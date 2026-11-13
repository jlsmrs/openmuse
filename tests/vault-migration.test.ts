import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createStore } from "../apps/server/src/db.ts";
import type { CredentialRecord } from "../apps/server/src/vault-migration.ts";
import { migrateCredentials } from "../apps/server/src/vault-migration.ts";
import {
  decryptSecret,
  encryptSecret,
  encryptSecretV2,
  migrateSecretToV2,
} from "../packages/integrations/src/vault.ts";

const execFileAsync = promisify(execFile);

test("migrateSecretToV2 re-encrypts v1 records under the v2 envelope", () => {
  const key = randomBytes(32).toString("base64");
  const secret = "synthetic refresh token / café";
  const context = { owner: "owner-1", recordId: "google" };
  const v1 = encryptSecret(secret, key);
  const result = migrateSecretToV2(v1, key, context);
  assert.equal(result.status, "migrated");
  if (result.status !== "migrated") throw new Error("unreachable");
  assert.equal(result.ciphertext.split(".")[0], "v2");
  assert.notEqual(result.ciphertext, v1);
  assert.equal(decryptSecret(result.ciphertext, key, context), secret);
  // The migrated envelope is bound to its context like any v2 record.
  assert.throws(
    () => decryptSecret(result.ciphertext, key, { owner: "owner-2", recordId: "google" }),
    /authenticate|decrypt/i,
  );
});

test("migrateSecretToV2 leaves valid v2 records unchanged and reports the rest", () => {
  const key = randomBytes(32).toString("base64");
  const context = { owner: "owner-1", recordId: "google" };
  const v2 = encryptSecretV2("already new", key, context);
  const kept = migrateSecretToV2(v2, key, context);
  assert.deepEqual(kept, { status: "already-v2", ciphertext: v2 });
  // A v2 record sealed under another owner does not silently pass.
  const foreign = encryptSecretV2("not mine", key, { owner: "owner-2", recordId: "google" });
  assert.equal(migrateSecretToV2(foreign, key, context).status, "failed");
  // Corrupt v1, unrecognized envelopes, and a wrong key all fail cleanly.
  const parts = encryptSecret("legacy", key).split(".");
  parts[2] = Buffer.from("x".repeat(16)).toString("base64url");
  assert.equal(migrateSecretToV2(parts.join("."), key, context).status, "failed");
  assert.equal(migrateSecretToV2("plaintext-secret", key, context).status, "failed");
  assert.equal(migrateSecretToV2("", key, context).status, "failed");
  const otherKey = randomBytes(32).toString("base64");
  assert.equal(migrateSecretToV2(encryptSecret("legacy", key), otherKey, context).status, "failed");
  // An empty v1 plaintext migrates to an empty v2 plaintext.
  const empty = migrateSecretToV2(encryptSecret("", key), key, context);
  assert.equal(empty.status, "migrated");
  if (empty.status === "migrated") {
    assert.equal(decryptSecret(empty.ciphertext, key, context), "");
  }
});

async function seedStore() {
  const db = await createStore();
  const key = randomBytes(32).toString("base64");
  const tokens: Record<string, string> = {
    "owner-a": "token-a",
    "owner-b": "token-b",
    other: "token-other",
  };
  await db.put<CredentialRecord>("owner-a", "credentials", {
    id: "google",
    generation: "gen-a",
    connectionId: "conn-a",
    secret: encryptSecret(tokens["owner-a"], key),
  });
  await db.put<CredentialRecord>("owner-b", "credentials", {
    id: "google",
    generation: "gen-b",
    connectionId: "conn-b",
    secret: encryptSecretV2(tokens["owner-b"], key, { owner: "owner-b", recordId: "google" }),
  });
  await db.put<CredentialRecord>("owner-c", "credentials", {
    id: "google",
    generation: "gen-c",
    connectionId: null,
    secret: null,
  });
  const corrupt = encryptSecret("corrupt-me", key).split(".");
  corrupt[3] = Buffer.from("tampered").toString("base64url");
  await db.put<CredentialRecord>("owner-d", "credentials", {
    id: "google",
    generation: "gen-d",
    connectionId: "conn-d",
    secret: corrupt.join("."),
  });
  await db.put<CredentialRecord>("owner-e", "credentials", {
    id: "google",
    generation: "gen-e",
    connectionId: "conn-e",
    secret: "not-an-envelope",
  });
  await db.put<CredentialRecord>("other", "credentials", {
    id: "other",
    generation: "gen-other",
    connectionId: "conn-other",
    secret: encryptSecret(tokens.other, key),
  });
  return { db, key, tokens };
}

