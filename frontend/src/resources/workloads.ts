import type { FieldDef, Issue, Model, ResourceDefinition } from '../core/types';
import { get, mapToPairs, num, pairsToMap, str } from '../core/model';
import { slug, yamlFile } from '../core/files';
import { checkName, checkQuantity, checkSchedule } from '../core/validation';
import {
  buildMeta, buildPodSpec, loadMeta, loadPodSpec, metaDefaults, metaFields,
  podDefaults, podFields, validateMeta, validatePodSpec,
} from './shared';

/** Selector labels double as the pod template labels, as kubectl create does. */
const selectorField: FieldDef = {
  path: 'selector',
  label: 'Selector labels',
  kind: 'keyvalue',
  section: 'Selector',
  required: true,
  help: 'Also applied to the pod template. Immutable once the object exists.',
};

function selectorMap(model: Model): Record<string, string> {
  return pairsToMap(get(model, 'selector')) ?? { app: str(get(model, 'metadata.name')) ?? 'app' };
}

function podTemplate(model: Model) {
  return {
    metadata: {
      labels: selectorMap(model),
      annotations: pairsToMap(get(model, 'templateAnnotations')),
    },
    spec: buildPodSpec(model),
  };
}

const templateAnnotationsField: FieldDef = {
  path: 'templateAnnotations',
  label: 'Pod annotations',
  kind: 'keyvalue',
  section: 'Selector',
  help: 'Applied to pods only, not to the controller.',
};

function baseDefaults(name: string, containerName: string, image: string): Model {
  return {
    ...metaDefaults(name),
    selector: [{ key: 'app', value: name }],
    templateAnnotations: [],
    ...podDefaults(containerName, image),
  };
}

function baseLoad(doc: any): Model {
  const template = doc?.spec?.template ?? {};
  return {
    ...loadMeta(doc),
    selector: mapToPairs(doc?.spec?.selector?.matchLabels ?? template?.metadata?.labels),
    templateAnnotations: mapToPairs(template?.metadata?.annotations),
    ...loadPodSpec(template?.spec),
  };
}

function baseValidate(model: Model): Issue[] {
  const issues = [...validateMeta(model), ...validatePodSpec(model)];
  if (!(get(model, 'selector') ?? []).some((row: any) => str(row?.key))) {
    issues.push({ level: 'error', message: 'At least one selector label is required', path: 'selector' });
  }
  return issues;
}

/* ── Deployment ──────────────────────────────────────────────────────────── */

export const deployment: ResourceDefinition = {
  id: 'deployment',
  group: 'Workloads',
  label: 'Deployment',
  summary: 'Stateless replicas with rolling updates.',
  apiVersion: 'apps/v1',
  kinds: ['Deployment'],
  fields: [
    ...metaFields(),
    { path: 'spec.replicas', label: 'Replicas', kind: 'number', half: true, min: 0, section: 'Rollout' },
    {
      path: 'spec.strategy', label: 'Strategy', kind: 'select', half: true, section: 'Rollout',
      options: [{ value: 'RollingUpdate', label: 'RollingUpdate' }, { value: 'Recreate', label: 'Recreate' }],
    },
    {
      path: 'spec.maxSurge', label: 'Max surge', kind: 'text', mono: true, half: true, section: 'Rollout',
      placeholder: '25%', when: (model) => get(model, 'spec.strategy') !== 'Recreate',
    },
    {
      path: 'spec.maxUnavailable', label: 'Max unavailable', kind: 'text', mono: true, half: true, section: 'Rollout',
      placeholder: '25%', when: (model) => get(model, 'spec.strategy') !== 'Recreate',
    },
    { path: 'spec.minReadySeconds', label: 'Min ready (s)', kind: 'number', half: true, min: 0, section: 'Rollout' },
    {
      path: 'spec.revisionHistoryLimit', label: 'Revision history limit', kind: 'number', half: true, min: 0,
      section: 'Rollout',
    },
    selectorField,
    templateAnnotationsField,
    ...podFields,
  ],
  defaults: () => ({
    ...baseDefaults('web', 'web', 'nginx:1.27'),
    spec: { replicas: 2, strategy: 'RollingUpdate', maxSurge: '', maxUnavailable: '', minReadySeconds: '', revisionHistoryLimit: '' },
  }),
  build: (model) => [yamlFile(`${slug(get(model, 'metadata.name'), 'deployment')}-deployment.yaml`, {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: buildMeta(model),
    spec: {
      replicas: num(get(model, 'spec.replicas')),
      revisionHistoryLimit: num(get(model, 'spec.revisionHistoryLimit')),
      minReadySeconds: num(get(model, 'spec.minReadySeconds')),
      selector: { matchLabels: selectorMap(model) },
      strategy: get(model, 'spec.strategy') === 'Recreate'
        ? { type: 'Recreate' }
        : {
          type: 'RollingUpdate',
          rollingUpdate: {
            maxSurge: str(get(model, 'spec.maxSurge')),
            maxUnavailable: str(get(model, 'spec.maxUnavailable')),
          },
        },
      template: podTemplate(model),
    },
  })],
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'Deployment');
    if (!doc) return null;
    return {
      ...baseLoad(doc),
      spec: {
        replicas: doc?.spec?.replicas ?? '',
        strategy: doc?.spec?.strategy?.type ?? 'RollingUpdate',
        maxSurge: doc?.spec?.strategy?.rollingUpdate?.maxSurge ?? '',
        maxUnavailable: doc?.spec?.strategy?.rollingUpdate?.maxUnavailable ?? '',
        minReadySeconds: doc?.spec?.minReadySeconds ?? '',
        revisionHistoryLimit: doc?.spec?.revisionHistoryLimit ?? '',
      },
    };
  },
  validate: baseValidate,
};

