import type { Issue, ResourceDefinition } from '../core/types';
import { get, mapToPairs, num, pairsToMap, str, toList } from '../core/model';
import { slug, yamlFile } from '../core/files';
import { checkName, checkPort, DNS_1123_SUBDOMAIN } from '../core/validation';
import { buildMeta, loadMeta, metaDefaults, metaFields, validateMeta } from './shared';

/* ── Service ─────────────────────────────────────────────────────────────── */

export const service: ResourceDefinition = {
  id: 'service',
  group: 'Networking',
  label: 'Service',
  summary: 'Stable virtual IP and DNS name for a set of pods.',
  apiVersion: 'v1',
  kinds: ['Service'],
  fields: [
    ...metaFields(),
    {
      path: 'spec.type', label: 'Type', kind: 'select', half: true, section: 'Routing',
      options: [
        { value: 'ClusterIP', label: 'ClusterIP' },
        { value: 'NodePort', label: 'NodePort' },
        { value: 'LoadBalancer', label: 'LoadBalancer' },
        { value: 'ExternalName', label: 'ExternalName' },
      ],
    },
    {
      path: 'spec.headless', label: 'Headless (clusterIP: None)', kind: 'boolean', half: true, section: 'Routing',
      when: (model) => get(model, 'spec.type') === 'ClusterIP',
      help: 'Use for StatefulSet peer discovery.',
    },
    {
      path: 'spec.externalName', label: 'External name', kind: 'text', mono: true, section: 'Routing',
      when: (model) => get(model, 'spec.type') === 'ExternalName', required: true,
      placeholder: 'db.example.com',
    },
    {
      path: 'spec.sessionAffinity', label: 'Session affinity', kind: 'select', half: true, section: 'Routing',
      options: [{ value: 'None', label: 'None' }, { value: 'ClientIP', label: 'ClientIP' }],
      when: (model) => get(model, 'spec.type') !== 'ExternalName',
    },
    {
      path: 'spec.externalTrafficPolicy', label: 'External traffic policy', kind: 'select', half: true,
      section: 'Routing',
      options: [{ value: '', label: 'Cluster (default)' }, { value: 'Local', label: 'Local (preserve source IP)' }],
      when: (model) => ['NodePort', 'LoadBalancer'].includes(get(model, 'spec.type')),
    },
    {
      path: 'selector', label: 'Pod selector', kind: 'keyvalue', section: 'Selector', required: true,
      when: (model) => get(model, 'spec.type') !== 'ExternalName',
      help: 'Must match the pod labels of the workload.',
    },
    {
      path: 'ports', label: 'Ports', kind: 'array', section: 'Ports', itemLabel: 'port',
      when: (model) => get(model, 'spec.type') !== 'ExternalName',
      itemDefault: () => ({ name: 'http', port: 80, targetPort: 'http', protocol: 'TCP', nodePort: '' }),
      itemFields: [
        {
          path: 'name', label: 'Name', kind: 'text', mono: true, half: true, placeholder: 'http',
          help: 'Required when more than one port is listed.',
        },
        { path: 'port', label: 'Service port', kind: 'number', half: true, required: true, min: 1, max: 65535 },
        {
          path: 'targetPort', label: 'Target port', kind: 'text', mono: true, half: true,
          placeholder: 'http or 8080', help: 'Container port name or number.',
        },
        {
          path: 'protocol', label: 'Protocol', kind: 'select', half: true,
          options: [{ value: 'TCP', label: 'TCP' }, { value: 'UDP', label: 'UDP' }, { value: 'SCTP', label: 'SCTP' }],
        },
        {
          path: 'nodePort', label: 'Node port', kind: 'number', half: true, min: 30000, max: 32767,
          help: '30000-32767. Leave empty to let the cluster pick.',
        },
      ],
    },
  ],
  defaults: () => ({
    ...metaDefaults('web'),
    spec: {
      type: 'ClusterIP', headless: false, externalName: '', sessionAffinity: 'None', externalTrafficPolicy: '',
    },
    selector: [{ key: 'app', value: 'web' }],
    ports: [{ name: 'http', port: 80, targetPort: 'http', protocol: 'TCP', nodePort: '' }],
  }),
  build: (model) => {
    const type = get(model, 'spec.type') || 'ClusterIP';
    const isExternalName = type === 'ExternalName';
    return [yamlFile(`${slug(get(model, 'metadata.name'), 'service')}-service.yaml`, {
      apiVersion: 'v1',
      kind: 'Service',
      metadata: buildMeta(model),
      spec: {
        type: type === 'ClusterIP' ? undefined : type,
        clusterIP: !isExternalName && get(model, 'spec.headless') === true ? 'None' : undefined,
        externalName: isExternalName ? str(get(model, 'spec.externalName')) : undefined,
        sessionAffinity: get(model, 'spec.sessionAffinity') === 'ClientIP' ? 'ClientIP' : undefined,
        externalTrafficPolicy: !isExternalName ? str(get(model, 'spec.externalTrafficPolicy')) : undefined,
        selector: isExternalName ? undefined : pairsToMap(get(model, 'selector')),
        ports: isExternalName ? undefined : (get(model, 'ports') ?? [])
          .filter((port: any) => num(port?.port) !== undefined)
          .map((port: any) => {
            const target = str(port.targetPort);
            return {
              name: str(port.name),
              port: num(port.port),
              targetPort: target && /^\d+$/.test(target) ? Number(target) : target,
              protocol: port.protocol && port.protocol !== 'TCP' ? port.protocol : undefined,
              nodePort: num(port.nodePort),
            };
          }),
      },
    })];
  },
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'Service');
    if (!doc) return null;
    return {
      ...loadMeta(doc),
      spec: {
        type: doc?.spec?.type ?? 'ClusterIP',
        headless: doc?.spec?.clusterIP === 'None',
        externalName: doc?.spec?.externalName ?? '',
        sessionAffinity: doc?.spec?.sessionAffinity ?? 'None',
        externalTrafficPolicy: doc?.spec?.externalTrafficPolicy ?? '',
      },
      selector: mapToPairs(doc?.spec?.selector),
      ports: (doc?.spec?.ports ?? []).map((port: any) => ({
        name: port?.name ?? '',
        port: port?.port ?? '',
        targetPort: port?.targetPort === undefined ? '' : String(port.targetPort),
        protocol: port?.protocol ?? 'TCP',
        nodePort: port?.nodePort ?? '',
      })),
    };
  },
  validate: (model) => {
    const issues: Issue[] = [...validateMeta(model)];
    const type = get(model, 'spec.type');
    const ports = get(model, 'ports') ?? [];
    if (type !== 'ExternalName') {
      if (!(get(model, 'selector') ?? []).some((row: any) => str(row?.key))) {
        issues.push({ level: 'error', message: 'A Service with no selector never gets endpoints', path: 'selector' });
      }
      if (!ports.length) issues.push({ level: 'error', message: 'At least one port is required', path: 'ports' });
      if (ports.length > 1) {
        ports.forEach((port: any, index: number) => {
          if (!str(port?.name)) {
            issues.push({ level: 'error', message: 'Every port needs a name when a Service exposes more than one', path: `ports.${index}.name` });
          }
        });
      }
      ports.forEach((port: any, index: number) => {
        issues.push(...checkPort(port?.port, `ports.${index}.port`, 'Service port'));
        if (str(port?.nodePort)) {
          const nodePort = Number(port.nodePort);
          if (nodePort < 30000 || nodePort > 32767) {
            issues.push({ level: 'error', message: 'Node port must be between 30000 and 32767', path: `ports.${index}.nodePort` });
          }
          if (type === 'ClusterIP') {
            issues.push({ level: 'warning', message: 'Node ports are ignored on a ClusterIP Service', path: `ports.${index}.nodePort` });
          }
        }
      });
    } else if (!DNS_1123_SUBDOMAIN.test(String(get(model, 'spec.externalName') ?? ''))) {
      issues.push({ level: 'error', message: 'External name must be a DNS name', path: 'spec.externalName' });
    }
    return issues;
  },
};

