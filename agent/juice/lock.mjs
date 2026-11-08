// Trava de mutação da receita (.agent/workflow.md + history.json), entre processos.
//
// Protocolo (só entre quem coopera — aprendizado e ledger do Agent; edição humana não passa aqui):
// - adquirir: mkdir `.agent/.workflow.lock` (atômico) e criar dentro, com O_EXCL,
//   `owner.<pid>.<nonce>`; o nonce distingue donos mesmo com PID reaproveitado.
// - nunca roubar por idade: dono vivo (ou suspenso) mantém a trava o tempo que for.
// - reaproveitar trava de dono morto: só se o PID do arquivo owner não existe mais;
//   apaga EXATAMENTE aquele arquivo e, só se esse unlink deu certo, rmdir NÃO recursivo
//   (dois concorrentes: só um vence o unlink; dono novo nunca é apagado).
// - diretório sem owner (dono morreu entre mkdir e criar o owner) ou com owner ilegível:
//   fail closed — ninguém remove sozinho; limpeza manual: `rmdir .agent/.workflow.lock`.
// - soltar: unlink do próprio owner + rmdir não recursivo.
// Sem a trava em `waitMs`, devolve undefined: o chamador trata como inconclusivo
// (o chamador não grava). Nunca segure durante chamada de modelo.
import { closeSync, mkdirSync, openSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export const LOCK_DIR = '.workflow.lock';
const OWNER = /^owner\.(\d+)\.([0-9a-f-]+)$/;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Só ESRCH prova morte; PID inválido ou qualquer outro erro conta como vivo (fail closed). */
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code !== 'ESRCH'; }
}

/** Tenta liberar uma trava de dono comprovadamente morto. true se removeu. */
function reapDead(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return false; }
  if (entries.length !== 1) return false; // vazio ou estranho → fail closed
  const m = OWNER.exec(entries[0]);
  if (!m || pidAlive(Number(m[1]))) return false;
  try { unlinkSync(join(dir, entries[0])); } catch { return false; } // outro concorrente venceu
  try { rmdirSync(dir); } catch { /* não vazio: dono novo já entrou */ }
  return true;
}

/** Roda `fn` com a trava; devolve o retorno dele, ou `undefined` se não obteve em `waitMs`. */
export function withWorkflowLock(cwd, fn, { waitMs = 5000 } = {}) {
  return withDirectoryLock(join(cwd, '.agent', LOCK_DIR), fn, { waitMs });
}

/** Trava de transação reutilizada pelo ledger e pelas preferências JSON. */
export function withDirectoryLock(dir, fn, { waitMs = 5000 } = {}) {
  const deadline = Date.now() + waitMs;
  const owner = join(dir, `owner.${process.pid}.${randomUUID()}`);
  for (;;) {
    try {
      mkdirSync(dir);
      closeSync(openSync(owner, 'wx'));
      break;
    } catch (e) {
      if (e?.code === 'ENOENT') { mkdirSync(dirname(dir), { recursive: true }); continue; }
      if (e?.code !== 'EEXIST') throw e;
      if (reapDead(dir)) continue;
      if (Date.now() >= deadline) return undefined;
      sleep(15 + Math.random() * 20);
    }
  }
  try {
    return fn();
  } finally {
    // rmdir só se ainda éramos donos: perdida a posse, o diretório pode ser de outro.
    let released = false;
    try { unlinkSync(owner); released = true; } catch { /* já não é nosso */ }
    if (released) { try { rmdirSync(dir); } catch { /* não vazio: outro dono */ } }
  }
}
