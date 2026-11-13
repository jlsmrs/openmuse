import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { GoogleAuth } from "../apps/server/src/google-auth.ts";
import { encryptSecret } from "../packages/integrations/src/vault.ts";

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise was not initialized");
  };
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function oauthConfig(): Config {
  return {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: "unused",
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    googleClientId: "synthetic-client",
    googleClientSecret: "synthetic-secret",
    encryptionKey: randomBytes(32).toString("base64"),
  };
}

test("old refresh cannot overwrite a newly connected Google account", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const key = randomBytes(32).toString("base64");
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: "unused",
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    encryptionKey: key,
  };
  const a = {
    connectionId: "connection-a",
    accessToken: "old-a",
    refreshToken: "refresh-a",
    expiresAt: 0,
    scopes: [],
    account: "a@example.com",
  };
  const b = {
    ...a,
    connectionId: "connection-b",
    accessToken: "new-b",
    account: "b@example.com",
    expiresAt: Date.now() + 3600000,
  };
  await db.put("owner", "credentials", {
    id: "google",
    connectionId: a.connectionId,
    secret: encryptSecret(JSON.stringify(a), key),
  });
  let release: ((response: Response) => void) | undefined;
  let started: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  t.mock.method(globalThis, "fetch", () => {
    started?.();
    return new Promise<Response>((resolve) => {
      release = resolve;
    });
  });
  const auth = new GoogleAuth(db, config);
  const refresh = auth.accessToken("owner", "connection-a");
  await requested;
  await db.put("owner", "credentials", {
    id: "google",
    connectionId: b.connectionId,
    secret: encryptSecret(JSON.stringify(b), key),
  });
  release?.(Response.json({ access_token: "refreshed-a", expires_in: 3600 }));
  await assert.rejects(refresh, /account changed/i);
  assert.equal((await auth.tokens("owner"))?.account, "b@example.com");
  await assert.rejects(auth.accessToken("owner", "connection-a"), /connection changed/i);
});

test("OAuth callbacks require a known, single-use state", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config: Config = {
    mode: "live",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: "unused",
    agentBackend: "model",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  };
  const auth = new GoogleAuth(db, config);
  await assert.rejects(auth.callback("unknown-state", "untrusted-code"), /expired/);
  await db.put("system", "oauth", {
    id: "expired",
    owner: "owner",
    verifier: "example",
    scopes: [],
    expiresAt: Date.now() - 1,
  });
  await assert.rejects(auth.callback("expired", "untrusted-code"), /expired/);
  assert.equal(await db.get("system", "oauth", "expired"), null);
});

for (const stage of ["token", "profile"]) {
  test(`disconnect invalidates an OAuth callback suspended during ${stage}`, async (t) => {
    const db = await createStore();
    t.after(() => db.close());
    const auth = new GoogleAuth(db, oauthConfig());
    const { url } = await auth.connect("callback-race", true);
    const state = new URL(url).searchParams.get("state");
    assert.ok(state);
    const started = deferred<void>();
    const release = deferred<void>();
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
      const isToken = String(input).includes("/token");
      if (isToken === (stage === "token")) {
        started.resolve();
        await release.promise;
      }
      return Response.json(
        isToken
          ? { access_token: "callback-access", refresh_token: "callback-refresh", expires_in: 3600 }
          : { emailAddress: "callback@example.com" },
      );
    });
    const callback = auth.callback(state, "synthetic-code");
    await started.promise;
    await auth.disconnect("callback-race");
    release.resolve();
    await assert.rejects(callback, /disconnect|expired|changed/i);
    assert.equal(await auth.tokens("callback-race"), null);
  });
}

test("disconnect invalidates pending OAuth state before a callback contacts Google", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const auth = new GoogleAuth(db, oauthConfig());
  const { url } = await auth.connect("pending-owner", false);
  const state = new URL(url).searchParams.get("state");
  assert.ok(state);
  await auth.disconnect("pending-owner");
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    calls++;
    return Response.json(
      String(input).includes("/token")
        ? { access_token: "unused", expires_in: 3600 }
        : { emailAddress: "unused@example.com" },
    );
  });
  await assert.rejects(auth.callback(state, "synthetic-code"), /disconnect|expired|changed/i);
  assert.equal(calls, 0);
});

test("a newer connect attempt invalidates an older callback already exchanging its code", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const auth = new GoogleAuth(db, oauthConfig());
  const first = new URL((await auth.connect("reconnect-owner", false)).url).searchParams.get(
    "state",
  );
  assert.ok(first);
  const started = deferred<void>();
  const release = deferred<void>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes("/token")) {
      const old = new URLSearchParams(String(init?.body)).get("code") === "old-code";
      if (old) {
        started.resolve();
        await release.promise;
      }
      return Response.json({ access_token: old ? "old-access" : "new-access", expires_in: 3600 });
    }
    return Response.json({ emailAddress: "new@example.com" });
  });
  const oldCallback = auth.callback(first, "old-code");
  await started.promise;
  const second = new URL((await auth.connect("reconnect-owner", true)).url).searchParams.get(
    "state",
  );
  assert.ok(second);
  await auth.callback(second, "new-code");
  release.resolve();
  await assert.rejects(oldCallback, /disconnect|expired|changed/i);
  assert.equal((await auth.tokens("reconnect-owner"))?.accessToken, "new-access");
});

