import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWorkerServer } from "../src/server.ts";

test("the worker HTTP request timeout exceeds the worst-case create chain", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-worker-timeout-"));
  const worker = await createWorkerServer({ token: "x".repeat(32), dataDir });
  t.after(async () => {
    await worker.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  // One POST /sessions request can chain a context launch (25 s timeout)
  // and an initial navigation (20 s goto) plus validation — 45 s+ on a
  // slow first launch. The server must not drop the client mid-chain.
  assert.ok(
    worker.server.requestTimeout > 45_000,
    `requestTimeout is ${worker.server.requestTimeout} ms`,
  );
});
