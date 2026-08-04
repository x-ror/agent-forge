import { describe, expect, it } from 'vitest';
import { canonicalWorkflowTemplate, workflowDefinitionSchema } from '@agentforge/core';
import { defaultEdgeCondition, defToFlow, flowToDef } from './graph';

describe('canvas graph conversion', () => {
  it('round-trips the canonical template def → flow → def', () => {
    const { nodes, edges } = defToFlow(canonicalWorkflowTemplate.definition);
    expect(nodes).toHaveLength(canonicalWorkflowTemplate.definition.nodes.length);
    const back = flowToDef(nodes, edges);
    expect(workflowDefinitionSchema.safeParse(back).success).toBe(true);
    expect(back.edges).toEqual(canonicalWorkflowTemplate.definition.edges);
    expect(back.nodes.map((n) => n.id).sort()).toEqual(canonicalWorkflowTemplate.definition.nodes.map((n) => n.id).sort());
  });

  it('lays out nodes by BFS depth (left to right)', () => {
    const { nodes } = defToFlow(canonicalWorkflowTemplate.definition);
    const x = new Map(nodes.map((n) => [n.id, n.position.x]));
    expect(x.get('start')!).toBeLessThan(x.get('worktree')!);
    expect(x.get('worktree')!).toBeLessThan(x.get('implement')!);
    expect(x.get('triage')!).toBeLessThan(x.get('deep')!);
  });

  it('picks sensible default edge conditions per source node type', () => {
    expect(defaultEdgeCondition({ id: 'a', type: 'action.agent', agent: 'X', prompt: 'p' }, [])).toBe('succeeded');
    expect(defaultEdgeCondition({ id: 'g', type: 'gate.human' }, [])).toBe('approved');
    expect(defaultEdgeCondition({ id: 'g', type: 'gate.human' }, [{ id: 'e1', source: 'g', target: 'x', label: 'approved' }])).toBe('rejected');
    const decision = { id: 'd', type: 'decision.agent' as const, agent: 'T', prompt: 'p', routes: ['deep', 'light'] };
    expect(defaultEdgeCondition(decision, [])).toBe('route:deep');
    expect(defaultEdgeCondition(decision, [{ id: 'e1', source: 'd', target: 'x', label: 'route:deep' }])).toBe('route:light');
  });
});