test("migrateCredentials migrates v1 rows, skips v2 and empty rows, leaves failures untouched", async (t) => {
  const { db, key, tokens } = await seedStore();
  t.after(() => db.close());
  const report = await migrateCredentials(db, key);
  assert.deepEqual(
    {
      examined: report.examined,
      migrated: report.migrated,
      alreadyV2: report.alreadyV2,
      empty: report.empty,
      failed: report.failed,
    },
    { examined: 6, migrated: 2, alreadyV2: 1, empty: 1, failed: 2 },
  );
  assert.deepEqual(report.failures.map((failure) => failure.owner).sort(), ["owner-d", "owner-e"]);
  // The migrated rows decrypt under v2 with their context, and nothing
  // else about the row changed.
  const a = await db.get<CredentialRecord>("owner-a", "credentials", "google");
  assert.ok(a?.secret?.startsWith("v2."));
  assert.equal(
    decryptSecret(a?.secret as string, key, { owner: "owner-a", recordId: "google" }),
    tokens["owner-a"],
  );
  assert.equal(a?.generation, "gen-a");
  assert.equal(a?.connectionId, "conn-a");
  const other = await db.get<CredentialRecord>("other", "credentials", "other");
  assert.ok(other?.secret?.startsWith("v2."));
  assert.equal(
    decryptSecret(other?.secret as string, key, { owner: "other", recordId: "other" }),
    tokens.other,
  );
  // The failed rows are byte-identical to what was seeded.
  const d = await db.get<CredentialRecord>("owner-d", "credentials", "google");
  assert.equal(d?.secret?.startsWith("v1."), true);
  const e = await db.get<CredentialRecord>("owner-e", "credentials", "google");
  assert.equal(e?.secret, "not-an-envelope");
  // A second run migrates nothing: the migration is idempotent.
  const second = await migrateCredentials(db, key);
  assert.equal(second.migrated, 0);
  assert.equal(second.alreadyV2, 3);
  assert.equal(second.failed, 2);
});

test("migrateCredentials dry-run reports but writes nothing", async (t) => {
  const { db, key } = await seedStore();
  t.after(() => db.close());
  const report = await migrateCredentials(db, key, { dryRun: true });
  assert.equal(report.migrated, 2);
  assert.equal(report.failed, 2);
  const a = await db.get<CredentialRecord>("owner-a", "credentials", "google");
  assert.equal(a?.secret?.startsWith("v1."), true);
});

const tsxBin = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const scriptPath = fileURLToPath(
  new URL("../apps/server/src/scripts/migrate-vault-v2.ts", import.meta.url),
);

async function seedDataDir() {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-vault-migrate-"));
  const db = await createStore({ dataDir: join(dataDir, "postgres") });
  const key = randomBytes(32).toString("base64");
  await db.put<CredentialRecord>("owner-a", "credentials", {
    id: "google",
    generation: "gen-a",
    connectionId: "conn-a",
    secret: encryptSecret("token-a", key),
  });
  await db.put<CredentialRecord>("owner-b", "credentials", {
    id: "google",
    generation: "gen-b",
    connectionId: "conn-b",
    secret: encryptSecretV2("token-b", key, { owner: "owner-b", recordId: "google" }),
  });
  await db.close();
  return { dataDir, key };
}

test("the migration script migrates a throwaway store and backs it up first", async (t) => {
  const { dataDir, key } = await seedDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const env = { ...process.env, TOKEN_ENCRYPTION_KEY: key };
  // A health URL that answers nothing: the API-down check passes.
  const dry = await execFileAsync(
    process.execPath,
    [
      tsxBin,
      scriptPath,
      "--data-dir",
      dataDir,
      "--api-health-url",
      "http://127.0.0.1:1/health",
      "--dry-run",
    ],
    { env },
  );
  assert.match(dry.stdout, /\[dry-run\] examined=2 migrated=1 already-v2=1 empty=0 failed=0/);
  assert.equal(
    (await readdir(dataDir)).filter((name) => name.startsWith("postgres-backup-")).length,
    0,
  );
  const run = await execFileAsync(
    process.execPath,
    [tsxBin, scriptPath, "--data-dir", dataDir, "--api-health-url", "http://127.0.0.1:1/health"],
    { env },
  );
  assert.match(run.stdout, /examined=2 migrated=1 already-v2=1 empty=0 failed=0/);
  assert.match(run.stdout, /backup: .*postgres-backup-/);
  const backups = (await readdir(dataDir)).filter((name) => name.startsWith("postgres-backup-"));
  assert.equal(backups.length, 1);
  // The migrated store still decrypts under v2 with context. Close it
  // explicitly before the next child run: two live PGlite backends on
  // the same data directory corrupt each other (see the script header).
  const db = await createStore({ dataDir: join(dataDir, "postgres") });
  const a = await db.get<CredentialRecord>("owner-a", "credentials", "google");
  assert.ok(a?.secret?.startsWith("v2."));
  assert.equal(
    decryptSecret(a?.secret as string, key, { owner: "owner-a", recordId: "google" }),
    "token-a",
  );
  await db.close();
  // A second run migrates nothing.
  const again = await execFileAsync(
    process.execPath,
    [tsxBin, scriptPath, "--data-dir", dataDir, "--api-health-url", "http://127.0.0.1:1/health"],
    { env },
  );
  assert.match(again.stdout, /examined=2 migrated=0 already-v2=2 empty=0 failed=0/);
});

test("the migration script refuses while the API answers healthy", async (t) => {
  const { dataDir, key } = await seedDataDir();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const env = { ...process.env, TOKEN_ENCRYPTION_KEY: key };
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [
        tsxBin,
        scriptPath,
        "--data-dir",
        dataDir,
        "--api-health-url",
        `http://127.0.0.1:${address.port}/api/health`,
      ],
      { env },
    ),
    /API is still up/,
  );
  // Nothing was written: no backup, and the v1 record is untouched.
  assert.equal(
    (await readdir(dataDir)).filter((name) => name.startsWith("postgres-backup-")).length,
    0,
  );
  const db = await createStore({ dataDir: join(dataDir, "postgres") });
  const a = await db.get<CredentialRecord>("owner-a", "credentials", "google");
  assert.equal(a?.secret?.startsWith("v1."), true);
  // Close explicitly: the t.after rm(dataDir) below must not delete the
  // directory out from under a still-open store.
  await db.close();
});
