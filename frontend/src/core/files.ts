import type { GeneratedFile } from './types';
import { toYaml, toYamlDocuments } from './yaml';

/** One YAML document in one file. */
export function yamlFile(path: string, doc: any): GeneratedFile {
  return { path, content: toYaml(doc), language: 'yaml' };
}

/** Several documents in one file, joined by `---`. */
export function multiYamlFile(path: string, docs: any[]): GeneratedFile {
  return { path, content: toYamlDocuments(docs), language: 'yaml' };
}

export function textFile(path: string, content: string): GeneratedFile {
  return { path, content, language: 'text' };
}

/** Filenames come from the resource name so a bundle stays readable in Git. */
export function slug(value: any, fallback = 'resource'): string {
  const text = String(value ?? '').trim().toLowerCase();
  const cleaned = text.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}
