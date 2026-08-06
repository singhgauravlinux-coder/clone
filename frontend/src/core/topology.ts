import type { GeneratedFile } from './types';
import { parseDocuments } from './yaml';
import type { HealthKey, SyncKey } from '../theme';
import type { Application, ResourceNode } from '../platform/types';

/**
 * Topology derivation.
 *
 * Argo CD draws its tree from what the cluster reports. Before anything is
 * applied there is no cluster to ask, so this derives the same shape from the
 * manifests themselves: which controllers exist, what pods they will create,
 * which Service selects which workload, what an Ingress routes to. When a live
 * cluster is attached the backend returns the same node shape with real health
 * and the view does not change.
 */

export interface TopoNode {
  id: string;
  kind: string;
  name: string;
  namespace?: string;
  /** Column in the tree. 0 is the application root. */
  tier: number;
  health: HealthKey;
  sync: SyncKey;
  /** Rows shown in the inspector. */
  detail: [string, string][];
  /** True when the node is inferred rather than declared, e.g. a pod. */
  derived?: boolean;
  x: number;
  y: number;
}

export interface TopoEdge {
  from: string;
  to: string;
}

export interface Topology {
  nodes: TopoNode[];
  edges: TopoEdge[];
  width: number;
  height: number;
}

const NODE_W = 190;
const NODE_H = 54;
const GAP_X = 96;
const GAP_Y = 20;

const CONTROLLER_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob']);

function labelsOf(doc: any): Record<string, string> {
  return doc?.spec?.template?.metadata?.labels ?? doc?.metadata?.labels ?? {};
}

function selectorMatches(selector: Record<string, string>, labels: Record<string, string>): boolean {
  const keys = Object.keys(selector ?? {});
  if (!keys.length) return false;
  return keys.every((key) => labels?.[key] === selector[key]);
}

/** Kinds that reference a ConfigMap, Secret or PVC by name inside a pod spec. */
function referencedNames(podSpec: any): { configMaps: string[]; secrets: string[]; claims: string[] } {
  const configMaps: string[] = [];
  const secrets: string[] = [];
  const claims: string[] = [];
  for (const volume of podSpec?.volumes ?? []) {
    if (volume?.configMap?.name) configMaps.push(volume.configMap.name);
    if (volume?.secret?.secretName) secrets.push(volume.secret.secretName);
    if (volume?.persistentVolumeClaim?.claimName) claims.push(volume.persistentVolumeClaim.claimName);
  }
  for (const container of podSpec?.containers ?? []) {
    for (const source of container?.envFrom ?? []) {
      if (source?.configMapRef?.name) configMaps.push(source.configMapRef.name);
      if (source?.secretRef?.name) secrets.push(source.secretRef.name);
    }
  }
  return { configMaps, secrets, claims };
}

interface BuildOptions {
  /** Name shown on the root node. */
  application: string;
  /** Live mode marks nodes healthy; preview mode marks them planned. */
  live?: boolean;
  /** Node names the backend reported as drifted. */
  drifted?: string[];
  /** Cap on rendered pod children so a replicas: 50 workload stays readable. */
  maxPods?: number;
}

