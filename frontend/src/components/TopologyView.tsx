import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Crosshair, Layers, Maximize2, Minus, Plus, Search, X } from 'lucide-react';
import type { TopoNode, Topology } from '../core/topology';
import { NODE_SIZE } from '../core/topology';
import { cls, health as healthColors, surface, sync as syncColors } from '../theme';

const KIND_ABBREV: Record<string, string> = {
  Application: 'app',
  Deployment: 'deploy',
  StatefulSet: 'sts',
  DaemonSet: 'ds',
  ReplicaSet: 'rs',
  Pod: 'pod',
  Service: 'svc',
  Ingress: 'ing',
  ConfigMap: 'cm',
  Secret: 'sec',
  PersistentVolumeClaim: 'pvc',
  HorizontalPodAutoscaler: 'hpa',
  ServiceAccount: 'sa',
  Role: 'role',
  ClusterRole: 'crole',
  RoleBinding: 'rb',
  ClusterRoleBinding: 'crb',
  Job: 'job',
  CronJob: 'cron',
  Kustomization: 'kust',
};

interface Props {
  topology: Topology;
  live: boolean;
  onInspect?: (node: TopoNode | null) => void;
}

export function TopologyView({ topology, live, onInspect }: Props) {
  const [zoom, setZoom] = useState(0.9);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [showDerived, setShowDerived] = useState(true);
  const dragging = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  const kinds = useMemo(() => {
    const set = new Set(topology.nodes.map((node) => node.kind));
    return ['all', ...[...set].sort()];
  }, [topology]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return topology.nodes.filter((node) => {
      if (!showDerived && node.derived) return false;
      if (kindFilter !== 'all' && node.kind !== kindFilter) return false;
      if (!needle) return true;
      return `${node.kind} ${node.name} ${node.namespace ?? ''}`.toLowerCase().includes(needle);
    });
  }, [topology, query, kindFilter, showDerived]);

  const visibleIds = useMemo(() => new Set(visible.map((node) => node.id)), [visible]);
  const dimmed = query.trim() !== '' || kindFilter !== 'all' || !showDerived;

  const byId = useMemo(() => new Map(topology.nodes.map((node) => [node.id, node])), [topology]);
  const selectedNode = selected ? byId.get(selected) ?? null : null;

  const select = useCallback((node: TopoNode | null) => {
    setSelected(node?.id ?? null);
    onInspect?.(node);
  }, [onInspect]);

  const fit = () => {
    setZoom(0.9);
    setPan({ x: 0, y: 0 });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-500" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search resources"
            style={surface.input}
            className={`${cls.input} pl-8 focus:ring-teal-500`}
          />
        </div>
        <select
          value={kindFilter}
          onChange={(event) => setKindFilter(event.target.value)}
          style={surface.input}
          className="rounded-lg px-2 py-2 font-mono text-xs text-slate-200 outline-none"
        >
          {kinds.map((kind) => (
            <option key={kind} value={kind} className="bg-slate-900">
              {kind === 'all' ? 'all kinds' : kind}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setShowDerived((value) => !value)}
          title="Show pods and replica sets"
          style={showDerived ? surface.chip : surface.input}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-2 font-mono text-xs uppercase tracking-widest text-slate-300"
        >
          <Layers className="h-3.5 w-3.5" /> pods
        </button>
        <div className="flex items-center gap-1">
          <IconButton label="Zoom out" onClick={() => setZoom((value) => Math.max(0.3, value - 0.15))}>
            <Minus className="h-3.5 w-3.5" />
          </IconButton>
          <span className="w-10 text-center font-mono text-xs text-slate-400">{Math.round(zoom * 100)}%</span>
          <IconButton label="Zoom in" onClick={() => setZoom((value) => Math.min(2.2, value + 0.15))}>
            <Plus className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Reset view" onClick={fit}>
            <Maximize2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      <div
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          setZoom((value) => Math.min(2.2, Math.max(0.3, value - event.deltaY * 0.0016)));
        }}
        onPointerDown={(event) => {
          dragging.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
          (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!dragging.current) return;
          setPan({
            x: dragging.current.panX + (event.clientX - dragging.current.x),
            y: dragging.current.panY + (event.clientY - dragging.current.y),
          });
        }}
        onPointerUp={() => { dragging.current = null; }}
        onPointerLeave={() => { dragging.current = null; }}
      >
        <svg width="100%" height="100%" role="img" aria-label="Resource topology">
          <defs>
            <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse">
              <path d="M28 0H0V28" fill="none" stroke="rgba(148,163,184,0.08)" strokeWidth="1" />
            </pattern>
            <filter id="nodeGlow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="6" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
          <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            {topology.edges.map((edge, index) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              if (!from || !to) return null;
              const lit = visibleIds.has(from.id) && visibleIds.has(to.id);
              const x1 = from.x + NODE_SIZE.width;
              const y1 = from.y + NODE_SIZE.height / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_SIZE.height / 2;
              const mid = (x1 + x2) / 2;
              return (
                <path
                  key={index}
                  d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={lit ? 'rgba(148,163,184,0.42)' : 'rgba(148,163,184,0.10)'}
                  strokeWidth={1.4}
                />
              );
            })}
            {topology.nodes.map((node) => (
              <NodeShape
                key={node.id}
                node={node}
                selected={node.id === selected}
                faded={dimmed && !visibleIds.has(node.id)}
                onSelect={() => select(node.id === selected ? null : node)}
              />
            ))}
          </g>
        </svg>

        <div
          style={surface.glass}
          className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-3 rounded-xl px-3 py-2"
        >
          {(['healthy', 'progressing', 'degraded', 'planned'] as const).map((key) => (
            <span key={key} className="flex items-center gap-1.5 font-mono text-xs text-slate-400">
              <span className="h-2 w-2 rounded-full" style={{ background: healthColors[key].fg }} />
              {key}
            </span>
          ))}
        </div>

        {!live && (
          <div
            style={surface.glass}
            className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 rounded-xl px-3 py-2 font-mono text-xs uppercase tracking-widest text-slate-300"
          >
            <Crosshair className="h-3.5 w-3.5 text-teal-300" />
            preview from manifests
          </div>
        )}
      </div>

      {selectedNode && <Inspector node={selectedNode} live={live} onClose={() => select(null)} />}
    </div>
  );
}

