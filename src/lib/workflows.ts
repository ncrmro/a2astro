import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

import { type CatalogSource, describeSource, materialize } from './catalog-sources.ts';
import { loadConfig } from './config.ts';

/** Mirrors `WorkflowDefinition` in ai-outfitter/outfitter `code/cli/src/resolver/WorkflowDefinition.ts`. */
export type WorkflowActor =
  | { readonly kind: 'agent'; readonly profile: string; readonly skills?: readonly string[] }
  | { readonly kind: 'human' | 'tool' | 'system'; readonly profile?: string; readonly skills?: readonly string[] };

export interface WorkflowNode {
  readonly id: string;
  readonly description: string;
  readonly action?: string;
  readonly workflow?: string;
  readonly actor?: string;
  readonly environment?: string;
  readonly needs?: readonly string[];
  readonly skill?: string;
  readonly skills?: readonly string[];
  readonly uses?: readonly string[];
  readonly if?: string;
}

export interface WorkflowDefinition {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status?: string;
  readonly actors: Readonly<Record<string, WorkflowActor>>;
  readonly environments?: Readonly<Record<string, unknown>>;
  readonly integrations?: Readonly<Record<string, unknown>>;
  readonly triggers?: readonly Readonly<Record<string, unknown>>[];
  readonly nodes: readonly WorkflowNode[];
  readonly feedback?: readonly { readonly from: string; readonly to: string }[];
}

export interface LoadedWorkflow {
  readonly definition: WorkflowDefinition;
  readonly path: string;
  /** Human-readable catalog the definition came from. */
  readonly catalog: string;
}

export interface WorkflowIssue {
  readonly slug: string;
  readonly path: string;
  readonly message: string;
}

const SLUG = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/** Structural validation of the parts the UI depends on; the full schema lives in outfitter. */
export const validateWorkflow = (document: unknown, path: string): WorkflowDefinition | WorkflowIssue => {
  const fail = (message: string): WorkflowIssue => ({ slug: '', path, message });
  if (typeof document !== 'object' || document === null) return fail('workflow.yaml must be a mapping');
  const doc = document as Record<string, unknown>;
  if (doc.version !== 1) return fail('version must be 1');
  if (typeof doc.id !== 'string' || !SLUG.test(doc.id)) return fail('id must be a slug');
  if (typeof doc.title !== 'string' || doc.title.length === 0) return fail('title is required');
  if (typeof doc.description !== 'string' || doc.description.length === 0) return fail('description is required');
  if (typeof doc.actors !== 'object' || doc.actors === null) return fail('actors must be a mapping');
  if (!Array.isArray(doc.nodes) || doc.nodes.length === 0) return fail('nodes must be a non-empty list');
  const ids = new Set<string>();
  for (const [index, node] of (doc.nodes as Record<string, unknown>[]).entries()) {
    const label = `nodes[${index}]`;
    if (typeof node.id !== 'string' || !SLUG.test(node.id)) return fail(`${label}.id must be a slug`);
    if (ids.has(node.id)) return fail(`${label}.id '${node.id}' is duplicated`);
    ids.add(node.id);
    if (typeof node.description !== 'string' || node.description.length === 0) return fail(`${label}.description is required`);
    const hasAction = typeof node.action === 'string';
    const hasWorkflow = typeof node.workflow === 'string';
    if (hasAction === hasWorkflow) return fail(`${label} must set exactly one of action or workflow`);
  }
  for (const node of doc.nodes as WorkflowNode[]) {
    for (const need of node.needs ?? []) {
      if (!ids.has(need)) return fail(`node '${node.id}' needs unknown node '${need}'`);
    }
  }
  return doc as unknown as WorkflowDefinition;
};

export const isWorkflowIssue = (value: WorkflowDefinition | WorkflowIssue): value is WorkflowIssue => 'message' in value;

