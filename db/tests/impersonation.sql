-- impersonation.sql — the rules that decide who a cluster call is made as.
-- Runs after verify.sql, whose tenant, user and cluster fixtures it reuses.

\set ON_ERROR_STOP on

BEGIN;

-- ── a cluster cannot enter impersonate mode without a usable template ──────

DO $$
BEGIN
    UPDATE clusters
       SET access_mode = 'impersonate', impersonation_username_template = 'static-user'
     WHERE id = 'dddddddd-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'a template that resolves to a constant must be rejected';
EXCEPTION WHEN check_violation THEN
    NULL;
END;
$$;

UPDATE clusters
   SET access_mode = 'impersonate',
       impersonation_username_template = '{{email}}',
       impersonation_group_prefix = 'workbench:'
 WHERE id = 'dddddddd-0000-0000-0000-000000000001';

-- ── the username comes from the template, groups from platform roles ───────

INSERT INTO role_bindings (organization_id, role_id, user_id, scope_type)
VALUES ('11111111-1111-1111-1111-111111111111',
        (SELECT id FROM roles WHERE slug = 'operator'),
        'aaaaaaaa-0000-0000-0000-000000000001', 'organization');

DO $$
DECLARE
    resolved RECORD;
BEGIN
    SELECT * INTO resolved
      FROM resolve_cluster_identity('dddddddd-0000-0000-0000-000000000001',
                                    'aaaaaaaa-0000-0000-0000-000000000001');

    IF resolved.kubernetes_username <> 'ops@acme.test' THEN
        RAISE EXCEPTION 'expected the email as the username, got %', resolved.kubernetes_username;
    END IF;
    IF NOT ('workbench:operator' = ANY (resolved.kubernetes_groups)) THEN
        RAISE EXCEPTION 'the platform role should become a prefixed group, got %', resolved.kubernetes_groups;
    END IF;
END;
$$;

-- The {{username}} form drops the domain, for clusters whose identity provider
-- issues bare usernames.
UPDATE clusters SET impersonation_username_template = 'oidc:{{username}}'
 WHERE id = 'dddddddd-0000-0000-0000-000000000001';

DO $$
DECLARE
    resolved RECORD;
BEGIN
    SELECT * INTO resolved
      FROM resolve_cluster_identity('dddddddd-0000-0000-0000-000000000001',
                                    'aaaaaaaa-0000-0000-0000-000000000001');
    IF resolved.kubernetes_username <> 'oidc:ops' THEN
        RAISE EXCEPTION 'expected the local part, got %', resolved.kubernetes_username;
    END IF;
END;
$$;

UPDATE clusters SET impersonation_username_template = '{{email}}'
 WHERE id = 'dddddddd-0000-0000-0000-000000000001';

-- ── an explicit mapping overrides the template and adds groups ─────────────

INSERT INTO cluster_identity_mappings (cluster_id, user_id, kubernetes_username, kubernetes_groups)
VALUES ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
        'dana.okafor', ARRAY['sre', 'oncall']);

DO $$
DECLARE
    resolved RECORD;
BEGIN
    SELECT * INTO resolved
      FROM resolve_cluster_identity('dddddddd-0000-0000-0000-000000000001',
                                    'aaaaaaaa-0000-0000-0000-000000000001');

    IF resolved.kubernetes_username <> 'dana.okafor' THEN
        RAISE EXCEPTION 'an override should beat the template, got %', resolved.kubernetes_username;
    END IF;
    -- The mapping adds to the role-derived groups; it does not replace them.
    IF NOT ('sre' = ANY (resolved.kubernetes_groups))
       OR NOT ('workbench:operator' = ANY (resolved.kubernetes_groups)) THEN
        RAISE EXCEPTION 'expected both mapped and role groups, got %', resolved.kubernetes_groups;
    END IF;
END;
$$;

-- ── team membership contributes groups ─────────────────────────────────────

