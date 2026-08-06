-- 0001_init.sql — baseline schema.
--
-- Design notes that are load bearing:
--   * Tenancy is org -> team -> project -> cluster/namespace binding. Every
--     row that a user can reach carries organization_id so row level security
--     has one predicate to enforce.
--   * Credentials never live in this database in plaintext. Cluster kubeconfigs
--     and service account tokens are stored as ciphertext produced by the KMS
--     envelope in `secret_material`; the DEK id is kept, the DEK is not.
--   * activity_log is append-only and hash chained. No UPDATE or DELETE grant
--     is issued on it, and a trigger rejects both, so an operator with table
--     access still cannot rewrite history without breaking the chain.

BEGIN;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ── tenancy ────────────────────────────────────────────────────────────────

CREATE TABLE organizations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug         CITEXT      NOT NULL UNIQUE,
    name         TEXT        NOT NULL,
    settings     JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at   TIMESTAMPTZ
);

CREATE TABLE users (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id       UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email                 CITEXT      NOT NULL,
    username              CITEXT,
    display_name          TEXT        NOT NULL DEFAULT '',
    -- argon2id encoded string; NULL for users that only federate in
    password_hash         TEXT,
    password_changed_at   TIMESTAMPTZ,
    email_verified_at     TIMESTAMPTZ,
    mfa_enabled           BOOLEAN     NOT NULL DEFAULT FALSE,
    mfa_secret_ciphertext BYTEA,
    mfa_recovery_hashes   TEXT[]      NOT NULL DEFAULT '{}',
    status                TEXT        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'invited', 'suspended', 'locked')),
    failed_login_count    INT         NOT NULL DEFAULT 0,
    locked_until          TIMESTAMPTZ,
    last_login_at         TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at            TIMESTAMPTZ,
    UNIQUE (organization_id, email)
);
CREATE UNIQUE INDEX users_org_username_key
    ON users (organization_id, username) WHERE username IS NOT NULL;

-- External identities: OIDC, SAML 2.0, LDAP/AD. One user may hold several.
CREATE TABLE identities (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider         TEXT        NOT NULL CHECK (provider IN ('local', 'oidc', 'saml', 'ldap')),
    provider_key     TEXT        NOT NULL,   -- issuer or directory URL
    subject          TEXT        NOT NULL,   -- sub / NameID / distinguished name
    claims           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    linked_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at     TIMESTAMPTZ,
    UNIQUE (provider, provider_key, subject)
);

CREATE TABLE identity_providers (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind             TEXT        NOT NULL CHECK (kind IN ('oidc', 'saml', 'ldap')),
    name             TEXT        NOT NULL,
    enabled          BOOLEAN     NOT NULL DEFAULT TRUE,
    config           JSONB       NOT NULL,            -- endpoints, client id, attribute map
    secret_id        UUID,                            -- -> secret_material
    -- Claim or attribute -> role mappings applied at login.
    role_mappings    JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, name)
);

CREATE TABLE teams (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug             CITEXT      NOT NULL,
    name             TEXT        NOT NULL,
    description      TEXT        NOT NULL DEFAULT '',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, slug)
);

CREATE TABLE projects (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug             CITEXT      NOT NULL,
    name             TEXT        NOT NULL,
    description      TEXT        NOT NULL DEFAULT '',
    git_repository   TEXT,
    git_branch       TEXT        NOT NULL DEFAULT 'main',
    git_path_prefix  TEXT        NOT NULL DEFAULT '',
    git_secret_id    UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,
    UNIQUE (organization_id, slug)
);

-- ── access control ─────────────────────────────────────────────────────────

