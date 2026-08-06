import type {
  ActivityEntry, Application, ApiResourceInfo, Cluster, ClusterResource, CurrentUser,
  DeploymentRecord, Inventory, InventoryFilter, Organization, Project, SessionInfo, Team,
} from './types';
import * as demo from './demo';
import * as live from './inventory';

/**
 * The seam between the UI and the backend.
 *
 * Everything the screens need is declared here. `DemoClient` answers from the
 * seeded dataset so the app is usable with no server; `HttpClient` calls the Go
 * service. `createClient` picks one at start-up and nothing above this file
 * knows which it got.
 */

export interface ActivityFilter {
  query?: string;
  actions?: string[];
  statuses?: string[];
  actors?: string[];
  clusters?: string[];
  since?: string;
  until?: string;
  limit?: number;
}

export interface ApplyRequest {
  applicationId: string;
  files: { path: string; content: string }[];
  dryRun: boolean;
  message: string;
}

export interface ApplyResult {
  deployment: DeploymentRecord;
  /** Server-side diff, as `kubectl diff` would print it. */
  diff: string;
}

export interface PlatformClient {
  readonly mode: 'demo' | 'live';
  bootstrap(): Promise<{
    user: CurrentUser;
    organization: Organization;
    projects: Project[];
    teams: Team[];
    clusters: Cluster[];
    sessions: SessionInfo[];
  }>;
  listApplications(): Promise<Application[]>;
  listDeployments(applicationId: string): Promise<DeploymentRecord[]>;
  apply(request: ApplyRequest): Promise<ApplyResult>;
  rollback(applicationId: string, revision: number): Promise<DeploymentRecord>;
  deleteResource(applicationId: string, resourceId: string): Promise<void>;
  refreshApplication(applicationId: string): Promise<Application>;
  /** Everything running in a cluster, not only what this platform deployed. */
  listInventory(clusterId: string, filter: InventoryFilter): Promise<Inventory>;
  /** Listable kinds, discovered at read time so CRDs appear without config. */
  listApiResources(clusterId: string): Promise<ApiResourceInfo[]>;
  listNamespaces(clusterId: string): Promise<string[]>;
  listActivity(filter: ActivityFilter): Promise<ActivityEntry[]>;
  record(entry: Pick<ActivityEntry, 'action' | 'status'> & Partial<ActivityEntry>): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
}

/** Free text search across the fields an operator would actually type. */
export function matchesText(object: ClusterResource, needle: string): boolean {
  const haystack = [
    object.kind, object.name, object.namespace, object.message,
    object.managedBy, object.node, ...(object.images ?? []),
    ...Object.entries(object.labels ?? {}).map(([key, value]) => `${key}=${value}`),
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle);
}

/* ── demo ────────────────────────────────────────────────────────────────── */

function matches(entry: ActivityEntry, filter: ActivityFilter): boolean {
  if (filter.actions?.length && !filter.actions.includes(entry.action)) return false;
  if (filter.statuses?.length && !filter.statuses.includes(entry.status)) return false;
  if (filter.actors?.length && !filter.actors.includes(entry.actorEmail)) return false;
  if (filter.clusters?.length && !(entry.clusterSlug && filter.clusters.includes(entry.clusterSlug))) return false;
  if (filter.since && entry.occurredAt < filter.since) return false;
  if (filter.until && entry.occurredAt > filter.until) return false;
  if (filter.query) {
    const haystack = [
      entry.actorEmail, entry.action, entry.targetKind, entry.targetName,
      entry.clusterSlug, entry.namespace, entry.error, entry.ip, entry.requestId,
    ].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(filter.query.toLowerCase())) return false;
  }
  return true;
}

class DemoClient implements PlatformClient {
  readonly mode = 'demo' as const;
  private applications = demo.applications.map((app) => ({ ...app }));
  private deployments = [...demo.deployments];
  private log = [...demo.activity];
  private sessions = [...demo.sessions];
  private nextLogId = 100001;

  async bootstrap() {
    return {
      user: demo.currentUser,
      organization: demo.organization,
      projects: demo.projects,
      teams: demo.teams,
      clusters: demo.clusters,
      sessions: this.sessions,
    };
  }

