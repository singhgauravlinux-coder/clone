import type { ResourceDefinition } from '../core/types';
import { get, num, str } from '../core/model';
import { slug, yamlFile } from '../core/files';
import { checkName } from '../core/validation';
import { buildMeta, loadMeta, metaDefaults, metaFields, validateMeta } from './shared';

export const horizontalPodAutoscaler: ResourceDefinition = {
  id: 'hpa',
  group: 'Autoscaling',
  label: 'HorizontalPodAutoscaler',
  summary: 'Scale a workload on CPU, memory, or a custom metric.',
  apiVersion: 'autoscaling/v2',
  kinds: ['HorizontalPodAutoscaler'],
  fields: [
    ...metaFields(),
    {
      path: 'target.kind', label: 'Target kind', kind: 'select', half: true, section: 'Scale target',
      options: [
        { value: 'Deployment', label: 'Deployment' },
        { value: 'StatefulSet', label: 'StatefulSet' },
        { value: 'ReplicaSet', label: 'ReplicaSet' },
      ],
    },
    { path: 'target.name', label: 'Target name', kind: 'text', mono: true, half: true, required: true, section: 'Scale target' },
    { path: 'spec.minReplicas', label: 'Min replicas', kind: 'number', half: true, min: 1, section: 'Range' },
    { path: 'spec.maxReplicas', label: 'Max replicas', kind: 'number', half: true, min: 1, required: true, section: 'Range' },
    {
      path: 'metrics.cpu', label: 'Target CPU utilization (%)', kind: 'number', half: true, min: 1, max: 100,
      section: 'Metrics', help: 'Percentage of the CPU request. Leave empty to skip.',
    },
    {
      path: 'metrics.memory', label: 'Target memory utilization (%)', kind: 'number', half: true, min: 1, max: 100,
      section: 'Metrics',
    },
    {
      path: 'metrics.custom', label: 'Pod metrics', kind: 'array', section: 'Metrics', itemLabel: 'metric',
      itemDefault: () => ({ name: '', value: '' }),
      itemFields: [
        { path: 'name', label: 'Metric name', kind: 'text', mono: true, half: true, required: true, placeholder: 'http_requests_per_second' },
        { path: 'value', label: 'Average value', kind: 'text', mono: true, half: true, required: true, placeholder: '100' },
      ],
    },
    {
      path: 'behavior.scaleDownStabilization', label: 'Scale down stabilization (s)', kind: 'number', half: true,
      min: 0, section: 'Behavior', help: 'How long to wait before scaling down. Default is 300.',
    },
    {
      path: 'behavior.scaleUpStabilization', label: 'Scale up stabilization (s)', kind: 'number', half: true, min: 0,
      section: 'Behavior',
    },
  ],
  defaults: () => ({
    ...metaDefaults('web'),
    target: { kind: 'Deployment', name: 'web' },
    spec: { minReplicas: 2, maxReplicas: 10 },
    metrics: { cpu: 70, memory: '', custom: [] },
    behavior: { scaleDownStabilization: '', scaleUpStabilization: '' },
  }),
  build: (model) => {
    const resourceMetric = (name: string, value: any) => (num(value) === undefined ? undefined : {
      type: 'Resource',
      resource: { name, target: { type: 'Utilization', averageUtilization: num(value) } },
    });
    const metrics = [
      resourceMetric('cpu', get(model, 'metrics.cpu')),
      resourceMetric('memory', get(model, 'metrics.memory')),
      ...(get(model, 'metrics.custom') ?? [])
        .filter((metric: any) => str(metric?.name))
        .map((metric: any) => ({
          type: 'Pods',
          pods: { metric: { name: str(metric.name) }, target: { type: 'AverageValue', averageValue: str(metric.value) } },
        })),
    ].filter(Boolean);
    const scaleDown = num(get(model, 'behavior.scaleDownStabilization'));
    const scaleUp = num(get(model, 'behavior.scaleUpStabilization'));
    return [yamlFile(`${slug(get(model, 'metadata.name'), 'hpa')}-hpa.yaml`, {
      apiVersion: 'autoscaling/v2',
      kind: 'HorizontalPodAutoscaler',
      metadata: buildMeta(model),
      spec: {
        scaleTargetRef: {
          apiVersion: 'apps/v1',
          kind: get(model, 'target.kind') || 'Deployment',
          name: str(get(model, 'target.name')),
        },
        minReplicas: num(get(model, 'spec.minReplicas')),
        maxReplicas: num(get(model, 'spec.maxReplicas')),
        metrics: metrics.length ? metrics : undefined,
        behavior: scaleDown === undefined && scaleUp === undefined ? undefined : {
          scaleDown: scaleDown === undefined ? undefined : { stabilizationWindowSeconds: scaleDown },
          scaleUp: scaleUp === undefined ? undefined : { stabilizationWindowSeconds: scaleUp },
        },
      },
    })];
  },
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'HorizontalPodAutoscaler');
    if (!doc) return null;
    const metrics: any[] = doc?.spec?.metrics ?? [];
    const resource = (name: string) => metrics
      .find((metric) => metric?.type === 'Resource' && metric?.resource?.name === name)
      ?.resource?.target?.averageUtilization ?? '';
    return {
      ...loadMeta(doc),
      target: {
        kind: doc?.spec?.scaleTargetRef?.kind ?? 'Deployment',
        name: doc?.spec?.scaleTargetRef?.name ?? '',
      },
      spec: { minReplicas: doc?.spec?.minReplicas ?? '', maxReplicas: doc?.spec?.maxReplicas ?? '' },
      metrics: {
        cpu: resource('cpu'),
        memory: resource('memory'),
        custom: metrics.filter((metric) => metric?.type === 'Pods').map((metric) => ({
          name: metric?.pods?.metric?.name ?? '',
          value: String(metric?.pods?.target?.averageValue ?? ''),
        })),
      },
      behavior: {
        scaleDownStabilization: doc?.spec?.behavior?.scaleDown?.stabilizationWindowSeconds ?? '',
        scaleUpStabilization: doc?.spec?.behavior?.scaleUp?.stabilizationWindowSeconds ?? '',
      },
    };
  },
  validate: (model) => {
    const issues = [...validateMeta(model), ...checkName(get(model, 'target.name'), 'target.name', 'Target name')];
    const min = num(get(model, 'spec.minReplicas'));
    const max = num(get(model, 'spec.maxReplicas'));
    if (max === undefined) {
      issues.push({ level: 'error', message: 'Max replicas is required', path: 'spec.maxReplicas' });
    } else if (min !== undefined && min > max) {
      issues.push({ level: 'error', message: 'Min replicas cannot exceed max replicas', path: 'spec.minReplicas' });
    }
    const hasMetric = num(get(model, 'metrics.cpu')) !== undefined
      || num(get(model, 'metrics.memory')) !== undefined
      || (get(model, 'metrics.custom') ?? []).some((metric: any) => str(metric?.name));
    if (!hasMetric) {
      issues.push({ level: 'error', message: 'An autoscaler needs at least one metric', path: 'metrics.cpu' });
    }
    if (num(get(model, 'metrics.cpu')) !== undefined) {
      issues.push({
        level: 'warning',
        message: 'CPU utilization is a percentage of the container CPU request, so the target workload must set one',
        path: 'metrics.cpu',
      });
    }
    return issues;
  },
};
