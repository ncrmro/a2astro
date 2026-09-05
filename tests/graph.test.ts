import { describe, expect, it } from 'vitest';

import { edgePath, layoutWorkflow, topologicalIds } from '../src/lib/graph.ts';
import type { WorkflowDefinition } from '../src/lib/workflows.ts';

const definition: WorkflowDefinition = {
  version: 1,
  id: 'sample',
  title: 'Sample',
  description: 'Diamond with a feedback edge.',
  actors: { eng: { kind: 'agent', profile: 'engineer' } },
  nodes: [
    { id: 'a', description: 'start', action: 'start' },
    { id: 'b', description: 'left', action: 'left', needs: ['a'] },
    { id: 'c', description: 'right', workflow: 'other', needs: ['a'] },
    { id: 'd', description: 'join', action: 'join', needs: ['b', 'c'] },
  ],
  feedback: [{ from: 'd', to: 'b' }],
};

describe('layoutWorkflow', () => {
  it('assigns layers by longest dependency path and rows by declaration order', () => {
    const layout = layoutWorkflow(definition);
    const byId = Object.fromEntries(layout.nodes.map((n) => [n.id, n]));
    expect(byId.a.layer).toBe(0);
    expect(byId.b.layer).toBe(1);
    expect(byId.c.layer).toBe(1);
    expect(byId.d.layer).toBe(2);
    expect(byId.b.row).toBe(0);
    expect(byId.c.row).toBe(1);
    expect(byId.c.x).toBeGreaterThan(byId.a.x);
    expect(layout.width).toBeGreaterThan(byId.d.x + layout.nodeWidth);
  });

  it('emits needs edges and feedback edges separately', () => {
    const layout = layoutWorkflow(definition);
    expect(layout.edges.filter((e) => e.kind === 'needs')).toHaveLength(4);
    expect(layout.edges.filter((e) => e.kind === 'feedback')).toEqual([{ from: 'd', to: 'b', kind: 'feedback' }]);
    for (const edge of layout.edges) expect(edgePath(layout, edge)).toMatch(/^M /);
  });

  it('orders ids by layer then row', () => {
    expect(topologicalIds(layoutWorkflow(definition))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not hang on a dependency cycle', () => {
    const cyclic: WorkflowDefinition = {
      ...definition,
      nodes: [
        { id: 'x', description: 'x', action: 'x', needs: ['y'] },
        { id: 'y', description: 'y', action: 'y', needs: ['x'] },
      ],
      feedback: [],
    };
    expect(layoutWorkflow(cyclic).nodes).toHaveLength(2);
  });
});
