#!/usr/bin/env bash
set -euo pipefail
command -v node >/dev/null || { echo 'Install Node >=22.19 first' >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' || { echo 'Install Node >=22.19 first' >&2; exit 1; }
case "$(uname -s)" in Darwin|Linux) ;; *) echo 'POSIX bootstrap only; Windows is not validated' >&2; exit 1;; esac
if [ -z "${AGENT_RELEASE_DIR:-}" ]; then
  command -v gh >/dev/null || { echo 'Authenticated GitHub CLI (gh) is required' >&2; exit 1; }
  GH_HOST=github.com gh auth status >/dev/null 2>&1 || { echo 'Authenticate gh for private repository access first' >&2; exit 1; }
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [ -n "${AGENT_RELEASE_DIR:-}" ]; then
  cp "$AGENT_RELEASE_DIR/agent-distribution.mjs" "$AGENT_RELEASE_DIR/SHA256SUMS" "$tmp/"
  cp "$AGENT_RELEASE_DIR/"*.tar.gz "$tmp/"
else
  repo=${AGENT_RELEASE_REPO:-GabrielMendonca1/agent}
  tag=${AGENT_VERSION:-}
  [[ "$repo" =~ ^[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+$ ]] || { echo "Invalid private repository" >&2; exit 1; }
  [[ -z "$tag" || "$tag" =~ ^[a-zA-Z0-9_.+-]+$ ]] || { echo "Invalid release tag" >&2; exit 1; }
  platform=$(node -p 'process.platform+"-"+process.arch')
  download=(release download -R "$repo" -p "agent-*-$platform.tar.gz" -p SHA256SUMS -p agent-distribution.mjs -D "$tmp")
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
platform=$(node -p 'process.platform+"-"+process.arch')
archives=("$tmp"/agent-*-"$platform".tar.gz)
[ "${#archives[@]}" -eq 1 ] && [ -f "${archives[0]}" ] || { echo 'Expected exactly one platform archive' >&2; exit 1; }
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.agent}"
node "$tmp/agent-distribution.mjs" "${archives[0]}" "$@"
printf '%s\n' 'Run ~/.local/bin/agent and /login with your own provider account.' 'If needed: export PATH="$HOME/.local/bin:$PATH" (no shell rc changed).'
