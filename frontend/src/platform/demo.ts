import type {
  ActivityEntry, Application, Cluster, CurrentUser, DeploymentRecord,
  Health, Organization, Project, ResourceNode, SessionInfo, Team,
} from './types';

/**
 * A deterministic dataset so the UI can be developed, demonstrated and tested
 * without a cluster. The HTTP client returns exactly these shapes, so nothing
 * above the client layer knows which one it is talking to.
 */

function mulberry(seed: number) {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry(20260804);
const NOW = Date.UTC(2026, 7, 4, 9, 30, 0);

function isoAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

export const organization: Organization = { id: 'org-acme', slug: 'acme', name: 'Acme Platform' };

export const projects: Project[] = [
  { id: 'proj-shop', organizationId: 'org-acme', slug: 'shop', name: 'Storefront', gitRepository: 'github.com/acme/shop-manifests', gitBranch: 'main' },
  { id: 'proj-data', organizationId: 'org-acme', slug: 'data', name: 'Data Platform', gitRepository: 'github.com/acme/data-manifests', gitBranch: 'main' },
];

export const teams: Team[] = [
  { id: 'team-platform', name: 'Platform', memberCount: 6, role: 'admin' },
  { id: 'team-shop', name: 'Storefront', memberCount: 11, role: 'operator' },
  { id: 'team-analytics', name: 'Analytics', memberCount: 4, role: 'developer' },
];

export const clusters: Cluster[] = [
  {
    id: 'cl-prod-eu', organizationId: 'org-acme', slug: 'prod-eu', name: 'Production EU',
    apiServerUrl: 'https://k8s-prod-eu.acme.internal:6443', authMode: 'service_account',
    status: 'healthy', kubernetesVersion: 'v1.30.4', nodeCount: 24,
    namespaces: ['production', 'ingress-nginx', 'monitoring', 'argocd'],
    distribution: 'EKS', region: 'eu-west-1',
  },
  {
    id: 'cl-prod-us', organizationId: 'org-acme', slug: 'prod-us', name: 'Production US',
    apiServerUrl: 'https://k8s-prod-us.acme.internal:6443', authMode: 'service_account',
    status: 'degraded', kubernetesVersion: 'v1.29.8', nodeCount: 18,
    namespaces: ['production', 'ingress-nginx', 'monitoring'],
    distribution: 'EKS', region: 'us-east-1',
  },
  {
    id: 'cl-staging', organizationId: 'org-acme', slug: 'staging', name: 'Staging',
    apiServerUrl: 'https://k8s-staging.acme.internal:6443', authMode: 'kubeconfig',
    status: 'healthy', kubernetesVersion: 'v1.30.4', nodeCount: 6,
    namespaces: ['staging', 'preview', 'monitoring'],
    distribution: 'k3s', region: 'eu-west-1',
  },
];

export const currentUser: CurrentUser = {
  id: 'user-1', email: 'dana@acme.test', displayName: 'Dana Okafor',
  organizationId: 'org-acme',
  roles: ['admin', 'operator'],
  permissions: ['organization.read', 'project.*', 'cluster.*', 'manifest.*', 'deployment.*', 'activity.read', 'activity.export', 'settings.*'],
  mfaEnabled: true, authMethod: 'oidc',
};

export const sessions: SessionInfo[] = [
  { id: 'sess-1', ip: '203.0.113.7', userAgent: 'Chrome 140 on macOS', current: true, issuedAt: isoAgo(96), lastUsedAt: isoAgo(0), mfaSatisfied: true },
  { id: 'sess-2', ip: '198.51.100.24', userAgent: 'Claude Workbench CLI 0.4.2', current: false, issuedAt: isoAgo(2880), lastUsedAt: isoAgo(310), mfaSatisfied: true },
  { id: 'sess-3', ip: '203.0.113.91', userAgent: 'Safari 18 on iOS', current: false, issuedAt: isoAgo(7200), lastUsedAt: isoAgo(6100), mfaSatisfied: false },
];

function logLines(name: string, count: number): string[] {
  const levels = ['INFO', 'INFO', 'INFO', 'WARN', 'DEBUG'];
  const messages = [
    'listening on :8080',
    'connected to postgres pool size=20',
    'GET /healthz 200 1.2ms',
    'GET /api/products 200 18.4ms',
    'cache miss key=catalog:eu',
    'POST /api/checkout 201 92.1ms',
    'refreshed feature flags in 4ms',
    'slow query 412ms SELECT * FROM orders',
    'GET /api/products 200 21.7ms',
    'shutting down worker gracefully',
  ];
  return Array.from({ length: count }, (_, index) => {
    const stamp = new Date(NOW - (count - index) * 4000).toISOString().slice(11, 23);
    const level = levels[Math.floor(random() * levels.length)];
    const message = messages[Math.floor(random() * messages.length)];
    return `${stamp} ${level.padEnd(5)} [${name}] ${message}`;
  });
}

function metrics(base: number): { t: number; cpu: number; memory: number }[] {
  let cpu = base;
  let memory = base * 3.2;
  return Array.from({ length: 30 }, (_, index) => {
    cpu = Math.max(2, cpu + (random() - 0.48) * base * 0.35);
    memory = Math.max(16, memory + (random() - 0.5) * base * 0.4);
    return { t: 29 - index, cpu: Math.round(cpu), memory: Math.round(memory) };
  }).reverse();
}

interface PodSpec {
  suffix: string;
  health: Health;
  restarts?: number;
  message?: string;
  node: string;
}

function buildWorkload(options: {
  app: string;
  namespace: string;
  image: string;
  replicas: number;
  pods: PodSpec[];
  health: Health;
  withIngress?: boolean;
  withConfig?: boolean;
  drift?: ResourceNode['drift'];
}): ResourceNode[] {
  const { app, namespace, image, replicas, pods, health } = options;
  const ready = pods.filter((pod) => pod.health === 'healthy').length;
  const nodes: ResourceNode[] = [];

  const deploymentId = `${app}-deployment`;
  nodes.push({
    id: deploymentId,
    kind: 'Deployment',
    apiVersion: 'apps/v1',
    name: app,
    namespace,
    health,
    syncStatus: options.drift?.length ? 'out_of_sync' : 'in_sync',
    age: 60 * 60 * 26,
    images: [image],
    replicasDesired: replicas,
    replicasReady: ready,
    drift: options.drift,
    message: health === 'degraded' ? `${ready}/${replicas} replicas available` : undefined,
    events: [
      { type: 'Normal', reason: 'ScalingReplicaSet', message: `Scaled up replica set ${app}-7d9f to ${replicas}`, count: 1, lastSeen: isoAgo(94) },
      ...(health === 'degraded'
        ? [{ type: 'Warning' as const, reason: 'ProgressDeadlineExceeded', message: `ReplicaSet ${app}-7d9f has timed out progressing`, count: 3, lastSeen: isoAgo(11) }]
        : []),
    ],
    metrics: metrics(120),
    manifest: [
      'apiVersion: apps/v1',
      'kind: Deployment',
      'metadata:',
      `  name: ${app}`,
      `  namespace: ${namespace}`,
      'spec:',
      `  replicas: ${replicas}`,
      '  selector:',
      '    matchLabels:',
      `      app: ${app}`,
      '  template:',
      '    spec:',
      '      containers:',
      `        - name: ${app}`,
      `          image: ${image}`,
      '',
    ].join('\n'),
  });

  const replicaSetId = `${app}-rs`;
  nodes.push({
    id: replicaSetId,
    parentId: deploymentId,
    kind: 'ReplicaSet',
    apiVersion: 'apps/v1',
    name: `${app}-7d9f4c8b6`,
    namespace,
    health,
    syncStatus: 'in_sync',
    age: 60 * 60 * 26,
    images: [image],
    replicasDesired: replicas,
    replicasReady: ready,
    events: [],
    metrics: metrics(90),
  });

  pods.forEach((pod) => {
    nodes.push({
      id: `${app}-pod-${pod.suffix}`,
      parentId: replicaSetId,
      kind: 'Pod',
      apiVersion: 'v1',
      name: `${app}-7d9f4c8b6-${pod.suffix}`,
      namespace,
      health: pod.health,
      syncStatus: 'in_sync',
      age: 60 * 60 * (2 + Math.floor(random() * 20)),
      images: [image],
      node: pod.node,
      restarts: pod.restarts ?? 0,
      message: pod.message,
      events: pod.health === 'healthy'
        ? [{ type: 'Normal', reason: 'Started', message: `Started container ${app}`, count: 1, lastSeen: isoAgo(120) }]
        : [
          { type: 'Warning', reason: 'BackOff', message: `Back-off restarting failed container ${app}`, count: 7, lastSeen: isoAgo(3) },
          { type: 'Warning', reason: 'Unhealthy', message: 'Readiness probe failed: HTTP probe failed with statuscode: 503', count: 12, lastSeen: isoAgo(2) },
        ],
      logs: logLines(app, 24),
      metrics: metrics(pod.health === 'healthy' ? 60 : 180),
    });
  });

  const serviceId = `${app}-service`;
  nodes.push({
    id: serviceId,
    parentId: deploymentId,
    kind: 'Service',
    apiVersion: 'v1',
    name: app,
    namespace,
    health: 'healthy',
    syncStatus: 'in_sync',
    age: 60 * 60 * 26,
    message: `ClusterIP 10.100.${Math.floor(random() * 200)}.${Math.floor(random() * 200)}:80`,
    events: [],
  });

  if (options.withIngress) {
    nodes.push({
      id: `${app}-ingress`,
      parentId: serviceId,
      kind: 'Ingress',
      apiVersion: 'networking.k8s.io/v1',
      name: app,
      namespace,
      health: 'healthy',
      syncStatus: 'in_sync',
      age: 60 * 60 * 26,
      message: `${app}.acme.test`,
      events: [{ type: 'Normal', reason: 'Sync', message: 'Scheduled for sync', count: 4, lastSeen: isoAgo(140) }],
    });
  }

  if (options.withConfig) {
    nodes.push({
      id: `${app}-configmap`,
      parentId: deploymentId,
      kind: 'ConfigMap',
      apiVersion: 'v1',
      name: `${app}-config`,
      namespace,
      health: 'healthy',
      syncStatus: 'in_sync',
      age: 60 * 60 * 26,
      message: '3 keys',
      events: [],
    });
    nodes.push({
      id: `${app}-secret`,
      parentId: deploymentId,
      kind: 'Secret',
      apiVersion: 'v1',
      name: `${app}-secrets`,
      namespace,
      health: 'healthy',
      syncStatus: 'in_sync',
      age: 60 * 60 * 26,
      message: 'Opaque, 2 keys',
      events: [],
    });
  }

  return nodes;
}

export const applications: Application[] = [
  {
    id: 'app-storefront',
    projectId: 'proj-shop',
    clusterId: 'cl-prod-eu',
    namespace: 'production',
    name: 'storefront',
    sourceKind: 'git',
    gitRepository: 'github.com/acme/shop-manifests',
    gitRevision: 'main@4f2a19c',
    gitPath: 'apps/storefront/production',
    health: 'healthy',
    syncStatus: 'in_sync',
    autoSync: true,
    selfHeal: true,
    prune: true,
    lastSyncedAt: isoAgo(37),
    revisionCount: 41,
    resources: buildWorkload({
      app: 'storefront',
      namespace: 'production',
      image: 'ghcr.io/acme/storefront:2.14.0',
      replicas: 4,
      health: 'healthy',
      withIngress: true,
      withConfig: true,
      pods: [
        { suffix: 'x4k2p', health: 'healthy', node: 'ip-10-0-3-41' },
        { suffix: 'm9w7t', health: 'healthy', node: 'ip-10-0-2-18' },
        { suffix: 'q2r8n', health: 'healthy', node: 'ip-10-0-4-77' },
        { suffix: 'v6y1d', health: 'healthy', node: 'ip-10-0-3-41' },
      ],
    }),
  },
  {
    id: 'app-checkout',
    projectId: 'proj-shop',
    clusterId: 'cl-prod-eu',
    namespace: 'production',
    name: 'checkout-api',
    sourceKind: 'helm',
    gitRepository: 'github.com/acme/charts',
    gitRevision: 'checkout-1.8.2',
    gitPath: 'charts/checkout',
    health: 'degraded',
    syncStatus: 'out_of_sync',
    autoSync: true,
    selfHeal: false,
    prune: true,
    lastSyncedAt: isoAgo(184),
    revisionCount: 27,
    resources: buildWorkload({
      app: 'checkout-api',
      namespace: 'production',
      image: 'ghcr.io/acme/checkout:1.8.2',
      replicas: 3,
      health: 'degraded',
      withIngress: true,
      withConfig: true,
      drift: [
        { path: 'spec.replicas', desired: '3', live: '6', lastWriter: 'kubectl-scale' },
        { path: 'spec.template.spec.containers[0].resources.limits.memory', desired: '512Mi', live: '1Gi', lastWriter: 'kubectl-edit' },
      ],
      pods: [
        { suffix: 'h3k9s', health: 'healthy', node: 'ip-10-0-2-18' },
        { suffix: 'b7n2v', health: 'healthy', node: 'ip-10-0-4-77' },
        { suffix: 'z1c5j', health: 'degraded', restarts: 7, message: 'CrashLoopBackOff', node: 'ip-10-0-3-41' },
      ],
    }),
  },
  {
    id: 'app-catalog',
    projectId: 'proj-shop',
    clusterId: 'cl-prod-us',
    namespace: 'production',
    name: 'catalog',
    sourceKind: 'kustomize',
    gitRepository: 'github.com/acme/shop-manifests',
    gitRevision: 'main@4f2a19c',
    gitPath: 'apps/catalog/overlays/us',
    health: 'progressing',
    syncStatus: 'in_sync',
    autoSync: false,
    selfHeal: false,
    prune: false,
    lastSyncedAt: isoAgo(6),
    revisionCount: 19,
    resources: buildWorkload({
      app: 'catalog',
      namespace: 'production',
      image: 'ghcr.io/acme/catalog:3.1.0',
      replicas: 3,
      health: 'progressing',
      withConfig: true,
      pods: [
        { suffix: 'p8l4k', health: 'healthy', node: 'ip-10-1-2-9' },
        { suffix: 'd2f6m', health: 'healthy', node: 'ip-10-1-3-22' },
        { suffix: 'w5s3q', health: 'progressing', message: 'ContainerCreating', node: 'ip-10-1-4-14' },
      ],
    }),
  },
  {
    id: 'app-ingest',
    projectId: 'proj-data',
    clusterId: 'cl-staging',
    namespace: 'staging',
    name: 'event-ingest',
    sourceKind: 'manifest',
    health: 'healthy',
    syncStatus: 'in_sync',
    autoSync: false,
    selfHeal: false,
    prune: false,
    lastSyncedAt: isoAgo(920),
    revisionCount: 8,
    resources: buildWorkload({
      app: 'event-ingest',
      namespace: 'staging',
      image: 'ghcr.io/acme/ingest:0.9.4',
      replicas: 2,
      health: 'healthy',
      pods: [
        { suffix: 'r4t7y', health: 'healthy', node: 'k3s-worker-1' },
        { suffix: 'n8m2x', health: 'healthy', node: 'k3s-worker-2' },
      ],
    }),
  },
];

export const deployments: DeploymentRecord[] = [
  {
    id: 'dep-41', applicationId: 'app-storefront', revision: 41, status: 'succeeded',
    strategy: 'server_side_apply', dryRun: false, startedAt: isoAgo(37), finishedAt: isoAgo(36),
    triggeredBy: 'dana@acme.test', message: 'bump storefront to 2.14.0',
    results: [
      { kind: 'Deployment', name: 'storefront', action: 'configured' },
      { kind: 'Service', name: 'storefront', action: 'unchanged' },
      { kind: 'Ingress', name: 'storefront', action: 'unchanged' },
    ],
  },
  {
    id: 'dep-40', applicationId: 'app-storefront', revision: 40, status: 'succeeded',
    strategy: 'server_side_apply', dryRun: false, startedAt: isoAgo(1480), finishedAt: isoAgo(1479),
    triggeredBy: 'ci-bot@acme.test', message: 'rotate storefront-secrets',
    results: [{ kind: 'Secret', name: 'storefront-secrets', action: 'configured' }],
  },
  {
    id: 'dep-27', applicationId: 'app-checkout', revision: 27, status: 'failed',
    strategy: 'server_side_apply', dryRun: false, startedAt: isoAgo(184), finishedAt: isoAgo(183),
    triggeredBy: 'sam@acme.test', message: 'checkout 1.8.2',
    results: [
      { kind: 'Deployment', name: 'checkout-api', action: 'configured' },
      { kind: 'HorizontalPodAutoscaler', name: 'checkout-api', action: 'failed', error: 'admission webhook denied: minReplicas must be >= 2' },
    ],
  },
  {
    id: 'dep-26', applicationId: 'app-checkout', revision: 26, status: 'succeeded',
    strategy: 'server_side_apply', dryRun: false, startedAt: isoAgo(3120), finishedAt: isoAgo(3119),
    triggeredBy: 'sam@acme.test', message: 'checkout 1.8.1',
    results: [{ kind: 'Deployment', name: 'checkout-api', action: 'configured' }],
  },
  {
    id: 'dep-19', applicationId: 'app-catalog', revision: 19, status: 'running',
    strategy: 'server_side_apply', dryRun: false, startedAt: isoAgo(6),
    triggeredBy: 'dana@acme.test', message: 'catalog 3.1.0',
    results: [{ kind: 'Deployment', name: 'catalog', action: 'configured' }],
  },
];

const ACTIONS: { action: string; kind?: string; status: ActivityEntry['status']; error?: string }[] = [
  { action: 'auth.login', status: 'success' },
  { action: 'auth.login.failed', status: 'failure', error: 'invalid credentials' },
  { action: 'auth.mfa.verified', status: 'success' },
  { action: 'auth.logout', status: 'success' },
  { action: 'manifest.create', kind: 'Deployment', status: 'success' },
  { action: 'manifest.update', kind: 'Service', status: 'success' },
  { action: 'manifest.import', kind: 'Ingress', status: 'success' },
  { action: 'manifest.export', kind: 'HelmChart', status: 'success' },
  { action: 'manifest.download', kind: 'Kustomization', status: 'success' },
  { action: 'git.commit', kind: 'Deployment', status: 'success' },
  { action: 'git.open_pull_request', kind: 'Deployment', status: 'success' },
  { action: 'deployment.dry_run', kind: 'Deployment', status: 'success' },
  { action: 'deployment.apply', kind: 'Deployment', status: 'success' },
  { action: 'deployment.apply', kind: 'HorizontalPodAutoscaler', status: 'failure', error: 'admission webhook denied: minReplicas must be >= 2' },
  { action: 'deployment.rollback', kind: 'Deployment', status: 'success' },
  { action: 'deployment.delete', kind: 'Job', status: 'success' },
  { action: 'cluster.connect', kind: 'Cluster', status: 'success' },
  { action: 'cluster.delete', kind: 'Cluster', status: 'denied', error: 'permission cluster.delete not granted' },
  { action: 'rbac.role_binding.create', kind: 'RoleBinding', status: 'success' },
  { action: 'settings.update', kind: 'Settings', status: 'success' },
  { action: 'apikey.create', kind: 'ApiKey', status: 'success' },
  { action: 'activity.export', status: 'success' },
];

const ACTORS = ['dana@acme.test', 'sam@acme.test', 'ci-bot@acme.test', 'priya@acme.test', 'unknown@external.test'];
const AGENTS = ['Chrome 140 on macOS', 'Firefox 131 on Linux', 'Claude Workbench CLI 0.4.2', 'Safari 18 on iOS'];
const IPS = ['203.0.113.7', '198.51.100.24', '203.0.113.91', '192.0.2.44'];
const TARGETS = ['storefront', 'checkout-api', 'catalog', 'event-ingest', 'prod-eu', 'shop'];

export const activity: ActivityEntry[] = Array.from({ length: 220 }, (_, index) => {
  const template = ACTIONS[Math.floor(random() * ACTIONS.length)];
  const actor = template.action === 'auth.login.failed'
    ? ACTORS[4]
    : ACTORS[Math.floor(random() * 4)];
  const cluster = clusters[Math.floor(random() * clusters.length)];
  const minutesAgo = Math.floor(index * 19 + random() * 17);
  const isWrite = /apply|rollback|delete|update|create/.test(template.action);
  return {
    id: 100000 - index,
    occurredAt: isoAgo(minutesAgo),
    actorEmail: actor,
    sessionId: actor === 'ci-bot@acme.test' ? undefined : `sess-${1 + Math.floor(random() * 3)}`,
    apiKeyId: actor === 'ci-bot@acme.test' ? 'key-ci-01' : undefined,
    ip: IPS[Math.floor(random() * IPS.length)],
    userAgent: AGENTS[Math.floor(random() * AGENTS.length)],
    projectSlug: projects[Math.floor(random() * projects.length)].slug,
    clusterSlug: template.action.startsWith('auth.') ? undefined : cluster.slug,
    namespace: template.action.startsWith('auth.') ? undefined : cluster.namespaces[0],
    action: template.action,
    targetKind: template.kind,
    targetName: template.kind ? TARGETS[Math.floor(random() * TARGETS.length)] : undefined,
    status: template.status,
    error: template.error,
    oldValue: isWrite ? { replicas: 3 } : undefined,
    newValue: isWrite ? { replicas: 4 } : undefined,
    requestId: `req_${(1e12 + Math.floor(random() * 8e11)).toString(36)}`,
  };
}).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
