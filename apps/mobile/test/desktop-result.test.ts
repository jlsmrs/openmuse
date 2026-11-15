import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopResult, rawDesktopResult } from "../src/desktop-result.ts";

test("a JSON string result parses to its action, receipt and error", () => {
  assert.deepEqual(parseDesktopResult(JSON.stringify({ action: "screenshot", receiptId: "r-1" })), {
    action: "screenshot",
    receiptId: "r-1",
  });
  assert.deepEqual(parseDesktopResult(JSON.stringify({ error: "The desktop step failed" })), {
    error: "The desktop step failed",
  });
});

test("an already-parsed object result parses without a JSON round trip", () => {
  assert.deepEqual(parseDesktopResult({ action: "click", receiptId: "r-2" }), {
    action: "click",
    receiptId: "r-2",
  });
  assert.deepEqual(parseDesktopResult({ error: "no session" }), { error: "no session" });
});

test("an unparseable result still renders as its raw text", () => {
  assert.equal(parseDesktopResult("not json"), undefined);
  assert.equal(parseDesktopResult({ exitCode: 1, detail: "boom" }), undefined);
  assert.equal(rawDesktopResult("not json"), "not json");
  assert.equal(rawDesktopResult({ exitCode: 1, detail: "boom" }), '{"exitCode":1,"detail":"boom"}');
  assert.equal(rawDesktopResult(new Error("kaboom")), "kaboom");
  assert.equal(rawDesktopResult(undefined), undefined);
  assert.equal(rawDesktopResult(null), undefined);
});
