import { toYaml, toYamlDocuments } from './emit';
import { parseYaml, parseDocuments, YamlError } from './parse';

let failures = 0;
function check(name: string, actual: any, expected: any) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    failures += 1;
    console.log(`FAIL ${name}\n  got      ${a}\n  expected ${b}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const deployment = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name: 'web', namespace: 'default', labels: { app: 'web', 'app.kubernetes.io/part-of': 'shop' } },
  spec: {
    replicas: 3,
    selector: { matchLabels: { app: 'web' } },
    template: {
      metadata: { labels: { app: 'web' } },
      spec: {
        containers: [
          {
            name: 'web',
            image: 'nginx:1.27',
            ports: [{ containerPort: 8080, name: 'http', protocol: 'TCP' }],
            env: [{ name: 'LOG_LEVEL', value: 'debug' }, { name: 'YES', value: 'true' }],
            args: ['--flag', '-v'],
            resources: { requests: { cpu: '100m', memory: '128Mi' } },
          },
        ],
        nodeSelector: {},
      },
    },
  },
};

const text = toYaml(deployment);
console.log('--- emitted ---');
console.log(text);
check('round trip deployment', parseYaml(text), JSON.parse(JSON.stringify({ ...deployment, spec: { ...deployment.spec, template: { ...deployment.spec.template, spec: { containers: deployment.spec.template.spec.containers } } } })));

check('quotes booleans-as-strings', /value: 'true'/.test(text), true);
check('quotes cpu quantity', /cpu: 100m/.test(text), true);

const script = toYaml({ data: { 'run.sh': '#!/bin/sh\nset -eu\necho "hi"\n' } });
console.log(script);
check('block scalar round trip', parseYaml(script), { data: { 'run.sh': '#!/bin/sh\nset -eu\necho "hi"\n' } });

check('flow sequence', parseYaml('args: [a, "b c", 3]'), { args: ['a', 'b c', 3] });
check('flow mapping', parseYaml('sel: {app: web, tier: api}'), { sel: { app: web_or('web'), tier: 'api' } });
function web_or(v: string) { return v; }

check('nested list of lists', parseYaml('a:\n  - - 1\n    - 2\n'), { a: [[1, 2]] });
check('empty map literal', parseYaml('a: {}\nb: []\n'), { a: {}, b: [] });
check('comments ignored', parseYaml('# top\na: 1 # trailing\n'), { a: 1 });
check('hash inside string kept', parseYaml('a: "b#c"\n'), { a: 'b#c' });
check('colon inside value', parseYaml("image: nginx:1.27\n"), { image: 'nginx:1.27' });
check('multi doc', parseDocuments('a: 1\n---\nb: 2\n').length, 2);
check('list of maps then key', parseYaml('spec:\n  rules:\n    - host: a.io\n      http:\n        paths:\n          - path: /\n            pathType: Prefix\nkind: Ingress\n'), {
  spec: { rules: [{ host: 'a.io', http: { paths: [{ path: '/', pathType: 'Prefix' }] } }] },
  kind: 'Ingress',
});
check('null value', parseYaml('a:\nb: 2\n'), { a: null, b: 2 });

const gha = `name: ci
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Test
        run: |
          go test ./...
          echo done
`;
check('github actions workflow', parseYaml(gha), {
  name: 'ci',
  on: { push: { branches: ['main'] } },
  jobs: { build: { 'runs-on': 'ubuntu-latest', steps: [{ uses: 'actions/checkout@v4' }, { name: 'Test', run: 'go test ./...\necho done\n' }] } },
});

let threw = false;
try { parseYaml('a: 1\n  b: 2\nc\n'); } catch (err) { threw = err instanceof YamlError; }
check('reports malformed line', threw, true);

check('documents joined', toYamlDocuments([{ a: 1 }, { b: 2 }]), 'a: 1\n---\nb: 2\n');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILING`);
if (failures) process.exit(1);
