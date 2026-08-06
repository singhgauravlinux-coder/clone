# API

Base path `/api`. JSON in, JSON out. Every response carries `X-Request-Id`, which
is the `request_id` on the matching audit row.

Authentication is a bearer access token or an API key:

```
Authorization: Bearer eyJhbGci...        # access token, 15 minutes
Authorization: Bearer mw_a1b2c3_9f8e...  # API key or personal access token
```

## Generation — no database, no cluster

Available in both deployment modes. When auth is configured these require a
valid caller; when it is not, they are open.

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| GET | `/resources` | – | catalogue grouped for the sidebar |
| GET | `/resources/:id` | – | field schema plus a default model |
| POST | `/generate` | `{resourceId, model}` | `{files, issues}` |
| POST | `/validate` | `{resourceId, model}` | `{valid, issues}` |
| POST | `/lint` | `{yaml}` | `{valid, issues}` — no resource id needed |
| POST | `/import` | `{yaml}` | `{resourceId, model, ignored, files, issues}` |

`/lint` is the CI endpoint: pipe a manifest in, fail the build on any `error`
level issue.

```bash
curl -sS localhost:8080/api/lint \
  --json "{\"yaml\": $(jq -Rs . < deployment.yaml)}" \
  | jq -e '.valid'
```

## Authentication

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/auth/login` | `{email, password}` | returns `{accessToken, expiresAt}` or `{mfaRequired, mfaChallengeId}` |
| POST | `/auth/login/mfa` | `{challengeId, code}` | completes the login |
| POST | `/auth/refresh` | – | reads the `mw_refresh` cookie, rotates it |
| POST | `/auth/logout` | – | revokes the current session |
| POST | `/auth/password/forgot` | `{email}` | always `202`, regardless of existence |
| POST | `/auth/password/reset` | `{token, password}` | revokes all other sessions |
| POST | `/auth/email/verify` | `{token}` | |
| GET | `/auth/sessions` | – | active sessions for the caller |
| DELETE | `/auth/sessions/:id` | – | revoke one |

Refresh tokens are delivered as an HttpOnly, Secure, SameSite=Strict cookie
scoped to `/api/auth`. They are never in a response body.

## Platform

All of these require an authenticated caller and are scoped to that caller's
organization by row level security, not by a query parameter.

| Method | Path | Permission | Returns |
| --- | --- | --- | --- |
| GET | `/bootstrap` | – | user, org, projects, teams, clusters, sessions |
| GET | `/clusters` | `cluster.read` | connected clusters with health |
| POST | `/clusters` | `cluster.create` | connect via kubeconfig or service account |
| GET | `/applications` | `deployment.read` | applications with rolled-up health |
| GET | `/applications/:id` | `deployment.read` | one application with its resource tree; `?refresh=true` re-reads the cluster |
| GET | `/applications/:id/deployments` | `deployment.read` | revision history |
| POST | `/deployments/apply` | `deployment.apply` or `deployment.dry_run` | apply result plus a server-side diff |
| POST | `/applications/:id/rollback` | `deployment.rollback` | `{revision}` |
| DELETE | `/applications/:id/resources/:rid` | `deployment.delete` | `204` |

### Apply

```jsonc
POST /api/deployments/apply
{
  "applicationId": "…",
  "clusterId": "…",
  "namespace": "production",
  "dryRun": true,
  "message": "bump storefront to 2.14.0",
  "files": [{"path": "web-deployment.yaml", "content": "apiVersion: apps/v1\n…"}]
}
```

Dry run and apply are the same code path with a different field manager option,
so a dry run exercises real admission webhooks and real server-side validation.
They are separate permissions: `deployment.dry_run` proves a change is valid
without granting the right to make it.

## Activity

| Method | Path | Permission |
| --- | --- | --- |
| GET | `/activity` | `activity.read` |
| GET | `/activity/export?format=csv\|json` | `activity.export` |

Filters, all repeatable where plural: `query`, `actions`, `statuses`, `actors`,
`clusters`, `since`, `until` (RFC 3339), `limit`.

```bash
curl -sS -H "Authorization: Bearer $TOKEN" \
  'localhost:8080/api/activity?actions=deployment.apply&statuses=failure&since=2026-08-01T00:00:00Z'
```

There is no endpoint that edits or deletes an activity row. The port that the
handlers depend on has no such method, the application database role has no such
grant, and the table has a trigger that rejects both.

## Errors

```jsonc
{"error": "forbidden", "permission": "deployment.apply"}
```

| Status | Meaning |
| --- | --- |
| 400 | malformed request |
| 401 | no or invalid credentials |
| 403 | authenticated but not permitted; the missing permission is named |
| 404 | not found, or not visible to this tenant — deliberately the same answer |
| 422 | the request was understood but the cluster or the manifest rejected it |
| 429 | login throttled |
