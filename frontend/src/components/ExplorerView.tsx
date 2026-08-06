import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Boxes, EyeOff, Filter, RefreshCw, Search, ShieldCheck, X,
} from 'lucide-react';
import type { ClusterResource, Health, Inventory } from '../platform/types';
import type { PlatformClient } from '../platform/api';
import { surface } from '../theme';

/**
 * Everything running in a cluster, not only what this platform deployed.
 *
 * Two distinctions drive the whole screen:
 *
 *   managed   — this platform applied it, so rollback and drift are meaningful
 *   observed  — it is simply there, installed by Helm, an operator or a human
 *
 * and, separately, kinds the credential could not list at all. Rendering an
 * empty namespace when the real answer is "you are not allowed to look" is the
 * failure mode this view exists to avoid.
 */

const HEALTH_DOT: Record<Health, string> = {
  healthy: '#2dd4bf',
  progressing: '#38bdf8',
  degraded: '#fb7185',
  suspended: '#94a3b8',
  missing: '#fbbf24',
  // A planned resource has not been applied yet, so it has no live counterpart
  // in the explorer. Included for exhaustiveness, never rendered here.
  planned: '#64748b',
  unknown: '#64748b',
};

function relative(iso: string): string {
  const seconds = Math.max(1, Math.floor((Date.parse('2026-08-04T09:30:00Z') - Date.parse(iso)) / 1000));
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return `${hours}h`;
  return `${Math.floor(seconds / 60)}m`;
}

interface Props {
  client: PlatformClient;
  clusterId: string;
  clusterLabel: string;
  onSelect: (resource: ClusterResource) => void;
  selectedUid?: string;
}

