/**
 * Slot de prompt. Para um slot FOO o template do Vault declara:
 *   {{PI_FOO}} bloco pronto · {{PI_FOO_ENTRIES}} dados crus · {{PI_FOO_<VAR>}} extras
 * Sem placeholder, o bloco é anexado no fim (legado). Sem dados, vira vazio.
 */
export interface PromptSlotValue {
  block: string;
  entries: string;
  vars?: Record<string, string>;
}

export function injectSlot(prompt: string, name: string, value: PromptSlotValue | null): string | null {
  const block = `{{PI_${name}}}`;
  const suffixes = new Set([...prompt.matchAll(new RegExp(`{{PI_${name}_([A-Z0-9_]+)}}`, "g"))].map((m) => m[1]));
  const hasBlock = prompt.includes(block);

  if (!hasBlock && suffixes.size === 0) return value ? `${prompt}\n\n${value.block}` : null;

  let out = hasBlock ? prompt.replaceAll(block, value?.block ?? "") : prompt;
  for (const suffix of suffixes) {
    const fill = suffix === "ENTRIES" ? value?.entries ?? "" : value?.vars?.[suffix] ?? "";
    out = out.replaceAll(`{{PI_${name}_${suffix}}}`, fill);
  }
  if (!value) out = out.replace(/\n{3,}/g, "\n\n");
  return out === prompt ? null : out;
}