/* ── Ingress ─────────────────────────────────────────────────────────────── */

export const ingress: ResourceDefinition = {
  id: 'ingress',
  group: 'Networking',
  label: 'Ingress',
  summary: 'HTTP routing from outside the cluster to Services.',
  apiVersion: 'networking.k8s.io/v1',
  kinds: ['Ingress'],
  fields: [
    ...metaFields(),
    {
      path: 'spec.ingressClassName', label: 'Ingress class', kind: 'text', mono: true, half: true,
      section: 'Controller', placeholder: 'nginx',
    },
    {
      path: 'rules', label: 'Rules', kind: 'array', section: 'Rules', itemLabel: 'host rule', required: true,
      itemDefault: () => ({ host: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }] }),
      itemFields: [
        { path: 'host', label: 'Host', kind: 'text', mono: true, placeholder: 'app.example.com', help: 'Leave empty to match any host.' },
        {
          path: 'paths', label: 'Paths', kind: 'array', itemLabel: 'path',
          itemDefault: () => ({ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }),
          itemFields: [
            { path: 'path', label: 'Path', kind: 'text', mono: true, half: true, required: true, placeholder: '/' },
            {
              path: 'pathType', label: 'Path type', kind: 'select', half: true,
              options: [
                { value: 'Prefix', label: 'Prefix' },
                { value: 'Exact', label: 'Exact' },
                { value: 'ImplementationSpecific', label: 'ImplementationSpecific' },
              ],
            },
            { path: 'serviceName', label: 'Service', kind: 'text', mono: true, half: true, required: true },
            {
              path: 'servicePort', label: 'Service port', kind: 'text', mono: true, half: true, required: true,
              placeholder: '80 or http',
            },
          ],
        },
      ],
    },
    {
      path: 'tls', label: 'TLS', kind: 'array', section: 'TLS', itemLabel: 'certificate',
      itemDefault: () => ({ secretName: '', hosts: '' }),
      itemFields: [
        { path: 'secretName', label: 'Secret name', kind: 'text', mono: true, half: true, required: true },
        { path: 'hosts', label: 'Hosts', kind: 'text', mono: true, half: true, help: 'Comma separated.' },
      ],
    },
  ],
  defaults: () => ({
    ...metaDefaults('web'),
    spec: { ingressClassName: 'nginx' },
    rules: [{ host: 'app.example.com', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'web', servicePort: '80' }] }],
    tls: [],
  }),
  build: (model) => [yamlFile(`${slug(get(model, 'metadata.name'), 'ingress')}-ingress.yaml`, {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: buildMeta(model),
    spec: {
      ingressClassName: str(get(model, 'spec.ingressClassName')),
      tls: (get(model, 'tls') ?? [])
        .filter((entry: any) => str(entry?.secretName))
        .map((entry: any) => ({ hosts: toList(entry.hosts), secretName: str(entry.secretName) })),
      rules: (get(model, 'rules') ?? []).map((rule: any) => ({
        host: str(rule?.host),
        http: {
          paths: (rule?.paths ?? [])
            .filter((path: any) => str(path?.serviceName))
            .map((path: any) => {
              const port = str(path.servicePort);
              return {
                path: str(path.path) ?? '/',
                pathType: path.pathType || 'Prefix',
                backend: {
                  service: {
                    name: str(path.serviceName),
                    port: port && /^\d+$/.test(port) ? { number: Number(port) } : { name: port },
                  },
                },
              };
            }),
        },
      })),
    },
  })],
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'Ingress');
    if (!doc) return null;
    return {
      ...loadMeta(doc),
      spec: { ingressClassName: doc?.spec?.ingressClassName ?? '' },
      rules: (doc?.spec?.rules ?? []).map((rule: any) => ({
        host: rule?.host ?? '',
        paths: (rule?.http?.paths ?? []).map((path: any) => ({
          path: path?.path ?? '/',
          pathType: path?.pathType ?? 'Prefix',
          serviceName: path?.backend?.service?.name ?? '',
          servicePort: String(path?.backend?.service?.port?.number ?? path?.backend?.service?.port?.name ?? ''),
        })),
      })),
      tls: (doc?.spec?.tls ?? []).map((entry: any) => ({
        secretName: entry?.secretName ?? '',
        hosts: (entry?.hosts ?? []).join(', '),
      })),
    };
  },
  validate: (model) => {
    const issues: Issue[] = [...validateMeta(model)];
    const rules = get(model, 'rules') ?? [];
    if (!rules.length) issues.push({ level: 'error', message: 'At least one rule is required', path: 'rules' });
    rules.forEach((rule: any, index: number) => {
      const host = str(rule?.host);
      if (host && !DNS_1123_SUBDOMAIN.test(host.replace(/^\*\./, ''))) {
        issues.push({ level: 'error', message: `Host "${host}" is not a valid DNS name`, path: `rules.${index}.host` });
      }
      const paths = rule?.paths ?? [];
      if (!paths.length) {
        issues.push({ level: 'error', message: 'A rule needs at least one path', path: `rules.${index}.paths` });
      }
      paths.forEach((path: any, pathIndex: number) => {
        const base = `rules.${index}.paths.${pathIndex}`;
        if (str(path?.path) && !String(path.path).startsWith('/')) {
          issues.push({ level: 'error', message: 'Path must start with "/"', path: `${base}.path` });
        }
        issues.push(...checkName(path?.serviceName, `${base}.serviceName`, 'Service'));
        const port = str(path?.servicePort);
        if (port && /^\d+$/.test(port)) issues.push(...checkPort(port, `${base}.servicePort`, 'Service port'));
      });
    });
    if (!str(get(model, 'spec.ingressClassName'))) {
      issues.push({ level: 'warning', message: 'No ingress class set, so the cluster default controller handles this', path: 'spec.ingressClassName' });
    }
    return issues;
  },
};