CREATE TABLE roles (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID        REFERENCES organizations(id) ON DELETE CASCADE,
    slug             CITEXT      NOT NULL,
    name             TEXT        NOT NULL,
    -- Verb strings such as 'cluster.apply', 'project.read', 'activity.export'.
    permissions      TEXT[]      NOT NULL DEFAULT '{}',
    builtin          BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Built-in roles have organization_id NULL and must stay globally unique.
CREATE UNIQUE INDEX roles_builtin_slug_key ON roles (slug) WHERE organization_id IS NULL;
CREATE UNIQUE INDEX roles_org_slug_key ON roles (organization_id, slug) WHERE organization_id IS NOT NULL;

-- A grant binds a subject (user or team) to a role at a scope. scope_type
-- narrows how far the role reaches; scope_id points at the row.
CREATE TABLE role_bindings (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role_id          UUID        NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    user_id          UUID        REFERENCES users(id) ON DELETE CASCADE,
    team_id          UUID        REFERENCES teams(id) ON DELETE CASCADE,
    scope_type       TEXT        NOT NULL CHECK (scope_type IN ('organization', 'project', 'cluster', 'namespace')),
    scope_id         UUID,
    scope_namespace  TEXT,
    granted_by       UUID        REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((user_id IS NULL) <> (team_id IS NULL))
);
CREATE INDEX role_bindings_user_idx ON role_bindings (user_id);
CREATE INDEX role_bindings_team_idx ON role_bindings (team_id);

CREATE TABLE team_members (
    team_id     UUID        NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_by    UUID        REFERENCES users(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, user_id)
);

-- ── sessions, tokens, keys ─────────────────────────────────────────────────

CREATE TABLE sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    -- SHA-256 of the refresh token. The token itself is never stored.
    refresh_token_hash  BYTEA       NOT NULL UNIQUE,
    -- Rotation chain: a reused parent is treated as theft and kills the family.
    parent_session_id   UUID        REFERENCES sessions(id) ON DELETE SET NULL,
    family_id           UUID        NOT NULL,
    ip                  INET,
    user_agent          TEXT,
    mfa_satisfied       BOOLEAN     NOT NULL DEFAULT FALSE,
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    revoked_reason      TEXT
);
CREATE INDEX sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE api_keys (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name             TEXT        NOT NULL,
    -- Presented as "mw_<prefix>_<secret>". Prefix is indexed, secret is hashed.
    token_prefix     TEXT        NOT NULL UNIQUE,
    token_hash       BYTEA       NOT NULL,
    scopes           TEXT[]      NOT NULL DEFAULT '{}',
    last_used_at     TIMESTAMPTZ,
    expires_at       TIMESTAMPTZ,
    revoked_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Single use tokens for verification, password reset and invitations.
CREATE TABLE auth_tokens (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose      TEXT        NOT NULL CHECK (purpose IN ('email_verify', 'password_reset', 'invite', 'mfa_enrol')),
    token_hash   BYTEA       NOT NULL UNIQUE,
    expires_at   TIMESTAMPTZ NOT NULL,
    consumed_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose) WHERE consumed_at IS NULL;

-- Envelope encrypted blobs: kubeconfigs, SA tokens, Git deploy keys, IdP secrets.
CREATE TABLE secret_material (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind               TEXT        NOT NULL CHECK (kind IN ('kubeconfig', 'service_account', 'git_key', 'idp_secret')),
    ciphertext         BYTEA       NOT NULL,
    nonce              BYTEA       NOT NULL,
    key_id             TEXT        NOT NULL,   -- KMS key that wrapped the DEK
    wrapped_dek        BYTEA       NOT NULL,
    created_by         UUID        REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotated_at         TIMESTAMPTZ
);

-- ── clusters and workloads ─────────────────────────────────────────────────

CREATE TABLE clusters (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    slug               CITEXT      NOT NULL,
    name               TEXT        NOT NULL,
    api_server_url     TEXT        NOT NULL,
    auth_mode          TEXT        NOT NULL CHECK (auth_mode IN ('kubeconfig', 'service_account')),
    credential_id      UUID        REFERENCES secret_material(id),
    ca_bundle          BYTEA,
    insecure_skip_tls  BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Last observed connectivity, refreshed by the health poller.
    status             TEXT        NOT NULL DEFAULT 'unknown'
                       CHECK (status IN ('unknown', 'healthy', 'degraded', 'unreachable')),
    kubernetes_version TEXT,
    node_count         INT,
    last_checked_at    TIMESTAMPTZ,
    labels             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_by         UUID        REFERENCES users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at         TIMESTAMPTZ,
    UNIQUE (organization_id, slug)
);

CREATE TABLE namespaces (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id   UUID        NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    name         TEXT        NOT NULL,
    project_id   UUID        REFERENCES projects(id) ON DELETE SET NULL,
    labels       JSONB       NOT NULL DEFAULT '{}'::jsonb,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cluster_id, name)
);

