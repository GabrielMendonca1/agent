---
name: debug
description: Diagnosis loop for hard bugs and performance regressions.
disable-model-invocation: true
---

# debug

Ordered loop for hard bugs. Skip a step only with an explicit justification.

**Redact first.** This skill has you show commands, outputs and artifacts. Write `<REDACTED>` in place of every secret; build loops against env vars so credentials stay in the environment. Captured artifacts carry auth headers — quote only the lines carrying signal. If redacted output is not enough to diagnose, say so and ask the user.

## 1. Build a tight, red-capable loop

**This is the skill**; everything after it is mechanical. Spend disproportionate effort here — be aggressive, be creative, refuse to give up. Ways to build one, tightening tactics, non-deterministic bugs, and what to do when no loop is possible: `references/tactics.md`.

Done when you can name **one command** — script path, test invocation, curl — that you have **already run at least once** (show the invocation and its redacted output), and:

- [ ] **Red-capable**: drives the actual bug code path and asserts the user's exact symptom, so it goes red on this bug and green once fixed. Not "runs without erroring".
- [ ] **Deterministic**: same verdict every run (flaky bugs: a pinned, high reproduction rate).
- [ ] **Fast**: seconds, not minutes.
- [ ] **Agent-runnable**: runs unattended; a human only via a scripted prompt-and-capture step.

Reading code to build a theory before this command exists is the failure this skill prevents. No red-capable command, no step 2.

## 2. Reproduce + minimise

Run the loop, watch it go red. Then cut inputs, callers, config, data and steps **one at a time**, re-running after each cut.

- [ ] The red is the failure mode the **user** described, not a nearby one. Wrong bug = wrong fix.
- [ ] Reproducible across runs (flaky: at a rate high enough to debug against).
- [ ] Exact symptom captured (error message, wrong output, timing) for later verification.
- [ ] **Every remaining element is load-bearing**: removing any one makes the loop go green.

## 3. Hypothesise

Generate **3–5 ranked hypotheses before testing any**; single-hypothesis generation anchors on the first plausible idea.

- [ ] Each one is **falsifiable**, stating its prediction: "If X is the cause, then changing Y makes the bug disappear / changing Z makes it worse." No prediction = a vibe; sharpen or discard it.
- [ ] Ranked list shown to the user before testing. They re-rank instantly ("we just deployed #3") or name what they already ruled out. Don't block: proceed with your ranking if they are AFK.

## 4. Instrument

Each probe maps to one prediction from step 3. **Change one variable at a time.**

1. **Debugger / REPL** if the env supports it. One breakpoint beats ten logs.
2. **Targeted logs** at the boundaries that distinguish hypotheses — never "log everything and grep".
3. Performance regressions take the measurement branch in `references/tactics.md`.

- [ ] Every debug log tagged with a unique prefix, e.g. `[DEBUG-a4f2]`, so cleanup is one grep.

## 5. Fix + regression test

Write the regression test **before the fix**, at a correct seam (see `references/tactics.md`); if none exists, record that absence as a finding.

- [ ] Minimised repro turned into a test at that seam, watched failing.
- [ ] Fix applied, test watched passing.
- [ ] Step 1 loop re-run against the original, un-minimised scenario.

## 6. Cleanup

- [ ] Original repro no longer reproduces (re-run the step 1 loop).
- [ ] Regression test passes, or the absent seam is documented.
- [ ] All `[DEBUG-...]` instrumentation removed (grep the prefix).
- [ ] Throwaway prototypes deleted, or moved to a clearly-marked debug location.
- [ ] The hypothesis that proved correct stated in the commit / PR message.
