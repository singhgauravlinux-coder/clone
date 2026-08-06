-- verify.sql — behavioural tests for the schema. Run against a scratch
-- database after the migrations. Any failure raises and aborts the transaction,
-- so a non-zero psql exit status is the whole result.
--
-- Run as the *owner*: this file seeds data and deliberately tries operations
-- the application role is not allowed to perform.

\set ON_ERROR_STOP on

BEGIN;

-- ── fixtures ───────────────────────────────────────────────────────────────

INSERT INTO organizations (id, slug, name) VALUES
    ('11111111-1111-1111-1111-111111111111', 'acme',   'Acme'),
    ('22222222-2222-2222-2222-222222222222', 'globex', 'Globex');

INSERT INTO users (id, organization_id, email, display_name, password_hash) VALUES
    ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
     'ops@acme.test', 'Acme Ops', '$argon2id$v=19$m=65536,t=3,p=2$c2FsdA$aGFzaA'),
    ('bbbbbbbb-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
     'ops@globex.test', 'Globex Ops', NULL);

INSERT INTO projects (id, organization_id, slug, name) VALUES
    ('cccccccc-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'shop', 'Shop');

INSERT INTO clusters (id, organization_id, slug, name, api_server_url, auth_mode) VALUES
    ('dddddddd-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
     'prod-eu', 'Production EU', 'https://k8s.acme.test:6443', 'service_account');

INSERT INTO applications (id, organization_id, project_id, cluster_id, namespace, name) VALUES
    ('eeeeeeee-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
     'cccccccc-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001', 'production', 'web');

-- ── the same email may exist in two tenants ────────────────────────────────

DO $$
BEGIN
    INSERT INTO users (organization_id, email) VALUES
        ('22222222-2222-2222-2222-222222222222', 'ops@acme.test');
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'email uniqueness must be scoped to the organization';
END;
$$;

-- ── a role binding names a user or a team, never both, never neither ───────

DO $$
BEGIN
    INSERT INTO role_bindings (organization_id, role_id, scope_type)
    VALUES ('11111111-1111-1111-1111-111111111111',
            (SELECT id FROM roles WHERE slug = 'viewer'), 'organization');
    RAISE EXCEPTION 'a role binding with no subject must be rejected';
EXCEPTION WHEN check_violation THEN
    NULL;
END;
$$;

-- ── updated_at maintains itself ────────────────────────────────────────────

-- Note: now() is the transaction timestamp, so the fixture is backdated first.
DO $$
DECLARE
    after_value TIMESTAMPTZ;
BEGIN
    UPDATE projects SET updated_at = now() - INTERVAL '1 day' WHERE slug = 'shop';
    UPDATE projects SET description = 'storefront' WHERE slug = 'shop';
    SELECT updated_at INTO after_value FROM projects WHERE slug = 'shop';
    IF after_value < now() - INTERVAL '1 minute' THEN
        RAISE EXCEPTION 'updated_at trigger did not fire';
    END IF;
END;
$$;

-- ── activity log: append, chain, refuse to change ──────────────────────────

CREATE OR REPLACE FUNCTION test_append_activity(p_action TEXT, p_status TEXT)
RETURNS BIGINT AS $$
DECLARE
    previous BYTEA;
    new_id   BIGINT;
BEGIN
    SELECT entry_hash INTO previous FROM activity_log ORDER BY id DESC LIMIT 1;
    INSERT INTO activity_log (
        organization_id, user_id, actor_email, ip, user_agent,
        project_id, cluster_id, namespace, action, target_kind, target_name,
        status, prev_hash, entry_hash
    ) VALUES (
        '11111111-1111-1111-1111-111111111111',
        'aaaaaaaa-0000-0000-0000-000000000001',
        'ops@acme.test', '203.0.113.7', 'Mozilla/5.0',
        'cccccccc-0000-0000-0000-000000000001',
        'dddddddd-0000-0000-0000-000000000001', 'production',
        p_action, 'Deployment', 'web', p_status,
        previous,
        digest(coalesce(previous, ''::bytea) || convert_to(p_action || p_status, 'UTF8'), 'sha256')
    ) RETURNING id INTO new_id;
    RETURN new_id;
END;
$$ LANGUAGE plpgsql;

SELECT test_append_activity('auth.login', 'success');
SELECT test_append_activity('manifest.create', 'success');
SELECT test_append_activity('deployment.apply', 'failure');

DO $$
BEGIN
    IF (SELECT count(*) FROM activity_log) <> 3 THEN
        RAISE EXCEPTION 'expected three activity rows';
    END IF;
    IF EXISTS (SELECT 1 FROM activity_log_verify()) THEN
        RAISE EXCEPTION 'hash chain should verify on a freshly written log';
    END IF;
END;
$$;

DO $$
BEGIN
    UPDATE activity_log SET status = 'success' WHERE action = 'deployment.apply';
    RAISE EXCEPTION 'activity_log must reject UPDATE';
EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN
        RAISE;
    END IF;
END;
$$;

DO $$
BEGIN
    DELETE FROM activity_log WHERE action = 'auth.login';
    RAISE EXCEPTION 'activity_log must reject DELETE';
EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%append-only%' THEN
        RAISE;
    END IF;
END;
$$;

-- Full text search over the log is what the activity screen filters on.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM activity_log
        WHERE to_tsvector('simple',
            coalesce(actor_email, '') || ' ' || action || ' ' ||
            coalesce(target_kind, '') || ' ' || coalesce(target_name, '') || ' ' ||
            coalesce(error, '')) @@ plainto_tsquery('simple', 'deployment.apply')
    ) THEN
        RAISE EXCEPTION 'activity search index does not match a known action';
    END IF;
END;
$$;

-- ── drift findings are unique per field ────────────────────────────────────

INSERT INTO cluster_resources (id, cluster_id, namespace, api_version, kind, name, application_id)
VALUES ('ffffffff-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-000000000001',
        'production', 'apps/v1', 'Deployment', 'web', 'eeeeeeee-0000-0000-0000-000000000001');

INSERT INTO drift_findings (resource_id, field_path, desired_value, live_value, last_writer)
VALUES ('ffffffff-0000-0000-0000-000000000001', 'spec.replicas', '2'::jsonb, '5'::jsonb, 'kubectl-scale');

DO $$
BEGIN
    INSERT INTO drift_findings (resource_id, field_path, desired_value, live_value)
    VALUES ('ffffffff-0000-0000-0000-000000000001', 'spec.replicas', '2'::jsonb, '7'::jsonb);
    RAISE EXCEPTION 'a field should only have one open drift finding';
EXCEPTION WHEN unique_violation THEN
    NULL;
END;
$$;

-- ── built-in roles are seeded and globally unique ──────────────────────────

DO $$
BEGIN
    IF (SELECT count(*) FROM roles WHERE builtin) <> 5 THEN
        RAISE EXCEPTION 'expected five built-in roles';
    END IF;
    INSERT INTO roles (slug, name, builtin) VALUES ('owner', 'Duplicate', TRUE);
    RAISE EXCEPTION 'built-in role slugs must be unique';
EXCEPTION WHEN unique_violation THEN
    NULL;
END;
$$;

COMMIT;

\echo 'schema verification passed'
