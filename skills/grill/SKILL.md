---
name: grill
description: Interrogate a plan, decision, or idea until shared understanding, in rounds. Use on "grill me", "stress-test this", or before committing to real work.
---

# grill

Interview the user until you reach shared understanding. Model the work as a **design tree**: every decision branches into the decisions that hang off it.

## Rounds and the frontier

The **frontier** is every decision whose prerequisites are already settled — the questions you can ask *now* without guessing at answers you have not heard yet.

Ask **the whole frontier in one round**, numbered, each carrying your recommended answer. Then wait. A question whose answer depends on another question still open in this round belongs to a *later* round, not this one.

Each set of answers reshapes the tree: settled decisions push the frontier outward and unblock what depended on them. Recompute the frontier and ask the next round.

Format a round like this:

```text
❓ **Q1 — <title>**: <body, may include enumerated choices>

➡️ <your recommended answer>

---

❓ **Q2 — <title>**: <body>

➡️ <your recommended answer>
```

When the choices enumerate cleanly, the `ask_user` tool renders them as a selector — one call per question, still inside the same round.

## Facts are yours, decisions are theirs

Finding **facts** is never the user's job. When a frontier question needs something from the environment — filesystem, git, config, logs, an API — go get it. For anything that takes real digging, dispatch a background agent (`omni` scout) instead of stalling the round.

Do not block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait. Ask the rest of the frontier now.

**Decisions** — scope, tradeoff, priority, risk tolerance, taste — belong to the user. Put each to them and wait. Never answer your own question, never simulate an answer, never let a branch close by assumption.

## Push back

Re-grill a branch when an answer makes the plan incoherent, contradicts an earlier decision, or skips a simpler option. Silent acceptance of a bad answer is the failure mode this skill exists to prevent.

## Done

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Close with the brief:

```text
## Grill brief
Locked: <each resolved decision, one line each>
Defaults kept: <branch — the default that stands>
Open: <anything the user chose to leave unresolved>
```

Do not act on the plan — no code, no edits, no dispatched work — until the user confirms the brief reflects shared understanding. Grilling is a design phase.

## Composition

Use this skill for explicit deep interrogation. `goal` is independent: it agrees an execution charter and runs bounded work; it does not load grill by default. Other domain skills may point here when an interview is actually requested.
