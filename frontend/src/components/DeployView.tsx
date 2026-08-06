import React, { useEffect, useMemo, useState } from 'react';
import { GitBranch, History, Loader2, Play, RefreshCw, RotateCcw, Search, Zap } from 'lucide-react';
import type { Application, DeploymentRecord, Health, ResourceNode } from '../platform/types';
import type { PlatformClient } from '../platform/api';
import { liveTopology } from '../core/topology';
import { TopologyView } from './TopologyView';
import { ResourceDrawer } from './ResourceDrawer';
import { cls, health as healthTokens, surface } from '../theme';

/**
 * The operations half of the product: what is actually running, how healthy it
 * is, what drifted, and the three verbs that change it — dry run, sync, roll
 * back. The graph is the same component the authoring view uses; only the
 * source of the nodes differs.
 */

const SOURCE_LABEL: Record<Application['sourceKind'], string> = {
  manifest: 'Manifest',
  git: 'Git',
  helm: 'Helm',
  kustomize: 'Kustomize',
  argocd: 'Argo CD',
};

function HealthDot({ health }: { health: Health }) {
  return (
    <span
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ background: healthTokens[health].fg, boxShadow: `0 0 8px ${healthTokens[health].ring}` }}
    />
  );
}

function since(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 172800) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

interface Props {
  client: PlatformClient;
  applications: Application[];
  selectedId: string;
  onSelectApplication: (id: string) => void;
  canDeploy: boolean;
  onToast: (tone: 'ok' | 'warn', message: string) => void;
}

