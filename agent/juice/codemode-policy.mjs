/** Exact model families approved for script-only tool calling. */
const ONLY = [
  /^anthropic\/claude-(?:opus|fable)-5(?:[-.]\d+)*$/,
  /^openai-codex\/gpt-(?:6(?:\.1)?|5\.6)-sol$/,
  /^openai-codex\/gpt-6-astra$/,
];

export function codemodeModeFor(model, env = process.env) {
  if (env.MARK_CODEMODE_MODE === 'on' || env.MARK_CODEMODE_MODE === 'only') return env.MARK_CODEMODE_MODE;
  const key = model ? `${model.provider}/${model.id}` : '';
  return ONLY.some(pattern => pattern.test(key)) ? 'only' : 'on';
}
