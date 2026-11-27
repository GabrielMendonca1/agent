#!/usr/bin/env node
// Standalone bootstrap: builtins only. Remote artifacts require an Ed25519 signature.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
export const schema = 1;
export const nodeMin = '22.19.0';
// Provision the official SPKI PEM before publication. Empty means remote access fails closed.
export const RELEASE_PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAkf7hdXHDQjp/yNrogWdAYo+4hPkV8WCXWCg4LuDl1J0=\n-----END PUBLIC KEY-----\n';
export const defaultReleaseRepo = 'GabrielMendonca1/agent';
export const validReleaseTag = value => typeof value === 'string' && /^[\w.+-]{1,200}$/.test(value) && value !== '.' && value !== '..';
export const validReleaseRepo = value => typeof value === 'string' && /^[\w.-]+\/[\w.-]+$/.test(value) && value.split('/').every(part => part !== '.' && part !== '..');
export const validAssetId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(value) && !value.includes('..');
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
 if (!validAssetId(m.releaseId)) fail('invalid release ID');
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
// Directory links need absolute junction targets on unprivileged Windows.
// Schema 1 archives currently allow only links to regular packaged files.
export function createArtifactLink(target, path, { platform = process.platform, directory = statSync(resolve(dirname(path), target)).isDirectory(), createSymlink = symlinkSync } = {}) {
 const absolute = resolve(dirname(path), target);
 createSymlink(platform === 'win32' && directory ? absolute : target, path, platform === 'win32' ? (directory ? 'junction' : 'file') : undefined);
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
 for (const e of entries.filter(e=>e.type==='link')) { const p=join(destination,e.path); mkdirSync(dirname(p),{recursive:true}); createArtifactLink(e.target,p); }
 return validateDirectory(destination);
}
function ed25519Key(pem, isPrivate = false) {
 if (!pem) fail(`no Ed25519 release ${isPrivate ? 'private' : 'public'} key configured`);
 let key;
 try { key = (isPrivate ? createPrivateKey : createPublicKey)(pem); }
 catch { fail(`invalid Ed25519 ${isPrivate ? 'private' : 'public'} key`); }
 if (key.asymmetricKeyType !== 'ed25519') fail('release key must be Ed25519');
 return key;
}
// The detached signature is canonical base64 of the 64 raw signature bytes.
export function signManifest(sumsPath, privateKeyPem) {
 return sign(null, readFileSync(sumsPath), ed25519Key(privateKeyPem, true)).toString('base64');
}
export function verifyManifestSignature(sumsPath, sigPath, publicKeyPem) {
 const key = ed25519Key(publicKeyPem);
 const encoded = readFileSync(sigPath, 'utf8').trim();
 if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) fail('invalid manifest signature encoding');
 const signature = Buffer.from(encoded, 'base64');
 if (signature.toString('base64') !== encoded || !verify(null, readFileSync(sumsPath), key, signature)) fail('invalid manifest signature');
}
function verifyFileHash(file) {
 const sums = readFileSync(join(dirname(file),'SHA256SUMS'),'utf8').split(/\r?\n/);
 const matches = sums.map(line=>/^([a-f0-9]{64})  ([A-Za-z0-9._+-]+)$/.exec(line)).filter(m=>m?.[2]===basename(file));
 if (matches.length !== 1 || hash(readFileSync(file)) !== matches[0][1]) fail(`${basename(file)} SHA256SUMS mismatch`);
}
export function verifyArchiveHash(archive) {
 verifyFileHash(archive);
}
function loopback(url) {
 return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
}
export function normalizeReleaseBaseUrl(value) {
 let url;
 try { url = new URL(value); }
 catch { fail('invalid release base URL'); }
 if (!/^https?:\/\//i.test(value) || /[?#\s\\]/.test(value) || url.username || url.password ||
     (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url)))) fail('invalid release base URL (HTTPS required except on loopback)');
 return url.href.replace(/\/+$/, '');
}
// Limit time to headers and gaps between chunks, not the total transfer time.
const downloadIdleMs = 60_000;
async function fetchReleaseFile(url, name, limit, { token, accept, output }) {
 const initial = new URL(url);
 for (let redirects = 0; ; redirects++) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), downloadIdleMs).unref();
  try {
   const headers = { 'User-Agent': 'agent-distribution' };
   if (accept) headers.Accept = accept;
   if (token) headers.Authorization = `Bearer ${token}`;
   let response;
   try { response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers }); }
   catch { fail(`cannot download ${name}`); }
   timer.refresh();
   if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    const location = response.headers.get('location');
    let next;
    try { if (location) next = new URL(location, url); } catch {}
    if (redirects >= 5 || !next || next.username || next.password ||
        (next.protocol !== 'https:' && !(initial.protocol === 'http:' && next.origin === initial.origin && new URL(url).protocol === 'http:'))) fail(`unsafe download redirect for ${name}`);
    if (next.origin !== new URL(url).origin) token = undefined;
    url = next.href;
    continue;
   }
   if (response.status !== 200 || !response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    fail(`download rejected for ${name} (HTTP ${response.status} or size limit)`);
   }
   let size = 0;
   const cap = new Transform({ transform(chunk, encoding, callback) {
    timer.refresh();
    size += chunk.length;
    if (size > limit) callback(new Error('response exceeds size limit'));
    else callback(null, chunk);
   } });
   const chunks = [];
   const sink = output ? createWriteStream(output, { flags: 'wx', mode: 0o600 }) : new Writable({
    write(chunk, encoding, callback) { chunks.push(chunk); callback(); },
   });
   try { await pipeline(Readable.fromWeb(response.body), cap, sink, { signal: controller.signal }); }
   catch { fail(`cannot download ${name} (interrupted or size limit exceeded)`); }
   return output ? undefined : Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
 }
}
async function githubRelease(repo, tag, token) {
 const api = `https://api.github.com/repos/${repo}/releases`;
 const metadataUrl = tag ? `${api}/tags/${encodeURIComponent(tag)}` : `${api}/latest`;
 const body = await fetchReleaseFile(metadataUrl, 'GitHub release metadata', 4 * 1024 ** 2, { token, accept: 'application/vnd.github+json' });
 let release;
 try { release = JSON.parse(body); } catch { fail('invalid GitHub release metadata'); }
 if (!validReleaseTag(release?.tag_name) || (tag && tag !== release.tag_name) || !Array.isArray(release.assets)) fail('invalid GitHub release metadata');
 return {
  tag: release.tag_name,
  async download(name, limit, output) {
   const matches = release.assets.filter(asset => asset?.name === name);
   const id = matches[0]?.id;
   if (matches.length !== 1 || !Number.isSafeInteger(id) || id < 1) fail(`missing or invalid GitHub asset: ${name}`);
   // Build the URL from the configured repo and numeric ID, never from metadata URLs.
   await fetchReleaseFile(`${api}/assets/${id}`, name, limit, { token, accept: 'application/octet-stream', output });
  },
 };
}
function readLatest(path, repo, tag) {
 let manifest;
 try { manifest = JSON.parse(readFileSync(path, 'utf8')); }
 catch { fail('invalid latest.json'); }
 if (manifest?.schema !== schema || manifest.repo !== repo || !validReleaseTag(manifest.tag) || (tag && tag !== manifest.tag)) fail('invalid latest.json release identity');
 return manifest;
}
export async function downloadArtifact(destination, tag = '') {
 requireNode();
 const repo = process.env.AGENT_RELEASE_REPO || defaultReleaseRepo;
 if (!validReleaseRepo(repo) || (tag !== '' && !validReleaseTag(tag))) fail('invalid repository or release tag');
 const baseUrl = process.env.AGENT_RELEASE_BASE_URL === undefined ? undefined : normalizeReleaseBaseUrl(process.env.AGENT_RELEASE_BASE_URL);
 const publicKey = process.env.AGENT_RELEASE_PUBLIC_KEY ?? RELEASE_PUBLIC_KEY_PEM;
 ed25519Key(publicKey); // Do not start network I/O without a configured trust root.
 // Ambient GitHub credentials are only for the fixed GitHub API origin.
 const token = process.env.AGENT_RELEASE_TOKEN || (!baseUrl ? process.env.GITHUB_TOKEN : undefined);
 const latest = join(destination, 'latest.json');
 const github = `https://github.com/${repo}/releases`;
 // Custom: <base>/latest.json and <base>/<tag>/<file>. GitHub without a token:
 // /releases/latest/download/latest.json and /releases/download/<tag>/<file>.
 // Publish byte-identical latest.json at discovery and at the tag. Its hash is in the signed sums.
 let fetchFile;
 if (!baseUrl && token) {
  const release = await githubRelease(repo, tag, token);
  tag = release.tag;
  fetchFile = (name, limit) => release.download(name, limit, join(destination, name));
  await fetchFile('latest.json', 64 * 1024);
 } else {
  const fileAt = (root, name, limit) => fetchReleaseFile(`${root}/${name}`, name, limit, { token, output: join(destination, name) });
  const releaseUrl = value => baseUrl ? `${baseUrl}/${encodeURIComponent(value)}` : `${github}/download/${encodeURIComponent(value)}`;
  if (!tag) {
   await fileAt(baseUrl ?? `${github}/latest/download`, 'latest.json', 64 * 1024);
   tag = readLatest(latest, repo).tag;
  } else {
   await fileAt(releaseUrl(tag), 'latest.json', 64 * 1024);
  }
  const root = releaseUrl(tag);
  fetchFile = (name, limit) => fileAt(root, name, limit);
 }
 await fetchFile('SHA256SUMS', 1024 * 1024);
 await fetchFile('SHA256SUMS.sig', 1024);
 verifyManifestSignature(join(destination, 'SHA256SUMS'), join(destination, 'SHA256SUMS.sig'), publicKey);
 // The signature authenticates identity and bytes, not freshness. Use an explicit tag to pin a release.
 verifyFileHash(latest);
 const platform = `${process.platform}-${process.arch}`;
 const asset = readLatest(latest, repo, tag).assets?.[platform];
 if (!validAssetId(asset?.assetId) || asset.file !== `agent-${asset.assetId}-${platform}.tar.gz`) fail('invalid or missing platform artifact in latest.json');
 await fetchFile(asset.file, 512 * 1024 ** 2);
 const archive = join(destination, asset.file);
 verifyArchiveHash(archive);
 return { archive, tag, repo, assetId: asset.assetId, ...(baseUrl ? { baseUrl } : {}) };
}
export function bootstrap(archive, args = [], expectedAssetId) {
 requireNode(); verifyArchiveHash(archive);
 const temporary=mkdtempSync(join(tmpdir(),'agent-bootstrap-'));
 try {
  const root=join(temporary,'payload');
  const artifact = extractArchive(archive,root);
  if (expectedAssetId !== undefined && artifact.releaseId !== expectedAssetId) fail('artifact release ID does not match latest.json');
  const result=spawnSync(process.execPath,[join(root,'bundle/scripts/agent-update.mjs'),'--install-artifact',root,...args],{stdio:'inherit'});
  if (result.error) throw result.error;
  return result.status ?? 1;
 } finally { rmSync(temporary,{recursive:true,force:true}); }
}
// Shared native installer. Legacy archive invocation remains supported for v0.1.0.
// The Phase 1 shell installer still assigns the offline return value to exitCode.
// Keep that branch synchronous; callers can await either branch.
export function install(args = []) {
 requireNode();
 let tag = process.env.AGENT_VERSION || '';
 const forwarded = [];
 for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tag') { tag = args[++i]; if (!tag) fail('--tag requires a value'); }
  else forwarded.push(args[i]);
 }
 process.env.PI_CODING_AGENT_DIR ||= join(process.env.USERPROFILE || homedir(), '.agent');
 if (process.env.AGENT_RELEASE_DIR) {
  const dir = resolve(process.env.AGENT_RELEASE_DIR);
  const archives = readdirSync(dir).filter(n => n.startsWith('agent-') && n.endsWith(`-${process.platform}-${process.arch}.tar.gz`));
  if (archives.length !== 1) fail('expected exactly one platform artifact');
  return bootstrap(join(dir, archives[0]), forwarded);
 }
 return installRemote(tag, forwarded);
}
async function installRemote(tag, args) {
 const temporary = mkdtempSync(join(tmpdir(), 'agent-install-'));
 try {
  const { archive, tag: resolvedTag, repo, assetId, baseUrl } = await downloadArtifact(temporary, tag);
  const identity = ['--release-tag', resolvedTag, '--release-repo', repo];
  if (baseUrl) identity.push('--release-base-url', baseUrl);
  return bootstrap(archive, [...args, ...identity], assetId);
 } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
 try { process.exitCode = process.argv[2] === 'install' ? await install(process.argv.slice(3)) : bootstrap(resolve(process.argv[2] ?? ''),process.argv.slice(3)); }
 catch(error) { console.error(error.message); process.exitCode=1; }
}
