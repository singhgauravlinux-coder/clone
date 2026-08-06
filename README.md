# Manifest Workbench

Rancher's resource creation experience and Argo CD's deployment view, in one
product, with an audit trail you can hand to a regulator.

Fill in a form, watch the YAML build itself, see the topology it will create,
dry run it against a real API server, apply it, and find the exact row in the
activity log six months later.

```
┌─ Form ─────────────┬─ YAML ──────────────┬─ Topology ─────────┐
│ Deployment         │ apiVersion: apps/v1 │      ┌─ deploy ─┐  │
│  name    [web    ] │ kind: Deployment    │ app ─┤          │  │
│  image   [nginx:…] │ metadata:           │      └─ svc ────┘  │
│  replicas[3      ] │   name: web         │                    │
└────────────────────┴─────────────────────┴────────────────────┘
```

## What is verified

Claims in this README that were checked by running something:

| Check | How |
| --- | --- |
| Schema applies and behaves | 3 migrations + 2 suites against real PostgreSQL 16 |
| Tenant isolation | unscoped queries as the app role return zero rows |
| Audit log is append-only | `UPDATE`/`DELETE` rejected by grant *and* trigger |
| YAML round trips | emitter/parser suite, 19 assertions |
| Every resource type builds, re-parses, validates and imports byte-stably | registry sweep over all 16 |
| Topology, apply, rollback, activity filters, CSV export | platform suite, 23 assertions |
| Impersonation rules | template resolution, group derivation, and both escalation guards, against PostgreSQL 16 |
| Inventory schema behaviour | UID identity, managed vs observed, label containment, sync marking, all against PostgreSQL 16 |
| Live inventory model | 24 assertions: edges resolve, CRDs appear, forbidden kinds surface, filters are exact |
| Frontend type safety | `tsc --noEmit`, strict, zero errors |
| Go sources parse | `gofmt -e` across every file |
| Workflows are well formed | parsed with this repo's own YAML parser; jobs, steps, pinned actions and `needs` all resolve |

