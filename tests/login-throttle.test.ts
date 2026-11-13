// S-B3: sign-in is throttled per client address AND per account, so one bad
// actor hammering sign-in cannot lock every sign-in out the way the old
// single global counter did.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { createLoginThrottle } from "../apps/server/src/rate-limit.ts";

test("login throttle caps attempts per address and per account independently", () => {
  const throttle = createLoginThrottle();
  const now = 1_000_000;
  for (let i = 0; i < 30; i++)
    assert.equal(throttle.check("conn:1.2.3.4", "account:aaa", now), true);
  assert.equal(
    throttle.check("conn:1.2.3.4", "account:aaa", now),
    false,
    "31st attempt from the same address is throttled",
  );
  // A different address with a different account is unaffected.
  assert.equal(throttle.check("conn:5.6.7.8", "account:bbb", now), true);
  // The same account from many addresses is still capped per account.
  const accountThrottle = createLoginThrottle();
  for (let i = 0; i < 30; i++)
    assert.equal(accountThrottle.check(`conn:10.0.0.${i}`, "account:aaa", now), true);
  assert.equal(
    accountThrottle.check("conn:10.0.0.99", "account:aaa", now),
    false,
    "31st attempt against the same account is throttled",
  );
  // A fresh window admits attempts again.
  assert.equal(throttle.check("conn:1.2.3.4", "account:aaa", now + 60_000), true);
});

test("the session route throttles after 30 rapid sign-ins", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-login-throttle-"));
  const db = await createStore();
  t.after(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  const { app } = await createApp(db, config);
  const signIn = () =>
    app.request("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
  for (let i = 0; i < 30; i++) assert.equal((await signIn()).status, 200);
  const throttled = await signIn();
  assert.equal(throttled.status, 429);
  assert.match(await throttled.text(), /Too many sign-in attempts/);
});
