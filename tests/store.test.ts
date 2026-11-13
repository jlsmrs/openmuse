import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../apps/server/src/db.ts";

// Raw query access for the index assertions below: the Store keeps its
// database handle private, so reach in through a cast (test-only).
async function indexNames(db: Awaited<ReturnType<typeof createStore>>): Promise<string[]> {
  const raw = db as unknown as {
    db: { query: (sql: string) => Promise<{ rows: Array<{ indexname: string }> }> };
  };
  const { rows } = await raw.db.query(
    "SELECT indexname FROM pg_indexes WHERE tablename = 'records' AND indexname LIKE 'records_%_idx'",
  );
  return rows.map((row) => row.indexname).sort();
}

// S-B4 item 16: the filtered fields have expression indexes.
test("the store creates indexes for the filtered fields", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  assert.deepEqual(await indexNames(db), [
    "records_goal_idx",
    "records_status_idx",
    "records_task_idx",
  ]);
});

// S-B4 item 15: guarded upsert — insert always succeeds, an overwrite only
// lands when the existing row still matches the caller's expectation.
test("putIfMatches refuses a stale overwrite and leaves the row untouched", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  await db.put("owner", "notes", { id: "n1", text: "first" });
  const saved = await db.putIfMatches(
    "owner",
    "notes",
    { id: "n1", text: "second" },
    { id: "n1", text: "first" },
  );
  assert.deepEqual(saved, { id: "n1", text: "second" });
  const refused = await db.putIfMatches(
    "owner",
    "notes",
    { id: "n1", text: "third" },
    { id: "n1", text: "first" },
  );
  assert.equal(refused, null);
  assert.deepEqual(await db.get("owner", "notes", "n1"), { id: "n1", text: "second" });
  // A fresh id inserts regardless of the expected state.
  const inserted = await db.putIfMatches(
    "owner",
    "notes",
    { id: "n2", text: "new" },
    { id: "n2", text: "anything" },
  );
  assert.deepEqual(inserted, { id: "n2", text: "new" });
});

test("concurrent guarded writes let exactly one writer win", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  await db.put("owner", "notes", { id: "n1", text: "first" });
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      db.putIfMatches(
        "owner",
        "notes",
        { id: "n1", text: `writer-${i}` },
        { id: "n1", text: "first" },
      ),
    ),
  );
  assert.equal(attempts.filter(Boolean).length, 1);
  const final = await db.get<{ text: string }>("owner", "notes", "n1");
  assert.ok(final?.text.startsWith("writer-"));
});

test("a partial (subset) expectation does not count as a match", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  await db.put("owner", "conversations", { id: "default", messages: ["a", "b"] });
  const refused = await db.putIfMatches(
    "owner",
    "conversations",
    { id: "default", messages: ["a", "c"] },
    { id: "default", messages: ["a"] },
  );
  assert.equal(refused, null);
  assert.deepEqual(await db.get("owner", "conversations", "default"), {
    id: "default",
    messages: ["a", "b"],
  });
});
