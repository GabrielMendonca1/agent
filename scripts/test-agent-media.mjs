#!/usr/bin/env node
/**
 * Prova offline de duas coisas distintas:
 *
 * 1) ANÚNCIO: a descrição da tool `subagent` expõe o conjunto REAL de tools de
 *    cada papel (o que está no .md dele), sem inventar, e diz que executável/
 *    transcrição exige papel com `bash`. Unidade, sem Pi.
 *
 * 2) IMAGEM, medido no Pi REAL (dist/cli.js) contra um provider Anthropic
 *    roteirizado em loopback (scripts/lib/fake-anthropic.mjs), com um PNG 1x1 de
 *    fixture. Cada caso roda duas vezes, nos dois papéis que importam:
 *      - "principal": conjunto de tools padrão (como o pai/worker);
 *      - "scout":     `--tools read,grep,find,ls`, exatamente o que o runner
 *                     passa para um papel read-only.
 *    (a) read nativo do Pi clássico envia imagem ao provider nos dois papéis,
 *        mantendo read-only, sem o antigo override read-media.
 *    (b) anexo direto (@arquivo) continua chegando ao provider.
 *    Nenhuma chamada sai da máquina; nada fora do diretório temporário é escrito.
 *
 * `node scripts/test-agent-media.mjs`
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeAnthropic } from './lib/fake-anthropic.mjs';

// Permite repetir a mesma prova sobre os bytes do artefato instalado, sem usar seu perfil.
const repo = resolve(process.env.AGENT_MEDIA_SOURCE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const store = process.env.AGENT_STORE ? resolve(process.env.AGENT_STORE) : join(homedir(), '.local/share/agent');
let checks = 0;
const ok = (name) => { checks++; console.log(`ok ${name}`); };

// PNG 1x1 (fixture binária mínima, gerada aqui mesmo; nenhum arquivo real é usado).
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

function findPiRoot() {
  if (process.env.AGENT_PI_ROOT) return realpathSync(process.env.AGENT_PI_ROOT);
  if (process.env.AGENT_PI_ROOT) return realpathSync(process.env.AGENT_PI_ROOT);
  const relative = join('lib/node_modules/@earendil-works/pi-coding-agent');
  const current = join(store, 'current', relative);
  if (existsSync(join(current, 'dist/cli.js'))) return realpathSync(current);
  const releases = join(store, 'releases');
  const candidates = (existsSync(releases) ? readdirSync(releases) : [])
    .map((name) => join(releases, name, relative))
    .filter((p) => existsSync(join(p, 'dist/cli.js')));
  return candidates.length ? realpathSync(candidates.sort().at(-1)) : null;
}

// ---- 1) unidade: anúncio dos papéis -----------------------------------------
async function announcement(piRoot) {
  const root = mkdtempSync(join(tmpdir(), 'agent-media-ann-'));
  const saved = { ...process.env };
  try {
    const agents = join(root, 'agent/agents');
    mkdirSync(agents, { recursive: true });
    // Fixtures com as MESMAS formas que existem em disco: lista inline, lista YAML
    // e papel sem `tools` (que herda o conjunto padrão).
    writeFileSync(join(agents, 'scout.md'), '---\nname: scout\ndescription: recon read-only\ntools: read, grep, find, ls\n---\nleia.\n');
    writeFileSync(join(agents, 'visual.md'), '---\nname: visual\ndescription: imagens\ntools: [read]\n---\nveja.\n');
    writeFileSync(join(agents, 'worker.md'), '---\nname: worker\ndescription: implementação\n---\nfaça.\n');
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    process.env.PI_CODING_AGENT_DIR = join(root, 'agent');
    const req = createRequire(join(piRoot, 'package.json'));
    const { createJiti } = req('jiti');
    const dep = (name) => join(piRoot, 'node_modules', name);
    const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false, alias: {
      '@earendil-works/pi-coding-agent': join(piRoot, 'dist/index.js'),
      '@earendil-works/pi-ai': dep('@earendil-works/pi-ai'),
      '@earendil-works/pi-tui': dep('@earendil-works/pi-tui'),
      typebox: join(piRoot, 'node_modules/typebox/build/index.mjs'),
    } });
    const mod = await jiti.import(join(repo, 'agent/extensions/brain-live/subagent/index.ts'));
    const { describeAgentTools, describeUserAgents } = mod;

    assert.equal(describeAgentTools({ tools: ['read', 'grep'] }), 'tools: read, grep');
    assert.match(describeAgentTools({}), /default set/);
    assert.match(describeAgentTools({ tools: [] }), /default set/);
    ok('helper imprime a lista real e nomeia o conjunto padrão quando o papel não declara tools');

    const text = describeUserAgents();
    assert.match(text, /scout — recon read-only \[tools: read, grep, find, ls\]/, text);
    assert.match(text, /visual — imagens \[tools: read\]/, text);
    assert.match(text, /worker — implementação \[tools: default set \(all tools of this build\)\]/, text);
    for (const role of ['scout', 'visual']) {
      const tools = text.split(`${role} — `)[1]?.split('[tools: ')[1]?.split(']')[0];
      assert.ok(tools && !tools.split(/,\s*/).includes('bash'), `nenhuma tool inventada para papel read-only ${role}`);
    }
    ok('anúncio lista o conjunto real de tools por papel, sem inventar');

    // A frase de roteamento por capacidade é exportada e entra na descrição da tool.
    const description = mod.SUBAGENT_CAPABILITY_RULE;
    assert.match(description, /`bash`/);
    assert.match(description, /read\/grep\/find\/ls/);
    assert.match(description, /ffmpeg|whisper/);
    assert.match(description, /selected model supports images/);
    assert.match(description, /503.*availability/);
    ok('roteamento: executável exige bash; imagens exigem modelo capaz; 503 não é falta de ferramenta');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- 2) integração: Pi real + provider falso, imagem via `read` e anexada ----
