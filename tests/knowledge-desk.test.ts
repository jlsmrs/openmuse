import assert from "node:assert/strict";
import { test } from "node:test";
import { validateDeskEntries } from "../apps/server/src/engine/knowledge-desk.ts";

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
