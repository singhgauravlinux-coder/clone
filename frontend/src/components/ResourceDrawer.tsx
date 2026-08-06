import React, { useMemo, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import type { MetricSample, ResourceNode } from '../platform/types';
import { health as healthTokens, surface } from '../theme';

/** Inline sparkline. Two series, shared x axis, no library. */
function Sparkline({ samples, series, colour, unit }: {
  samples: MetricSample[];
  series: 'cpu' | 'memory';
  colour: string;
  unit: string;
}) {
  const width = 260;
  const height = 56;
  const values = samples.map((sample) => sample[series]);
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * width;
    const y = height - (value / max) * (height - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const latest = values[values.length - 1] ?? 0;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="font-mono text-xs uppercase tracking-wider text-slate-400">{series}</span>
        <span className="font-mono text-sm text-slate-200">{latest}{unit}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-14 w-full" preserveAspectRatio="none">
        <polyline
          points={`0,${height} ${points.join(' ')} ${width},${height}`}
          fill={colour}
          fillOpacity={0.12}
          stroke="none"
        />
        <polyline points={points.join(' ')} fill="none" stroke={colour} strokeWidth={1.5} />
      </svg>
    </div>
  );
}

function relative(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const TABS = ['Summary', 'Events', 'Logs', 'Metrics', 'Drift', 'Manifest'] as const;
type Tab = typeof TABS[number];

interface Props {
  node: ResourceNode | null;
  onClose: () => void;
  onDelete: (node: ResourceNode) => void;
  canDelete: boolean;
}

export function ResourceDrawer({ node, onClose, onDelete, canDelete }: Props) {
  const [tab, setTab] = useState<Tab>('Summary');
  const [follow, setFollow] = useState(true);
  const driftCount = node?.drift?.length ?? 0;

  const visibleTabs = useMemo(
    () => TABS.filter((name) => {
      if (name === 'Logs') return !!node?.logs?.length;
      if (name === 'Metrics') return !!node?.metrics?.length;
      if (name === 'Drift') return driftCount > 0;
      if (name === 'Manifest') return !!node?.manifest;
      return true;
    }),
    [node, driftCount],
  );

  if (!node) return null;
  const active = visibleTabs.includes(tab) ? tab : 'Summary';

  return (
    <aside className="flex h-full w-full flex-col border-l border-white/10 lg:w-96" style={surface.well}>
      <header className="flex items-start justify-between gap-3 border-b border-white/10 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: healthTokens[node.health].fg, boxShadow: `0 0 8px ${healthTokens[node.health].ring}` }} />
            <span className="font-mono text-xs uppercase tracking-widest text-slate-400">{node.kind}</span>
          </div>
          <h2 className="truncate font-mono text-sm text-slate-100">{node.name}</h2>
          <p className="truncate text-xs text-slate-500">{node.namespace} · {node.apiVersion}</p>
        </div>
        <div className="flex items-center gap-1">
          {canDelete && (
            <button
              type="button"
              onClick={() => onDelete(node)}
              title="Delete this resource"
              className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-rose-500/15 hover:text-rose-300"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <nav className="flex gap-1 overflow-x-auto border-b border-white/10 px-2 py-1.5">
        {visibleTabs.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`shrink-0 rounded-lg px-2.5 py-1 font-mono text-xs uppercase tracking-wider transition-colors ${
              active === name ? 'bg-white/10 text-teal-200' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {name}
            {name === 'Drift' && driftCount > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-400/20 px-1.5 text-amber-300">{driftCount}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-sm">
        {active === 'Summary' && (
          <dl className="space-y-3">
            {[
              ['Health', node.health],
              ['Sync', node.syncStatus.replace('_', ' ')],
              ['Age', relative(node.age)],
              ['Node', node.node],
              ['Replicas', node.replicasDesired !== undefined ? `${node.replicasReady ?? 0} / ${node.replicasDesired}` : undefined],
              ['Restarts', node.restarts ? String(node.restarts) : undefined],
              ['Status', node.message],
            ].filter(([, value]) => value !== undefined && value !== '').map(([label, value]) => (
              <div key={label as string} className="flex items-baseline justify-between gap-4 border-b border-white/5 pb-2">
                <dt className="font-mono text-xs uppercase tracking-wider text-slate-500">{label}</dt>
                <dd className="text-right text-slate-200">{value as string}</dd>
              </div>
            ))}
            {node.images?.length ? (
              <div>
                <dt className="mb-1 font-mono text-xs uppercase tracking-wider text-slate-500">Images</dt>
                {node.images.map((image) => (
                  <dd key={image} className="break-all font-mono text-xs text-teal-200">{image}</dd>
                ))}
              </div>
            ) : null}
          </dl>
        )}

        {active === 'Events' && (
          node.events?.length ? (
            <ul className="space-y-2">
              {node.events.map((event, index) => (
                <li
                  key={index}
                  className={`rounded-lg border px-3 py-2 ${
                    event.type === 'Warning'
                      ? 'border-amber-400/30 bg-amber-400/5'
                      : 'border-white/10 bg-white/5'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className={`font-mono text-xs uppercase tracking-wider ${event.type === 'Warning' ? 'text-amber-300' : 'text-slate-400'}`}>
                      {event.reason}
                    </span>
                    <span className="font-mono text-xs text-slate-500">×{event.count}</span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-slate-300">{event.message}</p>
                </li>
              ))}
            </ul>
          ) : <p className="text-xs text-slate-500">No events in the retention window.</p>
        )}

        {active === 'Logs' && (
          <div>
            <label className="mb-2 flex items-center gap-2 font-mono text-xs uppercase tracking-wider text-slate-400">
              <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} className="accent-teal-400" />
              Follow
            </label>
            <pre className="max-h-full overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs leading-relaxed text-slate-300">
              {(follow ? node.logs!.slice(-40) : node.logs!).join('\n')}
            </pre>
          </div>
        )}

        {active === 'Metrics' && (
          <div className="space-y-5">
            <Sparkline samples={node.metrics!} series="cpu" colour="#2dd4bf" unit="m" />
            <Sparkline samples={node.metrics!} series="memory" colour="#a78bfa" unit="Mi" />
            <p className="text-xs leading-relaxed text-slate-500">
              Last 30 minutes, scraped from metrics-server. Absent values mean the
              metrics API is not installed on this cluster.
            </p>
          </div>
        )}

        {active === 'Drift' && (
          <div className="space-y-3">
            <p className="text-xs leading-relaxed text-slate-400">
              These fields differ from the manifest the platform last applied. The
              writer comes from <span className="font-mono text-slate-300">managedFields</span>.
            </p>
            {node.drift!.map((finding) => (
              <div key={finding.path} className="rounded-lg border border-amber-400/25 bg-amber-400/5 p-3">
                <p className="break-all font-mono text-xs text-amber-200">{finding.path}</p>
                <div className="mt-2 space-y-1 font-mono text-xs">
                  <p className="text-rose-300">- desired: {finding.desired}</p>
                  <p className="text-emerald-300">+ live: {finding.live}</p>
                </div>
                <p className="mt-2 text-xs text-slate-500">last written by {finding.lastWriter}</p>
              </div>
            ))}
          </div>
        )}

        {active === 'Manifest' && (
          <pre className="overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs leading-relaxed text-slate-300">
            {node.manifest}
          </pre>
        )}
      </div>
    </aside>
  );
}
