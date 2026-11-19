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

// P1-9 fix round: Store.transaction commits or rolls back as one unit, so
// Files.pull can write the artifact copy and its audit entry atomically.
test("transaction commits every put inside it", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  await db.transaction(async (tx) => {
    await tx.put("owner", "notes", { id: "n1", text: "first" });
    await tx.put("owner", "notes", { id: "n2", text: "second" });
  });
  assert.deepEqual(await db.get("owner", "notes", "n1"), { id: "n1", text: "first" });
  assert.deepEqual(await db.get("owner", "notes", "n2"), { id: "n2", text: "second" });
});

test("transaction rolls back every put when the work throws", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.put("owner", "notes", { id: "n1", text: "first" });
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await db.get("owner", "notes", "n1"), null);
});

// --- B1 fix round 2 (panel re-review R-2, Nov 18, 2026) -------------------
// These transaction tests exercise the EMBEDDED PGlite backend:
// createStore() with no databaseUrl builds a PGlite store, which is the
// backend the tests run against. The pg backend is NOT exercised here —
// it needs a live Postgres, which this environment does not provide.
// Its transaction shape (a dedicated pooled client checked out for the
// whole transaction) is structurally immune to the interleaving below:
// a pooled client cannot see another transaction's writes, and a plain
// pool.query can never land on the transaction's client. The PGlite
// backend needed the fix because it is a single connection shared by
// every query.

// R-2: overlapping transactions stay independent (probe R7 shape).
// Explicit synchronization gates, not timer gates (round 6, test
// adequacy): A's callback signals once its put has landed, the test
// then issues B while A is still open, and only then releases A to
// fail. No setTimeout is involved, so the intended overlap is
// arranged deterministically instead of hoped for within 50 ms.
test("overlapping transactions do not commit each other's rows", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  let releaseA!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseA = resolve;
  });
  let signalPut!: () => void;
  const putDone = new Promise<void>((resolve) => {
    signalPut = resolve;
  });
  const a = db.transaction(async (tx) => {
    await tx.put("owner-a", "files", { id: "a1", text: "A" });
    signalPut();
    await gate; // yield: B's whole transaction is issued here
    throw new Error("audit write failed");
  });
  await putDone;
  const b = db.transaction(async (tx) => {
    await tx.put("owner-b", "files", { id: "b1", text: "B" });
    await tx.put("system", "file-pull-audit", { id: "audit-b", text: "B" });
  });
  releaseA();
  const results = await Promise.allSettled([a, b]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  // A's row must be gone: B's COMMIT must not have committed it, and
  // A's ROLLBACK must have undone it.
  assert.equal(await db.get("owner-a", "files", "a1"), null);
  assert.deepEqual(await db.get("owner-b", "files", "b1"), { id: "b1", text: "B" });
  assert.deepEqual(await db.get("system", "file-pull-audit", "audit-b"), {
    id: "audit-b",
    text: "B",
  });
});

test("an ordinary write issued mid-transaction is not swept into it", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  // Same explicit gates as the test above (round 6, test adequacy):
  // the plain write is issued only after the transaction's put has
  // deterministically landed, while the transaction is still open.
  let releaseDoomed!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseDoomed = resolve;
  });
  let signalPut!: () => void;
  const putDone = new Promise<void>((resolve) => {
    signalPut = resolve;
  });
  const doomed = db.transaction(async (tx) => {
    await tx.put("owner-c", "files", { id: "c1", text: "C" });
    signalPut();
    await gate;
    throw new Error("rollback me");
  });
  await putDone;
  // Issue the plain write while the transaction is open: on the shared
  // single connection it used to join the open transaction and be rolled
  // back with it, even though its own call fulfilled.
  const plain = db.put("owner-d", "files", { id: "d1", text: "D" });
  releaseDoomed();
  const results = await Promise.allSettled([doomed, plain]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.equal(await db.get("owner-c", "files", "c1"), null);
  assert.deepEqual(await db.get("owner-d", "files", "d1"), { id: "d1", text: "D" });
});

test("nested transaction calls join the ambient transaction", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  await db.transaction(async (tx) => {
    await tx.put("owner", "notes", { id: "n1", text: "outer" });
    await tx.transaction(async (inner) => {
      await inner.put("owner", "notes", { id: "n2", text: "inner" });
    });
  });
  assert.deepEqual(await db.get("owner", "notes", "n1"), { id: "n1", text: "outer" });
  assert.deepEqual(await db.get("owner", "notes", "n2"), { id: "n2", text: "inner" });
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.put("owner", "notes", { id: "n3", text: "outer" });
      await tx.transaction(async (inner) => {
        await inner.put("owner", "notes", { id: "n4", text: "inner" });
      });
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await db.get("owner", "notes", "n3"), null);
  assert.equal(await db.get("owner", "notes", "n4"), null);
});
