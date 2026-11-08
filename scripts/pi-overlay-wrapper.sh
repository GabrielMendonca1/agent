#!/usr/bin/env bash
set -euo pipefail

OVERLAY_REPO=${PI_OVERLAY_REPO:-__OVERLAY_REPO__}
STORE=${PI_OVERLAY_STORE:-$HOME/.local/share/pi-overlay}
UPDATER="$OVERLAY_REPO/scripts/pi-overlay-update.mjs"
ACTIVE_PI="$STORE/current/bin/pi"
MARK_II_CONFIG="$STORE/mark-ii/config.json"
MARK_II_LAUNCHER="$OVERLAY_REPO/scripts/mark-ii-launch.mjs"

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

# Caminho normal (as rotas de manutenção acima já saíram por exec): o MARK II entra aqui, e só
# quando houve opt-in explícito. Sem config, nada muda em relação ao comportamento anterior.
# MARK_II_DISABLED=1 é o escape documentado; o launcher é quem valida artefato/broker/config e
# falha fechado — um `pi` que anuncia contabilização sem tê-la seria pior do que um que não abre.
if [ "${MARK_II_DISABLED:-}" != "1" ] && [ -f "$MARK_II_CONFIG" ]; then
  if [ ! -f "$MARK_II_LAUNCHER" ]; then
    echo "MARK II está habilitado em $MARK_II_CONFIG, mas $MARK_II_LAUNCHER não existe neste bundle." >&2
    echo "Reinstale o overlay (node $UPDATER) ou rode sem MARK II: MARK_II_DISABLED=1 pi" >&2
    exit 1
  fi
  exec node "$MARK_II_LAUNCHER" --store "$STORE" -- "$@"
fi

if [ ! -x "$ACTIVE_PI" ]; then
  echo "Pi overlay is not installed; run: node $UPDATER" >&2
  exit 1
fi

exec "$ACTIVE_PI" "$@"
