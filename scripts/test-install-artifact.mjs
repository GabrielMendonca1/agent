#!/usr/bin/env node
import './lib/hermetic-test-env.mjs';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { hash, packArchive, extractArchive, inventory, validateDirectory } from './lib/agent-distribution.mjs';
const root=realpathSync(mkdtempSync(join(tmpdir(),'agent-dist-test-'))), repo=resolve(new URL('..',import.meta.url).pathname);
const json=(p,v)=>{mkdirSync(dirname(p),{recursive:true});writeFileSync(p,`${JSON.stringify(v,null,2)}\n`);};
const load=p=>JSON.parse(readFileSync(p,'utf8'));
let checks=0;
const test=(name,fn)=>{fn();checks++;console.log(`ok ${name}`);};
try {
 const source=join(root,'source');mkdirSync(source);
 cpSync(join(repo,'scripts'),join(source,'scripts'),{recursive:true});
 const runtimeFile=join(source,'scripts/lib/agent-runtime.mjs');
 writeFileSync(runtimeFile,readFileSync(runtimeFile,'utf8').replace('const normalized = validateConfig(config, path);', 'if (process.env.FIXTURE_FAIL_CONFIG === "1") throw Error("fixture config failure"); const normalized = validateConfig(config, path);'));

 mkdirSync(join(source,'overlay'));writeFileSync(join(source,'overlay/base.patch'),'fixture patch');writeFileSync(join(source,'overlay/README.md'),'fixture');
 const patch={name:'base',path:'overlay/base.patch',sha256:hash(Buffer.from('fixture patch')),tests:['fixture.test.ts']};
 const manifest={name:'agent',officialPackage:'fixture-pi',officialRepository:'https://example.invalid/pi',overlayRef:'v1.0.0',overlayBase:'a'.repeat(40),patches:[patch],compatibility:{forbiddenOverlayMarkers:[],upstreamLayouts:[{name:'classic',binPi:'dist/cli.js'}],bundleMarkers:[{name:'base',path:'dist/cli.js',marker:'BASE',patch:'base'}]}};
 json(join(source,'overlay/manifest.json'),manifest);
 mkdirSync(join(source,'agent/core'),{recursive:true});writeFileSync(join(source,'agent/core/runtime.mjs'),'// no-op fixture preload\n');
 mkdirSync(join(source,'agent/extensions/agent/demo'),{recursive:true});writeFileSync(join(source,'agent/extensions/agent/demo/index.ts'),'// fixture extension\n');
 mkdirSync(join(source,'extensions/megamind'),{recursive:true});writeFileSync(join(source,'extensions/megamind/index.ts'),'// fixture Megamind\n');
 mkdirSync(join(source,'skills/megamind'),{recursive:true});writeFileSync(join(source,'skills/megamind/SKILL.md'),'---\nname: megamind\ndescription: fixture\n---\nfixture');
 const env={...process.env,HOME:join(root,'home'),USERPROFILE:join(root,'home'),PI_CODING_AGENT_DIR:join(root,'home/.agent'),AGENT_STORE:join(root,'store'),AGENT_WARM_START:'0'};mkdirSync(env.HOME);
 const run=(command,args,ok=true,extra={})=>{
  const r=spawnSync(command,args,{env:{...env,...extra},encoding:'utf8',cwd:source});
  assert.equal(r.status===0,ok,r.stdout+r.stderr);return r;
 };
 for(const args of [['init','-q'],['-c','user.name=fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-qm','fixture']]) run('git',args);
 const api=await import(pathToFileURL(join(source,'scripts/agent-update.mjs')));
 function release(id) {
  const dir=join(root,id),pkg=join(dir,'lib/node_modules/fixture-pi');mkdirSync(join(pkg,'dist/core'),{recursive:true});mkdirSync(join(dir,'bin'));
  json(join(pkg,'package.json'),{name:'fixture-pi',version:'1.0.0',bin:{pi:'dist/cli.js'}});
  writeFileSync(join(pkg,'dist/core/model-runtime.js'),'export class ModelRuntime {}');
  writeFileSync(join(pkg,'dist/cli.js'),`#!/usr/bin/env node\n// BASE ${id}\nif(process.argv.includes('--version'))console.log('1.0.0');else {console.log(JSON.stringify({type:'fixture',args:process.argv.slice(2),runtime:process.env.AGENT_RUNTIME_ENABLED,piRoot:process.env.AGENT_PI_ROOT,legacyHome:process.env.AGENT_JUICE_HOME}));process.exit(Number(process.env.FIXTURE_EXIT||0));}\n`,{mode:0o755});
  symlinkSync('../lib/node_modules/fixture-pi/dist/cli.js',join(dir,'bin/pi'));
  const fp=hash(Buffer.concat([readFileSync(join(source,'overlay/manifest.json')),readFileSync(join(source,patch.path))]));
  json(join(dir,'agent-release.json'),{officialRef:'v1.0.0',officialCommit:'a'.repeat(40),officialVersion:'1.0.0',overlayFingerprint:fp,patches:{base:patch.sha256},optionalLayers:[],digestAlgorithm:3,treeDigest:api.digestTree(dir)});
  return dir;
 }
 const dist=join(source,'scripts/agent-dist.mjs'), updater=join(source,'scripts/agent-update.mjs');
 const a=release('release-a'),b=release('release-b'),outA=join(root,'dist-a'),outB=join(root,'dist-b');
 run(process.execPath,[dist,'--release',a,'--out',outA]);run(process.execPath,[dist,'--release',b,'--out',outB]);
 const archive=dir=>join(dir,readdirSync(dir).find(n=>n.endsWith('.tar.gz')));
 test('merge host artifacts with verified checksums and both installers',()=>{
  const merged=join(root,'merged');
  run(process.execPath,[dist,'--merge',outA,outB,'--out',merged]);
  assert.equal(readdirSync(merged).filter(n=>n.endsWith('.tar.gz')).length,2);
  assert.ok(readFileSync(join(merged,'SHA256SUMS'),'utf8').includes('  install.ps1'));
  assert.equal(hash(readFileSync(archive(outA))),hash(readFileSync(join(merged,archive(outA).split('/').at(-1)))));
  writeFileSync(join(merged,'install.ps1'),'corrupt');
  run(process.execPath,[dist,'--merge',merged,'--out',join(root,'bad-merge')],false);
 });
 test('pack is deterministic and metadata portable',()=>{
  const again=join(root,'again');run(process.execPath,[dist,'--release',a,'--out',again]);
  assert.equal(hash(readFileSync(archive(outA))),hash(readFileSync(archive(again))));
  // Agent-only updates must reserve another physical pair, even when Pi bytes are unchanged.
  const changed=join(root,'core-only');writeFileSync(join(source,'extensions/megamind/index.ts'),'// changed standard integration');
  run(process.execPath,[dist,'--release',a,'--out',changed]);
  const changedRoot=join(root,'changed-payload');extractArchive(archive(changed),changedRoot);
  const originalRoot=join(root,'original-payload');extractArchive(archive(outA),originalRoot);
  assert.notEqual(load(join(changedRoot,'artifact.json')).releaseId,load(join(originalRoot,'artifact.json')).releaseId);

  const payload=join(root,'inspect');extractArchive(archive(outA),payload);const m=validateDirectory(payload);
  assert.equal(m.runtimeContract,3);assert.ok(!JSON.stringify(m).includes(root));assert.ok(!readFileSync(join(payload,'release/agent-release.json'),'utf8').includes('sourceRepo'));
 });
 const launcher=join(env.HOME,'.local/bin/agent'),store=env.AGENT_STORE,config=()=>load(join(store,'runtime/config.json'));
 const current=()=>realpathSync(join(store,'current'));
 test('bootstrap install A, first CLI, own profile, registered Megamind and core skills',()=>{
  const personal=join(env.PI_CODING_AGENT_DIR,'extensions/arca-megamind/index.ts');mkdirSync(dirname(personal),{recursive:true});writeFileSync(personal,'// personal alias sentinel');
  json(join(env.PI_CODING_AGENT_DIR,'settings.json'),{extensions:[dirname(personal)],defaultModel:'personal-model'});
  run('bash',[join(repo,'scripts/install.sh'),'--adopt-launcher'],true,{AGENT_RELEASE_DIR:outA});
  assert.match(current(),/release-a-[0-9a-f]{10}$/);assert.ok(existsSync(launcher));
  assert.equal(load(join(store,'active.json')).release,undefined);
  assert.match(run(launcher,['overlay-status']).stdout,/Release: unknown/);
  assert.equal(config().version,2);assert.equal(config().juiceHome,undefined);
  const settings=load(join(env.PI_CODING_AGENT_DIR,'settings.json'));
  assert.ok(settings.extensions.some(p=>p.endsWith('/extensions/standard/megamind')));
  assert.equal(settings.defaultModel,'personal-model');assert.equal(readFileSync(personal,'utf8'),'// personal alias sentinel');
  assert.ok(settings.extensions.includes('-'+personal));
  assert.ok(settings.extensions.some(p=>p.endsWith('/extensions/agent/demo')));
  assert.ok(settings.skills.some(p=>p.endsWith('/agent/skills')));
  assert.deepEqual(settings.warnings,{anthropicExtraUsage:false});assert.equal(existsSync(join(env.PI_CODING_AGENT_DIR,'keybindings.json')),false);
  assert.ok(!existsSync(join(env.HOME,'.pi')));assert.ok(!existsSync(join(env.HOME,'.agent-juice')));
  assert.ok(!existsSync(join(env.HOME,'.bashrc')));assert.ok(!existsSync(join(env.HOME,'.zshrc')));
  const r=run(launcher,['--mode','json','-p','hello']);const observed=JSON.parse(r.stdout);
  assert.equal(observed.runtime,'1');assert.equal(observed.legacyHome,undefined);assert.deepEqual(observed.args,['--mode','json','-p','hello']);
  assert.equal(run(launcher,['-p','error'],false,{FIXTURE_EXIT:'7'}).status,7);
 });
 test('update B, idempotence, rollback A keeps resources/config paired',()=>{
  run(process.execPath,[updater,'--install-artifact',archive(outB)]);
  assert.equal(load(join(store,'active.json')).release,undefined);
  const previous=realpathSync(join(store,'previous'));assert.ok(previous.includes('/release-a-'));
  run(process.execPath,[updater,'--install-artifact',archive(outB)]);assert.equal(realpathSync(join(store,'previous')),previous);
  run(launcher,['overlay-rollback']);assert.ok(current().includes('/release-a-'));assert.ok(config().piRoot.startsWith(current()));
  assert.equal(load(join(store,'active.json')).release,undefined);
  const registrations=load(join(env.PI_CODING_AGENT_DIR,'settings.json')).extensions.filter(p=>!p.startsWith('-'));
  assert.ok(registrations.filter(p=>p.includes('/runtime/releases/')).every(p=>p.includes(config().artifactId)));
 });
 const snapshot=()=>[current(),readFileSync(join(store,'runtime/config.json'),'utf8'),readFileSync(join(env.PI_CODING_AGENT_DIR,'settings.json'),'utf8'),readFileSync(config().resourceReceipt,'utf8'),readFileSync(join(store,'active.json'),'utf8')];
 test('bad archive hash fails without changing pair/settings/receipt',()=>{
  const before=snapshot(),bad=join(root,'bad-hash');mkdirSync(bad);cpSync(archive(outB),join(bad,'bad.tar.gz'));writeFileSync(join(bad,'SHA256SUMS'),`${'0'.repeat(64)}  bad.tar.gz\n`);
  run(process.execPath,[updater,'--install-artifact',join(bad,'bad.tar.gz')],false);assert.deepEqual(snapshot(),before);
 });
 function altered(name,mutate) {
  const dir=join(root,name),payload=join(dir,'payload');mkdirSync(dir);extractArchive(archive(outB),payload);mutate(payload);
  const m=load(join(payload,'artifact.json'));m.files=inventory(payload);m.contentDigest=hash(JSON.stringify(m.files));json(join(payload,'artifact.json'),m);
  const tar=join(dir,`${name}.tar.gz`);packArchive(payload,tar);writeFileSync(join(dir,'SHA256SUMS'),`${hash(readFileSync(tar))}  ${name}.tar.gz\n`);return tar;
 }
 test('wrong platform and content fail before executing payload',()=>{
  const before=snapshot();const wrong=altered('wrong-platform',p=>{const m=load(join(p,'artifact.json'));m.platforms=[{os:'wrong',arch:process.arch}];json(join(p,'artifact.json'),m);});
  run(process.execPath,[updater,'--install-artifact',wrong],false);assert.deepEqual(snapshot(),before);
  const corrupt=join(root,'inspect/bundle/scripts/agent-update.mjs');writeFileSync(corrupt,'throw Error("must not run")');
  assert.throws(()=>validateDirectory(join(root,'inspect')),/content digest/);
 });
 test('unsafe tar traversal and escaping links rejected before extraction',()=>{
  const original=gunzipSync(readFileSync(archive(outB)));
  for (const link of [false,true]) {
   let bytes=Buffer.from(original);const h=bytes.subarray(0,512),originalSize=parseInt(h.subarray(124,136).toString().replace(/\0.*$/s,''),8);h.fill(0,0,100);Buffer.from(link?'escape':'../escape').copy(h);
   if(link){h[156]=50;h.fill(0,157,257);Buffer.from('../../escape').copy(h,157);h.fill(0,124,136);Buffer.from('00000000000\0').copy(h,124);}
   h.fill(32,148,156);Buffer.from(`${h.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')}\0 `).copy(h,148);
   if(link) bytes=Buffer.concat([h,bytes.subarray(512+Math.ceil(originalSize/512)*512)]);
   const tar=join(root,`unsafe-${link}.tar.gz`);writeFileSync(tar,gzipSync(bytes));const dest=join(root,`unsafe-${link}`);
   assert.throws(()=>extractArchive(tar,dest),/unsafe archive path|unsafe symlink/);assert.equal(existsSync(dest),false);
  }
 });
 test('activation failure restores prior pointers/config/settings/receipt/metadata',()=>{
  const before=snapshot();
  const wrapper=join(store,'bin/pi-wrapper'),saved=readFileSync(wrapper);rmSync(wrapper);mkdirSync(wrapper);
  try {run(process.execPath,[updater,'--install-artifact',archive(outB)],false);assert.deepEqual(snapshot(),before);}
  finally {rmSync(wrapper,{recursive:true});writeFileSync(wrapper,saved,{mode:0o755});}
 });

 test('failure after resource switch restores the exact old receipt and registrations',()=>{
  const before=snapshot();
  run(process.execPath,[updater,'--install-artifact',archive(outB)],false,{FIXTURE_FAIL_CONFIG:'1'});
  assert.deepEqual(snapshot(),before);
 });
 test('failed adoption restores a regular launcher without following the new symlink',()=>{
  const before=snapshot(),wrapper=join(store,'bin/pi-wrapper'),wrapperBefore=readFileSync(wrapper);
  const link=readlinkSync(launcher),body='#!/bin/sh\necho personal launcher\n';
  rmSync(launcher);writeFileSync(launcher,body,{mode:0o751});chmodSync(launcher,0o751);
  try {
   run(process.execPath,[updater,'--install-artifact',archive(outB),'--adopt-launcher'],false,{FIXTURE_FAIL_CONFIG:'1'});
   assert.ok(lstatSync(launcher).isFile());assert.equal(lstatSync(launcher).mode & 0o777,0o751);
   assert.equal(readFileSync(launcher,'utf8'),body);assert.deepEqual(readFileSync(wrapper),wrapperBefore);
   assert.deepEqual(snapshot(),before);
  } finally {rmSync(launcher,{force:true});symlinkSync(link,launcher);}
 });
 test('release install, update, rollback and explicit tag retain stable identity',()=>{
  const bin=join(root,'fake-bin');mkdirSync(bin);
  writeFileSync(join(bin,'gh'),`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);
if(args[0]==='auth'&&args[1]==='status')process.exit(0);
if(args[0]!=='release'||!args.includes('GabrielMendonca1/agent'))process.exit(8);
if(args[1]==='view'){console.log(process.env.FIXTURE_TAG);process.exit(0);}
if(args[1]!=='download'||!args.includes(process.env.FIXTURE_TAG))process.exit(9);
const dest=args[args.indexOf('-D')+1];for(const name of fs.readdirSync(process.env.FIXTURE_DIST))fs.copyFileSync(path.join(process.env.FIXTURE_DIST,name),path.join(dest,name));
`,{mode:0o755});
  const remote=(dir,tag)=>({PATH:`${bin}:${env.PATH}`,FIXTURE_DIST:dir,FIXTURE_TAG:tag,AGENT_RELEASE_DIR:'',AGENT_VERSION:''});
  const idA={tag:'v-agent-a',assetId:load(join(root,'original-payload/artifact.json')).releaseId,repo:'GabrielMendonca1/agent'};
  const payloadB=join(root,'identity-b');extractArchive(archive(outB),payloadB);
  const idB={tag:'v-agent-b',assetId:load(join(payloadB,'artifact.json')).releaseId,repo:'GabrielMendonca1/agent'};
  const active=()=>load(join(store,'active.json')).release;
  const status=id=>assert.ok(run(launcher,['overlay-status']).stdout.includes(`Release: ${id.tag} (assetId ${id.assetId}, repo ${id.repo})`));
  run('bash',[join(repo,'scripts/install.sh')],true,remote(outA,idA.tag));assert.deepEqual(active(),idA);status(idA);
  run(launcher,['update'],true,remote(outB,idB.tag));assert.ok(current().includes('/release-b-'));assert.deepEqual(active(),idB);status(idB);
  run(launcher,['overlay-rollback']);assert.deepEqual(active(),idA);status(idA);
  run(launcher,['overlay-rollback']);assert.deepEqual(active(),idB);
  run(launcher,['overlay-rollback']);assert.deepEqual(active(),idA);
  const before=snapshot(),identities=readFileSync(join(store,'release-identities.json'),'utf8');
  run(launcher,['update'],false,{...remote(outB,'v-failed'),FIXTURE_FAIL_CONFIG:'1'});
  assert.deepEqual(snapshot(),before);assert.equal(readFileSync(join(store,'release-identities.json'),'utf8'),identities);
  run(process.execPath,[updater,'--install-artifact',idB.tag],true,remote(outB,idB.tag));assert.deepEqual(active(),idB);
  run(process.execPath,[updater,'--install-artifact','latest'],true,{...remote(outA,idA.tag),AGENT_VERSION:idA.tag});assert.deepEqual(active(),idA);
  run('bash',[join(repo,'scripts/install.sh')],true,{...remote(outB,idB.tag),AGENT_VERSION:idB.tag});assert.deepEqual(active(),idB);
 });
 test('explicit runtime opt-out survives artifact updates without legacy profile sync',()=>{
  run(launcher,['overlay-update','--agent-disable']);
  assert.equal(load(join(env.PI_CODING_AGENT_DIR,'settings.json')).warnings,undefined);
  const before=readFileSync(join(env.PI_CODING_AGENT_DIR,'settings.json'),'utf8');
  run(process.execPath,[updater,'--install-artifact',archive(outA),'--adopt-launcher']);
  assert.equal(load(join(store,'active.json')).release,undefined);
  assert.equal(config().enabled,false);assert.equal(readFileSync(join(env.PI_CODING_AGENT_DIR,'settings.json'),'utf8'),before);
  assert.equal(existsSync(join(env.HOME,'.bashrc')),false);assert.equal(existsSync(join(env.HOME,'.zshrc')),false);
 });
 console.log(`install-artifact: ${checks} fixture checks OK; no provider inference or remote access`);
} finally {rmSync(root,{recursive:true,force:true});}