export function buildTopology(files: GeneratedFile[], options: BuildOptions): Topology {
  const docs: any[] = [];
  for (const file of files) {
    if (file.language !== 'yaml') continue;
    try {
      docs.push(...parseDocuments(file.content));
    } catch {
      // A file mid-edit may not parse; the graph simply omits it.
    }
  }

  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  const drifted = new Set(options.drifted ?? []);
  const maxPods = options.maxPods ?? 6;
  const defaultHealth: HealthKey = options.live ? 'healthy' : 'planned';

  const add = (node: Omit<TopoNode, 'x' | 'y'>): string => {
    if (!nodes.some((existing) => existing.id === node.id)) {
      nodes.push({ ...node, x: 0, y: 0 });
    }
    return node.id;
  };
  const link = (from: string, to: string) => {
    if (from && to && !edges.some((edge) => edge.from === from && edge.to === to)) edges.push({ from, to });
  };

  const rootId = add({
    id: 'app',
    kind: 'Application',
    name: options.application || 'workbench',
    tier: 0,
    health: options.live ? 'healthy' : 'planned',
    sync: drifted.size ? 'out-of-sync' : options.live ? 'in-sync' : 'unknown',
    detail: [
      ['Source', 'manifest workbench'],
      ['Documents', String(docs.length)],
      ['Mode', options.live ? 'live cluster' : 'preview from manifests'],
    ],
  });

  const idOf = (doc: any) => `${doc?.kind}/${doc?.metadata?.name ?? 'unnamed'}`;

  // Tier 1: every declared object.
  for (const doc of docs) {
    if (!doc?.kind) continue;
    const name = doc?.metadata?.name ?? 'unnamed';
    const id = idOf(doc);
    const isDrifted = drifted.has(id) || drifted.has(name);
    add({
      id,
      kind: doc.kind,
      name,
      namespace: doc?.metadata?.namespace,
      tier: 1,
      health: isDrifted ? 'degraded' : defaultHealth,
      sync: isDrifted ? 'out-of-sync' : options.live ? 'in-sync' : 'unknown',
      detail: describe(doc),
    });
    link(rootId, id);
  }

  // Tier 2 and 3: controllers create replica sets and pods.
  for (const doc of docs) {
    if (!CONTROLLER_KINDS.has(doc?.kind)) continue;
    const parent = idOf(doc);
    const name = doc?.metadata?.name ?? 'workload';
    const namespace = doc?.metadata?.namespace;

    let podParent = parent;
    if (doc.kind === 'Deployment') {
      const rsId = `ReplicaSet/${name}-${hash(name)}`;
      add({
        id: rsId,
        kind: 'ReplicaSet',
        name: `${name}-${hash(name)}`,
        namespace,
        tier: 2,
        health: defaultHealth,
        sync: options.live ? 'in-sync' : 'unknown',
        derived: true,
        detail: [['Desired', String(doc?.spec?.replicas ?? 1)], ['Owner', `Deployment/${name}`]],
      });
      link(parent, rsId);
      podParent = rsId;
    }
    if (doc.kind === 'CronJob') {
      const jobId = `Job/${name}-scheduled`;
      add({
        id: jobId,
        kind: 'Job',
        name: `${name}-<timestamp>`,
        namespace,
        tier: 2,
        health: defaultHealth,
        sync: 'unknown',
        derived: true,
        detail: [['Schedule', String(doc?.spec?.schedule ?? '')], ['Created by', `CronJob/${name}`]],
      });
      link(parent, jobId);
      podParent = jobId;
    }

    const podTier = podParent === parent ? 2 : 3;
    const count = podCount(doc);
    const shown = Math.min(count, maxPods);
    for (let index = 0; index < shown; index += 1) {
      const podName = podNameFor(doc, name, index);
      const podId = `Pod/${podName}`;
      add({
        id: podId,
        kind: 'Pod',
        name: podName,
        namespace,
        tier: podTier,
        health: defaultHealth,
        sync: 'unknown',
        derived: true,
        detail: [
          ['Containers', (containersOf(doc) ?? []).map((container: any) => container?.name).join(', ')],
          ['Image', (containersOf(doc) ?? [])[0]?.image ?? ''],
          ['Owner', `${doc.kind}/${name}`],
        ],
      });
      link(podParent, podId);
    }
    if (count > shown) {
      const moreId = `Pod/${name}-more`;
      add({
        id: moreId,
        kind: 'Pod',
        name: `+${count - shown} more`,
        tier: podTier,
        health: defaultHealth,
        sync: 'unknown',
        derived: true,
        detail: [['Replicas', String(count)], ['Collapsed', `${count - shown} pods hidden`]],
      });
      link(podParent, moreId);
    }

    // Config and storage the pod template mounts.
    const podSpec = doc.kind === 'CronJob'
      ? doc?.spec?.jobTemplate?.spec?.template?.spec
      : doc?.spec?.template?.spec;
    const refs = referencedNames(podSpec);
    refs.configMaps.forEach((cm) => link(parent, `ConfigMap/${cm}`));
    refs.secrets.forEach((secret) => link(parent, `Secret/${secret}`));
    refs.claims.forEach((claim) => link(parent, `PersistentVolumeClaim/${claim}`));
  }

  // Services select workloads; Ingresses route to Services; HPAs target workloads.
  for (const doc of docs) {
    if (doc?.kind === 'Service') {
      const selector = doc?.spec?.selector ?? {};
      for (const candidate of docs) {
        if (!CONTROLLER_KINDS.has(candidate?.kind)) continue;
        if (selectorMatches(selector, labelsOf(candidate))) link(idOf(doc), idOf(candidate));
      }
    }
    if (doc?.kind === 'Ingress') {
      for (const rule of doc?.spec?.rules ?? []) {
        for (const path of rule?.http?.paths ?? []) {
          const target = path?.backend?.service?.name;
          if (target) link(idOf(doc), `Service/${target}`);
        }
      }
    }
    if (doc?.kind === 'HorizontalPodAutoscaler') {
      const target = doc?.spec?.scaleTargetRef;
      if (target?.kind && target?.name) link(idOf(doc), `${target.kind}/${target.name}`);
    }
    if (doc?.kind === 'RoleBinding' || doc?.kind === 'ClusterRoleBinding') {
      const roleRef = doc?.spec?.roleRef ?? doc?.roleRef;
      if (roleRef?.kind && roleRef?.name) link(idOf(doc), `${roleRef.kind}/${roleRef.name}`);
      for (const subject of doc?.subjects ?? []) {
        if (subject?.kind === 'ServiceAccount') link(idOf(doc), `ServiceAccount/${subject.name}`);
      }
    }
  }

  layout(nodes);
  const width = Math.max(...nodes.map((node) => node.x + NODE_W), NODE_W) + 40;
  const height = Math.max(...nodes.map((node) => node.y + NODE_H), NODE_H) + 40;
  return { nodes, edges, width, height };
}

