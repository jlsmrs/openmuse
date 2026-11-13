import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuth, readOrCreate } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";

function config(dataDir: string): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
  };
}

const sessionId = (token: string) => createHash("sha256").update(token).digest("hex");

// S-B4 item 1: signed URLs carry a per-owner generation that sign-out bumps,
// so links minted before a sign-out stop verifying even inside their
// 15-minute window.
test("signed URLs die with the session that minted them", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-auth-signing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = await createStore();
  t.after(() => db.close());
  const auth = await createAuth(db, config(directory));
  const before = auth.sign("owner-a", "/api/files/example/content");
  const otherOwner = auth.sign("owner-b", "/api/files/example/content");
  assert.equal(auth.verify(new URL(before)), "owner-a");
  assert.equal(auth.verify(new URL(otherOwner)), "owner-b");
  await db.put("system", "sessions", {
    id: sessionId("token-a"),
    owner: "owner-a",
    expiresAt: Date.now() + 3600_000,
  });
  await auth.revoke("Bearer token-a");
  assert.throws(() => auth.verify(new URL(before)), /expired/);
  // A fresh link mints under the new generation and verifies; the other
  // owner's links are untouched by this sign-out.
  assert.equal(auth.verify(new URL(auth.sign("owner-a", "/api/files/example/content"))), "owner-a");
  assert.equal(auth.verify(new URL(otherOwner)), "owner-b");
  // The bump is durable: a restarted Auth still rejects the pre-sign-out link.
  const restarted = await createAuth(db, config(directory));
  assert.throws(() => restarted.verify(new URL(before)), /expired/);
  assert.equal(
    restarted.verify(new URL(restarted.sign("owner-a", "/api/files/example/content"))),
    "owner-a",
  );
});

test("revoking an unknown token is a no-op and does not bump any generation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-auth-signing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = await createStore();
  t.after(() => db.close());
  const auth = await createAuth(db, config(directory));
  const url = auth.sign("owner-a", "/api/files/example/content");
  await auth.revoke("Bearer no-such-token");
  await auth.revoke(undefined);
  assert.equal(auth.verify(new URL(url)), "owner-a");
});

// S-B4 item 9: concurrent first-creates converge on one value instead of
// overwriting each other. The Azure-Files (ENOTSUP) branch itself cannot be
// triggered on a local filesystem, so it is verified by inspection.
test("concurrent readOrCreate calls share one value", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-read-or-create-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "key");
  const values = await Promise.all(
    Array.from({ length: 16 }, (_, i) => readOrCreate(path, () => `value-${i}`)),
  );
  assert.ok(values.every((value) => value === values[0]));
  assert.equal(await readFile(path, "utf8"), values[0]);
  // An existing file is returned as-is, never overwritten.
  await writeFile(join(directory, "pinned"), "pinned-value");
  assert.equal(await readOrCreate(join(directory, "pinned"), () => "other"), "pinned-value");
  assert.equal(await readFile(join(directory, "pinned"), "utf8"), "pinned-value");
});
