/**
 * Platform domain types.
 *
 * These mirror the PostgreSQL schema in db/migrations. The UI never invents a
 * shape the API cannot produce, so swapping the demo client for the HTTP client
 * changes nothing above this layer.
 */

/** Matches HealthKey in theme.ts; `planned` is what a manifest shows before it exists. */
export type Health = 'healthy' | 'progressing' | 'degraded' | 'suspended' | 'missing' | 'planned' | 'unknown';
export type SyncStatus = 'in_sync' | 'out_of_sync' | 'unknown';

export interface Organization {
  id: string;
  slug: string;
  name: string;
}

export interface Project {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  gitRepository?: string;
  gitBranch?: string;
}

export interface Team {
  id: string;
  name: string;
  memberCount: number;
  role: string;
}

export interface Cluster {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  apiServerUrl: string;
  authMode: 'kubeconfig' | 'service_account';
  status: 'healthy' | 'degraded' | 'unreachable' | 'unknown';
  kubernetesVersion: string;
  nodeCount: number;
  namespaces: string[];
  distribution?: string;
  region?: string;
}

export interface DriftField {
  path: string;
  desired: string;
  live: string;
  lastWriter: string;
}

export interface ResourceEvent {
  type: 'Normal' | 'Warning';
  reason: string;
  message: string;
  count: number;
  lastSeen: string;
}

export interface MetricSample {
  /** Minutes before now. */
  t: number;
  cpu: number;
  memory: number;
}

/** One node in the topology graph. */
export interface ResourceNode {
  id: string;
  parentId?: string;
  kind: string;
  apiVersion: string;
  name: string;
  namespace: string;
  health: Health;
  syncStatus: SyncStatus;
  message?: string;
  /** Seconds since creation. */
  age: number;
  images?: string[];
  replicasDesired?: number;
  replicasReady?: number;
  node?: string;
  restarts?: number;
  drift?: DriftField[];
  events?: ResourceEvent[];
  logs?: string[];
  metrics?: MetricSample[];
  manifest?: string;
}

export interface Application {
  id: string;
  projectId: string;
  clusterId: string;
  namespace: string;
  name: string;
  sourceKind: 'manifest' | 'git' | 'helm' | 'kustomize' | 'argocd';
  gitRepository?: string;
  gitRevision?: string;
  gitPath?: string;
  health: Health;
  syncStatus: SyncStatus;
  autoSync: boolean;
  selfHeal: boolean;
  prune: boolean;
  lastSyncedAt: string;
  revisionCount: number;
  resources: ResourceNode[];
}

export interface DeploymentRecord {
  id: string;
  applicationId: string;
  revision: number;
  status: 'succeeded' | 'failed' | 'running' | 'rolled_back';
  strategy: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt?: string;
  triggeredBy: string;
  message: string;
  /** Per-object outcome, as the API server reported it. */
  results: { kind: string; name: string; action: string; error?: string }[];
}

export type ActivityStatus = 'success' | 'failure' | 'denied';

export interface ActivityEntry {
  id: number;
  occurredAt: string;
  actorEmail: string;
  sessionId?: string;
  apiKeyId?: string;
  ip: string;
  userAgent: string;
  projectSlug?: string;
  clusterSlug?: string;
  namespace?: string;
  action: string;
  targetKind?: string;
  targetName?: string;
  status: ActivityStatus;
  error?: string;
  oldValue?: unknown;
  newValue?: unknown;
  requestId: string;
}

export interface SessionInfo {
  id: string;
  ip: string;
  userAgent: string;
  current: boolean;
  issuedAt: string;
  lastUsedAt: string;
  mfaSatisfied: boolean;
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  organizationId: string;
  roles: string[];
  permissions: string[];
  mfaEnabled: boolean;
  authMethod: 'password' | 'oidc' | 'saml' | 'ldap' | 'api_key';
}

/** Verb strings match the `permissions` column on roles. */
export function can(user: CurrentUser | null, permission: string): boolean {
  if (!user) return false;
  return user.permissions.some((granted) => {
    if (granted === '*' || granted === permission) return true;
    if (granted.endsWith('.*')) return permission.startsWith(granted.slice(0, -1));
    return false;
  });
}

export const HEALTH_ORDER: Health[] = ['degraded', 'missing', 'progressing', 'suspended', 'unknown', 'healthy'];

/* ── live cluster inventory ───────────────────────────────────────────────── */

/**
 * One object actually running in a cluster, as returned by the inventory
 * endpoint. This is deliberately wider than ResourceNode: the explorer shows
 * everything present, including objects this platform never deployed.
 */
export interface ClusterResource {
  uid: string;
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string;
  health: Health;
  message?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  createdAt: string;
  images?: string[];
  replicasDesired?: number;
  replicasReady?: number;
  node?: string;
  restarts?: number;
  /** Controller owner UID, when the API server reported one. */
  parentId?: string;
  /** How the parent edge was derived. `owner` is authoritative; the rest are inferred. */
  edge?: 'owner' | 'selector' | 'backend' | 'mount';
  /** True when this platform's field manager appears in managedFields. */
  managed: boolean;
  /** Last writer, read from managedFields. */
  managedBy?: string;
  /** Set when a completed sync did not see the object. */
  disappearedAt?: string;
}

/** A kind the credential could not list, and why. */
export interface UnreadableKind {
  kind: string;
  group: string;
  namespace?: string;
  reason: string;
  forbidden: boolean;
}

/** One listable kind, discovered at read time so CRDs appear on their own. */
export interface ApiResourceInfo {
  group: string;
  version: string;
  kind: string;
  plural: string;
  namespaced: boolean;
  custom: boolean;
  verbs: string[];
}

/** One complete read of a cluster. */
export interface Inventory {
  objects: ClusterResource[];
  unreadable: UnreadableKind[];
  discoveryFailures: string[];
  truncated: boolean;
  takenAt: string;
  durationMs: number;
}

export interface InventoryFilter {
  namespaces?: string[];
  kinds?: string[];
  search?: string;
  onlyManaged?: boolean;
  skipCustom?: boolean;
  refresh?: boolean;
}
