# Deploying on Kubernetes with GitHub Actions

Build once, deploy that exact digest to every environment. `main` goes to
staging automatically; a `v*` tag goes to production behind an approval.

```
push ──▶ ci.yml ──▶ cd.yml ──▶ publish ──▶ staging ──▶ [approval] ──▶ production
         6 jobs      build      GHCR        auto                      tag only
                     once      + sign
```

## What runs where

| Workflow | Trigger | Does |
| --- | --- | --- |
| `ci.yml` | push, pull request | frontend, backend, database, manifests, image, secrets |
| `cd.yml` | push to `main`, `v*` tags, manual | builds and publishes, then calls `deploy.yml` per environment |
| `deploy.yml` | called by `cd.yml` | one reusable `helm upgrade`, smoke test, rollback |

`deploy.yml` is the only code path in the repository that can change a cluster.
That is deliberate: one place to review, one place to audit.

## Before the first run

### 1. Lockfiles

CI uses `npm ci` and `go mod download`, both of which need a committed lockfile.
`frontend/package-lock.json` is in the repo. **`backend/go.sum` is not** —
generate and commit it once, on a machine with network access:

```bash
cd backend
go mod tidy
git add go.sum go.mod && git commit -m "add go.sum"
```

Without it the backend job fails with `missing go.sum entry for module
providing package …` on every import. CI has a fallback that runs `go mod tidy`
itself and emits a warning annotation, so the pipeline is not blocked, but a
generated-in-CI checksum file defeats the point of having one: the build is no
longer reproducible, and a dependency substituted upstream would not be caught.
Commit the file.

### 1a. Action versions

Every action is pinned to a major. Those majors move — `actions/checkout` is on
v7, `docker/*` on v4–v7, `trivy-action` on v0.36.0 — and a pin that does not
exist fails the run immediately with `unable to find version`. Check them when
you fork:

```bash
gh api repos/actions/checkout/releases/latest --jq .tag_name
```

### 2. GitHub environments

Create `staging` and `production` under **Settings → Environments**. On
`production` add required reviewers and, optionally, restrict deployment
branches to tags. That approval gate is what turns a tag push into a deliberate
release.

### 3. Secrets

Per environment, not repository-wide. Staging and production must not share a
credential; a leak in staging should not be a production incident.

| Secret | Value |
| --- | --- |
| `KUBE_CONFIG` | base64 of a kubeconfig for a service account scoped to the release namespace |
| `GITHUB_TOKEN` | provided automatically; used to push to GHCR |

```bash
kubectl create serviceaccount deployer -n workbench
kubectl create rolebinding deployer --clusterrole=edit \
  --serviceaccount=workbench:deployer -n workbench
# Mint a bound token, build a kubeconfig from it, then:
base64 -w0 deployer.kubeconfig | gh secret set KUBE_CONFIG --env production
```

**Prefer federated OIDC where your cloud supports it.** On EKS, GKE or AKS,
delete the `Configure cluster access` step in `deploy.yml` and use the
commented block above it: a short-lived token beats a long-lived kubeconfig
sitting in a secret store, and there is nothing to rotate.

### 4. In-cluster secrets

The chart reads connection details from secrets you create, so a database URL
never lands in `values.yaml` or in Git:

```bash
kubectl create secret generic workbench-database -n workbench \
  --from-literal=url='postgres://workbench:...@db.internal:5432/workbench?sslmode=require'

kubectl create secret generic workbench-redis -n workbench \
  --from-literal=url='redis://redis.internal:6379/0'

kubectl create secret generic workbench-auth -n workbench \
  --from-literal=jwt-signing-key="$(openssl rand -base64 48)"
```

Rotating the signing key invalidates every access token immediately and every
session at next refresh. That is the intended emergency lever.

### 5. Database

Use managed PostgreSQL 16 in production. The compose file runs Postgres in a
container for local work only — an in-cluster database with an `emptyDir` is how
audit trails get lost.

Migrations run as a Helm `pre-upgrade` hook, so a rollout never starts against
an old schema. If the hook fails the release aborts and nothing new is served.

## Deploying

```bash
git push origin main                    # → staging
git tag v0.2.0 && git push origin v0.2.0  # → production, after approval
gh workflow run cd.yml -f environment=staging   # manual
```

### Rollback

Three layers, in order of how quickly they fire:

1. `helm upgrade --atomic` reverts automatically if the release does not become
   ready inside the timeout.
2. The smoke test polls `/api/healthz` through the ingress for two minutes; if
   the release came up but is not actually serving, the explicit rollback step
   returns to the revision captured before the upgrade.
3. Manual: `helm rollback workbench <revision> -n workbench`.

Schema migrations are **not** rolled back. That is why `ci.yml` fails a pull
request that modifies or deletes an existing migration: rolling application code
back onto a schema it does not know is survivable, but only if every migration
is additive.

## Chart layout

```
deploy/helm/
  Chart.yaml
  values.yaml               defaults
  values-staging.yaml       one replica, no autoscaling, own secrets
  values-production.yaml    three replicas, zone spread, PDB, HPA
  templates/
    deployment.yaml         digest-pinned, non-root, read-only rootfs
    service.yaml
    ingress.yaml
    hpa.yaml
    pdb.yaml
    networkpolicy.yaml      egress allow-list to your API server CIDRs
    rbac.yaml               optional in-cluster access (localCluster.enabled)
    migrations-job.yaml     pre-install/pre-upgrade hook
    serviceaccount.yaml
```

Notable defaults: `runAsNonRoot`, `readOnlyRootFilesystem`, all capabilities
dropped, `seccompProfile: RuntimeDefault`, and a distroless nonroot base image.

### Reaching other clusters

Egress to arbitrary API servers is the product's whole job, so the NetworkPolicy
is an allow-list rather than deny-all. Set `networkPolicy.allowedCIDRs` to the
ranges your API servers actually live in — leaving it wide open gives a
compromised pod a route to everything you peer with.

To make the cluster it runs in a deploy target without storing a credential for
itself, set `localCluster.enabled: true` and list the namespaces it may manage.
The generated role deliberately excludes RBAC write and admission webhook
access: a deploy tool that can rewrite RBAC is a privilege escalation path.

## GitOps instead

If you would rather Argo CD pull than have Actions push, keep `ci.yml` and the
`publish` job, drop `staging`/`production` from `cd.yml`, and have CI commit the
new digest to an environment repository. The product generates the Argo CD
Application for you — author it in the GitOps section of the UI.

## What is verified, and what is not

The workflows are structurally validated (every job has `runs-on` and steps,
every step has `uses` or `run`, every action is pinned, `needs` resolve) using
this repository's own YAML parser. `ci.yml` then lints the chart, renders all
three values files and validates the output against the Kubernetes 1.30 schema
with kubeconform.

None of that ran here: this environment has no Helm binary and no cluster. The
first CI run is the first real test of the chart, so expect to fix a value path
or two.
