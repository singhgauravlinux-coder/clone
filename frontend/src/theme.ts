import type { CSSProperties } from 'react';

/**
 * Design tokens.
 *
 * The chrome is dark-first and built from layered translucent panels. Surfaces
 * are declared as inline styles rather than utility classes because the glass
 * effect needs real rgba stops, blur radii and inset highlights that a utility
 * palette cannot express: the top inset line is what reads as "pane of glass"
 * rather than "grey box with rounded corners".
 */

export const accent = '#2dd4bf';
export const accentDeep = '#0d9488';
export const violet = '#a78bfa';

export const surface = {
  page: {
    background:
      'radial-gradient(1200px 600px at 12% -10%, rgba(45,212,191,0.16), transparent 60%),'
      + 'radial-gradient(900px 500px at 92% 0%, rgba(167,139,250,0.14), transparent 55%),'
      + 'linear-gradient(180deg, #070b12 0%, #05080e 50%, #04060b 100%)',
  } as CSSProperties,

  /** Primary floating panel. */
  glass: {
    background: 'linear-gradient(160deg, rgba(255,255,255,0.075) 0%, rgba(255,255,255,0.025) 45%, rgba(255,255,255,0.012) 100%)',
    border: '1px solid rgba(255,255,255,0.10)',
    boxShadow: '0 20px 50px -24px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.14)',
    backdropFilter: 'blur(18px) saturate(140%)',
    WebkitBackdropFilter: 'blur(18px) saturate(140%)',
  } as CSSProperties,

  /** Recessed panel, used for editors and canvases. */
  well: {
    background: 'linear-gradient(180deg, rgba(2,6,14,0.78) 0%, rgba(3,7,16,0.92) 100%)',
    border: '1px solid rgba(255,255,255,0.07)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), inset 0 24px 48px -32px rgba(0,0,0,0.9)',
  } as CSSProperties,

  /** Chip / inline control. */
  chip: {
    background: 'linear-gradient(180deg, rgba(255,255,255,0.09), rgba(255,255,255,0.03))',
    border: '1px solid rgba(255,255,255,0.12)',
    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.12)',
  } as CSSProperties,

  input: {
    background: 'rgba(6,11,20,0.72)',
    border: '1px solid rgba(255,255,255,0.11)',
    boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.45)',
  } as CSSProperties,

  primary: {
    background: 'linear-gradient(180deg, #2dd4bf 0%, #0f9d8f 100%)',
    border: '1px solid rgba(45,212,191,0.65)',
    boxShadow: '0 10px 26px -12px rgba(45,212,191,0.75), inset 0 1px 0 rgba(255,255,255,0.35)',
    color: '#03201d',
  } as CSSProperties,

  danger: {
    background: 'linear-gradient(180deg, rgba(244,63,94,0.22), rgba(244,63,94,0.10))',
    border: '1px solid rgba(244,63,94,0.42)',
  } as CSSProperties,
};

/** Health colours shared by the topology, the status rail and the legend. */
export const health = {
  healthy: { fg: '#2dd4bf', bg: 'rgba(45,212,191,0.14)', ring: 'rgba(45,212,191,0.55)' },
  progressing: { fg: '#60a5fa', bg: 'rgba(96,165,250,0.14)', ring: 'rgba(96,165,250,0.55)' },
  degraded: { fg: '#fb7185', bg: 'rgba(251,113,133,0.14)', ring: 'rgba(251,113,133,0.55)' },
  suspended: { fg: '#fbbf24', bg: 'rgba(251,191,36,0.14)', ring: 'rgba(251,191,36,0.55)' },
  missing: { fg: '#a78bfa', bg: 'rgba(167,139,250,0.14)', ring: 'rgba(167,139,250,0.5)' },
  planned: { fg: '#94a3b8', bg: 'rgba(148,163,184,0.12)', ring: 'rgba(148,163,184,0.45)' },
  unknown: { fg: '#64748b', bg: 'rgba(100,116,139,0.12)', ring: 'rgba(100,116,139,0.40)' },
} as const;

export type HealthKey = keyof typeof health;

export const sync = {
  'in-sync': '#2dd4bf',
  'out-of-sync': '#fbbf24',
  unknown: '#64748b',
} as const;

export type SyncKey = keyof typeof sync;

/** Shared class fragments so controls stay consistent across components. */
export const cls = {
  label: 'block font-mono text-xs uppercase tracking-widest text-slate-400',
  input: 'w-full rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none transition focus:ring-2',
  help: 'mt-1 text-xs leading-snug text-slate-500',
  eyebrow: 'font-mono text-xs uppercase tracking-widest text-slate-500',
};
