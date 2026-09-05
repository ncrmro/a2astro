import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cacheDirFor, describeSource, materialize, normalizeGitUri, parseCatalogSource } from '../src/lib/catalog-sources.ts';

const identity = (value: string): string => value;

describe('parseCatalogSource', () => {
  it('treats a bare string as a local path', () => {
    expect(parseCatalogSource('./fixtures/catalog', 'catalogs[0]', identity)).toEqual({ kind: 'path', path: './fixtures/catalog' });
  });

  it('reads a git source and defaults its subpath and name', () => {
    const source = parseCatalogSource({ uri: 'https://github.com/ai-outfitter/community-profiles.git', revision: 'v1.7.0' }, 'catalogs[0]', identity);
    expect(source).toEqual({
      kind: 'git',
      uri: 'https://github.com/ai-outfitter/community-profiles.git',
      revision: 'v1.7.0',
      path: '.',
      name: 'ai-outfitter-community-profiles',
    });
  });

  it('requires a pinned revision', () => {
    expect(() => parseCatalogSource({ uri: 'https://example.com/catalog.git' }, 'catalogs[0]', identity)).toThrow(/revision is required/);
  });

  it('rejects a git source with no uri', () => {
    expect(() => parseCatalogSource({ revision: 'main' }, 'catalogs[2]', identity)).toThrow(/catalogs\[2\]\.uri is required/);
  });
});

describe('git URIs', () => {
  it('strips the operator’s git+ prefix', () => {
    expect(normalizeGitUri('git+http://host-forgejo.default.svc.cluster.local:3001/ks.systems/.agents.git')).toBe(
      'http://host-forgejo.default.svc.cluster.local:3001/ks.systems/.agents.git',
    );
  });

  it('describes a source the way the UI labels it', () => {
    expect(describeSource({ kind: 'git', uri: 'git+https://example.com/org/cat.git', revision: 'abc123', path: '.', name: 'cat' })).toBe(
      'https://example.com/org/cat.git@abc123',
    );
    expect(describeSource({ kind: 'path', path: '/tmp/catalog' })).toBe('/tmp/catalog');
  });

  it('gives each pinned revision its own cache directory', () => {
    const base = { kind: 'git', uri: 'https://example.com/org/cat.git', path: '.', name: 'cat' } as const;
    const a = cacheDirFor({ ...base, revision: 'v1' }, '/cache');
    const b = cacheDirFor({ ...base, revision: 'v2' }, '/cache');
    expect(a).not.toBe(b);
    expect(a.startsWith('/cache/cat-')).toBe(true);
  });
});

describe('materialize', () => {
  it('reports a missing local path instead of throwing', () => {
    const result = materialize({ kind: 'path', path: '/nonexistent-catalog' }, '/tmp');
    expect(result.root).toBeUndefined();
    expect(result.error).toMatch(/does not exist/);
  });

  it('returns a local path unchanged', () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2astro-catalog-'));
    expect(materialize({ kind: 'path', path: dir }, '/tmp').root).toBe(dir);
  });

  it('fetches a pinned git catalog once and reuses the checkout', () => {
    const cache = mkdtempSync(join(tmpdir(), 'a2astro-cache-'));
    const source = { kind: 'git', uri: 'https://example.com/org/cat.git', revision: 'v1.7.0', path: '.', name: 'cat' } as const;
    const calls: string[][] = [];
    const first = materialize(source, cache, (args, cwd) => {
      calls.push([...args]);
      // Stand in for the clone: create the directory git would have made.
      if (args[0] === 'init') mkdirSync(join(cacheDirFor(source, cache), '.git'), { recursive: true });
      void cwd;
    });
    expect(first.root).toBe(cacheDirFor(source, cache));
    expect(calls.map((c) => c[0])).toEqual(['init', 'remote', 'fetch', 'checkout']);
    expect(calls[2]).toContain('v1.7.0');

    const second = materialize(source, cache, () => {
      throw new Error('should not run git again');
    });
    expect(second.root).toBe(first.root);
  });

  it('surfaces a fetch failure as an issue, not an exception', () => {
    const cache = mkdtempSync(join(tmpdir(), 'a2astro-cache-'));
    const result = materialize({ kind: 'git', uri: 'https://example.com/x.git', revision: 'v1', path: '.', name: 'x' }, cache, () => {
      throw new Error('network is unreachable');
    });
    expect(result.root).toBeUndefined();
    expect(result.error).toMatch(/network is unreachable/);
  });

  it('resolves a subpath inside the catalog', () => {
    const cache = mkdtempSync(join(tmpdir(), 'a2astro-cache-'));
    const source = { kind: 'git', uri: 'https://example.com/org/cat.git', revision: 'v1', path: 'shared', name: 'cat' } as const;
    const dir = cacheDirFor(source, cache);
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'marker'), '');
    expect(materialize(source, cache).root).toBe(join(dir, 'shared'));
  });
});
