#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digestTree, installOverlayBundle, requireVerified, assertContainedTree } from './agent-update.mjs';
import { hash, inventory, nodeMin, packArchive, requireNode, validateDirectory } from './lib/agent-distribution.mjs';
const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
let release, merge = [], out = resolve('dist');
for (let i=0;i<args.length;i++) {
 if (args[i]==='--merge') { while (args[i+1] && !args[i+1].startsWith('--')) merge.push(resolve(args[++i])); }
 else if (args[i]==='--release') release=realpathSync(resolve(args[++i]));
 else if (args[i]==='--out') out=resolve(args[++i]);
 else throw new Error(`Unknown distribution option: ${args[i]}`);
}
requireNode();
const installers = ['install.sh', 'install.ps1', 'agent-distribution.mjs'];
function writeSums() {
 const names = readdirSync(out).filter(n => /^agent-.*\.tar\.gz$/.test(n) || installers.includes(n)).sort();
 writeFileSync(join(out, 'SHA256SUMS'), names.map(n => `${hash(readFileSync(join(out,n)))}  ${n}\n`).join(''));
}
if (merge.length) {
 if (release) throw new Error('--merge cannot be combined with --release');
 mkdirSync(out, { recursive: true });
 for (const dir of merge) {
  const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8');
  for (const name of readdirSync(dir).filter(n => /^agent-.*\.tar\.gz$/.test(n) || installers.includes(n))) {
   const bytes = readFileSync(join(dir, name)), digest = hash(bytes);
   if (!sums.split(/\r?\n/).includes(`${digest}  ${name}`)) throw new Error(`Invalid input checksum: ${name}`);
   if (existsSync(join(out,name)) && hash(readFileSync(join(out,name))) !== digest) throw new Error(`Conflicting release asset: ${name}`);
   cpSync(join(dir,name),join(out,name));
  }
 }
 for (const name of installers) if (!existsSync(join(out,name))) throw new Error(`Missing release asset: ${name}`);
 writeSums();
 console.log(`Merged distribution at ${out}; no release published.`);
 process.exit(0);
}
// realpath: no macOS tmpdir() é /var/... (symlink de /private/var); sem isso o bin/pi da release preparada "escapa" da árvore.
const temp=realpathSync(mkdtempSync(join(process.env.AGENT_DIST_TMP || tmpdir(),process.platform === 'win32' ? 'ad-' : 'agent-dist-')));
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
 writeSums();
 console.log(`Distribution staged at ${out}; no release published. Platform declaration is build-host only; run release checks before publishing.`);
} finally { rmSync(temp,{recursive:true,force:true}); }
