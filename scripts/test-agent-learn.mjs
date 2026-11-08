#!/usr/bin/env node
import './lib/hermetic-test-env.mjs';
// Aprendizado da receita, offline.
// Cobre: check mascarado não conta como verde; gravação concorrente;
// marcador explícito de regra não provada.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hadGreenChecks, runsCheck, applyLearned } from '../agent/juice/learn.mjs';
import { ensureWorkflow, ignoreWorkflowLocally, projectRules } from '../agent/juice/workflow.mjs';

const CHECK = 'node scripts/test-x.mjs';
let n = 0;
const ok = (msg) => { n++; console.log(`ok ${msg}`); };

// ---- aprendizado: o que conta como check verde ----
for (const c of [CHECK, `cd /repo && ${CHECK}`, `FOO=1 ${CHECK}`, `node --version && ${CHECK}`, `${CHECK} 2>&1`]) assert.equal(runsCheck(c, [CHECK]), true, c);
for (const c of [`${CHECK} || true`, `${CHECK}; true`, `${CHECK} | tail -3`, `echo ${CHECK}`, `echo "${CHECK}"`, `echo "x && ${CHECK} && y"`, `git commit -m 'a && ${CHECK}'`, `${CHECK} &`, `x=$(${CHECK})`, `true || ${CHECK}`, `${CHECK}x`, `# ${CHECK}`]) {
  assert.equal(runsCheck(c, [CHECK]), false, c);
}
ok('runsCheck: só execução real cujo exit code é o do check');

const run = (command, out, isError = false) => [
  { role: 'user', content: 'faça' },
  { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'bash', arguments: { command } }] },
  { role: 'toolResult', toolCallId: 't1', toolName: 'bash', content: [{ type: 'text', text: out }], isError },
];
assert.equal(hadGreenChecks(run(`${CHECK} || true`, 'not ok 1'), [CHECK]), false, '|| true não é verde');
assert.equal(hadGreenChecks(run(`echo ${CHECK}`, CHECK), [CHECK]), false, 'eco não executa');
assert.equal(hadGreenChecks(run(CHECK, '5 passed, 0 failed'), [CHECK]), true, '0 failed é verde');
assert.equal(hadGreenChecks(run(CHECK, '1 failed'), [CHECK]), false, 'saída declara falha');
assert.equal(hadGreenChecks(run(CHECK, 'ok', true), [CHECK]), false, 'exit != 0');
const orphan = [{ role: 'user', content: 'x' }, { role: 'toolResult', toolCallId: 'zz', toolName: 'checks', content: [{ type: 'text', text: '3/3 verdes' }] }];
assert.equal(hadGreenChecks(orphan, [CHECK]), false, 'resultado sem chamada neste run');
ok('hadGreenChecks: mascarado, eco, falha declarada e órfão não contam');

// ---- projeto falso ----
const root = mkdtempSync(join(tmpdir(), 'agent-prove-'));
const cwd = join(root, 'proj');
mkdirSync(join(cwd, '.agent'), { recursive: true });
const wf = join(cwd, '.agent/workflow.md');
const hist = join(cwd, '.agent/history.json');
const V1 = '# Receita\n\nversão: v1\n\n## Regras aprendidas\n(nenhuma ainda)\n';
const reset = () => { writeFileSync(wf, V1); rmSync(hist, { force: true }); };
reset();

