#!/usr/bin/env node
// Minerador de exercícios num repo git temporário: commit código+teste vira um
// task-*.json cujo base_rev é o commit sintético (código do pai + teste novo).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { mineTasks } = await import(path.join(repoRoot, 'mark/juice/mine.mjs'));

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mark-mine-test-')));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: tmp, encoding: 'utf8', env });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout || '').trim();
};
const write = (rel, body) => {
  fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(tmp, rel), body);
};

git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@t');
git('config', 'user.name', 'test');
git('config', 'commit.gpgsign', 'false');

// Commit 1 (raiz): código + teste que passa. Sem pai, logo não é minerável.
write('scripts/lib/sum.mjs', 'export function sum(a, b) {\n  return a + b;\n}\n');
write('scripts/test-sum.mjs', `import assert from 'node:assert/strict';
import test from 'node:test';
import { sum } from './lib/sum.mjs';
test('dois', () => assert.equal(sum(1, 2), 3));
`);
git('add', '-A');
git('commit', '-qm', 'sum inicial');

// Commit 2: código + teste atualizados juntos -> o exercício.
write('scripts/lib/sum.mjs', 'export function sum(...xs) {\n  return xs.reduce((a, b) => a + b, 0);\n}\n');
write('scripts/test-sum.mjs', `import assert from 'node:assert/strict';
import test from 'node:test';
import { sum } from './lib/sum.mjs';
test('dois', () => assert.equal(sum(1, 2), 3));
test('variadico', () => assert.equal(sum(1, 2, 3), 6));
`);
git('add', '-A');
git('commit', '-qm', 'sum variadico');

// Commit 3: grande (13 arquivos de código) + teste -> filtrado por tamanho.
for (let i = 0; i < 13; i += 1) write(`scripts/lib/m${i}.mjs`, `export const m${i} = ${i};\n`);
write('scripts/test-big.mjs', "import test from 'node:test';\ntest('ok', () => {});\n");
git('add', '-A');
git('commit', '-qm', 'modulos em massa');

const head = git('rev-parse', 'HEAD');
const branches = git('branch', '--format=%(refname)');

// --- rodada 1 ---
const first = mineTasks({ repo: tmp, max: 20, depth: 200 });
assert.equal(first.tasks.length, 1, `esperava 1 tarefa, veio ${first.tasks.length}`);
const [task] = first.tasks;

const file = path.join(tmp, '.mark/tasks', `${task.id}.json`);
const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(onDisk.id, task.id);
assert.equal(onDisk.family, 'change-with-tests');
assert.equal(onDisk.repo, tmp);
assert.ok(['Update', 'Gate', 'Audit'].includes(onDisk.split));
assert.equal(onDisk.id, onDisk.base_rev.slice(0, 12));
assert.deepEqual(onDisk.hidden_checks, []);
assert.deepEqual(onDisk.allowed_paths, ['scripts/lib/sum.mjs']);
assert.deepEqual(onDisk.checks, [
  { name: 'syntax-scripts-lib-sum-mjs', cmd: 'node --check scripts/lib/sum.mjs', kind: 'E0', timeout_ms: 120000 },
  { name: 'tests', cmd: 'node scripts/test-sum.mjs', kind: 'E3', timeout_ms: 120000 },
]);
assert.match(onDisk.prompt, /Testes: scripts\/test-sum\.mjs/);
assert.match(onDisk.prompt, /não edite os testes/);
assert.match(onDisk.prompt, /Verifique com: node scripts\/test-sum\.mjs/);
assert.match(onDisk.prompt, /sum variadico/);

// base_rev é commit sintético: teste falha nele e passa no pai.
const runAt = (rev) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mark-mine-check-'));
  const wt = path.join(dir, 'wt');
  git('worktree', 'add', '--detach', '-q', wt, rev);
  const r = spawnSync('node', ['scripts/test-sum.mjs'], { cwd: wt, encoding: 'utf8' });
  git('worktree', 'remove', '--force', wt);
  fs.rmSync(dir, { recursive: true, force: true });
  return r.status;
};
assert.notEqual(runAt(onDisk.base_rev), 0, 'teste deveria falhar no commit sintético');
assert.equal(runAt(`${onDisk.base_rev}^`), 0, 'teste deveria passar no pai do sintético');
assert.equal(git('rev-parse', `refs/mark/tasks/${task.id}`), onDisk.base_rev);
// A working tree, o index e as branches do repo minerado ficam intactos.
// (só .mark/tasks é novo; nenhum arquivo rastreado muda)
assert.equal(git('status', '--porcelain', '--', ':(exclude).mark'), '');
assert.equal(git('rev-parse', 'HEAD'), head);
assert.equal(git('branch', '--format=%(refname)'), branches);

// --- rodada 2: idempotente ---
const second = mineTasks({ repo: tmp, max: 20, depth: 200 });
assert.equal(second.tasks.length, 0, 'segunda rodada não deve regerar tarefas');
assert.deepEqual(fs.readdirSync(path.join(tmp, '.mark/tasks')), [`${task.id}.json`]);

// --- dry-run não escreve ---
fs.rmSync(path.join(tmp, '.mark'), { recursive: true, force: true });
const dry = mineTasks({ repo: tmp, max: 20, depth: 200, dryRun: true });
assert.equal(dry.tasks.length, 1);
assert.equal(dry.tasks[0].id, task.id, 'id estável entre rodadas');
assert.equal(fs.existsSync(path.join(tmp, '.mark')), false, 'dry-run não deve escrever');

// CLI --dry-run imprime a tarefa.
const cli = spawnSync('node', [path.join(repoRoot, 'mark/juice/mine.mjs'), '--repo', tmp, '--dry-run'], { encoding: 'utf8', env });
assert.equal(cli.status, 0, cli.stderr);
assert.match(cli.stdout, new RegExp(`^${task.id} `, 'm'));
assert.match(cli.stdout, /gerados=1/);
assert.equal(fs.existsSync(path.join(tmp, '.mark')), false);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('ok mark-mine: 1 tarefa minerada, sintético falha, pai passa, idempotente, dry-run limpo');
