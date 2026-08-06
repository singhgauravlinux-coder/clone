# Architecture

## The shape of the thing

Two halves that share one vocabulary.

**Authoring** turns a form into files. It is pure computation: a model in, a
list of `{path, content}` out. No cluster, no database, no network. This half
runs in the browser and, identically, in the Go service.

**Operations** takes files and makes them real, then keeps watching. Applying,
diffing, drawing the topology, rolling back — all of it needs a cluster
connection, a database and an audit trail.

Keeping them separate is what makes the product safe to use. You can author all
day with no credentials, and the code paths that can change a cluster are the
small ones you can read in an afternoon.

```
 browser                          Go service                     outside
┌──────────────────┐   REST      ┌────────────────────┐         ┌─────────────┐
│ registry         │◀───────────▶│ api  (gin)         │────────▶│ PostgreSQL  │
│  ├ resources/*   │             │  ├ middleware      │         │  RLS + audit│
│  ├ yaml emit     │             │  ├ routes          │         └─────────────┘
│  └ validation    │             │  └ ports (iface)   │         ┌─────────────┐
│ platform client  │             │ auth   argon2/JWT  │────────▶│ Redis       │
│  ├ demo (no API) │             │ rbac   verb+scope  │         │  sessions   │
│  └ http          │             │ audit  hash chain  │         └─────────────┘
│ components       │             │ cluster client-go  │────────▶┌─────────────┐
│  ├ FormRenderer  │             │ registry/resources │         │ kube API ×N │
│  ├ YamlPane      │             │ yamlgen  ordered   │         └─────────────┘
│  ├ TopologyView  │             └────────────────────┘
│  └ ActivityView  │
└──────────────────┘
```

## Layering

Dependencies point one way only:

```
components  ──▶  platform (client, types)  ──▶  core (registry, yaml, topology)
handlers    ──▶  ports (interfaces)        ──▶  domain packages
```

`internal/api` declares the interfaces it needs (`AuthService`,
`ApplicationService`, `DeploymentService`, `ActivityService`) and never imports a
database driver or a Kubernetes client. That is what lets the same router run in
three shapes:

- **generator** — `Services{}` zero value. No database, no auth, no cluster. This
  is what runs in CI to lint manifests.
- **platform** — everything wired.
- **test** — fakes for the four ports; no containers needed.

## The registry pattern

Everything the product knows about a resource type lives in one value:

```ts
interface ResourceDefinition {
  id, group, label, summary, apiVersion, kinds
  fields:   FieldDef[]                  // drives the form; there is no bespoke UI
  defaults: () => Model
  build:    (model) => GeneratedFile[]
  load?:    (docs)  => Model | null     // import
  validate?:(model) => Issue[]
}
```

`FormRenderer` walks `fields`. It has never heard of a Deployment. Adding a
resource type is one file plus one line in `core/registry.ts`; the sidebar entry,
the form, the preview, the validation panel, import matching, the export buttons
and the round-trip test all follow.

The Go side mirrors the same struct in `internal/registry`, with definitions
registering themselves from `init()`.

## Topology

Argo CD draws its tree from what the cluster reports. Before anything is applied
there is no cluster to ask, so `core/topology.ts` derives the same node shape
from the manifests themselves: which controllers exist, what pods they will
produce, which Service selects which workload, what an Ingress routes to. When a
live cluster is attached the backend returns the identical shape with real health
and the view does not change — the same component renders a plan and a running
system.

Layout is depth-based rather than force-directed. An `ownerReferences` chain is a
tree, and a deterministic tree is far easier to read than a graph that reshuffles
on every poll.

## Drift

`cluster.Detect` compares the desired object against the live one field by field,
after projecting the live object down to the fields the manifest actually sets.
This matters: a live Deployment carries a hundred defaulted fields that were
never in the manifest, and naively diffing whole objects reports drift on all of
them.

Each finding records the field path, both values, and the writer taken from
`managedFields`, so the UI can say "kubectl-scale changed spec.replicas from 3 to
6" instead of "something is different".

## Multi-tenancy

Tenancy is enforced in the database, not in application code. Every reachable row
carries `organization_id`; `0003_rls.sql` enables row level security with a
single predicate against `current_setting('app.organization_id')`, and the
application connects as `workbench_app`, which is neither the table owner nor
`BYPASSRLS`.

The consequence: a repository method that forgets its `WHERE` clause returns zero
rows instead of another tenant's data. `db/tests/rls.sql` proves this by running
deliberately unscoped queries as the application role.

## Audit

One table, `activity_log`, append-only twice over:

1. A `BEFORE UPDATE OR DELETE` trigger raises.
2. The application role holds no `UPDATE` or `DELETE` grant, so the attempt never
   reaches the trigger.

Each row carries `prev_hash` and `entry_hash` over a canonical serialisation, so
a row edited by someone with owner access breaks the chain.
`activity_log_verify()` returns the first broken id.

`Recorder.Record` never fails the request it is describing: a write failure is
attached to the request's error list and the response continues. An audit trail
that can take the product down gets disabled.

## Deployment verbs

Four, and they are separate permissions on purpose:

| Verb | Permission | Changes the cluster |
| --- | --- | --- |
| Dry run | `deployment.dry_run` | no |
| Apply | `deployment.apply` | yes |
| Rollback | `deployment.rollback` | yes |
| Delete | `deployment.delete` | yes |

A developer with only `deployment.dry_run` can prove a change is valid — server
side validation, admission webhooks, the real diff — without holding the right to
make it. That single split removes most of the reason people share an operator
account.

Apply uses server-side apply with a stable field manager, so the platform owns
the fields it sets and does not fight other controllers over the ones it does
not.

## Plugin boundaries

Four extension points, each an interface or a registry, none requiring a fork:

- **Resource types** — `ResourceDefinition`, both languages.
- **Identity providers** — `identity_providers` rows plus a provider interface;
  OIDC, SAML and LDAP are three implementations of the same contract.
- **Ports** — swap `DeploymentService` for one that opens a pull request instead
  of applying, and the UI does not change.
- **Validation rules** — `validate.Issue` producers compose; a definition's
  `validate` is just another one.
