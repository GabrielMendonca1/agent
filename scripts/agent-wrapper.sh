#!/usr/bin/env bash
set -euo pipefail

OVERLAY_REPO=${AGENT_REPO:-__OVERLAY_REPO__}
STORE=${AGENT_STORE:-$HOME/.local/share/agent}
# Perfil do Agent (settings, auth, sessões, extensões): separado do ~/.pi/agent do Pi/Mark.
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
      node "$UPDATER"
      exec "$ACTIVE_PI" update "${extension_args[@]}"
    fi
    exec node "$UPDATER"
    ;;
esac

# Caminho normal (as rotas de manutenção acima já saíram por exec): o Agent entra aqui, e só
# quando houve opt-in explícito. Sem config, nada muda em relação ao comportamento anterior.
# AGENT_DISABLED=1 é o escape documentado; o launcher é quem valida artefato/broker/config e
# falha fechado — um `pi` que anuncia contabilização sem tê-la seria pior do que um que não abre.
if [ "${AGENT_DISABLED:-}" != "1" ] && [ -f "$AGENT_CONFIG" ]; then
  if [ ! -f "$AGENT_LAUNCHER" ]; then
    echo "Agent está habilitado em $AGENT_CONFIG, mas $AGENT_LAUNCHER não existe neste bundle." >&2
    echo "Reinstale o overlay (node $UPDATER) ou rode sem Agent: AGENT_DISABLED=1 agent" >&2
    exit 1
  fi
  exec node "$AGENT_LAUNCHER" --store "$STORE" -- "$@"
fi

if [ ! -x "$ACTIVE_PI" ]; then
  echo "Pi overlay is not installed; run: node $UPDATER" >&2
  exit 1
fi

exec "$ACTIVE_PI" "$@"
