import type { FieldDef, Issue, Model } from '../core/types';
import { get, mapToPairs, num, pairsToMap, str, toList } from '../core/model';
import { checkImage, checkLabels, checkName, checkPort, checkQuantity } from '../core/validation';

/* ── Object metadata ─────────────────────────────────────────────────────── */

export function metaFields(nameHelp?: string): FieldDef[] {
  return [
    {
      path: 'metadata.name',
      label: 'Name',
      kind: 'text',
      required: true,
      mono: true,
      half: true,
      section: 'Metadata',
      placeholder: 'web',
      help: nameHelp ?? 'Lowercase letters, numbers, "-" and "." only.',
    },
    {
      path: 'metadata.namespace',
      label: 'Namespace',
      kind: 'text',
      mono: true,
      half: true,
      section: 'Metadata',
      placeholder: 'default',
      help: 'Leave empty to let the applying tool choose.',
    },
    {
      path: 'metadata.labels',
      label: 'Labels',
      kind: 'keyvalue',
      section: 'Metadata',
      keyLabel: 'key',
      valueLabel: 'value',
    },
    {
      path: 'metadata.annotations',
      label: 'Annotations',
      kind: 'keyvalue',
      section: 'Metadata',
      keyLabel: 'key',
      valueLabel: 'value',
    },
  ];
}

export function metaDefaults(name: string): Model {
  return { metadata: { name, namespace: '', labels: [{ key: 'app', value: name }], annotations: [] } };
}

export function buildMeta(model: Model): Record<string, any> {
  return {
    name: str(get(model, 'metadata.name')),
    namespace: str(get(model, 'metadata.namespace')),
    labels: pairsToMap(get(model, 'metadata.labels')),
    annotations: pairsToMap(get(model, 'metadata.annotations')),
  };
}

export function loadMeta(doc: any): Model {
  const meta = doc?.metadata ?? {};
  return {
    metadata: {
      name: meta.name ?? '',
      namespace: meta.namespace ?? '',
      labels: mapToPairs(meta.labels),
      annotations: mapToPairs(meta.annotations),
    },
  };
}

export function validateMeta(model: Model): Issue[] {
  return [
    ...checkName(get(model, 'metadata.name'), 'metadata.name'),
    ...(str(get(model, 'metadata.namespace'))
      ? checkName(get(model, 'metadata.namespace'), 'metadata.namespace', 'Namespace')
      : []),
    ...checkLabels(get(model, 'metadata.labels'), 'metadata.labels'),
    ...checkLabels(get(model, 'metadata.annotations'), 'metadata.annotations', 'Annotations'),
  ];
}

/* ── Containers and pod spec ─────────────────────────────────────────────── */

const PROBE_KINDS = [
  { value: '', label: 'None' },
  { value: 'httpGet', label: 'HTTP GET' },
  { value: 'tcpSocket', label: 'TCP socket' },
  { value: 'exec', label: 'Command' },
];

function probeFields(kind: 'readiness' | 'liveness'): FieldDef[] {
  const label = kind === 'readiness' ? 'Readiness' : 'Liveness';
  const active = (model: Model) => !!str(get(model, `${kind}.type`));
  return [
    { path: `${kind}.type`, label: `${label} probe`, kind: 'select', options: PROBE_KINDS, half: true },
    {
      path: `${kind}.path`, label: `${label} path`, kind: 'text', mono: true, half: true,
      when: (model) => get(model, `${kind}.type`) === 'httpGet', placeholder: '/healthz',
    },
    {
      path: `${kind}.port`, label: `${label} port`, kind: 'text', mono: true, half: true,
      when: (model) => ['httpGet', 'tcpSocket'].includes(get(model, `${kind}.type`)), placeholder: 'http or 8080',
    },
    {
      path: `${kind}.command`, label: `${label} command`, kind: 'text', mono: true, half: true,
      when: (model) => get(model, `${kind}.type`) === 'exec', placeholder: 'cat, /tmp/ready',
      help: 'Comma separated.',
    },
    {
      path: `${kind}.initialDelaySeconds`, label: 'Initial delay (s)', kind: 'number', half: true, min: 0, when: active,
    },
    { path: `${kind}.periodSeconds`, label: 'Period (s)', kind: 'number', half: true, min: 1, when: active },
  ];
}

