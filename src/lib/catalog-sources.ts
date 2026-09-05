/**
 * Catalog sources: where workflow definitions come from.
 *
 * a2astro does not define workflows. It reads the same catalog the agents
 * resolve — `ai-outfitter/community-profiles`, or an organization catalog that
 * pins it — so the graph the site draws is the workflow the agent was given.
 *
 * A local path works for development. A deployment reads a git source, pinned
 * to a revision the way an `Organization`'s `agentCatalogs` entry pins one, and
 * materializes it into the data directory.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type CatalogSource =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'git'; readonly uri: string; readonly revision: string; readonly path: string; readonly name: string };

export interface MaterializedCatalog {
  readonly source: CatalogSource;
  /** Local directory holding `workflows/<slug>/workflow.yaml`, when resolved. */
  readonly root?: string;
  readonly error?: string;
}

/** `git+http://host/org/repo.git` is how the operator writes a catalog URI. */
export const normalizeGitUri = (uri: string): string => uri.replace(/^git\+/, '');

const repoName = (uri: string): string => {
  const trimmed = normalizeGitUri(uri).replace(/\.git$/, '');
  const parts = trimmed.split(/[/:]/).filter(Boolean);
  return parts.slice(-2).join('-').replace(/[^a-zA-Z0-9._-]/g, '-') || 'catalog';
};

/** Stable cache directory for one (uri, revision) pair. */
export const cacheDirFor = (source: Extract<CatalogSource, { kind: 'git' }>, cacheRoot: string): string => {
  const digest = createHash('sha256').update(`${normalizeGitUri(source.uri)}@${source.revision}`).digest('hex').slice(0, 12);
  return join(cacheRoot, `${source.name}-${digest}`);
};

export interface GitRunner {
  (args: readonly string[], cwd?: string): void;
}

const runGit: GitRunner = (args, cwd) => {
  execFileSync('git', [...args], { cwd, stdio: 'pipe', timeout: 120_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
};

/**
 * Clone the pinned revision into the cache once. A materialized directory is
 * immutable: the revision is part of its name, so a new pin is a new directory
 * and nothing has to be re-fetched or invalidated.
 */
export const materialize = (source: CatalogSource, cacheRoot: string, git: GitRunner = runGit): MaterializedCatalog => {
  if (source.kind === 'path') {
    return existsSync(source.path) ? { source, root: source.path } : { source, error: `catalog path does not exist: ${source.path}` };
  }
  const dir = cacheDirFor(source, cacheRoot);
  const root = source.path === '.' ? dir : resolve(dir, source.path);
  if (existsSync(join(dir, '.git'))) return { source, root };
  try {
    mkdirSync(cacheRoot, { recursive: true });
    git(['init', '--quiet', dir]);
    git(['remote', 'add', 'origin', normalizeGitUri(source.uri)], dir);
    git(['fetch', '--quiet', '--depth', '1', 'origin', source.revision], dir);
    git(['checkout', '--quiet', 'FETCH_HEAD'], dir);
    return { source, root };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { source, error: `could not fetch ${source.uri}@${source.revision}: ${message}` };
  }
};

export const describeSource = (source: CatalogSource): string =>
  source.kind === 'path' ? source.path : `${normalizeGitUri(source.uri)}@${source.revision}${source.path === '.' ? '' : `/${source.path}`}`;

export const parseCatalogSource = (entry: unknown, label: string, expandPath: (value: string) => string): CatalogSource => {
  if (typeof entry === 'string') {
    if (entry.length === 0) throw new Error(`${label} must be a non-empty string`);
    return { kind: 'path', path: expandPath(entry) };
  }
  if (typeof entry !== 'object' || entry === null) throw new Error(`${label} must be a path or a git source mapping`);
  const raw = entry as Record<string, unknown>;
  if (typeof raw.path === 'string' && raw.uri === undefined) return { kind: 'path', path: expandPath(raw.path) };
  if (typeof raw.uri !== 'string' || raw.uri.length === 0) throw new Error(`${label}.uri is required for a git catalog`);
  if (typeof raw.revision !== 'string' || raw.revision.length === 0) throw new Error(`${label}.revision is required: pin the catalog`);
  return {
    kind: 'git',
    uri: raw.uri,
    revision: raw.revision,
    path: typeof raw.path === 'string' && raw.path.length > 0 ? raw.path : '.',
    name: typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : repoName(raw.uri),
  };
};