function containersOf(doc: any): any[] {
  if (doc?.kind === 'CronJob') return doc?.spec?.jobTemplate?.spec?.template?.spec?.containers ?? [];
  return doc?.spec?.template?.spec?.containers ?? [];
}

function podCount(doc: any): number {
  switch (doc?.kind) {
    case 'Deployment':
    case 'StatefulSet':
      return Math.max(0, Number(doc?.spec?.replicas ?? 1));
    case 'DaemonSet':
      return 3; // one per node; three is a readable stand-in before a cluster is attached
    case 'Job':
      return Math.max(1, Number(doc?.spec?.completions ?? doc?.spec?.parallelism ?? 1));
    case 'CronJob':
      return 1;
    default:
      return 0;
  }
}

function podNameFor(doc: any, name: string, index: number): string {
  if (doc?.kind === 'StatefulSet') return `${name}-${index}`;
  if (doc?.kind === 'DaemonSet') return `${name}-node${index + 1}`;
  return `${name}-${hash(name)}-${suffix(index)}`;
}

/** Stable pseudo-random suffix so the graph does not reshuffle on every render. */
function hash(value: string): string {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) total = (total * 31 + value.charCodeAt(index)) >>> 0;
  return total.toString(36).slice(0, 5).padStart(5, 'x');
}

function suffix(index: number): string {
  return 'abcdefghijklmnopqrstuvwxyz'.slice(index % 26, (index % 26) + 1)
    + String.fromCharCode(50 + (index % 7))
    + String.fromCharCode(107 + (index % 12));
}

function describe(doc: any): [string, string][] {
  const rows: [string, string][] = [['apiVersion', String(doc?.apiVersion ?? '')]];
  if (doc?.metadata?.namespace) rows.push(['Namespace', doc.metadata.namespace]);
  switch (doc?.kind) {
    case 'Deployment':
    case 'StatefulSet':
      rows.push(['Replicas', String(doc?.spec?.replicas ?? 1)]);
      rows.push(['Image', containersOf(doc)[0]?.image ?? '']);
      break;
    case 'Service':
      rows.push(['Type', String(doc?.spec?.type ?? 'ClusterIP')]);
      rows.push(['Ports', (doc?.spec?.ports ?? []).map((port: any) => port?.port).join(', ')]);
      break;
    case 'Ingress':
      rows.push(['Hosts', (doc?.spec?.rules ?? []).map((rule: any) => rule?.host).filter(Boolean).join(', ')]);
      rows.push(['Class', String(doc?.spec?.ingressClassName ?? 'default')]);
      break;
    case 'ConfigMap':
      rows.push(['Keys', Object.keys(doc?.data ?? {}).join(', ')]);
      break;
    case 'Secret':
      rows.push(['Type', String(doc?.type ?? 'Opaque')]);
      rows.push(['Keys', Object.keys(doc?.data ?? doc?.stringData ?? {}).join(', ')]);
      break;
    case 'PersistentVolumeClaim':
      rows.push(['Size', String(doc?.spec?.resources?.requests?.storage ?? '')]);
      rows.push(['Modes', (doc?.spec?.accessModes ?? []).join(', ')]);
      break;
    case 'HorizontalPodAutoscaler':
      rows.push(['Range', `${doc?.spec?.minReplicas ?? 1} – ${doc?.spec?.maxReplicas ?? 1}`]);
      break;
    case 'CronJob':
      rows.push(['Schedule', String(doc?.spec?.schedule ?? '')]);
      break;
    default:
      break;
  }
  return rows.filter(([, value]) => value !== '');
}