function buildProbe(model: Model, kind: 'readiness' | 'liveness'): any {
  const type = str(get(model, `${kind}.type`));
  if (!type) return undefined;
  const rawPort = str(get(model, `${kind}.port`));
  const port = rawPort && /^\d+$/.test(rawPort) ? Number(rawPort) : rawPort;
  const probe: Record<string, any> = {
    initialDelaySeconds: num(get(model, `${kind}.initialDelaySeconds`)),
    periodSeconds: num(get(model, `${kind}.periodSeconds`)),
  };
  if (type === 'httpGet') probe.httpGet = { path: str(get(model, `${kind}.path`)) ?? '/', port: port ?? 'http' };
  if (type === 'tcpSocket') probe.tcpSocket = { port: port ?? 'http' };
  if (type === 'exec') probe.exec = { command: toList(get(model, `${kind}.command`)) };
  return probe;
}

function loadProbe(probe: any, kind: 'readiness' | 'liveness'): Model {
  if (!probe) return { [kind]: { type: '' } };
  const type = probe.httpGet ? 'httpGet' : probe.tcpSocket ? 'tcpSocket' : probe.exec ? 'exec' : '';
  const source = probe.httpGet ?? probe.tcpSocket ?? {};
  return {
    [kind]: {
      type,
      path: probe.httpGet?.path ?? '',
      port: source.port === undefined ? '' : String(source.port),
      command: (probe.exec?.command ?? []).join(', '),
      initialDelaySeconds: probe.initialDelaySeconds ?? '',
      periodSeconds: probe.periodSeconds ?? '',
    },
  };
}

export const containerFields: FieldDef[] = [
  { path: 'name', label: 'Container name', kind: 'text', required: true, mono: true, half: true, placeholder: 'web' },
  { path: 'image', label: 'Image', kind: 'text', required: true, mono: true, half: true, placeholder: 'nginx:1.27' },
  {
    path: 'imagePullPolicy', label: 'Pull policy', kind: 'select', half: true,
    options: [
      { value: '', label: 'Cluster default' },
      { value: 'IfNotPresent', label: 'IfNotPresent' },
      { value: 'Always', label: 'Always' },
      { value: 'Never', label: 'Never' },
    ],
  },
  { path: 'command', label: 'Command (entrypoint)', kind: 'text', mono: true, half: true, placeholder: '/bin/sh, -c', help: 'Comma separated.' },
  { path: 'args', label: 'Args', kind: 'text', mono: true, placeholder: '--port=8080, --verbose', help: 'Comma separated.' },
  {
    path: 'ports', label: 'Container ports', kind: 'array', itemLabel: 'port',
    itemDefault: () => ({ name: 'http', containerPort: 8080, protocol: 'TCP' }),
    itemFields: [
      { path: 'name', label: 'Name', kind: 'text', mono: true, half: true, placeholder: 'http' },
      { path: 'containerPort', label: 'Port', kind: 'number', half: true, required: true, min: 1, max: 65535 },
      {
        path: 'protocol', label: 'Protocol', kind: 'select', half: true,
        options: [{ value: 'TCP', label: 'TCP' }, { value: 'UDP', label: 'UDP' }, { value: 'SCTP', label: 'SCTP' }],
      },
    ],
  },
  { path: 'env', label: 'Environment variables', kind: 'keyvalue', keyLabel: 'NAME', valueLabel: 'value' },
  {
    path: 'envFrom', label: 'Env from ConfigMap or Secret', kind: 'array', itemLabel: 'source',
    itemDefault: () => ({ kind: 'configMapRef', name: '' }),
    itemFields: [
      {
        path: 'kind', label: 'Source', kind: 'select', half: true,
        options: [{ value: 'configMapRef', label: 'ConfigMap' }, { value: 'secretRef', label: 'Secret' }],
      },
      { path: 'name', label: 'Name', kind: 'text', mono: true, half: true, required: true },
    ],
  },
  { path: 'resources.requests.cpu', label: 'CPU request', kind: 'text', mono: true, half: true, placeholder: '100m' },
  { path: 'resources.requests.memory', label: 'Memory request', kind: 'text', mono: true, half: true, placeholder: '128Mi' },
  { path: 'resources.limits.cpu', label: 'CPU limit', kind: 'text', mono: true, half: true, placeholder: '500m' },
  { path: 'resources.limits.memory', label: 'Memory limit', kind: 'text', mono: true, half: true, placeholder: '512Mi' },
  {
    path: 'volumeMounts', label: 'Volume mounts', kind: 'array', itemLabel: 'mount',
    itemDefault: () => ({ name: '', mountPath: '', readOnly: false }),
    itemFields: [
      { path: 'name', label: 'Volume name', kind: 'text', mono: true, half: true, required: true },
      { path: 'mountPath', label: 'Mount path', kind: 'text', mono: true, half: true, required: true, placeholder: '/data' },
      { path: 'subPath', label: 'Sub path', kind: 'text', mono: true, half: true },
      { path: 'readOnly', label: 'Read only', kind: 'boolean', half: true },
    ],
  },
  ...probeFields('readiness'),
  ...probeFields('liveness'),
];

