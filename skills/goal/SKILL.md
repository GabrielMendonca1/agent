---
name: goal
description: Run a bounded autonomous long-horizon task from one approved charter — concrete done-criterion, verification command, budgets, a restart checkpoint and an HTML decision audit. Use when work spans many steps, may be resumed later, or should proceed without a question at every branch.
---

# goal

Agree **one charter up front**, then execute inside it, recording decisions instead of asking. This never overrides a higher-priority instruction. If the user requires approval per step, that wins; for deep interrogation load [grill](../grill/SKILL.md) explicitly, not as a phase of this skill.

## 1. Charter (one approval, then go)

Before drafting, **inventory where you can act**, read-only and without authentication changes:
- Git remotes and branches; project scripts, CI and deploy configs.
- SSH `Host` entries in `~/.ssh/config` (including configured includes) and company aliases provisioned by Megamind, e.g. `ssh omni` / `ssh arca`; resolve candidates with `ssh -G <host>`. Do not connect or infer permission from discovery.
- Logged-in accounts in the Prometheus browser: inspect through CLI `arca`, following `arca skills get orca-cli`.
- Already-authenticated CLIs such as `gh`, `vercel`, `fly`: detect status/account only, never print tokens or secrets. If discovery is unavailable or requires consent, mark it unavailable; do not authenticate or bypass consent.

Draft from this inventory and the request, propose defaults, and ask **once**, before setting status to `running`:

```text
## Goal charter
Id: <slug>            Result: <one sentence end state>
Done: <checkable predicate>   Verify: `<command or evidence source>`
Scope: <paths/actions allowed>   Off-limits: <paths/actions forbidden>
Inventory approved: <discovered targets; explicitly mark authorized vs excluded/unavailable>
Push: <remote + branches>   Deploy: <targets/environments>
SSH: <hosts + allowed actions>   Browser: <accounts + allowed actions>
Budgets: <iterations> iters | <wall time> | <stall cap> rounds without progress | <token/cost cap>
Autonomy: execute within approved scope and inventory; defer red lines, never ask mid-goal
Checkpoint: <project>/.pi/goals/<id>/state.md   Audit: same dir /audit.html
```

Discovery is not authorization: list exact authorized targets/actions, or `none`, for each category. The approved charter is explicit instruction to commit, push without force and deploy within those bounds, not permission for red lines. Persist the full approved charter and inventory in `state.md`; on resume reuse them, never ask for approval again or silently expand them.

Start only with runnable verification, numeric budgets, named paths/actions and a progress signal. Resolve missing items in the single charter approval, before execution. If token/cost metering is unavailable, state that and enforce wall-time and iteration caps instead.

## 2. Autonomy inside the charter

**Decide, act and record; do not ask.** Choose libraries, layout, naming, test shape, refactor depth, retries and formatting. Commit frequently, push without force to approved remotes/branches, and deploy to listed targets, including production if approved. Record effects and verification in the audit; no additional confirmation.

**Fixed red lines — do not act, even under an autonomy charter:** force-push or rewrite shared-branch history; delete production data/databases/volumes or run destructive migrations without backup; spend money, purchase or subscribe; send messages or publish to third parties on the user's behalf; create, rotate or expose credentials or change account permissions; act on any target outside the approved inventory. Authorized code push/deploy above is not permission for unrelated publishing or messaging.

For every red line or out-of-scope ambiguity, mark **adiado** in both `audit.html` and `state.md`, explain the constraint and continue other authorized work. Never request confirmation as a workaround. If no authorized progress remains, stop and report the deferred items; do not change status merely to unlock a question and resume execution.

After approval, **no `ask_user`, text questions, remote questions or confirmations** until done or budget/stall exhaustion. A terminal blocker gets a final report, not a question. Do not treat a blocked tool as a reason to ask through another channel. The extension blocks `ask_user` whenever any `<cwd>/.pi/goals/*/state.md` has first-line status `running`; `blocked`, `done` and `stopped` release it. Keep project cwd and state accurate; the pre-running charter question remains available.

## 3. Loop of execution

1. **Inspect** — run the verify command, record the metric.
2. **Decide** — done → stop; budget/stall exhausted → stop and report; red line → defer and continue.
3. **Act** — one bounded change. Append the *pending* audit row first.
4. **Verify** — rerun; update that row with result, status, timestamp.
5. **Checkpoint** — rewrite `state.md`, including remaining budgets and deferred items.

No fake schedulers. `/loop`, cron, wake-ups and overnight execution require real runtime support. Otherwise execution runs in this session and the checkpoint makes it resumable. On termination set `done` when verified, `stopped` at budget/stall exhaustion or user stop, or `blocked` only when no authorized progress remains. Report verification, commits/pushes/deploys, budgets and all deferred items; do not append a new approval question.

## 4. Checkpoint — `<project>/.pi/goals/<id>/state.md`

Small and rewritten each step; sufficient for a cold resume without the transcript. Preserve the full charter and inventory. Recheck worktree, pending effects, evidence and remaining budgets before resuming; never reset caps or repeat an uncertain external effect blindly. Set `running` before further execution, without another approval:

```text
# goal <id> — <status: running|blocked|done|stopped>
Approved charter and inventory: <full approved text, including targets/actions and exclusions>
Done when: <predicate>   Verify: `<cmd>`   Last result: <pass/fail + metric> @ <ISO time>
Budgets used: <n/N iters> | <elapsed/limit> | <stall n/limit> | <measured tokens/cost or unavailable>
Started/deadline: <ISO times>   Scope: <paths>   Off-limits: <paths/actions>
Done so far: <bullets>   Next step: <one action>   Blocked on: <constraint or ->
Adiado: <deferred action + reason, or none>
```

## 5. Audit — `audit.html`

One standalone HTML file: no JavaScript, CDN or external CSS/fonts. A **human summary**, not chain-of-thought, transcript or raw logs; never include secrets in the inventory, state, audit or logs. One row per *material* decision/action: choice, rejected alternative and short reason, verification, timestamp, status.

Append **pending** before acting, patch after verification; never erase failed attempts, reversals or resumed steps. For red lines use visible status **adiado** (the template's `blocked` CSS class is sufficient), with reason and unperformed action as result; mirror it in `state.md`. Escape `& < >` in every cell. Template: [audit.md](audit.md), loaded only to create or extend the audit.

## 6. Parallelism

Independent sub-tasks sharing this orchestrator → **native subagents**, current Mac session, each confined to its files and the same charter/red lines/no-question rule. No recursive orchestrators or workspace-per-step reflex. Serialize shared-file changes.

## 7. Checklist scenarios

| Situation | Do |
|---|---|
| "Fix the failing tests, I'm going out" | Inventory, one charter, loop, audit, stop at cap |
| Two reasonable libraries | Pick one, record alternative + reason, continue |
| Approved production deploy | Commit, push without force and deploy to approved targets; verify and audit |
| Destructive prod migration without backup / unknown host | Mark adiado in audit + state; continue authorized work |
| Vague request | Resolve in charter before running; load `grill` if explicitly requested |
| User requires approval each step | Obey; this autonomy mode does not apply |
| Session ends mid-way | Resume from state with same charter/inventory and remaining budgets, no question |
| Budget/stall exhausted | Set stopped, report results and deferred items, no overrun |