/** Column layout: tier drives x, insertion order drives y within the tier. */
function layout(nodes: TopoNode[]) {
  const tiers = new Map<number, TopoNode[]>();
  nodes.forEach((node) => {
    const bucket = tiers.get(node.tier) ?? [];
    bucket.push(node);
    tiers.set(node.tier, bucket);
  });
  const tallest = Math.max(...[...tiers.values()].map((bucket) => bucket.length), 1);
  const fullHeight = tallest * (NODE_H + GAP_Y);
  [...tiers.entries()].forEach(([tier, bucket]) => {
    const columnHeight = bucket.length * (NODE_H + GAP_Y);
    const offset = (fullHeight - columnHeight) / 2;
    bucket.forEach((node, index) => {
      node.x = 20 + tier * (NODE_W + GAP_X);
      node.y = 20 + offset + index * (NODE_H + GAP_Y);
    });
  });
}

export const NODE_SIZE = { width: NODE_W, height: NODE_H };

/**
 * Live topology.
 *
 * The same graph shape, sourced from what the cluster reports instead of from
 * the manifests. Owner references give the parent edges; the application row
 * itself is the root. One renderer draws both, which is the point: an operator
 * should not have to learn two pictures of the same system.
 */
export function liveTopology(application: Application): Topology {
  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];
  const syncOf = (value: string): SyncKey =>
    value === 'out_of_sync' ? 'out-of-sync' : value === 'in_sync' ? 'in-sync' : 'unknown';

  const rootId = `Application/${application.name}`;
  nodes.push({
    id: rootId,
    kind: 'Application',
    name: application.name,
    namespace: application.namespace,
    tier: 0,
    health: application.health as HealthKey,
    sync: syncOf(application.syncStatus),
    detail: [
      ['Source', application.sourceKind],
      ['Revision', application.gitRevision ?? String(application.revisionCount)],
      ['Auto sync', application.autoSync ? 'on' : 'off'],
      ['Self heal', application.selfHeal ? 'on' : 'off'],
    ],
    x: 0,
    y: 0,
  });

  const depthOf = (node: ResourceNode): number => {
    let depth = 1;
    let cursor = node;
    const seen = new Set<string>();
    while (cursor.parentId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parent = application.resources.find((entry) => entry.id === cursor.parentId);
      if (!parent) break;
      cursor = parent;
      depth += 1;
    }
    return depth;
  };

  for (const resource of application.resources) {
    nodes.push({
      id: resource.id,
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace,
      tier: depthOf(resource),
      health: resource.health as HealthKey,
      sync: syncOf(resource.syncStatus),
      derived: resource.kind === 'Pod' || resource.kind === 'ReplicaSet',
      detail: [
        ['apiVersion', resource.apiVersion],
        ...(resource.replicasDesired !== undefined
          ? ([['Replicas', `${resource.replicasReady ?? 0} / ${resource.replicasDesired}`]] as [string, string][])
          : []),
        ...(resource.images?.length ? ([['Image', resource.images[0]]] as [string, string][]) : []),
        ...(resource.node ? ([['Node', resource.node]] as [string, string][]) : []),
        ...(resource.restarts ? ([['Restarts', String(resource.restarts)]] as [string, string][]) : []),
        ...(resource.drift?.length ? ([['Drifted fields', String(resource.drift.length)]] as [string, string][]) : []),
        ...(resource.message ? ([['Status', resource.message]] as [string, string][]) : []),
      ],
      x: 0,
      y: 0,
    });
    edges.push({ from: resource.parentId ?? rootId, to: resource.id });
  }

  layout(nodes);
  const width = Math.max(...nodes.map((node) => node.x + NODE_W), NODE_W) + 40;
  const height = Math.max(...nodes.map((node) => node.y + NODE_H), NODE_H) + 40;
  return { nodes, edges, width, height };
}