/* ── StatefulSet ─────────────────────────────────────────────────────────── */

export const statefulSet: ResourceDefinition = {
  id: 'statefulset',
  group: 'Workloads',
  label: 'StatefulSet',
  summary: 'Ordered pods with stable names and per-pod storage.',
  apiVersion: 'apps/v1',
  kinds: ['StatefulSet'],
  fields: [
    ...metaFields(),
    {
      path: 'spec.serviceName', label: 'Governing service', kind: 'text', mono: true, required: true, half: true,
      section: 'Rollout', help: 'Headless Service that gives each pod a DNS name.',
    },
    { path: 'spec.replicas', label: 'Replicas', kind: 'number', half: true, min: 0, section: 'Rollout' },
    {
      path: 'spec.podManagementPolicy', label: 'Pod management', kind: 'select', half: true, section: 'Rollout',
      options: [{ value: 'OrderedReady', label: 'OrderedReady' }, { value: 'Parallel', label: 'Parallel' }],
    },
    {
      path: 'spec.updateStrategy', label: 'Update strategy', kind: 'select', half: true, section: 'Rollout',
      options: [{ value: 'RollingUpdate', label: 'RollingUpdate' }, { value: 'OnDelete', label: 'OnDelete' }],
    },
    selectorField,
    templateAnnotationsField,
    ...podFields,
    {
      path: 'volumeClaimTemplates', label: 'Volume claim templates', kind: 'array', section: 'Per-pod storage',
      itemLabel: 'claim',
      itemDefault: () => ({ name: 'data', accessMode: 'ReadWriteOnce', size: '10Gi', storageClassName: '' }),
      itemFields: [
        { path: 'name', label: 'Name', kind: 'text', mono: true, half: true, required: true },
        { path: 'size', label: 'Size', kind: 'text', mono: true, half: true, required: true, placeholder: '10Gi' },
        {
          path: 'accessMode', label: 'Access mode', kind: 'select', half: true,
          options: [
            { value: 'ReadWriteOnce', label: 'ReadWriteOnce' },
            { value: 'ReadWriteOncePod', label: 'ReadWriteOncePod' },
            { value: 'ReadOnlyMany', label: 'ReadOnlyMany' },
            { value: 'ReadWriteMany', label: 'ReadWriteMany' },
          ],
        },
        { path: 'storageClassName', label: 'Storage class', kind: 'text', mono: true, half: true },
      ],
    },
  ],
  defaults: () => ({
    ...baseDefaults('db', 'db', 'postgres:16'),
    spec: { serviceName: 'db', replicas: 3, podManagementPolicy: 'OrderedReady', updateStrategy: 'RollingUpdate' },
    volumeClaimTemplates: [{ name: 'data', accessMode: 'ReadWriteOnce', size: '10Gi', storageClassName: '' }],
  }),
  build: (model) => [yamlFile(`${slug(get(model, 'metadata.name'), 'statefulset')}-statefulset.yaml`, {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: buildMeta(model),
    spec: {
      serviceName: str(get(model, 'spec.serviceName')),
      replicas: num(get(model, 'spec.replicas')),
      podManagementPolicy: get(model, 'spec.podManagementPolicy') === 'Parallel' ? 'Parallel' : undefined,
      updateStrategy: { type: get(model, 'spec.updateStrategy') || 'RollingUpdate' },
      selector: { matchLabels: selectorMap(model) },
      template: podTemplate(model),
      volumeClaimTemplates: (get(model, 'volumeClaimTemplates') ?? [])
        .filter((claim: any) => str(claim?.name))
        .map((claim: any) => ({
          metadata: { name: str(claim.name) },
          spec: {
            accessModes: [claim.accessMode || 'ReadWriteOnce'],
            storageClassName: str(claim.storageClassName),
            resources: { requests: { storage: str(claim.size) } },
          },
        })),
    },
  })],
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'StatefulSet');
    if (!doc) return null;
    return {
      ...baseLoad(doc),
      spec: {
        serviceName: doc?.spec?.serviceName ?? '',
        replicas: doc?.spec?.replicas ?? '',
        podManagementPolicy: doc?.spec?.podManagementPolicy ?? 'OrderedReady',
        updateStrategy: doc?.spec?.updateStrategy?.type ?? 'RollingUpdate',
      },
      volumeClaimTemplates: (doc?.spec?.volumeClaimTemplates ?? []).map((claim: any) => ({
        name: claim?.metadata?.name ?? '',
        accessMode: claim?.spec?.accessModes?.[0] ?? 'ReadWriteOnce',
        size: claim?.spec?.resources?.requests?.storage ?? '',
        storageClassName: claim?.spec?.storageClassName ?? '',
      })),
    };
  },
  validate: (model) => {
    const issues = baseValidate(model);
    issues.push(...checkName(get(model, 'spec.serviceName'), 'spec.serviceName', 'Governing service'));
    (get(model, 'volumeClaimTemplates') ?? []).forEach((claim: any, index: number) => {
      issues.push(...checkQuantity(claim?.size, `volumeClaimTemplates.${index}.size`, 'Claim size'));
    });
    return issues;
  },
};