-- A manifest is the saved output of the generator. Content is versioned so an
-- Apply can always name the exact bytes it sent.
CREATE TABLE manifests (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id       UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name             TEXT        NOT NULL,
    resource_type    TEXT        NOT NULL,       -- registry definition id
    -- The form model, so the GUI can reopen exactly what the user built.
    form_model       JSONB       NOT NULL,
    created_by       UUID        REFERENCES users(id),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at       TIMESTAMPTZ,
    UNIQUE (project_id, name)
);

CREATE TABLE manifest_versions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    manifest_id   UUID        NOT NULL REFERENCES manifests(id) ON DELETE CASCADE,
    version       INT         NOT NULL,
    files         JSONB       NOT NULL,       -- [{path, content, language}]
    content_hash  BYTEA       NOT NULL,       -- sha256 over the rendered files
    form_model    JSONB       NOT NULL,
    message       TEXT        NOT NULL DEFAULT '',
    created_by    UUID        REFERENCES users(id),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (manifest_id, version)
);

-- One row per apply attempt against one cluster/namespace.
CREATE TABLE deployments (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id           UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cluster_id           UUID        NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    namespace            TEXT        NOT NULL,
    manifest_version_id  UUID        REFERENCES manifest_versions(id),
    previous_deployment_id UUID      REFERENCES deployments(id),
    strategy             TEXT        NOT NULL DEFAULT 'server_side_apply'
                         CHECK (strategy IN ('server_side_apply', 'create', 'replace', 'delete')),
    dry_run              BOOLEAN     NOT NULL DEFAULT FALSE,
    status               TEXT        NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'rolled_back')),
    -- Server response per object, so a partial failure is inspectable.
    results              JSONB       NOT NULL DEFAULT '[]'::jsonb,
    error                TEXT,
    started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at          TIMESTAMPTZ,
    triggered_by         UUID        REFERENCES users(id)
);
CREATE INDEX deployments_cluster_ns_idx ON deployments (cluster_id, namespace, started_at DESC);

-- Live inventory: what the platform believes exists in a cluster, and whether
-- it still matches the manifest that produced it.
CREATE TABLE cluster_resources (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id        UUID        NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    namespace         TEXT        NOT NULL DEFAULT '',
    api_version       TEXT        NOT NULL,
    kind              TEXT        NOT NULL,
    name              TEXT        NOT NULL,
    uid               TEXT,
    owner_uid         TEXT,
    deployment_id     UUID        REFERENCES deployments(id) ON DELETE SET NULL,
    health            TEXT        NOT NULL DEFAULT 'unknown'
                      CHECK (health IN ('unknown', 'healthy', 'progressing', 'degraded', 'suspended', 'missing')),
    sync_status       TEXT        NOT NULL DEFAULT 'unknown'
                      CHECK (sync_status IN ('unknown', 'in_sync', 'out_of_sync')),
    -- Normalised live spec, used to compute drift against the desired spec.
    live_hash         BYTEA,
    desired_hash      BYTEA,
    drift_summary     JSONB,
    observed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cluster_id, namespace, api_version, kind, name)
);
CREATE INDEX cluster_resources_drift_idx
    ON cluster_resources (cluster_id) WHERE sync_status = 'out_of_sync';

CREATE TABLE settings (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID        REFERENCES organizations(id) ON DELETE CASCADE,
    key              TEXT        NOT NULL,
    value            JSONB       NOT NULL,
    updated_by       UUID        REFERENCES users(id),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, key)
);

-- ── activity log ───────────────────────────────────────────────────────────

