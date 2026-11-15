#!/usr/bin/env node
// Standalone bootstrap: builtins only. Downloaded code is trusted ONLY through the private gh channel.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
export const schema = 1;
export const nodeMin = '22.19.0';
export const hash = data => createHash('sha256').update(data).digest('hex');
const fail = message => { throw new Error(`Distribution: ${message}`); };
export function requireNode() {
 const [major, minor] = process.versions.node.split('.').map(Number);
 if (major < 22 || (major === 22 && minor < 19)) fail(`Node >= ${nodeMin} required`);
}
function safePath(name) {
 if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..') || /^[A-Za-z]:/.test(name)) fail(`unsafe archive path: ${name}`);
 return name;
}
function checkEntries(entries) {
 const names = new Set();
 for (const e of entries) {
  safePath(e.path);
  if (names.has(e.path)) fail(`duplicate path: ${e.path}`);
  names.add(e.path);
  if (!['file', 'link'].includes(e.type)) fail('unsupported archive entry');
  if (e.type === 'link') {
   if (!e.target || e.target.startsWith('/') || e.target.includes('\\') || /^[A-Za-z]:/.test(e.target)) fail('unsafe symlink');
   safePath(posix.normalize(posix.join(posix.dirname(e.path), e.target)));
  }
 }
 const links = new Set(entries.filter(e => e.type === 'link').map(e => e.path));
 for (const e of entries) {
  for (let parent = posix.dirname(e.path); parent !== '.'; parent = posix.dirname(parent)) if (links.has(parent)) fail('archive entry beneath symlink');
  if (e.type === 'link') {
   let target = posix.normalize(posix.join(posix.dirname(e.path), e.target));
   // Reject chains, directories and dangling links; final target must be a regular packaged file.
   if (!entries.some(other => other.path === target && other.type === 'file')) fail(`symlink target is not a packaged regular file: ${e.path}`);
  }
 }
}
export function inventory(root) {
 const entries = [];
 function walk(relative) {
  for (const name of readdirSync(join(root, relative)).sort()) {
   const path = relative ? `${relative}/${name}` : name;
   if (path === 'artifact.json') continue;
   const full = join(root, path), st = lstatSync(full);
   if (st.isDirectory()) walk(path);
   else if (st.isSymbolicLink()) entries.push({ path, type: 'link', target: readlinkSync(full) });
   else if (st.isFile()) entries.push({ path, type: 'file', mode: st.mode & 0o111 ? 0o755 : 0o644, sha256: hash(readFileSync(full)) });
   else fail(`unsupported file: ${path}`);
  }
 }
 walk(''); checkEntries(entries); return entries;
}
export function validateDirectory(root) {
 requireNode();
 if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink() || !lstatSync(join(root, "artifact.json")).isFile() || lstatSync(join(root, "artifact.json")).isSymbolicLink()) fail("artifact root/manifest must be real directory/regular file");
 const m = JSON.parse(readFileSync(join(root, 'artifact.json'), 'utf8'));
 if (m.schema !== schema || m.runtimeContract !== 3 || m.profileDefault !== '~/.agent' || m.node?.kind !== 'external' || m.node.min !== nodeMin) fail('unsupported artifact contract');
 if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(m.releaseId) || m.releaseId.includes('..')) fail('invalid release ID');
 if (!/^[a-f0-9]{40,64}$/.test(m.sourceCommit)) fail('invalid source commit');
 if (!Array.isArray(m.platforms) || !m.platforms.some(p => p.os === process.platform && p.arch === process.arch)) fail('artifact platform/architecture mismatch');
 const actual = inventory(root);
 if (JSON.stringify(actual) !== JSON.stringify(m.files) || hash(JSON.stringify(actual)) !== m.contentDigest) fail('artifact content digest mismatch');
 for (const e of actual) if (!e.path.startsWith('release/') && !e.path.startsWith('bundle/')) fail(`unexpected payload path ${e.path}`);
 if (hash(readFileSync(join(root, 'bundle/overlay/manifest.json'))) !== m.manifestSha256) fail('bundle manifest mismatch');
 return m;
}
function field(header, offset, width, value) {
 const b = Buffer.from(value); if (b.length > width) fail(`tar field too long: ${value}`); b.copy(header, offset);
}
export function packArchive(root, output) {
 const entries = [...inventory(root), { path: 'artifact.json', type: 'file', mode: 0o644 }].sort((a,b) => a.path < b.path ? -1 : 1);
 const chunks = [];
 for (const e of entries) {
  const h = Buffer.alloc(512); let name = e.path, prefix = '';
  if (Buffer.byteLength(name) > 100) {
   const splits = [...name.matchAll(/\//g)].map(m => m.index).filter(i => Buffer.byteLength(name.slice(0,i)) <= 155 && Buffer.byteLength(name.slice(i+1)) <= 100);
   if (!splits.length) fail(`path too long for ustar: ${name}`);
   const split = splits.at(-1); prefix = name.slice(0,split); name = name.slice(split+1);
  }
  const body = e.type === 'file' ? readFileSync(join(root,e.path)) : Buffer.alloc(0);
  field(h,0,100,name); field(h,100,8,`${(e.mode ?? 0o777).toString(8).padStart(7,'0')}\0`);
  field(h,108,8,'0000000\0'); field(h,116,8,'0000000\0'); field(h,124,12,`${body.length.toString(8).padStart(11,'0')}\0`); field(h,136,12,'00000000000\0');
  h.fill(32,148,156); h[156] = e.type === 'link' ? 50 : 48;
  if (e.target) field(h,157,100,e.target);
  field(h,257,6,'ustar\0'); field(h,263,2,'00'); field(h,345,155,prefix);
  field(h,148,8,`${h.reduce((a,b)=>a+b,0).toString(8).padStart(6,'0')}\0 `);
  chunks.push(h,body,Buffer.alloc((512 - body.length % 512) % 512));
 }
 chunks.push(Buffer.alloc(1024)); writeFileSync(output,gzipSync(Buffer.concat(chunks),{ level: 9 }));
}
export function extractArchive(archive, destination) {
 // Parse every header and validate all paths/links BEFORE writing any payload bytes.
 const bytes = gunzipSync(readFileSync(archive), { maxOutputLength: 2 * 1024 ** 3 });
 const entries = []; let offset = 0;
 const text = (h,a,n) => h.subarray(a,a+n).toString('utf8').replace(/\0.*$/s,'');
 const octal = value => { if (!/^[0-7]+$/.test(value.trim())) fail('invalid tar number'); return parseInt(value.trim(),8); };
 while (offset + 512 <= bytes.length) {
  const h = bytes.subarray(offset,offset+512); offset += 512;
  if (h.every(b=>b===0)) { if (!bytes.subarray(offset).every(b=>b===0)) fail('trailing archive payload'); break; }
  const checksum = octal(text(h,148,8)); const copy = Buffer.from(h); copy.fill(32,148,156);
  if (copy.reduce((a,b)=>a+b,0) !== checksum || text(h,257,6) !== 'ustar') fail('invalid ustar header');
  const prefix = text(h,345,155), name = text(h,0,100), size = octal(text(h,124,12));
  const type = h[156] === 50 ? 'link' : h[156] === 48 ? 'file' : fail('unsupported tar type (only regular files and confined symlinks accepted)');
  if (offset + size > bytes.length || (type === 'link' && size !== 0)) fail('truncated archive');
  entries.push({ path: prefix ? `${prefix}/${name}` : name, type, target: type === 'link' ? text(h,157,100) : undefined, body: bytes.subarray(offset,offset+size), mode: octal(text(h,100,8)) & 0o111 ? 0o755 : 0o644 });
  offset += Math.ceil(size/512)*512;
 }
 if (!entries.length || offset > bytes.length) fail('empty/truncated archive');
 checkEntries(entries);
 if (existsSync(destination)) fail('extraction destination must not exist');
 mkdirSync(destination,{recursive:true});
 for (const e of entries.filter(e=>e.type==='file')) { const p=join(destination,e.path); mkdirSync(dirname(p),{recursive:true}); writeFileSync(p,e.body,{mode:e.mode,flag:'wx'}); }
 for (const e of entries.filter(e=>e.type==='link')) { const p=join(destination,e.path); mkdirSync(dirname(p),{recursive:true}); symlinkSync(e.target,p); }
 return validateDirectory(destination);
}
export function verifyArchiveHash(archive) {
 const sums = readFileSync(join(dirname(archive),'SHA256SUMS'),'utf8').split(/\r?\n/);
 const matches = sums.map(line=>/^([a-f0-9]{64})  ([A-Za-z0-9._+-]+)$/.exec(line)).filter(m=>m?.[2]===basename(archive));
 if (matches.length !== 1 || hash(readFileSync(archive)) !== matches[0][1]) fail('archive SHA256SUMS mismatch');
}
export function downloadArtifact(destination, tag = '') {
 requireNode();
 const repo = process.env.AGENT_RELEASE_REPO || 'GabrielMendonca1/agent';
 if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || (tag && !/^[\w.+-]+$/.test(tag))) fail('invalid private repository or release tag');
 const asset = `agent-*-${process.platform}-${process.arch}.tar.gz`;
 const args = ['release','download',...(tag ? [tag] : []),'-R',repo,'-p',asset,'-p','SHA256SUMS','-D',destination];
 const result=spawnSync('gh',args,{stdio:'inherit',env:{...process.env,GH_HOST:'github.com'}});
 if (result.error || result.status !== 0) fail('authenticated private release download failed (gh access required)');
 const archives = readdirSync(destination).filter(n=>n.endsWith(`-${process.platform}-${process.arch}.tar.gz`));
 if (archives.length !== 1) fail('expected exactly one platform artifact');
 return join(destination,archives[0]);
}
export function bootstrap(archive, args = []) {
 requireNode(); verifyArchiveHash(archive);
 const temporary=mkdtempSync(join(tmpdir(),'agent-bootstrap-'));
 try {
  const root=join(temporary,'payload'); extractArchive(archive,root);
  const result=spawnSync(process.execPath,[join(root,'bundle/scripts/agent-update.mjs'),'--install-artifact',root,...args],{stdio:'inherit'});
  if (result.error) throw result.error;
  return result.status ?? 1;
 } finally { rmSync(temporary,{recursive:true,force:true}); }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
 try { process.exitCode=bootstrap(resolve(process.argv[2] ?? ''),process.argv.slice(3)); }
 catch(error) { console.error(error.message); process.exitCode=1; }
}
