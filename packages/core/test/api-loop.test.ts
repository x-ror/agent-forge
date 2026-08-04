import { describe, expect, it } from 'vitest';
import { ApiLoopAdapter } from '../src';
import { collectEvents, expectEventOrder, LocalSandbox, makeRunContext } from '../src/conformance';
import { startMockLlm } from '../src/conformance';

const KEY_ENV = { ANTHROPIC_API_KEY: 'test-key', OPENAI_API_KEY: 'test-key' };

describe('api-loop conformance', () => {
  it('golden event sequence: messages, tools, file change, usage, result (anthropic)', async () => {
    const llm = await startMockLlm();
    const sandbox = await LocalSandbox.create();
    try {
      llm.pushAnthropic({
        blocks: [
          { type: 'thinking', thinking: 'let me look around' },
          { type: 'text', text: 'starting work' },
          { type: 'tool_use', id: 't1', name: 'run_command', input: { command: 'echo hello' } },
        ],
      });
      llm.pushAnthropic({
        blocks: [
          {
            type: 'tool_use',
            id: 't2',
            name: 'write_file',
            input: { path: 'notes.txt', content: 'a note' },
          },
        ],
      });
      llm.pushAnthropic({ blocks: [{ type: 'text', text: 'all done, wrote notes.txt' }] });

      const adapter = new ApiLoopAdapter();
      const ctx = makeRunContext({
        sandbox,
        env: KEY_ENV,
        config: {
          model: 'mock-model',
          allowedCommands: ['echo'],
          options: { provider: 'anthropic', baseUrl: llm.url },
        },
      });
      const handle = await adapter.start(ctx);
      const events = await collectEvents(handle);

      expectEventOrder(events, ['usage', 'agent.thinking', 'agent.message', 'tool.start', 'tool.end', 'tool.start', 'file.change', 'tool.end', 'result']);
      const toolEnd = events.find((e) => e.type === 'tool.end');
      expect(toolEnd && 'output' in toolEnd && toolEnd.output).toContain('hello');
      expect(await sandbox.readFile('notes.txt')).toBe('a note');
      const result = events.find((e) => e.type === 'result');
      expect(result && 'outcome' in result && result.outcome).toBe('success');
    } finally {
      await llm.close();
    }
  });

  it('permission gate: non-allowed command asks; deny short-circuits, allow executes', async () => {
    const llm = await startMockLlm();
    const sandbox = await LocalSandbox.create();
    try {
      // Round 1: denied.
      llm.pushAnthropic({
        blocks: [{ type: 'tool_use', id: 'x1', name: 'run_command', input: { command: 'rm -rf /' } }],
      });
      llm.pushAnthropic({ blocks: [{ type: 'text', text: 'understood, stopping' }] });

      const adapter = new ApiLoopAdapter();
      const ctx = makeRunContext({
        sandbox,
        env: KEY_ENV,
        config: { allowedCommands: ['echo'], options: { baseUrl: llm.url } },
      });
      const handle = await adapter.start(ctx);
      const events = await collectEvents(handle, {
        onEvent: async (event) => {
          if (event.type === 'permission.request') {
            await handle.respondToPermission(event.id, 'deny');
          }
        },
      });
      expectEventOrder(events, ['tool.start', 'permission.request', 'tool.end', 'result']);
      const end = events.find((e) => e.type === 'tool.end');
      expect(end && 'ok' in end && end.ok).toBe(false);

      // Round 2: allowed → the command actually runs.
      llm.pushAnthropic({
        blocks: [{ type: 'tool_use', id: 'x2', name: 'run_command', input: { command: 'printf approved' } }],
      });
      llm.pushAnthropic({ blocks: [{ type: 'text', text: 'done' }] });
      const handle2 = await adapter.start(ctx);
      const events2 = await collectEvents(handle2, {
        onEvent: async (event) => {
          if (event.type === 'permission.request') {
            await handle2.respondToPermission(event.id, 'allow');
          }
        },
      });
      const end2 = events2.find((e) => e.type === 'tool.end');
      expect(end2 && 'ok' in end2 && end2.ok).toBe(true);
      expect(end2 && 'output' in end2 && end2.output).toContain('approved');
    } finally {
      await llm.close();
    }
  });

  it('clean cancellation: stop() ends the stream promptly without a result', async () => {
    const llm = await startMockLlm();
    const sandbox = await LocalSandbox.create();
    try {
      llm.pushAnthropic({ blocks: [{ type: 'text', text: 'slow…' }], delayMs: 5000 });
      const adapter = new ApiLoopAdapter();
      const handle = await adapter.start(makeRunContext({ sandbox, env: KEY_ENV, config: { options: { baseUrl: llm.url } } }));
      const started = Date.now();
      setTimeout(() => void handle.stop('cancelled'), 200);
      const events = await collectEvents(handle, { timeoutMs: 10_000 });
      expect(Date.now() - started).toBeLessThan(3000);
      expect(events.some((e) => e.type === 'result')).toBe(false);
    } finally {
      await llm.close();
    }
  });

  it('structured output: decision constrained to routes with reasoning', async () => {
    const llm = await startMockLlm();
    const sandbox = await LocalSandbox.create();
    try {
      llm.pushAnthropic({
        blocks: [
          {
            type: 'tool_use',
            id: 'd1',
            name: 'decide',
            input: { route: 'deep', reasoning: 'auth files were touched' },
          },
        ],
      });
      const adapter = new ApiLoopAdapter();
      const handle = await adapter.start(
        makeRunContext({
          sandbox,
          env: KEY_ENV,
          structuredRoutes: ['deep', 'light'],
          config: { options: { baseUrl: llm.url } },
        }),
      );
      const events = await collectEvents(handle);
      const result = events.find((e) => e.type === 'result');
      expect(result && 'structured' in result && result.structured).toEqual({
        route: 'deep',
        reasoning: 'auth files were touched',
      });
      // The decide tool schema advertised the declared routes to the model.
      const request = llm.requests[0] as {
        body: { tools: Array<{ name: string; input_schema: { properties: { route: { enum: string[] } } } }> };
      };
      const decide = request.body.tools.find((t) => t.name === 'decide');
      expect(decide?.input_schema.properties.route.enum).toEqual(['deep', 'light']);
    } finally {
      await llm.close();
    }
  });

  it('openai-compatible provider speaks chat/completions with tool calls', async () => {
    const llm = await startMockLlm();
    const sandbox = await LocalSandbox.create();
    try {
      llm.pushOpenAi({
        content: 'checking',
        toolCalls: [{ id: 'c1', name: 'run_command', args: { command: 'echo from-openai' } }],
      });
      llm.pushOpenAi({ content: 'finished' });
      const adapter = new ApiLoopAdapter();
      const handle = await adapter.start(
        makeRunContext({
          sandbox,
          env: KEY_ENV,
          config: {
            model: 'gpt-mock',
            allowedCommands: ['echo'],
            options: { provider: 'openai', baseUrl: llm.url },
          },
        }),
      );
      const events = await collectEvents(handle);
      expectEventOrder(events, ['agent.message', 'tool.start', 'tool.end', 'result']);
      const end = events.find((e) => e.type === 'tool.end');
      expect(end && 'output' in end && end.output).toContain('from-openai');
    } finally {
      await llm.close();
    }
  });

  it('resume replays the transcript and continues to completion', async () => {
    const llm = await startMockLlm();
    const sandbox = await LocalSandbox.create();
    try {
      llm.pushAnthropic({
        blocks: [{ type: 'tool_use', id: 'r1', name: 'write_file', input: { path: 'x.txt', content: 'v1' } }],
      });
      const adapter = new ApiLoopAdapter();
      const ctx = makeRunContext({
        sandbox,
        env: KEY_ENV,
        config: { options: { baseUrl: llm.url } },
      });
      const handle = await adapter.start(ctx);
      // Consume through the first tool round, then "crash".
      await collectEvents(handle, { until: (events) => events.some((e) => e.type === 'tool.end') });
      const state = handle.getResumeState?.();
      expect(state).toBeTruthy();
      await handle.stop('shutdown');

      llm.pushAnthropic({ blocks: [{ type: 'text', text: 'picking up where I left off; done' }] });
      const resumed = await adapter.resume(ctx, { data: state! });
      const events = await collectEvents(resumed);
      const result = events.find((e) => e.type === 'result');
      expect(result && 'summary' in result && result.summary).toContain('picking up');
      // The replayed transcript included the pre-crash tool exchange.
      const lastRequest = llm.requests.at(-1) as {
        body: { messages: Array<{ content: Array<{ type: string }> }> };
      };
      const blockTypes = lastRequest.body.messages.flatMap((m) => m.content.map((c) => c.type));
      expect(blockTypes).toContain('tool_use');
      expect(blockTypes).toContain('tool_result');
    } finally {
      await llm.close();
    }
  });

  it('missing API key fails at start, loudly', async () => {
    const sandbox = await LocalSandbox.create();
    const adapter = new ApiLoopAdapter();
    await expect(adapter.start(makeRunContext({ sandbox, env: {}, config: {} }))).rejects.toThrow(/missing API key/);
  });
});
