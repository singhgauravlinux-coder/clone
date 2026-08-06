# Security

## Credentials at rest

Nothing reversible is stored.

| Secret | Storage |
| --- | --- |
| Password | argon2id, 64 MiB / 3 passes / 2 lanes, per-user salt, parameters encoded in the hash |
| Refresh token | SHA-256 digest; the token exists only in the client cookie |
| API key / PAT | SHA-256 digest, plus an indexed prefix so revocation is a lookup not a scan |
| TOTP secret | sealed by the KMS envelope in `secret_material` before it reaches a row |
| Kubeconfig, service account token, Git deploy key | envelope encrypted: a per-row DEK, wrapped by a KMS key; the DEK is never stored unwrapped |
| MFA recovery codes | SHA-256 digests; a used code is removed, never reusable |

## Login

```
password ──▶ argon2id verify ──▶ MFA owed? ──┬─ no ──▶ session + access token
                                             └─ yes ─▶ challenge id ──▶ TOTP ──▶ session
```

- A login attempt against an unknown address costs the same as one against a
  known address (`EqualiseTiming`), so the endpoint is not a user enumerator.
- The response never distinguishes "no such user" from "wrong password".
- Lockout backs off exponentially from five failures, capped at fifteen minutes.
  It is a delay, not a permanent lock, so an attacker cannot lock a known account
  out by guessing at it.
- Password reset always answers "if that address exists, a link is on its way".

### Federated identity

OIDC, SAML 2.0 and LDAP/AD are three implementations of one provider contract.
Claims or directory attributes map to roles through `identity_providers.role_mappings`,
applied at every login, so revoking a group in the directory revokes access here
on next sign-in rather than on next manual review.

## Tokens

- **Access token** — JWT, 15 minutes, signed HS256 (or RS256 with a KMS key in
  larger deployments). Carries user id, organization id, session id.
- **Refresh token** — opaque 256-bit value, HttpOnly + Secure + SameSite=Strict
  cookie scoped to `/api/auth`, 14 days.

Refresh tokens **rotate on every use** and belong to a family. Presenting a token
that has already been rotated means someone is replaying a stolen cookie, so the
entire family is revoked and both parties must log in again. This is the standard
defence and it is why `sessions` carries `family_id` and `parent_session_id`.

## Authorisation

Permissions are dotted verbs — `deployment.apply`, `cluster.read`,
`activity.export`. A grant may hold `*`, a `resource.*` prefix, or an exact verb.
Bindings attach a role to a subject (user or team) at a scope:

```
organization ⊃ project ⊃ cluster ⊃ namespace
```

A grant at a wider scope covers narrower ones; the reverse is never inferred. An
unresolvable scope is a denial, not a pass.

### Built-in roles

| Role | Can |
| --- | --- |
| Owner | everything |
| Admin | everything except transferring ownership |
| Operator | author, dry run, apply, roll back, read activity |
| Developer | author, dry run, read — cannot change a cluster |
| Viewer | read only |

API keys carry their own scope list, intersected with the user's permissions. A
key can never do more than the human it belongs to.

## Cluster access: who the API server thinks you are

Two modes per cluster.

**`shared_credential`** — one stored credential, and this platform decides who
may use it. Simple, works with any cluster, and it makes our permission table
the enforcement boundary: a bug there is a privilege escalation, because the API
server never learns which human is on the other end.

**`impersonate`** — the stored credential is granted `impersonate` on users and
groups and nothing else. Every call is made as the logged-in user and Kubernetes
RBAC decides. Our permissions become a first filter, useful for hiding buttons
and for scoping below what RBAC can express, rather than the only one.

```
platform user ──▶ resolve_cluster_identity() ──▶ Impersonate-User: dana@acme.test
                                                 Impersonate-Group: workbench:operator
                                                 Impersonate-Group: sre
```

The username comes from a per-cluster template (`{{email}}` or `{{username}}`,
optionally prefixed), overridable per user. Groups are the union of the platform
roles, prefixed so an administrator binds `workbench:operator` to a ClusterRole
once, and any groups mapped to the user or to a team they belong to.

Both identities are recorded on every audit row — the platform actor *and* the
impersonated user and groups — so this trail and the API server's own audit log
can be reconciled after an incident.

### The guards, and the cost

- `system:masters` is refused. It is bound to cluster-admin with no way to
  revoke it, so a mapping into it would hand the cluster to anyone with any
  platform role. Refused in Go **and** by a database CHECK constraint, because
  one of the two will eventually be bypassed.
- Impersonation headers are strings in an HTTP request, so a username containing
  a newline is a header injection. Rejected in both places, again.
- Any `system:` username is refused.
- An empty resolved username would silently fall back to the service account —
  the exact failure impersonation exists to prevent — so it is a hard error.
- `CanImpersonate` runs a SelfSubjectAccessReview at connect time, turning a
  confusing 403 on every later request into one clear message at configuration.

The honest cost: a credential that can impersonate anyone is cluster-admin in
the hands of an attacker who can forge an identity inside this process. What it
buys is that a bug in *this* codebase cannot grant more than the person already
had, and that every action is attributed to a human in the cluster's own audit
log.

### Access review

`GET /api/clusters/:id/permissions` runs SelfSubjectAccessReviews and returns
what the caller may actually do. This is what lets the UI grey out a button
honestly. Deciding it locally produces a UI that offers actions the cluster will
refuse, which is worse than not offering them. In `shared_credential` mode the
answer describes the stored credential, and the response says so rather than
presenting it as a statement about the user.

## The audit trail

Every row of `activity_log` carries:

`occurred_at, organization_id, user_id, actor_email, session_id, api_key_id, ip,
user_agent, project_id/slug, cluster_id/slug, namespace, action, target_kind,
target_name, target_id, status, error, old_value, new_value, metadata,
request_id, prev_hash, entry_hash`

Audited actions include: login, failed login, MFA challenge and verification,
logout, refresh-token reuse detection, session revocation, password reset,
email verification, manifest create/update/import/export/download, Git commit and
pull request, cluster connect/update/delete, dry run, apply, rollback, resource
delete, role and role-binding changes, settings changes, API key issue and
revocation, and activity export itself.

Denials are recorded exactly like successes. "Who tried to do what and was
refused" is the more interesting half of an audit trail.

`old_value` and `new_value` pass through `audit.Redact` first: anything under a
known secret path becomes `***`. A kubeconfig has never been written to the log.

### Tamper evidence

`entry_hash = sha256(prev_hash ‖ canonical(row))`. Editing a row breaks every
hash after it. `SELECT * FROM activity_log_verify()` returns the first broken id,
or nothing.

## Transport and headers

`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and a CSP with no `unsafe-eval`. Every response
carries `X-Request-Id`, which is the same id written to the audit row, so a
support ticket resolves to an exact row.

## What this does not do

- No cluster credential ever reaches the browser. The frontend calls the API; the
  API calls the API server.
- The generator half has no credentials at all. Running it standalone is a
  supported deployment.
- Secret manifests are base64, which is encoding, not encryption. The Secret form
  says so on every render. Use SOPS, Sealed Secrets or an external secrets
  operator before committing one.
