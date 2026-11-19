import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { WorkspaceService } from "../apps/server/src/workspace.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";

function liveConfig(key: string): Config {
  return {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: "unused",
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    googleClientId: "synthetic-client",
    googleClientSecret: "synthetic-secret",
    allowedOrigins: [],
    encryptionKey: key,
  };
}

async function seedGoogle(db: Store, key: string, tokens: Record<string, unknown>) {
  await db.put("owner", "credentials", {
    id: "google",
    connectionId: tokens.connectionId,
    secret: encryptSecret(JSON.stringify(tokens), key),
  });
}

function workspaceFor(db: Store, config: Config) {
  return new WorkspaceService(
    db,
    config,
    new Files(db, config, { sign: () => "sig" } as never),
    new GoogleAuth(db, config),
  );
}

test("snapshot succeeds with a dead Google refresh token and reports Google disconnected", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const key = randomBytes(32).toString("base64");
  const config = liveConfig(key);
  await seedGoogle(db, key, {
    connectionId: "connection-1",
    accessToken: "expired-access-token",
    refreshToken: "dead-refresh-token",
    expiresAt: 0,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    account: "owner@example.com",
  });
  // Google rejects the refresh: the token endpoint answers invalid_grant.
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "invalid_grant" }, { status: 400 }),
  );
  const workspace = workspaceFor(db, config);
  const snapshot = await workspace.snapshot("owner");
  assert.deepEqual(snapshot.mail, []);
  assert.deepEqual(snapshot.events, []);
  assert.deepEqual(snapshot.files, []);
  assert.deepEqual(snapshot.browsers, []);
  assert.equal(snapshot.connections.find((c) => c.id === "google")?.status, "disconnected");
});

test("snapshot succeeds when the stored Google tokens have no refresh token", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const key = randomBytes(32).toString("base64");
  const config = liveConfig(key);
  await seedGoogle(db, key, {
    connectionId: "connection-1",
    accessToken: "expired-access-token",
    expiresAt: 0,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    account: "owner@example.com",
  });
  // The refresh throws before any network call when there is no refresh token.
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("fetch must not be called without a refresh token");
  });
  const workspace = workspaceFor(db, config);
  const snapshot = await workspace.snapshot("owner");
  assert.deepEqual(snapshot.mail, []);
  assert.deepEqual(snapshot.events, []);
  assert.equal(snapshot.connections.find((c) => c.id === "google")?.status, "disconnected");
});

test("snapshot still throws when the Google token refresh fails on a transport error", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const key = randomBytes(32).toString("base64");
  const config = liveConfig(key);
  await seedGoogle(db, key, {
    connectionId: "connection-1",
    accessToken: "expired-access-token",
    refreshToken: "dead-refresh-token",
    expiresAt: 0,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    account: "owner@example.com",
  });
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("network down");
  });
  const workspace = workspaceFor(db, config);
  await assert.rejects(workspace.snapshot("owner"), /network down/);
});

test("snapshot still throws when Gmail rejects a valid access token", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const key = randomBytes(32).toString("base64");
  const config = liveConfig(key);
  await seedGoogle(db, key, {
    connectionId: "connection-1",
    accessToken: "valid-access-token",
    refreshToken: "unused-refresh-token",
    expiresAt: Date.now() + 3600000,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    account: "owner@example.com",
  });
  // A 400 is not retried: the Gmail/Calendar reads fail at once.
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: { message: "Bad request" } }, { status: 400 }),
  );
  const workspace = workspaceFor(db, config);
  await assert.rejects(workspace.snapshot("owner"), /Google API \(400\)/);
});

test("direct calendar and mail reads still surface the expired Google session", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const key = randomBytes(32).toString("base64");
  const config = liveConfig(key);
  await seedGoogle(db, key, {
    connectionId: "connection-1",
    accessToken: "expired-access-token",
    refreshToken: "dead-refresh-token",
    expiresAt: 0,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    account: "owner@example.com",
  });
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "invalid_grant" }, { status: 400 }),
  );
  const workspace = workspaceFor(db, config);
  await assert.rejects(workspace.calendars("owner"), /Google session expired/);
  await assert.rejects(workspace.events("owner"), /Google session expired/);
});