  async listApplications() {
    return this.applications;
  }

  async listDeployments(applicationId: string) {
    return this.deployments.filter((entry) => entry.applicationId === applicationId);
  }

  async apply(request: ApplyRequest): Promise<ApplyResult> {
    const application = this.applications.find((app) => app.id === request.applicationId);
    const revision = (application?.revisionCount ?? 0) + 1;
    const deployment: DeploymentRecord = {
      id: `dep-${revision}-${Date.now().toString(36)}`,
      applicationId: request.applicationId,
      revision,
      status: request.dryRun ? 'succeeded' : 'succeeded',
      strategy: 'server_side_apply',
      dryRun: request.dryRun,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      triggeredBy: demo.currentUser.email,
      message: request.message || (request.dryRun ? 'dry run' : 'apply from workbench'),
      results: request.files.map((file) => ({
        kind: /kind:\s*(\S+)/.exec(file.content)?.[1] ?? 'Unknown',
        name: /name:\s*(\S+)/.exec(file.content)?.[1] ?? file.path,
        action: request.dryRun ? 'unchanged (dry run)' : 'configured',
      })),
    };
    if (!request.dryRun && application) {
      application.revisionCount = revision;
      application.lastSyncedAt = deployment.startedAt;
      application.syncStatus = 'in_sync';
      this.deployments = [deployment, ...this.deployments];
    }
    await this.record({
      action: request.dryRun ? 'deployment.dry_run' : 'deployment.apply',
      status: 'success',
      targetKind: deployment.results[0]?.kind,
      targetName: deployment.results[0]?.name,
      clusterSlug: demo.clusters.find((cluster) => cluster.id === application?.clusterId)?.slug,
      namespace: application?.namespace,
    });
    const diff = request.files.map((file) => [
      `--- live/${file.path}`,
      `+++ desired/${file.path}`,
      ...file.content.split('\n').slice(0, 6).map((line) => `+${line}`),
    ].join('\n')).join('\n\n');
    return { deployment, diff };
  }

  async rollback(applicationId: string, revision: number) {
    const deployment: DeploymentRecord = {
      id: `dep-rollback-${Date.now().toString(36)}`,
      applicationId,
      revision,
      status: 'succeeded',
      strategy: 'server_side_apply',
      dryRun: false,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      triggeredBy: demo.currentUser.email,
      message: `rollback to revision ${revision}`,
      results: [{ kind: 'Deployment', name: 'rolled back', action: 'configured' }],
    };
    this.deployments = [deployment, ...this.deployments];
    await this.record({ action: 'deployment.rollback', status: 'success', targetKind: 'Deployment' });
    return deployment;
  }

  async deleteResource(applicationId: string, resourceId: string) {
    const application = this.applications.find((app) => app.id === applicationId);
    if (application) {
      application.resources = application.resources.filter(
        (node) => node.id !== resourceId && node.parentId !== resourceId,
      );
    }
    await this.record({ action: 'deployment.delete', status: 'success', targetName: resourceId });
  }

  async refreshApplication(applicationId: string) {
    const application = this.applications.find((app) => app.id === applicationId);
    if (!application) throw new Error('unknown application');
    return application;
  }

  async listInventory(_clusterId: string, filter: InventoryFilter): Promise<Inventory> {
    let objects = live.inventory.objects;
    if (filter.namespaces?.length) {
      objects = objects.filter((object) => filter.namespaces!.includes(object.namespace));
    }
    if (filter.kinds?.length) {
      objects = objects.filter((object) => filter.kinds!.includes(object.kind));
    }
    if (filter.onlyManaged) objects = objects.filter((object) => object.managed);
    if (filter.search) {
      const needle = filter.search.toLowerCase();
      objects = objects.filter((object) => matchesText(object, needle));
    }
    await this.record({
      action: 'cluster.inventory',
      status: 'success',
      metadata: { refresh: filter.refresh === true, objects: objects.length },
    } as any);
    return { ...live.inventory, objects };
  }

  async listApiResources(_clusterId: string) {
    return live.apiResources;
  }

  async listNamespaces(_clusterId: string) {
    return live.namespaces;
  }

