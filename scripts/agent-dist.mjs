#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digestTree, installOverlayBundle, requireVerified, assertContainedTree } from './agent-update.mjs';
import { defaultReleaseRepo, hash, inventory, nodeMin, packArchive, requireNode, schema, signManifest, validAssetId, validReleaseRepo, validReleaseTag, validateDirectory } from './lib/agent-distribution.mjs';
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
let release, merge = [], out = resolve('dist'), tag, keyPath, keygen, pubPath, privPath;
let buildOption = false;
for (let i=0;i<args.length;i++) {
 const option = args[i];
 const value = () => {
  const next = args[++i];
  if (!next || next.startsWith('--')) throw new Error(`${option} requires a value`);
  return next;
 };
 if (option === '--keygen') keygen = true;
 else if (option === '--out-pub') pubPath = resolve(value());
 else if (option === '--out-priv') privPath = resolve(value());
 else {
  buildOption = true;
  if (option === '--merge') {
   merge.push(resolve(value()));
   while (args[i+1] && !args[i+1].startsWith('--')) merge.push(resolve(value()));
  } else if (option === '--release') release = realpathSync(resolve(value()));
  else if (option === '--out') out = resolve(value());
  else if (option === '--tag') tag = value();
  else if (option === '--sign-key') keyPath = resolve(value());
  else throw new Error(`Unknown distribution option: ${option}`);
 }
}
requireNode();
if (keygen) {
 if (buildOption) throw new Error('--keygen cannot be combined with build or merge options');
 const dir = !pubPath || !privPath ? mkdtempSync(join(tmpdir(), 'agent-release-keys-')) : undefined;
 pubPath ??= join(dir, 'release-public.pem');
 privPath ??= join(dir, 'release-private.pem');
 const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
 });
 writeFileSync(pubPath, publicKey, { flag: 'wx', mode: 0o644 });
 try { writeFileSync(privPath, privateKey, { flag: 'wx', mode: 0o600 }); }
 catch (error) { rmSync(pubPath); throw error; }
 console.log(`Public key: ${pubPath}\nPrivate key: ${privPath}`);
 process.exit(0);
}
if (pubPath || privPath) throw new Error('--out-pub and --out-priv require --keygen');
tag ??= process.env.AGENT_RELEASE_TAG;
const keyEnv = keyPath ? undefined : process.env.AGENT_SIGNING_PRIVATE_KEY;
const releaseRepo = process.env.AGENT_RELEASE_REPO || defaultReleaseRepo;
const signed = tag !== undefined || keyPath !== undefined || keyEnv !== undefined;
if (signed && (!validReleaseTag(tag) || !(keyPath || keyEnv) || !validReleaseRepo(releaseRepo))) {
 throw new Error('Signing requires a valid release tag, repo and Ed25519 private key');
}
const installers = ['install.sh', 'install.ps1', 'agent-distribution.mjs'];
const isAsset = n => /^agent-.*\.tar\.gz$/.test(n) || installers.includes(n);
function writeRelease(verifiedNames) {
 const names = readdirSync(out).filter(isAsset).sort();
 if (signed && names.some(n => !verifiedNames.has(n))) throw new Error('Signing requires an output directory without unrelated assets');
 const lines = names.map(n => `${hash(readFileSync(join(out,n)))}  ${n}\n`);
 const sumsPath = join(out, 'SHA256SUMS');
 const sigPath = join(out, 'SHA256SUMS.sig');
 const latestPath = join(out, 'latest.json');
 let latest;
 if (signed) {
  const assets = Object.create(null);
  for (const file of names.filter(n => !installers.includes(n))) {
   const match = /^agent-(.+)-([a-z0-9]+-[a-z0-9]+)\.tar\.gz$/.exec(file);
   if (!match || !validAssetId(match[1])) throw new Error(`Invalid release asset name: ${file}`);
   const [, assetId, platform] = match;
   if (assets[platform]) throw new Error(`Multiple release assets for ${platform}`);
   assets[platform] = { file, assetId };
  }
  if (!Object.keys(assets).length) throw new Error('No platform assets to sign');
  latest = `${JSON.stringify({ schema, tag, repo: releaseRepo, publishedAt: new Date().toISOString(), assets }, null, 2)}\n`;
  lines.push(`${hash(latest)}  latest.json\n`);
 }
 // Never leave an old detached signature or discovery manifest after regenerating sums.
 rmSync(sigPath, { force: true });
 rmSync(latestPath, { force: true });
 writeFileSync(sumsPath, lines.join(''));
 if (signed) {
  const key = keyPath ? readFileSync(keyPath) : keyEnv.includes('-----BEGIN ') ? keyEnv : Buffer.from(keyEnv, 'base64');
  const signature = signManifest(sumsPath, key);
  writeFileSync(sigPath, `${signature}\n`);
  writeFileSync(latestPath, latest);
 }
}
if (merge.length) {
 if (release) throw new Error('--merge cannot be combined with --release');
 mkdirSync(out, { recursive: true });
 const validated = new Set();
 for (const dir of merge) {
  const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split(/\r?\n/);
  for (const name of readdirSync(dir).filter(isAsset)) {
   const bytes = readFileSync(join(dir, name)), digest = hash(bytes);
   const entries = sums.filter(line => line.slice(64, 66) === '  ' && line.slice(66) === name);
   if (entries.length !== 1 || entries[0] !== `${digest}  ${name}`) throw new Error(`Invalid input checksum: ${name}`);
   if (existsSync(join(out,name)) && hash(readFileSync(join(out,name))) !== digest) throw new Error(`Conflicting release asset: ${name}`);
   if (realpathSync(out) !== realpathSync(dir)) writeFileSync(join(out,name), bytes);
   validated.add(name);
  }
 }
 for (const name of installers) if (!existsSync(join(out,name))) throw new Error(`Missing release asset: ${name}`);
 writeRelease(validated);
 console.log(`Merged distribution at ${out}; no release published.`);
 process.exit(0);
}
// realpath: no macOS tmpdir() é /var/... (symlink de /private/var); sem isso o bin/pi da release preparada "escapa" da árvore.
const temp=realpathSync.native(mkdtempSync(join(process.env.AGENT_DIST_TMP || tmpdir(),process.platform === 'win32' ? 'ad-' : 'agent-dist-')));
try {
 const home=join(temp,'h'), store=join(temp,'s'); mkdirSync(home);
 const inherited={...process.env};
 // Preserve OS essentials (SystemRoot, ComSpec, PATHEXT, windir, PATH).
 for (const key of Object.keys(inherited)) if (/TOKEN|SECRET|API_KEY|AUTH|NODE_OPTIONS|^AGENT_|^PI_CODING_AGENT_DIR$/i.test(key)) delete inherited[key];
 const env={...inherited,HOME:home,USERPROFILE:home,PI_CODING_AGENT_DIR:join(home,'.agent'),AGENT_STORE:store,AGENT_DIST:'1',AGENT_WARM_START:'0'};
 // No inherited authentication/profile state is copied. --prepare never launches inference.
 if (!release) {
  const result=spawnSync(process.execPath,[join(repo,'scripts/agent-update.mjs'),'--prepare','--store',store],{env,stdio:'inherit'});
  if (result.status!==0) throw new Error('Distribution prepare failed');
  const receipts=readdirSync(join(store,'prepared'));
  if (receipts.length!==1) throw new Error('Expected exactly one prepared release');
  release=join(store,'releases',basename(receipts[0],'.json'));
 }
 assertContainedTree(release); requireVerified(release);
 const stage=join(temp,'payload'); mkdirSync(stage);
 cpSync(release,join(stage,'release'),{recursive:true,verbatimSymlinks:true});
 const metadataPath=join(stage,'release/agent-release.json');
 const metadata=JSON.parse(readFileSync(metadataPath,'utf8'));
 delete metadata.sourceRepo;
 writeFileSync(metadataPath,`${JSON.stringify(metadata,null,2)}\n`);
 const bundle=installOverlayBundle(join(temp,'bundle-store'));
 cpSync(bundle,join(stage,'bundle'),{recursive:true});
 // All packaged metadata is portable. Source file paths in code/docs are audited below.
 const git=spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'});
 if (git.status!==0) throw new Error('Distribution requires source commit');
 const sourceCommit=git.stdout.trim();
 const files=inventory(stage);
 for (const e of files.filter(e=>e.type==='file')) {
  if (/(^|\/)(auth\.json|\.env(?:\.[^/]*)?|credentials\.json|run(?:\.v3)?\.json)(\/|$)/i.test(e.path)) throw new Error(`Personal state forbidden: ${e.path}`);
  const body=readFileSync(join(stage,e.path));
  // Binary dependencies are platform-specific; text assets must not contain literal host home paths or keys.
  if (!body.includes(0)) {
   const text=body.toString('utf8');
   if (/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bsk-ant-[A-Za-z0-9_-]{20,}/.test(text)) throw new Error(`Possible secret in ${e.path}`);
   if ((e.path.endsWith('agent-release.json') || e.path.endsWith('package.json')) && /\/Users\/|\/home\//.test(text)) throw new Error(`Host path in metadata ${e.path}`);
  }
 }
 const artifact={schema:1,runtimeContract:3,releaseId:`${basename(release)}-${hash(JSON.stringify(files)).slice(0,10)}`,sourceCommit,overlayFingerprint:metadata.overlayFingerprint,treeDigest:digestTree(join(stage,'release')),platforms:[{os:process.platform,arch:process.arch}],node:{kind:'external',min:nodeMin},profileDefault:'~/.agent',manifestSha256:hash(readFileSync(join(stage,'bundle/overlay/manifest.json'))),contentDigest:hash(JSON.stringify(files)),files};
 writeFileSync(join(stage,'artifact.json'),`${JSON.stringify(artifact,null,2)}\n`);
 validateDirectory(stage);
 mkdirSync(out,{recursive:true});
 const name=`agent-${artifact.releaseId}-${process.platform}-${process.arch}.tar.gz`;
 packArchive(stage,join(out,name));
 for (const name of installers) cpSync(join(repo, name === 'agent-distribution.mjs' ? `scripts/lib/${name}` : `scripts/${name}`),join(out,name));
 writeRelease(new Set([name, ...installers]));
 console.log(`Distribution staged at ${out}; no release published. Platform declaration is build-host only; run release checks before publishing.`);
} finally { rmSync(temp,{recursive:true,force:true}); }
