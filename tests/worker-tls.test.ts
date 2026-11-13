import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import { BrowserService } from "../apps/server/src/browser.ts";
import { type Config, readConfig } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { workerFetchInit } from "../apps/server/src/worker-fetch.ts";
import { createBrowserManager } from "../apps/worker/src/browser.ts";
import { createWorkerServer } from "../apps/worker/src/server.ts";

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
): Promise<number> {
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

async function makeService(
  t: { after: (fn: () => Promise<void> | void) => void },
  workerUrl: string,
  workerTlsCa: string | undefined,
): Promise<BrowserService> {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-api-tls-"));
  const db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/auth/google/callback",
    allowedOrigins: [],
    workerUrl,
    workerToken: token,
    workerTlsCa,
  };
  const auth = new Auth(db, config, "test-signing-key");
  const service = new BrowserService(db, config, auth, new Files(db, config, auth));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return service;
}

test("workerFetchInit returns no dispatcher for plain-http workers", () => {
  assert.deepEqual(workerFetchInit("http://127.0.0.1:8790", undefined), {});
  assert.deepEqual(workerFetchInit("http://127.0.0.1:8790", "ignored-ca"), {});
  assert.deepEqual(workerFetchInit(undefined, undefined), {});
});

test("workerFetchInit returns a cached dispatcher for https with a CA", () => {
  const first = workerFetchInit(
    "https://openmuse-browser:8790",
    "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----",
  );
  assert(first.dispatcher, "expected a dispatcher for https with a CA");
  assert.equal(
    workerFetchInit(
      "https://openmuse-browser:8790",
      "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----",
    ).dispatcher,
    first.dispatcher,
  );
  assert.notEqual(
    workerFetchInit(
      "https://openmuse-browser:8790",
      "-----BEGIN CERTIFICATE-----\nBBB\n-----END CERTIFICATE-----",
    ).dispatcher,
    first.dispatcher,
  );
});

test("workerFetchInit throws for https without a CA", () => {
  assert.throws(() => workerFetchInit("https://openmuse-browser:8790", undefined), /WORKER_TLS_CA/);
  assert.throws(() => workerFetchInit("https://openmuse-browser:8790", "   "), /WORKER_TLS_CA/);
});

test("BrowserService reaches a TLS worker with the right CA, not with the wrong one", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-api-tls-certs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { ca, cert, key } = await writeTestCerts(directory);
  const port = await startWorker(t, { cert, key });

  const service = await makeService(t, `https://127.0.0.1:${port}`, ca);
  assert.equal(await service.reachable(), true);

  // The same fetch shape BrowserService.request() uses, for an
  // authenticated operation-path call: /diagnostics with the Bearer token.
  const diagnostics = await fetch(`https://127.0.0.1:${port}/diagnostics`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
    ...workerFetchInit(`https://127.0.0.1:${port}`, ca),
  });
  assert.equal(diagnostics.status, 200);
  assert.equal(((await diagnostics.json()) as { status: string }).status, "ok");

  const wrongDir = await mkdtemp(join(tmpdir(), "openmuse-api-tls-ca2-"));
  t.after(() => rm(wrongDir, { recursive: true, force: true }));
  const wrong = await writeTestCerts(wrongDir);
  const wrongService = await makeService(t, `https://127.0.0.1:${port}`, wrong.ca);
  assert.equal(await wrongService.reachable(), false);

  const noCaService = await makeService(t, `https://127.0.0.1:${port}`, undefined);
  assert.throws(() => noCaService.reachable(), /WORKER_TLS_CA/);
});

test("BrowserService reaches a plain-http worker with no CA (Azure behavior preserved)", async (t) => {
  const port = await startWorker(t, undefined);
  const service = await makeService(t, `http://127.0.0.1:${port}`, undefined);
  assert.equal(await service.reachable(), true);
});

test("readConfig refuses an https worker URL without a CA", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.AGENT_BACKEND = "sample";
  process.env.HOST = "127.0.0.1";
  process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
  process.env.BROWSER_WORKER_URL = "https://openmuse-browser:8790";
  delete process.env.WORKER_TLS_CA;
  assert.throws(() => readConfig(), /WORKER_TLS_CA/);
  process.env.WORKER_TLS_CA = "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----";
  assert.equal(
    readConfig().workerTlsCa,
    "-----BEGIN CERTIFICATE-----\ntest-ca\n-----END CERTIFICATE-----",
  );
});
