import React, { useEffect, useMemo, useState } from 'react';
import { Download, Filter, Search, ShieldAlert } from 'lucide-react';
import type { ActivityEntry } from '../platform/types';
import type { ActivityFilter, PlatformClient } from '../platform/api';

/**
 * The audit screen. Every row is one immutable `activity_log` entry; nothing
 * here can edit one, because the API has no endpoint that could.
 */

const STATUS_STYLE: Record<ActivityEntry['status'], string> = {
  success: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300',
  failure: 'border-rose-400/30 bg-rose-400/10 text-rose-300',
  denied: 'border-amber-400/30 bg-amber-400/10 text-amber-300',
};

function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(entries: ActivityEntry[]): string {
  const columns: (keyof ActivityEntry)[] = [
    'id', 'occurredAt', 'actorEmail', 'sessionId', 'apiKeyId', 'ip', 'userAgent',
    'projectSlug', 'clusterSlug', 'namespace', 'action', 'targetKind', 'targetName',
    'status', 'error', 'oldValue', 'newValue', 'requestId',
  ];
  return [
    columns.join(','),
    ...entries.map((entry) => columns.map((column) => csvCell(entry[column])).join(',')),
  ].join('\n');
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface Props {
  client: PlatformClient;
  canExport: boolean;
}

export function ActivityView({ client, canExport }: Props) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [actors, setActors] = useState<string[]>([]);
  const [range, setRange] = useState<'1h' | '24h' | '7d' | 'all'>('all');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const since = range === 'all'
      ? undefined
      : new Date(Date.now() - { '1h': 3600e3, '24h': 86400e3, '7d': 604800e3 }[range]).toISOString();
    const filter: ActivityFilter = { query, statuses, actions, actors, since, limit: 500 };
    client.listActivity(filter).then((rows) => {
      if (!cancelled) {
        setEntries(rows);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [client, query, statuses, actions, actors, range]);

  const allActions = useMemo(() => [...new Set(entries.map((entry) => entry.action))].sort(), [entries]);
  const allActors = useMemo(() => [...new Set(entries.map((entry) => entry.actorEmail))].sort(), [entries]);

  const grouped = useMemo(() => {
    const days = new Map<string, ActivityEntry[]>();
    entries.forEach((entry) => {
      const key = entry.occurredAt.slice(0, 10);
      const list = days.get(key) ?? [];
      list.push(entry);
      days.set(key, list);
    });
    return [...days.entries()];
  }, [entries]);

  const failures = entries.filter((entry) => entry.status !== 'success').length;

  const toggle = (list: string[], value: string, set: (next: string[]) => void) => {
    set(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  };

  const chip = (selected: boolean) => `rounded-full border px-2.5 py-1 font-mono text-xs transition-colors ${
    selected
      ? 'border-teal-400/50 bg-teal-400/15 text-teal-200'
      : 'border-white/10 bg-white/5 text-slate-400 hover:border-white/25 hover:text-slate-200'
  }`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-3 border-b border-white/10 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search actor, action, target, IP or request id"
              className="w-full rounded-lg border border-white/10 bg-white/5 py-2 pl-9 pr-3 text-sm text-slate-100 placeholder-slate-500 focus:border-teal-400/60 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5">
            {(['1h', '24h', '7d', 'all'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setRange(value)}
                className={`rounded-md px-2.5 py-1.5 font-mono text-xs uppercase transition-colors ${
                  range === value ? 'bg-white/10 text-teal-200' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {value}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((current) => !current)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
              showFilters ? 'border-teal-400/50 text-teal-200' : 'border-white/10 text-slate-300 hover:border-white/25'
            }`}
          >
            <Filter className="h-4 w-4" /> Filters
          </button>
          {canExport && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => download(`activity-${Date.now()}.csv`, toCsv(entries), 'text/csv')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 transition-colors hover:border-teal-400/50 hover:text-teal-200"
              >
                <Download className="h-4 w-4" /> CSV
              </button>
              <button
                type="button"
                onClick={() => download(`activity-${Date.now()}.json`, JSON.stringify(entries, null, 2), 'application/json')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-sm text-slate-300 transition-colors hover:border-teal-400/50 hover:text-teal-200"
              >
                <Download className="h-4 w-4" /> JSON
              </button>
            </div>
          )}
        </div>

        {showFilters && (
          <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-3">
            <div>
              <p className="mb-1.5 font-mono text-xs uppercase tracking-widest text-slate-500">Status</p>
              <div className="flex flex-wrap gap-1.5">
                {['success', 'failure', 'denied'].map((value) => (
                  <button key={value} type="button" onClick={() => toggle(statuses, value, setStatuses)} className={chip(statuses.includes(value))}>
                    {value}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 font-mono text-xs uppercase tracking-widest text-slate-500">Actor</p>
              <div className="flex flex-wrap gap-1.5">
                {allActors.map((value) => (
                  <button key={value} type="button" onClick={() => toggle(actors, value, setActors)} className={chip(actors.includes(value))}>
                    {value}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 font-mono text-xs uppercase tracking-widest text-slate-500">Action</p>
              <div className="flex flex-wrap gap-1.5">
                {allActions.map((value) => (
                  <button key={value} type="button" onClick={() => toggle(actions, value, setActions)} className={chip(actions.includes(value))}>
                    {value}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="flex items-center gap-4 font-mono text-xs uppercase tracking-wider text-slate-500">
          <span>{entries.length} entries</span>
          {failures > 0 && (
            <span className="inline-flex items-center gap-1.5 text-amber-300">
              <ShieldAlert className="h-3.5 w-3.5" /> {failures} failed or denied
            </span>
          )}
          <span className="ml-auto normal-case tracking-normal text-slate-600">append-only · hash chained</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {loading && <p className="py-8 text-center text-sm text-slate-500">Loading…</p>}
        {!loading && entries.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-500">Nothing matches those filters.</p>
        )}
        {grouped.map(([day, rows]) => (
          <section key={day} className="mb-6">
            <h3 className="sticky top-0 z-10 -mx-4 mb-2 bg-slate-950/80 px-4 py-1.5 font-mono text-xs uppercase tracking-widest text-slate-500 backdrop-blur">
              {dayLabel(rows[0].occurredAt)}
            </h3>
            <ol className="relative space-y-1.5 border-l border-white/10 pl-4">
              {rows.map((entry) => (
                <li key={entry.id} className="relative">
                  <span
                    className={`absolute -left-[21px] top-3 h-2 w-2 rounded-full ${
                      entry.status === 'success' ? 'bg-emerald-400' : entry.status === 'failure' ? 'bg-rose-400' : 'bg-amber-400'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                    className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-left transition-colors hover:border-white/20"
                  >
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="font-mono text-xs text-slate-500">{timeLabel(entry.occurredAt)}</span>
                      <span className="font-mono text-sm text-teal-200">{entry.action}</span>
                      <span className={`rounded border px-1.5 py-0.5 font-mono text-xs ${STATUS_STYLE[entry.status]}`}>
                        {entry.status}
                      </span>
                      {entry.targetKind && (
                        <span className="font-mono text-xs text-slate-400">
                          {entry.targetKind}/{entry.targetName}
                        </span>
                      )}
                      <span className="ml-auto truncate text-xs text-slate-500">{entry.actorEmail}</span>
                    </div>
                    {entry.error && <p className="mt-1 text-xs text-rose-300">{entry.error}</p>}
                  </button>

                  {expanded === entry.id && (
                    <dl className="mt-1 grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-lg border border-white/10 bg-black/30 px-3 py-2.5 text-xs sm:grid-cols-2">
                      {[
                        ['Session', entry.sessionId ?? '—'],
                        ['API key', entry.apiKeyId ?? '—'],
                        ['IP', String(entry.ip)],
                        ['User agent', String(entry.userAgent)],
                        ['Project', entry.projectSlug ?? '—'],
                        ['Cluster', entry.clusterSlug ?? '—'],
                        ['Namespace', entry.namespace ?? '—'],
                        ['Request id', String(entry.requestId)],
                      ].map(([label, value]) => (
                        <div key={label} className="flex justify-between gap-3 border-b border-white/5 pb-1">
                          <dt className="font-mono uppercase tracking-wider text-slate-500">{label}</dt>
                          <dd className="truncate text-right font-mono text-slate-300">{value}</dd>
                        </div>
                      ))}
                      {Boolean(entry.oldValue || entry.newValue) && (
                        <div className="sm:col-span-2">
                          <dt className="mb-1 font-mono uppercase tracking-wider text-slate-500">Change</dt>
                          <dd className="space-y-0.5 font-mono">
                            <p className="text-rose-300">- {JSON.stringify(entry.oldValue)}</p>
                            <p className="text-emerald-300">+ {JSON.stringify(entry.newValue)}</p>
                          </dd>
                        </div>
                      )}
                    </dl>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
