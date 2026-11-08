# Review lenses

Every lens runs the same way: read the code for the patterns listed, output each finding as `symptom → failure mode → fix`, concrete only, one line if clean. Cross-cuts and the per-lens small-N exception are stated at the end of each section. Load only the sections selected in the SKILL protocol.

---

## Maintainability & abstraction

### Non-negotiable standards

0. **Be ambitious about structural simplification.** Reframe the change so fewer concepts, branches, helper layers, modes, or conditionals are needed. A refactor that merely moves the same number of concepts around is not accepted; push for a plausible code-judo move that deletes incidental complexity.
1. **A PR should not push a file from under 1k lines to over 1k lines.** Strong smell by default: extract helpers, subcomponents, modules, or local abstractions instead. If the diff crosses the threshold, ask explicitly whether the code should be decomposed first. Waive only for a compelling structural reason with the resulting file still clearly organized.
2. **No random spaghetti growth in existing code.** Be highly suspicious of new ad-hoc conditionals, scattered special cases, one-off booleans, nullable modes, flags, or branches inserted into unrelated flows. "Weird if statements in random places" is a design problem, not a stylistic nit. Prefer a dedicated abstraction, helper, state machine, policy object, explicit dispatcher, typed model, or separate module. Flag code that makes its surroundings harder to reason about even when it works — including narrow edge-case handling in an already busy function and "temporary" branching likely to become permanent debt.
3. **Clean the design, don't just accept working code.** No rubber-stamp because it works or tests pass if the codebase ends up less modular, less readable, or messier. Prefer simplifications that remove moving pieces; turn special-case logic into a simpler default flow with fewer exceptions; collapse duplicate branches into one clear flow.
4. **Prefer direct, boring code over hacky or magical code.** Brittle, ad-hoc, or "magic" behavior is a quality problem. Be skeptical of generic mechanisms hiding simple data-shape assumptions. Delete thin abstractions, identity wrappers, and pass-through helpers that add indirection without clarity.
5. **Push on type and boundary cleanliness.** Question unnecessary optionality, `unknown`, `any`, casts, and loosely shaped ad-hoc objects; prefer explicit typed models or shared contracts. Replace condition chains with a typed model or explicit dispatcher. Where silent fallback papers over an unclear invariant, make the boundary explicit so control flow simplifies.
6. **Keep logic in the canonical layer and reuse existing helpers.** Call out feature logic leaking into shared paths and implementation details leaking through APIs. Reuse the canonical utility instead of copy-pasting a bespoke near-duplicate. Move logic to the package, service, module, or layer that owns the concept; put feature-specific logic behind a dedicated abstraction.
7. **Unnecessary sequential orchestration and non-atomic updates are design smells** when the cleaner structure is obvious. If independent work is serialized for no reason, ask whether parallel execution also simplifies the orchestration. Separate orchestration from business logic. If related updates can leave state half-applied, restructure them into a more atomic flow. Flag avoidable orchestration complexity, not micro-optimizations.

### Questions for every meaningful change

- Is there a code-judo move that would make this dramatically simpler? Can it be reframed so fewer concepts, branches, or helper layers are needed?
- Does this improve or worsen the local architecture? Did a previously cohesive module become more coupled, more stateful, or harder to scan?
- Did the diff add branching complexity where a better abstraction should exist? Are repeated conditionals signaling a missing model or helper?
- Is this logic in the right file, canonical layer, and package, or does it leak details across a boundary? Did it duplicate a canonical helper?
- Did this enlarge a file or component past a healthy size boundary?
- Is the implementation direct and legible, or dependent on special cases and incidental control flow?
- Is the abstraction earning its keep, or is it just a wrapper?
- Did the diff introduce casts, optionality, or ad-hoc object shapes that obscure the invariant?
- Is orchestration more sequential or state less atomic than necessary?

### Preferred remedies

