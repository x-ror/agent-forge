import { z } from 'zod';

/**
 * Workflow definition schema (design doc §7.1).
 * Workflows are data: a versioned JSON DAG validated identically on the
 * canvas (client) and on save (server). Invalid graphs cannot be saved,
 * so the engine never sees them.
 */

const nodeId = z.string().min(1).max(64);
const routeName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

export const workflowNodeSchema = z.discriminatedUnion('type', [
  z.object({ id: nodeId, type: z.literal('trigger.task_selected') }),
  z.object({
    id: nodeId,
    type: z.literal('trigger.task_synced'),
    filter: z.object({ label: z.string().optional() }).optional(),
  }),
  z.object({ id: nodeId, type: z.literal('trigger.schedule') }),
  z.object({ id: nodeId, type: z.literal('action.create_worktree') }),
  z.object({
    id: nodeId,
    type: z.literal('action.agent'),
    agent: z.string().min(1),
    prompt: z.string().min(1),
  }),
  z.object({
    id: nodeId,
    type: z.literal('decision.agent'),
    agent: z.string().min(1),
    prompt: z.string().min(1),
    routes: z.array(routeName).min(2),
  }),
  z.object({
    id: nodeId,
    type: z.literal('decision.rule'),
    routes: z.array(routeName).min(2),
    /** Evaluated in order; first matching `when` expression wins. */
    rules: z.array(z.object({ when: z.string().min(1), route: routeName })).min(1),
    defaultRoute: routeName.optional(),
  }),
  z.object({
    id: nodeId,
    type: z.literal('gate.human'),
    message: z.string().optional(),
    timeoutMinutes: z.number().int().positive().optional(),
  }),
  z.object({ id: nodeId, type: z.literal('action.open_pr'), title: z.string().optional() }),
  z.object({
    id: nodeId,
    type: z.literal('action.notify'),
    channel: z.enum(['webhook', 'email', 'log']).optional(),
    message: z.string().optional(),
  }),
]);

export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export type WorkflowNodeType = WorkflowNode['type'];

export const edgeConditionSchema = z
  .string()
  .regex(/^(succeeded|failed|approved|rejected|route:[A-Za-z0-9_-]+)$/, 'edge condition must be succeeded | failed | approved | rejected | route:<name>');

export const workflowEdgeSchema = z.object({
  from: nodeId,
  to: nodeId,
  on: edgeConditionSchema,
});

export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

const workflowShape = z.object({
  nodes: z.array(workflowNodeSchema).min(1).max(100),
  edges: z.array(workflowEdgeSchema).max(300),
});

export type WorkflowDefinition = z.infer<typeof workflowShape>;

function isTrigger(node: WorkflowNode): boolean {
  return node.type.startsWith('trigger.');
}

/** Outgoing edge conditions permitted per node type. */
function allowedConditions(node: WorkflowNode): (on: string) => boolean {
  switch (node.type) {
    case 'trigger.task_selected':
    case 'trigger.task_synced':
    case 'trigger.schedule':
    case 'action.create_worktree':
    case 'action.agent':
    case 'action.open_pr':
    case 'action.notify':
      return (on) => on === 'succeeded' || on === 'failed';
    case 'decision.agent':
    case 'decision.rule':
      return (on) => on.startsWith('route:') || on === 'failed';
    case 'gate.human':
      return (on) => on === 'approved' || on === 'rejected';
  }
}

export interface WorkflowGraphIssue {
  code:
    | 'duplicate_node_id'
    | 'no_trigger'
    | 'multiple_triggers'
    | 'unknown_edge_node'
    | 'trigger_has_incoming'
    | 'invalid_edge_condition'
    | 'duplicate_edge'
    | 'unknown_route'
    | 'uncovered_route'
    | 'cycle'
    | 'unreachable_node';
  message: string;
}

