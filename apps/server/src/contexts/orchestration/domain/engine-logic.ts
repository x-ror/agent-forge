import type { Json, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agentforge/core';
import type { FlowStep } from './flow-step';

/**
 * Pure engine logic (no IO): step outcomes, edge resolution, decision
 * coercion, rule evaluation, diff summarization. The FlowEngine service
 * wires this to persistence.
 */

/** The edge condition a terminal step produces, or null when it ends the flow. */
export function stepOutcome(step: FlowStep): string | null {
  if (step.status === 'succeeded') {
    if (step.kind === 'decision' && step.decision) return `route:${step.decision.route}`;
    if (step.kind === 'gate' && step.decision) {
      return step.decision.route === 'approved' ? 'approved' : 'rejected';
    }
    return 'succeeded';
  }
  if (step.status === 'failed') return 'failed';
  return null; // cancelled/skipped: no path continues
}

export function matchingEdges(def: WorkflowDefinition, nodeId: string, outcome: string): WorkflowEdge[] {
  return def.edges.filter((edge) => edge.from === nodeId && edge.on === outcome);
}

export function nodeById(def: WorkflowDefinition, nodeId: string): WorkflowNode | undefined {
  return def.nodes.find((node) => node.id === nodeId);
}

export function stepKindFor(node: WorkflowNode): FlowStep['kind'] {
  if (node.type.startsWith('trigger.')) return 'trigger';
  if (node.type === 'action.agent') return 'agent';
  if (node.type.startsWith('decision.')) return 'decision';
  if (node.type === 'gate.human') return 'gate';
  if (node.type === 'gate.quality') return 'quality';
  return 'action';
}

/**
 * Coerce a decision run's structured output to a declared route (§7.3).
 * Falls back to scanning the summary text for exactly one route name.
 */
export function coerceRoute(routes: string[], structured: Json | null | undefined, summary: string): { route: string; reasoning: string } | null {
  if (structured !== null && typeof structured === 'object' && !Array.isArray(structured)) {
    const record = structured as { route?: unknown; reasoning?: unknown };
    const raw = String(record.route ?? '');
    const exact = routes.find((r) => r === raw) ?? routes.find((r) => r.toLowerCase() === raw.toLowerCase());
    if (exact) {
      return { route: exact, reasoning: String(record.reasoning ?? summary) };
    }
  }
  const mentioned = routes.filter((route) => new RegExp(`\\b${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(summary));
  if (mentioned.length === 1) {
    return { route: mentioned[0]!, reasoning: summary };
  }
  return null;
}

/**
 * decision.rule evaluation: first matching `when` wins. Expressions are
 * `<context.path> <op> <literal>` with ops ==, !=, >, >=, <, <=, contains.
 */
export function evaluateRules(rules: Array<{ when: string; route: string }>, defaultRoute: string | undefined, context: Json): { route: string; reasoning: string } | null {
  for (const rule of rules) {
    if (evaluateExpression(rule.when, context)) {
      return { route: rule.route, reasoning: `rule matched: ${rule.when}` };
    }
  }
  if (defaultRoute) return { route: defaultRoute, reasoning: 'no rule matched; default route' };
  return null;
}

export function evaluateExpression(expression: string, context: Json): boolean {
  const match = /^\s*([\w.$-]+)\s*(==|!=|>=|<=|>|<|contains)\s*(.+?)\s*$/.exec(expression);
  if (!match) return false;
  const [, path, op, rawValue] = match;
  const left = resolvePath(context, path!);
  const right = parseLiteral(rawValue!);

  switch (op) {
    case '==':
      return looseEquals(left, right);
    case '!=':
      return !looseEquals(left, right);
    case 'contains':
      return typeof left === 'string' && left.includes(String(right));
    default: {
      const l = Number(left);
      const r = Number(right);
      if (Number.isNaN(l) || Number.isNaN(r)) return false;
      if (op === '>') return l > r;
      if (op === '>=') return l >= r;
      if (op === '<') return l < r;
      return l <= r;
    }
  }
}

function looseEquals(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return a === b;
}

function resolvePath(context: Json, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc !== null && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), context);
}

function parseLiteral(raw: string): unknown {
  const trimmed = raw.trim();
  if (/^'.*'$/.test(trimmed) || /^".*"$/.test(trimmed)) return trimmed.slice(1, -1);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const num = Number(trimmed);
  return Number.isNaN(num) ? trimmed : num;
}

const DIFF_CONTEXT_CAP = 50_000;

/** Summarize a unified diff: files + added/removed line counts. */
export function summarizeDiff(diff: string): string {
  const files: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) files.push(line.slice(6));
    else if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }
  return `${files.length} file(s) changed, +${added}/-${removed} lines: ${files.join(', ')}`;
}

export function capDiff(diff: string): string {
  return diff.length > DIFF_CONTEXT_CAP ? `${diff.slice(0, DIFF_CONTEXT_CAP)}\n…[truncated]` : diff;
}