  async listActivity(filter: ActivityFilter) {
    return this.log.filter((entry) => matches(entry, filter)).slice(0, filter.limit ?? 500);
  }

  async record(entry: Pick<ActivityEntry, 'action' | 'status'> & Partial<ActivityEntry>) {
    this.log = [{
      id: this.nextLogId += 1,
      occurredAt: new Date().toISOString(),
      actorEmail: demo.currentUser.email,
      sessionId: 'sess-1',
      ip: '203.0.113.7',
      userAgent: 'Chrome 140 on macOS',
      requestId: `req_${Date.now().toString(36)}`,
      ...entry,
    } as ActivityEntry, ...this.log];
  }

  async revokeSession(sessionId: string) {
    this.sessions = this.sessions.filter((session) => session.id !== sessionId);
    await this.record({ action: 'auth.session.revoke', status: 'success', targetName: sessionId });
  }
}

/* ── live ────────────────────────────────────────────────────────────────── */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body.slice(0, 200)}`);
  }
  return response.status === 204 ? (undefined as T) : (response.json() as Promise<T>);
}

class HttpClient implements PlatformClient {
  readonly mode = 'live' as const;

  bootstrap() { return request<Awaited<ReturnType<PlatformClient['bootstrap']>>>('/bootstrap'); }
  listApplications() { return request<Application[]>('/applications'); }
  listDeployments(applicationId: string) {
    return request<DeploymentRecord[]>(`/applications/${applicationId}/deployments`);
  }
  apply(body: ApplyRequest) {
    return request<ApplyResult>('/deployments/apply', { method: 'POST', body: JSON.stringify(body) });
  }
  rollback(applicationId: string, revision: number) {
    return request<DeploymentRecord>(`/applications/${applicationId}/rollback`, {
      method: 'POST', body: JSON.stringify({ revision }),
    });
  }
  deleteResource(applicationId: string, resourceId: string) {
    return request<void>(`/applications/${applicationId}/resources/${resourceId}`, { method: 'DELETE' });
  }
  refreshApplication(applicationId: string) {
    return request<Application>(`/applications/${applicationId}?refresh=true`);
  }
  listInventory(clusterId: string, filter: InventoryFilter) {
    const params = new URLSearchParams();
    filter.namespaces?.forEach((value) => params.append('namespace', value));
    filter.kinds?.forEach((value) => params.append('kind', value));
    if (filter.search) params.set('search', filter.search);
    if (filter.onlyManaged) params.set('onlyManaged', 'true');
    if (filter.skipCustom) params.set('skipCustom', 'true');
    if (filter.refresh) params.set('refresh', 'true');
    return request<Inventory>(`/clusters/${clusterId}/resources?${params.toString()}`);
  }
  listApiResources(clusterId: string) {
    return request<ApiResourceInfo[]>(`/clusters/${clusterId}/api-resources`);
  }
  listNamespaces(clusterId: string) {
    return request<string[]>(`/clusters/${clusterId}/namespaces`);
  }
  listActivity(filter: ActivityFilter) {
    const params = new URLSearchParams();
    Object.entries(filter).forEach(([key, value]) => {
      if (Array.isArray(value)) value.forEach((item) => params.append(key, String(item)));
      else if (value !== undefined) params.set(key, String(value));
    });
    return request<ActivityEntry[]>(`/activity?${params.toString()}`);
  }
  record(entry: Pick<ActivityEntry, 'action' | 'status'> & Partial<ActivityEntry>) {
    // The server writes the trail itself; this is only used by the demo client.
    return request<void>('/activity', { method: 'POST', body: JSON.stringify(entry) });
  }
  revokeSession(sessionId: string) {
    return request<void>(`/sessions/${sessionId}`, { method: 'DELETE' });
  }
}

/**
 * Probe for a backend once at start-up. A missing or failing API is not an
 * error: the workbench still generates YAML, it just cannot deploy it.
 */
export async function createClient(): Promise<PlatformClient> {
  if (typeof fetch !== 'function' || typeof window === 'undefined') return new DemoClient();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch('/api/healthz', { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) return new HttpClient();
  } catch {
    // fall through to demo
  }
  return new DemoClient();
}

export { DemoClient, HttpClient };
