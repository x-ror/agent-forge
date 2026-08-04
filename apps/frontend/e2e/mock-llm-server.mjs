// Scripted Anthropic Messages endpoint + /__push control endpoint.
import http from 'node:http';

const port = Number(process.argv[2] ?? 0);
const queue = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.url === '/__push' && req.method === 'POST') {
      queue.push(JSON.parse(body));
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === '/v1/messages' && req.method === 'POST') {
      const turn = queue.shift();
      if (!turn) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'mock llm queue empty' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          content: turn.blocks,
          stop_reason: turn.blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`MOCK_LLM_PORT=${server.address().port}`);
});
