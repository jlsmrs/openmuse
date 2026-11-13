// S-B2: maintenance must only re-publish tasks whose row changed since the
// last tick. Re-publishing every task on every 60-second tick is wasted
// work; a fresh process still publishes everything once, which is the
// crash-recovery case the scan exists for.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { createStore } from "../apps/server/src/db.ts";
import type { AgentTask } from "../packages/domain/src/agent.ts";

test("maintenance publishes each task outcome once, then only changed rows", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-maintenance-watermark-"));
  const db = await createStore({ dataDir: join(directory, "db") });
  const server = await createApp(db, {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
  });
  const maintain = () => (server.agent as unknown as { maintain(): Promise<void> }).maintain();
  try {
    const owner = "watermark-owner";
    const task = await server.agent.createTask(owner, { prompt: "Finish the report" });
    // Move the task to a publishable outcome: a succeeded task notifies once.
    const succeeded = await db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      task.id,
      { status: task.status },
      { status: "succeeded", result: "Report finished", updatedAt: new Date().toISOString() },
    );
    assert.ok(succeeded);
    // Count notification writes: each publishOutcome for a succeeded task
    // attempts one insertIfAbsent into notifications.
    let notificationInserts = 0;
    const insertIfAbsent = db.insertIfAbsent.bind(db);
    t.mock.method(db, "insertIfAbsent", async (...args: Parameters<typeof insertIfAbsent>) => {
      if (args[1] === "notifications") notificationInserts++;
      return insertIfAbsent(...args);
    });
    await maintain();
    assert.equal(notificationInserts, 1);
    assert.equal((await db.list(owner, "notifications")).length, 1);
    // Second tick: nothing changed, nothing re-published.
    await maintain();
    assert.equal(notificationInserts, 1);
    assert.equal((await db.list(owner, "notifications")).length, 1);
    // A changed row re-publishes: fail the task, which moves updatedAt.
    const failed = await db.compareAndSwap<AgentTask>(
      owner,
      "tasks",
      task.id,
      { status: "succeeded" },
      {
        status: "failed",
        error: "Report failed",
        updatedAt: new Date(Date.now() + 1000).toISOString(),
      },
    );
    assert.ok(failed);
    await maintain();
    assert.equal(notificationInserts, 2);
    assert.equal((await db.list(owner, "notifications")).length, 2);
  } finally {
    await server.agent.stop();
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
