-- 0004_inventory.sql — reading the whole cluster, not just what we deployed.
--
-- Until now `cluster_resources` only held objects that came out of a
-- deployment. The explorer reads everything that is running, including
-- resources this platform has never touched, so the table grows three
-- capabilities: an identity that survives a rename, a record of who owns the
-- object, and a way to tell "gone" from "never seen".

BEGIN;

-- The API server's UID is the only durable identity: a name can be reused, and
-- the same name in the same namespace can be a different object tomorrow.
-- Rows written before this migration may have no UID, so the index is partial.
CREATE UNIQUE INDEX cluster_resources_uid_idx
    ON cluster_resources (cluster_id, uid) WHERE uid IS NOT NULL;

ALTER TABLE cluster_resources
    ADD COLUMN labels           JSONB       NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN annotations      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN resource_version TEXT,
    -- True when this platform's field manager appears in managedFields, i.e.
    -- we applied it rather than merely found it. The distinction drives what
    -- the UI offers: you may not roll back something you never deployed.
    ADD COLUMN managed          BOOLEAN     NOT NULL DEFAULT FALSE,
    -- The last writer, taken from managedFields. Answers "who changed this".
    ADD COLUMN managed_by       TEXT,
    -- All controller owners, kept flat so an orphan is detectable without a
    -- recursive query.
    ADD COLUMN owner_uids       TEXT[]      NOT NULL DEFAULT '{}',
    -- How the parent edge was derived: an ownerReference is authoritative, a
    -- selector or backend match is inferred. The UI styles them differently.
    ADD COLUMN parent_edge      TEXT        CHECK (parent_edge IN ('owner', 'selector', 'backend', 'mount')),
    ADD COLUMN node_name        TEXT,
    ADD COLUMN restarts         INT         NOT NULL DEFAULT 0,
    ADD COLUMN created_at       TIMESTAMPTZ,
    ADD COLUMN first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Set when a sync completes without seeing the object. Soft, not deleted:
    -- "this vanished" is information, and a hard delete throws it away.
    ADD COLUMN disappeared_at   TIMESTAMPTZ;

CREATE INDEX cluster_resources_browse_idx
    ON cluster_resources (cluster_id, namespace, kind, name) WHERE disappeared_at IS NULL;
CREATE INDEX cluster_resources_kind_idx
    ON cluster_resources (cluster_id, kind) WHERE disappeared_at IS NULL;
CREATE INDEX cluster_resources_managed_idx
    ON cluster_resources (cluster_id) WHERE managed AND disappeared_at IS NULL;
-- Label queries are the main filter in the explorer, and jsonb containment on
-- a GIN index is the one that stays fast as a cluster grows.
CREATE INDEX cluster_resources_labels_idx ON cluster_resources USING gin (labels jsonb_path_ops);

-- Discovery is per cluster and changes whenever a CRD is installed, so it is
-- cached rather than assumed. Without this the explorer would re-discover on
-- every page load.
CREATE TABLE cluster_api_resources (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id   UUID        NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    api_group    TEXT        NOT NULL DEFAULT '',
    version      TEXT        NOT NULL,
    kind         TEXT        NOT NULL,
    plural       TEXT        NOT NULL,
    namespaced   BOOLEAN     NOT NULL,
    verbs        TEXT[]      NOT NULL DEFAULT '{}',
    short_names  TEXT[]      NOT NULL DEFAULT '{}',
    categories   TEXT[]      NOT NULL DEFAULT '{}',
    -- Anything outside the well-known Kubernetes groups: a CRD or an
    -- aggregated API.
    custom       BOOLEAN     NOT NULL DEFAULT FALSE,
    -- False when the credential may discover the kind but not list it. Storing
    -- this is what lets the UI say "not visible to this credential" instead of
    -- rendering an empty namespace.
    listable     BOOLEAN     NOT NULL DEFAULT TRUE,
    observed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cluster_id, api_group, version, plural)
);
CREATE INDEX cluster_api_resources_cluster_idx ON cluster_api_resources (cluster_id);

-- One row per inventory read. This is an operational record, not an audit
-- record: it answers "is the explorer's data stale" and "why is this kind
-- missing", which the activity log is the wrong shape for.
CREATE TABLE cluster_syncs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cluster_id      UUID        NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    trigger         TEXT        NOT NULL DEFAULT 'scheduled'
                    CHECK (trigger IN ('scheduled', 'manual', 'watch', 'deployment')),
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    object_count    INT         NOT NULL DEFAULT 0,
    -- Kinds the credential could not list, with the reason. A 403 here is the
    -- normal case for a scoped ServiceAccount, not a failure.
    unreadable      JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- API groups that failed discovery outright, e.g. a metrics server that is
    -- down. Recorded so a partial read is never mistaken for a complete one.
    discovery_errors JSONB      NOT NULL DEFAULT '[]'::jsonb,
    truncated       BOOLEAN     NOT NULL DEFAULT FALSE,
    -- The resourceVersion the watch resumes from. When this ages out of etcd's
    -- window the API server returns 410 and a full re-list is required.
    resume_version  TEXT,
    status          TEXT        NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
    error           TEXT
);
CREATE INDEX cluster_syncs_recent_idx ON cluster_syncs (cluster_id, started_at DESC);

ALTER TABLE clusters
    ADD COLUMN last_sync_id     UUID REFERENCES cluster_syncs(id) ON DELETE SET NULL,
    ADD COLUMN last_synced_at   TIMESTAMPTZ,
    -- Zero disables background syncing for a cluster without disconnecting it,
    -- which is the lever you want when an API server is struggling.
    ADD COLUMN sync_interval_seconds INT NOT NULL DEFAULT 60
        CHECK (sync_interval_seconds >= 0);

-- New tables inherit the tenancy rules. cluster_api_resources and
-- cluster_syncs reach their tenant through clusters, exactly as
-- cluster_resources does.
ALTER TABLE cluster_api_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE cluster_api_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY cluster_api_resources_tenant ON cluster_api_resources
    USING (EXISTS (SELECT 1 FROM clusters c WHERE c.id = cluster_id AND c.organization_id = current_org()))
    WITH CHECK (EXISTS (SELECT 1 FROM clusters c WHERE c.id = cluster_id AND c.organization_id = current_org()));

ALTER TABLE cluster_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cluster_syncs FORCE ROW LEVEL SECURITY;
CREATE POLICY cluster_syncs_tenant ON cluster_syncs
    USING (EXISTS (SELECT 1 FROM clusters c WHERE c.id = cluster_id AND c.organization_id = current_org()))
    WITH CHECK (EXISTS (SELECT 1 FROM clusters c WHERE c.id = cluster_id AND c.organization_id = current_org()));

GRANT SELECT, INSERT, UPDATE, DELETE ON cluster_api_resources, cluster_syncs TO workbench_app;

-- Marks everything not seen by a completed sync as gone, in one statement.
-- Called at the end of a full read; a partial read must not call it, or a
-- namespace the credential lost access to would look like a mass deletion.
CREATE OR REPLACE FUNCTION mark_disappeared(p_cluster_id UUID, p_sync_started TIMESTAMPTZ)
RETURNS INT AS $$
DECLARE
    affected INT;
BEGIN
    UPDATE cluster_resources
       SET disappeared_at = now(),
           health         = 'missing'
     WHERE cluster_id = p_cluster_id
       AND disappeared_at IS NULL
       AND last_seen_at < p_sync_started;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
END;
$$ LANGUAGE plpgsql;

COMMIT;