INSERT INTO teams (id, organization_id, slug, name)
VALUES ('99999999-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'sre', 'SRE');
INSERT INTO team_members (team_id, user_id)
VALUES ('99999999-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO cluster_identity_mappings (cluster_id, team_id, kubernetes_groups)
VALUES ('dddddddd-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000001',
        ARRAY['platform-admins']);

DO $$
DECLARE
    resolved RECORD;
BEGIN
    SELECT * INTO resolved
      FROM resolve_cluster_identity('dddddddd-0000-0000-0000-000000000001',
                                    'aaaaaaaa-0000-0000-0000-000000000001');
    IF NOT ('platform-admins' = ANY (resolved.kubernetes_groups)) THEN
        RAISE EXCEPTION 'a team mapping should reach its members, got %', resolved.kubernetes_groups;
    END IF;
END;
$$;

-- A user in no team and with no mapping still resolves, with only their role
-- groups. Returning nothing here would make the caller fall back to the service
-- account, which is the failure this whole file exists to prevent.
DO $$
DECLARE
    resolved RECORD;
BEGIN
    SELECT * INTO resolved
      FROM resolve_cluster_identity('dddddddd-0000-0000-0000-000000000001',
                                    'bbbbbbbb-0000-0000-0000-000000000002');
    IF resolved.kubernetes_username IS NULL OR resolved.kubernetes_username = '' THEN
        RAISE EXCEPTION 'every user must resolve to a username';
    END IF;
END;
$$;

-- ── the escalation guards ──────────────────────────────────────────────────

DO $$
BEGIN
    INSERT INTO cluster_identity_mappings (cluster_id, user_id, kubernetes_groups)
    VALUES ('dddddddd-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
            ARRAY['system:masters']);
    RAISE EXCEPTION 'mapping into system:masters must be refused';
EXCEPTION WHEN check_violation THEN
    NULL;
END;
$$;

DO $$
BEGIN
    INSERT INTO cluster_identity_mappings (cluster_id, user_id, kubernetes_username)
    VALUES ('dddddddd-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001',
            E'admin\nX-Remote-Group: system:masters');
    RAISE EXCEPTION 'a newline in a username is a header injection and must be refused';
EXCEPTION WHEN check_violation THEN
    NULL;
END;
$$;

DO $$
BEGIN
    INSERT INTO cluster_identity_mappings (cluster_id, kubernetes_groups)
    VALUES ('dddddddd-0000-0000-0000-000000000002', ARRAY['sre']);
    RAISE EXCEPTION 'a mapping with no subject must be refused';
EXCEPTION WHEN check_violation THEN
    NULL;
END;
$$;

DO $$
BEGIN
    INSERT INTO cluster_identity_mappings (cluster_id, user_id, kubernetes_groups)
    VALUES ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001',
            ARRAY['duplicate']);
    RAISE EXCEPTION 'one mapping per user per cluster';
EXCEPTION WHEN unique_violation THEN
    NULL;
END;
$$;

-- ── the audit trail records who we acted as ────────────────────────────────

INSERT INTO activity_log (
    organization_id, user_id, actor_email, action, status,
    cluster_id, namespace, target_kind, target_name,
    impersonated_user, impersonated_groups, entry_hash
) VALUES (
    '11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
    'ops@acme.test', 'deployment.apply', 'success',
    'dddddddd-0000-0000-0000-000000000001', 'production', 'Deployment', 'web',
    'dana.okafor', ARRAY['workbench:operator', 'sre'], '\x01'::bytea
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM activity_log
         WHERE impersonated_user = 'dana.okafor'
           AND 'sre' = ANY (impersonated_groups)
    ) THEN
        RAISE EXCEPTION 'the identity sent to the cluster must be recorded alongside the actor';
    END IF;
END;
$$;

-- ── cache settings are bounded ─────────────────────────────────────────────

DO $$
BEGIN
    UPDATE clusters SET cache_idle_ttl_seconds = 5
     WHERE id = 'dddddddd-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'an idle TTL below a minute would evict caches faster than they warm';
EXCEPTION WHEN check_violation THEN
    NULL;
END;
$$;

COMMIT;

\echo 'impersonation verification passed'