- Delete a whole layer of indirection rather than polishing it.
- Reframe the state model so conditionals disappear instead of merely being centralized.
- Change the ownership boundary so the feature naturally extends an existing abstraction.
- Extract a helper or pure function; split a large file into smaller focused modules.
- Move feature-specific logic behind a dedicated abstraction; separate orchestration from business logic.
- Collapse duplicate branches into a single clearer flow; delete wrappers that don't clarify the API.
- Reuse the existing canonical helper instead of introducing a near-duplicate.
- Make type boundaries explicit and move logic to the layer that owns the concept.
- Parallelize independent work when that also simplifies orchestration; restructure related updates into a more atomic flow.

A rename is not an answer to a structural issue, and a cleaner version of the same messy idea is not an answer when a much simpler idea is plausible.

### Report language that lands

- `this pushes the file past 1k lines. can we decompose this first?`
- `this adds another special-case branch into an already busy flow. can we move this behind its own abstraction?`
- `this works, but it makes the surrounding code more spaghetti. let's keep the behavior and restructure the implementation.`
- `this feels like feature logic leaking into a shared path. can we isolate it?`
- `this abstraction seems unnecessary. can we just keep the direct flow?`
- `why does this need a cast / optional here? can we make the boundary more explicit instead?`
- `this looks like a bespoke helper for something we already have elsewhere. can we reuse the canonical one?`
- `i think there's a code-judo move here that makes this much simpler. can we reframe this so these branches disappear?`
- `this refactor moves complexity around, but doesn't really delete it. is there a way to make the model itself simpler?`

---

## Logic & complexity

Covers time AND space Big O. LLM-generated code is sub-optimal on memory ~18.7% of the time and on time ~18.5% of the time (arxiv 2503.06327) — both axes matter.

### Time

- **Nested loop over the same collection** → `O(N²)`. Fix: hash map / set lookup, or single pass with accumulator.
- **`.includes` / `in` / linear search inside a loop** → `O(N·M)`. Fix: build a `Set` once outside the loop, lookup is `O(1)`.
- **Sort inside a loop** → `O(N² log N)`. Fix: sort once before the loop; if data changes per iteration, use a heap.
- **Recomputing the same value per iteration** (length, parsed config, derived key, regex compile) → constant-factor blow-up, often >10×. Fix: hoist outside the loop, or memoize.
- **Recursion without depth bound or memo** → stack overflow or exponential time. Fix: depth limit; memoize overlapping subproblems; consider iterative with explicit stack.
- **String concatenation in a loop** (Python, Java, JS pre-modern engines) → `O(N²)`, strings are immutable. Fix: list append + `join`, or StringBuilder / array buffer.
- **Repeated work that could be precomputed** (group-by computed every read, sorted view rebuilt) → O(N) or worse per read where O(1) is available. Fix: compute once, cache, invalidate on write.

### Space

- **Building a full-size intermediate array when streaming would do** → memory linear in N. Fix: generator / iterator / lazy sequence / yield.
- **Allocating per iteration** (new object, array, buffer in a hot loop) → GC pressure, fragmentation, latency spikes. Fix: reuse buffer / object pool / preallocate.
- **Storing all results when only the answer is needed** (max, count, sum, first match) → unnecessary `O(N)` space. Fix: single accumulator, or short-circuit on found.
- **Closure over large objects retained past use** → memory leak, prevents GC. Fix: null out / drop reference / scope the closure narrowly.
- **Deep copy where a reference would do** (or vice versa: shared mutable state) → waste or correctness bug. Fix: pick deliberately based on ownership.

### Algorithmic substitution checklist

- Naive recomputes per position → **sliding window**
- Nested iteration over sorted data → **two-pointer**
- Range queries repeated over array → **prefix sums**
- Linear scan of sorted data → **binary search**
- Same subproblem hit > twice → **memoization** / DP
- Set operations on small universe → **bitset**

### Cross-cuts

