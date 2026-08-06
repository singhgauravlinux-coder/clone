import type { ResourceDefinition } from '../core/types';
import { get, num, str, toList } from '../core/model';
import { slug, yamlFile } from '../core/files';
import { checkQuantity } from '../core/validation';
import { buildMeta, loadMeta, metaDefaults, metaFields, validateMeta } from './shared';

export const persistentVolumeClaim: ResourceDefinition = {
  id: 'pvc',
  group: 'Storage',
  label: 'PersistentVolumeClaim',
  summary: 'Request durable storage for a pod.',
  apiVersion: 'v1',
  kinds: ['PersistentVolumeClaim'],
  fields: [
    ...metaFields(),
    {
      path: 'spec.accessModes', label: 'Access modes', kind: 'stringlist', section: 'Claim', required: true,
      options: [
        { value: 'ReadWriteOnce', label: 'ReadWriteOnce', help: 'One node can mount it read-write.' },
        { value: 'ReadWriteOncePod', label: 'ReadWriteOncePod', help: 'One pod, read-write.' },
        { value: 'ReadOnlyMany', label: 'ReadOnlyMany', help: 'Many nodes, read-only.' },
        { value: 'ReadWriteMany', label: 'ReadWriteMany', help: 'Many nodes, read-write.' },
      ],
    },
    {
      path: 'spec.storage', label: 'Requested size', kind: 'text', mono: true, required: true, half: true,
      section: 'Claim', placeholder: '10Gi',
    },
    {
      path: 'spec.storageClassName', label: 'Storage class', kind: 'text', mono: true, half: true, section: 'Claim',
      placeholder: 'standard', help: 'Empty uses the cluster default. Type "-" for no class.',
    },
    {
      path: 'spec.volumeMode', label: 'Volume mode', kind: 'select', half: true, section: 'Claim',
      options: [{ value: 'Filesystem', label: 'Filesystem' }, { value: 'Block', label: 'Block' }],
    },
    {
      path: 'spec.volumeName', label: 'Bind to volume', kind: 'text', mono: true, half: true, section: 'Claim',
      help: 'Only when binding to a pre-provisioned PersistentVolume.',
    },
    { path: 'spec.selector', label: 'Volume selector', kind: 'keyvalue', section: 'Claim' },
  ],
  defaults: () => ({
    ...metaDefaults('data'),
    spec: {
      accessModes: ['ReadWriteOnce'],
      storage: '10Gi',
      storageClassName: '',
      volumeMode: 'Filesystem',
      volumeName: '',
      selector: [],
    },
  }),
  build: (model) => [yamlFile(`${slug(get(model, 'metadata.name'), 'pvc')}-pvc.yaml`, {
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: buildMeta(model),
    spec: {
      accessModes: toList(get(model, 'spec.accessModes')),
      storageClassName: str(get(model, 'spec.storageClassName')),
      volumeMode: get(model, 'spec.volumeMode') === 'Block' ? 'Block' : undefined,
      volumeName: str(get(model, 'spec.volumeName')),
      selector: (get(model, 'spec.selector') ?? []).some((row: any) => str(row?.key))
        ? {
          matchLabels: Object.fromEntries(
            (get(model, 'spec.selector') ?? [])
              .filter((row: any) => str(row?.key))
              .map((row: any) => [str(row.key), String(row.value ?? '')]),
          ),
        }
        : undefined,
      resources: { requests: { storage: str(get(model, 'spec.storage')) } },
    },
  })],
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'PersistentVolumeClaim');
    if (!doc) return null;
    return {
      ...loadMeta(doc),
      spec: {
        accessModes: doc?.spec?.accessModes ?? ['ReadWriteOnce'],
        storage: doc?.spec?.resources?.requests?.storage ?? '',
        storageClassName: doc?.spec?.storageClassName ?? '',
        volumeMode: doc?.spec?.volumeMode ?? 'Filesystem',
        volumeName: doc?.spec?.volumeName ?? '',
        selector: Object.entries(doc?.spec?.selector?.matchLabels ?? {}).map(([key, value]) => ({
          key, value: String(value ?? ''),
        })),
      },
    };
  },
  validate: (model) => {
    const issues = [
      ...validateMeta(model),
      ...checkQuantity(get(model, 'spec.storage'), 'spec.storage', 'Requested size'),
    ];
    const modes = get(model, 'spec.accessModes') ?? [];
    if (!modes.length) {
      issues.push({ level: 'error', message: 'Pick at least one access mode', path: 'spec.accessModes' });
    }
    if (modes.includes('ReadWriteMany')) {
      issues.push({
        level: 'warning',
        message: 'ReadWriteMany needs a shared filesystem provisioner such as NFS, EFS or CephFS',
        path: 'spec.accessModes',
      });
    }
    if (num(get(model, 'spec.storage')) !== undefined) {
      issues.push({ level: 'warning', message: 'A bare number means bytes. Add a suffix such as Gi or Mi.', path: 'spec.storage' });
    }
    return issues;
  },
};
