#!/usr/bin/env bash
set -euo pipefail

OVERLAY_REPO=${AGENT_REPO:-__OVERLAY_REPO__}
STORE=${AGENT_STORE:-$HOME/.local/share/agent}
# Perfil do Agent (settings, auth, sessões, extensões): separado do ~/.pi/agent do Pi.
export PI_CODING_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.agent}"
UPDATER="$OVERLAY_REPO/scripts/agent-update.mjs"
ACTIVE_PI="$STORE/current/bin/pi"
AGENT_CONFIG="$STORE/runtime/config.json"
AGENT_LAUNCHER="$OVERLAY_REPO/scripts/agent-launch.mjs"

case "${1:-}" in
  overlay-update)
    shift
    exec node "$UPDATER" "$@"
    ;;
  overlay-rollback)
    shift
    exec node "$UPDATER" --rollback "$@"
    ;;
  overlay-status)
    shift
    exec node "$UPDATER" --status "$@"
    ;;
  overlay-gc)
    shift
    exec node "$UPDATER" --gc "$@"
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
      node "$UPDATER" --install-artifact latest
      exec "$ACTIVE_PI" update "${extension_args[@]}"
    fi
    exec node "$UPDATER" --install-artifact latest
    ;;
esac

# Sempre passe pelo helper quando disponível: inclusive opt-out precisa limpar preloads herdados.
if [ -f "$AGENT_LAUNCHER" ]; then
  exec node "$AGENT_LAUNCHER" --store "$STORE" -- "$@"
fi
if [ -f "$AGENT_CONFIG" ]; then
  echo "Agent configurado em $AGENT_CONFIG, mas $AGENT_LAUNCHER não existe. Reinstale o bundle." >&2
  exit 1
fi

if [ ! -x "$ACTIVE_PI" ]; then
  echo "Pi overlay is not installed; run: node $UPDATER" >&2
  exit 1
fi

exec "$ACTIVE_PI" "$@"
