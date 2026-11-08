// paths: onde ficam as coisas, dependendo de estar na VM Garime ou no Mac.
//
// Na VM o disco compartilhado /mnt/garime é a fonte (Sistema, estado do pi);
// no Mac tudo vive em ~. Antes cada extensão repetia o mesmo ternário com
// existsSync("/mnt/garime"), e uma delas esquecia PI_SYSTEM_DIR.
//
// As funções leem o ambiente/FS a cada chamada: quem quiser congelar o valor
// (a maioria) guarda o resultado numa const de módulo, como sempre fez.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** raiz do disco compartilhado da VM; só existe lá */
export const GARIME_ROOT = "/mnt/garime";

/** true quando rodando na VM Garime (o disco compartilhado está montado) */
export function onGarime(): boolean {
  return existsSync(GARIME_ROOT);
}

/** raiz do Vault/Sistema. PI_SYSTEM_DIR vence; depois /mnt/garime/Sistema; senão ~/Sistema */
export function sistemaDir(): string {
  const fromEnv = process.env.PI_SYSTEM_DIR;
  if (fromEnv) return fromEnv;
  const naVm = join(GARIME_ROOT, "Sistema");
  return existsSync(naVm) ? naVm : join(homedir(), "Sistema");
}

/** diretório de estado do pi: /mnt/garime/pi na VM, ~/.pi/agent no Mac */
export function piStateDir(): string {
  return onGarime() ? join(GARIME_ROOT, "pi") : join(homedir(), ".pi", "agent");
}

/** nome curto da máquina usado por mesh/presence */
export function hostName(): string {
  return onGarime() ? "garime" : "mac";
}
