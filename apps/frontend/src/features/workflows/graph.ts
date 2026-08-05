import type { Edge, Node } from '@xyflow/react';
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agentforge/core';

export type CanvasNode = Node<{ wf: WorkflowNode }>;
export type CanvasEdge = Edge;

/** BFS-layered auto layout: depth → column, sibling order → row. */
export function layout(def: WorkflowDefinition): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const edge of def.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  const incoming = new Set(def.edges.map((e) => e.to));
  const roots = def.nodes.filter((n) => !incoming.has(n.id)).map((n) => n.id);
  const queue = roots.map((id) => ({ id, d: 0 }));
  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    if ((depth.get(id) ?? -1) >= d) continue;
    depth.set(id, d);
    for (const next of outgoing.get(id) ?? []) queue.push({ id: next, d: d + 1 });
  }
  const byDepth = new Map<number, string[]>();
  for (const node of def.nodes) {
    const d = depth.get(node.id) ?? 0;
    byDepth.set(d, [...(byDepth.get(d) ?? []), node.id]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [d, ids] of byDepth) {
    ids.forEach((id, i) => positions.set(id, { x: d * 260 + 40, y: i * 140 + 40 }));
  }
  return positions;
}

export function defToFlow(def: WorkflowDefinition): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const positions = layout(def);
  return {
    nodes: def.nodes.map((wf) => ({
      id: wf.id,
      position: positions.get(wf.id) ?? { x: 40, y: 40 },
      data: { wf },
      type: 'agentforge',
    })),
    edges: def.edges.map((edge) => ({
      id: `${edge.from}__${edge.on}__${edge.to}`,
      source: edge.from,
      target: edge.to,
      label: edge.on,
    })),
  };
}

export function flowToDef(nodes: CanvasNode[], edges: CanvasEdge[]): WorkflowDefinition {
  return {
    nodes: nodes.map((n) => n.data.wf),
    edges: edges.map((e): WorkflowEdge => ({ from: e.source, to: e.target, on: String(e.label ?? 'succeeded') })),
  };
}

/** Sensible default edge condition for a new connection from this node. */
export function defaultEdgeCondition(source: WorkflowNode | undefined, existing: CanvasEdge[]): string {
  if (!source) return 'succeeded';
  if (source.type === 'gate.human') {
    const used = existing.filter((e) => e.source === source.id).map((e) => String(e.label));
    return used.includes('approved') ? 'rejected' : 'approved';
  }
  if (source.type === 'decision.agent' || source.type === 'decision.rule') {
    const used = existing.filter((e) => e.source === source.id).map((e) => String(e.label));
    const free = source.routes.find((r) => !used.includes(`route:${r}`));
    return `route:${free ?? source.routes[0]}`;
  }
  return 'succeeded';
}

let counter = 0;
export function freshNode(type: WorkflowNode['type']): WorkflowNode {
  const id = `${type.split('.')[1]}-${++counter}`;
  switch (type) {
    case 'action.agent':
      return { id, type, agent: '', prompt: 'Work on:\n{{task.title}}\n\n{{task.body}}' };
    case 'decision.agent':
      return { id, type, agent: '', prompt: 'Choose a route.\n{{steps.implement.diff_summary}}', routes: ['deep', 'light'] };
    case 'decision.rule':
      return { id, type, routes: ['big', 'small'], rules: [{ when: 'steps.implement.diff_lines > 300', route: 'big' }], defaultRoute: 'small' };
    case 'gate.human':
      return { id, type, message: 'Approve to continue' };
    case 'gate.quality':
      return { id, type, commands: ['make test'], maxRounds: 2 };
    case 'action.open_pr':
      return { id, type, title: '{{task.external_key}}: {{task.title}}' };
    case 'action.notify':
      return { id, type, channel: 'log', message: '{{task.title}} finished' };
    default:
      return { id, type } as WorkflowNode;
  }
}