Not verified here: the Go service does not compile in this environment because
the module proxy is unreachable. See [Honest limits](#honest-limits).

## Authoring

Sixteen resource types across Workloads, Networking, Configuration, Storage,
Autoscaling, Access control, GitOps, Packaging and CI:

Deployment · StatefulSet · DaemonSet · Job · CronJob · Service · Ingress ·
ConfigMap · Secret · PersistentVolumeClaim · HorizontalPodAutoscaler · RBAC
bundle · Argo CD Application · Kustomize overlay · Helm chart · GitHub Actions
workflow

- **Live preview** that re-renders on every keystroke.
- **Two-way sync.** Edit the YAML directly and it is parsed back into the form.
  A syntax error shows the line number and leaves the form untouched until it
  parses again.
- **Import.** Paste or upload a manifest, a multi-document file, a kustomization
  or a workflow. The right form opens filled in, and anything the form does not
  model is listed so you know what was dropped.
- **Validation that points at fields.** Click an issue, the input scrolls into
  view and flashes. Rules cover DNS-1123 names, label syntax, port ranges,
  quantities, cron expressions, image tags, RBAC verb combinations, HPA metric
  requirements and Argo sync policies.
- **Export.** Copy, download, ZIP a multi-file bundle, or commit to Git.

## Reading a live cluster

The explorer lists **everything running**, not only what this platform
deployed. Kinds are discovered at read time, so a CRD installed yesterday shows
up without a code change.

- **Managed vs observed.** An object carries a badge when this platform's field
  manager appears in its `managedFields`. Everything else — Helm releases,
  operator-created objects, whatever a human applied — is listed and read-only.
  Rollback is never offered for something we did not deploy.
- **Partial reads are stated, never hidden.** A kind the credential cannot list
  is reported as "not permitted", and an API group that fails discovery (a
  metrics server that is down) degrades the read instead of failing it. An empty
  namespace and a namespace you cannot see into look identical unless something
  says so.
- **Filter by namespace, kind, label or free text** across names, images, nodes
  and labels. Counts come from the unfiltered read, so the sidebar always shows
  where the rest of the cluster is.
- **Identity is the API server UID**, not the name, so a deleted-and-recreated
  object is a new object and a rename is not a deletion.
- **Disappearance is recorded, not deleted.** A completed sync marks what it did
  not see as missing; a partial sync deliberately does not, or losing access to a
  namespace would look like a mass deletion.

Under it: paginated dynamic-client lists with bounded concurrency, an
ownerReference graph with Service selectors and Ingress backends resolved
separately (and labelled as inferred), events by field selector, bounded log
tails, metrics from `metrics.k8s.io`, and a resumable watch for incremental
updates.

## Operations

- **Topology** — Application → controllers → ReplicaSets → Pods, with Services
  and Ingresses hung off the workloads they front. Pan, zoom, fit, filter.
  Health and sync state on every node.
- **Detail drawer** — status, events, logs, CPU/memory sparklines, live
  manifest, and a field-level drift diff naming the controller that made each
  change, read from `managedFields`.
- **Four verbs** — dry run, apply, rollback, delete. Separate permissions, so a
  developer can prove a change is valid without holding the right to make it.
- **Drift detection** that projects the live object down to the fields the
  manifest actually sets, so a hundred defaulted fields do not read as drift.

## Cluster access

Two modes per cluster. **Shared credential** is simple and works anywhere, but
it makes this platform's permission table the enforcement boundary.
**Impersonate** makes every call as the logged-in user, so Kubernetes RBAC
decides and our permissions are only a first filter — a bug here can no longer
grant more than the person already had. Both identities land on every audit row.

`system:masters` and newline-injected usernames are refused in Go *and* by
database constraints, on the theory that one of the two will eventually be
bypassed. `GET /clusters/:id/permissions` runs access reviews so the UI greys
out buttons the cluster would refuse, rather than buttons our own table dislikes.

The explorer is served from **informer-backed caches**, keyed per cluster *and*
per identity — with impersonation on, two users legitimately see different
objects, so one shared store would leak. Caches evict when idle, only cover the
core kinds (Secrets are deliberately never cached), and fall back to a live list
if they cannot sync in time.

## Identity

Email/username + password (argon2id), JWT access tokens with rotating refresh
token families, TOTP MFA with recovery codes, OIDC, SAML 2.0, LDAP/AD, password
reset, email verification, API keys and personal access tokens, session
management, and RBAC over `organization ⊃ project ⊃ cluster ⊃ namespace`.

Details, including what is stored and what is deliberately not:
[docs/security.md](docs/security.md).

## Layout

```
frontend/src/
  core/            registry, YAML emitter and parser, validation, topology, zip
  resources/       one file per resource type
  platform/        domain types, API client (demo | http), seeded dataset
  components/      FormRenderer, YamlPane, TopologyView, ResourceDrawer,
                   DeployView, ActivityView, ImportDialog, IssuePanel
backend/internal/
  api/             router, ports, middleware, routes
  auth/            argon2id, JWT, refresh rotation, TOTP, API keys, lockout
  rbac/            verb + scope evaluation
  audit/           hash-chained append-only recorder
  cluster/         client-go: connect, apply, delete, drift, health
  registry/        resource definitions, mirroring the frontend contract
  yamlgen/         ordered-map emitter
db/
  migrations/      0001 schema · 0002 applications and Git · 0003 RLS
  tests/           verify.sql · rls.sql
deploy/            Dockerfile, compose, Helm chart with per-environment values
.github/workflows/ ci · cd · deploy
docs/              architecture · security · api · deployment
```

## Shipping it

`main` deploys to staging automatically; a `v*` tag deploys to production behind
a GitHub environment approval. The image is built and signed once and the same
digest is deployed to both, so "it worked in staging" means something.

| Workflow | Trigger | Jobs |
| --- | --- | --- |
| `ci.yml` | push, PR | frontend · backend · database · manifests · image · secrets |
| `cd.yml` | `main`, `v*`, manual | publish to GHCR, sign, attest, then deploy |
| `deploy.yml` | called by `cd.yml` | the only path that can change a cluster |

The database job runs the migrations and both SQL suites against a real
PostgreSQL service container, and fails a pull request that edits an existing
migration. The manifests job renders every values file and validates the output
against the Kubernetes 1.30 schema.

Full setup — environments, secrets, OIDC, rollback layers:
[docs/deployment.md](docs/deployment.md).

## Running it

```bash
# everything, with a database
docker compose -f deploy/docker/docker-compose.yml up --build
# → http://localhost:8080

# frontend alone — fully usable, authors and validates, cannot deploy
cd frontend && npm install && npm run dev

# backend alone
cd backend && go mod tidy && go run . --addr :8080 --web ../frontend/dist
```

The frontend probes `/api/healthz` once at start-up. No backend means it runs
against the seeded dataset; the UI is identical either way, because both sit
behind the same `PlatformClient` interface.

## Tests

```bash
cd frontend && npm run test:bundle      # yaml, registry, platform

# schema, against a scratch database
psql -f db/migrations/0001_init.sql -f db/migrations/0002_applications_git.sql \
     -f db/migrations/0003_rls.sql -d workbench
psql -v ON_ERROR_STOP=1 -f db/tests/verify.sql -d workbench
psql -v ON_ERROR_STOP=1 -U workbench_app -f db/tests/rls.sql -d workbench

cd backend && go test ./...
```

## Extending it

Adding a resource type is one file and one line:

```ts
// frontend/src/resources/networkpolicy.ts
export const networkPolicy: ResourceDefinition = { id, group, label, fields, defaults, build, load, validate };

// frontend/src/core/registry.ts
export const resources = [ …, networkPolicy ];
```

The sidebar entry, the form, the preview, the validation panel, import matching,
topology derivation and the export buttons all follow from the definition. The
round-trip test picks it up automatically and checks that it builds, re-parses,
validates clean by default, and survives build → parse → load → build byte for
byte.

Three other extension points, none requiring a fork: identity providers
(one interface, three implementations), the API's service ports (swap
`DeploymentService` for one that opens a pull request instead of applying), and
validation rules (they compose).