export function ExplorerView({ client, clusterId, clusterLabel, onSelect, selectedUid }: Props) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [namespace, setNamespace] = useState<string>('');
  const [kind, setKind] = useState<string>('');
  const [onlyManaged, setOnlyManaged] = useState(false);
  const [showUnreadable, setShowUnreadable] = useState(true);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setInventory(await client.listInventory(clusterId, { refresh }));
    } catch (failure: any) {
      setError(String(failure?.message ?? failure));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await client.listInventory(clusterId, {});
        if (!cancelled) setInventory(result);
      } catch (failure: any) {
        if (!cancelled) setError(String(failure?.message ?? failure));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [client, clusterId]);

  const objects = inventory?.objects ?? [];

  // Counts come from the unfiltered read so the sidebar does not collapse to
  // the current filter, which would hide where the rest of the cluster is.
  const namespaceCounts = useMemo(() => {
    const counts = new Map<string, number>();
    objects.forEach((object) => {
      const key = object.namespace || '(cluster scoped)';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [objects]);

  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    objects.forEach((object) => counts.set(object.kind, (counts.get(object.kind) ?? 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [objects]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return objects.filter((object) => {
      if (namespace && (object.namespace || '(cluster scoped)') !== namespace) return false;
      if (kind && object.kind !== kind) return false;
      if (onlyManaged && !object.managed) return false;
      if (!needle) return true;
      const haystack = [
        object.kind, object.name, object.namespace, object.message, object.managedBy,
        ...(object.images ?? []),
        ...Object.entries(object.labels ?? {}).map(([key, value]) => `${key}=${value}`),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(needle);
    });
  }, [objects, search, namespace, kind, onlyManaged]);

  const managedCount = objects.filter((object) => object.managed).length;
  const unhealthy = filtered.filter((object) => object.health === 'degraded' || object.health === 'missing');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-slate-800 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2">
            <Boxes className="h-4 w-4 text-teal-300" />
            <h2 className="text-sm text-slate-100">{clusterLabel}</h2>
          </div>

          <span className="font-mono text-xs text-slate-500">
            {objects.length} objects · {managedCount} managed here · {objects.length - managedCount} observed
          </span>

          <div className="ml-auto flex items-center gap-2">
            <div style={surface.chip} className="flex items-center gap-2 rounded-lg px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="name, image, label, node"
                className="w-44 bg-transparent font-mono text-xs text-slate-100 placeholder-slate-500 focus:outline-none"
              />
              {search && (
                <button type="button" onClick={() => setSearch('')} aria-label="Clear search">
                  <X className="h-3 w-3 text-slate-500" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => setOnlyManaged(!onlyManaged)}
              style={surface.chip}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-xs uppercase tracking-wider transition ${
                onlyManaged ? 'text-teal-200' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Filter className="h-3.5 w-3.5" />
              managed only
            </button>

            <button
              type="button"
              onClick={() => load(true)}
              style={surface.chip}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-slate-200 transition hover:text-teal-200"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Refresh</span>
            </button>
          </div>
        </div>

        {inventory && (
          <p className="mt-2 font-mono text-xs text-slate-500">
            read {relative(inventory.takenAt)} ago in {inventory.durationMs}ms
            {inventory.truncated && <span className="ml-2 text-amber-300">truncated — narrow the filter</span>}
          </p>
        )}
      </header>

      {/* Partial reads are stated, never hidden. An empty namespace and a
          namespace you cannot see look identical unless something says so. */}
      {inventory && showUnreadable && (inventory.unreadable.length > 0 || inventory.discoveryFailures.length > 0) && (
        <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2">
          <div className="flex items-start gap-2">
            <EyeOff className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-xs uppercase tracking-wider text-amber-300">
                this read is incomplete
              </p>
              <ul className="mt-1 space-y-0.5">
                {inventory.unreadable.map((entry, index) => (
                  <li key={index} className="truncate text-xs text-amber-100/80">
                    <span className="font-mono">{entry.group ? `${entry.group}/` : ''}{entry.kind}</span>
                    {entry.namespace ? ` in ${entry.namespace}` : ''} — {entry.forbidden ? 'not permitted for this credential' : entry.reason}
                  </li>
                ))}
                {inventory.discoveryFailures.map((entry, index) => (
                  <li key={`d-${index}`} className="truncate text-xs text-amber-100/80">{entry}</li>
                ))}
              </ul>
            </div>
            <button type="button" onClick={() => setShowUnreadable(false)} aria-label="Dismiss">
              <X className="h-3.5 w-3.5 text-amber-300/60" />
            </button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-52 shrink-0 overflow-y-auto border-r border-slate-800 py-3 lg:block">
          <Section title="namespace">
            <FilterRow label="all" count={objects.length} active={namespace === ''} onClick={() => setNamespace('')} />
            {namespaceCounts.map(([name, count]) => (
              <FilterRow
                key={name}
                label={name}
                count={count}
                active={namespace === name}
                onClick={() => setNamespace(namespace === name ? '' : name)}
              />
            ))}
          </Section>
          <Section title="kind">
            <FilterRow label="all" count={objects.length} active={kind === ''} onClick={() => setKind('')} />
            {kindCounts.map(([name, count]) => (
              <FilterRow
                key={name}
                label={name}
                count={count}
                active={kind === name}
                onClick={() => setKind(kind === name ? '' : name)}
              />
            ))}
          </Section>
        </aside>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {error && (
            <div className="m-4 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
              <p className="text-sm text-rose-100">{error}</p>
            </div>
          )}

          {!error && loading && !inventory && (
            <p className="p-4 font-mono text-xs uppercase tracking-widest text-slate-500">reading cluster…</p>
          )}

          {inventory && (
            <>
              {unhealthy.length > 0 && (
                <p className="px-4 pt-3 font-mono text-xs text-rose-300">
                  {unhealthy.length} of {filtered.length} shown are degraded or missing
                </p>
              )}
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 bg-slate-950/80 backdrop-blur">
                  <tr className="border-b border-slate-800 text-left">
                    {['', 'kind', 'name', 'namespace', 'status', 'owner', 'age'].map((heading, index) => (
                      <th key={index} className="px-3 py-2 font-mono text-xs uppercase tracking-wider text-slate-500">
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((object) => (
                    <tr
                      key={object.uid}
                      onClick={() => onSelect(object)}
                      className={`cursor-pointer border-b border-slate-800/60 transition-colors ${
                        object.uid === selectedUid ? 'bg-white/10' : 'hover:bg-white/5'
                      }`}
                    >
                      <td className="w-6 px-3 py-2">
                        <span
                          className="inline-block h-2 w-2 rounded-full"
                          style={{ background: HEALTH_DOT[object.health] }}
                          title={object.health}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-400">{object.kind}</td>
                      <td className="max-w-xs truncate px-3 py-2 text-slate-100">
                        {object.name}
                        {object.managed && (
                          <ShieldCheck className="ml-1.5 inline h-3 w-3 text-teal-300" aria-label="deployed from this platform" />
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-400">
                        {object.namespace || <span className="text-slate-600">cluster</span>}
                      </td>
                      <td className="max-w-xs truncate px-3 py-2 text-xs text-slate-400">
                        {object.replicasDesired !== undefined
                          ? `${object.replicasReady ?? 0}/${object.replicasDesired}`
                          : ''}
                        {object.message ? ` ${object.message}` : ''}
                        {object.restarts ? <span className="ml-1 text-rose-300">{object.restarts} restarts</span> : null}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">{object.managedBy ?? '—'}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">{relative(object.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {filtered.length === 0 && (
                <p className="p-4 text-sm text-slate-500">
                  Nothing matches. {objects.length} objects were read, so this is a filter, not an empty cluster.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3 className="px-4 pb-1.5 font-mono text-xs uppercase tracking-widest text-slate-500">{title}</h3>
      {children}
    </div>
  );
}

function FilterRow({ label, count, active, onClick }: {
  label: string; count: number; active: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between border-l-2 px-4 py-1 text-left transition-colors ${
        active ? 'border-teal-400 bg-white/5 text-teal-200' : 'border-transparent text-slate-300 hover:bg-white/5'
      }`}
    >
      <span className="truncate text-xs">{label}</span>
      <span className="ml-2 font-mono text-xs text-slate-500">{count}</span>
    </button>
  );
}
