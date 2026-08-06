-- 0003_rls.sql — tenancy isolation enforced by the database, not by hope.
--
-- The API sets `app.organization_id` (and `app.user_id`) on every checked-out
-- connection. Policies below use that value, so a missing WHERE clause in a
-- repository method returns nothing instead of another tenant's rows.
--
-- The application connects as `workbench_app`, which is NOT the table owner and
-- does NOT have BYPASSRLS. Migrations run as the owner.

BEGIN;

CREATE OR REPLACE FUNCTION current_org() RETURNS UUID AS $$
    SELECT NULLIF(current_setting('app.organization_id', TRUE), '')::UUID;
$$ LANGUAGE sql STABLE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'workbench_app') THEN
        CREATE ROLE workbench_app LOGIN;
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO workbench_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO workbench_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO workbench_app;

-- The audit trail is the one table the application may not rewrite. The table
-- trigger already rejects UPDATE and DELETE; revoking the grant means the
-- attempt never even reaches it.
REVOKE UPDATE, DELETE ON activity_log FROM workbench_app;

-- Tables that carry organization_id directly.
DO $$
DECLARE
    target TEXT;
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'users', 'teams', 'projects', 'clusters', 'manifests', 'applications',
        'deployments', 'role_bindings', 'api_keys', 'sessions', 'secret_material',
        'identity_providers', 'git_operations', 'settings'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
        EXECUTE format($p$
            CREATE POLICY %1$I_tenant ON %1$I
            USING (organization_id = current_org())
            WITH CHECK (organization_id = current_org())
        $p$, target);
    END LOOP;
END;
$$;

-- Tables reachable only through a parent that carries the tenant id.
ALTER TABLE namespaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE namespaces FORCE ROW LEVEL SECURITY;
CREATE POLICY namespaces_tenant ON namespaces
    USING (EXISTS (SELECT 1 FROM clusters c WHERE c.id = cluster_id AND c.organization_id = current_org()))
    WITH CHECK (EXISTS (SELECT 1 FROM clusters c WHERE c.id = cluster_id AND c.organization_id = current_org()));

ALTER TABLE cluster_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE cluster_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY cluster_resources_tenant ON cluster_resources
    USING (EXISTS (SELECT 1 FROM clusters c WHERE c.id = cluster_id AND c.organization_id = current_org()))
    WITH CHECK (EXISTS (SELECT 1 FROM clusters c WHERE c.id = cluster_id AND c.organization_id = current_org()));

ALTER TABLE manifest_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE manifest_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY manifest_versions_tenant ON manifest_versions
    USING (EXISTS (SELECT 1 FROM manifests m WHERE m.id = manifest_id AND m.organization_id = current_org()))
    WITH CHECK (EXISTS (SELECT 1 FROM manifests m WHERE m.id = manifest_id AND m.organization_id = current_org()));

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members FORCE ROW LEVEL SECURITY;
CREATE POLICY team_members_tenant ON team_members
    USING (EXISTS (SELECT 1 FROM teams t WHERE t.id = team_id AND t.organization_id = current_org()))
    WITH CHECK (EXISTS (SELECT 1 FROM teams t WHERE t.id = team_id AND t.organization_id = current_org()));

-- The audit trail is readable within the tenant and insertable by anyone whose
-- connection is scoped to that tenant. NULL organization_id covers pre-login
-- events such as a failed password attempt against an unknown address.
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log FORCE ROW LEVEL SECURITY;
CREATE POLICY activity_log_tenant ON activity_log
    FOR SELECT USING (organization_id = current_org());
CREATE POLICY activity_log_insert ON activity_log
    FOR INSERT WITH CHECK (organization_id = current_org() OR organization_id IS NULL);

COMMIT;
