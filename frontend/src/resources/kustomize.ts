import type { GeneratedFile, Issue, ResourceDefinition } from '../core/types';
import { get, mapToPairs, num, pairsToMap, str, toList } from '../core/model';
import { slug, textFile, yamlFile } from '../core/files';
import { checkName } from '../core/validation';

export const kustomization: ResourceDefinition = {
  id: 'kustomize',
  group: 'Packaging',
  label: 'Kustomize overlay',
  summary: 'kustomization.yaml with patches, generators and image overrides.',
  apiVersion: 'kustomize.config.k8s.io/v1beta1',
  kinds: ['Kustomization'],
  fields: [
    {
      path: 'namespace', label: 'Namespace', kind: 'text', mono: true, half: true, section: 'Overlay',
      help: 'Applied to every resource in the overlay.',
    },
    { path: 'namePrefix', label: 'Name prefix', kind: 'text', mono: true, half: true, section: 'Overlay' },
    { path: 'nameSuffix', label: 'Name suffix', kind: 'text', mono: true, half: true, section: 'Overlay' },
    {
      path: 'resources', label: 'Resources', kind: 'textarea', mono: true, required: true, section: 'Overlay',
      placeholder: '../../base\ndeployment.yaml', help: 'One path or URL per line.',
    },
    {
      path: 'components', label: 'Components', kind: 'textarea', mono: true, section: 'Overlay',
      placeholder: '../../components/monitoring', help: 'One path per line.',
    },
    { path: 'commonLabels', label: 'Labels', kind: 'keyvalue', section: 'Common metadata' },
    {
      path: 'includeSelectors', label: 'Add labels to selectors', kind: 'boolean', half: true,
      section: 'Common metadata', help: 'Off is safer for existing workloads: selectors are immutable.',
    },
    { path: 'commonAnnotations', label: 'Annotations', kind: 'keyvalue', section: 'Common metadata' },
    {
      path: 'images', label: 'Image overrides', kind: 'array', section: 'Overrides', itemLabel: 'image',
      itemDefault: () => ({ name: '', newName: '', newTag: '', digest: '' }),
      itemFields: [
        { path: 'name', label: 'Matches image', kind: 'text', mono: true, half: true, required: true, placeholder: 'app' },
        { path: 'newName', label: 'New name', kind: 'text', mono: true, half: true, placeholder: 'ghcr.io/org/app' },
        { path: 'newTag', label: 'New tag', kind: 'text', mono: true, half: true, placeholder: 'v1.4.0' },
        { path: 'digest', label: 'Digest', kind: 'text', mono: true, half: true, placeholder: 'sha256:...' },
      ],
    },
    {
      path: 'replicas', label: 'Replica overrides', kind: 'array', section: 'Overrides', itemLabel: 'override',
      itemDefault: () => ({ name: '', count: 1 }),
      itemFields: [
        { path: 'name', label: 'Workload name', kind: 'text', mono: true, half: true, required: true },
        { path: 'count', label: 'Replicas', kind: 'number', half: true, min: 0, required: true },
      ],
    },
    {
      path: 'configMapGenerator', label: 'ConfigMap generators', kind: 'array', section: 'Generators',
      itemLabel: 'generator',
      itemDefault: () => ({ name: '', literals: [], files: '', behavior: 'create' }),
      itemFields: [
        { path: 'name', label: 'Name', kind: 'text', mono: true, half: true, required: true },
        {
          path: 'behavior', label: 'Behavior', kind: 'select', half: true,
          options: [
            { value: 'create', label: 'create' },
            { value: 'merge', label: 'merge' },
            { value: 'replace', label: 'replace' },
          ],
        },
        { path: 'literals', label: 'Literals', kind: 'keyvalue' },
        { path: 'files', label: 'Files', kind: 'text', mono: true, help: 'Comma separated paths.' },
      ],
    },
    {
      path: 'secretGenerator', label: 'Secret generators', kind: 'array', section: 'Generators', itemLabel: 'generator',
      itemDefault: () => ({ name: '', literals: [], files: '', type: 'Opaque' }),
      itemFields: [
        { path: 'name', label: 'Name', kind: 'text', mono: true, half: true, required: true },
        { path: 'type', label: 'Type', kind: 'text', mono: true, half: true, placeholder: 'Opaque' },
        { path: 'literals', label: 'Literals', kind: 'keyvalue' },
        { path: 'files', label: 'Files', kind: 'text', mono: true, help: 'Comma separated paths.' },
      ],
    },
    {
      path: 'disableNameSuffixHash', label: 'Disable name suffix hash', kind: 'boolean', half: true,
      section: 'Generators', help: 'Keeps generated names stable, but pods will not roll on change.',
    },
    {
      path: 'patches', label: 'Patches', kind: 'array', section: 'Patches', itemLabel: 'patch',
      itemDefault: () => ({ name: '', kind: 'Deployment', target: '', body: '' }),
      itemFields: [
        {
          path: 'name', label: 'Patch file name', kind: 'text', mono: true, half: true, required: true,
          placeholder: 'increase-memory',
        },
        { path: 'kind', label: 'Target kind', kind: 'text', mono: true, half: true, required: true },
        { path: 'target', label: 'Target name', kind: 'text', mono: true, half: true, required: true },
        {
          path: 'body', label: 'Patch body', kind: 'textarea', mono: true, required: true,
          help: 'Strategic merge patch. The apiVersion, kind and name headers are added for you.',
          placeholder: 'spec:\n  template:\n    spec:\n      containers:\n        - name: app\n          resources:\n            limits:\n              memory: 1Gi',
        },
      ],
    },
  ],
  defaults: () => ({
    namespace: 'production',
    namePrefix: '',
    nameSuffix: '',
    resources: '../../base',
    components: '',
    commonLabels: [{ key: 'app.kubernetes.io/part-of', value: 'shop' }],
    includeSelectors: false,
    commonAnnotations: [],
    images: [{ name: 'app', newName: 'ghcr.io/org/app', newTag: 'v1.4.0', digest: '' }],
    replicas: [],
    configMapGenerator: [],
    secretGenerator: [],
    disableNameSuffixHash: false,
    patches: [],
  }),
  build: (model) => {
    const files: GeneratedFile[] = [];
    const patches = (get(model, 'patches') ?? []).filter((patch: any) => str(patch?.name) && str(patch?.body));

    const labels = pairsToMap(get(model, 'commonLabels'));
    const doc = {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      namespace: str(get(model, 'namespace')),
      namePrefix: str(get(model, 'namePrefix')),
      nameSuffix: str(get(model, 'nameSuffix')),
      commonAnnotations: pairsToMap(get(model, 'commonAnnotations')),
      labels: labels ? [{ pairs: labels, includeSelectors: get(model, 'includeSelectors') === true }] : undefined,
      resources: toList(get(model, 'resources')),
      components: toList(get(model, 'components')),
      images: (get(model, 'images') ?? [])
        .filter((image: any) => str(image?.name))
        .map((image: any) => ({
          name: str(image.name),
          newName: str(image.newName),
          newTag: str(image.newTag),
          digest: str(image.digest),
        })),
      replicas: (get(model, 'replicas') ?? [])
        .filter((entry: any) => str(entry?.name))
        .map((entry: any) => ({ name: str(entry.name), count: num(entry.count) ?? 1 })),
      configMapGenerator: (get(model, 'configMapGenerator') ?? [])
        .filter((generator: any) => str(generator?.name))
        .map((generator: any) => ({
          name: str(generator.name),
          behavior: generator.behavior && generator.behavior !== 'create' ? generator.behavior : undefined,
          literals: (generator.literals ?? [])
            .filter((row: any) => str(row?.key))
            .map((row: any) => `${str(row.key)}=${row.value ?? ''}`),
          files: toList(generator.files),
        })),
      secretGenerator: (get(model, 'secretGenerator') ?? [])
        .filter((generator: any) => str(generator?.name))
        .map((generator: any) => ({
          name: str(generator.name),
          type: str(generator.type),
          literals: (generator.literals ?? [])
            .filter((row: any) => str(row?.key))
            .map((row: any) => `${str(row.key)}=${row.value ?? ''}`),
          files: toList(generator.files),
        })),
      generatorOptions: get(model, 'disableNameSuffixHash') === true
        ? { disableNameSuffixHash: true }
        : undefined,
      patches: patches.length ? patches.map((patch: any) => ({
        path: `patches/${slug(patch.name, 'patch')}.yaml`,
        target: { kind: str(patch.kind), name: str(patch.target) },
      })) : undefined,
    };

    files.push(yamlFile('kustomization.yaml', doc));

    patches.forEach((patch: any) => {
      const kind = str(patch.kind) ?? 'Deployment';
      const apiVersion = ['Deployment', 'StatefulSet', 'DaemonSet'].includes(kind) ? 'apps/v1'
        : ['Job', 'CronJob'].includes(kind) ? 'batch/v1'
          : ['Ingress'].includes(kind) ? 'networking.k8s.io/v1' : 'v1';
      const header = `apiVersion: ${apiVersion}\nkind: ${kind}\nmetadata:\n  name: ${str(patch.target) ?? 'name'}\n`;
      const body = String(patch.body ?? '').replace(/\s+$/, '');
      files.push(textFile(`patches/${slug(patch.name, 'patch')}.yaml`, `${header}${body}\n`));
    });

    return files;
  },
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'Kustomization');
    if (!doc) return null;
    const labelEntry = Array.isArray(doc.labels) ? doc.labels[0] : undefined;
    return {
      namespace: doc.namespace ?? '',
      namePrefix: doc.namePrefix ?? '',
      nameSuffix: doc.nameSuffix ?? '',
      resources: (doc.resources ?? []).join('\n'),
      components: (doc.components ?? []).join('\n'),
      commonLabels: mapToPairs(labelEntry?.pairs ?? doc.commonLabels),
      includeSelectors: labelEntry?.includeSelectors === true,
      commonAnnotations: mapToPairs(doc.commonAnnotations),
      images: (doc.images ?? []).map((image: any) => ({
        name: image?.name ?? '',
        newName: image?.newName ?? '',
        newTag: image?.newTag ?? '',
        digest: image?.digest ?? '',
      })),
      replicas: (doc.replicas ?? []).map((entry: any) => ({ name: entry?.name ?? '', count: entry?.count ?? 1 })),
      configMapGenerator: (doc.configMapGenerator ?? []).map((generator: any) => ({
        name: generator?.name ?? '',
        behavior: generator?.behavior ?? 'create',
        literals: (generator?.literals ?? []).map((literal: string) => {
          const index = String(literal).indexOf('=');
          return { key: String(literal).slice(0, index), value: String(literal).slice(index + 1) };
        }),
        files: (generator?.files ?? []).join(', '),
      })),
      secretGenerator: (doc.secretGenerator ?? []).map((generator: any) => ({
        name: generator?.name ?? '',
        type: generator?.type ?? '',
        literals: (generator?.literals ?? []).map((literal: string) => {
          const index = String(literal).indexOf('=');
          return { key: String(literal).slice(0, index), value: String(literal).slice(index + 1) };
        }),
        files: (generator?.files ?? []).join(', '),
      })),
      disableNameSuffixHash: doc.generatorOptions?.disableNameSuffixHash === true,
      patches: (doc.patches ?? []).map((patch: any) => ({
        name: String(patch?.path ?? '').replace(/^patches\//, '').replace(/\.ya?ml$/, ''),
        kind: patch?.target?.kind ?? 'Deployment',
        target: patch?.target?.name ?? '',
        body: '',
      })),
    };
  },
  validate: (model) => {
    const issues: Issue[] = [];
    if (!toList(get(model, 'resources'))) {
      issues.push({ level: 'error', message: 'List at least one resource or base path', path: 'resources' });
    }
    if (str(get(model, 'namespace'))) {
      issues.push(...checkName(get(model, 'namespace'), 'namespace', 'Namespace'));
    }
    (get(model, 'images') ?? []).forEach((image: any, index: number) => {
      if (str(image?.newTag) && str(image?.digest)) {
        issues.push({ level: 'error', message: 'Set either a tag or a digest, not both', path: `images.${index}.digest` });
      }
    });
    if (get(model, 'includeSelectors') === true) {
      issues.push({
        level: 'warning',
        message: 'Adding labels to selectors changes an immutable field on existing Deployments',
        path: 'includeSelectors',
      });
    }
    (get(model, 'patches') ?? []).forEach((patch: any, index: number) => {
      if (str(patch?.name) && !str(patch?.body)) {
        issues.push({ level: 'error', message: 'Patch body is required', path: `patches.${index}.body` });
      }
    });
    const names = (get(model, 'secretGenerator') ?? []).filter((generator: any) => str(generator?.name));
    if (names.length && get(model, 'disableNameSuffixHash') === true) {
      issues.push({
        level: 'warning',
        message: 'Without the name suffix hash, pods do not restart when a generated Secret changes',
        path: 'disableNameSuffixHash',
      });
    }
    return issues;
  },
};