/* ── DaemonSet ───────────────────────────────────────────────────────────── */

export const daemonSet: ResourceDefinition = {
  id: 'daemonset',
  group: 'Workloads',
  label: 'DaemonSet',
  summary: 'One pod per matching node.',
  apiVersion: 'apps/v1',
  kinds: ['DaemonSet'],
  fields: [
    ...metaFields(),
    {
      path: 'spec.updateStrategy', label: 'Update strategy', kind: 'select', half: true, section: 'Rollout',
      options: [{ value: 'RollingUpdate', label: 'RollingUpdate' }, { value: 'OnDelete', label: 'OnDelete' }],
    },
    {
      path: 'spec.maxUnavailable', label: 'Max unavailable', kind: 'text', mono: true, half: true, section: 'Rollout',
      placeholder: '1', when: (model) => get(model, 'spec.updateStrategy') !== 'OnDelete',
    },
    selectorField,
    templateAnnotationsField,
    ...podFields,
  ],
  defaults: () => ({
    ...baseDefaults('node-agent', 'agent', 'fluent/fluent-bit:3.1'),
    spec: { updateStrategy: 'RollingUpdate', maxUnavailable: '1' },
  }),
  build: (model) => [yamlFile(`${slug(get(model, 'metadata.name'), 'daemonset')}-daemonset.yaml`, {
    apiVersion: 'apps/v1',
    kind: 'DaemonSet',
    metadata: buildMeta(model),
    spec: {
      selector: { matchLabels: selectorMap(model) },
      updateStrategy: get(model, 'spec.updateStrategy') === 'OnDelete'
        ? { type: 'OnDelete' }
        : { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: str(get(model, 'spec.maxUnavailable')) } },
      template: podTemplate(model),
    },
  })],
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'DaemonSet');
    if (!doc) return null;
    return {
      ...baseLoad(doc),
      spec: {
        updateStrategy: doc?.spec?.updateStrategy?.type ?? 'RollingUpdate',
        maxUnavailable: doc?.spec?.updateStrategy?.rollingUpdate?.maxUnavailable ?? '',
      },
    };
  },
  validate: baseValidate,
};