export const readWorkflowFile = (path: string): WorkflowDefinition | WorkflowIssue => {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { slug: '', path, message: `not readable: ${String(error)}` };
  }
  let document: unknown;
  try {
    document = parse(text);
  } catch (error) {
    return { slug: '', path, message: `invalid YAML: ${String(error)}` };
  }
  return validateWorkflow(document, path);
};

export interface WorkflowCatalog {
  readonly workflows: ReadonlyMap<string, LoadedWorkflow>;
  readonly issues: readonly WorkflowIssue[];
}

/** Scan `<catalog>/workflows/<slug>/workflow.yaml` across catalogs; first catalog wins a slug. */
export interface ResolvedCatalog {
  readonly root: string;
  /** How the catalog is named in the UI: a path, or `<uri>@<revision>`. */
  readonly label: string;
}

export const scanCatalogs = (catalogs: readonly (string | ResolvedCatalog)[]): WorkflowCatalog => {
  const workflows = new Map<string, LoadedWorkflow>();
  const issues: WorkflowIssue[] = [];
  for (const entry of catalogs) {
    const { root: catalogRoot, label: catalog } = typeof entry === 'string' ? { root: entry, label: entry } : entry;
    const root = join(catalogRoot, 'workflows');
    if (!existsSync(root)) continue;
    for (const slug of readdirSync(root).sort()) {
      const dir = join(root, slug);
      if (!statSync(dir).isDirectory()) continue;
      const path = join(dir, 'workflow.yaml');
      if (!existsSync(path)) continue;
      if (workflows.has(slug)) continue;
      const result = readWorkflowFile(path);
      if (isWorkflowIssue(result)) {
        issues.push({ ...result, slug });
        continue;
      }
      if (result.id !== slug) {
        issues.push({ slug, path, message: `id '${result.id}' must match its directory '${slug}'` });
        continue;
      }
      workflows.set(slug, { definition: result, path, catalog });
    }
  }
  return { workflows, issues };
};

let cache: { readonly key: string; readonly catalog: WorkflowCatalog; readonly at: number } | undefined;
const CACHE_MS = 5000;

/** Resolve every configured source to a local directory, fetching pinned git catalogs once. */
export const resolveCatalogs = (sources: readonly CatalogSource[], cacheRoot: string): { roots: ResolvedCatalog[]; issues: WorkflowIssue[] } => {
  const roots: ResolvedCatalog[] = [];
  const issues: WorkflowIssue[] = [];
  for (const source of sources) {
    const label = describeSource(source);
    const result = materialize(source, cacheRoot);
    if (result.root) roots.push({ root: result.root, label });
    else issues.push({ slug: '', path: label, message: result.error ?? 'catalog could not be resolved' });
  }
  return { roots, issues };
};

export const loadWorkflows = (): WorkflowCatalog => {
  const config = loadConfig();
  const key = config.catalogs.map(describeSource).join('\0');
  const now = Date.now();
  if (cache && cache.key === key && now - cache.at < CACHE_MS) return cache.catalog;
  const { roots, issues } = resolveCatalogs(config.catalogs, join(config.dataDir, 'catalogs'));
  const scanned = scanCatalogs(roots);
  const catalog: WorkflowCatalog = { workflows: scanned.workflows, issues: [...issues, ...scanned.issues] };
  cache = { key, catalog, at: now };
  return catalog;
};

export const findWorkflow = (slug: string | undefined): LoadedWorkflow | undefined =>
  slug ? loadWorkflows().workflows.get(slug) : undefined;

/** Every workflow reachable from a root through nested `workflow:` nodes, root first. */
export const workflowClosure = (catalog: WorkflowCatalog, root: string): LoadedWorkflow[] => {
  const out: LoadedWorkflow[] = [];
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const slug = queue.shift()!;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const workflow = catalog.workflows.get(slug);
    if (!workflow) continue;
    out.push(workflow);
    for (const node of workflow.definition.nodes) if (node.workflow) queue.push(node.workflow);
  }
  return out;
};
