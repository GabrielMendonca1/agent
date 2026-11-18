#!/usr/bin/env bash
set -euo pipefail
command -v node >/dev/null || { echo 'Install Node >=22.19 first' >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' || { echo 'Install Node >=22.19 first' >&2; exit 1; }
if [ -z "${AGENT_RELEASE_DIR:-}" ]; then
  command -v gh >/dev/null || { echo 'Authenticated GitHub CLI (gh) is required' >&2; exit 1; }
  GH_HOST=github.com gh auth status >/dev/null 2>&1 || { echo 'Authenticate gh for private repository access first' >&2; exit 1; }
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ -n "${AGENT_RELEASE_DIR:-}" ]; then
  cp "$AGENT_RELEASE_DIR/agent-distribution.mjs" "$AGENT_RELEASE_DIR/SHA256SUMS" "$tmp/"
else
  repo=${AGENT_RELEASE_REPO:-GabrielMendonca1/agent}
  tag=${AGENT_VERSION:-}
  [[ "$repo" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || exit 1
  [[ -z "$tag" || "$tag" =~ ^[a-zA-Z0-9_.+-]+$ ]] || exit 1
  view=(release view -R "$repo" --json tagName --jq .tagName)
  if [ -n "$tag" ]; then view+=("$tag"); fi
  tag=$(GH_HOST=github.com gh "${view[@]}")
  [[ "$tag" =~ ^[a-zA-Z0-9_.+-]+$ ]] || exit 1
  export AGENT_VERSION="$tag"
  download=(release download -R "$repo" -p agent-distribution.mjs -p SHA256SUMS -D "$tmp")
  if [ -n "$tag" ]; then download+=("$tag"); fi
  GH_HOST=github.com gh "${download[@]}"
fi
# Authenticate the channel via gh; these hashes detect corruption, not publisher signatures.
node - "$tmp" <<'JS'
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=process.argv[2],name='agent-distribution.mjs';
const matches=fs.readFileSync(path.join(root,'SHA256SUMS'),'utf8').split(/\r?\n/).map(l=>/^([a-f0-9]{64})  ([A-Za-z0-9._+-]+)$/.exec(l)).filter(m=>m?.[2]===name);
if(matches.length!==1||crypto.createHash('sha256').update(fs.readFileSync(path.join(root,name))).digest('hex')!==matches[0][1])throw Error('Bootstrap digest mismatch');
JS
# v0.1.0 exposes bootstrap/downloadArtifact but predates the install CLI.
node --input-type=module - "$tmp/agent-distribution.mjs" "$tmp" "$@" <<'JS'
import { pathToFileURL } from 'node:url';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
const [modulePath, temp, ...args] = process.argv.slice(2);
process.argv[1] = process.execPath; // Legacy bootstrap compares realpaths at import time.
const dist = await import(pathToFileURL(modulePath));
if (dist.install) process.exitCode = dist.install(args);
else {
  process.env.PI_CODING_AGENT_DIR ||= join(process.env.HOME, '.agent');
  const local = process.env.AGENT_RELEASE_DIR;
  const names = local && readdirSync(local).filter(n => n.endsWith(`-${process.platform}-${process.arch}.tar.gz`));
  if (local && names.length !== 1) throw Error('Expected exactly one platform archive');
  const d = local ? { archive: join(local, names[0]) } : dist.downloadArtifact(temp, process.env.AGENT_VERSION || '');
  process.exitCode = dist.bootstrap(d.archive, [...(d.tag ? ['--release-tag', d.tag, '--release-repo', d.repo] : []), ...args]);
}
JS
