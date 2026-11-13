import assert from "node:assert/strict";
import test from "node:test";
import { browserInputSchema } from "../apps/server/src/browser.ts";

// S-B4 item 5: console input is validated at the API boundary with the same
// bounds the worker enforces, so a malformed payload is rejected here with a
// 422 instead of travelling to the worker and failing there.
test("console input is validated at the API boundary", () => {
  assert.deepEqual(browserInputSchema.parse({ type: "click", x: 100, y: 200 }), {
    type: "click",
    x: 100,
    y: 200,
  });
  assert.deepEqual(browserInputSchema.parse({ type: "text", text: "hello" }), {
    type: "text",
    text: "hello",
  });
  assert.deepEqual(browserInputSchema.parse({ type: "key", key: "Enter" }), {
    type: "key",
    key: "Enter",
  });
  assert.deepEqual(browserInputSchema.parse({ type: "key", key: "Control+a" }), {
    type: "key",
    key: "Control+a",
  });
  assert.deepEqual(browserInputSchema.parse({ type: "scroll", deltaY: -120 }), {
    type: "scroll",
    deltaY: -120,
  });
  for (const bad of [
    { type: "click", x: 1280, y: 10 },
    { type: "click", x: 10, y: 800 },
    { type: "click", x: Number.NaN, y: 10 },
    { type: "click", x: -1, y: 10 },
    { type: "text", text: "x".repeat(10_001) },
    { type: "key", key: "F5" },
    { type: "scroll", deltaY: 5001 },
    { type: "scroll", deltaY: -5001 },
    { type: "drag", x: 1, y: 2 },
    { type: "click" },
    "not-an-object",
    null,
    [],
  ])
    assert.throws(() => browserInputSchema.parse(bad));
});
