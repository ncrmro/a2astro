import type { WorkflowDefinition, WorkflowNode } from './workflows.ts';

export type NodeStatus = 'pending' | 'working' | 'done' | 'failed' | 'skipped';

export interface LayoutNode {
  readonly id: string;
  readonly node: WorkflowNode;
  readonly layer: number;
  readonly row: number;
  readonly x: number;
  readonly y: number;
}

export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'needs' | 'feedback';
}

export interface GraphLayout {
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  readonly width: number;
  readonly height: number;
  readonly nodeWidth: number;
  readonly nodeHeight: number;
}

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 56;
const LAYER_GAP = 90;
const ROW_GAP = 28;
const PADDING = 16;

/**
 * Layered left-to-right layout: a node's layer is one past the deepest node it
 * `needs`; rows follow declaration order within a layer. Cycles (which the
 * outfitter schema forbids) are broken by declaration order so rendering never
 * hangs on a bad file.
 */
export const layoutWorkflow = (definition: WorkflowDefinition): GraphLayout => {
  const byId = new Map(definition.nodes.map((n) => [n.id, n] as const));
  const layerOf = new Map<string, number>();
  const visiting = new Set<string>();
  const layer = (id: string): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = byId.get(id);
    const deps = (node?.needs ?? []).filter((d) => byId.has(d));
    const value = deps.length === 0 ? 0 : Math.max(...deps.map(layer)) + 1;
    visiting.delete(id);
    layerOf.set(id, value);
    return value;
  };
  for (const node of definition.nodes) layer(node.id);

  const rows = new Map<number, number>();
  const nodes: LayoutNode[] = definition.nodes.map((node) => {
    const l = layerOf.get(node.id) ?? 0;
    const row = rows.get(l) ?? 0;
    rows.set(l, row + 1);
    return { id: node.id, node, layer: l, row, x: PADDING + l * (NODE_WIDTH + LAYER_GAP), y: PADDING + row * (NODE_HEIGHT + ROW_GAP) };
  });

  const edges: LayoutEdge[] = [];
  for (const node of definition.nodes) {
    for (const need of node.needs ?? []) if (byId.has(need)) edges.push({ from: need, to: node.id, kind: 'needs' });
  }
  for (const fb of definition.feedback ?? []) {
    if (byId.has(fb.from) && byId.has(fb.to)) edges.push({ from: fb.from, to: fb.to, kind: 'feedback' });
  }

  const maxLayer = Math.max(0, ...nodes.map((n) => n.layer));
  const maxRows = Math.max(1, ...rows.values());
  return {
    nodes,
    edges,
    width: PADDING * 2 + (maxLayer + 1) * NODE_WIDTH + maxLayer * LAYER_GAP,
    height: PADDING * 2 + maxRows * NODE_HEIGHT + (maxRows - 1) * ROW_GAP,
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
  };
};

/** SVG path for an edge between two laid-out nodes (right edge to left edge, cubic curve). */
export const edgePath = (layout: GraphLayout, edge: LayoutEdge): string => {
  const from = layout.nodes.find((n) => n.id === edge.from)!;
  const to = layout.nodes.find((n) => n.id === edge.to)!;
  const x1 = from.x + layout.nodeWidth;
  const y1 = from.y + layout.nodeHeight / 2;
  const x2 = to.x;
  const y2 = to.y + layout.nodeHeight / 2;
  if (edge.kind === 'feedback' || x2 <= x1) {
    // Loop back underneath.
    const drop = Math.max(from.y, to.y) + layout.nodeHeight + 18;
    return `M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x1 + 30} ${drop}, ${x1} ${drop} L ${x2} ${drop} C ${x2 - 30} ${drop}, ${x2 - 30} ${y2}, ${x2} ${y2}`;
  }
  const dx = Math.max(24, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};

/** Ids ordered by layer then row: a stable "execution order" for progress heuristics. */
export const topologicalIds = (layout: GraphLayout): string[] =>
  [...layout.nodes].sort((a, b) => a.layer - b.layer || a.row - b.row).map((n) => n.id);
