-- inventory.sql — behaviour of the full-cluster inventory tables.
-- Run after verify.sql, which creates the tenant, cluster and application
-- fixtures this file reuses.

\set ON_ERROR_STOP on

BEGIN;

-- ── UID is the identity that survives a rename ─────────────────────────────

UPDATE cluster_resources
   SET uid = 'uid-deployment-web', managed = TRUE, managed_by = 'manifest-workbench',
       labels = '{"app":"web","tier":"frontend"}'::jsonb
 WHERE name = 'web' AND kind = 'Deployment';

INSERT INTO cluster_resources (cluster_id, namespace, api_version, kind, name, uid, labels, managed_by)
VALUES ('dddddddd-0000-0000-0000-000000000001', 'production', 'v1', 'Service', 'web',
        'uid-service-web', '{"app":"web"}'::jsonb, 'kubectl-client-side-apply');

DO $$
BEGIN
    INSERT INTO cluster_resources (cluster_id, namespace, api_version, kind, name, uid)
    VALUES ('dddddddd-0000-0000-0000-000000000001', 'production', 'v1', 'ConfigMap', 'other',
            'uid-service-web');
    RAISE EXCEPTION 'the same UID must not appear twice in one cluster';
EXCEPTION WHEN unique_violation THEN
    NULL;
END;
$$;

-- The same UID in a *different* cluster is fine: they are different objects.
INSERT INTO clusters (id, organization_id, slug, name, api_server_url, auth_mode)
VALUES ('dddddddd-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
        'staging', 'Staging', 'https://staging.acme.test:6443', 'kubeconfig');

INSERT INTO cluster_resources (cluster_id, namespace, api_version, kind, name, uid)
VALUES ('dddddddd-0000-0000-0000-000000000002', 'staging', 'v1', 'Service', 'web', 'uid-service-web');

-- Rows with no UID predate the inventory work; the partial index tolerates them.
INSERT INTO cluster_resources (cluster_id, namespace, api_version, kind, name)
VALUES ('dddddddd-0000-0000-0000-000000000002', 'staging', 'v1', 'ConfigMap', 'legacy-a'),
       ('dddddddd-0000-0000-0000-000000000002', 'staging', 'v1', 'ConfigMap', 'legacy-b');

-- ── managed vs merely observed ─────────────────────────────────────────────

DO $$
DECLARE
    managed_count INT;
    total_count   INT;
BEGIN
    SELECT count(*) FILTER (WHERE managed), count(*)
      INTO managed_count, total_count
      FROM cluster_resources
     WHERE cluster_id = 'dddddddd-0000-0000-0000-000000000001';

    IF managed_count <> 1 OR total_count <> 2 THEN
        RAISE EXCEPTION 'expected one managed of two objects, got % of %', managed_count, total_count;
    END IF;
END;
$$;

-- ── label search uses the GIN index path ───────────────────────────────────

DO $$
DECLARE
    found INT;
BEGIN
    SELECT count(*) INTO found
      FROM cluster_resources
     WHERE cluster_id = 'dddddddd-0000-0000-0000-000000000001'
       AND labels @> '{"app":"web"}'::jsonb;
    IF found <> 2 THEN
        RAISE EXCEPTION 'label containment should match both web objects, matched %', found;
    END IF;

    SELECT count(*) INTO found
      FROM cluster_resources
     WHERE labels @> '{"tier":"frontend"}'::jsonb;
    IF found <> 1 THEN
        RAISE EXCEPTION 'a narrower label should match one object, matched %', found;
    END IF;
END;
$$;

-- ── a completed sync marks what it did not see ─────────────────────────────

DO $$
DECLARE
    sync_started TIMESTAMPTZ := now();
    gone         INT;
