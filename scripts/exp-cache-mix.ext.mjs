// tools+system a 1h; cauda (último bloco) a 5m; com AGENT_CKPT=1, checkpoint 1h no fim da penúltima mensagem do assistente.
import { appendFileSync } from 'node:fs';
export default function (pi) {
  pi.on('before_provider_request', (event) => {
    const p = event.payload;
    const one = (o) => { if (o?.cache_control) o.cache_control = { type: 'ephemeral', ttl: '1h' }; };
    (Array.isArray(p.system) ? p.system : []).forEach(one);
    (p.tools ?? []).forEach(one);
    const msgs = p.messages ?? [];
    for (const m of msgs) if (Array.isArray(m.content)) for (const b of m.content) if (b.cache_control) b.cache_control = { type: 'ephemeral', ttl: '5m' };
    if (process.env.AGENT_CKPT === '1') {
      const idx = msgs.map((m, i) => [m, i]).filter(([m]) => m.role === 'assistant').map(([, i]) => i).at(-1);
      if (idx !== undefined) {
        const m = msgs[idx]; if (typeof m.content === 'string') m.content = [{ type: 'text', text: m.content }];
        const last = [...m.content].reverse().find(b => b.type === 'text' || b.type === 'tool_use');
        if (last) last.cache_control = { type: 'ephemeral', ttl: '1h' };
      }
    }
    return p;
  });
  pi.on('provider_stream_event', (event) => {
    const d = event.data; if (d?.type === 'message_start' && process.env.AGENT_TTL_LOG) appendFileSync(process.env.AGENT_TTL_LOG, JSON.stringify(d.message.usage) + '\n');
  });
}
