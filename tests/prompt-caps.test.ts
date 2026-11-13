// S-B1: the background prompt and the system-prompt application state are
// capped so unbounded memories, prior state or client state cannot blow the
// context window.
import assert from "node:assert/strict";
import test from "node:test";
import { clipPromptContext, MAX_PROMPT_CONTEXT_CHARS } from "../apps/server/src/engine/model.ts";
import {
  clipApplicationState,
  MAX_APPLICATION_STATE_CHARS,
} from "../apps/server/src/engine/tanstack-agent.ts";

test("short prompt context passes through unchanged", () => {
  assert.equal(
    clipPromptContext({ memories: [{ text: "Likes tea" }] }),
    '{"memories":[{"text":"Likes tea"}]}',
  );
});

test("long prompt context is clipped at the budget with a truncation note", () => {
  const clipped = clipPromptContext({ blob: "x".repeat(100000) });
  assert.ok(clipped.length <= MAX_PROMPT_CONTEXT_CHARS + 100);
  assert.match(clipped, /personal context truncated to 20000 characters/);
  assert.equal(clipped.startsWith('{"blob":"'), true);
});

test("short application state passes through unchanged", () => {
  assert.equal(clipApplicationState({ view: "chat" }), '{\n  "view": "chat"\n}');
});

test("long application state is clipped at the budget with a truncation note", () => {
  const clipped = clipApplicationState({ blob: "x".repeat(100000) });
  assert.ok(clipped.length <= MAX_APPLICATION_STATE_CHARS + 100);
  assert.match(clipped, /application state truncated to 20000 characters/);
});
