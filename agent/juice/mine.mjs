#!/usr/bin/env node
// Minerador de exercícios: cada commit que mudou código E teste vira um
// task-*.json para exercícios de código. O exercício é a árvore do PAI do
// commit com os TESTES do commit sobrepostos — o agente precisa reescrever o
// código. O commit sintético é montado só com plumbing (index temporário),
// nunca tocando working tree, index real ou branches.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEST_RE = /(^|\/)(test|tests|__tests__|spec)s?[/.-]|\.(test|spec)\.[cm]?[jt]sx?$|^scripts\/test-.*\.mjs$/;
const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'rs', 'py', 'go', 'java', 'kt', 'swift', 'rb', 'php', 'cs']);
const SKIP_RE = /(^|\/)(node_modules|dist|build|vendor)(\/|$)/;
const TIMEOUT_MS = 120000;
const FAMILY = 'change-with-tests';
const MAX_CODE_FILES = 12;

function git(repo, args, opts = {}) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function gitOk(repo, args, opts) {
  const r = git(repo, args, opts);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.err || `status ${r.status}`}`);
  return r.out;
}

function isTest(p) {
  return TEST_RE.test(p);
}

function isCode(p) {
  if (SKIP_RE.test(p)) return false;
  const ext = path.extname(p).replace('.', '').toLowerCase();
  return CODE_EXT.has(ext);
}

function classify(files) {
  const tests = [];
  const code = [];
  for (const f of files) {
    if (isTest(f)) tests.push(f);
    else if (isCode(f)) code.push(f);
  }
  return { tests: tests.sort(), code: code.sort() };
}

function showFile(repo, rev, p) {
  const r = git(repo, ['show', `${rev}:${p}`]);
  return r.status === 0 ? r.out : null;
}

/** Comando E3: .pi/checks.json que cite um teste > scripts/test-*.mjs > npm test. */
function testCommand(repo, commit, tests) {
  const raw = showFile(repo, commit, '.pi/checks.json');
  if (raw) {
    try {
      for (const c of JSON.parse(raw).checks || []) {
        if (typeof c?.cmd === 'string' && tests.some((t) => c.cmd.includes(t))) return c.cmd;
      }
    } catch {}
  }
  const script = tests.find((t) => /^scripts\/test-.*\.mjs$/.test(t));
  if (script) return `node ${script}`;
  const pkg = showFile(repo, commit, 'package.json');
  if (pkg) {
    try {
      if (JSON.parse(pkg).scripts?.test) return 'npm test --silent';
    } catch {}
  }
  return null;
}

/** Monta o commit sintético: árvore do pai + blobs de teste do commit. */
function buildSynthetic(repo, commit, parent, tests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mine-idx-'));
  const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, 'index') };
  try {
    gitOk(repo, ['read-tree', parent], { env });
    for (const t of tests) {
      const ls = gitOk(repo, ['ls-tree', commit, '--', t]);
      if (!ls) continue; // teste apagado em C: nada a sobrepor
      const [mode, , sha] = ls.split('\n')[0].split(/\s+/);
      gitOk(repo, ['update-index', '--add', '--cacheinfo', `${mode},${sha},${t}`], { env });
    }
    const tree = gitOk(repo, ['write-tree'], { env });
    // Datas e autor fixos: o sha do commit sintético precisa ser estável entre rodadas.
    const date = gitOk(repo, ['show', '-s', '--format=%aI', commit]);
    const ident = {
      GIT_AUTHOR_NAME: 'agent-mine', GIT_AUTHOR_EMAIL: 'mine@agent',
      GIT_COMMITTER_NAME: 'agent-mine', GIT_COMMITTER_EMAIL: 'mine@agent',
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
    };
    const msg = `agent task from ${commit.slice(0, 12)}`;
    return gitOk(repo, ['commit-tree', tree, '-p', parent, '-m', msg], { env: { ...process.env, ...ident } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Roda o comando numa worktree temporária e descarta. */
function runAt(repo, rev, cmd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mine-wt-'));
  const wt = path.join(dir, 'wt');
  const add = git(repo, ['worktree', 'add', '--detach', wt, rev]);
  if (add.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    return false;
  }
  try {
    const env = { ...process.env };
    delete env.GIT_INDEX_FILE;
    const r = spawnSync(cmd, { cwd: wt, shell: true, encoding: 'utf8', timeout: TIMEOUT_MS, env });
    return r.status === 0;
  } finally {
    git(repo, ['worktree', 'remove', '--force', wt]);
    fs.rmSync(dir, { recursive: true, force: true });
    git(repo, ['worktree', 'prune']);
  }
}

function splitFor(id) {
  const n = createHash('sha256').update(id).digest().readUInt32BE(0) % 100;
  return n < 60 ? 'Update' : n < 85 ? 'Gate' : 'Audit';
}

function syntaxChecks(code) {
  return code
    .filter((f) => /\.(mjs|cjs|js)$/.test(f))
    .slice(0, 5)
    .map((f) => ({
      name: `syntax-${f.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      cmd: `node --check ${f}`,
      kind: 'E0',
      timeout_ms: TIMEOUT_MS,
    }));
}

