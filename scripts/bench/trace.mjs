// JSONL events, not session-file events: account once at message_end, never at deltas.
export function redact(value) {
  let s = String(value);
  for (const [key, secret] of Object.entries(process.env)) {
    if (/key|token|secret|password|credential/i.test(key) && secret?.length >= 8) s = s.split(secret).join('[REDACTED]');
  }
  return s.replace(/(?:sk-ant-|sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;"}]+/gi, '$1[REDACTED]')
    .replace(/\/Users\/[^/\s"\\]+/g, '~');
}
export function newStats() {
  return { costUsd: 0, requests: 0, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, tools: {}, codemodeCalls: 0,
    nestedCalls: null, nestedTools: {}, nestedEstimate: 0, toolsAdded: [], toolErrors: [], finalText: '', malformedLines: 0, fatal: null };
}
export function consume(s, e) {
  const added = e.toolsAdded ?? e.message?.toolsAdded;
  if (Array.isArray(added)) s.toolsAdded = [...new Set([...s.toolsAdded, ...added.map(t => typeof t === 'string' ? t : t.name)])];
  // Child execution ends have a parent id; count them once, not again in details.calls or toolResult.nestedCalls.
  if (e.type === 'tool_execution_end' && e.parentToolCallId) {
    s.nestedCalls = (s.nestedCalls ?? 0) + 1;
    s.nestedTools[e.toolName] = (s.nestedTools[e.toolName] || 0) + 1;
  }
  if (e.type === 'message_end' && e.message?.role === 'assistant') {
    const m = e.message;
    if (m.usage) {
      s.requests++;
      const cost = m.usage.cost?.total;
      if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) s.fatal = 'usage cost unavailable; budget cannot be measured';
      else s.costUsd += cost;
      for (const key of Object.keys(s.tokens)) s.tokens[key] += Number(m.usage[key] ?? m.usage[key.replace(/[A-Z]/g, c => '_' + c.toLowerCase())] ?? 0);
    }
    const content = Array.isArray(m.content) ? m.content : [];
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (text) s.finalText = redact(text).slice(-1200);
    for (const call of content.filter(b => b.type === 'toolCall')) {
      s.tools[call.name] = (s.tools[call.name] || 0) + 1;
      if (call.name === 'codemode') {
        s.codemodeCalls++;
        s.nestedEstimate += (JSON.stringify(call.arguments || {}).match(/tools\./g) || []).length;
      }
    }
    if (m.errorMessage) {
      s.toolErrors.push(redact(m.errorMessage).slice(0, 600));
      if (/credential|api.key|unauthorized|authentication|login|log in|not found.*model/i.test(m.errorMessage)) s.fatal = 'credentials or model unavailable';
    }
  }
  if (e.type === 'tool_execution_end' && e.isError) s.toolErrors.push(redact(JSON.stringify(e.result)).slice(0, 600));
  s.toolErrors = s.toolErrors.slice(-6);
}
