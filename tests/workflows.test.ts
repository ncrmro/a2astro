import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanCatalogs, validateWorkflow, workflowClosure } from '../src/lib/workflows.ts';

const fixtures = new URL('../fixtures/catalog', import.meta.url).pathname;

describe('scanCatalogs', () => {
  it('loads every fixture workflow with no issues', () => {
    const catalog = scanCatalogs([fixtures]);
    expect(catalog.issues).toEqual([]);
    expect([...catalog.workflows.keys()]).toContain('engineer');
    expect(catalog.workflows.get('engineer')!.definition.nodes.map((n) => n.id)).toEqual(['issue', 'develop', 'draft', 'review', 'merge']);
  });

  it('lets the first catalog win a slug and reports broken files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2astro-'));
    mkdirSync(join(dir, 'workflows', 'engineer'), { recursive: true });
    writeFileSync(join(dir, 'workflows', 'engineer', 'workflow.yaml'), 'version: 1\nid: engineer\ntitle: Override\ndescription: d\nactors: {}\nnodes: [{id: only, description: d, action: a}]\n');
    mkdirSync(join(dir, 'workflows', 'broken'), { recursive: true });
    writeFileSync(join(dir, 'workflows', 'broken', 'workflow.yaml'), 'version: 1\nid: broken\ntitle: B\ndescription: d\nactors: {}\nnodes: [{id: x, description: d}]\n');
    mkdirSync(join(dir, 'workflows', 'misnamed'), { recursive: true });
    writeFileSync(join(dir, 'workflows', 'misnamed', 'workflow.yaml'), 'version: 1\nid: other\ntitle: M\ndescription: d\nactors: {}\nnodes: [{id: x, description: d, action: a}]\n');
    const catalog = scanCatalogs([dir, fixtures]);
    expect(catalog.workflows.get('engineer')!.definition.title).toBe('Override');
    expect(catalog.issues.map((i) => i.slug).sort()).toEqual(['broken', 'misnamed']);
    expect(catalog.workflows.has('issue-triage')).toBe(true);
  });
});

describe('validateWorkflow', () => {
  it('rejects unknown needs and action/workflow ambiguity', () => {
    const base = { version: 1, id: 'w', title: 'W', description: 'd', actors: {} };
    expect(validateWorkflow({ ...base, nodes: [{ id: 'a', description: 'd', action: 'x', needs: ['zzz'] }] }, 'p')).toMatchObject({ message: expect.stringContaining('unknown node') });
    expect(validateWorkflow({ ...base, nodes: [{ id: 'a', description: 'd', action: 'x', workflow: 'y' }] }, 'p')).toMatchObject({ message: expect.stringContaining('exactly one') });
    expect(validateWorkflow({ ...base, nodes: [{ id: 'a', description: 'd', action: 'x' }] }, 'p')).toMatchObject({ id: 'w' });
  });
});

describe('workflowClosure', () => {
  it('walks nested workflows breadth-first without repeats', () => {
    const catalog = scanCatalogs([fixtures]);
    const slugs = workflowClosure(catalog, 'issue-triage').map((w) => w.definition.id);
    expect(slugs[0]).toBe('issue-triage');
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('bug-issue');
  });
});
