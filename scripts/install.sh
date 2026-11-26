#!/usr/bin/env bash
set -euo pipefail
umask 077
fail() { echo "$*" >&2; exit 1; }

# The updater accepts --store; keep the runtime and artifact in the same store.
store=${AGENT_STORE:-$HOME/.local/share/agent}
argv=("$@")
for ((i=0; i<$#; i++)); do
  case "${argv[i]}" in
    --tag) i=$((i+1)); [ "$i" -lt "$#" ] || fail '--tag requires a value' ;;
    --store) i=$((i+1)); [ "$i" -lt "$#" ] || fail '--store requires a value'; store=${argv[i]:-.} ;;
  esac
done
case "$store" in /*) ;; *) store="$PWD/$store" ;; esac

# https://nodejs.org/dist/v24.22.3/SHASUMS256.txt; see lib/portable-node.mjs.
version=v24.22.3
node_root="$store/node"
node_bin="$node_root/$version/bin/node"
node_version='const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)'
# Do not let inherited preloads run during the trust bootstrap.
unset NODE_OPTIONS
if [ "${AGENT_PORTABLE_NODE:-}" != 1 ] && { [ -n "${AGENT_RELEASE_DIR:-}" ] || [ "${AGENT_USE_SYSTEM_NODE:-}" = 1 ]; } &&
    system_node=$(type -P node) && "$system_node" -e "$node_version"; then
  node_bin=$system_node
else
  if [ ! -f "$node_bin" ] || [ ! -x "$node_bin" ]; then
    if [ -n "${AGENT_RELEASE_DIR:-}" ] && [ "${AGENT_PORTABLE_NODE:-}" != 1 ]; then
      fail 'Offline installation needs Node >=22.19 or an existing portable Node (AGENT_PORTABLE_NODE=1 permits download)'
    fi
    case "$(uname -s)-$(uname -m)" in
      Darwin-arm64) suffix=darwin-arm64.tar.gz; sha=ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd ;;
      Darwin-x86_64) suffix=darwin-x64.tar.gz; sha=977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7 ;;
      Linux-aarch64|Linux-arm64) suffix=linux-arm64.tar.xz; sha=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c ;;
      Linux-x86_64) suffix=linux-x64.tar.xz; sha=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb ;;
      *) fail 'Unsupported portable Node platform' ;;
    esac
    base=${AGENT_NODE_BASE_URL:-https://nodejs.org/dist}
    while [[ "$base" == */ ]]; do base=${base%/}; done
    # No userinfo, query, fragment, escapes in authority, or curl URL globs.
    if ! [[ "$base" =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/[a-zA-Z0-9._+/%~-]*)?$ ]]; then fail 'Invalid Node base URL'; fi
    if [[ "$base" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]]; then
      if [ -n "${AGENT_NODE_SHA256:-}" ]; then sha=$AGENT_NODE_SHA256; fi
    elif [[ "$base" != https://* ]]; then
      fail 'Node base URL requires HTTPS except on loopback'
    fi
    [[ "$sha" =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid Node SHA-256'
    mkdir -p "$node_root"
    stage=$(mktemp -d "$node_root/.stage.XXXXXXXX")
    trap 'rm -rf -- "$stage"' EXIT
    archive="$stage/node-$version-$suffix"
    # A Node mirror serves the pinned archive directly; never send release credentials.
    status=$(curl -q --fail --silent --show-error --globoff --connect-timeout 20 --max-time 600 \
      --max-filesize 134217728 --output "$archive" --write-out '%{http_code}' "$base/$version/${archive##*/}")
    [ "$status" = 200 ] || fail 'Node archive download rejected'
    if command -v sha256sum >/dev/null; then actual=$(sha256sum < "$archive"); else actual=$(shasum -a 256 < "$archive"); fi
    [ "${actual%% *}" = "$sha" ] || fail 'Portable Node SHA-256 mismatch'
    mkdir "$stage/runtime"
    tar -xf "$archive" -C "$stage/runtime" --strip-components 1
    # rename(2) is atomic and never moves into an already installed directory.
    "$stage/runtime/bin/node" - "$stage/runtime" "$node_root/$version" <<'JS'
const fs = require('node:fs');
const [source, target] = process.argv.slice(2);
try { fs.renameSync(source, target); }
catch (error) {
  if (!['ENOTEMPTY', 'EEXIST'].includes(error.code) || !fs.statSync(`${target}/bin/node`).isFile()) throw error;
}
JS
    rm -rf -- "$stage"
    trap - EXIT
  fi
  # Same-directory rename replaces the old symlink atomically (including stale links).
  "$node_bin" - "$node_root" "$version" <<'JS'
const fs = require('node:fs'), path = require('node:path');
const [root, version] = process.argv.slice(2);
const stage = fs.mkdtempSync(path.join(root, '.link.'));
const link = path.join(stage, 'current');
try {
  fs.symlinkSync(version, link);
  fs.renameSync(link, path.join(root, 'current'));
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
JS
  export PATH="${node_bin%/*}:$PATH"
fi

tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
cat > "$tmp/bootstrap.cjs" <<'JS'
// Keep this embedded bootstrap identical in install.sh and install.ps1. It is
// local code: do not import anything from a release until after verification.
const { readFileSync, copyFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash, createPublicKey, verify } = require('node:crypto');
const { spawnSync } = require('node:child_process');

// Provision alongside RELEASE_PUBLIC_KEY_PEM in agent-distribution.mjs.
const RELEASE_PUBLIC_KEY_PEM = '';
const env = process.env;
const [root, ...args] = process.argv.slice(2);
const local = env.AGENT_RELEASE_DIR;
const moduleName = 'agent-distribution.mjs';
const modulePath = join(root, moduleName);
const sumsName = 'SHA256SUMS';
const sigName = 'SHA256SUMS.sig';
const latestName = 'latest.json';
const validTag = value => typeof value === 'string' && /^[\w.+-]{1,200}$/.test(value) && value !== '.' && value !== '..';
const loopback = url => ['localhost', '127.0.0.1'].includes(url.hostname);
const fail = message => { throw Error(message); };
const KiB = 1024;

function checkHash(sums, name, data) {
  const matches = sums.toString('utf8').split(/\r?\n/)
    .map(line => /^([a-f0-9]{64})  ([A-Za-z0-9._+-]+)$/.exec(line)).filter(m => m?.[2] === name);
  if (matches.length !== 1 || createHash('sha256').update(data).digest('hex') !== matches[0][1]) fail(`${name} SHA256SUMS mismatch`);
}

async function download(url, name, limit, token, accept) {
  const initial = new URL(url);
  for (let redirects = 0; ; redirects++) {
    const headers = { 'User-Agent': 'agent-installer' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (accept) headers.Accept = accept;
    try {
      const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        const next = location && new URL(location, url);
        if (!next || redirects >= 5 || next.username || next.password ||
            (next.protocol !== 'https:' && !(initial.protocol === 'http:' && next.origin === initial.origin && new URL(url).protocol === 'http:'))) fail('unsafe redirect');
        if (next.origin !== new URL(url).origin) token = undefined;
        url = next.href;
        continue;
      }
      if (response.status !== 200 || !response.body || Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        fail('download rejected');
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) fail('size limit exceeded');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    } catch {
      // Do not print request URLs, headers, response bodies or redirect locations.
      fail(`Cannot download ${name}`);
    }
  }
}

async function remote() {
  const pem = env.AGENT_RELEASE_PUBLIC_KEY ?? RELEASE_PUBLIC_KEY_PEM;
  if (!pem) fail('Release public key is not configured (AGENT_RELEASE_PUBLIC_KEY)');
  let key;
  try { key = createPublicKey(pem); } catch { fail('Invalid Ed25519 release public key'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('Release key must be Ed25519');
  env.AGENT_RELEASE_PUBLIC_KEY = pem; // Payload verification uses the same trust root.
  const repo = env.AGENT_RELEASE_REPO || 'GabrielMendonca1/agent';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split('/').some(p => p === '.' || p === '..')) fail('Invalid release repository');
  let tag = env.AGENT_VERSION || '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tag') {
      tag = args[++i];
      if (!tag) fail('--tag requires a value');
    }
  }
  if (tag && !validTag(tag)) fail('Invalid release tag');
  let base;
  if (env.AGENT_RELEASE_BASE_URL !== undefined) {
    const value = env.AGENT_RELEASE_BASE_URL;
    try { base = new URL(value); } catch { fail('Invalid release base URL'); }
    if (!/^https?:\/\//i.test(value) || /[?#\s\\]/.test(value) || base.username || base.password ||
        (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback(base)))) fail('Invalid release base URL (HTTPS required except on loopback)');
  }
  const token = env.AGENT_RELEASE_TOKEN || (!base ? env.GITHUB_TOKEN : undefined);
  const parseLatest = bytes => {
    const value = JSON.parse(bytes);
    if (value?.schema !== 1 || value.repo !== repo || !validTag(value.tag) || (tag && value.tag !== tag)) fail('Invalid latest.json release identity');
    return value.tag;
  };
  let file, latest;
  if (!base && token) {
    const api = `https://api.github.com/repos/${repo}/releases`;
    const metadata = JSON.parse(await download(tag ? `${api}/tags/${encodeURIComponent(tag)}` : `${api}/latest`, 'GitHub release metadata', 4096 * KiB, token, 'application/vnd.github+json'));
    if (!validTag(metadata?.tag_name) || (tag && metadata.tag_name !== tag) || !Array.isArray(metadata.assets)) fail('Invalid GitHub release metadata');
    tag = metadata.tag_name;
    file = (name, limit) => {
      const matches = metadata.assets.filter(asset => asset?.name === name);
      const id = matches[0]?.id;
      if (matches.length !== 1 || !Number.isSafeInteger(id) || id < 1) fail(`Missing or invalid GitHub asset: ${name}`);
      return download(`${api}/assets/${id}`, name, limit, token, 'application/octet-stream');
    };
    latest = await file(latestName, 64 * KiB);
  } else {
    const github = `https://github.com/${repo}/releases`;
    const mirror = base?.href.replace(/\/+$/, '');
    const releaseUrl = value => `${mirror || `${github}/download`}/${encodeURIComponent(value)}`;
    if (!tag) {
      latest = await download(`${mirror || `${github}/latest/download`}/${latestName}`, latestName, 64 * KiB, token);
      tag = parseLatest(latest); // Only a validated tag may be used to form a URL.
    }
    file = (name, limit) => download(`${releaseUrl(tag)}/${name}`, name, limit, token);
    latest ??= await file(latestName, 64 * KiB);
  }
  const sums = await file(sumsName, 1024 * KiB);
  const encoded = (await file(sigName, KiB)).toString('utf8').trim();
  const signature = Buffer.from(encoded, 'base64');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded) || signature.toString('base64') !== encoded || !verify(null, sums, key, signature)) fail('Invalid manifest signature');
  checkHash(sums, latestName, latest);
  parseLatest(latest);
  const module = await file(moduleName, 1024 * KiB);
  checkHash(sums, moduleName, module);
  writeFileSync(modulePath, module, { flag: 'wx', mode: 0o600 });
  env.AGENT_VERSION = tag;
}

async function install() {
  if (local) {
    // Offline is a trusted local channel and retains compatibility with unsigned artifacts.
    copyFileSync(join(local, moduleName), modulePath);
    checkHash(readFileSync(join(local, sumsName)), moduleName, readFileSync(modulePath));
  } else await remote();
  const child = spawnSync(process.execPath, [modulePath, 'install', ...args], { stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
}
install().catch(error => { console.error(error instanceof SyntaxError ? 'Invalid release JSON' : error.message); process.exitCode = 1; });
JS
"$node_bin" "$tmp/bootstrap.cjs" "$tmp" "$@"