- Wrong data structure causes most O(N²) patterns. If symptoms point at structure, also load the **data** lens.
- A tight CPU loop next to I/O is rarely the real bottleneck — confirm with the **io** lens.
- Small-N exception: N bounded ≤ ~100 makes `O(N²)` correct. Name the bound, don't refactor.

---

## Data structures

ADT-to-structure mismatches. Mike Acton: *"If you don't understand the data, you don't understand the problem."* List the operations, count their frequency, pick the structure. Casey Muratori: structures should be dense and designed around actual usage patterns, not abstract theory.

| Dominant operation | Right structure | Wrong default to watch for |
| --- | --- | --- |
| Lookup by key | hash map / dict | array with `.find()` |
| Membership test | set | array with `.includes()` |
| Range / sorted access | sorted map / B-tree / sorted array+bs | re-sort on every read |
| FIFO | deque / queue | array with `.shift()` (O(N)) |
| LIFO | stack / array push-pop | linked list (cache-hostile) |
| Priority access | heap / priority queue | sorted array re-sorted on insert |
| Iteration only | array | linked list (cache-hostile) |
| Sparse data | hash map keyed by index | full array of mostly nulls |
| Bidirectional lookup | two maps, or bimap | linear search in one direction |
| Ordered + indexed-by-key | map + ordered keys array, or LinkedHashMap | sort on every iteration |

### Patterns to flag

- **Array where dominant op is lookup or membership** → wrong ADT, drives O(N²) elsewhere. Fix: convert to map/set at the boundary; iterate the original array if order matters.
- **Object with many fields where few are hot** → cache lines wasted, prefetch defeated. Fix: hot/cold split (below).
- **Re-parsing / re-sorting / re-grouping on every read**, or re-building the same derived structure per request (sorted view, index, lookup map) → repeated O(N log N) where O(1) lookup is available. Fix: compute once at write-time, cache the derived view, invalidate on write.
- **Linked list where the only operation is iteration** → cache misses, pointer chasing, 10× slowdown vs array. Fix: array; the "O(1) insert" rarely beats contiguous-memory locality.
- **ORM lazy-loaded relations on iteration** → fat objects, hidden I/O, N+1. Fix: eager-load explicitly; select only needed columns; project to a DTO.
- **Sparse data in a dense array** → wasted memory and iteration time. Fix: hash map keyed by index, or sparse representation (run-length, bitset, sparse matrix lib).
- **Mutable shared collection across boundaries** → defensive copies everywhere, or race conditions. Fix: immutable structure, or single owner with explicit handoff.
- **Fat general-purpose structure where a primitive would do** (`Map<string, boolean>` for a set; objects where tuples suffice) → memory and GC overhead. Fix: use the primitive ADT.

### Hot/cold split and cache locality

A cache line is 64 bytes — every byte loaded and not read is bandwidth burned. When a struct is 200 bytes and the hot path reads 20, you waste cache.

- **Hot fields** → packed struct kept contiguous (array of hot structs, or struct-of-arrays). **Cold fields** → kept by id/index in a separate structure, joined only when needed.
- Iterating pointers (linked list, tree, graph) where iterating values would do → cache miss per node.
- Array of pointers to structs (AoS) when struct-of-arrays (SoA) would let you stream just the hot column.
- Random-access pattern over a large structure → consider sorting access order, or rebuilding into a layout that matches access.

### Cross-cuts

- A wrong data structure is the root cause of most O(N²) patterns flagged by the **logic** lens.
- ORM/relation patterns surface here AND in the **io** lens — both lenses must concur on the fix (eager load + project to DTO).
- Small-N exception: for N < ~100 a single array is usually correct; hashing's constant factor loses to a tight linear scan at 12 items.

---

## Architecture & I/O

I/O is the dominant bottleneck in 95% of backend code. A single network call (~10ms) costs more than a billion CPU cycles. Optimizing algorithmic logic before I/O is sweeping sand on a beach.