test("an in-flight refresh cannot restore credentials after disconnect", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = oauthConfig();
  assert.ok(config.encryptionKey);
  await db.put("refresh-disconnect", "credentials", {
    id: "google",
    connectionId: "old-connection",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "old-connection",
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 0,
        scopes: [],
        account: "me@example.com",
      }),
      config.encryptionKey,
    ),
  });
  const started = deferred<void>();
  const release = deferred<void>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("/revoke")) return new Response(null, { status: 200 });
    started.resolve();
    await release.promise;
    return Response.json({ access_token: "refreshed", expires_in: 3600 });
  });
  const auth = new GoogleAuth(db, config);
  const refresh = auth.accessToken("refresh-disconnect");
  await started.promise;
  await auth.disconnect("refresh-disconnect");
  release.resolve();
  await assert.rejects(refresh, /disconnected/i);
  assert.equal(await auth.tokens("refresh-disconnect"), null);
});

test("a rotated refresh token survives a second refresh", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const key = randomBytes(32).toString("base64");
  const config: Config = { ...oauthConfig(), encryptionKey: key };
  const seed = async (tokens: Record<string, unknown>) => {
    await db.put("owner", "credentials", {
      id: "google",
      connectionId: tokens.connectionId,
      secret: encryptSecret(JSON.stringify(tokens), key),
    });
  };
  await seed({
    connectionId: "connection-1",
    accessToken: "old-access",
    refreshToken: "old-refresh",
    expiresAt: 0,
    scopes: [],
    account: "owner@example.com",
  });
  const auth = new GoogleAuth(db, config);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    // First refresh rotates the refresh token; the second returns none.
    return calls === 1
      ? Response.json({ access_token: "access-1", refresh_token: "new-refresh", expires_in: 3600 })
      : Response.json({ access_token: "access-2", expires_in: 3600 });
  });
  assert.equal(await auth.accessToken("owner"), "access-1");
  assert.equal((await auth.tokens("owner"))?.refreshToken, "new-refresh");
  // Expire the stored tokens again so the next call refreshes a second time.
  const stored = await auth.tokens("owner");
  assert.ok(stored);
  await seed({ ...stored, expiresAt: 0 });
  assert.equal(await auth.accessToken("owner"), "access-2");
  assert.equal(
    (await auth.tokens("owner"))?.refreshToken,
    "new-refresh",
    "the rotated token survives a refresh that returns none",
  );
});

// S-B4 item 2: revocation is attempted before the credential is cleared, so
// a failed revocation keeps the grant and can be retried instead of leaving
// Google holding a grant we can no longer revoke.
test("a failed Google revocation keeps the credential so disconnect can be retried", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = oauthConfig();
  const key = config.encryptionKey;
  assert.ok(key);
  await db.put("revoke-owner", "credentials", {
    id: "google",
    connectionId: "connection-1",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "connection-1",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: Date.now() + 3600_000,
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        account: "me@example.com",
      }),
      key,
    ),
  });
  const auth = new GoogleAuth(db, config);
  let revokeStatus = 500;
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: revokeStatus }));
  await assert.rejects(auth.disconnect("revoke-owner"), /revocation failed/);
  assert.notEqual(await auth.tokens("revoke-owner"), null);
  revokeStatus = 200;
  await auth.disconnect("revoke-owner");
  assert.equal(await auth.tokens("revoke-owner"), null);
});

// S-B4 item 3: reconnecting unions previously granted scopes into the new
// request, unless the caller asks for a scope reset.
test("reconnect unions previously granted scopes unless reset", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const config = oauthConfig();
  const key = config.encryptionKey;
  assert.ok(key);
  const driveScope = "https://www.googleapis.com/auth/drive.readonly";
  await db.put("scope-owner", "credentials", {
    id: "google",
    connectionId: "connection-1",
    secret: encryptSecret(
      JSON.stringify({
        connectionId: "connection-1",
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: Date.now() + 3600_000,
        scopes: [driveScope],
        account: "me@example.com",
      }),
      key,
    ),
  });
  const auth = new GoogleAuth(db, config);
  const kept =
    new URL((await auth.connect("scope-owner", false)).url).searchParams.get("scope") ?? "";
  assert.ok(kept.split(" ").includes(driveScope));
  const reset =
    new URL((await auth.connect("scope-owner", false, { resetScopes: true })).url).searchParams.get(
      "scope",
    ) ?? "";
  assert.ok(!reset.split(" ").includes(driveScope));
  assert.ok(reset.split(" ").includes("https://www.googleapis.com/auth/gmail.readonly"));
});

// S-B4 item 4: when Google omits the scope field, the stored scopes are
// what Google returned (none) — not the requested scopes — and the grant is
// marked uncertain.
test("a callback without a scope field stores no scopes and marks the grant uncertain", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const auth = new GoogleAuth(db, oauthConfig());
  const { url } = await auth.connect("scope-uncertain", true);
  const state = new URL(url).searchParams.get("state");
  assert.ok(state);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("/token"))
      return Response.json({ access_token: "token-access", expires_in: 3600 });
    return Response.json({ emailAddress: "me@example.com" });
  });
  await auth.callback(state, "synthetic-code");
  const tokens = await auth.tokens("scope-uncertain");
  assert.deepEqual(tokens?.scopes, []);
  assert.equal(tokens?.scopesUncertain, true);
});

test("a callback with a scope field stores exactly the returned scopes", async (t) => {
  const db = await createStore();
  t.after(() => db.close());
  const auth = new GoogleAuth(db, oauthConfig());
  const { url } = await auth.connect("scope-certain", true);
  const state = new URL(url).searchParams.get("state");
  assert.ok(state);
  const returned = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("/token"))
      return Response.json({
        access_token: "token-access",
        expires_in: 3600,
        scope: returned.join(" "),
      });
    return Response.json({ emailAddress: "me@example.com" });
  });
  await auth.callback(state, "synthetic-code");
  const tokens = await auth.tokens("scope-certain");
  assert.deepEqual(tokens?.scopes, returned);
  assert.equal(tokens?.scopesUncertain, false);
});