export function newContainer(name = 'app', image = ''): Model {
  return {
    name,
    image,
    imagePullPolicy: '',
    command: '',
    args: '',
    ports: [{ name: 'http', containerPort: 8080, protocol: 'TCP' }],
    env: [],
    envFrom: [],
    resources: { requests: { cpu: '', memory: '' }, limits: { cpu: '', memory: '' } },
    volumeMounts: [],
    readiness: { type: '' },
    liveness: { type: '' },
  };
}

export function buildContainer(model: Model): any {
  const env = (get(model, 'env') ?? [])
    .filter((row: any) => str(row?.key))
    .map((row: any) => ({ name: str(row.key), value: String(row.value ?? '') }));
  const envFrom = (get(model, 'envFrom') ?? [])
    .filter((row: any) => str(row?.name))
    .map((row: any) => ({ [row.kind || 'configMapRef']: { name: str(row.name) } }));
  const requests = {
    cpu: str(get(model, 'resources.requests.cpu')),
    memory: str(get(model, 'resources.requests.memory')),
  };
  const limits = {
    cpu: str(get(model, 'resources.limits.cpu')),
    memory: str(get(model, 'resources.limits.memory')),
  };
  return {
    name: str(model.name),
    image: str(model.image),
    imagePullPolicy: str(model.imagePullPolicy),
    command: toList(model.command),
    args: toList(model.args),
    ports: (get(model, 'ports') ?? [])
      .filter((port: any) => num(port?.containerPort) !== undefined)
      .map((port: any) => ({
        name: str(port.name),
        containerPort: num(port.containerPort),
        protocol: port.protocol && port.protocol !== 'TCP' ? port.protocol : undefined,
      })),
    env: env.length ? env : undefined,
    envFrom: envFrom.length ? envFrom : undefined,
    resources: { requests, limits },
    volumeMounts: (get(model, 'volumeMounts') ?? [])
      .filter((mount: any) => str(mount?.name) && str(mount?.mountPath))
      .map((mount: any) => ({
        name: str(mount.name),
        mountPath: str(mount.mountPath),
        subPath: str(mount.subPath),
        readOnly: mount.readOnly === true ? true : undefined,
      })),
    readinessProbe: buildProbe(model, 'readiness'),
    livenessProbe: buildProbe(model, 'liveness'),
  };
}

export function loadContainer(container: any): Model {
  return {
    name: container?.name ?? '',
    image: container?.image ?? '',
    imagePullPolicy: container?.imagePullPolicy ?? '',
    command: (container?.command ?? []).join(', '),
    args: (container?.args ?? []).join(', '),
    ports: (container?.ports ?? []).map((port: any) => ({
      name: port?.name ?? '',
      containerPort: port?.containerPort ?? '',
      protocol: port?.protocol ?? 'TCP',
    })),
    env: (container?.env ?? [])
      .filter((entry: any) => entry?.value !== undefined || entry?.valueFrom === undefined)
      .map((entry: any) => ({ key: entry?.name ?? '', value: entry?.value ?? '' })),
    envFrom: (container?.envFrom ?? []).map((entry: any) => ({
      kind: entry?.secretRef ? 'secretRef' : 'configMapRef',
      name: entry?.secretRef?.name ?? entry?.configMapRef?.name ?? '',
    })),
    resources: {
      requests: {
        cpu: container?.resources?.requests?.cpu ?? '',
        memory: container?.resources?.requests?.memory ?? '',
      },
      limits: {
        cpu: container?.resources?.limits?.cpu ?? '',
        memory: container?.resources?.limits?.memory ?? '',
      },
    },
    volumeMounts: (container?.volumeMounts ?? []).map((mount: any) => ({
      name: mount?.name ?? '',
      mountPath: mount?.mountPath ?? '',
      subPath: mount?.subPath ?? '',
      readOnly: mount?.readOnly === true,
    })),
    ...loadProbe(container?.readinessProbe, 'readiness'),
    ...loadProbe(container?.livenessProbe, 'liveness'),
  };
}

