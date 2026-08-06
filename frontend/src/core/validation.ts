import type { FieldDef, Issue, Model } from './types';
import { get } from './model';

/**
 * Validation mirrors what the API server rejects at admission time, so the
 * generated file is committable without a round trip to a cluster.
 */

export const DNS_1123_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
export const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
export const LABEL_KEY = /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
export const LABEL_VALUE = /^([A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?)?$/;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.]*$/;
export const QUANTITY = /^[+-]?(\d+(\.\d*)?|\.\d+)(([EPTGMK]i?)|[munp]|[eE][+-]?\d+)?$/;

export function checkName(value: any, path: string, label = 'Name'): Issue[] {
  const name = String(value ?? '').trim();
  if (!name) return [{ level: 'error', message: `${label} is required`, path }];
  const issues: Issue[] = [];
  if (name.length > 253) {
    issues.push({ level: 'error', message: `${label} must be 253 characters or fewer`, path });
  }
  if (!DNS_1123_SUBDOMAIN.test(name)) {
    issues.push({
      level: 'error',
      message: `${label} must be lowercase alphanumerics, "-" or ".", starting and ending with an alphanumeric`,
      path,
    });
  }
  return issues;
}

export function checkLabels(rows: any, path: string, label = 'Labels'): Issue[] {
  if (!Array.isArray(rows)) return [];
  const issues: Issue[] = [];
  const seen = new Set<string>();
  rows.forEach((row: any) => {
    const key = String(row?.key ?? '').trim();
    if (!key) return;
    if (seen.has(key)) issues.push({ level: 'error', message: `${label}: "${key}" is set twice`, path });
    seen.add(key);
    if (!LABEL_KEY.test(key)) {
      issues.push({ level: 'error', message: `${label}: "${key}" is not a valid key`, path });
    }
    if (!LABEL_VALUE.test(String(row?.value ?? ''))) {
      issues.push({ level: 'error', message: `${label}: value for "${key}" has invalid characters`, path });
    }
  });
  return issues;
}

export function checkPort(value: any, path: string, label = 'Port'): Issue[] {
  if (value === '' || value === null || value === undefined) return [];
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return [{ level: 'error', message: `${label} must be an integer between 1 and 65535`, path }];
  }
  return [];
}

export function checkQuantity(value: any, path: string, label: string): Issue[] {
  const text = String(value ?? '').trim();
  if (!text) return [];
  if (!QUANTITY.test(text)) {
    return [{ level: 'error', message: `${label}: "${text}" is not a valid quantity (try 100m, 1, 256Mi, 2Gi)`, path }];
  }
  return [];
}

export function checkImage(value: any, path: string): Issue[] {
  const image = String(value ?? '').trim();
  if (!image) return [{ level: 'error', message: 'Image is required', path }];
  const issues: Issue[] = [];
  if (/\s/.test(image)) issues.push({ level: 'error', message: 'Image reference cannot contain spaces', path });
  const tag = image.split('/').pop() ?? '';
  if (!tag.includes(':') && !image.includes('@')) {
    issues.push({ level: 'warning', message: `Image "${image}" has no tag, so it resolves to :latest`, path });
  } else if (tag.endsWith(':latest')) {
    issues.push({ level: 'warning', message: 'Pinning :latest makes rollouts unreproducible', path });
  }
  return issues;
}

/** Five-field cron with the ranges the CronJob controller accepts. */
export function checkSchedule(value: any, path: string): Issue[] {
  const schedule = String(value ?? '').trim();
  if (!schedule) return [{ level: 'error', message: 'Schedule is required', path }];
  if (/^@(yearly|annually|monthly|weekly|daily|midnight|hourly)$/.test(schedule)) return [];
  const parts = schedule.split(/\s+/);
  if (parts.length !== 5) {
    return [{ level: 'error', message: 'Schedule needs five fields: minute hour day-of-month month day-of-week', path }];
  }
  const bounds: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  const issues: Issue[] = [];
  parts.forEach((part, index) => {
    const [min, max] = bounds[index];
    const ok = part.split(',').every((chunk) => {
      const [range, step] = chunk.split('/');
      if (step !== undefined && !/^\d+$/.test(step)) return false;
      if (range === '*') return true;
      return range.split('-').every((bound) => /^\d+$/.test(bound) && Number(bound) >= min && Number(bound) <= max);
    });
    if (!ok) issues.push({ level: 'error', message: `Schedule field ${index + 1} ("${part}") is out of range ${min}-${max}`, path });
  });
  return issues;
}

/** Required-field sweep driven by the field definitions themselves. */
export function checkRequired(fields: FieldDef[], model: Model): Issue[] {
  const issues: Issue[] = [];
  const walk = (defs: FieldDef[], scope: Model, prefix: string) => {
    for (const field of defs) {
      if (field.when && !field.when(scope)) continue;
      const value = get(scope, field.path);
      const path = prefix + field.path;
      if (field.required) {
        const empty = value === undefined || value === null || value === ''
          || (Array.isArray(value) && value.length === 0);
        if (empty) issues.push({ level: 'error', message: `${field.label} is required`, path });
      }
      if (field.kind === 'array' && field.itemFields && Array.isArray(value)) {
        value.forEach((row: Model, index: number) => walk(field.itemFields!, row, `${path}.${index}.`));
      }
    }
  };
  walk(fields, model, '');
  return issues;
}

/** Errors first, then warnings, with duplicates collapsed. */
export function sortIssues(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  const unique = issues.filter((issue) => {
    const key = `${issue.level}:${issue.path ?? ''}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
}
