import { describe, expect, it } from 'vitest';
import { AGENT_EVENT_TYPES, agentEventSchema } from '../src';

describe('agentEventSchema', () => {
  it('accepts all nine protocol event types', () => {
    const samples = [
      { type: 'agent.message', text: 'hello' },
      { type: 'agent.thinking', text: 'hmm' },
      { type: 'tool.start', tool: 'run_command', detail: { cmd: 'ls' } },
      { type: 'tool.end', tool: 'run_command', ok: true, output: 'a.txt' },
      { type: 'file.change', path: 'src/a.ts', diff: '--- a\n+++ b' },
      { type: 'permission.request', id: 'p1', action: 'run_command', detail: { cmd: 'rm' } },
      { type: 'usage', tokensIn: 10, tokensOut: 20, costUsd: 0.01 },
      { type: 'result', outcome: 'success', summary: 'done', structured: { route: 'deep' } },
      { type: 'fatal', error: 'boom' },
    ];
    expect(samples).toHaveLength(AGENT_EVENT_TYPES.length);
    for (const sample of samples) {
      expect(agentEventSchema.parse(sample).type).toBe(sample.type);
    }
  });

  it('rejects unknown event types and malformed payloads', () => {
    expect(agentEventSchema.safeParse({ type: 'nope', text: 'x' }).success).toBe(false);
    expect(agentEventSchema.safeParse({ type: 'usage', tokensIn: -1, tokensOut: 0 }).success).toBe(
      false,
    );
    expect(agentEventSchema.safeParse({ type: 'result', outcome: 'meh', summary: '' }).success).toBe(
      false,
    );
  });
});
