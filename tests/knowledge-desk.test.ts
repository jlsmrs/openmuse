import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cosine,
  searchKnowledgeDeskTool,
  validateDeskEntries,
} from "../apps/server/src/engine/knowledge-desk.ts";

const valid = { id: "1", source: "sop.md", title: "Title", text: "Some text." };

test("validateDeskEntries accepts a valid index, with or without embeddings", () => {
  assert.deepEqual(validateDeskEntries([]), { ok: true, entries: [] });
  assert.deepEqual(validateDeskEntries([valid]), { ok: true, entries: [valid] });
  assert.deepEqual(validateDeskEntries([{ ...valid, embedding: [0.1, 0.2] }]), {
    ok: true,
    entries: [{ ...valid, embedding: [0.1, 0.2] }],
  });
});

test("validateDeskEntries rejects a non-array index", () => {
  assert.equal(validateDeskEntries({}).ok, false);
  assert.equal(validateDeskEntries("entries").ok, false);
  assert.equal(validateDeskEntries(null).ok, false);
});

test("validateDeskEntries rejects entries missing a required string field", () => {
  for (const field of ["id", "source", "title", "text"] as const) {
    const { [field]: _, ...rest } = valid;
    const result = validateDeskEntries([rest]);
    assert.equal(result.ok, false, `entry missing "${field}" must be rejected`);
    if (!result.ok) assert.match(result.error, new RegExp(`entry 0.*"${field}"`));
  }
  assert.equal(validateDeskEntries([42]).ok, false);
  assert.equal(validateDeskEntries([{ ...valid, title: 7 }]).ok, false);
});

test("validateDeskEntries rejects a non-numeric embedding", () => {
  assert.equal(validateDeskEntries([{ ...valid, embedding: [0.1, "x"] }]).ok, false);
  assert.equal(validateDeskEntries([{ ...valid, embedding: "vec" }]).ok, false);
});

test("cosine rejects a dimension mismatch instead of truncating", () => {
  assert.throws(() => cosine([1, 0], [1, 0, 0]), /dimension mismatch/);
  assert.throws(() => cosine([1, 0, 0], [1, 0]), /dimension mismatch/);
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
});

test("a mismatched entry embedding falls back to keyword scoring with a warning", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-desk-"));
  const previous = {
    DATA_DIR: process.env.DATA_DIR,
    FOUNDRY_EMBEDDINGS_ENDPOINT: process.env.FOUNDRY_EMBEDDINGS_ENDPOINT,
    FOUNDRY_EMBEDDINGS_KEY: process.env.FOUNDRY_EMBEDDINGS_KEY,
  };
  process.env.DATA_DIR = dir;
  process.env.FOUNDRY_EMBEDDINGS_ENDPOINT = "https://example.invalid/embeddings";
  process.env.FOUNDRY_EMBEDDINGS_KEY = "test-key";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json({ data: [{ embedding: [1, 0, 0] }] }, { status: 200 })) as typeof fetch;
  t.after(async () => {
    globalThis.fetch = originalFetch;
    if (previous.DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous.DATA_DIR;
    if (previous.FOUNDRY_EMBEDDINGS_ENDPOINT === undefined)
      delete process.env.FOUNDRY_EMBEDDINGS_ENDPOINT;
    else process.env.FOUNDRY_EMBEDDINGS_ENDPOINT = previous.FOUNDRY_EMBEDDINGS_ENDPOINT;
    if (previous.FOUNDRY_EMBEDDINGS_KEY === undefined) delete process.env.FOUNDRY_EMBEDDINGS_KEY;
    else process.env.FOUNDRY_EMBEDDINGS_KEY = previous.FOUNDRY_EMBEDDINGS_KEY;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "knowledge-desk"), { recursive: true });
  await writeFile(
    join(dir, "knowledge-desk", "index.json"),
    JSON.stringify([
      {
        id: "1",
        source: "a.md",
        title: "Notary signing",
        text: "notary signing rules",
        embedding: [1, 0, 0],
      },
      { id: "2", source: "b.md", title: "Notary stamp", text: "notary stamp", embedding: [0, 1] },
    ]),
  );
  assert.ok(searchKnowledgeDeskTool.execute);
  const result = (await searchKnowledgeDeskTool.execute({ query: "notary" })) as {
    method?: string;
    hits?: unknown[];
    warning?: string;
  };
  assert.equal(result.method, "embeddings");
  assert.equal(result.hits?.length, 2);
  assert.match(result.warning ?? "", /different dimension.*keyword instead/);
});
