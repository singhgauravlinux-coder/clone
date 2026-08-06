/**
 * Indentation-driven YAML parser covering the subset that appears in
 * Kubernetes manifests, ArgoCD applications, Helm values, and GitHub Actions
 * workflows: block mappings and sequences, flow collections, quoted scalars,
 * literal/folded block scalars, comments, anchors-free multi-document files.
 *
 * Anything it cannot represent raises YamlError with a 1-based line number so
 * the editor can point at the offending line.
 */

export class YamlError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = 'YamlError';
    this.line = line;
  }
}

interface Line {
  indent: number;
  text: string;
  /** 1-based line number in the source. */
  no: number;
}

const NUMERIC = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function stripComment(input: string): string {
  let quoteChar: string | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoteChar) {
      if (ch === '\\' && quoteChar === '"') i += 1;
      else if (ch === quoteChar) quoteChar = null;
    } else if (ch === '"' || ch === "'") {
      quoteChar = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(input[i - 1]))) {
      return input.slice(0, i).trimEnd();
    }
  }
  return input.trimEnd();
}

function unquote(raw: string, line: number): string {
  const body = raw.slice(1, -1);
  if (raw[0] === "'") return body.replace(/''/g, "'");
  try {
    return JSON.parse(raw.replace(/\n/g, '\\n'));
  } catch {
    throw new YamlError('Unterminated or invalid double-quoted string', line);
  }
}

/** Split a flow collection body on top-level commas. */
function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoteChar: string | null = null;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quoteChar) {
      current += ch;
      if (ch === '\\' && quoteChar === '"') { current += body[++i] ?? ''; }
      else if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quoteChar = ch; current += ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((part) => part.trim());
}

function parseScalar(raw: string, line: number): any {
  const value = raw.trim();
  if (value === '') return null;
  if (value[0] === '"' || value[0] === "'") {
    const last = value[value.length - 1];
    if (value.length < 2 || last !== value[0]) {
      throw new YamlError('Unterminated quoted string', line);
    }
    return unquote(value, line);
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw new YamlError('Unclosed flow sequence', line);
    return splitFlow(value.slice(1, -1)).map((item) => parseScalar(item, line));
  }
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) throw new YamlError('Unclosed flow mapping', line);
    const out: Record<string, any> = {};
    for (const entry of splitFlow(value.slice(1, -1))) {
      const idx = entry.indexOf(':');
      if (idx === -1) throw new YamlError('Flow mapping entry is missing a colon', line);
      out[parseScalar(entry.slice(0, idx), line) as string] = parseScalar(entry.slice(idx + 1), line);
    }
    return out;
  }
  if (value === 'null' || value === '~') return null;
  if (value === 'true' || value === 'True' || value === 'TRUE') return true;
  if (value === 'false' || value === 'False' || value === 'FALSE') return false;
  if (NUMERIC.test(value)) return Number(value);
  return value;
}

/** Find the colon that separates a block-mapping key from its value. */
function keySplit(text: string): number {
  let quoteChar: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoteChar) {
      if (ch === '\\' && quoteChar === '"') i += 1;
      else if (ch === quoteChar) quoteChar = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quoteChar = ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ':' && depth === 0) {
      const next = text[i + 1];
      if (next === undefined || next === ' ') return i;
    }
  }
  return -1;
}

class Parser {
  private lines: Line[] = [];
  private pos = 0;

  constructor(source: string[], offset: number) {
    this.lines = source.map((text, index) => ({
      indent: text.search(/\S|$/),
      text,
      no: index + 1 + offset,
    }));
  }

