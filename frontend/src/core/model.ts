import type { Model } from './types';

/** Read a dot path, e.g. get(model, "spec.template.replicas"). */
export function get(model: Model, path: string): any {
  return path.split('.').reduce<any>((node, key) => (node == null ? undefined : node[key]), model);
}

/** Return a copy of `model` with `path` set to `value`. Arrays stay arrays. */
export function set(model: Model, path: string, value: any): Model {
  const keys = path.split('.');
  const clone = Array.isArray(model) ? [...(model as any)] : { ...model };
  let node: any = clone;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    const child = node[key];
    node[key] = Array.isArray(child) ? [...child] : { ...(child ?? {}) };
    node = node[key];
  }
  node[keys[keys.length - 1]] = value;
  return clone;
}

/** Convert a list of {key, value} rows into a plain object. */
export function pairsToMap(rows: any): Record<string, string> | undefined {
  if (!Array.isArray(rows)) return undefined;
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row && typeof row.key === 'string' && row.key.trim() !== '') {
      out[row.key.trim()] = row.value == null ? '' : String(row.value);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Convert an object back into {key, value} rows for the form. */
export function mapToPairs(map: any): { key: string; value: string }[] {
  if (!map || typeof map !== 'object') return [];
  return Object.entries(map).map(([key, value]) => ({ key, value: value == null ? '' : String(value) }));
}

/** Split a textarea or comma list into trimmed, non-empty entries. */
export function toList(value: any): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item).trim()).filter(Boolean);
    return items.length ? items : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const items = value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

/** Numbers arrive from inputs as strings; keep empty as undefined. */
export function num(value: any): number | undefined {
  if (value === '' || value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function str(value: any): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

export function bool(value: any): boolean | undefined {
  return value === true ? true : value === false ? false : undefined;
}

/** Deep clone for handing fresh models to the form. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}
