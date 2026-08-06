-- rls.sql — runs as the application role, not the owner, and proves that a
-- query with a forgotten tenant predicate returns nothing rather than someone
-- else's rows. Depends on the fixtures created by verify.sql.

\set ON_ERROR_STOP on

DO $$
BEGIN
    IF current_user <> 'workbench_app' THEN
        RAISE EXCEPTION 'run this file as workbench_app, got %', current_user;
    END IF;
END;
$$;

-- Scope the connection the way the API middleware does.
SET app.organization_id = '11111111-1111-1111-1111-111111111111';

DO $$
DECLARE
    visible INT;
BEGIN
    -- Deliberately no WHERE clause.
    SELECT count(*) INTO visible FROM users;
    IF visible <> 1 THEN
        RAISE EXCEPTION 'expected to see only the one Acme user, saw %', visible;
    END IF;

    SELECT count(*) INTO visible FROM projects;
    IF visible <> 1 THEN
        RAISE EXCEPTION 'expected one visible project, saw %', visible;
    END IF;

    -- Reachable only through clusters, which carry the tenant id.
    SELECT count(*) INTO visible FROM cluster_resources;
    IF visible <> 1 THEN
        RAISE EXCEPTION 'expected one visible cluster resource, saw %', visible;
    END IF;
END;
$$;

-- Writing into another tenant must be refused even with an explicit id.
DO $$
BEGIN
    INSERT INTO projects (organization_id, slug, name)
    VALUES ('22222222-2222-2222-2222-222222222222', 'smuggled', 'Smuggled');
    RAISE EXCEPTION 'cross-tenant insert should have been rejected';
EXCEPTION WHEN insufficient_privilege THEN
    NULL;
END;
$$;

-- Switching the setting switches the view of the world.
SET app.organization_id = '22222222-2222-2222-2222-222222222222';

DO $$
DECLARE
    visible INT;
BEGIN
    SELECT count(*) INTO visible FROM projects;
    IF visible <> 0 THEN
        RAISE EXCEPTION 'Globex should see no Acme projects, saw %', visible;
    END IF;
    SELECT count(*) INTO visible FROM users;
    IF visible <> 2 THEN
        RAISE EXCEPTION 'Globex should see its own two users, saw %', visible;
    END IF;
END;
$$;

-- An unset tenant is a closed door, not an open one.
RESET app.organization_id;

DO $$
DECLARE
    visible INT;
BEGIN
    SELECT count(*) INTO visible FROM users;
    IF visible <> 0 THEN
        RAISE EXCEPTION 'an unscoped connection must see nothing, saw %', visible;
    END IF;
END;
$$;

-- The application role cannot rewrite history: the grant itself is missing.
SET app.organization_id = '11111111-1111-1111-1111-111111111111';

DO $$
BEGIN
    UPDATE activity_log SET status = 'success';
    RAISE EXCEPTION 'workbench_app must not hold UPDATE on activity_log';
EXCEPTION WHEN insufficient_privilege THEN
    NULL;
END;
$$;

DO $$
BEGIN
    DELETE FROM activity_log;
    RAISE EXCEPTION 'workbench_app must not hold DELETE on activity_log';
EXCEPTION WHEN insufficient_privilege THEN
    NULL;
END;
$$;

-- But it can read its own tenant's trail and append to it.
DO $$
DECLARE
    visible INT;
BEGIN
    SELECT count(*) INTO visible FROM activity_log;
    IF visible <> 3 THEN
        RAISE EXCEPTION 'expected three readable log rows, saw %', visible;
    END IF;
    INSERT INTO activity_log (organization_id, action, status, entry_hash)
    VALUES ('11111111-1111-1111-1111-111111111111', 'auth.logout', 'success', '\x00'::bytea);
END;
$$;

\echo 'row level security verification passed'
