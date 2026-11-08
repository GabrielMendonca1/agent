import { mkdirSync, rmSync, statSync, utimesSync } from "fs";
import { basename, dirname, join } from "path";
import { setTimeout as sleep } from "timers/promises";

// Mesmo protocolo do proper-lockfile que o pi usa no AuthStorage (e o overlay pi-account-env no
// accounts.json): a trava de `<arquivo>` e o DIRETORIO `<arquivo>.lock`, criado por mkdir atomico,
// com mtime renovado enquanto viva e tratada como stale depois de 30 s sem renovacao.
// Arquivo `wx` com o mesmo nome travava um lado com ELOCKED/ENOTDIR sem nunca serializar.
//
// Assincrona de proposito: a extensao roda DENTRO do processo pi. Esperar com o event loop parado
// impediria o proprio pi de terminar um refresh em voo (e de renovar o mtime da trava dele), e a
// espera acabaria quebrando a trava do pi como stale — descartando um token ja rotacionado.
export const AUTH_LOCK_STALE_MS = 30_000;
const RETRY_MS = 50;
const WAIT_MS = 60_000;
const TOUCH_MS = AUTH_LOCK_STALE_MS / 3;

function code(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function lockAgeMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Serializa o reler+gravar de `file` com qualquer outro escritor (pi, app, outra sessao). */
export async function withFileLock<T>(file: string, run: () => T | Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      const age = lockAgeMs(lock);
      if (age === null || age >= AUTH_LOCK_STALE_MS) {
        // Stale (dono morreu). `recursive` tambem remove o arquivo-trava legado de app/extensao antigos.
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`${basename(lock)} preso por outro processo`);
      await sleep(RETRY_MS);
    }
  }
  const touch = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(lock, now, now);
    } catch {
      // Removida por terceiro: a gravacao seguinte ainda e atomica; nada a fazer aqui.
    }
  }, TOUCH_MS);
  touch.unref?.();
  try {
    return await run();
  } finally {
    clearInterval(touch);
    rmSync(lock, { recursive: true, force: true });
  }
}

export function withAuthLock<T>(agentDir: string, run: () => T | Promise<T>): Promise<T> {
  return withFileLock(join(agentDir, "auth.json"), run);
}

/** Ordem fixa accounts.json -> auth.json, a mesma do refresh do pi patchado: sem deadlock. */
export function withAccountLocks<T>(agentDir: string, run: () => T | Promise<T>): Promise<T> {
  return withFileLock(join(agentDir, "accounts.json"), () => withAuthLock(agentDir, run));
}
