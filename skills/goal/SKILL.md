---
name: goal
description: "Goal — run long work unattended from one approved charter: checkable done, verify command, budgets, a resumable checkpoint and an HTML audit. Use when work spans many steps, may resume in a later session, or should run without a question at every branch."
---

# goal

**Unattended**: one charter is the only question; after approval you are the sole decision-maker and the user's next contact is the final report. A user instruction requiring per-step approval outranks this skill.

## 1. Inventory

Read-only; discovery never authorizes, connects or logs in. Record each category, or `unavailable`:
- Git remotes and branches; project scripts, CI and deploy configs.
- SSH hosts: `Host` entries in `~/.ssh/config` (and includes) plus SSH aliases provisioned by Megamind; resolve with `ssh -G <host>` (for example, `ssh -G my-vm`).
- Megamind browser accounts, via `arca` (guide: `arca skills get orca-cli`).
- Authenticated CLIs (`gh`, `vercel`, `fly`…): account and status only.

Secrets stay out of inventory, state, audit and logs.

## 2. Charter — the one approval

Draft from inventory and request, propose defaults, ask once:

```text
## Goal charter
Id: <slug>            Result: <one-sentence end state>
Done: <checkable predicate>   Verify: `<command or evidence source>`
Scope: <paths/actions>        Off-limits: <paths/actions>
Push: <remote + branches | none>   Deploy: <targets/environments | none>
SSH: <hosts + actions | none>      Browser: <accounts + actions | none>
Budgets: <N> iters | <wall time> | <stall cap> rounds without progress | <token/cost cap or unmetered>
Checkpoint: <project>/.pi/goals/<id>/state.md   Audit: same dir /audit.html
```

Ready to ask when: Verify is runnable, every budget is a number, and Push/Deploy/SSH/Browser each name exact targets or `none`. Approval is the user's explicit instruction to commit, push (no force) and deploy inside those bounds. Write `state.md` with status `running` only after approval — that status is what locks `ask_user`.

## 3. Loop

1. **Inspect** — run Verify, record the metric.
2. **Decide** — done, budget or stall exhausted → finish (§6); next step crosses a red line or leaves the charter → **defer** it (§4) and pick other authorized work.
3. **Act** — one bounded change; append a *pending* audit row first. Commit each verified change; push and deploy to approved targets, production included when listed.
4. **Verify** — rerun; patch that row with result, status, time.
5. **Checkpoint** — rewrite `state.md`.

Choices inside scope (libraries, layout, naming, tests, retries, refactor depth) are yours: decide, record the rejected alternative, continue.

## 4. Red lines — defer

These stay undone under any charter: force-push or rewriting shared history; deleting production data, databases or volumes, or destructive migrations without a backup; spending money; messaging or publishing to third parties as the user; creating, rotating or exposing credentials, or changing account permissions; any target outside the approved inventory.

**Defer** = audit row with status `adiado` and the reason, the same item under `Adiado` in `state.md`, then continue. A deferred item waits for the final report.

## 5. Checkpoint — `state.md`

Rewritten every step; enough for a cold resume. Resume reuses the stored charter, rechecks worktree, pending effects and remaining budgets, and repeats no uncertain external effect.

```text
# goal <id> — <running|blocked|done|stopped>
Charter: <full approved text>
Last verify: <pass/fail + metric> @ <ISO time>
Budgets used: <n/N iters> | <elapsed/limit> | <stall n/limit> | <tokens/cost or unmetered>
Done so far: <bullets>   Next step: <one action>
Adiado: <item + reason, or none>
```

## 6. Finish

Set status: `done` (Verify passes), `stopped` (budget, stall or user stop), `blocked` (only deferred work remains). Finished when `state.md` and `audit.html` agree and the report lists: Verify result, every commit/push/deploy (hash, branch, target), budgets used, every `adiado` item.

## Audit and parallelism

`audit.html` is a standalone human summary, one row per material decision; rules and template in [audit.md](audit.md), loaded when creating or extending it.

Independent sub-tasks → native subagents in this session, each confined to its own files and bound by the same charter and red lines; serialize anything touching a shared file.
