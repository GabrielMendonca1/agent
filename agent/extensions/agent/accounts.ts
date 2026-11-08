import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAccountsCore } from "./lib/accounts-core.ts";

// Lockstep com o pi patchado (overlay arca-pi pi-account-env): o pi so honra PI_ACCOUNT_* quando a
// extensao que registra /accounts declara o protocolo de trava novo (diretorio proper-lockfile,
// ordem accounts.json -> auth.json, merge por entrada). Extensao antiga reverteria rotacoes.
export const ACCOUNTS_LOCK_PROTOCOL = 2;
(globalThis as Record<symbol, unknown>)[Symbol.for("arca.accounts.lockProtocol")] = ACCOUNTS_LOCK_PROTOCOL;

export default function (pi: ExtensionAPI) {
  const core = createAccountsCore();
  pi.on("agent_end", async (_event, ctx) => {
    await core.agentEnd(ctx.model?.provider, (message, level) => ctx.ui.notify(message, level));
  });
  pi.registerCommand("accounts", {
    description: "Bucket de contas por provider: /accounts [list|save|use|sync|mirror|rename|remove]",
    getArgumentCompletions: core.completions,
    handler: async (args, ctx) => {
      await core.execute(args, (message, level) => ctx.ui.notify(message, level));
    },
  });
}
