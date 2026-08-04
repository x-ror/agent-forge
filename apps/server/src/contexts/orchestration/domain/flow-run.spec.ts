import { describe, expect, it } from 'vitest';
import { FlowRun, IllegalFlowTransitionError } from './flow-run';

function freshFlow(): FlowRun {
  return FlowRun.create({ id: 'f1', workflowId: 'w1', taskId: 't1' });
}

describe('FlowRun state machine (§3.1)', () => {
  it('running ⇄ awaiting_input → succeeded', () => {
    const flow = freshFlow();
    expect(flow.status).toBe('running');
    flow.awaitInput();
    flow.resume();
    flow.succeed();
    expect(flow.status).toBe('succeeded');
    expect(flow.finishedAt).not.toBeNull();
  });

  it('cannot succeed while awaiting input', () => {
    const flow = freshFlow();
    flow.awaitInput();
    expect(() => flow.succeed()).toThrow(IllegalFlowTransitionError);
  });

  it('terminal states are final', () => {
    const flow = freshFlow();
    flow.fail();
    expect(() => flow.resume()).toThrow(IllegalFlowTransitionError);
    expect(() => flow.cancel()).toThrow(IllegalFlowTransitionError);
  });

  it('context accumulates via merge', () => {
    const flow = freshFlow();
    flow.mergeContext({ worktree: '/w' });
    flow.mergeContext({ steps: { implement: { summary: 'ok' } } });
    expect(flow.context).toEqual({ worktree: '/w', steps: { implement: { summary: 'ok' } } });
  });
});