// ---- concorrência entre processos: aprender × aprender × reverter ----
{
  reset();
  const { spawn } = await import('node:child_process');
  const learnUrl = new URL('../agent/juice/learn.mjs', import.meta.url).href;
  const N = 8;
  const go = (code) => new Promise((done, fail) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('close', c => (c === 0 ? done() : fail(new Error(err))));
  });
  // Todos esperam o mesmo instante para colidir de verdade.
  const at = Date.now() + 400;
  const wait = `while (Date.now() < ${at}) {}`;
  await Promise.all(Array.from({ length: N }, (_, i) => go(`import { applyLearned } from ${JSON.stringify(learnUrl)}; ${wait}; if (!applyLearned(${JSON.stringify(cwd)}, ['Regra concorrente número ${i} aqui'])) process.exit(9);`)));
  const text = readFileSync(wf, 'utf8');
  for (let i = 0; i < N; i++) assert.match(text, new RegExp(`Regra concorrente número ${i} aqui`), `regra ${i} perdida`);
  const h = JSON.parse(readFileSync(hist, 'utf8'));
  assert.equal(new Set(h.map(x => x.version)).size, N, 'versões únicas');
  assert.match(text, new RegExp(`versão: v${N + 1}`));
  ok(`${N} processos aprendendo: nenhuma regra perdida, versões únicas`);
}

{
  const { spawn, spawnSync } = await import('node:child_process');
  const { utimesSync, rmdirSync } = await import('node:fs');
  const { withWorkflowLock, LOCK_DIR } = await import('../agent/juice/lock.mjs');
  const lockDir = join(cwd, '.agent', LOCK_DIR);
  const sleeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  mkdirSync(lockDir); writeFileSync(join(lockDir, `owner.${sleeper.pid}.aaaa`), '');
  const old = (Date.now() - 3600_000) / 1000; utimesSync(lockDir, old, old);
  assert.equal(withWorkflowLock(cwd, () => 'roubou', { waitMs: 300 }), undefined, 'dono vivo antigo não é roubado');
  assert.ok(existsSync(join(lockDir, `owner.${sleeper.pid}.aaaa`)), 'owner vivo intacto');
  sleeper.kill('SIGKILL'); await new Promise(r => sleeper.on('close', r));
  assert.equal(withWorkflowLock(cwd, () => 'ok', { waitMs: 2000 }), 'ok', 'dono morto é reaproveitado');
  assert.ok(!existsSync(lockDir), 'trava solta');
  mkdirSync(lockDir);
  assert.equal(withWorkflowLock(cwd, () => 'x', { waitMs: 200 }), undefined, 'sem owner → fail closed');
  assert.ok(existsSync(lockDir), 'não removido automaticamente');
  rmdirSync(lockDir);
  // PID inválido no owner (0, gigante): não prova morte → não é apagado.
  for (const bad of ['0', '99999999999']) {
    mkdirSync(lockDir); writeFileSync(join(lockDir, `owner.${bad}.cccc`), '');
    assert.equal(withWorkflowLock(cwd, () => 'x', { waitMs: 200 }), undefined, `PID inválido ${bad} → fail closed`);
    assert.ok(existsSync(join(lockDir, `owner.${bad}.cccc`)), `owner ${bad} intacto`);
    rmSync(lockDir, { recursive: true });
  }
  // Posse perdida dentro de fn: owner removido por fora e diretório reocupado por um
  // dono novo que ainda não criou o owner (vazio). Soltar não pode apagar o diretório dele.
  withWorkflowLock(cwd, () => { for (const f of readdirSync(lockDir)) rmSync(join(lockDir, f)); });
  assert.ok(existsSync(lockDir), 'posse perdida: diretório do novo dono intacto');
  rmSync(lockDir, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  mkdirSync(lockDir); writeFileSync(join(lockDir, `owner.${dead}.bbbb`), '');
  const lockUrl = new URL('../agent/juice/lock.mjs', import.meta.url).href;
  const log = join(root, 'excl.log'); rmSync(log, { force: true });
  const at = Date.now() + 400;
  await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((done, fail) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `import { withWorkflowLock } from ${JSON.stringify(lockUrl)}; import { appendFileSync } from 'node:fs';
while (Date.now() < ${at}) {}
const r = withWorkflowLock(${JSON.stringify(cwd)}, () => { appendFileSync(${JSON.stringify(log)}, 'in ${i}\\n'); const t = Date.now() + 40; while (Date.now() < t) {} appendFileSync(${JSON.stringify(log)}, 'out ${i}\\n'); return 1; }, { waitMs: 8000 });
process.exit(r === 1 ? 0 : 9);`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('close', c => (c === 0 ? done() : fail(new Error(`concorrente ${i}: ${c} ${err}`))));
  })));
  const lines = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 12, lines.join('|'));
  for (let k = 0; k < lines.length; k += 2) assert.equal(lines[k].replace('in', 'out'), lines[k + 1], `sobreposição: ${lines.join(' | ')}`);
  assert.ok(!existsSync(lockDir), 'trava solta no fim');
  ok('trava: dono vivo antigo não é roubado; sem owner fail closed; 6 concorrentes sobre dono morto sem sobreposição');
}

