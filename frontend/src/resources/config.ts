import type { Issue, ResourceDefinition } from '../core/types';
import { get, str } from '../core/model';
import { slug, yamlFile } from '../core/files';
import { decodeBase64, encodeBase64 } from '../core/base64';
import { buildMeta, loadMeta, metaDefaults, metaFields, validateMeta } from './shared';

const KEY_PATTERN = /^[-._a-zA-Z0-9]+$/;

const entriesField = {
  path: 'entries',
  label: 'Data',
  kind: 'array' as const,
  section: 'Data',
  itemLabel: 'entry',
  required: true,
  itemDefault: () => ({ key: '', value: '' }),
  itemFields: [
    {
      path: 'key', label: 'Key', kind: 'text' as const, mono: true, required: true,
      placeholder: 'application.yaml', help: 'Letters, digits, "-", "_" and "." only.',
    },
    { path: 'value', label: 'Value', kind: 'textarea' as const, mono: true, placeholder: 'log.level=info' },
  ],
};

function entriesToMap(model: any): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const entry of get(model, 'entries') ?? []) {
    const key = str(entry?.key);
    if (key) out[key] = entry?.value == null ? '' : String(entry.value);
  }
  return Object.keys(out).length ? out : undefined;
}

function validateKeys(model: any, path = 'entries'): Issue[] {
  const issues: Issue[] = [];
  const seen = new Set<string>();
  (get(model, 'entries') ?? []).forEach((entry: any, index: number) => {
    const key = str(entry?.key);
    if (!key) {
      issues.push({ level: 'error', message: 'Key is required', path: `${path}.${index}.key` });
      return;
    }
    if (!KEY_PATTERN.test(key)) {
      issues.push({ level: 'error', message: `"${key}" is not a valid key`, path: `${path}.${index}.key` });
    }
    if (seen.has(key)) {
      issues.push({ level: 'error', message: `Key "${key}" appears twice`, path: `${path}.${index}.key` });
    }
    seen.add(key);
  });
  return issues;
}

/* ── ConfigMap ───────────────────────────────────────────────────────────── */

export const configMap: ResourceDefinition = {
  id: 'configmap',
  group: 'Configuration',
  label: 'ConfigMap',
  summary: 'Non-confidential key/value data for pods.',
  apiVersion: 'v1',
  kinds: ['ConfigMap'],
  fields: [
    ...metaFields(),
    {
      path: 'immutable', label: 'Immutable', kind: 'boolean', half: true, section: 'Data',
      help: 'Blocks updates and reduces API server load.',
    },
    entriesField,
  ],
  defaults: () => ({
    ...metaDefaults('app-config'),
    immutable: false,
    entries: [{ key: 'LOG_LEVEL', value: 'info' }],
  }),
  build: (model) => [yamlFile(`${slug(get(model, 'metadata.name'), 'configmap')}-configmap.yaml`, {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: buildMeta(model),
    immutable: get(model, 'immutable') === true ? true : undefined,
    data: entriesToMap(model),
  })],
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'ConfigMap');
    if (!doc) return null;
    return {
      ...loadMeta(doc),
      immutable: doc?.immutable === true,
      entries: Object.entries(doc?.data ?? {}).map(([key, value]) => ({ key, value: String(value ?? '') })),
    };
  },
  validate: (model) => {
    const issues = [...validateMeta(model), ...validateKeys(model)];
    if (!(get(model, 'entries') ?? []).length) {
      issues.push({ level: 'warning', message: 'This ConfigMap has no data', path: 'entries' });
    }
    return issues;
  },
};

/* ── Secret ──────────────────────────────────────────────────────────────── */

export const secret: ResourceDefinition = {
  id: 'secret',
  group: 'Configuration',
  label: 'Secret',
  summary: 'Key/value data mounted as files or env vars. Base64, not encrypted.',
  apiVersion: 'v1',
  kinds: ['Secret'],
  fields: [
    ...metaFields(),
    {
      path: 'type', label: 'Type', kind: 'select', half: true, section: 'Data',
      options: [
        { value: 'Opaque', label: 'Opaque' },
        { value: 'kubernetes.io/tls', label: 'TLS certificate' },
        { value: 'kubernetes.io/dockerconfigjson', label: 'Docker registry' },
        { value: 'kubernetes.io/basic-auth', label: 'Basic auth' },
        { value: 'kubernetes.io/ssh-auth', label: 'SSH auth' },
        { value: 'kubernetes.io/service-account-token', label: 'Service account token' },
      ],
    },
    {
      path: 'encode', label: 'Write values as base64 (data)', kind: 'boolean', half: true, section: 'Data',
      help: 'Off writes stringData, which the API server encodes for you.',
    },
    {
      path: 'immutable', label: 'Immutable', kind: 'boolean', half: true, section: 'Data',
    },
    entriesField,
  ],
  defaults: () => ({
    ...metaDefaults('app-secrets'),
    type: 'Opaque',
    encode: false,
    immutable: false,
    entries: [{ key: 'DATABASE_URL', value: 'postgres://user:pass@db:5432/app' }],
  }),
  build: (model) => {
    const entries = entriesToMap(model);
    const encode = get(model, 'encode') === true;
    const data = entries && encode
      ? Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, encodeBase64(value)]))
      : undefined;
    return [yamlFile(`${slug(get(model, 'metadata.name'), 'secret')}-secret.yaml`, {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: buildMeta(model),
      type: get(model, 'type') || 'Opaque',
      immutable: get(model, 'immutable') === true ? true : undefined,
      data,
      stringData: encode ? undefined : entries,
    })];
  },
  load: (docs) => {
    const doc = docs.find((entry) => entry?.kind === 'Secret');
    if (!doc) return null;
    const encoded = doc?.data && Object.keys(doc.data).length > 0;
    const source = encoded ? doc.data : doc?.stringData ?? {};
    return {
      ...loadMeta(doc),
      type: doc?.type ?? 'Opaque',
      encode: !!encoded,
      immutable: doc?.immutable === true,
      entries: Object.entries(source).map(([key, value]) => ({
        key,
        value: encoded ? decodeBase64(String(value ?? '')) : String(value ?? ''),
      })),
    };
  },
  validate: (model) => {
    const issues = [...validateMeta(model), ...validateKeys(model)];
    const type = get(model, 'type');
    const keys = new Set((get(model, 'entries') ?? []).map((entry: any) => str(entry?.key)));
    const require = (needed: string[]) => {
      needed.forEach((key) => {
        if (!keys.has(key)) {
          issues.push({ level: 'error', message: `Type ${type} requires the key "${key}"`, path: 'entries' });
        }
      });
    };
    if (type === 'kubernetes.io/tls') require(['tls.crt', 'tls.key']);
    if (type === 'kubernetes.io/dockerconfigjson') require(['.dockerconfigjson']);
    if (type === 'kubernetes.io/basic-auth') require(['username', 'password']);
    if (type === 'kubernetes.io/ssh-auth') require(['ssh-privatekey']);
    issues.push({
      level: 'warning',
      message: 'Secret values are only base64 encoded. Commit this file only if the repo is private or the values are sealed.',
      path: 'entries',
    });
    return issues;
  },
};
