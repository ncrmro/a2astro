import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

import { parse } from 'yaml';

import { type CatalogSource, parseCatalogSource } from './catalog-sources.ts';

export interface AgentConfig {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Default workflow slug used to draw a graph for tasks that carry no workflow metadata. */
  readonly workflow?: string;
  readonly a2a: { readonly url: string; readonly token?: string };
  readonly deployment?: { readonly cluster?: string; readonly namespace?: string };
}

/**
 * Read a bearer token out of a mounted file. A plain file is the token itself;
 * a JSON array of `{Username, Token}` is the shape agent-operator writes for
 * its forge routes, so a projected Secret key can be used directly.
 */
export const readTokenFile = (path: string, username?: string): string => {
  const text = readFileSync(path, 'utf8');
  if (!username) return text.trim();
  const entries = JSON.parse(text) as { Username?: string; username?: string; Token?: string; token?: string }[];
  if (!Array.isArray(entries)) throw new Error(`${path} must be a JSON array when a2a.tokenUsername is set`);
  const wanted = username.toLowerCase();
  const match = entries.find((e) => (e.Username ?? e.username ?? '').toLowerCase() === wanted);
  const token = match?.Token ?? match?.token;
  if (!token) throw new Error(`${path} has no token for '${username}'`);
  return token;
};

export interface AppConfig {
  readonly path: string;
  readonly dataDir: string;
  /** Where workflow definitions come from; a2astro defines none of its own. */
  readonly catalogs: readonly CatalogSource[];
  readonly agents: readonly AgentConfig[];
}

const expandEnv = (value: string): string =>
  value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => process.env[name] ?? '');

const expandPath = (value: string, base: string): string => {
  const expanded = value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
};

export const parseConfig = (document: unknown, path: string, base: string): AppConfig => {
  if (typeof document !== 'object' || document === null) throw new Error(`${path}: config must be a mapping`);
  const doc = document as Record<string, unknown>;
  const agentsRaw = Array.isArray(doc.agents) ? doc.agents : [];
  const agents = agentsRaw.map((entry, index): AgentConfig => {
    const raw = entry as Record<string, unknown>;
    const label = `agents[${index}]`;
    const id = asString(raw.id, `${label}.id`);
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id)) throw new Error(`${label}.id '${id}' is not a slug`);
    const a2a = (raw.a2a ?? {}) as Record<string, unknown>;
    let token = typeof a2a.token === 'string' ? expandEnv(a2a.token) : undefined;
    if (typeof a2a.tokenFile === 'string' && a2a.tokenFile.length > 0) {
      const file = expandPath(expandEnv(a2a.tokenFile), base);
      // An unreadable token file is this agent's problem, not the site's: leave
      // the token unset so the agent reports 401/offline like any other
      // unreachable one, rather than failing every page at config load.
      try {
        token = readTokenFile(file, typeof a2a.tokenUsername === 'string' ? a2a.tokenUsername : undefined);
      } catch (error) {
        console.warn(`[config] ${label}: ${error instanceof Error ? error.message : String(error)}`);
        token = undefined;
      }
    }
    const deployment = (raw.deployment ?? undefined) as AgentConfig['deployment'];
    return {
      id,
      name: typeof raw.name === 'string' ? raw.name : id,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      workflow: typeof raw.workflow === 'string' ? raw.workflow : undefined,
      a2a: { url: asString(a2a.url, `${label}.a2a.url`).replace(/\/+$/, ''), token: token || undefined },
      deployment,
    };
  });
  const seen = new Set<string>();
  for (const agent of agents) {
    if (seen.has(agent.id)) throw new Error(`duplicate agent id '${agent.id}'`);
    seen.add(agent.id);
  }
  const catalogs = (Array.isArray(doc.catalogs) ? doc.catalogs : []).map((entry, index) =>
    parseCatalogSource(entry, `catalogs[${index}]`, (value) => expandPath(value, base)),
  );
  return {
    path,
    dataDir: expandPath(typeof doc.dataDir === 'string' ? doc.dataDir : './data', base),
    catalogs,
    agents,
  };
};

export const resolveConfigPath = (): string => {
  const explicit = process.env.A2ASTRO_CONFIG;
  if (explicit) return resolve(explicit);
  const candidates = ['a2astro.config.yaml', 'a2astro.config.mock.yaml', 'a2astro.config.example.yaml'].map((c) => resolve(process.cwd(), c));
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
};

let cached: AppConfig | undefined;

export const loadConfig = (): AppConfig => {
  if (cached) return cached;
  const path = resolveConfigPath();
  const text = readFileSync(path, 'utf8');
  cached = parseConfig(parse(text), path, resolve(path, '..'));
  return cached;
};

export const resetConfigCache = (): void => {
  cached = undefined;
};

export const findAgent = (id: string): AgentConfig | undefined => loadConfig().agents.find((a) => a.id === id);
