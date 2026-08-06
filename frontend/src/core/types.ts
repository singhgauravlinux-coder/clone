/**
 * Core schema types.
 *
 * Everything the app knows about a resource lives in a ResourceDefinition.
 * Adding a new resource type means adding one file under src/resources and
 * registering it — no changes to the form renderer, the YAML pane, or the app
 * shell.
 */

export type Model = Record<string, any>;

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'number'
  | 'boolean'
  | 'select'
  | 'keyvalue'
  | 'stringlist'
  | 'array';

export interface SelectOption {
  value: string;
  label: string;
  help?: string;
}

export interface FieldDef {
  /** Dot path into the form model, e.g. "spec.replicas". */
  path: string;
  label: string;
  kind: FieldKind;
  /** Short hint shown under the control. */
  help?: string;
  placeholder?: string;
  required?: boolean;
  /** Section heading this field belongs to. */
  section?: string;
  /** Half-width layout on wide screens. */
  half?: boolean;
  options?: SelectOption[];
  min?: number;
  max?: number;
  step?: number;
  /** Hide the field unless the model satisfies this predicate. */
  when?: (model: Model) => boolean;
  /** For kind: 'array' — the shape of one item. */
  itemFields?: FieldDef[];
  /** For kind: 'array' — label for one row, e.g. "container". */
  itemLabel?: string;
  /** For kind: 'array' — value used when a row is added. */
  itemDefault?: () => Model;
  /** For kind: 'keyvalue' — column headings. */
  keyLabel?: string;
  valueLabel?: string;
  /** Monospace input (names, images, paths, selectors). */
  mono?: boolean;
}

export interface GeneratedFile {
  /** Repo-relative path, e.g. "templates/deployment.yaml". */
  path: string;
  /** Rendered file contents. */
  content: string;
  /** Language hint for the preview pane. */
  language: 'yaml' | 'text';
}

export type IssueLevel = 'error' | 'warning';

export interface Issue {
  level: IssueLevel;
  message: string;
  /** Model path the issue belongs to; clicking the issue focuses this field. */
  path?: string;
}

export interface ResourceDefinition {
  id: string;
  /** Left-rail grouping, e.g. "Workloads". */
  group: string;
  label: string;
  /** One line describing what this produces. */
  summary: string;
  /** Shown in the rail in mono, e.g. "apps/v1". */
  apiVersion?: string;
  /** Kubernetes kind(s) this definition can import. */
  kinds?: string[];
  fields: FieldDef[];
  /** Fresh model for a new document. */
  defaults: () => Model;
  /** Model -> files. Always pure; never touches a cluster. */
  build: (model: Model) => GeneratedFile[];
  /** Parsed YAML documents -> model. Return null if the docs don't match. */
  load?: (docs: any[]) => Model | null;
  /** Rules beyond required-field checks. */
  validate?: (model: Model) => Issue[];
}
