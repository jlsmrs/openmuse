import assert from "node:assert/strict";
import test from "node:test";
import {
  createPgDatabase,
  createStore,
  isIndeterminateCommit,
  markIndeterminateCommit,
} from "../apps/server/src/db.ts";
import { reportBackgroundFailure } from "../apps/server/src/log.ts";

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

// --- B1 fix round 7 (panel re-review #6, chunk B, Nov 19, 2026) --------------
// Mock-level pg transaction tests for the failed-ROLLBACK discard
// (B-1, round 7). No live PostgreSQL exists in this environment, so
// the timeout sequence itself is mock-level: the fake pool's client
// fails its work query (client-side timeout shape) and fails its
// ROLLBACK too. What is asserted for real is the discard mechanism —
// release called exactly once WITH an error (pg-pool destroys a
// client released with an error instead of returning it to the idle
// pool, verified against installed pg-pool 3.14.0 _release) — and
// that the original error is preserved, never masked by the rollback
// failure.

interface FakePgClient {
  queries: string[];
  releases: Array<Error | undefined>;
  failWorkWith: Error | null;
  failRollbackWith: Error | null;
  /** Round 8: fail the BEGIN step. */
  failBeginWith?: Error | null;
  /** Round 8: fail the COMMIT step. */
  failCommitWith?: Error | null;
  /** Round 8: throw from release(). */
  failReleaseWith?: Error | null;
  /** Round 9 (B-2): reject the ROLLBACK with `undefined` itself. */
  failRollbackWithUndefined?: boolean;
}

function fakePgPool(client: FakePgClient) {
  const clients: FakePgClient[] = [];
  return {
    clients,
    pool: {
      query: async () => ({ rows: [] }),
      connect: async () => {
        clients.push(client);
        return {
          query: async (sql: string) => {
            client.queries.push(sql);
            if (sql === "BEGIN") {
              if (client.failBeginWith) throw client.failBeginWith;
              return { rows: [] };
            }
            if (sql === "COMMIT") {
              if (client.failCommitWith) throw client.failCommitWith;
              return { rows: [] };
            }
            if (sql === "ROLLBACK") {
              if (client.failRollbackWithUndefined) throw undefined;
              if (client.failRollbackWith) throw client.failRollbackWith;
              return { rows: [] };
            }
            if (client.failWorkWith) throw client.failWorkWith;
            return { rows: [] };
          },
          release: (error?: Error) => {
            client.releases.push(error);
            if (client.failReleaseWith) throw client.failReleaseWith;
          },
        };
      },
      end: async () => {},
    },
  };
}

