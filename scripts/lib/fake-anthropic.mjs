// Provider roteirizado para testes offline: um servidor HTTP em loopback que fala o
// protocolo de streaming da Anthropic (/v1/messages, SSE). O Pi real conversa com
// ele pelo código de provider de verdade; nenhuma chamada sai da máquina.
//
// script: array de respostas, uma por requisição, em ordem. Cada resposta é
//   { text: '...' } ou { tool: { name, input } } (+ opcional usage {input, cacheRead, cacheWrite, output}).
// A última se repete se as requisições passarem do roteiro.
import { createServer } from 'node:http';

export async function startFakeAnthropic(script) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(body); } catch { /* registra mesmo assim */ }
      requests.push({ url: req.url, headers: req.headers, payload });
      if (!req.url.startsWith('/v1/messages')) { res.writeHead(404).end(); return; }
      const step = script[Math.min(requests.filter(r => r.url.startsWith('/v1/messages')).length - 1, script.length - 1)] ?? { text: 'ok' };
      const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, ...step.usage };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      send('message_start', { message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: payload?.model ?? 'fake', content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: usage.input, cache_read_input_tokens: usage.cacheRead, cache_creation_input_tokens: usage.cacheWrite, output_tokens: 1 } } });
      if (step.tool) {
        send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `toolu_${requests.length}`, name: step.tool.name, input: {} } });
        send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.input ?? {}) } });
      } else {
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: step.text ?? 'ok' } });
      }
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output } });
      send('message_stop', {});
      res.end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    messages: () => requests.filter(r => r.url.startsWith('/v1/messages')).map(r => r.payload),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
