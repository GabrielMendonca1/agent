/** Script-only tools for approved families, including future major/minor versions. */
function scriptOnlyFamily(model) {
  if (model?.provider === 'anthropic') {
    const match = /^claude-(?:opus|fable)-(\d+)(?:[-.]\d+)*$/.exec(model.id);
    return Boolean(match && Number(match[1]) >= 5);
  }
  if (model?.provider === 'openai-codex') {
    const match = /^gpt-(\d+)(?:\.(\d+))?-(?:sol|astra)$/.exec(model.id);
    return Boolean(match && (Number(match[1]) >= 6 || (Number(match[1]) === 5 && Number(match[2]) === 6)));
  }
  return false;
}

export function codemodeModeFor(model, env = process.env) {
  if (env.AGENT_CODEMODE_MODE === 'on' || env.AGENT_CODEMODE_MODE === 'only') return env.AGENT_CODEMODE_MODE;
  return scriptOnlyFamily(model) ? 'only' : 'on';
}