/* ── Job ─────────────────────────────────────────────────────────────────── */

const jobSpecFields: FieldDef[] = [
  { path: 'job.completions', label: 'Completions', kind: 'number', half: true, min: 1, section: 'Job' },
  { path: 'job.parallelism', label: 'Parallelism', kind: 'number', half: true, min: 0, section: 'Job' },
  { path: 'job.backoffLimit', label: 'Backoff limit', kind: 'number', half: true, min: 0, section: 'Job' },
  {
    path: 'job.activeDeadlineSeconds', label: 'Active deadline (s)', kind: 'number', half: true, min: 1,
    section: 'Job',
  },
  {
    path: 'job.ttlSecondsAfterFinished', label: 'Clean up after (s)', kind: 'number', half: true, min: 0,
    section: 'Job', help: 'Deletes the finished Job object.',
  },
  {
    path: 'job.restartPolicy', label: 'Restart policy', kind: 'select', half: true, section: 'Job',
    options: [{ value: 'Never', label: 'Never' }, { value: 'OnFailure', label: 'OnFailure' }],
  },
];

function buildJobSpec(model: Model) {
  return {
    completions: num(get(model, 'job.completions')),
    parallelism: num(get(model, 'job.parallelism')),
    backoffLimit: num(get(model, 'job.backoffLimit')),
    activeDeadlineSeconds: num(get(model, 'job.activeDeadlineSeconds')),
    ttlSecondsAfterFinished: num(get(model, 'job.ttlSecondsAfterFinished')),
    template: {
      metadata: {
        labels: pairsToMap(get(model, 'selector')),
        annotations: pairsToMap(get(model, 'templateAnnotations')),
      },
      spec: { ...buildPodSpec(model), restartPolicy: get(model, 'job.restartPolicy') || 'Never' },
    },
  };
}

function loadJobSpec(spec: any): Model {
  return {
    job: {
      completions: spec?.completions ?? '',
      parallelism: spec?.parallelism ?? '',
      backoffLimit: spec?.backoffLimit ?? '',
      activeDeadlineSeconds: spec?.activeDeadlineSeconds ?? '',
      ttlSecondsAfterFinished: spec?.ttlSecondsAfterFinished ?? '',
      restartPolicy: spec?.template?.spec?.restartPolicy ?? 'Never',
    },
  };
}

const jobDefaults = (name: string, image: string): Model => ({
  ...metaDefaults(name),
  selector: [],
  templateAnnotations: [],
  ...podDefaults(name, image),
  job: {
    completions: '', parallelism: '', backoffLimit: 4, activeDeadlineSeconds: '',
    ttlSecondsAfterFinished: 3600, restartPolicy: 'Never',
  },
});

export const job: ResourceDefinition = {
  id: 'job',
  group: 'Workloads',
  label: 'Job',
  summary: 'Run pods to completion once.',
  apiVersion: 'batch/v1',
  kinds: ['Job'],
  fields: [...metaFields(), ...jobSpecFields, templateAnnotationsField, ...podFields],
  defaults: () => {
    const model = jobDefaults('migrate', 'ghcr.io/org/app:1.0.0');
    model.containers[0].ports = [];
    return model;
  },
  build: (model) => [yamlFile(`${slug(get(model, 'metadata.name'), 'job')}-job.yaml`, {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: buildMeta(model),
    spec: buildJobSpec(model),
  })],
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'Job');
    if (!doc) return null;
    return {
      ...loadMeta(doc),
      selector: [],
      templateAnnotations: mapToPairs(doc?.spec?.template?.metadata?.annotations),
      ...loadPodSpec(doc?.spec?.template?.spec),
      ...loadJobSpec(doc?.spec),
    };
  },
  validate: (model) => [...validateMeta(model), ...validatePodSpec(model)],
};

/* ── CronJob ─────────────────────────────────────────────────────────────── */

