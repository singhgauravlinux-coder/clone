-- 0005_impersonation.sql — moving the enforcement boundary into the API server.
--
-- Until now a cluster held one credential and this platform decided who could
-- use it. That makes a bug in our permission table a privilege escalation,
-- because the API server never learns which human is on the other end.
--
-- In `impersonate` mode the stored credential is granted `impersonate` on users
-- and groups and nothing else. Every call is made as the logged-in user and
-- Kubernetes RBAC decides. Our own permissions become a first filter, not the
-- only one.

BEGIN;

ALTER TABLE clusters
    ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'shared_credential'
        CHECK (access_mode IN ('shared_credential', 'impersonate')),

    -- How a platform user becomes a Kubernetes username. {{email}} and
    -- {{username}} are substituted. Kept as a template rather than hard-coded
    -- because clusters differ: an OIDC-backed cluster usually wants the raw
    -- email, while others prefix to keep platform users distinguishable.
    ADD COLUMN impersonation_username_template TEXT NOT NULL DEFAULT '{{email}}',

    -- Platform roles are mapped onto RBAC groups with this prefix, so binding
    -- `workbench:operator` to a ClusterRole is all an administrator has to do.
    ADD COLUMN impersonation_group_prefix TEXT NOT NULL DEFAULT 'workbench:',

    -- Serving the explorer from warm informers instead of listing per request.
    ADD COLUMN cache_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN cache_idle_ttl_seconds INT NOT NULL DEFAULT 900
        CHECK (cache_idle_ttl_seconds BETWEEN 60 AND 86400),

    -- Verified at connect time by a SelfSubjectAccessReview. A cluster in
    -- impersonate mode whose credential cannot impersonate would fail every
    -- request; catching it here turns that into one clear error.
    ADD COLUMN impersonation_verified_at TIMESTAMPTZ;

-- A username template that resolves to nothing would silently fall back to the
-- service account, which is the exact failure impersonation exists to prevent.
ALTER TABLE clusters
    ADD CONSTRAINT clusters_impersonation_template_present
    CHECK (
        access_mode <> 'impersonate'
        OR impersonation_username_template ~ '\{\{(email|username)\}\}'
    );

-- Extra groups for a subject on one cluster, beyond the ones derived from
-- platform roles. This is how an existing directory group is reused: map the
-- platform team onto the RBAC group the cluster already binds.
CREATE TABLE cluster_identity_mappings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id      UUID        NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    -- Exactly one subject, mirroring role_bindings.
    user_id         UUID        REFERENCES users(id) ON DELETE CASCADE,
    team_id         UUID        REFERENCES teams(id) ON DELETE CASCADE,
    -- Overrides the username template for this subject. Rare, but needed when
    -- one person's cluster identity does not match their platform email.
    kubernetes_username TEXT,
    kubernetes_groups   TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by      UUID REFERENCES users(id),

    CONSTRAINT cluster_identity_mappings_one_subject CHECK (
        (user_id IS NOT NULL AND team_id IS NULL)
        OR (user_id IS NULL AND team_id IS NOT NULL)
    ),
    -- system:masters is bound to cluster-admin with no way to revoke it, so a
    -- mapping into it would hand the cluster to anyone with any platform role.
    -- Refused in the database as well as in Go: two places, because one of them
    -- will eventually be bypassed.
    CONSTRAINT cluster_identity_mappings_no_masters CHECK (
        NOT ('system:masters' = ANY (kubernetes_groups))
    ),
    -- Impersonation headers are strings in an HTTP request; a newline in one is
    -- a header injection.
    CONSTRAINT cluster_identity_mappings_username_clean CHECK (
        kubernetes_username IS NULL OR kubernetes_username !~ '[\r\n]'
    )
);

CREATE UNIQUE INDEX cluster_identity_mappings_user_idx
    ON cluster_identity_mappings (cluster_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX cluster_identity_mappings_team_idx
    ON cluster_identity_mappings (cluster_id, team_id) WHERE team_id IS NOT NULL;

ALTER TABLE cluster_identity_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE cluster_identity_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY cluster_identity_mappings_tenant ON cluster_identity_mappings
    USING (EXISTS (SELECT 1 FROM clusters c WHERE c.id = cluster_id AND c.organization_id = current_org()))
    WITH CHECK (EXISTS (SELECT 1 FROM clusters c WHERE c.id = cluster_id AND c.organization_id = current_org()));

GRANT SELECT, INSERT, UPDATE, DELETE ON cluster_identity_mappings TO workbench_app;

-- Impersonated calls are attributed twice: once in the API server's own audit
-- log, and once here. Recording the identity we sent is what lets the two be
-- reconciled after an incident.
ALTER TABLE activity_log
    ADD COLUMN impersonated_user   TEXT,
    ADD COLUMN impersonated_groups TEXT[];

-- Resolves the identity to send for one user on one cluster: the template or an
-- override for the username, and the union of role-derived and mapped groups.
CREATE OR REPLACE FUNCTION resolve_cluster_identity(p_cluster_id UUID, p_user_id UUID)
RETURNS TABLE (kubernetes_username TEXT, kubernetes_groups TEXT[]) AS $$
DECLARE
    v_template TEXT;
    v_prefix   TEXT;
    v_email    TEXT;
    v_override TEXT;
    v_groups   TEXT[];
BEGIN
    SELECT c.impersonation_username_template, c.impersonation_group_prefix
      INTO v_template, v_prefix
      FROM clusters c WHERE c.id = p_cluster_id;

    SELECT u.email INTO v_email FROM users u WHERE u.id = p_user_id;
    IF v_email IS NULL THEN
        RAISE EXCEPTION 'no such user %', p_user_id;
    END IF;

    SELECT m.kubernetes_username INTO v_override
      FROM cluster_identity_mappings m
     WHERE m.cluster_id = p_cluster_id AND m.user_id = p_user_id;

    -- Groups from platform roles, plus any mapped directly to the user or to a
    -- team they belong to.
    SELECT coalesce(array_agg(DISTINCT g), '{}') INTO v_groups FROM (
        SELECT v_prefix || r.slug AS g
          FROM role_bindings rb
          JOIN roles r ON r.id = rb.role_id
         WHERE rb.user_id = p_user_id
        UNION
        SELECT unnest(m.kubernetes_groups)
          FROM cluster_identity_mappings m
         WHERE m.cluster_id = p_cluster_id AND m.user_id = p_user_id
        UNION
        SELECT unnest(m.kubernetes_groups)
          FROM cluster_identity_mappings m
          JOIN team_members tm ON tm.team_id = m.team_id
         WHERE m.cluster_id = p_cluster_id AND tm.user_id = p_user_id
    ) AS resolved(g);

    RETURN QUERY SELECT
        coalesce(v_override, replace(replace(v_template, '{{email}}', v_email),
                                     '{{username}}', split_part(v_email, '@', 1))),
        v_groups;
END;
$$ LANGUAGE plpgsql STABLE;

COMMIT;
