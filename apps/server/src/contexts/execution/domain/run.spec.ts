import { describe, expect, it } from 'vitest';
import { IllegalRunTransitionError, Run } from './run';

function freshRun(): Run {
  return Run.create({ id: 'r1', projectId: 'p1', agentId: 'a1', taskPrompt: 't', baseRef: 'main' });
}

describe('Run state machine (§3.1)', () => {
  it('walks the happy path queued → … → succeeded', () => {
    const run = freshRun();
    expect(run.status).toBe('queued');
    run.startProvisioning();
    run.markRunning();
    run.awaitInput();
    run.resumeRunning();
    run.beginFinalizing();
    run.succeed();
    expect(run.status).toBe('succeeded');
    expect(run.finishedAt).not.toBeNull();
    expect(run.leaseAt).toBeNull();
  });

  it('rejects illegal transitions with a domain error', () => {
    const run = freshRun();
    expect(() => run.succeed()).toThrow(IllegalRunTransitionError);
    expect(() => run.markRunning()).toThrow(IllegalRunTransitionError);
    run.startProvisioning();
    expect(() => run.awaitInput()).toThrow(IllegalRunTransitionError);
  });

  it('terminal states accept no further transitions', () => {
    const run = freshRun();
    run.cancel();
    expect(run.status).toBe('cancelled');
    expect(() => run.startProvisioning()).toThrow(IllegalRunTransitionError);
    expect(() => run.fail('x')).toThrow(IllegalRunTransitionError);
  });

  it('fail() records the error and releases the lease', () => {
    const run = freshRun();
    run.startProvisioning();
    run.heartbeat();
    expect(run.leaseAt).not.toBeNull();
    run.fail('sandbox exploded');
    expect(run.status).toBe('failed');
    expect(run.error).toBe('sandbox exploded');
    expect(run.leaseAt).toBeNull();
  });

  it('accumulates usage across merges', () => {
    const run = freshRun();
    run.mergeUsage({ tokensIn: 10, tokensOut: 5 });
    run.mergeUsage({ tokensIn: 7, tokensOut: 3, costUsd: 0.02 });
    expect(run.usage).toMatchObject({ tokensIn: 17, tokensOut: 8, costUsd: 0.02 });
  });
});
