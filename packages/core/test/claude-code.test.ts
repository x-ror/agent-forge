import { chmodSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../src';
import { collectEvents, expectEventOrder, LocalSandbox, makeRunContext } from '../src/conformance';

const CLI = path.join(__dirname, 'fixtures', 'mock-claude.cjs');
chmodSync(CLI, 0o755);

function ctxFor(sandbox: LocalSandbox, scenario: string) {
  return makeRunContext({
    sandbox,
    env: { MOCK_CLAUDE_SCENARIO: scenario },
    config: { options: { cliPath: CLI } },
  });
}

describe('claude-code conformance', () => {
  it('--version handshake fails loudly for a broken CLI', async () => {
    const sandbox = await LocalSandbox.create();
    const adapter = new ClaudeCodeAdapter();
    await expect(adapter.start(makeRunContext({ sandbox, config: { options: { cliPath: '/bin/false' } } }))).rejects.toThrow(/--version.*failed/);
  });

  it('golden event sequence maps the stream-json protocol to the 9-event union', async () => {
    const sandbox = await LocalSandbox.create();
    const adapter = new ClaudeCodeAdapter();
    const handle = await adapter.start(ctxFor(sandbox, 'golden'));
    const events = await collectEvents(handle);

    expectEventOrder(events, ['agent.thinking', 'agent.message', 'tool.start', 'tool.end', 'tool.start', 'file.change', 'tool.end', 'usage', 'result']);
    const usage = events.find((e) => e.type === 'usage');
    expect(usage && 'costUsd' in usage && usage.costUsd).toBeCloseTo(0.0421);
    const fileChange = events.find((e) => e.type === 'file.change');
    expect(fileChange && 'path' in fileChange && fileChange.path).toBe('a.txt');
    const result = events.find((e) => e.type === 'result');
    expect(result && 'outcome' in result && result.outcome).toBe('success');
    expect(handle.getResumeState?.()).toEqual({ sessionId: 'sess-1' });
  });

  it('permission gate: allow path runs the tool, deny path skips it', async () => {
    const adapter = new ClaudeCodeAdapter();

    const sandboxAllow = await LocalSandbox.create();
    const allowHandle = await adapter.start(ctxFor(sandboxAllow, 'permission'));
    const allowEvents = await collectEvents(allowHandle, {
      onEvent: async (event) => {
        if (event.type === 'permission.request') {
          expect(event.action).toBe('Bash');
          await allowHandle.respondToPermission(event.id, 'allow');
        }
      },
    });
    expectEventOrder(allowEvents, ['permission.request', 'tool.start', 'tool.end', 'result']);
    const allowResult = allowEvents.find((e) => e.type === 'result');
    expect(allowResult && 'summary' in allowResult && allowResult.summary).toBe('did it');

    const sandboxDeny = await LocalSandbox.create();
    const denyHandle = await adapter.start(ctxFor(sandboxDeny, 'permission'));
    const denyEvents = await collectEvents(denyHandle, {
      onEvent: async (event) => {
        if (event.type === 'permission.request') {
          await denyHandle.respondToPermission(event.id, 'deny', 'too risky');
        }
      },
    });
    const denyResult = denyEvents.find((e) => e.type === 'result');
    expect(denyResult && 'summary' in denyResult && denyResult.summary).toBe('skipped dangerous command');
    expect(denyEvents.some((e) => e.type === 'tool.start')).toBe(false);
  });

  it('clean cancellation kills the CLI and ends the stream', async () => {
    const sandbox = await LocalSandbox.create();
    const adapter = new ClaudeCodeAdapter();
    const handle = await adapter.start(ctxFor(sandbox, 'hang'));
    const started = Date.now();
    const events = await collectEvents(handle, {
      timeoutMs: 15_000,
      onEvent: async (event) => {
        if (event.type === 'agent.message') void handle.stop('cancelled');
      },
    });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(events.some((e) => e.type === 'result')).toBe(false);
  });

  it('resume relaunches with --resume <sessionId>', async () => {
    const sandbox = await LocalSandbox.create();
    const adapter = new ClaudeCodeAdapter();
    const handle = await adapter.resume(ctxFor(sandbox, 'golden'), {
      data: { sessionId: 'sess-9' },
    });
    const events = await collectEvents(handle);
    const result = events.find((e) => e.type === 'result');
    expect(result && 'summary' in result && result.summary).toBe('resumed:sess-9');
  });
});
