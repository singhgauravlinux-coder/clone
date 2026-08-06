import type { ApiResourceInfo, ClusterResource, Health, Inventory, UnreadableKind } from './types';

/**
 * A synthetic cluster read.
 *
 * The point of the explorer is that it shows everything running, not only what
 * this platform deployed, so this dataset deliberately includes things the
 * workbench has never touched: kube-system, an ingress controller installed by
 * Helm, a CRD from Argo CD, and a namespace the credential cannot read into.
 */

function seeded(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = seeded(940217);
const NOW = Date.UTC(2026, 7, 4, 9, 30, 0);
const isoAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

let counter = 0;
const uid = (prefix: string) => `${prefix}-${(counter += 1).toString(36).padStart(4, '0')}`;

interface WorkloadSpec {
  namespace: string;
  name: string;
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'CronJob';
  image: string;
  replicas: number;
  ready?: number;
  health?: Health;
  managed: boolean;
  managedBy: string;
  withService?: boolean;
  withIngress?: boolean;
  withConfig?: boolean;
  withPVC?: boolean;
  podHealth?: Health[];
}

function workload(spec: WorkloadSpec): ClusterResource[] {
  const out: ClusterResource[] = [];
  const ready = spec.ready ?? spec.replicas;
  const health = spec.health ?? (ready === spec.replicas ? 'healthy' : 'degraded');
  const labels = { app: spec.name, 'app.kubernetes.io/name': spec.name };
  const base = {
    namespace: spec.namespace,
    managed: spec.managed,
    managedBy: spec.managedBy,
    createdAt: isoAgo(600 + Math.floor(random() * 8000)),
    labels,
  };

  const controllerUid = uid(spec.name);
  out.push({
    ...base,
    uid: controllerUid,
    apiVersion: spec.kind === 'CronJob' ? 'batch/v1' : 'apps/v1',
    kind: spec.kind,
    name: spec.name,
    health,
    replicasDesired: spec.kind === 'CronJob' ? undefined : spec.replicas,
    replicasReady: spec.kind === 'CronJob' ? undefined : ready,
    images: [spec.image],
    message: health === 'degraded' ? `${ready}/${spec.replicas} replicas available` : undefined,
  });

  // Deployments own a ReplicaSet; the others own their pods directly. Getting
  // this wrong is the most visible way to get a topology wrong.
  let podParent = controllerUid;
  if (spec.kind === 'Deployment') {
    podParent = uid(`${spec.name}-rs`);
    out.push({
      ...base,
      uid: podParent,
      apiVersion: 'apps/v1',
      kind: 'ReplicaSet',
      name: `${spec.name}-${Math.floor(random() * 9e8).toString(36)}`,
      health,
      parentId: controllerUid,
      edge: 'owner',
      replicasDesired: spec.replicas,
      replicasReady: ready,
      images: [spec.image],
    });
  }

  if (spec.kind !== 'CronJob') {
    const healths = spec.podHealth
      ?? Array.from({ length: spec.replicas }, (_, index) => (index < ready ? 'healthy' : 'degraded') as Health);
    healths.forEach((podHealth, index) => {
      out.push({
        ...base,
        uid: uid(`${spec.name}-pod`),
        apiVersion: 'v1',
        kind: 'Pod',
        name: `${spec.name}-${Math.floor(random() * 9e5).toString(36)}-${Math.floor(random() * 9e5).toString(36)}`,
        health: podHealth,
        parentId: podParent,
        edge: 'owner',
        images: [spec.image],
        node: `ip-10-0-${1 + (index % 4)}-${20 + Math.floor(random() * 200)}`,
        restarts: podHealth === 'healthy' ? 0 : 3 + Math.floor(random() * 9),
        message: podHealth === 'degraded' ? 'CrashLoopBackOff' : undefined,
      });
    });
  }

  if (spec.withService) {
    const serviceUid = uid(`${spec.name}-svc`);
    out.push({
      ...base,
      uid: serviceUid,
      apiVersion: 'v1',
      kind: 'Service',
      name: spec.name,
      health: 'healthy',
      parentId: controllerUid,
      // Inferred, not authoritative: a Service has no ownerReference to the
      // workload it fronts.
      edge: 'selector',
      message: `ClusterIP 10.100.${Math.floor(random() * 250)}.${Math.floor(random() * 250)}`,
    });
    if (spec.withIngress) {
      out.push({
        ...base,
        uid: uid(`${spec.name}-ing`),
        apiVersion: 'networking.k8s.io/v1',
        kind: 'Ingress',
        name: spec.name,
        health: 'healthy',
        parentId: serviceUid,
        edge: 'backend',
        message: `${spec.name}.acme.test`,
      });
    }
  }

  if (spec.withConfig) {
    out.push({
      ...base,
      uid: uid(`${spec.name}-cm`),
      apiVersion: 'v1',
      kind: 'ConfigMap',
      name: `${spec.name}-config`,
      health: 'healthy',
      parentId: controllerUid,
      edge: 'mount',
      message: '4 keys',
    });
    out.push({
      ...base,
      uid: uid(`${spec.name}-sec`),
      apiVersion: 'v1',
      kind: 'Secret',
      name: `${spec.name}-secrets`,
      health: 'healthy',
      parentId: controllerUid,
      edge: 'mount',
      message: 'Opaque, 2 keys',
    });
  }

  if (spec.withPVC) {
    out.push({
      ...base,
      uid: uid(`${spec.name}-pvc`),
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      name: `data-${spec.name}-0`,
      health: 'healthy',
      parentId: controllerUid,
      edge: 'mount',
      message: 'Bound, 50Gi',
    });
  }

  return out;
}

const objects: ClusterResource[] = [
  // Applications the workbench deployed.
  ...workload({
    namespace: 'production', name: 'storefront', kind: 'Deployment',
    image: 'ghcr.io/acme/storefront:2.14.0', replicas: 4,
    managed: true, managedBy: 'manifest-workbench',
    withService: true, withIngress: true, withConfig: true,
  }),
  ...workload({
    namespace: 'production', name: 'checkout-api', kind: 'Deployment',
    image: 'ghcr.io/acme/checkout:1.8.2', replicas: 3, ready: 2,
    managed: true, managedBy: 'manifest-workbench',
    withService: true, withIngress: true, withConfig: true,
    podHealth: ['healthy', 'healthy', 'degraded'],
  }),
  ...workload({
    namespace: 'production', name: 'postgres', kind: 'StatefulSet',
    image: 'postgres:16.3', replicas: 2,
    managed: true, managedBy: 'manifest-workbench',
    withService: true, withPVC: true, withConfig: true,
  }),
  ...workload({
    namespace: 'production', name: 'nightly-report', kind: 'CronJob',
    image: 'ghcr.io/acme/reporter:1.0.0', replicas: 0,
    managed: true, managedBy: 'manifest-workbench',
  }),

  // Installed by Helm before this platform existed. Present, visible, and not
  // ours: the explorer shows it, and the deploy view will not offer to roll it
  // back.
  ...workload({
    namespace: 'ingress-nginx', name: 'ingress-nginx-controller', kind: 'Deployment',
    image: 'registry.k8s.io/ingress-nginx/controller:v1.11.2', replicas: 2,
    managed: false, managedBy: 'helm', withService: true,
  }),
  ...workload({
    namespace: 'monitoring', name: 'prometheus', kind: 'StatefulSet',
    image: 'quay.io/prometheus/prometheus:v2.54.1', replicas: 1,
    managed: false, managedBy: 'prometheus-operator', withService: true, withPVC: true,
  }),
  ...workload({
    namespace: 'monitoring', name: 'node-exporter', kind: 'DaemonSet',
    image: 'quay.io/prometheus/node-exporter:v1.8.2', replicas: 6,
    managed: false, managedBy: 'prometheus-operator',
  }),
  ...workload({
    namespace: 'kube-system', name: 'coredns', kind: 'Deployment',
    image: 'registry.k8s.io/coredns/coredns:v1.11.1', replicas: 2,
    managed: false, managedBy: 'kubeadm', withService: true,
  }),
  ...workload({
    namespace: 'kube-system', name: 'aws-node', kind: 'DaemonSet',
    image: '602401143452.dkr.ecr.eu-west-1.amazonaws.com/amazon-k8s-cni:v1.18.3',
    replicas: 6, managed: false, managedBy: 'eks',
  }),
  ...workload({
    namespace: 'argocd', name: 'argocd-server', kind: 'Deployment',
    image: 'quay.io/argoproj/argocd:v2.12.3', replicas: 2,
    managed: false, managedBy: 'argocd-application-controller', withService: true,
  }),

  // A CRD instance, discovered without the platform knowing the kind in
  // advance. Nothing in the code enumerates Argo CD types.
  {
    uid: uid('argo-app'),
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'Application',
    name: 'storefront',
    namespace: 'argocd',
    health: 'healthy',
    managed: false,
    managedBy: 'argocd-application-controller',
    createdAt: isoAgo(9800),
    message: 'Synced to main@4f2a19c',
    labels: { 'argocd.argoproj.io/instance': 'storefront' },
  },
  {
    uid: uid('argo-appset'),
    apiVersion: 'argoproj.io/v1alpha1',
    kind: 'ApplicationSet',
    name: 'preview-environments',
    namespace: 'argocd',
    health: 'progressing',
    managed: false,
    managedBy: 'argocd-applicationset-controller',
    createdAt: isoAgo(9800),
    message: 'Generating 3 applications',
  },
  {
    uid: uid('cert'),
    apiVersion: 'cert-manager.io/v1',
    kind: 'Certificate',
    name: 'acme-test-tls',
    namespace: 'production',
    health: 'healthy',
    managed: false,
    managedBy: 'cert-manager',
    createdAt: isoAgo(4300),
    message: 'Certificate is up to date, renews in 43d',
  },

  // Cluster-scoped objects have no namespace, which the UI must not treat as
  // "default".
  {
    uid: uid('node'),
    apiVersion: 'v1',
    kind: 'Node',
    name: 'ip-10-0-1-42.eu-west-1.compute.internal',
    namespace: '',
    health: 'healthy',
    managed: false,
    managedBy: 'kubelet',
    createdAt: isoAgo(43200),
    message: 'Ready, 16 CPU / 64Gi',
    labels: { 'node.kubernetes.io/instance-type': 'm6i.4xlarge', 'topology.kubernetes.io/zone': 'eu-west-1a' },
  },
  {
    uid: uid('node'),
    apiVersion: 'v1',
    kind: 'Node',
    name: 'ip-10-0-2-88.eu-west-1.compute.internal',
    namespace: '',
    health: 'degraded',
    managed: false,
    managedBy: 'kubelet',
    createdAt: isoAgo(43200),
    message: 'DiskPressure',
    labels: { 'node.kubernetes.io/instance-type': 'm6i.4xlarge', 'topology.kubernetes.io/zone': 'eu-west-1b' },
  },
  {
    uid: uid('sc'),
    apiVersion: 'storage.k8s.io/v1',
    kind: 'StorageClass',
    name: 'gp3',
    namespace: '',
    health: 'healthy',
    managed: false,
    managedBy: 'eks',
    createdAt: isoAgo(43200),
    message: 'default',
  },
];

/** Kinds the demo credential is refused on, so the UI has something to render. */
const unreadable: UnreadableKind[] = [
  {
    kind: 'Secret',
    group: '',
    namespace: 'kube-system',
    reason: 'secrets is forbidden: User "system:serviceaccount:workbench:reader" cannot list resource "secrets" in namespace "kube-system"',
    forbidden: true,
  },
  {
    kind: 'ClusterRoleBinding',
    group: 'rbac.authorization.k8s.io',
    reason: 'clusterrolebindings is forbidden: this credential is namespace scoped',
    forbidden: true,
  },
];

export const apiResources: ApiResourceInfo[] = [
  { group: '', version: 'v1', kind: 'Pod', plural: 'pods', namespaced: true, custom: false, verbs: ['get', 'list', 'watch'] },
  { group: '', version: 'v1', kind: 'Service', plural: 'services', namespaced: true, custom: false, verbs: ['get', 'list', 'watch'] },
  { group: '', version: 'v1', kind: 'ConfigMap', plural: 'configmaps', namespaced: true, custom: false, verbs: ['get', 'list', 'watch'] },
  { group: '', version: 'v1', kind: 'Secret', plural: 'secrets', namespaced: true, custom: false, verbs: ['get', 'list'] },
  { group: '', version: 'v1', kind: 'Node', plural: 'nodes', namespaced: false, custom: false, verbs: ['get', 'list', 'watch'] },
  { group: 'apps', version: 'v1', kind: 'Deployment', plural: 'deployments', namespaced: true, custom: false, verbs: ['get', 'list', 'watch', 'patch'] },
  { group: 'apps', version: 'v1', kind: 'StatefulSet', plural: 'statefulsets', namespaced: true, custom: false, verbs: ['get', 'list', 'watch', 'patch'] },
  { group: 'apps', version: 'v1', kind: 'DaemonSet', plural: 'daemonsets', namespaced: true, custom: false, verbs: ['get', 'list', 'watch'] },
  { group: 'apps', version: 'v1', kind: 'ReplicaSet', plural: 'replicasets', namespaced: true, custom: false, verbs: ['get', 'list', 'watch'] },
  { group: 'batch', version: 'v1', kind: 'CronJob', plural: 'cronjobs', namespaced: true, custom: false, verbs: ['get', 'list', 'watch'] },
  { group: 'networking.k8s.io', version: 'v1', kind: 'Ingress', plural: 'ingresses', namespaced: true, custom: false, verbs: ['get', 'list', 'watch'] },
  { group: 'storage.k8s.io', version: 'v1', kind: 'StorageClass', plural: 'storageclasses', namespaced: false, custom: false, verbs: ['get', 'list'] },
  { group: 'argoproj.io', version: 'v1alpha1', kind: 'Application', plural: 'applications', namespaced: true, custom: true, verbs: ['get', 'list', 'watch'] },
  { group: 'argoproj.io', version: 'v1alpha1', kind: 'ApplicationSet', plural: 'applicationsets', namespaced: true, custom: true, verbs: ['get', 'list', 'watch'] },
  { group: 'cert-manager.io', version: 'v1', kind: 'Certificate', plural: 'certificates', namespaced: true, custom: true, verbs: ['get', 'list', 'watch'] },
];

export const inventory: Inventory = {
  objects,
  unreadable,
  // A metrics server that is down must degrade the read, not fail it.
  discoveryFailures: ['metrics.k8s.io/v1beta1: the server is currently unable to handle the request'],
  truncated: false,
  takenAt: isoAgo(2),
  durationMs: 1840,
};

export const namespaces: string[] = [
  ...new Set(objects.map((object) => object.namespace).filter(Boolean)),
].sort();

/**
 * Adapt a live cluster object to the node shape the detail drawer renders.
 *
 * The drawer was written for resources the platform deployed. An observed
 * object has no desired state, so it has no sync status and no drift: reporting
 * "in sync" for something we never applied would be a lie.
 */
export function toResourceNode(resource: ClusterResource, now = Date.now()) {
  return {
    id: resource.uid,
    kind: resource.kind,
    apiVersion: resource.apiVersion,
    name: resource.name,
    namespace: resource.namespace,
    health: resource.health,
    syncStatus: (resource.managed ? 'in_sync' : 'unknown') as 'in_sync' | 'unknown',
    age: Math.max(0, Math.floor((now - Date.parse(resource.createdAt)) / 1000)),
    message: resource.message,
    images: resource.images,
    replicasDesired: resource.replicasDesired,
    replicasReady: resource.replicasReady,
    node: resource.node,
    restarts: resource.restarts,
    parentId: resource.parentId,
  };
}
