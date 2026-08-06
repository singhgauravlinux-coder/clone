import type { Issue, ResourceDefinition } from '../core/types';
import { get, mapToPairs, num, pairsToMap, str, toList } from '../core/model';
import { slug, yamlFile } from '../core/files';
import { checkSchedule } from '../core/validation';

const JOB_ID = /^[A-Za-z_][A-Za-z0-9_-]*$/;

const permissionOptions = [
  { value: '', label: 'Not set' },
  { value: 'read', label: 'read' },
  { value: 'write', label: 'write' },
  { value: 'none', label: 'none' },
];

export const githubWorkflow: ResourceDefinition = {
  id: 'github-workflow',
  group: 'CI',
  label: 'GitHub Actions workflow',
  summary: 'A workflow file with triggers, permissions and jobs.',
  apiVersion: '.github/workflows',
  fields: [
    { path: 'name', label: 'Workflow name', kind: 'text', required: true, half: true, section: 'Workflow' },
    {
      path: 'filename', label: 'File name', kind: 'text', mono: true, half: true, section: 'Workflow',
      placeholder: 'ci.yml',
    },
    {
      path: 'on.push', label: 'Run on push', kind: 'boolean', half: true, section: 'Triggers',
    },
    {
      path: 'on.pushBranches', label: 'Push branches', kind: 'text', mono: true, half: true, section: 'Triggers',
      placeholder: 'main, release/*', when: (model) => get(model, 'on.push') === true, help: 'Comma separated.',
    },
    {
      path: 'on.pushTags', label: 'Push tags', kind: 'text', mono: true, half: true, section: 'Triggers',
      placeholder: 'v*', when: (model) => get(model, 'on.push') === true,
    },
    {
      path: 'on.pushPaths', label: 'Push paths', kind: 'text', mono: true, half: true, section: 'Triggers',
      placeholder: 'src/**', when: (model) => get(model, 'on.push') === true,
    },
    { path: 'on.pullRequest', label: 'Run on pull request', kind: 'boolean', half: true, section: 'Triggers' },
    {
      path: 'on.prBranches', label: 'Pull request branches', kind: 'text', mono: true, half: true, section: 'Triggers',
      placeholder: 'main', when: (model) => get(model, 'on.pullRequest') === true,
    },
    {
      path: 'on.schedule', label: 'Schedule (cron)', kind: 'text', mono: true, half: true, section: 'Triggers',
      placeholder: '0 3 * * 1', help: 'UTC. Leave empty for no schedule.',
    },
    { path: 'on.workflowDispatch', label: 'Allow manual runs', kind: 'boolean', half: true, section: 'Triggers' },
    {
      path: 'on.release', label: 'Run on release published', kind: 'boolean', half: true, section: 'Triggers',
    },
    {
      path: 'permissions.contents', label: 'contents', kind: 'select', half: true, section: 'Permissions',
      options: permissionOptions,
    },
    {
      path: 'permissions.packages', label: 'packages', kind: 'select', half: true, section: 'Permissions',
      options: permissionOptions,
    },
    {
      path: 'permissions.idToken', label: 'id-token', kind: 'select', half: true, section: 'Permissions',
      options: permissionOptions, help: 'write is needed for OIDC cloud login.',
    },
    {
      path: 'permissions.pullRequests', label: 'pull-requests', kind: 'select', half: true, section: 'Permissions',
      options: permissionOptions,
    },
    {
      path: 'concurrency.group', label: 'Concurrency group', kind: 'text', mono: true, half: true,
      section: 'Concurrency', placeholder: '${{ github.workflow }}-${{ github.ref }}',
    },
    {
      path: 'concurrency.cancelInProgress', label: 'Cancel in-progress runs', kind: 'boolean', half: true,
      section: 'Concurrency', when: (model) => !!str(get(model, 'concurrency.group')),
    },
    { path: 'env', label: 'Workflow environment', kind: 'keyvalue', section: 'Environment' },
    {
      path: 'jobs', label: 'Jobs', kind: 'array', section: 'Jobs', required: true, itemLabel: 'job',
      itemDefault: () => ({
        id: 'build',
        name: '',
        runsOn: 'ubuntu-latest',
        needs: '',
        condition: '',
        environment: '',
        timeoutMinutes: '',
        matrixKey: '',
        matrixValues: '',
        steps: [{ name: 'Check out', uses: 'actions/checkout@v4', with: [], run: '', condition: '' }],
      }),
      itemFields: [
        { path: 'id', label: 'Job id', kind: 'text', mono: true, half: true, required: true, placeholder: 'build' },
        { path: 'name', label: 'Display name', kind: 'text', half: true },
        {
          path: 'runsOn', label: 'Runs on', kind: 'text', mono: true, half: true, required: true,
          placeholder: 'ubuntu-latest',
        },
        { path: 'needs', label: 'Needs', kind: 'text', mono: true, half: true, help: 'Comma separated job ids.' },
        { path: 'condition', label: 'Condition (if)', kind: 'text', mono: true, half: true, placeholder: "github.ref == 'refs/heads/main'" },
        { path: 'environment', label: 'Environment', kind: 'text', mono: true, half: true },
        { path: 'timeoutMinutes', label: 'Timeout (minutes)', kind: 'number', half: true, min: 1 },
        {
          path: 'matrixKey', label: 'Matrix variable', kind: 'text', mono: true, half: true, placeholder: 'go-version',
        },
        {
          path: 'matrixValues', label: 'Matrix values', kind: 'text', mono: true, half: true, placeholder: '1.22, 1.23',
          when: (model) => !!str(model.matrixKey),
        },
        {
          path: 'steps', label: 'Steps', kind: 'array', itemLabel: 'step', required: true,
          itemDefault: () => ({ name: '', uses: '', with: [], run: '', condition: '' }),
          itemFields: [
            { path: 'name', label: 'Step name', kind: 'text', half: true },
            {
              path: 'uses', label: 'Action (uses)', kind: 'text', mono: true, half: true,
              placeholder: 'actions/checkout@v4', help: 'Leave empty when the step runs a command.',
            },
            {
              path: 'with', label: 'Inputs (with)', kind: 'keyvalue',
              when: (model) => !!str(model.uses),
            },
            {
              path: 'run', label: 'Command (run)', kind: 'textarea', mono: true, placeholder: 'go test ./...',
              when: (model) => !str(model.uses),
            },
            { path: 'env', label: 'Step environment', kind: 'keyvalue' },
            { path: 'condition', label: 'Condition (if)', kind: 'text', mono: true },
          ],
        },
      ],
    },
  ],
  defaults: () => ({
    name: 'CI',
    filename: 'ci.yml',
    on: {
      push: true, pushBranches: 'main', pushTags: '', pushPaths: '',
      pullRequest: true, prBranches: 'main', schedule: '', workflowDispatch: true, release: false,
    },
    permissions: { contents: 'read', packages: '', idToken: '', pullRequests: '' },
    concurrency: { group: '${{ github.workflow }}-${{ github.ref }}', cancelInProgress: true },
    env: [],
    jobs: [{
      id: 'build',
      name: 'Build and test',
      runsOn: 'ubuntu-latest',
      needs: '',
      condition: '',
      environment: '',
      timeoutMinutes: 15,
      matrixKey: '',
      matrixValues: '',
      steps: [
        { name: 'Check out', uses: 'actions/checkout@v4', with: [], run: '', env: [], condition: '' },
        {
          name: 'Set up Go', uses: 'actions/setup-go@v5',
          with: [{ key: 'go-version', value: '1.23' }], run: '', env: [], condition: '',
        },
        { name: 'Test', uses: '', with: [], run: 'go test ./...', env: [], condition: '' },
      ],
    }],
  }),
  build: (model) => {
    const triggers: Record<string, any> = {};
    if (get(model, 'on.push') === true) {
      triggers.push = {
        branches: toList(get(model, 'on.pushBranches')),
        tags: toList(get(model, 'on.pushTags')),
        paths: toList(get(model, 'on.pushPaths')),
      };
      if (!Object.values(triggers.push).some(Boolean)) triggers.push = null;
    }
    if (get(model, 'on.pullRequest') === true) {
      const branches = toList(get(model, 'on.prBranches'));
      triggers.pull_request = branches ? { branches } : null;
    }
    if (str(get(model, 'on.schedule'))) {
      triggers.schedule = [{ cron: str(get(model, 'on.schedule')) }];
    }
    if (get(model, 'on.release') === true) triggers.release = { types: ['published'] };
    if (get(model, 'on.workflowDispatch') === true) triggers.workflow_dispatch = null;

    const permissions: Record<string, any> = {
      contents: str(get(model, 'permissions.contents')),
      packages: str(get(model, 'permissions.packages')),
      'id-token': str(get(model, 'permissions.idToken')),
      'pull-requests': str(get(model, 'permissions.pullRequests')),
    };

    const jobs: Record<string, any> = {};
    for (const job of get(model, 'jobs') ?? []) {
      const id = str(job?.id);
      if (!id) continue;
      const matrixKey = str(job.matrixKey);
      jobs[id] = {
        name: str(job.name),
        'runs-on': str(job.runsOn) ?? 'ubuntu-latest',
        needs: toList(job.needs),
        if: str(job.condition),
        environment: str(job.environment),
        'timeout-minutes': num(job.timeoutMinutes),
        strategy: matrixKey ? { matrix: { [matrixKey]: toList(job.matrixValues) ?? [] } } : undefined,
        steps: (job.steps ?? [])
          .filter((step: any) => str(step?.uses) || str(step?.run))
          .map((step: any) => ({
            name: str(step.name),
            if: str(step.condition),
            uses: str(step.uses),
            with: str(step.uses) ? pairsToMap(step.with) : undefined,
            run: str(step.uses) ? undefined : str(step.run),
            env: pairsToMap(step.env),
          })),
      };
    }

    const group = str(get(model, 'concurrency.group'));
    const file = slug(str(get(model, 'filename')) ?? str(get(model, 'name')) ?? 'workflow', 'workflow')
      .replace(/\.(yml|yaml)$/, '');
    return [yamlFile(`.github/workflows/${file}.yml`, {
      name: str(get(model, 'name')),
      on: triggers,
      permissions: Object.values(permissions).some(Boolean) ? permissions : undefined,
      concurrency: group ? {
        group,
        'cancel-in-progress': get(model, 'concurrency.cancelInProgress') === true ? true : undefined,
      } : undefined,
      env: pairsToMap(get(model, 'env')),
      jobs,
    })];
  },
  load: (docs) => {
    const doc = docs.find((entry) => entry && typeof entry === 'object' && entry.jobs && entry.on !== undefined);
    if (!doc) return null;
    const on = doc.on ?? {};
    const push = on.push ?? null;
    const pr = on.pull_request ?? null;
    return {
      name: doc.name ?? '',
      filename: `${slug(doc.name ?? 'workflow')}.yml`,
      on: {
        push: 'push' in on,
        pushBranches: (push?.branches ?? []).join(', '),
        pushTags: (push?.tags ?? []).join(', '),
        pushPaths: (push?.paths ?? []).join(', '),
        pullRequest: 'pull_request' in on,
        prBranches: (pr?.branches ?? []).join(', '),
        schedule: on.schedule?.[0]?.cron ?? '',
        workflowDispatch: 'workflow_dispatch' in on,
        release: 'release' in on,
      },
      permissions: {
        contents: doc.permissions?.contents ?? '',
        packages: doc.permissions?.packages ?? '',
        idToken: doc.permissions?.['id-token'] ?? '',
        pullRequests: doc.permissions?.['pull-requests'] ?? '',
      },
      concurrency: {
        group: doc.concurrency?.group ?? '',
        cancelInProgress: doc.concurrency?.['cancel-in-progress'] === true,
      },
      env: mapToPairs(doc.env),
      jobs: Object.entries(doc.jobs ?? {}).map(([id, raw]: [string, any]) => {
        const matrix = raw?.strategy?.matrix ?? {};
        const matrixKey = Object.keys(matrix)[0] ?? '';
        return {
          id,
          name: raw?.name ?? '',
          runsOn: raw?.['runs-on'] ?? 'ubuntu-latest',
          needs: Array.isArray(raw?.needs) ? raw.needs.join(', ') : (raw?.needs ?? ''),
          condition: raw?.if ?? '',
          environment: typeof raw?.environment === 'string' ? raw.environment : '',
          timeoutMinutes: raw?.['timeout-minutes'] ?? '',
          matrixKey,
          matrixValues: matrixKey ? (matrix[matrixKey] ?? []).join(', ') : '',
          steps: (raw?.steps ?? []).map((step: any) => ({
            name: step?.name ?? '',
            uses: step?.uses ?? '',
            with: mapToPairs(step?.with),
            run: step?.run ?? '',
            env: mapToPairs(step?.env),
            condition: step?.if ?? '',
          })),
        };
      }),
    };
  },
  validate: (model) => {
    const issues: Issue[] = [];
    if (!str(get(model, 'name'))) {
      issues.push({ level: 'error', message: 'Workflow name is required', path: 'name' });
    }
    const on = get(model, 'on') ?? {};
    if (!on.push && !on.pullRequest && !on.workflowDispatch && !on.release && !str(on.schedule)) {
      issues.push({ level: 'error', message: 'A workflow needs at least one trigger', path: 'on.push' });
    }
    if (str(on.schedule)) issues.push(...checkSchedule(on.schedule, 'on.schedule'));
    const jobs = get(model, 'jobs') ?? [];
    if (!jobs.length) issues.push({ level: 'error', message: 'Add at least one job', path: 'jobs' });
    const ids = new Set(jobs.map((job: any) => str(job?.id)).filter(Boolean));
    jobs.forEach((job: any, index: number) => {
      const id = str(job?.id);
      if (!id) {
        issues.push({ level: 'error', message: 'Job id is required', path: `jobs.${index}.id` });
      } else if (!JOB_ID.test(id)) {
        issues.push({ level: 'error', message: `Job id "${id}" must start with a letter or _ and use only letters, digits, - and _`, path: `jobs.${index}.id` });
      }
      (toList(job?.needs) ?? []).forEach((need) => {
        if (!ids.has(need)) {
          issues.push({ level: 'error', message: `Job "${id}" needs "${need}", which is not defined`, path: `jobs.${index}.needs` });
        }
      });
      const steps = job?.steps ?? [];
      if (!steps.length) {
        issues.push({ level: 'error', message: `Job "${id}" has no steps`, path: `jobs.${index}.steps` });
      }
      steps.forEach((step: any, stepIndex: number) => {
        const base = `jobs.${index}.steps.${stepIndex}`;
        if (!str(step?.uses) && !str(step?.run)) {
          issues.push({ level: 'error', message: 'A step needs either an action or a command', path: `${base}.uses` });
        }
        const uses = str(step?.uses);
        if (uses && !uses.includes('@') && !uses.startsWith('./') && !uses.startsWith('docker://')) {
          issues.push({ level: 'warning', message: `Action "${uses}" has no version. Pin it with @v4 or a commit SHA.`, path: `${base}.uses` });
        }
      });
    });
    if (get(model, 'permissions.contents') === 'write') {
      issues.push({
        level: 'warning',
        message: 'contents: write lets the workflow push to the repository',
        path: 'permissions.contents',
      });
    }
    return issues;
  },
};
