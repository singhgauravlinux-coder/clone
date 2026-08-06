/**
 * YAML 1.2 emitter for the subset that Kubernetes manifests use:
 * mappings, sequences, scalars, and literal block scalars.
 *
 * Emitting rather than pulling in js-yaml keeps output deterministic and keeps
 * key order exactly as the resource definition wrote it, which matters when the
 * generated file is going to live in Git.
 */

/** Words the YAML 1.2 core schema resolves to non-strings. */
const CORE_RESERVED = new Set(['true', 'false', 'null', '~', 'True', 'False', 'Null', 'NULL', 'TRUE', 'FALSE']);

/**
 * Words only YAML 1.1 parsers read as booleans. Quoted as values, because
 * a value of "no" should stay a string; left plain as keys, because
 * `on:` in a GitHub Actions workflow must read as `on`, not `'on'`.
 */
const LEGACY_BOOLEANS = new Set(['yes', 'no', 'on', 'off', 'y', 'n', 'Yes', 'No', 'On', 'Off', 'Y', 'N', 'YES', 'NO', 'ON', 'OFF']);

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const SEXAGESIMAL = /^[-+]?\d+(:\d+)+$/;
const LEADING_INDICATOR = /^[-?:,[\]{}#&*!|>'"%@`]/;

/** True when a plain (unquoted) scalar would not round-trip. */
export function needsQuotes(value: string, isKey = false): boolean {
  if (value === '') return true;
  if (CORE_RESERVED.has(value)) return true;
  if (!isKey && LEGACY_BOOLEANS.has(value)) return true;
  if (NUMERIC.test(value) || SEXAGESIMAL.test(value)) return true;
  if (LEADING_INDICATOR.test(value)) return true;
  if (value !== value.trim()) return true;
  if (value.includes(': ') || value.endsWith(':')) return true;
  if (value.includes(' #')) return true;
  if (/[\n\t\r]/.test(value)) return true;
  return false;
}

function quote(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  return JSON.stringify(value);
}

function scalar(value: any): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  const str = String(value);
  return needsQuotes(str) ? quote(str) : str;
}

function isPlainObject(value: any): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Drop empty values so optional form fields never emit `key: ""`. */
export function prune(value: any): any {
  if (Array.isArray(value)) {
    const items = value.map(prune).filter((item) => item !== undefined);
    return items.length ? items : undefined;
  }
  if (isPlainObject(value)) {
    const out: Record<string, any> = {};
    for (const [key, raw] of Object.entries(value)) {
      const cleaned = prune(raw);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

function pad(depth: number): string {
  return '  '.repeat(depth);
}

function emitBlockString(value: string, depth: number): string {
  const chomp = value.endsWith('\n') ? '' : '-';
  const body = value.replace(/\n$/, '')
    .split('\n')
    .map((line) => (line ? pad(depth) + line : ''))
    .join('\n');
  return `|${chomp}\n${body}`;
}

function emitValue(value: any, depth: number): string {
  if (Array.isArray(value)) return '\n' + emitSequence(value, depth);
  if (isPlainObject(value)) return '\n' + emitMapping(value, depth);
  if (typeof value === 'string' && value.includes('\n')) {
    return ' ' + emitBlockString(value, depth);
  }
  return ' ' + scalar(value);
}

function emitMapping(node: Record<string, any>, depth: number): string {
  const entries = Object.entries(node);
  if (!entries.length) return `${pad(depth)}{}`;
  return entries
    .map(([key, value]) => {
      const name = needsQuotes(key, true) ? quote(key) : key;
      if (Array.isArray(value) && value.length === 0) return `${pad(depth)}${name}: []`;
      if (isPlainObject(value) && Object.keys(value).length === 0) {
        return `${pad(depth)}${name}: {}`;
      }
      return `${pad(depth)}${name}:${emitValue(value, depth + 1)}`;
    })
    .join('\n');
}

function emitSequence(node: any[], depth: number): string {
  if (!node.length) return `${pad(depth)}[]`;
  return node
    .map((item) => {
      if (isPlainObject(item) && Object.keys(item).length) {
        // Hang the first key off the dash: "- name: web".
        const block = emitMapping(item, depth + 1);
        return pad(depth) + '- ' + block.slice(pad(depth + 1).length);
      }
      if (Array.isArray(item) && item.length) {
        const block = emitSequence(item, depth + 1);
        return pad(depth) + '- ' + block.slice(pad(depth + 1).length);
      }
      if (typeof item === 'string' && item.includes('\n')) {
        return `${pad(depth)}- ${emitBlockString(item, depth + 1)}`;
      }
      return `${pad(depth)}- ${scalar(item)}`;
    })
    .join('\n');
}

/** Render one document. Empty documents render as an empty string. */
export function toYaml(doc: any): string {
  const cleaned = prune(doc);
  if (cleaned === undefined) return '';
  if (!isPlainObject(cleaned) && !Array.isArray(cleaned)) return scalar(cleaned) + '\n';
  const body = Array.isArray(cleaned) ? emitSequence(cleaned, 0) : emitMapping(cleaned, 0);
  return body + '\n';
}

/** Render several documents into one file, separated by `---`. */
export function toYamlDocuments(docs: any[]): string {
  return docs
    .map(toYaml)
    .filter((text) => text.trim() !== '')
    .join('---\n');
}