Latency: L1 ~0.5ns · main memory ~100ns · SSD read ~150µs (~1500× memory) · network same-DC round-trip ~500µs · cross-region ~10ms (~100000× memory) · DB query ~1–10ms.

### N+1 family

- **Query / HTTP / file-read inside a loop** → N+1 round-trips, linear with N. Fix: batch (`WHERE id IN (...)`), JOIN, bulk endpoint, eager-load.
- **ORM lazy-load triggered by attribute access in a loop** → silent N+1, easy to miss. Fix: explicit eager-load (`select_related`, `joinedload`, `Include`, `with()`).
- **Sub-query per row in SQL** → N+1 inside the database itself. Fix: JOIN, window function, or CTE.
- **Repeated cache misses in a loop** → looks fast in unit tests, isn't in prod. Fix: bulk cache fetch (`MGET`, `mget_many`, multi-key get).
- **Per-item authorization / validation call in a loop** → N round-trips to auth service. Fix: bulk authorize endpoint, or fetch policy once and check locally.

### Concurrency

- **Sequential `await` / blocking calls when calls are independent** → serial latency where parallel was free. Fix: `Promise.all` / `asyncio.gather` / `tokio::join!` / parallel fetch.
- **Parallel calls contending on the same row / lock / connection / rate limit** → false parallelism, often slower than serial. Fix: batch into one call, partition by key, or serialize on the contended resource.
- **Synchronous CPU work blocking the event loop / request thread** → tail latency spikes, head-of-line blocking, dropped requests. Fix: offload to worker thread/pool, stream, defer.
- **Unbounded fan-out** (one request triggers N parallel downstream calls without cap) → thundering herd, downstream collapse, retry storm. Fix: cap concurrency (semaphore / connection pool / chunked `Promise.allSettled` / worker pool).
- **`async` everywhere but no actual concurrency** (every call awaited inline) → all the cost of async, none of the benefit. Fix: identify independent calls, run them concurrently.

### Layering — move code to data, not data to code

- **Filter in app after fetching all rows** → wasted bandwidth and memory, indexes unused. Fix: `WHERE` in the query.
- **Aggregate in app via loop** → loses the DB's index/B-tree advantage, ships N rows instead of 1 number. Fix: `GROUP BY` / `SUM` / `COUNT` in SQL.
- **Compute in client what the server already knows** → round-trip cost, version drift, security boundary mishandled. Fix: compute server-side, ship the result.
- **Compute in app what a materialized view could cache** → recompute per request. Fix: cache, materialize, or precompute on write.
- **Joining in app what the DB could join** → multiple round-trips + in-memory join code. Fix: SQL JOIN, or denormalize if joins dominate.

### Bounded work

- **Unbounded queue / retry / recursion / fan-out** → memory blow, downstream overload, infinite loop. Fix: cap depth, max retries (exponential backoff + jitter), bounded queue with backpressure.
- **No timeout on external call** → one slow dependency stalls the system, threads pile up. Fix: deadline / per-call timeout, circuit breaker on repeated failure.
- **Retry without idempotency** → duplicates, double-charges, corrupted state. Fix: idempotency key, deduplicate on receipt.
- **Cache without TTL or invalidation** → stale data forever, or memory blow. Fix: explicit TTL, or write-through invalidation on mutation.

### Batching

Network ~10ms per round-trip: 1000 items × 1 call each = 10s; 1000 items in one batched call = ~50ms. Always ask whether this can be one call instead of N. TigerBeetle's principle: *"Everything is a batch"* — amortize fixed costs (network setup, fsync, consensus, serialization) across many operations.

### Cross-cuts

- A loop with I/O inside is the worst compounding case. If the **logic** lens flagged O(N²) and this lens flags N+1, you have `N³` round-trips.
- ORM lazy-loading appears here AND in the **data** lens; both must concur on the fix.
- Small-N exception: N ≤ ~10, internal call, no growth → N+1 is fine. Name it (`// N ≤ 10, batching not worth complexity`) and move on.