BEGIN
    -- Backdate everything, then "see" only the Deployment during this sync.
    UPDATE cluster_resources SET last_seen_at = sync_started - INTERVAL '1 hour'
     WHERE cluster_id = 'dddddddd-0000-0000-0000-000000000001';
    UPDATE cluster_resources SET last_seen_at = now()
     WHERE cluster_id = 'dddddddd-0000-0000-0000-000000000001' AND kind = 'Deployment';

    gone := mark_disappeared('dddddddd-0000-0000-0000-000000000001', sync_started);
    IF gone <> 1 THEN
        RAISE EXCEPTION 'exactly the unseen Service should disappear, got %', gone;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM cluster_resources
         WHERE uid = 'uid-service-web'
           AND cluster_id = 'dddddddd-0000-0000-0000-000000000001'
           AND disappeared_at IS NOT NULL
           AND health = 'missing'
    ) THEN
        RAISE EXCEPTION 'a disappeared object should be marked missing, not deleted';
    END IF;

    IF EXISTS (
        SELECT 1 FROM cluster_resources
         WHERE uid = 'uid-deployment-web' AND disappeared_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'an object seen during the sync must not be marked gone';
    END IF;

    -- Another cluster's objects are never touched by one cluster's sync.
    IF EXISTS (
        SELECT 1 FROM cluster_resources
         WHERE cluster_id = 'dddddddd-0000-0000-0000-000000000002' AND disappeared_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'mark_disappeared leaked across clusters';
    END IF;

    -- Running it again changes nothing: the rows are already marked.
    IF mark_disappeared('dddddddd-0000-0000-0000-000000000001', sync_started) <> 0 THEN
        RAISE EXCEPTION 'mark_disappeared should be idempotent';
    END IF;
END;
$$;

-- ── discovery cache ────────────────────────────────────────────────────────

INSERT INTO cluster_api_resources (cluster_id, api_group, version, kind, plural, namespaced, verbs, custom)
VALUES
    ('dddddddd-0000-0000-0000-000000000001', 'apps', 'v1', 'Deployment', 'deployments', TRUE,
     ARRAY['get','list','watch','create','update','patch','delete'], FALSE),
    ('dddddddd-0000-0000-0000-000000000001', '', 'v1', 'Pod', 'pods', TRUE,
     ARRAY['get','list','watch'], FALSE),
    -- A CRD, discovered without the platform knowing about it in advance.
    ('dddddddd-0000-0000-0000-000000000001', 'argoproj.io', 'v1alpha1', 'Application', 'applications', TRUE,
     ARRAY['get','list','watch'], TRUE);

DO $$
BEGIN
    IF (SELECT count(*) FROM cluster_api_resources WHERE custom) <> 1 THEN
        RAISE EXCEPTION 'the CRD should be flagged as custom';
    END IF;
    -- Re-discovering the same kind must not duplicate it.
    INSERT INTO cluster_api_resources (cluster_id, api_group, version, kind, plural, namespaced)
    VALUES ('dddddddd-0000-0000-0000-000000000001', 'apps', 'v1', 'Deployment', 'deployments', TRUE);
    RAISE EXCEPTION 'discovery entries must be unique per cluster, group, version and plural';
EXCEPTION WHEN unique_violation THEN
    NULL;
END;
$$;

-- ── a sync records what it could not read ──────────────────────────────────

INSERT INTO cluster_syncs (
    cluster_id, trigger, finished_at, object_count, unreadable, discovery_errors, status, resume_version
) VALUES (
    'dddddddd-0000-0000-0000-000000000001', 'manual', now(), 412,
    '[{"kind":"Secret","namespace":"kube-system","reason":"forbidden","forbidden":true}]'::jsonb,
    '["metrics.k8s.io/v1beta1: the server is currently unable to handle the request"]'::jsonb,
    'partial', '84213311'
);

DO $$
BEGIN
    -- A forbidden kind is a normal outcome for a scoped credential, and the
    -- sync that hit one is "partial", never "failed".
    IF NOT EXISTS (
        SELECT 1 FROM cluster_syncs
         WHERE status = 'partial'
           AND unreadable @> '[{"forbidden":true}]'::jsonb
           AND jsonb_array_length(discovery_errors) = 1
    ) THEN
        RAISE EXCEPTION 'a partial sync should retain both the forbidden kinds and the discovery errors';
    END IF;

    INSERT INTO cluster_syncs (cluster_id, status)
    VALUES ('dddddddd-0000-0000-0000-000000000001', 'nonsense');
    RAISE EXCEPTION 'sync status is constrained';
EXCEPTION WHEN check_violation THEN
    NULL;
END;
$$;

DO $$
BEGIN
    UPDATE clusters SET sync_interval_seconds = -5
     WHERE id = 'dddddddd-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'a negative sync interval is not a valid way to disable syncing';
EXCEPTION WHEN check_violation THEN
    NULL;
END;
$$;

-- Zero is the supported way to pause syncing without disconnecting a cluster.
UPDATE clusters SET sync_interval_seconds = 0
 WHERE id = 'dddddddd-0000-0000-0000-000000000001';

COMMIT;

\echo 'inventory verification passed'