function imageBlocks(payload) {
  const found = [];
  for (const message of payload?.messages ?? []) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === 'image') found.push(block);
      // Resultado de tool: um bloco de imagem poderia vir embrulhado no tool_result.
      for (const inner of Array.isArray(block?.content) ? block.content : []) {
        if (inner?.type === 'image') found.push(inner);
      }
    }
  }
  return found;
}

function toolResults(payload) {
  const out = [];
  for (const message of payload?.messages ?? []) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'tool_result') out.push(JSON.stringify(block.content));
    }
  }
  return out.join('\n');
}

/** Os dois papéis que importam: o conjunto padrão e o read-only que o runner dá ao scout. */
const ROLES = [
  ['principal (tools padrão)', []],
  ['scout (--tools read,grep,find,ls)', ['--tools', 'read,grep,find,ls']],
];

async function imageReachesProvider(piRoot) {
  const root = mkdtempSync(join(tmpdir(), 'agent-media-img-'));
  try {
    const agentDir = join(root, 'agent');
    const cwd = join(root, 'projeto');
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const png = join(cwd, 'pixel.png');
    writeFileSync(png, PNG_1X1);

    const run = async ({ roleArgs, script, promptArgs }) => {
      const fake = await startFakeAnthropic(script);
      try {
        writeFileSync(join(agentDir, 'models.json'), `${JSON.stringify({
          providers: { anthropic: { baseUrl: fake.baseUrl, apiKey: 'agent-media-test-not-a-key', compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true } } },
        }, null, 2)}\n`);
        const result = await new Promise((done) => {
          const child = spawn(process.execPath, [
            join(piRoot, 'dist/cli.js'),
            '--mode', 'json', '-p', '--no-session', '--no-extensions', '--no-skills',
            '--model', 'anthropic/claude-haiku-5-5',
            ...roleArgs,
            ...promptArgs,
          ], {
            cwd, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
            env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, NODE_OPTIONS: '',
              PI_DURABLE_HOST: '0',
              AGENT_JUICE_ENABLED: '1', AGENT_JUICE_BIN: '/nonexistent-offline-fixture', AGENT_JUICE_HOME: join(root, 'juice'), AGENT_JUICE_STATE: join(root, 'juice/run.json') },
          });
          let out = '', err = '';
          child.stdout.on('data', (d) => { out += d; });
          child.stderr.on('data', (d) => { err += d; });
          child.on('close', (code) => done({ code, out, err }));
        });
        return { result, payloads: fake.messages() };
      } finally {
        await fake.close();
      }
    };

    // (a) read nativo: imagem de verdade no request seguinte, nos dois papéis.
    // Sem carregar read-media: a antiga limitação era do host experimental 1.1.0.
    for (const host of ['classic']) for (const [role, roleArgs] of ROLES) {
      const label = `${host}/${role}`;
      const { result, payloads } = await run({
        roleArgs, host,
        script: [{ tool: { name: 'read', input: { path: png } } }, { text: 'nao consegui ver' }],
        promptArgs: [`Leia a imagem ${png} e descreva.`],
      });
      assert.equal(result.code, 0, `${label}: Pi saiu com ${result.code}\n${result.err.slice(0, 2000)}`);
      assert.ok(payloads.length >= 2, `${label}: o modelo não voltou ao provider depois do read (${payloads.length} requisições)`);
      const names = (payloads[0].tools ?? []).map((t) => t.name);
      assert.ok(names.includes('read'), `${label}: tool read não foi declarada: ${names.join(',')}`);
      if (roleArgs.length) assert.ok(!names.includes('bash'), `${label}: papel read-only não pode receber bash: ${names.join(',')}`);
      const images = imageBlocks(payloads[1]);
      assert.equal(images.length, 1, `${label}: read deve entregar imagem, resultado: ${toolResults(payloads[1]).slice(0, 1000)}`);
      assert.equal(images[0].source?.media_type, 'image/png');
      assert.ok(Buffer.from(images[0].source.data, 'base64').equals(PNG_1X1), 'bytes preservados');
      assert.doesNotMatch(toolResults(payloads[1]), /reading images is not supported/);
      ok(`${label}: read de PNG chega ao provider com bytes corretos, sem ampliar tools`);
    }

    // O read nativo mantém offset/limit e respeita o loadout de cada papel.
    const textFile = join(cwd, 'text.txt');
    writeFileSync(textFile, 'alpha\nbeta\ngamma\n');
    for (const host of ['classic']) {
      const text = await run({ host, roleArgs: ROLES[1][1], script: [{ tool: { name: 'read', input: { path: textFile, offset: 2, limit: 1 } } }, { text: 'fim' }], promptArgs: ['Leia a segunda linha.'] });
      assert.equal(text.result.code, 0, text.result.err);
      assert.match(toolResults(text.payloads[1]), /beta/);
      assert.doesNotMatch(toolResults(text.payloads[1]), /alpha|gamma/);
      const restricted = await run({ host, roleArgs: ['--tools', 'ls'], script: [{ text: 'fim' }], promptArgs: ['Liste se necessário.'] });
      assert.equal(restricted.result.code, 0, restricted.result.err);
      const tools = restricted.payloads[0].tools.map(t => t.name);
      assert.ok(!tools.includes('read'), `${host}: loadout sem read não pode ganhar read: ${tools}`);
      assert.ok(!tools.includes('bash'));
      ok(`${host}: texto/offset preservados e loadout sem read não ganha read`);
    }

    // (b) imagem anexada na mensagem: chega ao provider, nos dois papéis.
    for (const [label, roleArgs] of ROLES) {
      const { result, payloads } = await run({
        roleArgs,
        script: [{ text: 'vi a imagem' }],
        promptArgs: ['--', `@${png}`, 'Descreva a imagem anexada.'],
      });
      assert.equal(result.code, 0, `${label}: Pi saiu com ${result.code}\n${result.err.slice(0, 2000)}`);
      assert.ok(payloads.length >= 1, `${label}: nenhuma requisição chegou ao provider`);
      const blocks = imageBlocks(payloads[0]);
      assert.ok(blocks.length >= 1, `${label}: imagem anexada não chegou: ${JSON.stringify(payloads[0].messages).slice(0, 1200)}`);
      assert.equal(blocks[0].source?.type, 'base64', `${label}: fonte: ${JSON.stringify(blocks[0].source).slice(0, 300)}`);
      assert.match(blocks[0].source?.media_type ?? '', /^image\/png$/, `${label}: media_type inesperado`);
      assert.ok(Buffer.from(blocks[0].source.data, 'base64').equals(PNG_1X1), `${label}: bytes da imagem diferentes da fixture`);
      ok(`${label}: imagem anexada (@caminho) chega ao provider como ${blocks[0].source.media_type} base64 idêntico à fixture`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const piRoot = findPiRoot();
if (!piRoot) {
  console.log(`sem release do Pi com CLI clássico em ${store}; teste de mídia pulado`);
  process.exit(0);
}
await announcement(piRoot);
await imageReachesProvider(piRoot);
console.log(`${checks} checks passed`);