/* ── Volumes ─────────────────────────────────────────────────────────────── */

export const volumeField: FieldDef = {
  path: 'volumes',
  label: 'Volumes',
  kind: 'array',
  section: 'Volumes',
  itemLabel: 'volume',
  itemDefault: () => ({ name: '', type: 'emptyDir', source: '' }),
  itemFields: [
    { path: 'name', label: 'Name', kind: 'text', mono: true, half: true, required: true },
    {
      path: 'type', label: 'Type', kind: 'select', half: true,
      options: [
        { value: 'emptyDir', label: 'emptyDir' },
        { value: 'configMap', label: 'ConfigMap' },
        { value: 'secret', label: 'Secret' },
        { value: 'persistentVolumeClaim', label: 'PersistentVolumeClaim' },
        { value: 'hostPath', label: 'hostPath' },
      ],
    },
    {
      path: 'source', label: 'Source name or path', kind: 'text', mono: true, required: true,
      when: (model) => model.type !== 'emptyDir',
      help: 'ConfigMap/Secret/PVC name, or the host path.',
    },
  ],
};

export function buildVolumes(model: Model): any[] | undefined {
  const volumes = (get(model, 'volumes') ?? [])
    .filter((volume: any) => str(volume?.name))
    .map((volume: any) => {
      const name = str(volume.name);
      const source = str(volume.source);
      switch (volume.type) {
        case 'configMap': return { name, configMap: { name: source } };
        case 'secret': return { name, secret: { secretName: source } };
        case 'persistentVolumeClaim': return { name, persistentVolumeClaim: { claimName: source } };
        case 'hostPath': return { name, hostPath: { path: source } };
        default: return { name, emptyDir: {} };
      }
    });
  return volumes.length ? volumes : undefined;
}

export function loadVolumes(volumes: any[] | undefined): Model[] {
  return (volumes ?? []).map((volume: any) => {
    if (volume?.configMap) return { name: volume.name, type: 'configMap', source: volume.configMap.name ?? '' };
    if (volume?.secret) return { name: volume.name, type: 'secret', source: volume.secret.secretName ?? '' };
    if (volume?.persistentVolumeClaim) {
      return { name: volume.name, type: 'persistentVolumeClaim', source: volume.persistentVolumeClaim.claimName ?? '' };
    }
    if (volume?.hostPath) return { name: volume.name, type: 'hostPath', source: volume.hostPath.path ?? '' };
    return { name: volume?.name ?? '', type: 'emptyDir', source: '' };
  });
}

/* ── Whole pod spec ──────────────────────────────────────────────────────── */

export const podFields: FieldDef[] = [
  {
    path: 'containers', label: 'Containers', kind: 'array', section: 'Containers', itemLabel: 'container',
    required: true, itemDefault: () => newContainer('app'), itemFields: containerFields,
  },
  volumeField,
  {
    path: 'pod.serviceAccountName', label: 'Service account', kind: 'text', mono: true, half: true,
    section: 'Pod settings',
  },
  {
    path: 'pod.imagePullSecrets', label: 'Image pull secrets', kind: 'text', mono: true, half: true,
    section: 'Pod settings', help: 'Comma separated secret names.',
  },
  { path: 'pod.nodeSelector', label: 'Node selector', kind: 'keyvalue', section: 'Pod settings' },
  {
    path: 'pod.terminationGracePeriodSeconds', label: 'Termination grace period (s)', kind: 'number', half: true,
    section: 'Pod settings', min: 0,
  },
  {
    path: 'pod.securityContext.runAsNonRoot', label: 'Run as non-root', kind: 'boolean', half: true,
    section: 'Pod settings',
  },
];

