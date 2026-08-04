import { describe, expect, it } from 'vitest';
import { coerceRoute, evaluateExpression, evaluateRules, matchingEdges, stepOutcome, summarizeDiff } from './engine-logic';
import type { FlowStep } from './flow-step';

function step(partial: Partial<FlowStep>): FlowStep {
  return {
    id: 's1',
    flowRunId: 'f1',
    nodeId: 'n1',
    kind: 'agent',
    status: 'running',
    runId: null,
    decision: null,
    startedAt: new Date(),
    finishedAt: null,
    ...partial,
  };
}

describe('engine logic', () => {
  it('maps step status/kind to edge outcomes', () => {
    expect(stepOutcome(step({ status: 'succeeded' }))).toBe('succeeded');
    expect(stepOutcome(step({ status: 'failed' }))).toBe('failed');
    expect(stepOutcome(step({ kind: 'decision', status: 'succeeded', decision: { route: 'deep', reasoning: 'r' } }))).toBe('route:deep');
    expect(stepOutcome(step({ kind: 'gate', status: 'succeeded', decision: { route: 'approved', reasoning: '' } }))).toBe('approved');
    expect(stepOutcome(step({ status: 'cancelled' }))).toBeNull();
  });

  it('resolves matching edges', () => {
    const def = {
      nodes: [
        { id: 'a', type: 'trigger.task_selected' as const },
        { id: 'b', type: 'action.notify' as const },
        { id: 'c', type: 'action.notify' as const },
      ],
      edges: [
        { from: 'a', to: 'b', on: 'succeeded' },
        { from: 'a', to: 'c', on: 'failed' },
      ],
    };
    expect(matchingEdges(def, 'a', 'succeeded').map((e) => e.to)).toEqual(['b']);
    expect(matchingEdges(def, 'a', 'failed').map((e) => e.to)).toEqual(['c']);
  });

  it('coerces structured decisions to declared routes', () => {
    expect(coerceRoute(['deep', 'light'], { route: 'deep', reasoning: 'big diff' }, '')).toEqual({
      route: 'deep',
      reasoning: 'big diff',
    });
    expect(coerceRoute(['deep', 'light'], { route: 'DEEP', reasoning: 'x' }, '')?.route).toBe('deep');
    // Fallback: unique route mentioned in the summary.
    expect(coerceRoute(['deep', 'light'], null, 'I recommend a light review')?.route).toBe('light');
    // Ambiguous or absent → null (step fails, honestly).
    expect(coerceRoute(['deep', 'light'], null, 'deep or light, who knows')).toBeNull();
    expect(coerceRoute(['deep', 'light'], { route: 'medium' }, 'nothing useful')).toBeNull();
  });

  it('evaluates rule expressions against the context', () => {
    const context = {
      steps: { implement: { diff_lines: 420, summary: 'touched auth and migrations' } },
    };
    expect(evaluateExpression('steps.implement.diff_lines > 300', context)).toBe(true);
    expect(evaluateExpression('steps.implement.diff_lines <= 300', context)).toBe(false);
    expect(evaluateExpression("steps.implement.summary contains 'auth'", context)).toBe(true);
    expect(evaluateExpression("steps.implement.summary == 'nope'", context)).toBe(false);
    expect(evaluateExpression('nonsense garbage', context)).toBe(false);

    expect(
      evaluateRules(
        [
          { when: 'steps.implement.diff_lines > 1000', route: 'deep' },
          { when: "steps.implement.summary contains 'auth'", route: 'deep' },
        ],
        'light',
        context,
      ),
    ).toEqual({ route: 'deep', reasoning: "rule matched: steps.implement.summary contains 'auth'" });
    expect(evaluateRules([{ when: 'x > 1', route: 'a' }], 'b', {})?.route).toBe('b');
    expect(evaluateRules([{ when: 'x > 1', route: 'a' }], undefined, {})).toBeNull();
  });

  it('summarizes diffs', () => {
    const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -1,2 +1,3 @@', '+added line', '+another', '-removed'].join('\n');
    expect(summarizeDiff(diff)).toBe('1 file(s) changed, +2/-1 lines: x.ts');
  });
});
