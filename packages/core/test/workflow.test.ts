import { describe, expect, it } from 'vitest';
import { collectReferencedAgents, validateWorkflowGraph, workflowDefinitionSchema, type WorkflowDefinition } from '../src';

/** The canonical example from design doc §7.2 — must always validate. */
export const canonicalWorkflow: WorkflowDefinition = {
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
      prompt: 'Deep review or light?\n{{steps.implement.diff_summary}}',
    },
    {
      id: 'deep',
      type: 'action.agent',
      agent: 'Reviewer',
      prompt: 'Thorough line-by-line review.\n{{steps.implement.diff}}',
    },
    {
      id: 'light',
      type: 'action.agent',
      agent: 'Reviewer',
      prompt: 'Quick sanity review.\n{{steps.implement.diff}}',
    },
    { id: 'pr', type: 'action.open_pr', title: '{{task.external_key}}: {{task.title}}' },
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
};

describe('workflowDefinitionSchema', () => {
  it('accepts the canonical workflow', () => {
    const parsed = workflowDefinitionSchema.parse(canonicalWorkflow);
    expect(parsed.nodes).toHaveLength(7);
    expect(collectReferencedAgents(parsed)).toEqual(['Implementer', 'Review Triage', 'Reviewer']);
  });

  it('rejects a workflow with no trigger', () => {
    const def = {
      nodes: [{ id: 'a', type: 'action.create_worktree' }],
      edges: [],
    };
    const res = workflowDefinitionSchema.safeParse(def);
    expect(res.success).toBe(false);
  });

  it('rejects multiple triggers', () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: 't1', type: 'trigger.task_selected' },
        { id: 't2', type: 'trigger.schedule' },
      ],
      edges: [],
    };
    expect(validateWorkflowGraph(def).map((i) => i.code)).toContain('multiple_triggers');
  });

  it('rejects cycles', () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: 'start', type: 'trigger.task_selected' },
        { id: 'a', type: 'action.agent', agent: 'X', prompt: 'p' },
        { id: 'b', type: 'action.agent', agent: 'X', prompt: 'p' },
      ],
      edges: [
        { from: 'start', to: 'a', on: 'succeeded' },
        { from: 'a', to: 'b', on: 'succeeded' },
        { from: 'b', to: 'a', on: 'succeeded' },
      ],
    };
    expect(validateWorkflowGraph(def).map((i) => i.code)).toContain('cycle');
  });

  it('rejects unreachable nodes', () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: 'start', type: 'trigger.task_selected' },
        { id: 'island', type: 'action.notify' },
      ],
      edges: [],
    };
    expect(validateWorkflowGraph(def).map((i) => i.code)).toContain('unreachable_node');
  });

  it('requires every declared route to be covered by an edge', () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: 'start', type: 'trigger.task_selected' },
        { id: 'd', type: 'decision.agent', agent: 'T', prompt: 'p', routes: ['a', 'b'] },
        { id: 'na', type: 'action.notify' },
      ],
      edges: [
        { from: 'start', to: 'd', on: 'succeeded' },
        { from: 'd', to: 'na', on: 'route:a' },
      ],
    };
    expect(validateWorkflowGraph(def).map((i) => i.code)).toContain('uncovered_route');
  });

  it('rejects edges whose condition does not fit the source node', () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: 'start', type: 'trigger.task_selected' },
        { id: 'g', type: 'gate.human' },
        { id: 'n', type: 'action.notify' },
      ],
      edges: [
        { from: 'start', to: 'g', on: 'succeeded' },
        { from: 'g', to: 'n', on: 'succeeded' },
      ],
    };
    expect(validateWorkflowGraph(def).map((i) => i.code)).toContain('invalid_edge_condition');
  });

  it('rejects trigger nodes with incoming edges', () => {
    const def: WorkflowDefinition = {
      nodes: [
        { id: 'start', type: 'trigger.task_selected' },
        { id: 'n', type: 'action.notify' },
      ],
      edges: [
        { from: 'start', to: 'n', on: 'succeeded' },
        { from: 'n', to: 'start', on: 'succeeded' },
      ],
    };
    expect(validateWorkflowGraph(def).map((i) => i.code)).toContain('trigger_has_incoming');
  });
});