## Honest limits

- **The Helm chart is not rendered here.** No Helm binary and no cluster in this
  environment. `ci.yml` lints it, renders all three values files and runs
  kubeconform against the output, so the first CI run is the first real test.
  Budget a fix or two.
- **`backend/go.sum` is missing** and CI needs it. Run `go mod tidy` in
  `backend/` once and commit the result. CI falls back to generating it with a
  warning annotation so the pipeline is not blocked, but a checksum file
  generated in CI is not a lockfile.
- **Action pins drift.** Every `uses:` was re-resolved against the live tag
  lists; majors move faster than they look. A pin that does not exist fails the
  run immediately, so re-check them when you fork.
- **The Go service is not compiled here.** This environment cannot reach the
  module proxy, so `go build` was never run. Every file parses (`gofmt -e`) and
  the packages are internally consistent, but expect to fix a handful of things
  on first build. The database schema, by contrast, was executed.
- **Store implementations are ports, not code.** `internal/api` declares
  `AuthService`, `ApplicationService`, `DeploymentService` and `ActivityService`
  and the handlers are written against them. The PostgreSQL implementations of
  those four interfaces are the main thing left to write.
- **The frontend ships a real topology renderer, not React Flow.** The stack
  names React Flow and Monaco; this build hand-rolls the graph and the editor so
  it runs as a single artifact with no bundler. Both are behind small interfaces
  and swapping them is local work.
- **3D is CSS depth, not Three.js.** Layered translucency, inset highlights and
  real blur radii. No WebGL in this build.
- **Import is lossy by design.** A definition models the fields its form
  exposes; anything else is dropped rather than silently carried through. The
  preview always shows exactly what will be written.
- **Secrets are base64.** That is encoding, not encryption, and the Secret form
  says so on every render.
