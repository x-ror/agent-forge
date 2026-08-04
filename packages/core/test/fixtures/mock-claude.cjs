#!/usr/bin/env node
/* Mock Claude Code CLI speaking the headless stream-json protocol. */
const readline = require('node:readline');

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('2.1.0 (mock Claude Code)');
  process.exit(0);
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const scenario = process.env.MOCK_CLAUDE_SCENARIO || 'golden';
const resumeIdx = argv.indexOf('--resume');

const inbox = [];
const waiters = [];
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const waiter = waiters.shift();
  if (waiter) waiter(message);
  else inbox.push(message);
});
const nextMessage = () =>
  new Promise((resolve) => {
    const message = inbox.shift();
    if (message) resolve(message);
    else waiters.push(resolve);
  });

const usage = { input_tokens: 42, output_tokens: 17 };

(async () => {
  const sessionId = resumeIdx >= 0 ? argv[resumeIdx + 1] : 'sess-1';
  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  await nextMessage(); // initial user prompt

  if (resumeIdx >= 0) {
    emit({
      type: 'result',
      subtype: 'success',
      result: `resumed:${sessionId}`,
      usage,
      total_cost_usd: 0.001,
    });
    process.exit(0);
  }

  if (scenario === 'golden') {
    emit({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'inspecting the repo' },
          { type: 'text', text: 'hello from claude' },
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    emit({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'README.md' }] },
    });
    emit({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: 'a.txt', content: 'x' } },
        ],
      },
    });
    emit({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'ok' }] },
    });
    emit({
      type: 'result',
      subtype: 'success',
      result: 'implemented the thing',
      usage,
      total_cost_usd: 0.0421,
    });
    process.exit(0);
  }

  if (scenario === 'permission') {
    emit({
      type: 'control_request',
      request_id: 'req-1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm x' } },
    });
    let response;
    for (;;) {
      response = await nextMessage();
      if (response.type === 'control_response') break;
    }
    const behavior =
      response.response && response.response.response && response.response.response.behavior;
    if (behavior === 'allow') {
      emit({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tuP', name: 'Bash', input: { command: 'rm x' } }],
        },
      });
      emit({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tuP', content: 'removed' }] },
      });
      emit({ type: 'result', subtype: 'success', result: 'did it', usage, total_cost_usd: 0.01 });
    } else {
      emit({
        type: 'result',
        subtype: 'success',
        result: 'skipped dangerous command',
        usage,
        total_cost_usd: 0.01,
      });
    }
    process.exit(0);
  }

  if (scenario === 'hang') {
    emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'working forever' }] },
    });
    setInterval(() => undefined, 1000); // never exits on its own
  }
})();
