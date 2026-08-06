-- 0002_applications_git.sql — the deployment-visualisation layer.
--
-- An application is the unit the topology view draws: a named desired state
-- (manifest version, Helm chart or Git path) bound to one cluster/namespace,
-- plus the live resources that were produced from it. Keeping it separate from
-- `deployments` matters because a deployment is an *event* and an application
-- is a *thing that keeps existing* between events.

BEGIN;

CREATE TABLE applications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id          UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    cluster_id          UUID        NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    namespace           TEXT        NOT NULL,
    name                TEXT        NOT NULL,
    -- Where desired state comes from.
    source_kind         TEXT        NOT NULL DEFAULT 'manifest'
                        CHECK (source_kind IN ('manifest', 'git', 'helm', 'kustomize', 'argocd')),
    manifest_id         UUID        REFERENCES manifests(id) ON DELETE SET NULL,
    git_repository      TEXT,
    git_revision        TEXT,
    git_path            TEXT,
    -- Aggregated from cluster_resources by the reconciler, cached for listing.
    health              TEXT        NOT NULL DEFAULT 'unknown'
                        CHECK (health IN ('unknown', 'healthy', 'progressing', 'degraded', 'suspended', 'missing')),
    sync_status         TEXT        NOT NULL DEFAULT 'unknown'
                        CHECK (sync_status IN ('unknown', 'in_sync', 'out_of_sync')),
    auto_sync           BOOLEAN     NOT NULL DEFAULT FALSE,
    self_heal           BOOLEAN     NOT NULL DEFAULT FALSE,
    prune               BOOLEAN     NOT NULL DEFAULT FALSE,
    current_deployment_id UUID      REFERENCES deployments(id) ON DELETE SET NULL,
    last_synced_at      TIMESTAMPTZ,
    created_by          UUID        REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    UNIQUE (cluster_id, namespace, name)
);
CREATE INDEX applications_project_idx ON applications (project_id) WHERE deleted_at IS NULL;
CREATE INDEX applications_unhealthy_idx
    ON applications (organization_id) WHERE health IN ('degraded', 'missing');

ALTER TABLE deployments
    ADD COLUMN application_id UUID REFERENCES applications(id) ON DELETE SET NULL;
CREATE INDEX deployments_application_idx ON deployments (application_id, started_at DESC);

ALTER TABLE cluster_resources
    ADD COLUMN application_id UUID REFERENCES applications(id) ON DELETE SET NULL,
    -- Parent edge for the topology graph, resolved from ownerReferences.
    ADD COLUMN parent_id      UUID REFERENCES cluster_resources(id) ON DELETE SET NULL,
    ADD COLUMN status_message TEXT,
    ADD COLUMN images         TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN replicas_desired INT,
    ADD COLUMN replicas_ready   INT;
CREATE INDEX cluster_resources_app_idx    ON cluster_resources (application_id);
CREATE INDEX cluster_resources_parent_idx ON cluster_resources (parent_id);

-- Drift is recorded per field rather than as a blob so the UI can render a
-- readable diff and so "who changed this" survives the next reconcile.
CREATE TABLE drift_findings (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    resource_id    UUID        NOT NULL REFERENCES cluster_resources(id) ON DELETE CASCADE,
    field_path     TEXT        NOT NULL,       -- e.g. spec.replicas
    desired_value  JSONB,
    live_value     JSONB,
    -- managedFields tells us which controller last wrote the field.
    last_writer    TEXT,
    detected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at    TIMESTAMPTZ,
    UNIQUE (resource_id, field_path)
);
CREATE INDEX drift_findings_open_idx ON drift_findings (resource_id) WHERE resolved_at IS NULL;

-- Cached events and metric samples. Both are cheap to refetch, so these are a
-- convenience for the timeline rather than a source of truth.
CREATE TABLE resource_events (
    id           BIGSERIAL PRIMARY KEY,
    cluster_id   UUID        NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    resource_id  UUID        REFERENCES cluster_resources(id) ON DELETE CASCADE,
    type         TEXT        NOT NULL CHECK (type IN ('Normal', 'Warning')),
    reason       TEXT        NOT NULL,
    message      TEXT        NOT NULL,
    source       TEXT,
    count        INT         NOT NULL DEFAULT 1,
    first_seen   TIMESTAMPTZ NOT NULL,
    last_seen    TIMESTAMPTZ NOT NULL
);
CREATE INDEX resource_events_resource_idx ON resource_events (resource_id, last_seen DESC);

-- Git side. Every commit the platform makes is recorded with the manifest
-- version it carried, so "what did we push" is answerable without the remote.
CREATE TABLE git_operations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id          UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    manifest_version_id UUID        REFERENCES manifest_versions(id),
    operation           TEXT        NOT NULL CHECK (operation IN ('commit', 'push', 'open_pull_request')),
    repository          TEXT        NOT NULL,
    branch              TEXT        NOT NULL,
    commit_sha          TEXT,
    message             TEXT        NOT NULL DEFAULT '',
    files               TEXT[]      NOT NULL DEFAULT '{}',
    pull_request_url    TEXT,
    status              TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'succeeded', 'failed')),
    error               TEXT,
    performed_by        UUID        REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX git_operations_project_idx ON git_operations (project_id, created_at DESC);

-- Keeps `updated_at` honest without every writer remembering to set it.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    target TEXT;
BEGIN
    FOREACH target IN ARRAY ARRAY[
        'organizations', 'users', 'projects', 'clusters', 'manifests', 'applications'
    ] LOOP
        EXECUTE format(
            'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
            target, target
        );
    END LOOP;
END;
$$;

COMMIT;