export function podDefaults(containerName: string, image = ''): Model {
  return {
    containers: [newContainer(containerName, image)],
    volumes: [],
    pod: {
      serviceAccountName: '',
      imagePullSecrets: '',
      nodeSelector: [],
      terminationGracePeriodSeconds: '',
      securityContext: { runAsNonRoot: false },
    },
  };
}

export function buildPodSpec(model: Model): any {
  const pullSecrets = toList(get(model, 'pod.imagePullSecrets'));
  return {
    serviceAccountName: str(get(model, 'pod.serviceAccountName')),
    imagePullSecrets: pullSecrets?.map((name) => ({ name })),
    nodeSelector: pairsToMap(get(model, 'pod.nodeSelector')),
    terminationGracePeriodSeconds: num(get(model, 'pod.terminationGracePeriodSeconds')),
    securityContext: get(model, 'pod.securityContext.runAsNonRoot') === true ? { runAsNonRoot: true } : undefined,
    containers: (get(model, 'containers') ?? []).map(buildContainer),
    volumes: buildVolumes(model),
  };
}

export function loadPodSpec(spec: any): Model {
  return {
    containers: (spec?.containers ?? []).map(loadContainer),
    volumes: loadVolumes(spec?.volumes),
    pod: {
      serviceAccountName: spec?.serviceAccountName ?? '',
      imagePullSecrets: (spec?.imagePullSecrets ?? []).map((entry: any) => entry?.name).filter(Boolean).join(', '),
      nodeSelector: mapToPairs(spec?.nodeSelector),
      terminationGracePeriodSeconds: spec?.terminationGracePeriodSeconds ?? '',
      securityContext: { runAsNonRoot: spec?.securityContext?.runAsNonRoot === true },
    },
  };
}

export function validatePodSpec(model: Model): Issue[] {
  const containers: Model[] = get(model, 'containers') ?? [];
  const issues: Issue[] = [];
  if (!containers.length) {
    issues.push({ level: 'error', message: 'At least one container is required', path: 'containers' });
  }
  const names = new Set<string>();
  const volumeNames = new Set((get(model, 'volumes') ?? []).map((volume: any) => str(volume?.name)).filter(Boolean));
  containers.forEach((container, index) => {
    const base = `containers.${index}`;
    issues.push(...checkName(container.name, `${base}.name`, 'Container name'));
    if (container.name && names.has(container.name)) {
      issues.push({ level: 'error', message: `Container name "${container.name}" is used twice`, path: `${base}.name` });
    }
    names.add(container.name);
    issues.push(...checkImage(container.image, `${base}.image`));
    (container.ports ?? []).forEach((port: any, portIndex: number) => {
      issues.push(...checkPort(port?.containerPort, `${base}.ports.${portIndex}.containerPort`, 'Container port'));
    });
    issues.push(
      ...checkQuantity(get(container, 'resources.requests.cpu'), `${base}.resources.requests.cpu`, 'CPU request'),
      ...checkQuantity(get(container, 'resources.limits.cpu'), `${base}.resources.limits.cpu`, 'CPU limit'),
      ...checkQuantity(get(container, 'resources.requests.memory'), `${base}.resources.requests.memory`, 'Memory request'),
      ...checkQuantity(get(container, 'resources.limits.memory'), `${base}.resources.limits.memory`, 'Memory limit'),
    );
    if (!str(get(container, 'resources.requests.cpu')) && !str(get(container, 'resources.limits.cpu'))) {
      issues.push({ level: 'warning', message: `Container "${container.name || index}" has no CPU request, so the scheduler treats it as best effort`, path: `${base}.resources.requests.cpu` });
    }
    (container.volumeMounts ?? []).forEach((mount: any, mountIndex: number) => {
      if (str(mount?.name) && !volumeNames.has(str(mount.name))) {
        issues.push({
          level: 'error',
          message: `Mount "${mount.name}" has no matching volume`,
          path: `${base}.volumeMounts.${mountIndex}.name`,
        });
      }
    });
  });
  return issues;
}
