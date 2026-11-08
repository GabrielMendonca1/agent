---
name: review
description: Judge code through lenses — maintainability, complexity, data structures, architecture and I/O — and report each finding as symptom → failure mode → fix.
disable-model-invocation: true
---

# Code Review

A review is a set of lenses applied to code. All lens content lives in `references/lenses.md`.

## 1. Pick the lenses

- Every meaningful change → **maintainability** (`references/lenses.md`, section *Maintainability & abstraction*)
- Loops, recursion, transformations, search, sort → **logic**
- Non-trivial state or collections (lookups, joins, dedups, accumulations) → **data**
- Boundary crossings (network, DB, disk, IPC, blocking) → **io**
- A loop AND an I/O call in the same function → load **logic** AND **io**: the compounding (O(N²) × N+1 round-trips) is the worst failure mode and invisible from either lens alone.

Skip the performance lenses for throwaway scripts, prototypes still validating an idea, bounded-small N (< ~100 forever), and pure plumbing. Apply them when code loops over user/network/db/file data, N grows with users or time, or it is a maintained hot path.

The performance lenses are static analysis, not profiling: when a bottleneck is suspected but not visible by inspection, profile.

## 2. DESIGN pass (before writing)

Answer the applicable questions in the response before the code exists, so contradictions surface on the page. Baseline for every change: audit the branch's changes deeply, rethink how to structure them to meaningfully improve quality without impacting behavior, be ambitious enough to restructure parts of the codebase when there is a clear path, measure twice cut once.

- **Frame the simplest design.** Look for a "code judo" reorganization that makes whole branches, helpers, modes, conditionals, or layers disappear. Prefer deleting complexity to rearranging it, and the solution that feels inevitable in hindsight.
- **Place ownership.** Identify the canonical package, service, module, utility, model, and API boundary. Keep feature logic out of shared paths and implementation details behind their owning API.
- **Make contracts explicit.** Avoid unnecessary optionality, `unknown`, `any`, casts, loosely shaped ad-hoc objects, and silent fallback where an explicit typed model or shared contract can state the invariant.
- **Bound N.** Give a realistic upper bound for every collection in scope. Unbounded or > ~10k means complexity IS the design.
- **Pick the data shape** from the dominant operation: lookup-by-key → map; membership → set (never `array.includes` in a loop); sorted/range → sorted structure or sort-once + binary search; FIFO/LIFO → queue/stack; array only when iteration order is the only operation.
- **Name the bottleneck** on the hot path: CPU, memory, disk, or network. Any I/O inside a loop is the bottleneck — no further analysis needed.
- **Batch & bound.** Can N round-trips become 1? Can computation move to where the data lives (filter in DB, not app)? What caps memory, queue depth, retries, fan-out, recursion? Unbounded is a bug.
- **Plan orchestration and state.** Independent work should not be serialized without reason; related updates should be atomic when partial state is harder to reason about.

## 3. AUDIT pass (after writing)

Load only the selected sections of `references/lenses.md` and run their checks against the code. Report every finding as `symptom → failure mode → fix`, with file and line. Concrete only. A lens that finds nothing gets one line saying so.

Most real code needs maintainability plus two of the three performance lenses.

## 4. Report

Be direct, serious, demanding, and actionable without being rude. If code makes the codebase messier or misses a dramatic simplification, say so clearly. Prefer a few high-conviction findings over cosmetic nits; do not flood the review with nits while structural issues stand.

Order findings by:

1. Structural code-quality regressions
2. Missed code-judo / dramatic simplification
3. Spaghetti and branching complexity increases
4. Boundary, abstraction, and type-contract problems
5. File-size and decomposition concerns
6. Modularity, legibility, maintainability

## 5. Verdict

Correct behavior and passing tests do not earn approval. Approve only when each of these is checked off explicitly:

- [ ] No structural regression, and no plausible code-judo move left on the table
- [ ] No file pushed from below 1000 lines to above 1000 lines without a compelling structural reason
- [ ] No ad-hoc branching tangling an existing flow, and no feature checks scattered across shared code
- [ ] No hacky/magical abstraction, unnecessary wrapper, cast, or optionality churn obscuring the design
- [ ] No architecture-boundary leak and no duplication of a canonical helper
- [ ] No missed obvious decomposition that materially improves maintainability
- [ ] Every selected lens reported, each finding in `symptom → failure mode → fix` form

An unchecked box is a presumptive blocker: name it, propose the cleaner decomposition. If every box is checked, say the code is clean under every loaded lens in one line and end.

## Anti-cargo-cult clause

A strict review does not invent problems to justify itself. It does not demand a hash map for a 5-item list. If N is bounded and small, an O(N²) loop can be correct: name the bound (`// N ≤ 50, O(N²) acceptable`) and move on. Apply maintainability pressure where simplification is real, not where abstraction would merely add ceremony. The choices must be conscious, not accidental.
