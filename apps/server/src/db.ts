import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { backgroundFailure } from "./log.ts";

type Row = { data: Record<string, unknown> };

/**
 * A promise-chain mutex: each holder runs alone, in call order. Used to
 * serialize every operation on the embedded PGlite connection (see
 * createStore): PGlite is a single connection, and a plain query issued
 * while a transaction is open on that connection joins the open
 * transaction — it can be committed by another transaction's COMMIT or
 * rolled back by its ROLLBACK. The mutex keeps a whole transaction
 * (including its awaits) and every ordinary query mutually exclusive, so
 * neither can leak into the other.
 */
function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = tail;
    tail = previous.then(() => gate);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

interface Database {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Row[] }>;
  /**
   * Run `fn` inside one database transaction: every query `fn` issues
   * commits together or rolls back together. The pg implementation
   * checks a single client out of the pool for the whole transaction
   * (pool.query would not be atomic — BEGIN and the writes could land on
   * different clients). The PGlite implementation uses PGlite's
   * transaction API with its transaction-scoped query handle, and the
   * whole transaction is additionally serialized against ALL other
   * access to the embedded connection (see createMutex): sequential
   * BEGIN/COMMIT on the single connection is NOT atomic under async
   * callbacks — an await inside one transaction lets another
   * transaction's queries interleave, and a plain query issued
   * mid-transaction joins the open transaction. A nested call just
   * joins the ambient transaction.
   *
   * A failure in the COMMIT step is marked indeterminate (B-1, round
   * 6): the COMMIT may have completed server-side before the
   * connection broke, so the outcome is unknown, not a rollback —
   * see markIndeterminateCommit / isIndeterminateCommit.
   */
  transaction: <T>(fn: (query: Database["query"]) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
}

/**
 * Indeterminate COMMIT marker (B-1, round 6): a transaction whose
 * COMMIT step failed may or may not have committed server-side — a
 * lost acknowledgement is indistinguishable from a rollback from the
 * client's seat. The pg transaction marks such failures with this
 * symbol so callers that do destructive cleanup on failure
 * (Files.pull deleting the bytes file) can tell "outcome unknown"
 * from "rolled back". The marker is advisory, not sufficient on its
 * own: callers must ALSO treat any failure after their work callback
 * completed as indeterminate, because a wrapper (or a later step) can
 * throw after a successful commit — which no backend marker can see.
 */
const INDETERMINATE_COMMIT = Symbol("indeterminate-commit");
export function markIndeterminateCommit(error: unknown): unknown {
  if (typeof error === "object" && error !== null) {
    (error as Record<symbol, boolean>)[INDETERMINATE_COMMIT] = true;
  }
  return error;
}
export function isIndeterminateCommit(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<symbol, unknown>)[INDETERMINATE_COMMIT] === true
  );
}