function buildPrompt(tests, subject, cmd) {
  return 'Os testes abaixo foram atualizados e hoje falham. Faça-os passar alterando apenas código-fonte; não edite os testes.\n'
    + `Testes: ${tests.join(', ')}\n`
    + `Contexto do commit original: ${subject}\n`
    + `Verifique com: ${cmd}`;
}

export function mineTasks({ repo = process.cwd(), max = 20, depth = 200, dryRun = false } = {}) {
  const root = gitOk(repo, ['rev-parse', '--show-toplevel']);
  const tasksDir = path.join(root, '.agent', 'tasks');
  const existing = new Set(
    (fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir) : [])
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5)),
  );

  const commits = gitOk(root, ['log', '--no-merges', '-n', String(depth), '--format=%H']).split('\n').filter(Boolean);
  const tasks = [];
  const stats = { examined: 0, skipped: 0, generated: 0 };

  for (const commit of commits) {
    if (tasks.length >= max) break;
    stats.examined += 1;
    const parent = git(root, ['rev-parse', `${commit}^`]);
    if (parent.status !== 0) { stats.skipped += 1; continue; }

    const files = gitOk(root, ['diff-tree', '--no-commit-id', '-r', '--diff-filter=AMR', '--name-only', commit])
      .split('\n').filter(Boolean);
    const { tests, code } = classify(files);
    if (!tests.length || !code.length || code.length > MAX_CODE_FILES) { stats.skipped += 1; continue; }

    const cmd = testCommand(root, commit, tests);
    if (!cmd) { stats.skipped += 1; continue; }

    const sha = buildSynthetic(root, commit, parent.out, tests);
    const id = sha.slice(0, 12);
    if (existing.has(id)) { stats.skipped += 1; continue; }

    // Só vale como exercício se o teste passa no commit original e falha no sintético.
    if (!runAt(root, commit, cmd) || runAt(root, sha, cmd)) { stats.skipped += 1; continue; }

    const subject = gitOk(root, ['show', '-s', '--format=%s', commit]);
    const task = {
      id,
      family: FAMILY,
      repo: root,
      base_rev: sha,
      split: splitFor(id),
      prompt: buildPrompt(tests, subject, cmd),
      checks: [...syntaxChecks(code), { name: 'tests', cmd, kind: 'E3', timeout_ms: TIMEOUT_MS }],
      hidden_checks: [],
      allowed_paths: code,
    };

    if (!dryRun) {
      gitOk(root, ['update-ref', `refs/agent/tasks/${id}`, sha]);
      fs.mkdirSync(tasksDir, { recursive: true });
      fs.writeFileSync(path.join(tasksDir, `${id}.json`), `${JSON.stringify(task, null, 2)}\n`);
    }
    existing.add(id);
    tasks.push({ ...task, origin: commit, file: path.join(tasksDir, `${id}.json`) });
    stats.generated += 1;
  }

  return { tasks, stats };
}

function parseArgs(argv) {
  const opts = { repo: process.cwd(), max: 20, depth: 200, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo') opts.repo = argv[++i];
    else if (a === '--max') opts.max = Number(argv[++i]);
    else if (a === '--depth') opts.depth = Number(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  if (!opts.repo || !Number.isInteger(opts.max) || !Number.isInteger(opts.depth)) throw new Error('--repo/--max/--depth inválidos');
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const { tasks, stats } = mineTasks(opts);
    for (const t of tasks) {
      console.log(`${t.id} ${t.split} origem=${t.origin.slice(0, 12)} base=${t.base_rev.slice(0, 12)} e3="${t.checks.at(-1).cmd}" allowed=${t.allowed_paths.join(',')}`);
    }
    console.log(`examinados=${stats.examined} gerados=${stats.generated} descartados=${stats.skipped}${opts.dryRun ? ' (dry-run: nada escrito)' : ''}`);
  } catch (e) {
    console.error(`mine: ${e.message}`);
    process.exit(1);
  }
}
