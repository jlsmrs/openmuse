import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Agent, fetch as undiciFetch } from "undici";
import { createBrowserManager } from "../src/browser.ts";
import { createWorkerServer } from "../src/server.ts";

// Test-only certificates, generated fresh per test with openssl (never
// committed, never production material). The server SAN is localhost +
// 127.0.0.1 because these tests connect over loopback; the production
// certificate carries DNS:openmuse-browser instead (docs/RENDER-WORKER-TLS.md).
async function writeTestCerts(
  directory: string,
): Promise<{ ca: string; cert: string; key: string }> {
  const run = (args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  run([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-days",
    "2",
    "-nodes",
    "-subj",
    "/CN=OpenMuse Test CA",
  ]);
  run([
    "req",
    "-newkey",
    "rsa:2048",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-nodes",
    "-subj",
    "/CN=localhost",
  ]);
  await writeFile(
    join(directory, "ext.cnf"),
    "[v3_req]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
  );
  run([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "server.crt",
    "-days",
    "2",
    "-extensions",
    "v3_req",
    "-extfile",
    "ext.cnf",
  ]);
  const [ca, cert, key] = await Promise.all([
    readFile(join(directory, "ca.crt"), "utf8"),
    readFile(join(directory, "server.crt"), "utf8"),
    readFile(join(directory, "server.key"), "utf8"),
  ]);
  return { ca, cert, key };
}

const token = randomBytes(32).toString("hex");
const stubProxy = async () => ({ url: "http://127.0.0.1:1", close: async () => {} });

async function startWorker(
  t: { after: (fn: () => Promise<void> | void) => void },
  tls: { cert: string; key: string } | undefined,
) {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-worker-tls-"));
  const worker = await createWorkerServer({ token, dataDir, tls }, (options) =>
    createBrowserManager(options, stubProxy),
  );
  worker.server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => worker.server.once("listening", resolve));
  const address = worker.server.address();
  assert(address && typeof address !== "string");
  t.after(async () => {
    await worker.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return address.port;
}

test("a TLS worker serves HTTPS verified by the test CA, and keeps token auth", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-worker-tls-certs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { ca, cert, key } = await writeTestCerts(directory);
  const port = await startWorker(t, { cert, key });
  const agent = new Agent({ connect: { ca } });
  t.after(() => agent.close());

  // /health stays unauthenticated, over TLS, when the CA verifies.
  // (undici's fetch: the global fetch's RequestInit type has no dispatcher.)
  const health = await undiciFetch(`https://localhost:${port}/health`, {
    dispatcher: agent,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  // Without the CA the handshake fails: verification stays on.
  await assert.rejects(
    fetch(`https://localhost:${port}/health`, { signal: AbortSignal.timeout(5000) }),
  );
  // With the wrong CA it fails too.
  const wrongDir = await mkdtemp(join(tmpdir(), "openmuse-worker-tls-ca2-"));
  t.after(() => rm(wrongDir, { recursive: true, force: true }));
  const wrong = await writeTestCerts(wrongDir);
  const wrongAgent = new Agent({ connect: { ca: wrong.ca } });
  t.after(() => wrongAgent.close());
  await assert.rejects(
    undiciFetch(`https://localhost:${port}/health`, {
      dispatcher: wrongAgent,
      signal: AbortSignal.timeout(5000),
    }),
  );
  // Plain HTTP to the TLS port fails.
  await assert.rejects(
    fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) }),
  );

  // Token auth is unchanged inside TLS: /sessions needs the Bearer token.
  const unauth = await undiciFetch(`https://localhost:${port}/sessions`, {
    dispatcher: agent,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(unauth.status, 401);
  const authed = await undiciFetch(`https://localhost:${port}/sessions`, {
    dispatcher: agent,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(authed.status, 200);
  assert.deepEqual(await authed.json(), []);
});

test("a worker without TLS material serves plain HTTP exactly as before", async (t) => {
  const port = await startWorker(t, undefined);
  const health = await fetch(`http://127.0.0.1:${port}/health`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
});

test("a worker with a mismatched certificate and key fails fast", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-worker-tls-certs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { cert } = await writeTestCerts(directory);
  const otherDir = await mkdtemp(join(tmpdir(), "openmuse-worker-tls-ca2-"));
  t.after(() => rm(otherDir, { recursive: true, force: true }));
  const other = await writeTestCerts(otherDir);
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-worker-tls-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await assert.rejects(
    createWorkerServer({ token, dataDir, tls: { cert, key: other.key } }, (options) =>
      createBrowserManager(options, stubProxy),
    ),
    /matching certificate\/key pair/,
  );
});
