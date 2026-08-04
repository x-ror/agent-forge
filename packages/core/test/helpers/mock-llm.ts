import http from 'node:http';
import type { AddressInfo } from 'node:net';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

interface AnthropicTurn {
  blocks: AnthropicBlock[];
  delayMs?: number;
}

interface OpenAiTurn {
  content?: string;
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  delayMs?: number;
}

export interface MockLlm {
  url: string;
  requests: unknown[];
  pushAnthropic(turn: AnthropicTurn): void;
  pushOpenAi(turn: OpenAiTurn): void;
  close(): Promise<void>;
}

/** Scripted Anthropic Messages + OpenAI chat-completions endpoints. */
export async function startMockLlm(): Promise<MockLlm> {
  const anthropicQueue: AnthropicTurn[] = [];
  const openaiQueue: OpenAiTurn[] = [];
  const requests: unknown[] = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      requests.push({ path: req.url, body: parsed });

      const respond = (payload: unknown, delayMs = 0): void => {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        }, delayMs);
      };

      if (req.url === '/v1/messages') {
        const turn = anthropicQueue.shift();
        if (!turn) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'mock: anthropic queue empty' }));
          return;
        }
        respond(
          {
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            content: turn.blocks,
            stop_reason: turn.blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
            usage: { input_tokens: 11, output_tokens: 7 },
          },
          turn.delayMs,
        );
        return;
      }

      if (req.url === '/v1/chat/completions') {
        const turn = openaiQueue.shift();
        if (!turn) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'mock: openai queue empty' }));
          return;
        }
        respond(
          {
            id: 'chatcmpl_mock',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: turn.content ?? null,
                  ...(turn.toolCalls
                    ? {
                        tool_calls: turn.toolCalls.map((c) => ({
                          id: c.id,
                          type: 'function',
                          function: { name: c.name, arguments: JSON.stringify(c.args) },
                        })),
                      }
                    : {}),
                },
                finish_reason: turn.toolCalls ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: 13, completion_tokens: 5 },
          },
          turn.delayMs,
        );
        return;
      }

      res.writeHead(404);
      res.end('{}');
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    pushAnthropic: (turn) => anthropicQueue.push(turn),
    pushOpenAi: (turn) => openaiQueue.push(turn),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
