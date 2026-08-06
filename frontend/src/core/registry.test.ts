import { generate, importDocuments, resources, validate } from './registry';
import { parseDocuments } from './yaml';

let failures = 0;
const note = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `\n${detail}` : ''}`);
};

for (const resource of resources) {
  const model = resource.defaults();
  const files = generate(resource, model);
  note(files.length > 0 && !files.some((file) => file.path === 'error.txt'), `${resource.id}: builds`,
    files.find((file) => file.path === 'error.txt')?.content ?? '');

  // Every emitted YAML file must parse back.
  let parsed: any[] = [];
  for (const file of files.filter((entry) => entry.language === 'yaml')) {
    try {
      parsed = parsed.concat(parseDocuments(file.content));
    } catch (error) {
      note(false, `${resource.id}: ${file.path} re-parses`, String(error));
    }
  }

  const errors = validate(resource, model).filter((issue) => issue.level === 'error');
  note(errors.length === 0, `${resource.id}: defaults validate`, errors.map((issue) => `     ${issue.path}: ${issue.message}`).join('\n'));

  if (resource.load) {
    const reloaded = resource.load(parsed);
    if (!reloaded) {
      note(false, `${resource.id}: load matches its own output`);
    } else {
      const before = files.filter((file) => file.language === 'yaml').map((file) => file.content).join('\n');
      const after = generate(resource, reloaded).filter((file) => file.language === 'yaml').map((file) => file.content).join('\n');
      if (before !== after) {
        const beforeLines = before.split('\n');
        const afterLines = after.split('\n');
        const diff: string[] = [];
        for (let i = 0; i < Math.max(beforeLines.length, afterLines.length); i += 1) {
          if (beforeLines[i] !== afterLines[i]) diff.push(`     - ${beforeLines[i] ?? ''}\n     + ${afterLines[i] ?? ''}`);
        }
        note(false, `${resource.id}: round trip is stable`, diff.slice(0, 6).join('\n'));
      } else {
        note(true, `${resource.id}: round trip is stable`);
      }
    }
  }
}

// Importing a pasted manifest picks the right form.
const imported = importDocuments(`apiVersion: v1
kind: Service
metadata:
  name: api
spec:
  type: NodePort
  selector:
    app: api
  ports:
    - name: http
      port: 80
      targetPort: 8080
      nodePort: 30080
`);
note(imported.resource.id === 'service', 'import detects Service');
note(imported.model.spec.type === 'NodePort', 'import keeps the type');

const workflow = importDocuments(`name: release
on:
  push:
    tags: [v*]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`);
note(workflow.resource.id === 'github-workflow', 'import detects a workflow');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILING`);
if (failures) process.exit(1);
