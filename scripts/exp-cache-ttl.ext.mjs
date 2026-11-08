// Ajusta o TTL de todos os breakpoints do request conforme MARK_TTL (5m|1h) e grava o usage bruto.
import { appendFileSync } from 'node:fs';
export default function (pi) {
  pi.on('before_provider_request', (event) => {
    const ttl = process.env.MARK_TTL; if (!ttl) return;
    const set = (o) => { if (o && o.cache_control) o.cache_control = { type: 'ephemeral', ttl }; };
    const p = event.payload;
    (Array.isArray(p.system) ? p.system : []).forEach(set);
    (p.tools ?? []).forEach(set);
    for (const m of p.messages ?? []) if (Array.isArray(m.content)) m.content.forEach(set);
    return p;
  });
  pi.on('provider_stream_event', (event) => {
    const d = event.data; const u = d?.message?.usage ?? (d?.type === 'message_delta' ? d.usage : null);
    if (u && process.env.MARK_TTL_LOG) appendFileSync(process.env.MARK_TTL_LOG, JSON.stringify({ ttl: process.env.MARK_TTL, type: d.type, u }) + '\n');
  });
}
