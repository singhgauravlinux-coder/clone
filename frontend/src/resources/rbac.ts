import type { GeneratedFile, Issue, Model, ResourceDefinition } from '../core/types';
import { get, str, toList } from '../core/model';
import { slug, yamlFile } from '../core/files';
import { checkName } from '../core/validation';

const VERBS = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', '*'];

const cluster = (model: Model) => get(model, 'scope') === 'Cluster';

export const rbac: ResourceDefinition = {
  id: 'rbac',
  group: 'Access control',
  label: 'RBAC bundle',
  summary: 'ServiceAccount plus a Role or ClusterRole and its binding.',
  apiVersion: 'rbac.authorization.k8s.io/v1',
  kinds: ['Role', 'ClusterRole', 'RoleBinding', 'ClusterRoleBinding', 'ServiceAccount'],
  fields: [
    {
      path: 'scope', label: 'Scope', kind: 'select', half: true, section: 'Scope',
      options: [
        { value: 'Namespaced', label: 'Namespaced (Role)' },
        { value: 'Cluster', label: 'Cluster-wide (ClusterRole)' },
      ],
    },
    {
      path: 'namespace', label: 'Namespace', kind: 'text', mono: true, half: true, section: 'Scope',
      when: (model) => !cluster(model), placeholder: 'default',
    },
    { path: 'name', label: 'Base name', kind: 'text', mono: true, required: true, half: true, section: 'Scope', help: 'Used for the role, the binding and the service account.' },
    {
      path: 'createServiceAccount', label: 'Create a ServiceAccount', kind: 'boolean', half: true,
      section: 'Subjects',
    },
    {
      path: 'subjects', label: 'Extra subjects', kind: 'array', section: 'Subjects', itemLabel: 'subject',
      itemDefault: () => ({ kind: 'ServiceAccount', name: '', namespace: '' }),
      itemFields: [
        {
          path: 'kind', label: 'Kind', kind: 'select', half: true,
          options: [
            { value: 'ServiceAccount', label: 'ServiceAccount' },
            { value: 'User', label: 'User' },
            { value: 'Group', label: 'Group' },
          ],
        },
        { path: 'name', label: 'Name', kind: 'text', mono: true, half: true, required: true },
        {
          path: 'namespace', label: 'Namespace', kind: 'text', mono: true, half: true,
          when: (model) => model.kind === 'ServiceAccount',
        },
      ],
    },
    {
      path: 'rules', label: 'Rules', kind: 'array', section: 'Permissions', required: true, itemLabel: 'rule',
      itemDefault: () => ({ apiGroups: '', resources: 'pods', verbs: ['get', 'list', 'watch'], resourceNames: '' }),
      itemFields: [
        {
          path: 'apiGroups', label: 'API groups', kind: 'text', mono: true, half: true,
          placeholder: 'apps, batch', help: 'Empty means the core group. Comma separated.',
        },
        {
          path: 'resources', label: 'Resources', kind: 'text', mono: true, half: true, required: true,
          placeholder: 'pods, pods/log', help: 'Comma separated, plural names.',
        },
        {
          path: 'verbs', label: 'Verbs', kind: 'stringlist', required: true,
          options: VERBS.map((verb) => ({ value: verb, label: verb })),
        },
        {
          path: 'resourceNames', label: 'Limit to names', kind: 'text', mono: true,
          help: 'Optional. Comma separated. Does not work with list or watch.',
        },
      ],
    },
  ],
  defaults: () => ({
    scope: 'Namespaced',
    namespace: 'default',
    name: 'app-reader',
    createServiceAccount: true,
    subjects: [],
    rules: [{ apiGroups: '', resources: 'pods, configmaps', verbs: ['get', 'list', 'watch'], resourceNames: '' }],
  }),
  build: (model) => {
    const name = str(get(model, 'name')) ?? 'rbac';
    const namespace = cluster(model) ? undefined : str(get(model, 'namespace'));
    const roleKind = cluster(model) ? 'ClusterRole' : 'Role';
    const bindingKind = cluster(model) ? 'ClusterRoleBinding' : 'RoleBinding';
    const base = slug(name, 'rbac');
    const files: GeneratedFile[] = [];

    const subjects = [
      ...(get(model, 'createServiceAccount') === true
        ? [{ kind: 'ServiceAccount', name, namespace: namespace ?? 'default' }]
        : []),
      ...(get(model, 'subjects') ?? [])
        .filter((subject: any) => str(subject?.name))
        .map((subject: any) => ({
          kind: subject.kind || 'ServiceAccount',
          name: str(subject.name),
          namespace: subject.kind === 'ServiceAccount' ? (str(subject.namespace) ?? namespace ?? 'default') : undefined,
          apiGroup: subject.kind === 'User' || subject.kind === 'Group' ? 'rbac.authorization.k8s.io' : undefined,
        })),
    ];

    if (get(model, 'createServiceAccount') === true) {
      files.push(yamlFile(`${base}-serviceaccount.yaml`, {
        apiVersion: 'v1',
        kind: 'ServiceAccount',
        metadata: { name, namespace: namespace ?? 'default' },
      }));
    }

    files.push(yamlFile(`${base}-${roleKind.toLowerCase()}.yaml`, {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: roleKind,
      metadata: { name, namespace },
      rules: (get(model, 'rules') ?? [])
        .filter((rule: any) => toList(rule?.resources))
        .map((rule: any) => ({
          apiGroups: toList(rule.apiGroups) ?? [''],
          resources: toList(rule.resources),
          verbs: toList(rule.verbs) ?? ['get'],
          resourceNames: toList(rule.resourceNames),
        })),
    }));

    files.push(yamlFile(`${base}-${bindingKind.toLowerCase()}.yaml`, {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: bindingKind,
      metadata: { name, namespace },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: roleKind, name },
      subjects: subjects.length ? subjects : undefined,
    }));

    return files;
  },
  load: (docs) => {
    const role = docs.find((doc) => doc?.kind === 'Role' || doc?.kind === 'ClusterRole');
    const binding = docs.find((doc) => doc?.kind === 'RoleBinding' || doc?.kind === 'ClusterRoleBinding');
    const account = docs.find((doc) => doc?.kind === 'ServiceAccount');
    if (!role && !binding && !account) return null;
    const source = role ?? binding ?? account;
    const isCluster = source?.kind === 'ClusterRole' || source?.kind === 'ClusterRoleBinding';
    const name = source?.metadata?.name ?? '';
    const namespace = source?.metadata?.namespace ?? '';
    const subjects = binding?.subjects ?? [];
    return {
      scope: isCluster ? 'Cluster' : 'Namespaced',
      namespace,
      name,
      createServiceAccount: !!account
        || subjects.some((subject: any) => subject?.kind === 'ServiceAccount' && subject?.name === name),
      subjects: subjects
        .filter((subject: any) => !(subject?.kind === 'ServiceAccount' && subject?.name === name))
        .map((subject: any) => ({
          kind: subject?.kind ?? 'ServiceAccount',
          name: subject?.name ?? '',
          namespace: subject?.namespace ?? '',
        })),
      rules: (role?.rules ?? []).map((rule: any) => ({
        apiGroups: (rule?.apiGroups ?? []).filter(Boolean).join(', '),
        resources: (rule?.resources ?? []).join(', '),
        verbs: rule?.verbs ?? [],
        resourceNames: (rule?.resourceNames ?? []).join(', '),
      })),
    };
  },
  validate: (model) => {
    const issues: Issue[] = [...checkName(get(model, 'name'), 'name', 'Base name')];
    if (!cluster(model) && str(get(model, 'namespace'))) {
      issues.push(...checkName(get(model, 'namespace'), 'namespace', 'Namespace'));
    }
    const rules = get(model, 'rules') ?? [];
    if (!rules.length) issues.push({ level: 'error', message: 'At least one rule is required', path: 'rules' });
    rules.forEach((rule: any, index: number) => {
      if (!toList(rule?.resources)) {
        issues.push({ level: 'error', message: 'Resources is required', path: `rules.${index}.resources` });
      }
      const verbs = toList(rule?.verbs) ?? [];
      if (!verbs.length) {
        issues.push({ level: 'error', message: 'Pick at least one verb', path: `rules.${index}.verbs` });
      }
      if (verbs.includes('*') && cluster(model)) {
        issues.push({
          level: 'warning',
          message: 'A cluster-wide rule with verb "*" grants full control over those resources',
          path: `rules.${index}.verbs`,
        });
      }
      if (toList(rule?.resourceNames) && verbs.some((verb: string) => ['list', 'watch', 'create'].includes(verb))) {
        issues.push({
          level: 'warning',
          message: 'resourceNames has no effect on list, watch or create',
          path: `rules.${index}.resourceNames`,
        });
      }
    });
    const hasSubject = get(model, 'createServiceAccount') === true
      || (get(model, 'subjects') ?? []).some((subject: any) => str(subject?.name));
    if (!hasSubject) {
      issues.push({ level: 'error', message: 'The binding needs at least one subject', path: 'subjects' });
    }
    return issues;
  },
};