export const cronJob: ResourceDefinition = {
  id: 'cronjob',
  group: 'Workloads',
  label: 'CronJob',
  summary: 'Run a Job on a schedule.',
  apiVersion: 'batch/v1',
  kinds: ['CronJob'],
  fields: [
    ...metaFields(),
    {
      path: 'cron.schedule', label: 'Schedule', kind: 'text', mono: true, required: true, half: true,
      section: 'Schedule', placeholder: '0 3 * * *', help: 'Five cron fields, or @daily / @hourly.',
    },
    {
      path: 'cron.timeZone', label: 'Time zone', kind: 'text', mono: true, half: true, section: 'Schedule',
      placeholder: 'Etc/UTC', help: 'Kubernetes 1.27+. Empty means the controller time zone.',
    },
    {
      path: 'cron.concurrencyPolicy', label: 'Concurrency', kind: 'select', half: true, section: 'Schedule',
      options: [
        { value: 'Allow', label: 'Allow' },
        { value: 'Forbid', label: 'Forbid' },
        { value: 'Replace', label: 'Replace' },
      ],
    },
    { path: 'cron.suspend', label: 'Suspended', kind: 'boolean', half: true, section: 'Schedule' },
    {
      path: 'cron.startingDeadlineSeconds', label: 'Starting deadline (s)', kind: 'number', half: true, min: 0,
      section: 'Schedule',
    },
    {
      path: 'cron.successfulJobsHistoryLimit', label: 'Keep successful jobs', kind: 'number', half: true, min: 0,
      section: 'Schedule',
    },
    {
      path: 'cron.failedJobsHistoryLimit', label: 'Keep failed jobs', kind: 'number', half: true, min: 0,
      section: 'Schedule',
    },
    ...jobSpecFields,
    templateAnnotationsField,
    ...podFields,
  ],
  defaults: () => {
    const model: Model = {
      ...jobDefaults('nightly-report', 'ghcr.io/org/reporter:1.0.0'),
      cron: {
        schedule: '0 3 * * *', timeZone: '', concurrencyPolicy: 'Forbid', suspend: false,
        startingDeadlineSeconds: '', successfulJobsHistoryLimit: 3, failedJobsHistoryLimit: 1,
      },
    };
    model.containers[0].ports = [];
    return model;
  },
  build: (model) => [yamlFile(`${slug(get(model, 'metadata.name'), 'cronjob')}-cronjob.yaml`, {
    apiVersion: 'batch/v1',
    kind: 'CronJob',
    metadata: buildMeta(model),
    spec: {
      schedule: str(get(model, 'cron.schedule')),
      timeZone: str(get(model, 'cron.timeZone')),
      concurrencyPolicy: get(model, 'cron.concurrencyPolicy') || 'Allow',
      suspend: get(model, 'cron.suspend') === true ? true : undefined,
      startingDeadlineSeconds: num(get(model, 'cron.startingDeadlineSeconds')),
      successfulJobsHistoryLimit: num(get(model, 'cron.successfulJobsHistoryLimit')),
      failedJobsHistoryLimit: num(get(model, 'cron.failedJobsHistoryLimit')),
      jobTemplate: { spec: buildJobSpec(model) },
    },
  })],
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'CronJob');
    if (!doc) return null;
    const jobSpec = doc?.spec?.jobTemplate?.spec ?? {};
    return {
      ...loadMeta(doc),
      selector: [],
      templateAnnotations: mapToPairs(jobSpec?.template?.metadata?.annotations),
      ...loadPodSpec(jobSpec?.template?.spec),
      ...loadJobSpec(jobSpec),
      cron: {
        schedule: doc?.spec?.schedule ?? '',
        timeZone: doc?.spec?.timeZone ?? '',
        concurrencyPolicy: doc?.spec?.concurrencyPolicy ?? 'Allow',
        suspend: doc?.spec?.suspend === true,
        startingDeadlineSeconds: doc?.spec?.startingDeadlineSeconds ?? '',
        successfulJobsHistoryLimit: doc?.spec?.successfulJobsHistoryLimit ?? '',
        failedJobsHistoryLimit: doc?.spec?.failedJobsHistoryLimit ?? '',
      },
    };
  },
  validate: (model) => [
    ...validateMeta(model),
    ...checkSchedule(get(model, 'cron.schedule'), 'cron.schedule'),
    ...validatePodSpec(model),
  ],
};
