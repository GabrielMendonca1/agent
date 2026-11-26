# Native Windows bootstrap. No profile or permanent PATH changes.
$ErrorActionPreference = 'Stop'
$version = 'v24.22.3'
# https://nodejs.org/dist/v24.22.3/SHASUMS256.txt; see lib/portable-node.mjs.
$sha = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f'
$argv = $args
$oldPath = $env:PATH
$oldNodeOptions = $env:NODE_OPTIONS
$tmp = $null
$stage = $null
$lock = $null
$code = 1
try {
    $store = if ($env:AGENT_STORE) { $env:AGENT_STORE } else { Join-Path $(if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }) '.local/share/agent' }
    for ($i = 0; $i -lt $argv.Count; $i++) {
        if ($argv[$i] -ceq '--tag') {
            if ((++$i) -ge $argv.Count) { throw '--tag requires a value' }
        } elseif ($argv[$i] -ceq '--store') {
            if ((++$i) -ge $argv.Count) { throw '--store requires a value' }
            $store = if ($argv[$i]) { [string]$argv[$i] } else { '.' }
        }
    }
    $store = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($store)
    $nodeRoot = Join-Path $store 'node'
    $versionDir = Join-Path $nodeRoot $version
    $nodeBin = Join-Path $versionDir 'node.exe'
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    $systemNode = $null
    if ($env:AGENT_PORTABLE_NODE -cne '1' -and ($env:AGENT_RELEASE_DIR -or $env:AGENT_USE_SYSTEM_NODE -ceq '1')) {
        $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) {
            & $command.Source -e 'const [a,b]=process.versions.node.split(String.fromCharCode(46)).map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)'
            if ($LASTEXITCODE -eq 0) { $systemNode = $command.Source }
        }
    }
    if ($systemNode) { $nodeBin = $systemNode } else {
        if (!(Test-Path -LiteralPath $nodeBin -PathType Leaf)) {
            if ($env:AGENT_RELEASE_DIR -and $env:AGENT_PORTABLE_NODE -cne '1') {
                throw 'Offline installation needs Node >=22.19 or an existing portable Node (AGENT_PORTABLE_NODE=1 permits download)'
            }
            $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
            if ($arch -ne 'AMD64') { throw 'Unsupported portable Node platform (expected Windows x64)' }
            $base = if ($env:AGENT_NODE_BASE_URL) { $env:AGENT_NODE_BASE_URL.TrimEnd('/') } else { 'https://nodejs.org/dist' }
            if ($base -cnotmatch '^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/[a-zA-Z0-9._+/%~-]*)?$') { throw 'Invalid Node base URL' }
            if ($base -cmatch '^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$)') {
                if ($env:AGENT_NODE_SHA256) { $sha = $env:AGENT_NODE_SHA256 }
            } elseif (!$base.StartsWith('https://')) { throw 'Node base URL requires HTTPS except on loopback' }
            if ($sha -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid Node SHA-256' }
            [IO.Directory]::CreateDirectory($nodeRoot) | Out-Null
            $stage = Join-Path $nodeRoot ('.stage.' + [guid]::NewGuid().ToString('N'))
            [IO.Directory]::CreateDirectory($stage) | Out-Null
            $file = "node-$version-win-x64.zip"
            $archive = Join-Path $stage $file
            # No release credentials or redirects for a Node archive.
            Invoke-WebRequest -UseBasicParsing -Uri "$base/$version/$file" -OutFile $archive -TimeoutSec 120 -MaximumRedirection 0
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha) { throw 'Portable Node SHA-256 mismatch' }
            Expand-Archive -LiteralPath $archive -DestinationPath $stage
            $extracted = Join-Path $stage "node-$version-win-x64"
            if (!(Test-Path -LiteralPath (Join-Path $extracted 'node.exe') -PathType Leaf)) { throw 'Portable Node executable is missing' }
            try { [IO.Directory]::Move($extracted, $versionDir) }
            catch { if (!(Test-Path -LiteralPath $nodeBin -PathType Leaf)) { throw } }
        }
        # Serialize junction changes. On Windows there is no atomic replace for
        # an existing directory junction; stage the replacement and restore on failure.
        $lockPath = Join-Path $nodeRoot '.current.lock'
        for ($attempt = 0; $null -eq $lock; $attempt++) {
            try { $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
            catch [IO.IOException] { if ($attempt -ge 100) { throw }; Start-Sleep -Milliseconds 100 }
        }
        $current = Join-Path $nodeRoot 'current'
        $link = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
        if ($link -and $link.LinkType -ne 'Junction') { throw 'Portable Node current is not a junction' }
        if (!$link -or $link.Target -ne $versionDir) {
            $pending = Join-Path $nodeRoot ('.link.' + [guid]::NewGuid().ToString('N'))
            $backup = "$pending.old"
            New-Item -ItemType Junction -Path $pending -Target $versionDir | Out-Null
            try {
                if ($link) { [IO.Directory]::Move($current, $backup) }
                try { [IO.Directory]::Move($pending, $current) }
                catch { if ($link) { [IO.Directory]::Move($backup, $current) }; throw }
                if ($link) { [IO.Directory]::Delete($backup) }
            } finally { if (Test-Path -LiteralPath $pending) { [IO.Directory]::Delete($pending) } }
        }
        $lock.Dispose(); $lock = $null
        $env:PATH = "$versionDir$([IO.Path]::PathSeparator)$oldPath"
    }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('ai-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($tmp) | Out-Null
    $bootstrap = Join-Path $tmp 'bootstrap.cjs'
    $source = @'
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
'@
    [IO.File]::WriteAllText($bootstrap, $source)
    & $nodeBin $bootstrap $tmp @argv
    $code = $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
} finally {
    if ($lock) { $lock.Dispose() }
    $env:PATH = $oldPath
    $env:NODE_OPTIONS = $oldNodeOptions
    if ($stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
    if ($tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
exit $code