test("B-1 (round 7): a failed ROLLBACK discards the pg client instead of returning it to the pool", async () => {
  const workError = new Error("query timed out");
  const rollbackError = new Error("ROLLBACK timed out");
  const client: FakePgClient = {
    queries: [],
    releases: [],
    failWorkWith: workError,
    failRollbackWith: rollbackError,
  };
  const { pool } = fakePgPool(client);
  const db = createPgDatabase(pool);
  // Capture console.error: the cleanup failure must be reported, not
  // swallowed (backgroundFailure logs phase + error name only).
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(
      args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
    );
  };
  try {
    await assert.rejects(
      db.transaction(async (query) => {
        await query("INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)");
        return "never";
      }),
      (error: unknown) => {
        // The ORIGINAL error is preserved — the rollback failure must
        // never mask it.
        assert.equal(error, workError);
        return true;
      },
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(client.queries, [
    "BEGIN",
    "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)",
    "ROLLBACK",
  ]);
  // Exactly one release, WITH an error: pg destroys a client released
  // with an error instead of returning it to the idle pool, so the
  // connection can never be reused mid-transaction by a later COMMIT.
  assert.equal(client.releases.length, 1);
  assert.equal(client.releases[0], rollbackError);
  assert.match(captured.join("\n"), /postgres rollback failed/);
});

test("B-1 (round 7): a successful ROLLBACK releases the pg client normally", async () => {
  // Control: the discard is specific to a FAILED rollback. Work fails,
  // ROLLBACK succeeds, the client goes back to the pool with a plain
  // release and the original error still propagates.
  const workError = new Error("audit write failed");
  const client: FakePgClient = {
    queries: [],
    releases: [],
    failWorkWith: workError,
    failRollbackWith: null,
  };
  const { pool } = fakePgPool(client);
  const db = createPgDatabase(pool);
  await assert.rejects(
    db.transaction(async (query) => {
      await query("INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)");
      return "never";
    }),
    (error: unknown) => {
      assert.equal(error, workError);
      return true;
    },
  );
  assert.equal(client.releases.length, 1);
  assert.equal(client.releases[0], undefined);
});

test("B-1 (round 7): a successful pg transaction releases the client exactly once", async () => {
  const client: FakePgClient = {
    queries: [],
    releases: [],
    failWorkWith: null,
    failRollbackWith: null,
  };
  const { pool } = fakePgPool(client);
  const db = createPgDatabase(pool);
  const result = await db.transaction(async (query) => {
    await query("INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)");
    return "committed";
  });
  assert.equal(result, "committed");
  assert.deepEqual(client.queries, [
    "BEGIN",
    "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)",
    "COMMIT",
  ]);
  assert.equal(client.releases.length, 1);
  assert.equal(client.releases[0], undefined);
});

// --- B1 fix round 8 (panel re-review #7, Nov 19, 2026) ----------------------
// B-1 cleanup hardening, mock-level (no live PostgreSQL in this env):
// release() and the cleanup logging are guarded, so neither can mask
// the original operation error; the indeterminate-COMMIT mark is
// non-mutating (WeakSet), so it works on frozen errors too.

test("B-1 (round 8): a BEGIN failure keeps the original error even when release throws", async () => {
  const beginError = new Error("BEGIN failed: connection reset");
  const releaseError = new Error("release failed");
  const client: FakePgClient = {
    queries: [],
    releases: [],
    failWorkWith: null,
    failRollbackWith: null,
    failBeginWith: beginError,
    failReleaseWith: releaseError,
  };
  const { pool } = fakePgPool(client);
  const db = createPgDatabase(pool);
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(
      args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
    );
  };
  try {
    await assert.rejects(
      db.transaction(async () => "never"),
      (error: unknown) => {
        // The ORIGINAL error is preserved — the throwing release must
        // never replace it.
        assert.equal(error, beginError);
        return true;
      },
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(client.queries, ["BEGIN", "ROLLBACK"]);
  // Exactly one release attempt, and the release failure was reported,
  // not propagated.
  assert.equal(client.releases.length, 1);
  assert.equal(client.releases[0], undefined);
  assert.match(captured.join("\n"), /postgres release failed/);
});

test("B-1 (round 8): a COMMIT failure keeps its indeterminate mark even when release throws", async () => {
  const commitError = new Error("COMMIT failed: connection lost");
  const releaseError = new Error("release failed");
  const client: FakePgClient = {
    queries: [],
    releases: [],
    failWorkWith: null,
    failRollbackWith: null,
    failCommitWith: commitError,
    failReleaseWith: releaseError,
  };
  const { pool } = fakePgPool(client);
  const db = createPgDatabase(pool);
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(
      args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
    );
  };
  try {
    await assert.rejects(
      db.transaction(async (query) => {
        await query("INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)");
        return "never";
      }),
      (error: unknown) => {
        assert.equal(error, commitError);
        // The mark survives the ROLLBACK attempt AND the throwing
        // release: callers can still tell the outcome is unknown,
        // not rolled back.
        assert.equal(isIndeterminateCommit(error), true);
        return true;
      },
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(client.queries, [
    "BEGIN",
    "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)",
    "COMMIT",
    "ROLLBACK",
  ]);
  assert.equal(client.releases.length, 1);
  assert.equal(client.releases[0], undefined);
  assert.match(captured.join("\n"), /postgres release failed/);
});

test("B-1 (round 8): a frozen COMMIT error still gets its indeterminate mark", async () => {
  // The round-7 marker assigned a symbol property on the error object,
  // which throws on a frozen/non-extensible error and would replace
  // the COMMIT error with the assignment failure. The round-8 marker
  // is a WeakSet add, which never mutates the object.
  const commitError = Object.freeze(new Error("COMMIT failed: connection lost"));
  const client: FakePgClient = {
    queries: [],
    releases: [],
    failWorkWith: null,
    failRollbackWith: null,
    failCommitWith: commitError,
  };
  const { pool } = fakePgPool(client);
  const db = createPgDatabase(pool);
  await assert.rejects(
    db.transaction(async (query) => {
      await query("INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)");
      return "never";
    }),
    (error: unknown) => {
      assert.equal(error, commitError);
      assert.equal(isIndeterminateCommit(error), true);
      return true;
    },
  );
  assert.equal(client.releases.length, 1);
});

test("B-1 (round 8): a throwing cleanup logger cannot mask the original error", async () => {
  // backgroundFailure is only console.error, but if the logger itself
  // throws (a broken console, a throwing transport), the rollback
  // reporting must not replace the work error — and the release must
  // still run.
  const workError = new Error("query timed out");
  const rollbackError = new Error("ROLLBACK timed out");
  const client: FakePgClient = {
    queries: [],
    releases: [],
    failWorkWith: workError,
    failRollbackWith: rollbackError,
  };
  const { pool } = fakePgPool(client);
  const db = createPgDatabase(pool);
  const originalError = console.error;
  console.error = () => {
    throw new Error("logger down");
  };
  try {
    await assert.rejects(
      db.transaction(async (query) => {
        await query("INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)");
        return "never";
      }),
      (error: unknown) => {
        assert.equal(error, workError);
        return true;
      },
    );
  } finally {
    console.error = originalError;
  }
  // The release still ran (with the discard error), despite the
  // logger throwing before it.
  assert.equal(client.releases.length, 1);
  assert.equal(client.releases[0], rollbackError);
});

test("B-1 (round 8): a release failure after a successful COMMIT does not fail the transaction", async () => {
  // The COMMIT succeeded; a throwing release must not turn a
  // committed transaction into a thrown error. The failure is
  // reported, and the committed result stands.
  const releaseError = new Error("release failed");
  const client: FakePgClient = {
    queries: [],
    releases: [],
    failWorkWith: null,
    failRollbackWith: null,
    failReleaseWith: releaseError,
  };
  const { pool } = fakePgPool(client);
  const db = createPgDatabase(pool);
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(
      args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
    );
  };
  try {
    const result = await db.transaction(async (query) => {
      await query("INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)");
      return "committed";
    });
    assert.equal(result, "committed");
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(client.queries, [
    "BEGIN",
    "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)",
    "COMMIT",
  ]);
  assert.equal(client.releases.length, 1);
  assert.equal(client.releases[0], undefined);
  assert.match(captured.join("\n"), /postgres release failed/);
});

test("B-1 (round 8): markIndeterminateCommit marks frozen and non-object errors without throwing", async () => {
  // Direct mechanism test (see db.ts): the WeakSet mark never mutates
  // the error, so frozen/non-extensible errors mark cleanly, and
  // non-objects pass through unmarked (as before).
  const frozen = Object.freeze(new Error("frozen"));
  assert.equal(markIndeterminateCommit(frozen), frozen);
  assert.equal(isIndeterminateCommit(frozen), true);
  const sealed = Object.preventExtensions(new Error("sealed"));
  assert.equal(markIndeterminateCommit(sealed), sealed);
  assert.equal(isIndeterminateCommit(sealed), true);
  const plain = new Error("plain");
  assert.equal(isIndeterminateCommit(plain), false);
  assert.equal(markIndeterminateCommit(plain), plain);
  assert.equal(isIndeterminateCommit(plain), true);
  assert.equal(markIndeterminateCommit("a string error"), "a string error");
  assert.equal(isIndeterminateCommit("a string error"), false);
});

// --- B1 fix round 9 (panel re-review #8, Nov 19, 2026) ----------------------
// B-1 shared non-throwing logging wrapper; B-2 undefined rollback rejection.

test("B-1 (round 9): reportBackgroundFailure never throws, even when the logger does", async () => {
  // The shared wrapper (log.ts) is what both db.ts and files.ts now
  // call for cleanup logging. With a throwing console, the wrapper
  // must return normally — the caller keeps its own error and control
  // flow — and with a working console it still reports the phase.
  const originalError = console.error;
  console.error = () => {
    throw new Error("logger down");
  };
  try {
    reportBackgroundFailure("test phase", new Error("boom"));
  } finally {
    console.error = originalError;
  }
  const captured: string[] = [];
  console.error = (...args: unknown[]) => {
    captured.push(
      args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
    );
  };
  try {
    reportBackgroundFailure("test phase", new Error("boom"));
  } finally {
    console.error = originalError;
  }
  assert.match(captured.join("\n"), /test phase/);
});

test("B-2 (round 9): a ROLLBACK rejecting with undefined still discards the pg client", async () => {
  // The old check read `rollbackError !== undefined`, so a query
  // rejecting with `undefined` took the plain release() path and
  // returned the client to the pool. The failure is now tracked with
  // a separate boolean: the client must be released WITH an error
  // (pg destroys it) and the original work error preserved.
  const workError = new Error("query timed out");
  const client: FakePgClient = {
    queries: [],
    releases: [],
    failWorkWith: workError,
    failRollbackWith: null,
    failRollbackWithUndefined: true,
  };
  const { pool } = fakePgPool(client);
  const db = createPgDatabase(pool);
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(
      args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
    );
  };
  try {
    await assert.rejects(
      db.transaction(async (query) => {
        await query("INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)");
        return "never";
      }),
      (error: unknown) => {
        assert.equal(error, workError);
        return true;
      },
    );
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(client.queries, [
    "BEGIN",
    "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb)",
    "ROLLBACK",
  ]);
  // Exactly one release, WITH an error — the client is discarded,
  // not returned to the pool.
  assert.equal(client.releases.length, 1);
  assert.ok(client.releases[0] instanceof Error);
  assert.match(captured.join("\n"), /postgres rollback failed/);
});
