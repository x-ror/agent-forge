import type { WorkflowDefinition } from './schema';

/**
 * The canonical Implement → Triage → Review → PR workflow (design doc §7.2).
 * Shipped as a seed template; also the fixture the engine e2e runs.
 */
/**
 * Canonical + a human gate before the PR — the recommended default for flows
 * fed by external task sources (design doc §12, prompt-injection stance).
 */
export function gatedWorkflowTemplate(): { name: string; definition: WorkflowDefinition } {
  const base = canonicalWorkflowTemplate.definition;
  return {
    name: 'Implement → Review → Gate → PR',
    definition: {
      nodes: [
        ...base.nodes.filter((n) => n.id !== 'pr'),
        { id: 'gate', type: 'gate.human', message: 'Review the diff before the PR is opened.' },
        ...base.nodes.filter((n) => n.id === 'pr'),
      ],
      edges: [
        ...base.edges.filter((e) => e.to !== 'pr'),
        { from: 'deep', to: 'gate', on: 'succeeded' },
        { from: 'light', to: 'gate', on: 'succeeded' },
        { from: 'gate', to: 'pr', on: 'approved' },
      ].filter((e, i, all) => all.findIndex((o) => o.from === e.from && o.to === e.to && o.on === e.on) === i),
    },
  };
}

export const canonicalWorkflowTemplate: { name: string; definition: WorkflowDefinition } = {
  name: 'Implement → Review → PR',
  definition: {
    nodes: [
      { id: 'start', type: 'trigger.task_selected' },
      { id: 'worktree', type: 'action.create_worktree' },
      {
        id: 'implement',
        type: 'action.agent',
        agent: 'Implementer',
        prompt: 'Implement this task:\n{{task.title}}\n\n{{task.body}}',
      },
      {
        id: 'triage',
        type: 'decision.agent',
        agent: 'Review Triage',
        routes: ['deep', 'light'],
        prompt: 'Deep review (security/arch impact, >300 lines, auth or migrations touched) or light?\n{{steps.implement.diff_summary}}',
      },
      {
        id: 'deep',
        type: 'action.agent',
        agent: 'Reviewer',
        prompt: 'Thorough line-by-line review. Fix findings or report blockers.\n{{steps.implement.diff}}',
      },
      {
        id: 'light',
        type: 'action.agent',
        agent: 'Reviewer',
        prompt: 'Quick sanity review: obvious bugs, missing tests.\n{{steps.implement.diff}}',
      },
      { id: 'pr', type: 'action.open_pr', title: '{{task.externalKey}}: {{task.title}}' },
    ],
    edges: [
      { from: 'start', to: 'worktree', on: 'succeeded' },
      { from: 'worktree', to: 'implement', on: 'succeeded' },
      { from: 'implement', to: 'triage', on: 'succeeded' },
      { from: 'triage', to: 'deep', on: 'route:deep' },
      { from: 'triage', to: 'light', on: 'route:light' },
      { from: 'deep', to: 'pr', on: 'succeeded' },
      { from: 'light', to: 'pr', on: 'succeeded' },
    ],
  },
};
