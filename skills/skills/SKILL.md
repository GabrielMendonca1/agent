---
name: skills
description: Write or review a Claude Code skill so it behaves predictably. Covers the leading word, model-invoked vs user-invoked, router skills, the description rules, the body's information hierarchy, when to split, the six failure modes (premature-completion, duplication, sediment, sprawl, no-op, negation), and a pruning checklist. Use before creating or editing any SKILL.md, or when asked "is this skill good?".
disable-model-invocation: true
---

# Writing great skills

A skill exists to wrangle determinism out of a stochastic system. Optimize for **predictability** — a consistent *process*, not identical output. Every rule below serves that.

## Naming & invocation

- **Leading word.** Pick a compact concept the model already knows from pretraining; it anchors both behavior and invocation. Refactor repeated meanings down to that single word. Examples: "fast, deterministic, low-overhead" → *tight*; "a loop you believe in" → *red* (a binary observable state). Assume every skill is carrying restatements a leading word could retire — go find them.
- **Model-invoked** — has a `description`; the model fires it on its own. Costs **context load** (the description is always resident). Use only when the model must reach it independently, or another skill calls it.
- **User-invoked** — set `disable-model-invocation: true`. Zero context load, but costs **cognitive load**: you are the index, you must remember it exists. The `description` becomes human-facing — a one-line summary, trigger list stripped. Default for skills fired only by hand.
- **Router skill** — when user-invoked skills multiply past what you can remember, cure the cognitive load with one user-invoked skill that names the others and when to reach for each.

## Description (model-invoked only)

- Front-load the leading word.
- One trigger per branch — collapse synonyms; two phrasings of the same trigger is duplication.
- Strip identity that's already in the body. Keep only triggers + reach clauses.
- Every word adds context load. Cut ruthlessly.

## Body — information hierarchy

Order by how immediately the agent needs it:

1. **In-skill steps** (primary) — ordered actions with **checkable, exhaustive completion criteria**. Make the criterion specific: "every modified model accounted for", not "done".
2. **In-skill reference** — definitions, rules, facts consulted on demand. Flat peer-sets are fine.
3. **External reference** — push behind a pointer (`references/X.md`); it loads only when the pointer fires.

Co-locate concept, rule, and caveat under one heading.

## When to split

Only when the cut earns its load cost:
- **By invocation** — another skill must reach the piece independently (give it its own leading word).
- **By sequence** — hide post-completion steps that would tempt the agent to stop early.

## The six failure modes

| Mode | What it is | Fix |
|---|---|---|
| **Premature completion** | Stops before genuinely done | Sharpen the completion criterion; hide post-completion steps by splitting |
| **Duplication** | Same meaning in two places | One source of truth; refactor into the leading word |
| **Sediment** | Stale layers pile up over edits | Prune; delete what no longer holds |
| **Sprawl** | Too long even when every line is live | Disclose reference behind pointers; branch by path |
| **No-op** | Lines that change nothing vs. defaults | Replace weak words ("be thorough") with strong ones ("relentless"); or delete |
| **Negation** | Prohibition names the wrong behavior and makes it more available ("don't think of an elephant") | Formulate the positive instead; keep a prohibition only as a hard guardrail impossible to phrase positively, and always pair it with what to do instead |

## Pruning checklist

- [ ] One source of truth per meaning.
- [ ] Every sentence earns its place — test each in isolation (does behavior change without it?); a sentence that fails is deleted whole, not trimmed.
- [ ] Completion criteria are sharp and checkable.
- [ ] No synonym branches disguised as distinct triggers.
- [ ] Leading word reused to anchor behavior.
- [ ] Progressive disclosure: inline what every path needs, pointer what only some do.

---
*Adaptado de writing-great-skills (Matt Pocock), rebase 2026-07-14.*