export function DeployView({
  client, applications, selectedId, onSelectApplication, canDeploy, onToast,
}: Props) {
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<DeploymentRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [listQuery, setListQuery] = useState('');

  const application = applications.find((app) => app.id === selectedId) ?? applications[0];
  const topology = useMemo(() => (application ? liveTopology(application) : null), [application]);

  useEffect(() => {
    setInspectedId(null);
    if (!application) return undefined;
    let cancelled = false;
    client.listDeployments(application.id).then((rows) => {
      if (!cancelled) setHistory(rows);
    });
    return () => { cancelled = true; };
  }, [client, application]);

  if (!application || !topology) {
    return <p className="p-8 text-center text-sm text-slate-500">No applications are registered yet.</p>;
  }

  const inspected: ResourceNode | null =
    application.resources.find((node) => node.id === inspectedId) ?? null;

  const run = async (label: string, task: () => Promise<string>) => {
    setBusy(label);
    try {
      onToast('ok', await task());
    } catch (error) {
      onToast('warn', `${label} failed: ${(error as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const driftCount = application.resources.reduce((total, node) => total + (node.drift?.length ?? 0), 0);
  const filtered = applications.filter((app) => {
    const needle = listQuery.trim().toLowerCase();
    return !needle || app.name.toLowerCase().includes(needle) || app.namespace.toLowerCase().includes(needle);
  });

  return (
    <div className="relative flex h-full min-h-0">
      <div className="hidden w-64 shrink-0 flex-col border-r border-white/10 md:flex">
        <div className="border-b border-white/10 p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              value={listQuery}
              onChange={(event) => setListQuery(event.target.value)}
              placeholder="Filter applications"
              className={`${cls.input} py-1.5 pl-8 pr-2 text-xs focus:ring-teal-400/40`}
              style={surface.input}
            />
          </div>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto p-2">
          {filtered.map((app) => (
            <li key={app.id}>
              <button
                type="button"
                onClick={() => onSelectApplication(app.id)}
                className="mb-1.5 w-full rounded-xl px-3 py-2.5 text-left transition hover:bg-white/5"
                style={app.id === application.id ? surface.chip : undefined}
              >
                <div className="flex items-center gap-2">
                  <HealthDot health={app.health} />
                  <span className="truncate font-mono text-sm text-slate-100">{app.name}</span>
                </div>
                <p className="mt-1 truncate text-xs text-slate-500">
                  {app.namespace} · {SOURCE_LABEL[app.sourceKind]}
                </p>
                {app.syncStatus === 'out_of_sync' && (
                  <span className="mt-1.5 inline-block rounded border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 font-mono text-xs text-amber-300">
                    drifted
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
          <select
            value={application.id}
            onChange={(event) => onSelectApplication(event.target.value)}
            className="rounded-lg px-2 py-1.5 text-sm text-slate-100 outline-none md:hidden"
            style={surface.input}
          >
            {applications.map((app) => (
              <option key={app.id} value={app.id} className="bg-slate-900">{app.name}</option>
            ))}
          </select>

          <span className="flex items-center gap-2 font-mono text-sm text-slate-200">
            <HealthDot health={application.health} />
            {application.name}
          </span>

          {driftCount > 0 && (
            <span className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-2 py-1 font-mono text-xs text-amber-300">
              {driftCount} drifted {driftCount === 1 ? 'field' : 'fields'}
            </span>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => run('Refresh', async () => {
                await client.refreshApplication(application.id);
                return 'Refreshed live state';
              })}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 transition hover:text-white"
              style={surface.chip}
            >
              {busy === 'Refresh' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setShowHistory((current) => !current)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition ${
                showHistory ? 'text-teal-200' : 'text-slate-300 hover:text-white'
              }`}
              style={surface.chip}
            >
              <History className="h-3.5 w-3.5" /> History
            </button>
            {canDeploy && (
              <>
                <button
                  type="button"
                  onClick={() => run('Dry run', async () => {
                    const result = await client.apply({
                      applicationId: application.id, files: [], dryRun: true, message: 'dry run from topology',
                    });
                    return `Dry run complete — ${result.deployment.results.length} objects, nothing sent`;
                  })}
                  className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-slate-300 transition hover:text-teal-200"
                  style={surface.chip}
                >
                  {busy === 'Dry run' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                  Dry run
                </button>
                <button
                  type="button"
                  onClick={() => run('Sync', async () => {
                    await client.apply({
                      applicationId: application.id, files: [], dryRun: false, message: 'sync from topology',
                    });
                    setHistory(await client.listDeployments(application.id));
                    return `Synced ${application.name}`;
                  })}
                  className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition"
                  style={surface.primary}
                >
                  {busy === 'Sync' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                  Sync
                </button>
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-b border-white/10 px-3 py-2 font-mono text-xs text-slate-500">
          <span className={application.syncStatus === 'out_of_sync' ? 'text-amber-300' : ''}>
            {application.syncStatus.replace('_', ' ')}
          </span>
          <span>rev {application.revisionCount}</span>
          <span>synced {since(application.lastSyncedAt)}</span>
          <span>{application.namespace}</span>
          {application.gitRepository && (
            <span className="flex min-w-0 items-center gap-1.5">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="truncate">{application.gitRepository}@{application.gitRevision}</span>
            </span>
          )}
          {application.autoSync && <span className="text-teal-300">auto-sync</span>}
          {application.selfHeal && <span className="text-teal-300">self-heal</span>}
          {application.prune && <span className="text-teal-300">prune</span>}
        </div>

        <div className="relative min-h-0 flex-1">
          <TopologyView
            topology={topology}
            live
            onInspect={(node) => setInspectedId(node ? node.id : null)}
          />

          {showHistory && (
            <div className="absolute inset-y-0 left-0 w-full max-w-sm overflow-y-auto border-r border-white/10 p-3" style={surface.well}>
              <h3 className={`${cls.eyebrow} mb-2`}>Deployment history</h3>
              {history.length === 0 && <p className="text-xs text-slate-500">No deployments recorded.</p>}
              <ul className="space-y-2">
                {history.map((record) => (
                  <li key={record.id} className="rounded-xl p-3" style={surface.glass}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm text-slate-100">rev {record.revision}</span>
                      <span
                        className={`font-mono text-xs ${
                          record.status === 'succeeded' ? 'text-teal-300'
                            : record.status === 'failed' ? 'text-rose-300' : 'text-sky-300'
                        }`}
                      >
                        {record.status}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">{record.message}</p>
                    <p className="mt-1 font-mono text-xs text-slate-600">
                      {record.triggeredBy} · {since(record.startedAt)}{record.dryRun ? ' · dry run' : ''}
                    </p>
                    {record.results.some((result) => result.error) && (
                      <p className="mt-1.5 rounded border border-rose-400/30 bg-rose-400/10 px-2 py-1 text-xs text-rose-300">
                        {record.results.find((result) => result.error)?.error}
                      </p>
                    )}
                    {canDeploy && record.status === 'succeeded' && !record.dryRun && (
                      <button
                        type="button"
                        onClick={() => run('Rollback', async () => {
                          await client.rollback(application.id, record.revision);
                          setHistory(await client.listDeployments(application.id));
                          return `Rolled back to revision ${record.revision}`;
                        })}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs text-slate-300 transition hover:text-amber-200"
                        style={surface.chip}
                      >
                        <RotateCcw className="h-3 w-3" /> Roll back here
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {inspected && (
        <div className="absolute inset-y-0 right-0 z-20 w-full max-w-sm lg:relative lg:inset-auto lg:z-auto lg:w-96">
          <ResourceDrawer
            node={inspected}
            onClose={() => setInspectedId(null)}
            canDelete={canDeploy}
            onDelete={(node) => run('Delete', async () => {
              await client.deleteResource(application.id, node.id);
              setInspectedId(null);
              return `Deleted ${node.kind}/${node.name}`;
            })}
          />
        </div>
      )}
    </div>
  );
}
