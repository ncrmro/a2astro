import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseConfig, readTokenFile } from '../src/lib/config.ts';

describe('parseConfig', () => {
  it('expands env tokens, resolves paths, and normalizes URLs', () => {
    process.env.A2ASTRO_TEST_TOKEN = 'tok';
    const config = parseConfig(
      { dataDir: './data', catalogs: ['./fixtures/catalog'], agents: [{ id: 'vega', a2a: { url: 'https://vega.example:8788/', token: '${A2ASTRO_TEST_TOKEN}' } }] },
      '/tmp/x/a2astro.config.yaml',
      '/tmp/x',
    );
    expect(config.dataDir).toBe('/tmp/x/data');
    expect(config.catalogs).toEqual([{ kind: 'path', path: '/tmp/x/fixtures/catalog' }]);
    expect(config.agents[0]).toMatchObject({ name: 'vega', a2a: { url: 'https://vega.example:8788', token: 'tok' } });
  });

  it('treats an unset env token as absent and rejects duplicate ids', () => {
    delete process.env.A2ASTRO_MISSING;
    const config = parseConfig({ agents: [{ id: 'a', a2a: { url: 'http://a', token: '${A2ASTRO_MISSING}' } }] }, '/p', '/');
    expect(config.agents[0].a2a.token).toBeUndefined();
    expect(() => parseConfig({ agents: [{ id: 'a', a2a: { url: 'http://a' } }, { id: 'a', a2a: { url: 'http://b' } }] }, '/p', '/')).toThrow(/duplicate/);
    expect(() => parseConfig({ agents: [{ id: 'Not Slug', a2a: { url: 'http://a' } }] }, '/p', '/')).toThrow(/slug/);
  });
});

describe('readTokenFile', () => {
  it('reads a plain token file, trimming whitespace', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'a2astro-token-')), 'token');
    writeFileSync(file, 'secret-value\n');
    expect(readTokenFile(file)).toBe('secret-value');
  });

  it('picks one token out of an agent-operator forge-routes array', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'a2astro-token-')), 'forge-routes.json');
    writeFileSync(file, JSON.stringify([{ Username: 'luce', URL: 'http://l', Token: 'l-token' }, { Username: 'Vega', URL: 'http://v', Token: 'v-token' }]));
    expect(readTokenFile(file, 'vega')).toBe('v-token');
  });

  it('names the agent it could not find a token for', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'a2astro-token-')), 'forge-routes.json');
    writeFileSync(file, JSON.stringify([{ Username: 'luce', Token: 'l-token' }]));
    expect(() => readTokenFile(file, 'vega')).toThrow(/no token for 'vega'/);
  });
});
