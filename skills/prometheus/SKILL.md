---
name: prometheus
description: Drive Prometheus (the desktop app, formerly ARCA Desktop) through its CLI — open a new terminal with another agent session (Pi by default) and hand it a task, in this checkout or a new worktree; read or type into an app terminal; use the app's built-in browser tab; or click through a native Windows/macOS app. Use when the user asks to open a terminal/session/agent and pass work, or when the work lives in Prometheus state or needs GUI control on a partner's machine.
---

# Prometheus

Prometheus (repo `GabrielMendonca1/prometheus`, formerly `ARCA.app`) exposes
its state through a CLI that talks to the running app. Existing macOS profiles
may install it at `~/Applications/Prometheus.app`; resolve the CLI rather than
assuming that path:
`arca` on macOS, `orca` on Windows (`orca.cmd`, put on PATH when the command line
tool is enabled). The same binary ships the version-matched guides, so load them
instead of guessing flags.

1. Resolve the CLI: run `arca status --json` (macOS) or `orca status --json`
   (Windows) and reuse that name below as `CLI`. If the command is not found,
   ask the user to enable the command line tool in Prometheus settings and stop.
2. Load the guide for the job and follow it:
   - worktrees, terminals, handoffs, built-in browser: `CLI skills get orca-cli`
   - native app GUI (Windows UI Automation / macOS accessibility): `CLI skills get computer-use`
   The dynamically loaded, version-matched guide is authoritative for available flags.
3. Prefer `--json`. If a command says the app is not running, `CLI open --json`
   and retry once.

Done when the command's JSON result shows the requested effect. For a handoff,
a worktree id or terminal handle is only intermediate: require a prompt receipt
with `accepted: true`. For GUI actions, require a fresh accessibility snapshot.

## Choosing the surface

- Project paths and tasks come from the catalog and `STATUS.md` (skill
  `megamind`); use the app only to act on them.
- Work for another agent in the app: use Pi unless the user explicitly requests
  Claude or Codex. The session can use this checkout or a new worktree; see the
  handoff steps below. Coordination across machines stays in Megamind.
- A web page the user is looking at inside the app: the built-in browser
  (`orca-cli` guide).
- GUI control is the last resort, after shell, files, git, HTTP and existing CLIs.

## Open another session and hand it a task

Use Pi by default. Substitute `claude` or `codex` only when the user explicitly
asks for that agent. Make the brief state the objective, done condition,
verification, and limits.

For parallel editing, default to a new worktree:

```sh
CLI worktree create --name <task-name> --agent pi --prompt "<brief>" --json
```

Add `--no-parent` for independent work rather than a child of the current
context. Use `startupTerminal.handle` from the result as the agent handle. Do
not create a second agent terminal.

For a new session in this checkout:

```sh
CLI terminal create --worktree path:<absolute-checkout-path> --title "<task-name>" --command pi --json
CLI terminal read --terminal <handle> --json
# Only after readiness is confirmed:
CLI terminal send --terminal <handle> --text "<brief>" --enter --json
```

Take `<handle>` from `result.terminal.handle`; `--worktree active` also works
inside an app-managed checkout. `terminal wait --for tui-idle` can time out
with Pi already ready. Instead, inspect `result.terminal.tail` for Pi's input
box (`│ >`) and status bar before sending. Retry reads with a short pause,
up to five attempts within 30 seconds; if readiness remains unclear, stop and
report the handle without sending. Never busy-loop or repeat an accepted
prompt because the agent is silent.

For explicitly requested follow-up, use `terminal read` or find the session
with `peers_list` and use `peers_context`/`peers_ask`.

The handoff is complete when the prompt receipt reports `accepted: true`; that
proves input acceptance, not task completion. Report the handle and stop without
waiting for results unless the user asked you to supervise. Never close a
terminal you did not create.

## Marking an agent worktree

When you create a git worktree for a subagent outside the app (for example
`git worktree add /tmp/<name> -b <branch>`), mark it so the app's sidebar lists
it under "agentes trabalhando" instead of offering to hide it:

```sh
printf '%s' '{"agent":"<model or role>","task":"<one line>","createdBy":"<you>"}' \
  > "$(git -C <worktree> rev-parse --git-dir)/arca-agent.json"
```

The file lives in the worktree's git dir, never in `git status`, and goes away
with `git worktree remove`. Every field is optional. Worktrees under the system
temp dir are treated as agent work even without the marker.
