import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isWorkflowIssue, readWorkflowFile } from '../src/lib/workflows.ts';

/**
 * a2astro's own capabilities are outfitter workflows in `workflows/<slug>/`.
 * They are shipped and rendered, so a broken one is a broken page.
 */
const root = resolve(import.meta.dirname, '../workflows');
const slugs = readdirSync(root).sort();

describe('a2astro capability workflows', () => {
  it('covers chat, review, and scheduling', () => {
    expect(slugs).toEqual(['agent-chat', 'scheduled-dispatch', 'task-review']);
  });

  it.each(slugs)('%s validates and its id matches its directory', (slug) => {
    const result = readWorkflowFile(resolve(root, slug, 'workflow.yaml'));
    if (isWorkflowIssue(result)) throw new Error(`${slug}: ${result.message}`);
    expect(result.id).toBe(slug);
    expect(result.nodes.length).toBeGreaterThan(0);
  });

  it('only references workflows that exist', () => {
    for (const slug of slugs) {
      const result = readWorkflowFile(resolve(root, slug, 'workflow.yaml'));
      if (isWorkflowIssue(result)) throw new Error(`${slug}: ${result.message}`);
      for (const node of result.nodes) {
        if (node.workflow) expect(slugs).toContain(node.workflow);
      }
    }
  });
});
