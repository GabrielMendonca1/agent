# Rename map — Mark → Agent

Agent is the current Mark tree, renamed. Nothing else changes: no refactor, no new features.

## Keep intact (upstream Pi or unrelated words)

- Pi identifiers: `pi` binary inside the installation (`<store>/current/bin/pi`), `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `overlay/manifest.json` fields `officialRepository`, `officialPackage`, `overlayBase`, `overlayRef`, `releaseOverlays`; `overlay/model-data/**`.
- Pi env and dirs: `PI_CODING_AGENT_DIR`, `PI_TUI_*`, `PI_ACCOUNT_*`, `PI_AUTOMATIC_SKILLS`, `~/.pi/agent`, project `.pi/` (including `.pi/checks.json`, `.pi/todos`).
- Shared protocol values: `harness: "pi"` (Megamind), Megamind server contract, `MEGAMIND_*`, `ARCA_*`.
- Words: `markdown`, `marker`, `marked`, `remark`, `bookmark`, `markDelivered`, `marks`, `stream-markdown`, `CODESPAN_SYMBOL`.
- Legacy compatibility constants (`mark2`, `LEGACY_NATIVE_*`) stay as they are: they describe old state, not identity.
- Licenses and attribution (`agent/skills/CREDITS.md`, iso-figure LICENSE).

## Rename (case-sensitive, whole tokens)

| Today | Agent |
|---|---|
| `mark-pi`, `GabrielMendonca1/mark-pi` | `agent`, `GabrielMendonca1/agent` |
| `Mark II`, `Mark` (product/persona, "O Mark") | `Agent` ("O Agent") |
| `mark-ii`, `markII`, `MARK_II_*` | `agent`, `agent`, `AGENT_*` (no generation suffix) |
| `MARK_*` env (`MARK_DIR`, `MARK_TREE`, `MARK_WARM_START`…) | `AGENT_*` |
| tree `mark/`, `MARK_SUBDIR = "mark"` | `agent/`, `"agent"` (paths already moved) |
| `mark/extensions/mark` (extension `mark`) | `agent/extensions/agent` (already moved) |
| `mark-patches/` | `agent-patches/` (already moved) |
| `.mark/`, `.mark-themes`, `.mark-agents.json` | `.agent/`, `.agent-themes`, `.agent-agents.json` |
| prompt tags `mark_autonomy`, `mark_complex`, `mark_notes`, `mark_skill_categories`, `mark_tickets` | `agent_*` |
| `mark-meta-peers`, `Symbol.for("mark.askUser.requests")` | `agent-meta-peers`, `"agent.askUser.requests"` |
| `PATH_MARKER` text `# mark-pi: …` | `# agent: …` |
| themes `*-claude-cc-mark*.json` | `*-claude-cc-agent*.json` (files already moved) |
| scripts `scripts/*mark*.mjs`, `scripts/lib/mark-*.mjs`, `mark-ii-launch.mjs`, `mark-ii-runtime.mjs`, `mark-ii-resources.mjs` | `agent-*`, `agent-launch.mjs`, `agent-runtime.mjs`, `agent-resources.mjs` (files already moved; imports must follow) |
| check names `mark-*`, `mark-ii-*`, tag `mark-ii` | `agent-*`, tag `agent` |
| `manifest.name: "mark-pi"`, `"mark": "II"` | `name: "agent"`; remove the `mark` field (and its assertion in `test-layers.mjs`) |

## Installation and launcher (owned by Agent, renamed)

| Today | Agent |
|---|---|
| store `~/.local/share/pi-overlay` | `~/.local/share/agent` |
| `PI_OVERLAY_STORE`, `PI_OVERLAY_REPO` | `AGENT_STORE`, `AGENT_REPO` |
| `scripts/pi-overlay-update.mjs` | `scripts/agent-update.mjs` |
| `scripts/pi-overlay-wrapper.sh/.cmd` | `scripts/agent-wrapper.sh/.cmd` |
| public command `~/.local/bin/pi` | `~/.local/bin/agent` (subcommands `overlay-update`, `overlay-rollback`, `overlay-status`, `overlay-gc`, `update` keep their names) |
| release metadata `pi-overlay.json` | `agent-release.json` |
| store subdir `mark-ii/` (config.json, releases) | `runtime/` |
| flags `--mark-ii-enable`, `--mark-ii-disable` | `--agent-enable`, `--agent-disable` |
| backup suffix `-mark-ii-<label>` | `-agent-<label>` |
| `overlayFingerprint` and related names | keep (not identity) |

The upstream `pi` executable stays inside `<store>/current/bin/pi`; the wrapper delegates to it.

## Removed (vendor pipeline needs the old Git history)

`scripts/vendor-gabriel-setup.mjs`, `scripts/regen-extensions-patch.mjs`, `scripts/test-regen-extensions-patch.mjs`, `scripts/lib/mark-closure.mjs`, check `extensions-patch`. References to them are deleted, not renamed. This repository is the source of the code.

## Verification

- Residual grep must be empty outside the keep list: `rg -n -i 'mark' --glob '!overlay/model-data/**' | rg -v 'markdown|marker|marked|remark|bookmark|markDeliver|marks\b|mark2|LEGACY_NATIVE'`
- `python3 -m json.tool overlay/manifest.json`; `shasum -a 256 overlay/*.patch` must match the manifest.
- Every fast check in `.pi/checks.json` runs directly: `node scripts/test-*.mjs`.
