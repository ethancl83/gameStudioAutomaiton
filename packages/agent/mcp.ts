import { createInterface } from 'node:readline';
import { AGENT_TOOLS } from './tools.js';

// STDIO MCP bridge. stdout is exclusively JSON-RPC, including on failures.
const endpoint = process.env.APPOPS_AGENT_ENDPOINT;
const token = process.env.APPOPS_AGENT_TOKEN;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(endpoint) || !token) process.exit(1);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const reply = (id: unknown, result: unknown) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
for await (const line of lines) {
  let message: { id?: unknown; method?: string; params?: { name?: string; arguments?: unknown } };
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined) continue;
  if (message.method === 'initialize') reply(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'appops', version: '1.0.0' } });
  else if (message.method === 'ping') reply(message.id, {});
  else if (message.method === 'tools/list') reply(message.id, { tools: AGENT_TOOLS });
  else if (message.method === 'tools/call') {
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: message.params?.name, arguments: message.params?.arguments ?? {} }), signal: AbortSignal.timeout(110_000) });
      const result = await response.json();
      reply(message.id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: !response.ok });
    } catch { reply(message.id, { content: [{ type: 'text', text: '운영 앱과의 연결이 끊겼습니다. 외부 변경을 반복하지 말고 종료하세요.' }], isError: true }); }
  } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n');
}
