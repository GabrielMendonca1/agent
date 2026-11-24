#!/usr/bin/env node
import assert from "node:assert/strict";
import { initialState, next } from "../agent/core/loop-guard.mjs";

let checks = 0;
function test(name, run) { run(); checks++; console.log(`ok ${name}`); }
function machine() {
  let state = initialState();
  let id = 0;
  const send = (event) => { const outcome = next(state, event); state = outcome.state; return outcome; };
  const call = (input = { command: "ls dist/" }, content = "missing", isError = false) => {
    const toolCallId = String(++id);
    const outcome = send({ type: "tool_call", toolCallId, toolName: "bash", input });
    if (outcome.stop) return outcome;
    return send({ type: "tool_result", toolCallId, isError, content: [{ type: "text", text: content }] });
  };
  return { send, call };
}

test("nudge at 3, block sixth attempt", () => {
  const m = machine();
  for (let i = 1; i <= 5; i++) {
    const outcome = m.call();
    assert.equal(outcome.nudge, i === 3);
    assert.equal(outcome.stop, undefined);
  }
  assert.equal(m.call().stop, true);
});

test("periods 2 and 3 nudge once; only all-error cycles block the continuing call", () => {
  for (const keys of [["A", "B"], ["A", "B", "A"]]) {
    for (const mode of ["success", "mixed", "error"]) {
      const m = machine();
      const call = (command) => m.call({ command }, "same result", mode === "error" || (mode === "mixed" && command === "A"));
      call("prefix");
      for (let i = 0; i < 5 * keys.length; i++) {
        const outcome = call(keys[i % keys.length]);
        assert.equal(outcome.nudge, i + 1 === 3 * keys.length);
        assert.equal(outcome.stop, undefined);
      }
      assert.equal(call(keys[0]).stop, mode === "error" ? true : undefined);
      assert.equal(call("different").stop, undefined);
    }
  }
});

test("changed hashes break cycles and a user message clears cycle history", () => {
  const m = machine();
  for (let i = 0; i < 6; i++) {
    assert.equal(m.call({ command: "A" }).nudge, false);
    assert.equal(m.call({ command: "B" }, `result ${i}`).nudge, false);
  }
  for (let i = 0; i < 5; i++) {
    m.call({ command: "C" }, "error", true);
    m.call({ command: "D" }, "error", true);
  }
  assert.equal(m.call({ command: "C" }).stop, true);
  m.send({ type: "before_agent_start", messageType: "user" });
  assert.equal(m.call({ command: "C" }).stop, undefined);
});

test("new user run resets repetition and empty turns", () => {
  const m = machine();
  for (let i = 0; i < 5; i++) m.call();
  m.send({ type: "turn_end", hasText: false, toolResults: [] });
  m.send({ type: "before_agent_start", messageType: "custom" });
  assert.equal(m.call().stop, true);
  const reset = m.send({ type: "before_agent_start", messageType: "user" });
  assert.equal(reset.state.emptyTurns, 0);
  assert.equal(m.call().stop, undefined);
});

test("polling with a different result resets the streak", () => {
  const m = machine();
  for (let i = 0; i < 4; i++) m.call();
  assert.equal(m.call(undefined, "new output").state.streak, 1);
  assert.equal(m.call(undefined, "new output").nudge, false);
  assert.equal(m.call(undefined, "new output").nudge, true);
});

test("different args reset; object key order is stable", () => {
  const m = machine();
  for (let i = 0; i < 4; i++) m.call();
  assert.equal(m.call({ command: "pwd", timeout: 1 }).state.streak, 1);
  assert.equal(m.call({ timeout: 1, command: "pwd" }).state.streak, 2);
  assert.equal(m.call({ command: "pwd", timeout: 1 }).nudge, true);
});

test("structured results and error status participate in the hash", () => {
  const m = machine();
  for (const [id, structuredContent, isError] of [["a", { n: 1 }, false], ["b", { n: 2 }, false], ["c", { n: 2 }, true]]) {
    m.send({ type: "tool_call", toolCallId: id, toolName: "read", input: {} });
    assert.equal(m.send({ type: "tool_result", toolCallId: id, content: [], structuredContent, isError }).state.streak, 1);
  }
});

test("nested calls do not change state", () => {
  const state = initialState();
  for (const type of ["tool_call", "tool_result"]) {
    assert.equal(next(state, { type, parentToolCallId: "script" }).state, state);
  }
});

test("3 empty or all-error/blocked turns abort", () => {
  const m = machine();
  assert.equal(m.send({ type: "turn_end", hasText: false, toolResults: [] }).abort, false);
  assert.equal(m.send({ type: "turn_end", hasText: false, toolResults: [{ isError: true }] }).abort, false);
  assert.equal(m.send({ type: "turn_end", hasText: false, toolResults: [{ blocked: true }] }).abort, true);
});

test("assistant text or a successful tool result resets empty turns", () => {
  for (const good of [{ hasText: true, toolResults: [] }, { hasText: false, toolResults: [{ isError: false }] }]) {
    const m = machine();
    const empty = { type: "turn_end", hasText: false, toolResults: [] };
    m.send(empty); m.send(empty);
    assert.equal(m.send({ type: "turn_end", ...good }).state.emptyTurns, 0);
    assert.equal(m.send(empty).abort, false);
    assert.equal(m.send(empty).abort, false);
    assert.equal(m.send(empty).abort, true);
  }
});

console.log(`PASS loop-guard (${checks} checks)`);
