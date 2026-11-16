#!/usr/bin/env node
/** Startup compacto com uma dica e capabilities de empresa. Sem rede. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = process.env.AGENT_STORE ? resolve(process.env.AGENT_STORE) : join(homedir(), '.local/share/agent');
function findPiRoot() {
  if (process.env.AGENT_JUICE_PI_ROOT) return realpathSync(process.env.AGENT_JUICE_PI_ROOT);
  const relative = 'lib/node_modules/@earendil-works/pi-coding-agent';
  const current = join(store, 'current', relative);
  if (existsSync(join(current, 'dist/index.js'))) return realpathSync(current);
  const releases = join(store, 'releases');
  const c = (existsSync(releases) ? readdirSync(releases) : []).map((n) => join(releases, n, relative)).filter((p) => existsSync(join(p, 'dist/index.js')));
  return c.length ? realpathSync(c.sort().at(-1)) : null;
}
const piRoot = findPiRoot();
assert.ok(piRoot, 'Pi não encontrado no store do overlay');

const req = createRequire(join(piRoot, 'package.json'));
const { createJiti } = req('jiti');
const dep = (n) => join(piRoot, 'node_modules', n);
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'),
  '@earendil-works/pi-ai': dep('@earendil-works/pi-ai'),
  '@earendil-works/pi-tui': dep('@earendil-works/pi-tui'),
  typebox: join(piRoot, 'node_modules/typebox/build/index.mjs'),
} });
const dir = join(repo, 'agent/extensions/agent/tui');
const logo = await jiti.import(join(dir, 'logo.ts'));
const { visibleWidth } = await jiti.import(dep('@earendil-works/pi-tui'));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const theme = { fg: (_c, t) => t, bold: (t) => t };

const home = mkdtempSync(join(tmpdir(), 'agent-header-'));
try {
  const enroll = (d) => { mkdirSync(join(home, '.config', d), { recursive: true }); writeFileSync(join(home, '.config', d, 'config.json'), '{}'); };
  const all = new Set(['skill:arca-ops', 'skill:omni-ops']);

  // Regra ARCA/Omni
  assert.deepEqual(logo.userCompanies({}, home), []);
  enroll('arca-projects');
  assert.deepEqual(logo.userCompanies({}, home), ['arca']);
  assert.deepEqual(logo.opsSkills(all, {}, home), ['arca-ops']);
  assert.deepEqual(logo.opsSkills(new Set(['skill:omni-ops']), {}, home), [], 'skill ausente na sessão não é anunciada');
  enroll('omni-megamind');
  assert.deepEqual(logo.opsSkills(all, {}, home), ['arca-ops', 'omni-ops']);
  assert.deepEqual(logo.userCompanies({ ARCA_MEGAMIND_CONFIG: join(home, '.config/omni-megamind/config.json') }, home), ['omni']);
  assert.deepEqual(logo.userCompanies({ ARCA_MEGAMIND_CONFIG: 'none' }, home), []);
  assert.deepEqual(logo.userCompanies({ ARCA_MEGAMIND_CONFIG: '/x/outra/config.json' }, home), []);
  console.log('ok regra ARCA/Omni/ambos/nenhum');

  // Compact header with exactly one capability-aware hint.
  for (const opts of [
    { skills: ['arca-ops', 'omni-ops'], juice: true },
    { skills: ['arca-ops'], juice: false },
    { skills: [], juice: true },
    { skills: [], juice: false },
  ]) {
    const tips = logo.headerTips(theme, opts);
    assert.doesNotMatch(tips.join(' '), /shift\+tab|simple|complex/i);
    assert.equal(tips.length, 1);
    const full = logo.headerLines(150, theme, { tips }).map(strip);
    assert.equal(full[0], '✳ Agent');
    assert.equal(full.length, 2, 'marca e uma dica');
    if (opts.skills.length) for (const name of opts.skills) assert.match(full[1], new RegExp('/skill:' + name));
    else assert.match(full[1], /\/hotkeys/);
    assert.doesNotMatch(full[1], /\/subagents/, 'sem opt-in: subagentes sempre ligados');
    for (const w of [0, 1, 5, 20, 40, 100]) for (const line of logo.headerLines(w, theme, { tips })) assert.ok(visibleWidth(line) <= w);
  }
  const handlers = new Map();
  logo.default({ on: (n,h) => handlers.set(n,h), getCommands: () => [] });
  let factory;
  await handlers.get('session_start')({}, { mode: 'tui', ui: { setHeader: f => { factory = f; } } });
  const component = factory({}, theme);
  assert.equal(component.render(100).length, 2);
  component.invalidate();
  assert.equal(component.render(100).length, 2);
  factory = undefined;
  await handlers.get('session_start')({}, { mode: 'print', ui: { setHeader: f => { factory = f; } } });
  assert.equal(factory, undefined, 'fora da TUI não instala header');
  console.log('ok startup compacto: uma dica, capacidades, largura e modo headless');
} finally {
  rmSync(home, { recursive: true, force: true });
}
