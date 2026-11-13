import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Files, MAX_FILE_BYTES } from "../apps/server/src/files.ts";
import type { BrowserSession } from "../packages/domain/src/index.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const downloadId = "00000000-0000-4000-8000-000000000002";
const savedSession: BrowserSession = {
  id: sessionId,
  title: "Saved page",
  url: "https://example.com/",
  status: "active",
  updatedAt: "2026-09-27T00:00:00.000Z",
};

async function startService(
  t: TestContext,
  handle: (
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ) => void | Promise<void>,
): Promise<{ db: Store; service: BrowserService }> {
  const server: Server = createServer((request, response) => {
    void Promise.resolve(handle(request, response)).catch(() => {
      if (!response.writableEnded) response.writeHead(500);
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-cap-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: [],
    workerUrl: `http://127.0.0.1:${address.port}`,
    workerToken: "test-worker-token-at-least-32-characters",
  };
  const auth = new Auth(db, config, "test-signing-key");
  const service = new BrowserService(db, config, auth, new Files(db, config, auth));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  await db.put("owner", "browsers", savedSession);
  return { db, service };
}

function downloadsList(size: number) {
  return JSON.stringify({
    downloads: [{ id: downloadId, name: "file.bin", size, mimeType: "application/octet-stream" }],
    failures: [],
  });
}

test("a download whose listed size exceeds the cap is rejected without fetching the body", async (t) => {
  let bodyFetched = false;
  const { service } = await startService(t, (request, response) => {
    if (request.url === `/sessions/${sessionId}/downloads`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(downloadsList(MAX_FILE_BYTES + 1));
    } else if (request.url === `/sessions/${sessionId}/downloads/${downloadId}`) {
      bodyFetched = true;
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.alloc(16));
    } else {
      response.writeHead(404);
      response.end();
    }
  });

  await assert.rejects(
    () => service.imports("owner", sessionId),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Files must be 10 MB or smaller" &&
      (error as { status?: number }).status === 413,
  );
  assert.equal(bodyFetched, false, "the over-cap body must never be fetched");
});

test("a download whose body exceeds the cap is rejected mid-stream without buffering it all", async (t) => {
  // The body claims to be small but actually runs to 100 MB. The server
  // writes 64 KiB chunks and stops when the client goes away, tracking how
  // much it managed to send: the old arrayBuffer() read would have pulled
  // the whole 100 MB before files.import rejected it.
  const claimedBodyBytes = 100 * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  let bytesSent = 0;
  let bodyServed = false;
  const { service } = await startService(t, async (request, response) => {
    if (request.url === `/sessions/${sessionId}/downloads`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(downloadsList(1024));
    } else if (request.url === `/sessions/${sessionId}/downloads/${downloadId}`) {
      bodyServed = true;
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(claimedBodyBytes),
      });
      try {
        while (bytesSent < claimedBodyBytes) {
          if (!response.write(chunk)) await once(response, "drain");
          bytesSent += chunk.length;
        }
        response.end();
      } catch {
        // The client cancelled the stream once the cap was crossed.
      }
    } else {
      response.writeHead(404);
      response.end();
    }
  });

  await assert.rejects(
    () => service.imports("owner", sessionId),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Files must be 10 MB or smaller" &&
      (error as { status?: number }).status === 413,
  );
  assert.equal(bodyServed, true);
  assert.ok(
    bytesSent < 20 * 1024 * 1024,
    `the server should have sent only a little past the 10 MB cap, sent ${bytesSent} bytes of ${claimedBodyBytes}`,
  );
});

test("an in-cap download still imports", async (t) => {
  const body = Buffer.from("hello download", "utf8");
  const { db, service } = await startService(t, (request, response) => {
    if (request.url === `/sessions/${sessionId}/downloads`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(downloadsList(body.length));
    } else if (request.url === `/sessions/${sessionId}/downloads/${downloadId}`) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(body);
    } else {
      response.writeHead(404);
      response.end();
    }
  });

  const { files } = await service.imports("owner", sessionId);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "file.bin");
  assert.equal((await db.list("owner", "files")).length, 1);
});