  private peek(): Line | null {
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      const trimmed = line.text.trim();
      if (trimmed === '' || trimmed.startsWith('#')) { this.pos += 1; continue; }
      return line;
    }
    return null;
  }

  /** Consume a literal (|) or folded (>) block scalar owned by `parentIndent`. */
  private readBlock(header: string, parentIndent: number, line: number): string {
    const folded = header[0] === '>';
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const explicit = /\d/.exec(header);
    const collected: string[] = [];
    let blockIndent = explicit ? parentIndent + Number(explicit[0]) : -1;
    while (this.pos < this.lines.length) {
      const raw = this.lines[this.pos];
      const isBlank = raw.text.trim() === '';
      if (!isBlank && raw.indent <= parentIndent) break;
      if (blockIndent === -1 && !isBlank) blockIndent = raw.indent;
      collected.push(isBlank ? '' : raw.text.slice(blockIndent));
      this.pos += 1;
    }
    while (collected.length && collected[collected.length - 1] === '') collected.pop();
    if (!collected.length) return '';
    let text: string;
    if (folded) {
      text = collected.reduce((acc, cur, idx) => {
        if (idx === 0) return cur;
        if (cur === '' || acc.endsWith('\n')) return `${acc}\n${cur}`;
        return `${acc} ${cur}`;
      }, '');
    } else {
      text = collected.join('\n');
    }
    if (chomp === 'strip') return text;
    if (chomp === 'keep') return `${text}\n\n`;
    void line;
    return `${text}\n`;
  }

  private parseNode(indent: number): any {
    const line = this.peek();
    if (!line || line.indent < indent) return null;
    if (line.text.trim() === '-' || line.text.trim().startsWith('- ')) {
      return this.parseSequence(line.indent);
    }
    return this.parseMapping(line.indent);
  }

  private parseSequence(indent: number): any[] {
    const items: any[] = [];
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent) break;
      const body = line.text.trim();
      if (body !== '-' && !body.startsWith('- ')) break;
      this.pos += 1;
      const rest = body === '-' ? '' : body.slice(2).trim();
      if (rest === '') {
        const next = this.peek();
        items.push(next && next.indent > indent ? this.parseNode(next.indent) : null);
        continue;
      }
      if (rest === '-' || rest.startsWith('- ')) {
        const nestedIndent = line.text.indexOf(rest);
        this.lines.splice(this.pos, 0, { indent: nestedIndent, text: ' '.repeat(nestedIndent) + rest, no: line.no });
        items.push(this.parseSequence(nestedIndent));
        continue;
      }
      const colon = keySplit(rest);
      if (colon !== -1 && !rest.startsWith('[') && !rest.startsWith('{')) {
        // "- name: web" starts a mapping whose indent is the dash plus two.
        const virtualIndent = line.text.indexOf(rest);
        this.lines.splice(this.pos, 0, { indent: virtualIndent, text: ' '.repeat(virtualIndent) + rest, no: line.no });
        items.push(this.parseMapping(virtualIndent));
        continue;
      }
      if (rest[0] === '|' || rest[0] === '>') {
        items.push(this.readBlock(rest, indent, line.no));
        continue;
      }
      items.push(parseScalar(stripComment(rest), line.no));
    }
    return items;
  }

  private parseMapping(indent: number): Record<string, any> {
    const out: Record<string, any> = {};
    for (;;) {
      const line = this.peek();
      if (!line || line.indent !== indent) break;
      const body = line.text.trim();
      if (body.startsWith('- ') || body === '-') break;
      const colon = keySplit(body);
      if (colon === -1) {
        throw new YamlError(`Expected "key: value" but found ${JSON.stringify(body)}`, line.no);
      }
      const rawKey = body.slice(0, colon).trim();
      const key = rawKey[0] === '"' || rawKey[0] === "'" ? unquote(rawKey, line.no) : rawKey;
      const rest = body.slice(colon + 1).trim();
      this.pos += 1;
      if (rest === '') {
        const next = this.peek();
        out[key] = next && next.indent > indent ? this.parseNode(next.indent) : null;
        continue;
      }
      if (rest[0] === '|' || rest[0] === '>') {
        out[key] = this.readBlock(rest, indent, line.no);
        continue;
      }
      out[key] = parseScalar(stripComment(rest), line.no);
    }
    return out;
  }

  parse(): any {
    const first = this.peek();
    if (!first) return null;
    const value = this.parseNode(first.indent);
    const leftover = this.peek();
    if (leftover) {
      throw new YamlError(
        leftover.indent !== first.indent
          ? 'Indentation does not line up with the block above'
          : `Unexpected content: ${JSON.stringify(leftover.text.trim())}`,
        leftover.no,
      );
    }
    return value;
  }
}

/** Parse a single-document string. Throws YamlError on malformed input. */
export function parseYaml(text: string): any {
  return parseDocuments(text)[0] ?? null;
}

/** Parse a multi-document string into one value per `---` section. */
export function parseDocuments(text: string): any[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const chunks: { lines: string[]; offset: number }[] = [];
  let current: string[] = [];
  let offset = 0;
  lines.forEach((line, index) => {
    const trimmed = line.trimEnd();
    if (trimmed === '---' || trimmed.startsWith('--- ')) {
      chunks.push({ lines: current, offset });
      current = [];
      offset = index + 1;
      return;
    }
    if (trimmed === '...') return;
    current.push(line);
  });
  chunks.push({ lines: current, offset });
  const docs = chunks
    .map((chunk) => new Parser(chunk.lines, chunk.offset).parse())
    .filter((doc) => doc !== null && doc !== undefined);
  return docs;
}
