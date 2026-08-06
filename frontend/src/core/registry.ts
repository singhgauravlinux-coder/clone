import type { GeneratedFile, Issue, Model, ResourceDefinition } from './types';
import { checkRequired, sortIssues } from './validation';
import { parseDocuments } from './yaml';

import { cronJob, daemonSet, deployment, job, statefulSet } from '../resources/workloads';
import { ingress, service } from '../resources/networking';
import { configMap, secret } from '../resources/config';
import { persistentVolumeClaim } from '../resources/storage';
import { horizontalPodAutoscaler } from '../resources/autoscaling';
import { rbac } from '../resources/rbac';
import { argoApplication } from '../resources/argocd';
import { githubWorkflow } from '../resources/githubActions';
import { helmChart } from '../resources/helm';
import { kustomization } from '../resources/kustomize';

/**
 * The registry is the only place that knows the full catalogue. Adding a
 * resource type means writing one definition file and adding it to this list.
 * Definitions with a `kind` are matched first when importing, so the two
 * kind-less formats (Helm charts, workflows) act as fallbacks.
 */
export const resources: ResourceDefinition[] = [
  deployment,
  statefulSet,
  daemonSet,
  job,
  cronJob,
  service,
  ingress,
  configMap,
  secret,
  persistentVolumeClaim,
  horizontalPodAutoscaler,
  rbac,
  argoApplication,
  kustomization,
  helmChart,
  githubWorkflow,
];

export const resourceById = new Map(resources.map((resource) => [resource.id, resource]));

export interface ResourceGroup {
  name: string;
  items: ResourceDefinition[];
}

export const resourceGroups: ResourceGroup[] = resources.reduce<ResourceGroup[]>((groups, resource) => {
  const existing = groups.find((group) => group.name === resource.group);
  if (existing) existing.items.push(resource);
  else groups.push({ name: resource.group, items: [resource] });
  return groups;
}, []);

export function generate(resource: ResourceDefinition, model: Model): GeneratedFile[] {
  try {
    return resource.build(model).filter((file) => file.content.trim() !== '');
  } catch (error) {
    return [{
      path: 'error.txt',
      content: `Could not render this resource:\n${(error as Error).message}\n`,
      language: 'text',
    }];
  }
}

export function validate(resource: ResourceDefinition, model: Model): Issue[] {
  const issues = [...checkRequired(resource.fields, model)];
  if (resource.validate) {
    try {
      issues.push(...resource.validate(model));
    } catch (error) {
      issues.push({ level: 'error', message: `Validation failed: ${(error as Error).message}` });
    }
  }
  return sortIssues(issues);
}

export interface ImportResult {
  resource: ResourceDefinition;
  model: Model;
  /** Kinds found in the file that this definition does not cover. */
  ignored: string[];
}

/** Match pasted or uploaded YAML to a definition and fill in the form model. */
export function importDocuments(text: string): ImportResult {
  const docs = parseDocuments(text);
  if (!docs.length) throw new Error('No YAML documents found');
  const kinds: string[] = docs.map((doc) => doc?.kind).filter(Boolean);
  const ordered = [
    ...resources.filter((resource) => resource.kinds?.some((kind) => kinds.includes(kind))),
    ...resources.filter((resource) => !resource.kinds?.some((kind) => kinds.includes(kind))),
  ];
  for (const resource of ordered) {
    if (!resource.load) continue;
    const model = resource.load(docs);
    if (model) {
      const covered = new Set(resource.kinds ?? []);
      return { resource, model, ignored: [...new Set(kinds.filter((kind) => !covered.has(kind)))] };
    }
  }
  throw new Error(
    kinds.length
      ? `No form matches kind ${[...new Set(kinds)].join(', ')}`
      : 'This document does not look like a resource this app can edit',
  );
}
