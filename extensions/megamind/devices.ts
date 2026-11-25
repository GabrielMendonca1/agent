// Onde a outra sessão está: mesma máquina (peers_*) ou outra máquina/outro sócio
// (megamind_*). Quem responde isso é o servidor, em `same_device` de `who`; aqui
// só mora a frase que o agente lê.
import { megamindApp } from "./profile.ts";

/** `peers_send`/`pi-peers send` endereçam pelos 6 últimos chars do uuid da sessão. */
export function short6(session_id: string): string {
  return session_id.slice(-6);
}

/**
 * `peers` = mesma máquina e sessão Pi (alcançável por `peers_send`).
 * `local` = mesma máquina, mas outro harness (Claude Code, Codex): o `peers` não
 * chega lá. `remote` = outra máquina ou outro sócio.
 */
export type Locality = "peers" | "local" | "remote";

/** `same_device` do `who` mais o harness da sessão. */
export function localityOf(session: { same_device?: boolean; harness?: string } | undefined): Locality {
  if (!session?.same_device) return "remote";
  return session.harness === "pi" ? "peers" : "local";
}

/** Como falar com a outra sessão, em uma frase, conforme onde ela está. */
export function coordinateHint(session_id: string, place: Locality, harness?: string): string {
  if (place === "peers") {
    const id = short6(session_id);
    return `It is on this same machine: use peers_send {to: "${id}"} (CLI: pi-peers send ${id}), not megamind_send.`;
  }
  if (place === "local") {
    const what = harness ? ` (${harness})` : "";
    return `It is on this same machine but is not a Pi session${what}: peers cannot reach it; coordinate through ${megamindApp()} or with your user, and use megamind_send {to: "${session_id}"} only as a last resort.`;
  }
  return `Use megamind_send {to: "${session_id}"}.`;
}

/** Sufixo de `megamind_who` para sessão desta mesma máquina. */
export function localMark(session_id: string, place: Locality, harness?: string): string | undefined {
  if (place === "peers") return `esta máquina — use peers_send ${short6(session_id)}`;
  if (place === "local") return `esta máquina${harness ? ` (${harness})` : ""} — fora do peers`;
  return undefined;
}
