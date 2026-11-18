import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
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

// A fake worker serving one fixture PDF as the session's only download,
// then POST /api/browsers/:id/import-downloads through the real app
// (so files.import runs end to end and PdfError meets the onError map).
async function postImport(t: TestContext, fixtureName: string, downloadName: string) {
  const bytes = await readFile(new URL(`./fixtures/${fixtureName}`, import.meta.url));
  const server = createServer((request, response) => {
    if (request.url === `/sessions/${sessionId}/downloads`) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          downloads: [
            {
              id: downloadId,
              name: downloadName,
              size: bytes.length,
              mimeType: "application/pdf",
            },
          ],
          failures: [],
        }),
      );
    } else if (request.url === `/sessions/${sessionId}/downloads/${downloadId}`) {
      response.writeHead(200, { "content-type": "application/pdf" });
      response.end(bytes);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pdf-import-"));
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
  const { app, auth, agent } = await createApp(db, config);
  t.after(async () => {
    agent.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { token } = await auth.session();
  await db.put("local-user", "browsers", savedSession);
  const response = await app.request(`/api/browsers/${sessionId}/import-downloads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    app,
    token,
  };
}

test("import-downloads succeeds for the incident PDF (encrypted, empty password)", async (t) => {
  const { status, body } = await postImport(t, "pdf-test.pdf", "pdf-test.pdf");
  assert.equal(status, 200);
  assert.deepEqual(body.failures, []);
  const files = body.files as { name: string; mimeType: string; pageCount: number }[];
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "pdf-test.pdf");
  assert.equal(files[0].mimeType, "application/pdf");
  assert.equal(files[0].pageCount, 1);
});

test("import-downloads succeeds for the unencrypted linearized + ObjStm control", async (t) => {
  const { status, body } = await postImport(t, "pdf-test-decrypted.pdf", "pdf-test-decrypted.pdf");
  assert.equal(status, 200);
  const files = body.files as { name: string; pageCount: number }[];
  assert.equal(files.length, 1);
  assert.equal(files[0].pageCount, 1);
});

test("import-downloads returns a typed 422, not a generic 502, for a password-protected PDF", async (t) => {
  const { status, body } = await postImport(t, "pdf-password.pdf", "pdf-password.pdf");
  assert.equal(status, 422);
  assert.equal(body.error, "This PDF is password-protected");
});

test("import-downloads returns a typed 422 for a genuinely malformed PDF", async (t) => {
  const { status, body } = await postImport(t, "malformed.pdf", "malformed.pdf");
  assert.equal(status, 422);
  assert.equal(body.error, "Invalid or malformed PDF");
});

test("the stored bytes of an imported encrypted PDF are the original bytes", async (t) => {
  // Files.import stores what it was handed, not the decrypted rebuild:
  // the decryptor's output is only ever used for inspection. A stored
  // copy that differed from the download would be a silent rewrite.
  const { status, body, app, token } = await postImport(t, "pdf-test.pdf", "pdf-test.pdf");
  assert.equal(status, 200);
  const files = body.files as { id: string }[];
  assert.equal(files.length, 1);
  const stored = await app.request(`/api/files/${files[0].id}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(stored.status, 200);
  const original = await readFile(new URL("./fixtures/pdf-test.pdf", import.meta.url));
  assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), new Uint8Array(original));
});

test("filling an imported PDF with an unknown field returns a typed 422, not a 502", async (t) => {
  // The PdfError -> 422 map covers every PDF operation, including fill:
  // before F1, this came back as a generic 502 because PdfError was not
  // mapped in onError at all.
  const { status, body, app, token } = await postImport(t, "pdf-test.pdf", "pdf-test.pdf");
  assert.equal(status, 200);
  const files = body.files as { id: string }[];
  assert.equal(files.length, 1);
  const filled = await app.request(`/api/files/${files[0].id}/fill`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { missing: "value" } }),
  });
  assert.equal(filled.status, 422);
  const filledBody = (await filled.json()) as Record<string, unknown>;
  assert.match(String(filledBody.error), /unknown.*missing/i);
});

test("PdfError logging carries only the parser byte offset, never message text", async (t) => {
  // F6: the log line must never carry file bytes or token-bearing content.
  // The malformed import's parser cause is "Trying to parse invalid object"
  // at offset 7353; the log must carry the offset, not the message.
  const lines: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const { status, body } = await postImport(t, "malformed.pdf", "malformed.pdf");
    assert.equal(status, 422);
    assert.equal(body.error, "Invalid or malformed PDF");
  } finally {
    console.error = originalError;
  }
  const pdfLines = lines.filter((line) => line.includes("PdfError"));
  assert.equal(pdfLines.length, 1);
  assert.match(pdfLines[0], /^\[OpenMuse\] PdfError: Error offset=\d+$/);
  assert.equal(pdfLines[0].includes("Trying to parse invalid object"), false);
});
