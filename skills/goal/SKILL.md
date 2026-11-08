---
name: goal
description: Run a bounded autonomous long-horizon task from one approved charter — concrete done-criterion, verification command, budgets, a restart checkpoint and an HTML decision audit. Use when work spans many steps, may be resumed later, or should proceed without a question at every branch.
---

# goal

Long work dies from two things: no checkable *done*, and a question at every branch. This skill fixes both — agree **one charter up front**, then execute inside it, recording decisions instead of asking about them.

This never overrides a higher-priority instruction. If the user asked for interrogation, review, or approval per step, that wins; for deep interrogation load [grill](../grill/SKILL.md) explicitly — it is a separate skill, not a phase of this one.

## 1. Charter (one approval, then go)

Draft it from the repo and the request, propose defaults, and ask **once**:

```text
## Goal charter
Id: <slug>            Result: <one sentence end state>
Done: <checkable predicate>
Verify: `<command or evidence source>`
Scope: <paths/actions allowed>   Off-limits: <paths/actions forbidden>
Budgets: <iterations> iters | <wall time> | <stall cap> rounds without progress | <$ or token budget>
Autonomy: decide and record reversible technical choices; escalate <list>
Checkpoint: <project>/.pi/goals/<id>/state.md   Audit: same dir /audit.html
```

Persist the approved charter in `state.md`; do not infer fresh permission on resume. If token/cost metering is unavailable, say so and use enforceable wall-time and iteration caps instead of pretending to measure spend.

Emit only when all four hold: verification is runnable evidence, budgets are numbers, scope names paths and actions, and a progress signal lets the work stop itself. Any one missing → resolve that one before starting, not the whole tree.

## 2. Autonomy inside the charter

**Decide and record** (do not ask): library/helper choice, file layout, naming, test shape, refactor depth inside scope, retry strategy, formatting — anything reversible with a local edit.

**Stop and ask** only for: risk beyond the charter, budget overrun, production/live systems, destructive or irreversible actions (delete, force-push, migrations, deploy, money/legal/medical), external effects (sending messages, third-party calls, publishing), new credentials or permissions, and genuine ambiguity whose answer lies **outside** the charter. When blocked, write the pending audit row, checkpoint, and ask one concrete question with a recommended answer.

## 3. Loop of execution

1. **Inspect** — run the verify command, record the metric.
2. **Decide** — done → stop; budget/stall exhausted → stop and report; escalation trigger → ask.
3. **Act** — one bounded change. Append the *pending* audit row first.
4. **Verify** — rerun; update that row with result, status, timestamp.
5. **Checkpoint** — rewrite `state.md`.

No fake schedulers. `/loop`, cron, wake-ups and "keep going overnight" only exist if the runtime actually provides them; a skill cannot grant them. Without runtime support, the goal runs inside the current session and the checkpoint is what makes it resumable later.

## 4. Checkpoint — `<project>/.pi/goals/<id>/state.md`

Small and rewritten each step; enough for a cold agent to resume without the transcript. On resume, recheck the worktree, pending actions, evidence and remaining budgets before acting; never reset caps or repeat an uncertain external effect blindly:

```text
# goal <id> — <status: running|blocked|done|stopped>
Done when: <predicate>   Verify: `<cmd>`   Last result: <pass/fail + metric> @ <ISO time>
Budgets used: <n/N iters> | <elapsed/limit> | <stall n/limit> | <measured tokens/cost or unavailable>
Approved autonomy: <allowed choices + escalation rules>   Started/deadline: <ISO times>
Scope: <paths>   Off-limits: <paths/actions>
Done so far: <bullets>   Next step: <one action>   Blocked on: <question or ->
```

## 5. Audit — `audit.html`

One standalone HTML file: no JavaScript, no CDN, no external CSS/fonts. It is a **human summary for the user**, not chain-of-thought and not a transcript — one row per *material* decision or action (changes behaviour, costs money/time, is hard to undo, or resolves ambiguity). Each row carries: what was chosen, the rejected alternative with a short reason, what verification showed, timestamp and status.

Append a **pending** row before acting, then patch that row with the result after. Never rewrite history: failed attempts, reversals and resumed steps stay visible. Escape `& < >` in every cell. Template: [audit.md](audit.md) — load only when you must create or extend the file.

## 6. Parallelism

Independent sub-tasks that share this orchestrator → **native subagents**, in the current Mac session, with each one's edits confined to its own files. Never spawn an orchestrator that spawns orchestrators; no recursive herds, no workspace-per-step reflex. Serialize anything that touches the same file.

## 7. Checklist scenarios

| Situation | Do |
|---|---|
| "Fix the failing tests, I'm going out" | Charter, run loop, decide fixes yourself, audit each, stop at cap |
| Two reasonable libraries, both reversible | Pick one, record rejected alternative + reason, continue |
| Needs a prod DB migration | Pending row, checkpoint, ask — do not run |
| Request is vague and charter cannot cover it | Ask before starting; if user wants depth, load `grill` |
| User said "ask me at each step" | Obey them; charter autonomy does not apply |
| Session ends mid-way | `state.md` is current; next session resumes from Next step |
| Four independent files to migrate | Native subagents, one per file, this session |
| "Keep running all night" | Say plainly: only with real runtime scheduling; otherwise checkpoint + resume |