function IconButton({ children, label, onClick }: { children: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={surface.input}
      className="rounded-lg p-2 text-slate-300 transition hover:text-teal-300"
    >
      {children}
    </button>
  );
}

function NodeShape({ node, selected, faded, onSelect }: {
  node: TopoNode; selected: boolean; faded: boolean; onSelect: () => void;
}) {
  const tone = healthColors[node.health];
  return (
    <g
      transform={`translate(${node.x} ${node.y})`}
      opacity={faded ? 0.22 : 1}
      onClick={(event) => { event.stopPropagation(); onSelect(); }}
      className="cursor-pointer"
    >
      <rect
        width={NODE_SIZE.width}
        height={NODE_SIZE.height}
        rx={12}
        fill="rgba(15,23,42,0.86)"
        stroke={selected ? tone.fg : 'rgba(255,255,255,0.12)'}
        strokeWidth={selected ? 2 : 1}
        filter={selected ? 'url(#nodeGlow)' : undefined}
      />
      <rect width={4} height={NODE_SIZE.height} rx={2} fill={tone.fg} opacity={0.9} />
      <rect
        x={10}
        y={9}
        width={40}
        height={16}
        rx={5}
        fill={tone.bg}
        stroke={tone.ring}
        strokeWidth={0.8}
      />
      <text x={30} y={20.5} textAnchor="middle" fontSize={9} fill={tone.fg} fontFamily="ui-monospace, monospace">
        {KIND_ABBREV[node.kind] ?? node.kind.slice(0, 5).toLowerCase()}
      </text>
      <text x={58} y={21} fontSize={10} fill="rgba(148,163,184,0.85)" fontFamily="ui-monospace, monospace">
        {node.kind}
      </text>
      <text x={11} y={41} fontSize={12} fill="#e2e8f0" fontFamily="ui-monospace, monospace">
        {node.name.length > 22 ? `${node.name.slice(0, 21)}…` : node.name}
      </text>
      <circle
        cx={NODE_SIZE.width - 13}
        cy={16}
        r={4}
        fill={syncColors[node.sync]}
        opacity={node.sync === 'unknown' ? 0.45 : 1}
      />
    </g>
  );
}

function Inspector({ node, live, onClose }: { node: TopoNode; live: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'summary' | 'events' | 'logs' | 'metrics'>('summary');
  const tone = healthColors[node.health];
  return (
    <div
      style={surface.glass}
      className="absolute bottom-3 right-3 flex max-h-80 w-80 flex-col rounded-2xl"
    >
      <div className="flex items-start justify-between gap-2 border-b border-slate-800 px-3 py-2.5">
        <div className="min-w-0">
          <p className={cls.eyebrow}>{node.kind}</p>
          <p className="truncate font-mono text-sm text-slate-100">{node.name}</p>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 transition hover:text-slate-100">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex shrink-0 gap-1 px-3 pt-2">
        {(['summary', 'events', 'logs', 'metrics'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            style={tab === value ? surface.chip : undefined}
            className={`rounded-md px-2 py-1 font-mono text-xs uppercase tracking-wider transition ${
              tab === value ? 'text-teal-200' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {tab === 'summary' ? (
          <dl className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: tone.fg }} />
              <span className="font-mono text-xs" style={{ color: tone.fg }}>{node.health}</span>
              <span className="font-mono text-xs text-slate-500">· {node.sync}</span>
            </div>
            {node.detail.map(([key, value]) => (
              <div key={key} className="flex gap-2 text-xs">
                <dt className="w-24 shrink-0 font-mono uppercase tracking-wider text-slate-500">{key}</dt>
                <dd className="min-w-0 break-words font-mono text-slate-300">{value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-xs leading-relaxed text-slate-400">
            {live
              ? 'Streaming from the connected cluster.'
              : `Live ${tab} need a connected cluster. Attach one under Clusters, then switch this panel to live mode; the backend streams ${tab} for this resource over the same node id.`}
          </p>
        )}
      </div>
    </div>
  );
}
