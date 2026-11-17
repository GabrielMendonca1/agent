#!/usr/bin/env node
/**
 * Ícone do Megamind na barra de status: só aparece quando o cwd pertence a um
 * projeto do Mainframe (ARCA ou Omni). Sessão num diretório sem projeto
 * vinculado não mostra nada — nem "connecting".
 *
 * Carrega a extensão real (extensions/megamind/index.ts) com um Pi falso, uma
 * credencial fictícia e a rede desligada. Nada sai da máquina.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = process.env.AGENT_STORE ? resolve(process.env.AGENT_STORE) : join(homedir(), '.local/share/agent');

function findPiRoot() {
  if (process.env.AGENT_PI_ROOT) return realpathSync(process.env.AGENT_PI_ROOT);
  const relative = 'lib/node_modules/@earendil-works/pi-coding-agent';
  const current = join(store, 'current', relative);
  if (existsSync(join(current, 'dist/index.js'))) return realpathSync(current);
  const releases = join(store, 'releases');
  const candidates = (existsSync(releases) ? readdirSync(releases) : [])
    .map((name) => join(releases, name, relative))
    .filter((p) => existsSync(join(p, 'dist/index.js')));
  return candidates.length ? realpathSync(candidates.sort().at(-1)) : null;
}

const piRoot = findPiRoot();
if (!piRoot) {
  console.log('skip: Pi não encontrado no store do overlay');
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), 'agent-megamind-status-'));
const saved = { ...process.env };
const realFetch = globalThis.fetch;
try {
  const tokenFile = join(root, 'token');
  writeFileSync(tokenFile, 'device-credential-fictional');
  chmodSync(tokenFile, 0o600);
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ endpoint: 'https://mainframe.example/api/arca/mcp', token_file: tokenFile }));
  process.env.ARCA_MEGAMIND_CONFIG = config;
  process.env.HOME = root;
  delete process.env.ARCA_MEGAMIND_AUTO;
  delete process.env.ARCA_PROJECTS_AUTO;

  const req = createRequire(join(piRoot, 'package.json'));
  const { createJiti } = req('jiti');
  const dep = (name) => join(piRoot, 'node_modules', name);
  const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
    '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'),
    '@earendil-works/pi-ai': dep('@earendil-works/pi-ai'),
    '@earendil-works/pi-tui': dep('@earendil-works/pi-tui'),
    typebox: join(piRoot, 'node_modules/typebox/build/index.mjs'),
  } });
  const mod = await jiti.import(join(repo, 'extensions/megamind/index.ts'));
  const megamind = mod.default ?? mod;

  /** Uma sessão Pi falsa no `cwd`; devolve as escritas do status `megamind`. */
  async function session(cwd) {
    const handlers = new Map();
    const pi = {
      on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
      registerTool() {}, registerCommand() {}, registerFlag() {}, getFlag() {}, registerMessageRenderer() {},
      sendMessage() {}, sendUserMessage() {}, appendEntry() {},
    };
    megamind(pi);
    const writes = [];
    const ctx = {
      mode: 'tui', hasUI: true, cwd,
      isIdle: () => true,
      sessionManager: { getSessionId: () => '019a0000-0000-7000-8000-00000000abcd' },
      ui: {
        theme: { fg: (_c, t) => t, bold: (t) => t },
        setStatus: (key, value) => { if (key === 'megamind') writes.push(value); },
        notify() {}, setWidget() {},
      },
    };
    for (const handler of handlers.get('session_start') ?? []) await handler({ reason: 'startup' }, ctx);
    await new Promise((r) => setTimeout(r, 400));
    for (const handler of handlers.get('session_shutdown') ?? []) await handler({ reason: 'quit' }, ctx);
    return writes;
  }

  // Catálogo falso: só o repo `github.com/arca/demo` pertence a um projeto.
  // Qualquer outra chamada ao Mainframe falha (presença não registra).
  globalThis.fetch = async (_url, init) => {
    const rpc = JSON.parse(String(init?.body ?? '{}'));
    if (rpc.method === 'tools/call' && rpc.params?.name === 'projects_list') {
      const result = { items: [{ id: 'proj-arca-demo', repos: ['github.com/arca/demo'] }] };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });
    }
    throw new Error('offline in test');
  };

  const plain = mkdtempSync(join(root, 'no-repo-')); // sem git: nenhum projeto
  let shown = (await session(plain)).filter(Boolean);
  assert.deepEqual(shown, [], `Megamind apareceu fora de projeto: ${JSON.stringify(shown)}`);
  console.log('ok cwd sem repo não publica o status megamind');

  const foreign = mkdtempSync(join(root, 'foreign-'));
  execFileSync('git', ['init', '-q', foreign]);
  execFileSync('git', ['-C', foreign, 'remote', 'add', 'origin', 'git@github.com:someone/other.git']);
  shown = (await session(foreign)).filter(Boolean);
  assert.deepEqual(shown, [], `Megamind apareceu em repo fora do catálogo: ${JSON.stringify(shown)}`);
  console.log('ok repo fora do catálogo ARCA/Omni não publica o status megamind');

  const linked = mkdtempSync(join(root, 'linked-'));
  execFileSync('git', ['init', '-q', linked]);
  execFileSync('git', ['-C', linked, 'remote', 'add', 'origin', 'git@github.com:arca/demo.git']);
  shown = (await session(linked)).filter(Boolean);
  assert.ok(shown.length > 0 && shown.every((v) => /megamind/.test(v)), `projeto vinculado sem ícone: ${JSON.stringify(shown)}`);
  console.log('ok repo de projeto vinculado mostra o status megamind');

  console.log('megamind-status: 3 checks');
} finally {
  globalThis.fetch = realFetch;
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(root, { recursive: true, force: true });
}
