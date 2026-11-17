#!/usr/bin/env node
// Every subprocess has a fixture HOME and explicit profile; never inherit the user's profile.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeAgentConfig } from './lib/agent-runtime.mjs';

const root = mkdtempSync(join(tmpdir(), 'agent-mark-migration-'));
const home = join(root, 'home'), store = join(home, '.local/share/agent'), source = join(home, '.pi/agent'), dest = join(home, '.agent');
const env = { ...process.env, HOME: home, USERPROFILE: home, AGENT_STORE: store, AGENT_REPO: resolve('.'), PI_CODING_AGENT_DIR: dest };
const put = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
const json = (path, data) => put(path, JSON.stringify(data));
function run(...args) {
  const r = spawnSync('bash', ['scripts/agent-wrapper.sh', 'migrate-from-mark', '--json', ...args], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!r.stdout.includes('SECRET_VALUE'));
  return JSON.parse(r.stdout);
}
function snapshot(path) {
  const result = [];
  function walk(p) {
    const st = lstatSync(p);
    result.push([p, st.mode, st.mtimeMs, st.isSymbolicLink() ? readlinkSync(p) : st.isFile() ? readFileSync(p).toString('base64') : 'dir']);
    if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n));
  }
  walk(path); return result;
}
try {
  const idA = 'a'.repeat(64), idB = 'b'.repeat(64);
  const a = join(store, 'runtime/releases', idA, 'agent/skills/standard');
  const b = join(store, 'runtime/releases', idB, 'agent/skills/standard');
  put(join(a, 'megamind/SKILL.md'), 'a'); put(join(b, 'megamind/SKILL.md'), 'b');
  // This is the same config commit path used for activation, pair switch and rollback.
  const config = artifactId => ({ version: 2, enabled: true, artifactId, piRoot: join(root, 'pi') });
  writeAgentConfig({ store, config: config(idA) });
  assert.equal(realpathSync(join(store, 'skills/megamind')), realpathSync(join(a, 'megamind')));
  writeAgentConfig({ store, config: config(idB) }); assert.equal(realpathSync(join(store, 'skills')), realpathSync(b));
  writeAgentConfig({ store, config: config(idA) });
  const session = join(source, 'sessions/--repo--/one.jsonl');
  put(session, '{"type":"session","version":3,"id":"existing"}\n');
  utimesSync(session, new Date('2024-01-01'), new Date('2024-01-01'));
  for (const name of ['auth.json', 'accounts.json', 'accounts-mirror.json', 'accounts.rotations/one', 'subagent-jobs/one', 'secrets/key', 'mcp.json', 'models.json', 'models-store.json', 'keybindings.json', 'project-overviews/repo', 'session-list-index.json']) put(join(source, name), 'SECRET_VALUE');
  put(join(dest, 'accounts.json'), 'Agent account preserved');
  json(join(source, 'settings.json'), { defaultProvider: 'mark-provider', defaultModel: 'mark-model', theme: 'dark', extensions: ['mark-ii'], skills: ['pi-overlay'], 'mark-ii': true });
  json(join(dest, 'settings.json'), { defaultModel: 'agent-model', extensions: ['receipt'], skills: ['receipt'] });
  put(join(source, 'superagent/state'), 'not migrated');
  put(join(home, '.local/bin/pi'), '#!/bin/bash\nexec ~/.local/share/pi-overlay/current/bin/pi "$@"\n');
  put(join(home, '.local/bin/agent'), '#!/bin/bash\nprintf "%s" "$PI_CODING_AGENT_DIR"\n');
  chmodSync(join(home, '.local/bin/agent'), 0o755);
  const links = join(home, '.agents/skills'); mkdirSync(links, { recursive: true });
  symlinkSync(join(home, '.local/share/pi-overlay/skills/megamind'), join(links, 'megamind'));
  symlinkSync(join(home, '.local/share/pi-overlay/skills/prometheus'), join(links, 'prometheus'));
  symlinkSync('/unrelated', join(links, 'custom'));
  const durable = join(source, 'durable-sessions/12345678-1234-4234-8234-123456789abc');
  mkdirSync(durable, { recursive: true });
  const db = new DatabaseSync(join(durable, 'session.sqlite'));
  db.exec('CREATE TABLE entries (id INTEGER, record TEXT)');
  db.prepare('INSERT INTO entries VALUES (?, ?)').run(1, JSON.stringify({ id: 1, conversationId: 1, kind: 'pi.user', model: [{ role: 'user', content: 'hello', timestamp: 1704067200000 }] })); db.close();
  json(join(durable, 'meta.json'), { cwd: '/fixture/repo', created: 1704067200000 });
  const worktree = join(source, 'mark/worktrees/repo'); mkdirSync(worktree, { recursive: true });
  assert.equal(spawnSync('git', ['init', '-q', worktree], { env }).status, 0);
  put(join(worktree, 'dirty'), 'work');
  const before = snapshot(home), origin = snapshot(source);
  const dry = run('--dry-run'); assert.ok(dry.copied.length > 10); assert.ok(dry.manual.length >= 3);
  assert.deepEqual(snapshot(home), before, 'dry-run must not change fixture HOME');
  const migrated = run(); assert.ok(migrated.copied.length > 10);
  assert.deepEqual(snapshot(source), origin, 'Mark origin remains intact');
  assert.equal(statSync(join(dest, 'sessions/--repo--/one.jsonl')).mtimeMs, statSync(session).mtimeMs);
  assert.equal(statSync(join(dest, 'auth.json')).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(dest, 'accounts.json'), 'utf8'), 'Agent account preserved');
  assert.deepEqual(JSON.parse(readFileSync(join(dest, 'settings.json'))), { defaultModel: 'agent-model', extensions: ['receipt'], skills: ['receipt'], defaultProvider: 'mark-provider', theme: 'dark' });
  assert.equal(realpathSync(join(links, 'megamind')), realpathSync(join(a, 'megamind')));
  writeAgentConfig({ store, config: config(idB) });
  assert.equal(realpathSync(join(links, 'megamind')), realpathSync(join(b, 'megamind')));
  writeAgentConfig({ store, config: config(idA) });
  const forwarded = spawnSync('bash', [join(home, '.local/bin/pi')], { env: { ...env, PI_CODING_AGENT_DIR: '/wrong-profile' }, encoding: 'utf8' });
  assert.equal(forwarded.status, 0); assert.equal(forwarded.stdout, dest);
  assert.ok(!existsSync(join(links, 'prometheus'))); assert.equal(readlinkSync(join(links, 'custom')), '/unrelated');
  assert.ok(lstatSync(join(home, '.agents/mark-migration-backups/prometheus.before-agent-migration')).isSymbolicLink());
  const after = snapshot(home); assert.equal(run().copied.length, 0); assert.deepEqual(snapshot(home), after);
  // Both a redirected root and project directory must skip durable publication with a pending item.
  const planned = dry.copied.find(e => e.path.endsWith('_12345678-1234-4234-8234-123456789abc.jsonl')).path;
  rmSync(planned);
  rmSync(join(dest, 'sessions'), { recursive: true });
  for (const redirected of [join(dest, 'sessions'), dirname(planned)]) {
    mkdirSync(dirname(redirected), { recursive: true });
    symlinkSync(join(source, 'sessions'), redirected);
    const originBefore = snapshot(source), homeBefore = snapshot(home);
    const redirectedDry = run('--dry-run');
    assert.ok(redirectedDry.manual.some(e => /symlink in destination path/.test(e.reason)));
    assert.deepEqual(snapshot(home), homeBefore, 'redirected dry-run must not write to either profile');
    const redirectedReport = run();
    assert.ok(redirectedReport.skipped.some(e => /symlink in destination path/.test(e.reason)));
    assert.ok(redirectedReport.manual.some(e => /symlink in destination path/.test(e.reason)));
    assert.deepEqual(snapshot(source), originBefore, 'redirected import must not alter Mark');
    assert.ok(!existsSync(join(source, 'sessions', planned.split('/').pop())));
    rmSync(redirected);
  }
  // A destination symlink must never redirect credentials outside the fixture profile.
  rmSync(join(dest, 'auth.json')); symlinkSync(join(root, 'outside'), join(dest, 'auth.json'));
  assert.ok(!run().copied.some(e => e.path === join(dest, 'auth.json'))); assert.ok(!existsSync(join(root, 'outside')));
  console.log('ok Mark migration: isolated HOME, dry-run, copy, durable import, repeat, privacy, backups, skill realpath');
} finally { rmSync(root, { recursive: true, force: true }); }
