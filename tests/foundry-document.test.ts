// Foundry document-ai tool: the provider payload is capped before it is
// returned to the model, so one huge document-ai response cannot flood the
// thread with uncapped text.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  analyzeDocumentTool,
  FOUNDRY_DOCAI_MAX_CHARS,
} from "../apps/server/src/engine/foundry-document.ts";

const files = {
  get: async () => ({ name: "doc.pdf" }),
  bytes: async () => Buffer.from("fake-pdf-bytes"),
} as never;

function stubFetch(t: TestContext, handler: (url: string) => Promise<Response>): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string) => handler(url)) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function setEnv(t: TestContext): void {
  const previous = {
    FOUNDRY_DOCAI_ENDPOINT: process.env.FOUNDRY_DOCAI_ENDPOINT,
    FOUNDRY_DOCAI_KEY: process.env.FOUNDRY_DOCAI_KEY,
  };
  process.env.FOUNDRY_DOCAI_ENDPOINT = "https://example.invalid/docai";
  process.env.FOUNDRY_DOCAI_KEY = "test-key";
  t.after(() => {
    if (previous.FOUNDRY_DOCAI_ENDPOINT === undefined) delete process.env.FOUNDRY_DOCAI_ENDPOINT;
    else process.env.FOUNDRY_DOCAI_ENDPOINT = previous.FOUNDRY_DOCAI_ENDPOINT;
    if (previous.FOUNDRY_DOCAI_KEY === undefined) delete process.env.FOUNDRY_DOCAI_KEY;
    else process.env.FOUNDRY_DOCAI_KEY = previous.FOUNDRY_DOCAI_KEY;
  });
}

type DocResult = { file?: string; extracted?: unknown; truncated?: boolean; error?: string };

async function executeDoc(fileId: string): Promise<DocResult> {
  const tool = analyzeDocumentTool(files, "owner");
  assert.ok(tool.execute);
  return (await tool.execute({ fileId })) as DocResult;
}

test("a small provider payload is returned whole", async (t) => {
  setEnv(t);
  stubFetch(t, async () =>
    Response.json({ text: "hello", fields: { merchant: "Shop" } }, { status: 200 }),
  );
  const result = await executeDoc("f1");
  assert.equal(result.file, "doc.pdf");
  assert.deepEqual(result.extracted, { text: "hello", fields: { merchant: "Shop" } });
  assert.equal(result.truncated, undefined);
});

test("an over-cap provider payload is truncated and flagged", async (t) => {
  setEnv(t);
  stubFetch(t, async () =>
    Response.json({ text: "x".repeat(FOUNDRY_DOCAI_MAX_CHARS + 1000) }, { status: 200 }),
  );
  const result = await executeDoc("f1");
  if (typeof result.extracted !== "string") assert.fail("expected a truncated string");
  assert.ok(result.extracted.length <= FOUNDRY_DOCAI_MAX_CHARS + "[truncated]".length + 10);
  assert.match(result.extracted, /\[truncated\]$/);
  assert.equal(result.truncated, true);
});

test("a non-JSON success response returns the normal error object", async (t) => {
  setEnv(t);
  stubFetch(t, async () => new Response("<html>not json</html>", { status: 200 }));
  const result = await executeDoc("f1");
  assert.match(result.error ?? "", /non-JSON/);
  assert.equal(result.extracted, undefined);
});