export class Store {
  constructor(private readonly db: Database) {}
  /**
   * Run `work` with a transactional view of this store: every put/remove
   * inside `work` commits together or rolls back together. Used by
   * Files.pull so the artifact copy and its audit entry are one unit —
   * a failed audit write can never leave a visible, unaudited copy.
   */
  async transaction<T>(work: (tx: Store) => Promise<T>): Promise<T> {
    return this.db.transaction(async (query) => {
      const txDatabase: Database = {
        query,
        // Already inside a transaction: join it.
        transaction: (fn) => fn(query),
        close: async () => {},
      };
      return work(new Store(txDatabase));
    });
  }
  /** Liveness probe: true when the database answers, false otherwise. Never throws. */
  async ping(): Promise<boolean> {
    try {
      await this.db.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
  async get<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    id: string,
  ): Promise<T | null> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=$3",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async list<T = Record<string, unknown>>(owner: string, kind: string): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 ORDER BY updated_at DESC,id",
      [owner, kind],
    );
    return result.rows.map((row) => row.data as T);
  }
  async listByGoalId<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    goalId: string,
  ): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>'goalId'=$3 ORDER BY updated_at DESC,id",
      [owner, kind, goalId],
    );
    return result.rows.map((row) => row.data as T);
  }
  async listByTaskId<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    taskId: string,
  ): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>'taskId'=$3 ORDER BY updated_at DESC,id",
      [owner, kind, taskId],
    );
    return result.rows.map((row) => row.data as T);
  }
  /** Rows of one kind named by id, in the same order `list` returns them. */
  async listByIds<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    ids: readonly string[],
  ): Promise<T[]> {
    if (ids.length === 0) return [];
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND id=ANY($3) ORDER BY updated_at DESC,id",
      [owner, kind, [...ids]],
    );
    return result.rows.map((row) => row.data as T);
  }
  async listByStatus<T = Record<string, unknown>>(
    owner: string,
    kind: string,
    status: string,
  ): Promise<T[]> {
    const result = await this.db.query(
      "SELECT data FROM records WHERE owner=$1 AND kind=$2 AND data->>'status'=$3 ORDER BY updated_at DESC,id",
      [owner, kind, status],
    );
    return result.rows.map((row) => row.data as T);
  }
  async put<T extends { id: string }>(owner: string, kind: string, value: T): Promise<T> {
    await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now()",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return value;
  }
  /**
   * Guarded upsert (optimistic concurrency) for contested rows: inserts a
   * new row, or overwrites only when the existing row still equals `expected`
   * — the full row the caller read before editing. Returns null when the
   * guard refuses the overwrite, so the caller can report a 409 instead of
   * silently discarding another writer's change. Use it wherever a
   * read-modify-write on one row can race; plain put stays last-write-wins
   * for rows only one writer touches.
   */
  async putIfMatches<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
    expected: T,
  ): Promise<T | null> {
    const result = await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner,kind,id) DO UPDATE SET data=excluded.data,updated_at=now() WHERE records.data = $5::jsonb RETURNING data",
      [owner, kind, value.id, JSON.stringify(value), JSON.stringify(expected)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async remove(owner: string, kind: string, id: string): Promise<void> {
    await this.db.query("DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3", [
      owner,
      kind,
      id,
    ]);
  }
  async compareAndSwap<T>(
    owner: string,
    kind: string,
    id: string,
    expected: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<T | null> {
    const result = await this.db.query(
      "UPDATE records SET data=data || $5::jsonb,updated_at=now() WHERE owner=$1 AND kind=$2 AND id=$3 AND data @> $4::jsonb RETURNING data",
      [owner, kind, id, JSON.stringify(expected), JSON.stringify(patch)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  // Update only the selected checkbox against the current row, preserving concurrent
  // additions, renames, reordering and other milestones' completion state.
  async setMilestoneDone<T>(owner: string, goalId: string, milestoneId: string, done: boolean) {
    const result = await this.db.query(
      `UPDATE records SET data=jsonb_set(data, '{milestones}', (
        SELECT jsonb_agg(CASE WHEN item->>'id'=$3
          THEN item || jsonb_build_object('done', $4::boolean) ELSE item END ORDER BY ordinal)
        FROM jsonb_array_elements(data->'milestones') WITH ORDINALITY AS milestones(item, ordinal)
      )), updated_at=now()
      WHERE owner=$1 AND kind='goals' AND id=$2
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(data->'milestones') item WHERE item->>'id'=$3)
      RETURNING data`,
      [owner, goalId, milestoneId, done],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async insertIfAbsent<T extends { id: string }>(
    owner: string,
    kind: string,
    value: T,
  ): Promise<T | null> {
    const result = await this.db.query(
      "INSERT INTO records(owner,kind,id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING RETURNING data",
      [owner, kind, value.id, JSON.stringify(value)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async scan<T>(kind: string): Promise<{ owner: string; value: T }[]> {
    const result = await this.db.query(
      "SELECT jsonb_build_object('owner',owner,'value',data) AS data FROM records WHERE kind=$1 ORDER BY updated_at ASC",
      [kind],
    );
    return result.rows.map((row) => row.data as { owner: string; value: T });
  }
  async claim<T>(owner: string, id: string, status: string, now: string): Promise<T | null> {
    const result = await this.db.query(
      `UPDATE records AS action SET data=jsonb_set(data,'{status}',$4::jsonb),updated_at=now()
       WHERE owner=$1 AND kind='actions' AND id=$2 AND data->>'status'='awaiting_review'
       AND (data->>'expiresAt')::timestamptz>$3::timestamptz
       AND ($4::jsonb <> '"executing"'::jsonb OR data->>'taskId' IS NULL OR EXISTS (
         SELECT 1 FROM records task WHERE task.owner=action.owner AND task.kind='tasks'
         AND task.id=action.data->>'taskId' AND task.data->>'status' IN ('running','waiting_approval')
       )) RETURNING data`,
      [owner, id, now, JSON.stringify(status)],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  async recoverInterruptedActions(): Promise<void> {
    await this.db.query(
      `UPDATE records SET data=data || '{"status":"outcome_unknown","error":"Server restarted during execution. Check the provider before creating another action."}'::jsonb WHERE kind='actions' AND data->>'status'='executing'`,
    );
  }
  async take<T>(owner: string, kind: string, id: string): Promise<T | null> {
    const result = await this.db.query(
      "DELETE FROM records WHERE owner=$1 AND kind=$2 AND id=$3 RETURNING data",
      [owner, kind, id],
    );
    return (result.rows[0]?.data as T | undefined) ?? null;
  }
  close(): Promise<void> {
    return this.db.close();
  }
  async updateCredential(owner: string, connectionId: string, secret: string): Promise<boolean> {
    const result = await this.db.query(
      "UPDATE records SET data=jsonb_set(data,'{secret}',$3::jsonb),updated_at=now() WHERE owner=$1 AND kind='credentials' AND id='google' AND data->>'connectionId'=$2 RETURNING data",
      [owner, connectionId, JSON.stringify(secret)],
    );
    return result.rows.length === 1;
  }
}

/** Idle clients can be disconnected by a database restart; without a listener pg's `error` event crashes the process. */
export function createPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on("error", (error) => backgroundFailure("postgres pool", error));
  return pool;
}

export async function createStore(
  options: { dataDir?: string; databaseUrl?: string } = {},
): Promise<Store> {
  let database: Database;
  if (options.databaseUrl) {
    const pool = createPool(options.databaseUrl);
    database = {
      query: async (sql, params) => pool.query(sql, params),
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const result = await fn((sql, params) => client.query(sql, params));
          try {
            await client.query("COMMIT");
          } catch (commitError) {
            // The COMMIT may have completed server-side before the
            // connection broke: the outcome is indeterminate, not a
            // rollback. Mark it — the ROLLBACK attempt below is
            // connection hygiene only and cannot prove a rollback
            // happened, so the mark survives it.
            throw markIndeterminateCommit(commitError);
          }
          return result;
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  } else {
    if (options.dataDir) await mkdir(dirname(options.dataDir), { recursive: true, mode: 0o700 });
    const embedded = new PGlite(options.dataDir);
    await embedded.waitReady;
    // One lock for the whole embedded connection: a transaction callback
    // holds it from its first query to its commit/rollback, and every
    // ordinary query holds it for its single statement. The lock is held
    // only by the outermost operation — the transaction-scoped query
    // handle below never re-acquires it, so there is no re-entrancy.
    const exclusive = createMutex();
    database = {
      query: (sql, params) => exclusive(() => embedded.query<Row>(sql, params)),
      transaction: async (fn) =>
        exclusive(() =>
          embedded.transaction(async (tx) => fn((sql, params) => tx.query<Row>(sql, params))),
        ),
      close: () => embedded.close(),
    };
  }
  await database.query(
    "CREATE TABLE IF NOT EXISTS records(owner text NOT NULL,kind text NOT NULL,id text NOT NULL,data jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(owner,kind,id))",
  );
  // Expression indexes for the fields the list queries filter on — without
  // them every listByGoalId/listByTaskId/listByStatus call scans the table.
  await database.query(
    "CREATE INDEX IF NOT EXISTS records_goal_idx ON records(owner,kind,(data->>'goalId'))",
  );
  await database.query(
    "CREATE INDEX IF NOT EXISTS records_task_idx ON records(owner,kind,(data->>'taskId'))",
  );
  await database.query(
    "CREATE INDEX IF NOT EXISTS records_status_idx ON records(owner,kind,(data->>'status'))",
  );
  return new Store(database);
}