// ---- `.agent` versionado só onde já é: nos outros projetos, exclude LOCAL ----
{
  const { execFileSync, spawn } = await import('node:child_process');
  const git = (d, ...args) => execFileSync('git', ['-C', d, ...args], { encoding: 'utf8' });
  const newRepo = (name) => {
    const d = join(root, name); mkdirSync(d, { recursive: true });
    git(d, 'init', '-q');
    writeFileSync(join(d, 'a.txt'), 'a\n'); writeFileSync(join(d, '.gitignore'), 'node_modules\n');
    git(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A');
    git(d, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'base');
    return d;
  };
  const excludeOf = (d) => join(d, '.git/info/exclude');
  // projeto comum: receita criada e `.agent/` ignorado localmente, sem tocar .gitignore
  const plain = newRepo('repo-plain');
  writeFileSync(excludeOf(plain), '# pessoal\n*.local\n');
  const text = ensureWorkflow(plain);
  assert.match(text, /^# Receita do Agent — repo-plain$/m);
  const ex1 = readFileSync(excludeOf(plain), 'utf8');
  assert.match(ex1, /^# pessoal\n\*\.local\n\/\.agent\/\n$/, ex1);
  assert.equal(readFileSync(join(plain, '.gitignore'), 'utf8'), 'node_modules\n', '.gitignore intocado');
  assert.equal(git(plain, 'status', '--porcelain').includes('.agent'), false, `.agent fora do status: ${git(plain, 'status', '--porcelain')}`);
  // idempotente: repetir não duplica linha nem reescreve a receita
  writeFileSync(join(plain, '.agent/workflow.md'), `${text}\n- editado à mão\n`);
  assert.equal(ignoreWorkflowLocally(plain), false, 'linha já existe');
  assert.equal(ensureWorkflow(plain), `${text}\n- editado à mão\n`, 'receita existente não é reescrita');
  assert.equal(readFileSync(excludeOf(plain), 'utf8'), ex1, 'exclude inalterado na repetição');
  // exclude ausente e `.agent` já existente: a linha entra mesmo assim
  const late = newRepo('repo-late');
  mkdirSync(join(late, '.agent'), { recursive: true }); writeFileSync(join(late, '.agent/workflow.md'), V1);
  rmSync(excludeOf(late), { force: true });
  assert.equal(ignoreWorkflowLocally(late), true);
  assert.equal(readFileSync(excludeOf(late), 'utf8'), '/.agent/\n');
  // Filhos iniciando juntos: preservar o exclude pessoal, inclusive sem newline final.
  const concurrent = newRepo('repo-concurrent');
  writeFileSync(excludeOf(concurrent), '# pessoal\n*.local');
  const source = new URL('../agent/juice/workflow.mjs', import.meta.url).href;
  await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { ignoreWorkflowLocally } from ${JSON.stringify(source)}; ignoreWorkflowLocally(${JSON.stringify(concurrent)});`],
      { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`exclude concorrente: exit ${code}`)); });
  })));
  const concurrentExclude = readFileSync(excludeOf(concurrent), 'utf8');
  assert.ok(concurrentExclude.startsWith('# pessoal\n*.local\n'), 'nenhuma exclusão pessoal é truncada');
  assert.match(concurrentExclude, /^\/\.agent\/$/m);
  assert.equal(ignoreWorkflowLocally(concurrent), false, 'repetição após corrida é idempotente');
  assert.equal(readFileSync(excludeOf(concurrent), 'utf8'), concurrentExclude);
  // projeto que VERSIONA .agent (como o agent): nada é ignorado
  const tracked = newRepo('repo-tracked');
  mkdirSync(join(tracked, '.agent'), { recursive: true }); writeFileSync(join(tracked, '.agent/workflow.md'), V1);
  git(tracked, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.agent');
  git(tracked, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'receita');
  const exTracked = readFileSync(excludeOf(tracked), 'utf8');
  assert.equal(ignoreWorkflowLocally(tracked), false, 'repo que versiona .agent não ignora');
  assert.equal(readFileSync(excludeOf(tracked), 'utf8'), exTracked, 'exclude do repo versionado intacto');
  ensureWorkflow(tracked);
  assert.equal(readFileSync(excludeOf(tracked), 'utf8'), exTracked, 'ensureWorkflow também respeita');
  // o próprio agent (real, .agent rastreado): nenhuma escrita
  const selfRepo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const selfExclude = join(selfRepo, '.git/info/exclude');
  const selfBefore = existsSync(selfExclude) ? readFileSync(selfExclude, 'utf8') : null;
  assert.equal(ignoreWorkflowLocally(selfRepo), false, 'agent versiona .agent');
  assert.equal(existsSync(selfExclude) ? readFileSync(selfExclude, 'utf8') : null, selfBefore, 'exclude do agent intacto');
  // worktree: `.git` é arquivo; o exclude vem de `rev-parse --git-path` (comum ao repo)
  const main = newRepo('repo-main');
  rmSync(excludeOf(main), { force: true });
  const wt = join(root, 'repo-worktree');
  git(main, 'worktree', 'add', '-q', '-b', 'wt', wt);
  assert.ok(!existsSync(join(wt, '.git/HEAD')), 'worktree tem .git arquivo, não diretório');
  assert.equal(ignoreWorkflowLocally(wt), true, 'worktree ganha a linha');
  assert.equal(readFileSync(excludeOf(main), 'utf8'), '/.agent/\n', 'exclude resolvido pelo git, no diretório comum');
  assert.equal(ignoreWorkflowLocally(wt), false, 'worktree idempotente');
  assert.equal(ignoreWorkflowLocally(main), false, 'linha do worktree vale para o repo principal');
  assert.match(ensureWorkflow(wt), /^# Receita do Agent — repo-worktree$/m);
  assert.equal(readFileSync(excludeOf(main), 'utf8'), '/.agent/\n', 'sem duplicar');
  // sem git / fora de repo: nunca lança nem cria nada
  const bare = join(root, 'sem-git'); mkdirSync(bare, { recursive: true });
  assert.equal(ignoreWorkflowLocally(bare), false);
  assert.equal(ensureWorkflow(bare), null);
  assert.equal(existsSync(join(bare, '.agent')), false);
  const broken = join(root, 'git-quebrado'); mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, '.git'), 'gitdir: /nao/existe\n');
  assert.equal(ignoreWorkflowLocally(broken), false, '.git quebrado não explode');
  // regras como orientação do projeto (o que vai ao filho)
  assert.equal(projectRules(wt), '', 'receita nova (nenhuma regra ainda) não gera orientação');
  rmSync(join(wt, '.agent'), { recursive: true }); // só a receita criada pela fixture
  git(main, 'worktree', 'remove', wt);
  git(main, 'branch', '-d', 'wt');
  applyLearned(late, ['Regra deste projeto para o filho']);
  assert.match(projectRules(late), /^## Project notes\n[^\n]*guidance only[^\n]*\n- Regra deste projeto para o filho \[by: Agent; proven: no\]$/);
  assert.equal(projectRules(bare), '');
  ok('exclude local idempotente (worktree incluída); repo que versiona .agent e .gitignore intactos');
}

rmSync(root, { recursive: true, force: true });
console.log(`${n} checks passed`);
