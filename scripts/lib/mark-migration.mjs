import { constants, chmodSync, copyFileSync, existsSync, lstatSync, linkSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const info = p => { try { return lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const within = (root, p) => p === root || p.startsWith(root + sep);

export function migrateFromMark({ platform = process.platform, createSymlink = symlinkSync, dryRun = false, home = homedir(), store = process.env.AGENT_STORE || join(home, '.local/share/agent'), destination = process.env.PI_CODING_AGENT_DIR || join(home, '.agent') } = {}) {
  home = resolve(home); store = resolve(store); destination = resolve(destination);
  const source = join(home, '.pi/agent'), markStore = join(home, '.local/share/pi-overlay');
  if (within(source, destination) || within(destination, source)) throw new Error('Source and destination overlap');
  const report = { dryRun, copied: [], alreadyExisted: [], skipped: [], manual: [] };
  const record = (kind, path, reason) => report[kind].push({ path, reason });
  // Never follow source or destination symlinks when copying profile data.
  function safeParents(path) {
    for (let p = path; ; p = dirname(p)) {
      if (info(p)?.isSymbolicLink()) throw new Error(`Symlink in profile path: ${p}`);
      if (p === home || dirname(p) === p) break;
    }
  }
  safeParents(source); safeParents(destination);
  function copy(src, dst) {
    const st = info(src);
    if (!st) return;
    safeParents(dirname(dst));
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) { record('skipped', src, 'not a regular file/directory'); return; }
    const old = info(dst);
    if (st.isDirectory()) {
      if (old && !old.isDirectory()) { record('skipped', dst, 'destination is not a directory'); return; }
      for (const name of readdirSync(src).sort()) copy(join(src, name), join(dst, name));
    } else if (old) record('alreadyExisted', dst, 'never overwritten');
    else {
      record('copied', dst, 'copy missing file (private mode, preserved mtime)');
      if (!dryRun) {
        mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
        const temp = `${dst}.migration-${process.pid}`;
        copyFileSync(src, temp, constants.COPYFILE_EXCL);
        try { chmodSync(temp, 0o600); utimesSync(temp, st.atime, st.mtime); linkSync(temp, dst); }
        finally { unlinkSync(temp); }
      }
    }
  }
  for (const name of ['sessions', 'subagent-jobs', 'auth.json', 'accounts.json', 'accounts-mirror.json', 'accounts.rotations', 'mcp.json', 'models.json', 'models-store.json', 'keybindings.json', 'project-overviews', 'session-list-index.json', 'secrets']) copy(join(source, name), join(destination, name));
  const settings = join(source, 'settings.json'), targetSettings = join(destination, 'settings.json');
  if (info(settings)?.isFile()) {
    safeParents(targetSettings);
    const from = JSON.parse(readFileSync(settings, 'utf8'));
    const originalSettings = existsSync(targetSettings) ? readFileSync(targetSettings, 'utf8') : null;
    const to = originalSettings === null ? {} : JSON.parse(originalSettings);
    if (!from || typeof from !== 'object' || Array.isArray(from) || !to || typeof to !== 'object' || Array.isArray(to)) throw new Error('Settings must be JSON objects');
    let changed = false;
    for (const [key, value] of Object.entries(from)) {
      if (!['defaultProvider', 'defaultModel', 'theme', 'defaultThinkingLevel'].includes(key) || /mark-ii|pi-overlay/.test(JSON.stringify({ [key]: value }))) {
        record('skipped', `${settings}#${key}`, 'not an allowed user default; resource registrations never migrated');
        if (/mark-ii|pi-overlay/.test(JSON.stringify({ [key]: value }))) record('manual', `${settings}#${key}`, 'Mark-specific setting not migrated');
      } else if (Object.hasOwn(to, key)) record('alreadyExisted', `${targetSettings}#${key}`, 'user default preserved');
      else { to[key] = value; changed = true; record('copied', `${targetSettings}#${key}`, 'missing user default'); }
    }
    if (changed && !dryRun) {
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      const temp = `${targetSettings}.migration-${process.pid}`;
      writeFileSync(temp, JSON.stringify(to, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      try {
        const current = existsSync(targetSettings) ? readFileSync(targetSettings, 'utf8') : null;
        if (current !== originalSettings) throw new Error('Destination settings changed during migration; retry');
        renameSync(temp, targetSettings);
      } finally { if (info(temp)) unlinkSync(temp); }
    }
  }
  const durable = join(source, 'durable-sessions');
  if (info(durable)) {
    const args = [fileURLToPath(new URL('../import-durable-sessions.mjs', import.meta.url)), '--source', durable, '--destination', join(destination, 'sessions')];
    if (dryRun) args.push('--dry-run');
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    // Importer emits metadata only; do not expose raw child output or errors.
    if (result.status !== 0) record('manual', durable, 'durable importer failed; rerun import-durable-sessions.mjs with explicit source/destination');
    {
      for (const line of (result.stdout || '').split('\n')) {
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.status === 'skipped' && /symlink in destination path/.test(event.reason)) record('manual', event.target || event.source || durable, event.reason);
        if (event.status) record(event.status === 'skipped' ? (/exists/.test(event.reason) ? 'alreadyExisted' : 'skipped') : 'copied', event.target || event.source || durable, event.reason || event.status);
      }
    }
  }
  function backup(path) {
    const base = info(path).isSymbolicLink() ? join(dirname(dirname(path)), "mark-migration-backups", basename(path)) : path;
    let dst = `${base}.before-agent-migration`, n = 0;
    while (info(dst)) dst = `${base}.before-agent-migration-${++n}`;
    if (!dryRun) {
      mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
      if (info(path).isSymbolicLink()) createSymlink(resolve(dirname(path), readlinkSync(path)), dst, platform === 'win32' ? 'junction' : undefined);
      else { copyFileSync(path, dst, constants.COPYFILE_EXCL); chmodSync(dst, info(path).mode & 0o777); }
    }
    return dst;
  }
  const shellQuote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  const windowsProfile = destination === join(home, '.agent') ? '%USERPROFILE%\\.agent' : destination.replaceAll('%', '%%');
  const wrappers = platform === 'win32' ? [
    ['pi.cmd', `@echo off\r\nrem agent Mark migration forwarding wrapper\r\nset "PI_CODING_AGENT_DIR=${windowsProfile}"\r\ncall "%~dp0agent.cmd" %*\r\nexit /b %errorlevel%\r\n`],
    ['pi.ps1', `# agent Mark migration forwarding wrapper\n$env:PI_CODING_AGENT_DIR = '${destination.replaceAll("'", "''")}'\n& "$PSScriptRoot/agent.cmd" @args\nexit $LASTEXITCODE\n`],
  ] : [['pi', `#!/usr/bin/env bash\n# agent Mark migration forwarding wrapper\nexport PI_CODING_AGENT_DIR=${shellQuote(destination)}\nexec ${shellQuote(join(home, '.local/bin/agent'))} "$@"\n`]];
  for (const [name, forwarding] of wrappers) {
    const wrapper = join(home, '.local/bin', name);
    if (info(wrapper)?.isFile()) {
      const content = readFileSync(wrapper, 'utf8');
      if (content === forwarding || (/(?:exec\s+.*agent|agent\.cmd)/.test(content) && !/pi-overlay|mark-ii/.test(content))) record('alreadyExisted', wrapper, 'already forwards to Agent');
      else if (/pi-overlay|mark-ii/.test(content) && !existsSync(join(home, platform === 'win32' ? '.local/bin/agent.cmd' : '.local/bin/agent'))) record('manual', wrapper, 'Agent command missing; install Agent before replacing pi');
      else if (/pi-overlay|mark-ii/.test(content)) {
        const saved = backup(wrapper); record('copied', wrapper, `forward to Agent; backup: ${saved}`);
        if (!dryRun) { const temp = `${wrapper}.migration-${process.pid}`; writeFileSync(temp, forwarding, { flag: 'wx', mode: 0o755 }); renameSync(temp, wrapper); }
      } else record('skipped', wrapper, 'unrecognized wrapper; preserved');
    } else record('skipped', wrapper, 'missing or not a regular wrapper; preserved');
  }
  const skills = join(home, '.agents/skills');
  safeParents(dirname(skills));
  if (info(skills)?.isDirectory() && !info(skills).isSymbolicLink() && !existsSync(join(store, 'skills'))) record('manual', skills, 'Agent standard skills unavailable; activate Agent before migrating links');
  else if (info(skills)?.isDirectory() && !info(skills).isSymbolicLink()) {
    for (const name of readdirSync(skills).sort()) {
      const link = join(skills, name);
      if (!info(link)?.isSymbolicLink()) continue;
      const target = resolve(skills, readlinkSync(link));
      if (!within(markStore, target)) continue;
      const standard = join(store, 'skills', name), saved = backup(link);
      const available = existsSync(standard);
      record('copied', link, `${available ? 'repoint to Agent' : 'remove obsolete Mark link'}; backup: ${saved}`);
      if (!dryRun) { unlinkSync(link); if (available) createSymlink(resolve(standard), link, platform === 'win32' ? 'junction' : undefined); }
    }
  }
  if (info(join(source, 'superagent'))) record('manual', join(source, 'superagent'), 'daemon state not migrated; stop/reconfigure manually');
  const worktrees = join(source, 'mark/worktrees');
  function inspectTrees(path) {
    if (!info(path)?.isDirectory() || info(path).isSymbolicLink()) return;
    if (info(join(path, '.git'))) {
      const git = args => spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', path, ...args], { encoding: 'utf8' });
      const dirty = git(['status', '--porcelain']), branch = git(['branch', '--show-current']);
      const ahead = git(['rev-list', '--count', '@{upstream}..HEAD']);
      if (dirty.status !== 0 || dirty.stdout.trim() || ahead.status !== 0 || Number(ahead.stdout) > 0) record('manual', path, `worktree preserved; branch ${branch.stdout.trim() || '(detached)'}; ${dirty.stdout.trim() ? 'dirty; ' : ''}${ahead.status !== 0 ? 'no upstream/integration unknown' : `${Number(ahead.stdout)} commits ahead of upstream`}`);
      return;
    }
    for (const name of readdirSync(path)) inspectTrees(join(path, name));
  }
  inspectTrees(worktrees);
  return report;
}
