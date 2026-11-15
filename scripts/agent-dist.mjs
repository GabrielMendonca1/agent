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
let release, out = resolve('dist');
for (let i=0;i<args.length;i++) {
 if (args[i]==='--release') release=realpathSync(resolve(args[++i]));
 else if (args[i]==='--out') out=resolve(args[++i]);
 else throw new Error(`Unknown distribution option: ${args[i]}`);
}
requireNode();
const temp=mkdtempSync(join(tmpdir(),'agent-dist-'));
try {
 const home=join(temp,'home'), store=join(temp,'store'); mkdirSync(home);
 const env={...process.env,HOME:home,USERPROFILE:home,PI_CODING_AGENT_DIR:join(home,'.agent'),AGENT_STORE:store,AGENT_DIST:'1',AGENT_WARM_START:'0'};
 // No inherited authentication/profile state is copied. --prepare never launches inference.
 for (const key of Object.keys(env)) if (/TOKEN|SECRET|API_KEY|AUTH|NODE_OPTIONS|AGENT_JUICE/.test(key)) delete env[key];
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
 cpSync(join(repo,'scripts/install.sh'),join(out,'install.sh'));
 cpSync(join(repo,'scripts/lib/agent-distribution.mjs'),join(out,'agent-distribution.mjs'));
 const sums=[name,'install.sh','agent-distribution.mjs'].map(n=>`${hash(readFileSync(join(out,n)))}  ${n}`).join('\n');
 writeFileSync(join(out,'SHA256SUMS'),`${sums}\n`);
 console.log(`Distribution staged at ${out}; no release published. Platform declaration is build-host only; run release checks before publishing.`);
} finally { rmSync(temp,{recursive:true,force:true}); }
