#!/usr/bin/env node
// Monta um perfil isolado do Agent (HOME próprio e extensões do repo)
// e um launcher. Prepare only; never starts Pi, reads auth contents, or
// changes global settings. `--install` grava `~/.local/bin/mark2` apontando
// para o perfil novo (o único efeito fora do perfil).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyAgentResources, planAgentResources } from './lib/agent-resources.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
// cpSync({ dereference:true }) no Node 26/macOS preservou links aninhados no
// caminho rápido de diretórios. Aqui isolamento é requisito, não otimização:
// percorra explicitamente e copie ARQUIVOS; nunca recrie um link da origem.
function copyIsolatedTree(from, to, ancestors = new Set()) {
  const real = realpathSync(from);
  const stat = statSync(from);
  if (stat.isDirectory()) {
    if (ancestors.has(real)) throw new Error(`Ciclo de symlink ao copiar perfil: ${from}`);
    ancestors.add(real);
    mkdirSync(to, { recursive: true, mode: stat.mode & 0o777 });
    try { for (const name of readdirSync(from)) copyIsolatedTree(join(from, name), join(to, name), ancestors); }
    finally { ancestors.delete(real); }
  } else if (stat.isFile()) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  } else throw new Error(`Recurso não copiável no perfil isolado: ${from}`);
}
const source = resolve(option('--agent-dir', join(homedir(), '.agent')));
const piRoot = resolve(option('--pi-root', process.env.AGENT_PI_ROOT || process.env.AGENT_JUICE_PI_ROOT || join(homedir(), '.local/share/agent/current/lib/node_modules/@earendil-works/pi-coding-agent')));
if (!existsSync(join(piRoot, 'dist/core/model-runtime.js'))) throw new Error('Pi root missing; pass --pi-root');
const host = option('--host', 'classic');
if (host !== 'classic') throw new Error('--host must be classic');
const entry = 'dist/cli.js';
const root = mkdtempSync(join(resolve(option('--temp-parent', tmpdir())), 'agent-juice-test-'));
const home = join(root, 'home');
const agent = join(home, '.pi/agent');
mkdirSync(agent, { recursive: true, mode: 0o700 });
mkdirSync(join(agent, 'extensions'), { mode: 0o700 });
// Copy independent resources, not sessions, sockets, caches or live state.
// models.json may contain API keys; credentials are excluded unless --share-auth
// explicitly requests them. OAuth refresh requires the live auth file, not a copy.
for (const name of ['settings.json', 'keybindings.json', 'AGENTS.md', 'SYSTEM.md', 'APPEND_SYSTEM.md', 'extensions', 'skills', 'prompts', 'themes', 'agents', 'resource-overrides']) {
  const from = join(source, name);
  if (!existsSync(from)) continue;
  copyIsolatedTree(from, join(agent, name));
}
if (args.includes('--share-auth')) {
  if (existsSync(join(source, 'auth.json'))) symlinkSync(join(source, 'auth.json'), join(agent, 'auth.json'));
  if (existsSync(join(source, 'models.json'))) copyIsolatedTree(join(source, 'models.json'), join(agent, 'models.json'));
}
// Vault input is explicit; neither the host's default Vault nor PI_SYSTEM_DIR
// authorizes copying personal prompts, skills or model credentials.
const vaultOption = option('--vault-pi', '');
const promptOverride = option('--system-prompt', '');
if (vaultOption || promptOverride) {
  const vaultPi = vaultOption ? resolve(vaultOption) : null;
  const target = join(home, 'Sistema/Pi');
  mkdirSync(target, { recursive: true });
  for (const name of ['system-prompt.md', 'tools.md', 'compactacao.md', 'agents', 'skills']) {
    if (!vaultPi) continue;
    const from = join(vaultPi, name);
    if (existsSync(from)) copyIsolatedTree(from, join(target, name));
  }
  // `--system-prompt <arquivo>`: testa uma proposta de prompt sem tocar no Vault real.
  if (promptOverride) copyIsolatedTree(resolve(promptOverride), join(target, 'system-prompt.md'));
}
const settingsPath = join(agent, 'settings.json');
// Separa na CÓPIA os paths do Agent global antes de registrar o checkout.
// Preserva customizações (inclusive exclusões pessoais) e recursos externos;
// nenhum settings, recibo, tema ou binding global é escrito.
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {};
const configRoot = resolve(process.env.AGENT_STORE || join(homedir(), '.local/share/agent'));
const installedConfigPath = join(configRoot, 'runtime/config.json');
if (existsSync(installedConfigPath)) {
  const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
  if (installed.enabled === true && installed.resourceReceipt) {
    const receipt = JSON.parse(readFileSync(installed.resourceReceipt, 'utf8'));
    if (typeof receipt.agentDir === 'string' && resolve(receipt.agentDir) === source) {
      if (typeof receipt.agentRoot !== 'string' || !isAbsolute(receipt.agentRoot) || resolve(receipt.agentRoot) === dirname(resolve(receipt.agentRoot))) {
        throw new Error('O perfil isolado não pôde separar os recursos do Agent global: agentRoot ambíguo no recibo');
      }
      const roots = [join(configRoot, 'runtime/releases'), resolve(receipt.agentRoot)];
      const isGlobalResource = value => {
        if (typeof value !== 'string') return false;
        const path = value.replace(/^[!+-]/, '');
        if (!isAbsolute(path)) return false;
        return roots.some(base => {
          const child = relative(base, resolve(path));
          return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
        });
      };
      for (const key of ['extensions', 'skills']) {
        if (Array.isArray(settings[key])) settings[key] = settings[key].filter(value => !isGlobalResource(value));
      }
    }
  }
}
function resourcePath(value) {
  if (typeof value !== 'string') return value;
  const prefix = /^[!+-]/.test(value) ? value[0] : '';
  let p = prefix ? value.slice(1) : value;
  if (p.startsWith(source + '/')) p = agent + p.slice(source.length);
  // Preserve explicit resource paths outside agentDir and relative local paths.
  return prefix + p;
}
for (const key of ['extensions', 'skills', 'prompts', 'themes']) if (Array.isArray(settings[key])) settings[key] = settings[key].map(resourcePath);
// Aquecedor nativo só durante execuções ativas; ocioso fica com o cache-keeper (curva de retorno por projeto).
settings.cacheWarming = 'streaming';
// Keep resources loaded but hide their startup inventory. The compact Agent
// header remains visible; billing details remain in the footer.
settings.quietStartup = 'header';
// Keep warning and retry behavior consistent with the Agent profile.
settings.warnings = { ...(settings.warnings ?? {}), anthropicExtraUsage: false };
settings.retry = { ...settings.retry, enabled: false };
// Compactação do Agent (450k em janelas de 1M, reserva de 10% nas menores) também no meio
// de um run: o gatilho nativo do Pi é `janela - reserveTokens`, por modelo. Cobre os providers
// do catálogo do Pi que o Vault usa; overrides já existentes no settings prevalecem.
{
  const dataDir = join(piRoot, 'node_modules/@earendil-works/pi-ai/dist/providers/data');
  const wanted = new Set([settings.defaultProvider, 'anthropic', 'openai-codex', 'google'].filter(Boolean));
  const overrides = {};
  for (const file of existsSync(dataDir) ? readdirSync(dataDir) : []) {
    if (!wanted.has(file.replace(/\.json$/, ''))) continue;
    let data; try { data = JSON.parse(readFileSync(join(dataDir, file), 'utf8')); } catch { continue; }
    for (const models of Object.values(data)) for (const m of Object.values(models ?? {})) {
      if (m?.type !== 'chat' || !(m.contextWindow > 0)) continue;
      const at = m.contextWindow >= 1_000_000 ? 450_000 : Math.floor(m.contextWindow * 0.9);
      overrides[`${m.provider}/${m.id}`] = { reserveTokens: m.contextWindow - at };
    }
  }
  // A janela efetiva pode vir do models.json do perfil (providers.*.models / modelOverrides).
  try {
    const custom = JSON.parse(readFileSync(join(agent, 'models.json'), 'utf8'));
    for (const [provider, cfg] of Object.entries(custom.providers ?? {})) {
      const entries = [...(cfg.models ?? []).map(m => [m.id, m]), ...Object.entries(cfg.modelOverrides ?? {})];
      for (const [id, m] of entries) {
        if (!(m?.contextWindow > 0)) continue;
        const at = m.contextWindow >= 1_000_000 ? 450_000 : Math.floor(m.contextWindow * 0.9);
        overrides[`${provider}/${id}`] = { reserveTokens: m.contextWindow - at };
      }
    }
  } catch { /* sem models.json próprio: vale o catálogo */ }
  settings.compaction = { ...settings.compaction, modelOverrides: { ...overrides, ...settings.compaction?.modelOverrides } };
}
// O mesmo planner da instalação registra recursos e resolve colisões. Não há
// wrappers nem regra de exposição no perfil: as fábricas mantêm tools diretas.
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
const resources = applyAgentResources({
  plan: planAgentResources({ agentRoot: join(repo, 'agent'), agentDir: agent, homeDir: home }),
  backupDir: join(root, 'resources-backup'),
});
const env = {
  HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agent,
  XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
  PI_SYSTEM_DIR: join(home, 'Sistema'),
  PI_ACCOUNTS_MIRROR: '0', PI_OFFLINE: '1', ORCA_BACKGROUND_LAUNCH: '1',
  AGENT_RUNTIME_ENABLED: '1', AGENT_PI_ROOT: piRoot, AGENT_CHILD: '0',
  AGENT_VAULT: vaultOption || promptOverride ? '1' : '0',
  AGENT_SUBAGENTS: process.env.AGENT_SUBAGENTS === '1' ? '1' : '0',
  // Prompt cache de 1 h (Anthropic): pausa humana típica 5 min–1 h; −15% sozinho (cache-plan.md).
  PI_CACHE_RETENTION: 'long',
  // Compatibility with previously installed dual-host Pi releases.
  PI_DURABLE_HOST: '0',
  NODE_OPTIONS: `--import=${pathToFileURL(join(repo, 'agent/juice/runtime.mjs')).href}`,
};
// Existing ARCA profile paths remain supported for Megamind and Peers.
// Only --link-arca shares enrollment/mesh; --install does not imply consent.
// --arca-home permits fixtures without using real enrollment.
if (args.includes('--link-arca')) {
  const real = resolve(option('--arca-home', homedir()));
  const megamind = join(real, '.config/arca-projects/config.json');
  if (existsSync(megamind)) env.ARCA_MEGAMIND_CONFIG = megamind;
  if (existsSync(join(real, '.cache/arca-projects'))) env.ARCA_MEGAMIND_CACHE = join(real, '.cache/arca-projects');
  if (existsSync(join(real, '.pi/mesh'))) env.PI_MESH_DIR = join(real, '.pi/mesh');
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
// Keep the original project cwd, so project extensions and skills still discover.
const command = `env -u AGENT_JUICE_CHILD -u AGENT_JUICE_ENABLED -u AGENT_JUICE_HOME -u AGENT_JUICE_STATE -u AGENT_JUICE_RUN_ID -u AGENT_JUICE_PI_ROOT -u ARCA_MEGAMIND_CONFIG -u ARCA_MEGAMIND_CACHE -u PI_MESH_DIR ${Object.entries(env).map(([k, v]) => `${k}=${quote(v)}`).join(' ')} ${quote(process.execPath)} ${quote(join(piRoot, entry))}`;
writeFileSync(join(root, 'launch.sh'), `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o700 });
writeFileSync(join(root, 'environment.json'), JSON.stringify(env, null, 2) + '\n', { mode: 0o600 });
if (args.includes('--install')) {
  // Legado de desenvolvimento, não distribuidor de produção. Launcher estável: `mark2` abre o perfil mais recente; o anterior fica no disco para rollback manual.
  const bin = join(homedir(), '.local/bin');
  mkdirSync(bin, { recursive: true });
  const launcher = join(bin, 'mark2');
  if (existsSync(launcher)) rmSync(launcher);
  writeFileSync(launcher, `#!/bin/sh\n# Agent — perfil ${root}\nexec ${quote(join(root, 'launch.sh'))} "$@"\n`, { mode: 0o755 });
}
console.log(JSON.stringify({ root, agentDir: agent, host, exposure: 'direct', resourceReceipt: resources.receiptPath, launch: `${quote(join(root, 'launch.sh'))} --session <TEST_SESSION_FILE>`, coverage: 'Runtime preload without ledger. Credentials excluded unless --share-auth; Vault input requires --vault-pi or --system-prompt. Project discovery retains current cwd. Review copied settings and external resource paths before launch; isolation is not a sandbox.' }, null, 2));