/** Structural validation beyond per-node shape: DAG, connectivity, route coverage. */
export function validateWorkflowGraph(def: WorkflowDefinition): WorkflowGraphIssue[] {
  const issues: WorkflowGraphIssue[] = [];
  const byId = new Map<string, WorkflowNode>();

  for (const node of def.nodes) {
    if (byId.has(node.id)) {
      issues.push({ code: 'duplicate_node_id', message: `duplicate node id "${node.id}"` });
    }
    byId.set(node.id, node);
  }

  const triggers = def.nodes.filter(isTrigger);
  if (triggers.length === 0) {
    issues.push({ code: 'no_trigger', message: 'workflow must have exactly one trigger node' });
  } else if (triggers.length > 1) {
    issues.push({
      code: 'multiple_triggers',
      message: `workflow must have exactly one trigger node, found ${triggers.length}`,
    });
  }

  const seenEdges = new Set<string>();
  for (const edge of def.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      issues.push({
        code: 'unknown_edge_node',
        message: `edge ${edge.from} → ${edge.to} references a node that does not exist`,
      });
      continue;
    }
    if (isTrigger(to)) {
      issues.push({
        code: 'trigger_has_incoming',
        message: `trigger node "${to.id}" cannot have incoming edges`,
      });
    }
    if (!allowedConditions(from)(edge.on)) {
      issues.push({
        code: 'invalid_edge_condition',
        message: `edge condition "${edge.on}" is not valid for ${from.type} node "${from.id}"`,
      });
    }
    const key = `${edge.from}|${edge.on}|${edge.to}`;
    if (seenEdges.has(key)) {
      issues.push({ code: 'duplicate_edge', message: `duplicate edge ${key}` });
    }
    seenEdges.add(key);
  }

  // Route coverage: every declared route has an edge; every route edge is declared.
  for (const node of def.nodes) {
    if (node.type !== 'decision.agent' && node.type !== 'decision.rule') continue;
    const declared = new Set(node.routes);
    const outgoingRoutes = def.edges.filter((e) => e.from === node.id && e.on.startsWith('route:')).map((e) => e.on.slice('route:'.length));
    for (const r of outgoingRoutes) {
      if (!declared.has(r)) {
        issues.push({
          code: 'unknown_route',
          message: `decision "${node.id}" has an edge for undeclared route "${r}"`,
        });
      }
    }
    for (const r of declared) {
      if (!outgoingRoutes.includes(r)) {
        issues.push({
          code: 'uncovered_route',
          message: `decision "${node.id}" declares route "${r}" but no edge covers it`,
        });
      }
    }
  }

  // Acyclicity (Kahn's algorithm) — only if edges reference known nodes.
  if (!issues.some((i) => i.code === 'unknown_edge_node' || i.code === 'duplicate_node_id')) {
    const indegree = new Map<string, number>(def.nodes.map((n) => [n.id, 0]));
    const adjacency = new Map<string, string[]>(def.nodes.map((n) => [n.id, []]));
    for (const edge of def.edges) {
      adjacency.get(edge.from)!.push(edge.to);
      indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
    const queue = def.nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
    let visited = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      visited += 1;
      for (const next of adjacency.get(id) ?? []) {
        const d = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, d);
        if (d === 0) queue.push(next);
      }
    }
    if (visited !== def.nodes.length) {
      issues.push({ code: 'cycle', message: 'workflow graph contains a cycle' });
    } else if (triggers.length === 1) {
      // Connectivity: every node reachable from the trigger.
      const reachable = new Set<string>();
      const stack = [triggers[0]!.id];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (reachable.has(id)) continue;
        reachable.add(id);
        for (const next of adjacency.get(id) ?? []) stack.push(next);
      }
      for (const node of def.nodes) {
        if (!reachable.has(node.id)) {
          issues.push({
            code: 'unreachable_node',
            message: `node "${node.id}" is not reachable from the trigger`,
          });
        }
      }
    }
  }

  return issues;
}

/** Full schema: shape + structural graph validation. Shared by canvas and server. */
export const workflowDefinitionSchema = workflowShape.superRefine((def, ctx) => {
  for (const issue of validateWorkflowGraph(def)) {
    ctx.addIssue({ code: 'custom', message: `${issue.code}: ${issue.message}` });
  }
});

/** Agent names referenced by the definition (existence checked server-side). */
export function collectReferencedAgents(def: WorkflowDefinition): string[] {
  const names = new Set<string>();
  for (const node of def.nodes) {
    if (node.type === 'action.agent' || node.type === 'decision.agent') names.add(node.agent);
  }
  return [...names];
}
