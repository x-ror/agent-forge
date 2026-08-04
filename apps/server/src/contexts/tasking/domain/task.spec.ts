import { describe, expect, it } from 'vitest';
import { assertTaskTransition, IllegalTaskTransitionError } from './task';

describe('Task lifecycle (§3.1)', () => {
  it('allows backlog → in_flow → done → archived', () => {
    assertTaskTransition('backlog', 'in_flow');
    assertTaskTransition('in_flow', 'done');
    assertTaskTransition('done', 'archived');
  });

  it('allows failed → backlog retry', () => {
    assertTaskTransition('in_flow', 'failed');
    assertTaskTransition('failed', 'backlog');
  });

  it('rejects nonsense moves', () => {
    expect(() => assertTaskTransition('backlog', 'done')).toThrow(IllegalTaskTransitionError);
    expect(() => assertTaskTransition('archived', 'backlog')).toThrow(IllegalTaskTransitionError);
    expect(() => assertTaskTransition('done', 'in_flow')).toThrow(IllegalTaskTransitionError);
  });
});
