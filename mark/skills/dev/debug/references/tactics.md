# Debug tactics

## Ways to construct a loop, in roughly this order

1. **Failing test** at whatever seam reaches the bug: unit, integration, e2e.
2. **Curl / HTTP script** against a running dev server.
3. **CLI invocation** with a fixture input, diffing stdout against a known-good snapshot.
4. **Headless browser script** (Playwright / Puppeteer) driving the UI, asserting on DOM/console/network.
5. **Replay a captured trace.** Save a real request / payload / event log to disk; replay it through the code path in isolation.
6. **Throwaway harness.** Minimal subset of the system (one service, mocked deps) exercising the bug path in one call.
7. **Property / fuzz loop.** For "sometimes wrong output": 1000 random inputs, look for the failure mode.
8. **Bisection harness.** Bug appeared between two known states (commit, dataset, version): automate "boot at state X, check, repeat" so `git bisect run` consumes it.
9. **Differential loop.** Same input through old vs new version (or two configs), diff outputs.
10. **HITL bash script.** Last resort: if a human must click, drive *them* with a script that prompts, waits and captures output back to you.

## Tightening

Treat the loop as a product:

- Faster: cache setup, skip unrelated init, narrow the test scope.
- Sharper signal: assert the specific symptom, not "didn't crash".
- More deterministic: pin time, seed RNG, isolate filesystem, freeze network.

A 30-second flaky loop is barely better than none; a 2-second deterministic one is a superpower.

## Non-deterministic bugs

The goal is not a clean repro but a **higher reproduction rate**: loop the trigger 100×, parallelise, add stress, narrow timing windows, inject sleeps. 50%-flake is debuggable, 1% is not — keep raising the rate.

## When you genuinely cannot build a loop

Stop and say so. List what you tried. Ask the user for: (a) access to an environment that reproduces it, (b) a redacted captured artifact (HAR, log dump, core dump, screen recording with timestamps), or (c) permission to add temporary production instrumentation. Hypothesising without a loop is the failure this skill prevents.

## Performance regressions

Logs are usually the wrong probe. Establish a baseline measurement (timing harness, `performance.now()`, profiler, query plan), then bisect. Measure first, fix second.

## Regression-test seams

A correct seam exercises the **real bug pattern as it occurs at the call site**. A seam that is too shallow (single-caller test when the bug needs multiple callers; unit test that can't replicate the triggering chain) gives false confidence. If no correct seam exists, that is itself the finding: the architecture prevents the bug from being locked down — note it in the report.