CREATE TABLE activity_log (
    id                BIGSERIAL PRIMARY KEY,
    occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    organization_id   UUID        REFERENCES organizations(id) ON DELETE SET NULL,
    -- Actor identity is denormalised on purpose: the log must stay readable
    -- after the user row is deleted.
    user_id           UUID,
    actor_email       TEXT,
    session_id        UUID,
    api_key_id        UUID,
    ip                INET,
    user_agent        TEXT,
    -- Where it happened.
    project_id        UUID,
    project_slug      TEXT,
    cluster_id        UUID,
    cluster_slug      TEXT,
    namespace         TEXT,
    -- What happened. Dotted verb, e.g. 'auth.login', 'deployment.apply'.
    action            TEXT        NOT NULL,
    target_kind       TEXT,
    target_name       TEXT,
    target_id         UUID,
    status            TEXT        NOT NULL CHECK (status IN ('success', 'failure', 'denied')),
    error             TEXT,
    -- Redacted before write: values under known secret paths become '***'.
    old_value         JSONB,
    new_value         JSONB,
    metadata          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    request_id        TEXT,
    -- Tamper evidence: sha256(prev_hash || canonical(row)).
    prev_hash         BYTEA,
    entry_hash        BYTEA       NOT NULL
);

CREATE INDEX activity_log_time_idx        ON activity_log (occurred_at DESC);
CREATE INDEX activity_log_org_time_idx    ON activity_log (organization_id, occurred_at DESC);
CREATE INDEX activity_log_user_idx        ON activity_log (user_id, occurred_at DESC);
CREATE INDEX activity_log_action_idx      ON activity_log (action, occurred_at DESC);
CREATE INDEX activity_log_cluster_idx     ON activity_log (cluster_id, occurred_at DESC);
CREATE INDEX activity_log_target_idx      ON activity_log (target_kind, target_name);
CREATE INDEX activity_log_search_idx      ON activity_log
    USING gin (to_tsvector('simple',
        coalesce(actor_email, '') || ' ' || action || ' ' ||
        coalesce(target_kind, '') || ' ' || coalesce(target_name, '') || ' ' ||
        coalesce(error, '')));

-- Append only. Rejecting at the table level means a bug in application code
-- cannot quietly rewrite an entry.
CREATE OR REPLACE FUNCTION activity_log_is_append_only() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'activity_log is append-only (attempted %)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER activity_log_no_update
    BEFORE UPDATE OR DELETE ON activity_log
    FOR EACH ROW EXECUTE FUNCTION activity_log_is_append_only();

-- Verify the chain from a starting id. Returns the first broken row, if any.
CREATE OR REPLACE FUNCTION activity_log_verify(from_id BIGINT DEFAULT 0)
RETURNS TABLE (broken_id BIGINT, expected BYTEA, actual BYTEA) AS $$
    SELECT curr.id, prev.entry_hash, curr.prev_hash
    FROM activity_log curr
    JOIN activity_log prev ON prev.id = curr.id - 1
    WHERE curr.id > from_id
      AND (curr.prev_hash IS DISTINCT FROM prev.entry_hash)
    ORDER BY curr.id
    LIMIT 1;
$$ LANGUAGE sql STABLE;

-- Monthly partitioning is expected in production; create the parent as a
-- regular table first and convert with pg_partman once volume justifies it.

-- ── seed roles ─────────────────────────────────────────────────────────────

INSERT INTO roles (slug, name, permissions, builtin) VALUES
    ('owner',    'Owner',    ARRAY['*'], TRUE),
    ('admin',    'Admin',    ARRAY[
        'organization.read','organization.update','user.*','team.*','project.*',
        'cluster.*','manifest.*','deployment.*','activity.read','activity.export','settings.*'
    ], TRUE),
    ('operator', 'Operator', ARRAY[
        'project.read','cluster.read','manifest.*','deployment.apply','deployment.read',
        'deployment.rollback','deployment.dry_run','activity.read'
    ], TRUE),
    ('developer','Developer',ARRAY[
        'project.read','cluster.read','manifest.create','manifest.read','manifest.update',
        'deployment.dry_run','deployment.read','activity.read'
    ], TRUE),
    ('viewer',   'Viewer',   ARRAY['project.read','cluster.read','manifest.read','deployment.read','activity.read'], TRUE);

COMMIT;
