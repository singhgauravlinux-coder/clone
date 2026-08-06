import type { Issue, ResourceDefinition } from '../core/types';
import { get, mapToPairs, num, pairsToMap, str, toList } from '../core/model';
import { slug, yamlFile } from '../core/files';
import { checkName } from '../core/validation';

const isHelm = (model: any) => get(model, 'source.type') === 'helm';
const isKustomize = (model: any) => get(model, 'source.type') === 'kustomize';

export const argoApplication: ResourceDefinition = {
  id: 'argocd-application',
  group: 'GitOps',
  label: 'ArgoCD Application',
  summary: 'Point Argo CD at a Git path, Helm chart, or Kustomize overlay.',
  apiVersion: 'argoproj.io/v1alpha1',
  kinds: ['Application'],
  fields: [
    {
      path: 'metadata.name', label: 'Application name', kind: 'text', mono: true, required: true, half: true,
      section: 'Application',
    },
    {
      path: 'metadata.namespace', label: 'Argo CD namespace', kind: 'text', mono: true, half: true,
      section: 'Application', placeholder: 'argocd', help: 'Where the Application object lives.',
    },
    { path: 'spec.project', label: 'Project', kind: 'text', mono: true, half: true, section: 'Application', placeholder: 'default' },
    {
      path: 'finalizer', label: 'Cascade delete children', kind: 'boolean', half: true, section: 'Application',
      help: 'Adds the resources-finalizer annotation.',
    },
    { path: 'metadata.labels', label: 'Labels', kind: 'keyvalue', section: 'Application' },
    {
      path: 'source.repoURL', label: 'Repository URL', kind: 'text', mono: true, required: true, section: 'Source',
      placeholder: 'https://github.com/org/repo.git',
    },
    {
      path: 'source.type', label: 'Source type', kind: 'select', half: true, section: 'Source',
      options: [
        { value: 'directory', label: 'Plain manifests' },
        { value: 'helm', label: 'Helm chart' },
        { value: 'kustomize', label: 'Kustomize' },
      ],
    },
    {
      path: 'source.targetRevision', label: 'Target revision', kind: 'text', mono: true, half: true, section: 'Source',
      placeholder: 'HEAD', help: 'Branch, tag, commit, or chart version.',
    },
    {
      path: 'source.path', label: 'Path in repo', kind: 'text', mono: true, half: true, section: 'Source',
      placeholder: 'manifests/production', when: (model) => !str(get(model, 'source.chart')),
    },
    {
      path: 'source.chart', label: 'Chart name', kind: 'text', mono: true, half: true, section: 'Source',
      when: isHelm, help: 'Set this only when the repository is a Helm repo.',
    },
    {
      path: 'source.helm.releaseName', label: 'Release name', kind: 'text', mono: true, half: true, section: 'Source',
      when: isHelm,
    },
    {
      path: 'source.helm.valueFiles', label: 'Value files', kind: 'text', mono: true, section: 'Source',
      when: isHelm, placeholder: 'values.yaml, values-prod.yaml', help: 'Comma separated.',
    },
    {
      path: 'source.helm.parameters', label: 'Helm parameters', kind: 'keyvalue', section: 'Source', when: isHelm,
      keyLabel: 'image.tag', valueLabel: 'v1.2.3',
    },
    {
      path: 'source.kustomize.namePrefix', label: 'Name prefix', kind: 'text', mono: true, half: true,
      section: 'Source', when: isKustomize,
    },
    {
      path: 'source.kustomize.images', label: 'Image overrides', kind: 'text', mono: true, section: 'Source',
      when: isKustomize, placeholder: 'ghcr.io/org/api:v1.2.3', help: 'Comma separated.',
    },
    {
      path: 'destination.server', label: 'Cluster server', kind: 'text', mono: true, half: true,
      section: 'Destination', placeholder: 'https://kubernetes.default.svc',
    },
    {
      path: 'destination.name', label: 'Cluster name', kind: 'text', mono: true, half: true, section: 'Destination',
      help: 'Use either the server URL or the registered cluster name.',
    },
    {
      path: 'destination.namespace', label: 'Target namespace', kind: 'text', mono: true, half: true,
      section: 'Destination', required: true,
    },
    { path: 'sync.automated', label: 'Automated sync', kind: 'boolean', half: true, section: 'Sync policy' },
    {
      path: 'sync.prune', label: 'Prune removed resources', kind: 'boolean', half: true, section: 'Sync policy',
      when: (model) => get(model, 'sync.automated') === true,
    },
    {
      path: 'sync.selfHeal', label: 'Self heal drift', kind: 'boolean', half: true, section: 'Sync policy',
      when: (model) => get(model, 'sync.automated') === true,
    },
    {
      path: 'sync.options', label: 'Sync options', kind: 'stringlist', section: 'Sync policy',
      options: [
        { value: 'CreateNamespace=true', label: 'CreateNamespace=true' },
        { value: 'ServerSideApply=true', label: 'ServerSideApply=true' },
        { value: 'PrunePropagationPolicy=foreground', label: 'PrunePropagationPolicy=foreground' },
        { value: 'PruneLast=true', label: 'PruneLast=true' },
        { value: 'ApplyOutOfSyncOnly=true', label: 'ApplyOutOfSyncOnly=true' },
        { value: 'Validate=false', label: 'Validate=false' },
      ],
    },
    { path: 'sync.retryLimit', label: 'Retry limit', kind: 'number', half: true, min: 0, section: 'Sync policy' },
    {
      path: 'sync.retryBackoff', label: 'Retry backoff', kind: 'text', mono: true, half: true, section: 'Sync policy',
      placeholder: '5s', when: (model) => num(get(model, 'sync.retryLimit')) !== undefined,
    },
  ],
  defaults: () => ({
    metadata: { name: 'web', namespace: 'argocd', labels: [] },
    finalizer: true,
    spec: { project: 'default' },
    source: {
      repoURL: 'https://github.com/org/repo.git',
      type: 'directory',
      targetRevision: 'HEAD',
      path: 'manifests/production',
      chart: '',
      helm: { releaseName: '', valueFiles: '', parameters: [] },
      kustomize: { namePrefix: '', images: '' },
    },
    destination: { server: 'https://kubernetes.default.svc', name: '', namespace: 'production' },
    sync: {
      automated: true, prune: true, selfHeal: true,
      options: ['CreateNamespace=true'], retryLimit: 5, retryBackoff: '5s',
    },
  }),
  build: (model) => {
    const helmParameters = (get(model, 'source.helm.parameters') ?? [])
      .filter((row: any) => str(row?.key))
      .map((row: any) => ({ name: str(row.key), value: String(row.value ?? '') }));
    const automated = get(model, 'sync.automated') === true;
    const retryLimit = num(get(model, 'sync.retryLimit'));
    return [yamlFile(`${slug(get(model, 'metadata.name'), 'application')}-application.yaml`, {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: {
        name: str(get(model, 'metadata.name')),
        namespace: str(get(model, 'metadata.namespace')) ?? 'argocd',
        labels: pairsToMap(get(model, 'metadata.labels')),
        finalizers: get(model, 'finalizer') === true
          ? ['resources-finalizer.argocd.argoproj.io']
          : undefined,
      },
      spec: {
        project: str(get(model, 'spec.project')) ?? 'default',
        source: {
          repoURL: str(get(model, 'source.repoURL')),
          targetRevision: str(get(model, 'source.targetRevision')) ?? 'HEAD',
          path: str(get(model, 'source.chart')) ? undefined : str(get(model, 'source.path')),
          chart: isHelm(model) ? str(get(model, 'source.chart')) : undefined,
          helm: isHelm(model) ? {
            releaseName: str(get(model, 'source.helm.releaseName')),
            valueFiles: toList(get(model, 'source.helm.valueFiles')),
            parameters: helmParameters.length ? helmParameters : undefined,
          } : undefined,
          kustomize: isKustomize(model) ? {
            namePrefix: str(get(model, 'source.kustomize.namePrefix')),
            images: toList(get(model, 'source.kustomize.images')),
          } : undefined,
        },
        destination: {
          server: str(get(model, 'destination.name')) ? undefined : str(get(model, 'destination.server')),
          name: str(get(model, 'destination.name')),
          namespace: str(get(model, 'destination.namespace')),
        },
        syncPolicy: {
          automated: automated ? {
            prune: get(model, 'sync.prune') === true,
            selfHeal: get(model, 'sync.selfHeal') === true,
          } : undefined,
          syncOptions: toList(get(model, 'sync.options')),
          retry: retryLimit === undefined ? undefined : {
            limit: retryLimit,
            backoff: { duration: str(get(model, 'sync.retryBackoff')) ?? '5s', factor: 2, maxDuration: '3m' },
          },
        },
      },
    })];
  },
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'Application' && String(entry?.apiVersion ?? '').startsWith('argoproj.io'));
    if (!doc) return null;
    const source = doc?.spec?.source ?? {};
    return {
      metadata: {
        name: doc?.metadata?.name ?? '',
        namespace: doc?.metadata?.namespace ?? 'argocd',
        labels: mapToPairs(doc?.metadata?.labels),
      },
      finalizer: (doc?.metadata?.finalizers ?? []).includes('resources-finalizer.argocd.argoproj.io'),
      spec: { project: doc?.spec?.project ?? 'default' },
      source: {
        repoURL: source.repoURL ?? '',
        type: source.helm || source.chart ? 'helm' : source.kustomize ? 'kustomize' : 'directory',
        targetRevision: source.targetRevision ?? 'HEAD',
        path: source.path ?? '',
        chart: source.chart ?? '',
        helm: {
          releaseName: source.helm?.releaseName ?? '',
          valueFiles: (source.helm?.valueFiles ?? []).join(', '),
          parameters: (source.helm?.parameters ?? []).map((param: any) => ({
            key: param?.name ?? '', value: String(param?.value ?? ''),
          })),
        },
        kustomize: {
          namePrefix: source.kustomize?.namePrefix ?? '',
          images: (source.kustomize?.images ?? []).join(', '),
        },
      },
      destination: {
        server: doc?.spec?.destination?.server ?? '',
        name: doc?.spec?.destination?.name ?? '',
        namespace: doc?.spec?.destination?.namespace ?? '',
      },
      sync: {
        automated: !!doc?.spec?.syncPolicy?.automated,
        prune: doc?.spec?.syncPolicy?.automated?.prune === true,
        selfHeal: doc?.spec?.syncPolicy?.automated?.selfHeal === true,
        options: doc?.spec?.syncPolicy?.syncOptions ?? [],
        retryLimit: doc?.spec?.syncPolicy?.retry?.limit ?? '',
        retryBackoff: doc?.spec?.syncPolicy?.retry?.backoff?.duration ?? '',
      },
    };
  },
  validate: (model) => {
    const issues: Issue[] = [
      ...checkName(get(model, 'metadata.name'), 'metadata.name', 'Application name'),
      ...checkName(get(model, 'destination.namespace'), 'destination.namespace', 'Target namespace'),
    ];
    const repo = str(get(model, 'source.repoURL'));
    if (!repo) {
      issues.push({ level: 'error', message: 'Repository URL is required', path: 'source.repoURL' });
    } else if (!/^(https?:\/\/|git@|ssh:\/\/|oci:\/\/)/.test(repo)) {
      issues.push({ level: 'error', message: 'Repository URL must start with https://, ssh://, oci:// or git@', path: 'source.repoURL' });
    }
    if (!str(get(model, 'destination.server')) && !str(get(model, 'destination.name'))) {
      issues.push({ level: 'error', message: 'Set either a cluster server URL or a cluster name', path: 'destination.server' });
    }
    if (str(get(model, 'destination.server')) && str(get(model, 'destination.name'))) {
      issues.push({ level: 'error', message: 'Server and name are mutually exclusive', path: 'destination.name' });
    }
    if (isHelm(model) && !str(get(model, 'source.chart')) && !str(get(model, 'source.path'))) {
      issues.push({ level: 'error', message: 'Set a chart name or a path to the chart in the repo', path: 'source.path' });
    }
    if (get(model, 'source.targetRevision') === 'HEAD' && get(model, 'sync.automated') === true) {
      issues.push({
        level: 'warning',
        message: 'Automated sync against HEAD redeploys on every commit to the default branch',
        path: 'source.targetRevision',
      });
    }
    if (get(model, 'sync.automated') === true && get(model, 'sync.prune') !== true) {
      issues.push({
        level: 'warning',
        message: 'Without prune, resources deleted from Git stay in the cluster',
        path: 'sync.prune',
      });
    }
    return issues;
  },
};
