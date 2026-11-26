#!/usr/bin/env bash
set -euo pipefail

OVERLAY_REPO=${AGENT_REPO:-__OVERLAY_REPO__}
STORE=${AGENT_STORE:-$HOME/.local/share/agent}
# Perfil do Agent (settings, auth, sessões, extensões): separado do ~/.pi/agent do Pi.
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.agent}"
NODE_BIN="$STORE/node/current/bin/node"
if [ -f "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
  export PATH="${NODE_BIN%/*}:$PATH"
else
  NODE_BIN=node
fi
UPDATER="$OVERLAY_REPO/scripts/agent-update.mjs"
ACTIVE_PI="$STORE/current/bin/pi"
AGENT_CONFIG="$STORE/runtime/config.json"
AGENT_LAUNCHER="$OVERLAY_REPO/scripts/agent-launch.mjs"

case "${1:-}" in
  migrate-from-mark)
    shift
    exec "$NODE_BIN" "$OVERLAY_REPO/scripts/migrate-from-mark.mjs" "$@"
    ;;
  deps)
    shift
    exec "$NODE_BIN" "$OVERLAY_REPO/scripts/lib/agent-deps.mjs" "$@"
    ;;
  overlay-update)
    shift
    exec "$NODE_BIN" "$UPDATER" "$@"
    ;;
  overlay-rollback)
    shift
    exec "$NODE_BIN" "$UPDATER" --rollback "$@"
    ;;
  overlay-status)
    shift
    exec "$NODE_BIN" "$UPDATER" --status "$@"
    ;;
  overlay-gc)
    shift
    exec "$NODE_BIN" "$UPDATER" --gc "$@"
    ;;
  update)
    shift
    mode=self
    extension_args=(--extensions)
    for arg in "$@"; do
      case "$arg" in
        --all)
          mode=all
          ;;
        self|pi|--self)
          ;;
        --force|--approve|--no-approve)
          extension_args+=("$arg")
          ;;
        --models|--extensions|--extension)
          mode=delegate
          ;;
        -*|*)
          mode=delegate
          ;;
      esac
    done

    if [ "$mode" = delegate ]; then
      exec "$ACTIVE_PI" update "$@"
    fi
    if [ "$mode" = all ]; then
      "$NODE_BIN" "$UPDATER" --install-artifact latest
      exec "$ACTIVE_PI" update "${extension_args[@]}"
    fi
    exec "$NODE_BIN" "$UPDATER" --install-artifact latest
    ;;
esac

# Sempre passe pelo helper quando disponível: inclusive opt-out precisa limpar preloads herdados.
if [ -f "$AGENT_LAUNCHER" ]; then
  exec "$NODE_BIN" "$AGENT_LAUNCHER" --store "$STORE" -- "$@"
fi
if [ -f "$AGENT_CONFIG" ]; then
  echo "Agent configurado em $AGENT_CONFIG, mas $AGENT_LAUNCHER não existe. Reinstale o bundle." >&2
  exit 1
fi

if [ ! -x "$ACTIVE_PI" ]; then
  echo "Pi overlay is not installed; run: $NODE_BIN $UPDATER" >&2
  exit 1
fi

exec "$ACTIVE_PI" "$@"
