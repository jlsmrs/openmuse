// Live Obscura test. Opt-in only: run with OBSCURA_TEST_LIVE=1 and
// OBSCURA_BIN pointing at an Obscura binary. Skipped everywhere else,
// including CI without a binary. Spawns a local Obscura server (token
// auth on, --allow-private-network for this VM's egress proxy) and drives
// a real session through the worker's Obscura mode.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createBrowserManager } from "../src/browser.ts";

const BIN = process.env.OBSCURA_BIN ?? "";
const LIVE = process.env.OBSCURA_TEST_LIVE === "1";
//
// The target is an IP literal: this VM's DNS resolver answers public
// hostnames with CGNAT addresses, which the worker correctly blocks, so
// a hostname target cannot pass URL validation here. In production the
// worker runs with normal DNS and hostnames work. The /cdn-cgi/trace
// path is chosen because it answers 200 with no redirect: the bare
// https://1.1.1.1/ 301s to https://one.one.one.one/, and the worker's
// post-navigation URL check would (correctly, on this VM) reject that
// hostname. The trace body is plain text, so the page title is empty.
const TARGET = "https://1.1.1.1/cdn-cgi/trace";

const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "utf8",
);

// Local origin for the download live tests. /report.pdf answers with an
// explicit content-length (native path); /stream.pdf answers chunked with
// no content-length (fallback path); /page is a plain page (negative
// control). Served as http://1.1.1.1/... through the forward proxy below,
// because the worker only accepts public URLs.
async function startOriginServer() {
  const origin = createHttpServer((req, res) => {
    if (req.url === "/report.pdf") {
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="report.pdf"',
        "content-length": PDF_BYTES.length,
      });
      res.end(PDF_BYTES);
    } else if (req.url === "/stream.pdf") {
      // No content-length: Node answers chunked, so the navigation
      // Response carries no length and the native path must defer to the
      // Chromium fallback.
      res.writeHead(200, {
        "content-type": "application/pdf",
        "content-disposition": 'attachment; filename="stream.pdf"',
      });
      res.end(PDF_BYTES);
    } else if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><head><title>Plain page</title></head><body>hello</body></html>");
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const port = (origin.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => origin.close(() => resolve())),
  };
}

async function startForwardProxyServer(originPort: number) {
  const proxy = createHttpServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (target.hostname !== "1.1.1.1") {
      res.writeHead(404);
      res.end();
      return;
    }
    const forwarded = httpRequest(
      {
        hostname: "127.0.0.1",
        port: originPort,
        path: target.pathname + target.search,
        method: req.method,
        headers: { ...req.headers, host: "1.1.1.1" },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    forwarded.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(forwarded);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => proxy.close(() => resolve())),
  };
}

async function startObscuraServer(proxyPort?: number) {
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OBSCURA_CDP_TOKEN: token,
    OBSCURA_ALLOW_PRIVATE_NETWORK: "1",
  };
  if (proxyPort !== undefined) {
    env.http_proxy = `http://127.0.0.1:${proxyPort}`;
    env.https_proxy = `http://127.0.0.1:${proxyPort}`;
    env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    env.no_proxy = "";
    env.NO_PROXY = "";
  }
  const server: ChildProcess = spawn(
    BIN,
    ["serve", "--port", String(port), "--host", "127.0.0.1", "--allow-private-network"],
    { env, stdio: "ignore" },
  );
  await waitForVersion(port, token);
  return {
    port,
    token,
    close: () => {
      server.kill("SIGTERM");
    },
  };
}

function setObscuraEnv(t: TestContext, port: number, token: string) {
  const savedUrl = process.env.OBSCURA_CDP_URL;
  const savedToken = process.env.OBSCURA_CDP_TOKEN;
  process.env.OBSCURA_CDP_URL = `ws://127.0.0.1:${port}/devtools/browser`;
  process.env.OBSCURA_CDP_TOKEN = token;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.OBSCURA_CDP_URL;
    else process.env.OBSCURA_CDP_URL = savedUrl;
    if (savedToken === undefined) delete process.env.OBSCURA_CDP_TOKEN;
    else process.env.OBSCURA_CDP_TOKEN = savedToken;
  });
}

test("Obscura mode captures a PDF navigation natively, with no download event", {
  timeout: 180_000,
  skip: !LIVE || !binaryAvailable(),
}, async (t) => {
  const { port: originPort, close: closeOrigin } = await startOriginServer();
  t.after(closeOrigin);
  const { port: proxyPort, close: closeProxy } = await startForwardProxyServer(originPort);
  t.after(closeProxy);
  const { port, token, close: closeObscura } = await startObscuraServer(proxyPort);
  t.after(closeObscura);
  setObscuraEnv(t, port, token);

  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-native-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let proxyCalls = 0;
  const createProxy = async () => {
    proxyCalls += 1;
    return { url: "http://127.0.0.1:1", close: async () => {} };
  };
  const browser = await createBrowserManager({ dataDir }, createProxy);
  try {
    const id = randomUUID();
    await browser.create(id, "http://1.1.1.1/report.pdf");
    const listed = await browser.downloads(id);
    assert.equal(listed.failures.length, 0, JSON.stringify(listed.failures));
    assert.equal(listed.downloads.length, 1);
    assert.equal(listed.downloads[0].name, "report.pdf");
    const stored = await browser.download(id, listed.downloads[0].id);
    assert.equal(stored.bytes.subarray(0, 5).toString(), "%PDF-");
    assert.equal(proxyCalls, 0, "the native path must not start the egress proxy");
    await browser.closeSession(id);
  } finally {
    await browser.close();
  }
});

test("engine=chromium downloads the same PDF via the download event", {
  timeout: 180_000,
  skip: !LIVE || !binaryAvailable(),
}, async (t) => {
  const { port: originPort, close: closeOrigin } = await startOriginServer();
  t.after(closeOrigin);
  const { port: proxyPort, close: closeProxy } = await startForwardProxyServer(originPort);
  t.after(closeProxy);

  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-engine-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let proxyCalls = 0;
  const createProxy = async () => {
    proxyCalls += 1;
    return { url: `http://127.0.0.1:${proxyPort}`, close: async () => {} };
  };
  // Obscura-configured manager with a dummy unreachable endpoint: the
  // Chromium session never connects to it, so the engine override is
  // exercised without an Obscura server.
  const savedUrl = process.env.OBSCURA_CDP_URL;
  const savedToken = process.env.OBSCURA_CDP_TOKEN;
  process.env.OBSCURA_CDP_URL = "ws://127.0.0.1:9/devtools/browser";
  process.env.OBSCURA_CDP_TOKEN = "secret-token";
  t.after(() => {
    if (savedUrl === undefined) delete process.env.OBSCURA_CDP_URL;
    else process.env.OBSCURA_CDP_URL = savedUrl;
    if (savedToken === undefined) delete process.env.OBSCURA_CDP_TOKEN;
    else process.env.OBSCURA_CDP_TOKEN = savedToken;
  });
  const browser = await createBrowserManager({ dataDir }, createProxy);
  try {
    const id = randomUUID();
    await browser.create(id, "http://1.1.1.1/report.pdf", "chromium");
    assert.equal(proxyCalls, 1, "the Chromium session starts the lazy proxy");
    // The event-path capture runs async in the download handler; poll
    // until it publishes or records a failure.
    const deadline = Date.now() + 30_000;
    let listed: Awaited<ReturnType<typeof browser.downloads>> | null = null;
    while (Date.now() <= deadline) {
      try {
        listed = await browser.downloads(id);
      } catch {
        // A store failure surfaces here; keep polling briefly, then report.
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      if (listed.downloads.length > 0 || listed.failures.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(listed, "the downloads listing never answered");
    assert.equal(listed.failures.length, 0, JSON.stringify(listed.failures));
    assert.equal(listed.downloads.length, 1);
    assert.equal(listed.downloads[0].name, "report.pdf");
    const stored = await browser.download(id, listed.downloads[0].id);
    assert.equal(stored.bytes.subarray(0, 5).toString(), "%PDF-");
    await browser.closeSession(id);
  } finally {
    await browser.close();
  }
});

test("Obscura mode leaves the downloads list empty for a non-download page", {
  timeout: 180_000,
  skip: !LIVE || !binaryAvailable(),
}, async (t) => {
  const { port: originPort, close: closeOrigin } = await startOriginServer();
  t.after(closeOrigin);
  const { port: proxyPort, close: closeProxy } = await startForwardProxyServer(originPort);
  t.after(closeProxy);
  const { port, token, close: closeObscura } = await startObscuraServer(proxyPort);
  t.after(closeObscura);
  setObscuraEnv(t, port, token);

  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-negative-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let proxyCalls = 0;
  const createProxy = async () => {
    proxyCalls += 1;
    return { url: "http://127.0.0.1:1", close: async () => {} };
  };
  const browser = await createBrowserManager({ dataDir }, createProxy);
  try {
    const id = randomUUID();
    await browser.create(id, "http://1.1.1.1/page");
    const listed = await browser.downloads(id);
    assert.deepEqual(listed.downloads, []);
    assert.deepEqual(listed.failures, []);
    assert.equal(proxyCalls, 0, "a non-download navigation must not start the proxy");
    await browser.closeSession(id);
  } finally {
    await browser.close();
  }
});

test("Obscura mode falls back to Chromium when content-length is absent", {
  timeout: 180_000,
  skip: !LIVE || !binaryAvailable(),
}, async (t) => {
  const { port: originPort, close: closeOrigin } = await startOriginServer();
  t.after(closeOrigin);
  const { port: proxyPort, close: closeProxy } = await startForwardProxyServer(originPort);
  t.after(closeProxy);
  const { port, token, close: closeObscura } = await startObscuraServer(proxyPort);
  t.after(closeObscura);
  setObscuraEnv(t, port, token);

  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-fallback-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let proxyCalls = 0;
  const createProxy = async () => {
    proxyCalls += 1;
    return { url: `http://127.0.0.1:${proxyPort}`, close: async () => {} };
  };
  const browser = await createBrowserManager({ dataDir }, createProxy);
  try {
    const id = randomUUID();
    await browser.create(id, "http://1.1.1.1/stream.pdf");
    const listed = await browser.downloads(id);
    assert.equal(listed.failures.length, 0, JSON.stringify(listed.failures));
    assert.equal(listed.downloads.length, 1);
    assert.equal(listed.downloads[0].name, "stream.pdf");
    const stored = await browser.download(id, listed.downloads[0].id);
    assert.equal(stored.bytes.subarray(0, 5).toString(), "%PDF-");
    assert.equal(proxyCalls, 1, "the fallback must start the lazy proxy exactly once");
    await browser.closeSession(id);
  } finally {
    await browser.close();
  }
});

test("Obscura mode refuses a 21st PDF (limit is 20, not 21)", {
  timeout: 180_000,
  skip: !LIVE || !binaryAvailable(),
}, async (t) => {
  const { port: originPort, close: closeOrigin } = await startOriginServer();
  t.after(closeOrigin);
  const { port: proxyPort, close: closeProxy } = await startForwardProxyServer(originPort);
  t.after(closeProxy);
  const { port, token, close: closeObscura } = await startObscuraServer(proxyPort);
  t.after(closeObscura);
  setObscuraEnv(t, port, token);

  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-limit-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let proxyCalls = 0;
  const createProxy = async () => {
    proxyCalls += 1;
    return { url: "http://127.0.0.1:1", close: async () => {} };
  };
  const browser = await createBrowserManager({ dataDir }, createProxy);
  try {
    // 20 already saved: the next capture is the 21st and must be refused.
    const full = randomUUID();
    await browser.create(full, "http://1.1.1.1/page");
    for (let i = 0; i < 20; i++) await seedPdf(dataDir, full, `seed-${i}.pdf`);
    await browser.navigate(full, "http://1.1.1.1/report.pdf");
    const refused = await browser.downloads(full);
    assert.equal(refused.downloads.length, 20);
    assert.equal(refused.failures.length, 1);
    assert.equal(refused.failures[0].code, "DOWNLOAD_LIMIT");
    assert.equal(refused.failures[0].name, "report.pdf");
    await browser.closeSession(full);

    // 19 already saved: the next capture is the 20th and must publish.
    const room = randomUUID();
    await browser.create(room, "http://1.1.1.1/page");
    for (let i = 0; i < 19; i++) await seedPdf(dataDir, room, `seed-${i}.pdf`);
    await browser.navigate(room, "http://1.1.1.1/report.pdf");
    const published = await browser.downloads(room);
    assert.equal(published.downloads.length, 20);
    assert.equal(published.failures.length, 0, JSON.stringify(published.failures));
    await browser.closeSession(room);

    assert.equal(proxyCalls, 0, "the native path must not start the egress proxy");
  } finally {
    await browser.close();
  }
});

test("a broken download store marks downloads failed, then recovers on the next success", {
  timeout: 180_000,
  skip: !LIVE || !binaryAvailable(),
}, async (t) => {
  const { port: originPort, close: closeOrigin } = await startOriginServer();
  t.after(closeOrigin);
  const { port: proxyPort, close: closeProxy } = await startForwardProxyServer(originPort);
  t.after(closeProxy);
  const { port, token, close: closeObscura } = await startObscuraServer(proxyPort);
  t.after(closeObscura);
  setObscuraEnv(t, port, token);

  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-store-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let proxyCalls = 0;
  const createProxy = async () => {
    proxyCalls += 1;
    return { url: "http://127.0.0.1:1", close: async () => {} };
  };
  const browser = await createBrowserManager({ dataDir }, createProxy);
  try {
    const id = randomUUID();
    await browser.create(id, "http://1.1.1.1/page");
    // Break the failure store: capturePdfDownload's mkdir(outcomes)
    // fails when the outcomes path is a file, so the capture throws
    // and the session's download store is marked failed.
    await writeFile(join(dataDir, id, "download-outcomes"), "not a directory");
    await browser.navigate(id, "http://1.1.1.1/report.pdf");
    await assert.rejects(
      browser.downloads(id),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "DOWNLOAD_STORE_FAILED",
    );
    // Repair the store and navigate again: the capture succeeds and
    // the transient failure flag is cleared.
    await rm(join(dataDir, id, "download-outcomes"), { force: true });
    await browser.navigate(id, "http://1.1.1.1/report.pdf");
    const listed = await browser.downloads(id);
    assert.equal(listed.downloads.length, 1);
    assert.equal(listed.downloads[0].name, "report.pdf");
    assert.equal(listed.failures.length, 0, JSON.stringify(listed.failures));
    const stored = await browser.download(id, listed.downloads[0].id);
    assert.equal(stored.bytes.subarray(0, 5).toString(), "%PDF-");
    assert.equal(proxyCalls, 0, "the native path must not start the egress proxy");
    await browser.closeSession(id);
  } finally {
    await browser.close();
  }
});

async function seedPdf(dataDir: string, sessionId: string, name: string) {
  const folder = join(dataDir, sessionId, "downloads");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  await writeFile(join(folder, `${id}.pdf`), PDF_BYTES, { mode: 0o600 });
  await writeFile(
    join(folder, `${id}.json`),
    JSON.stringify({ id, name, size: PDF_BYTES.length, mimeType: "application/pdf" }),
    { mode: 0o600 },
  );
}

function binaryAvailable(): boolean {
  if (!BIN) return false;
  try {
    accessSync(BIN, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForVersion(port: number, token: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // Server not up yet.
    }
    if (Date.now() > deadline) throw new Error("Obscura server did not answer /json/version");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

test("Obscura mode drives a real session end to end", {
  timeout: 180_000,
  skip: !LIVE || !binaryAvailable(),
}, async (t) => {
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const server: ChildProcess = spawn(
    BIN,
    ["serve", "--port", String(port), "--host", "127.0.0.1", "--allow-private-network"],
    {
      env: {
        ...process.env,
        OBSCURA_CDP_TOKEN: token,
        OBSCURA_ALLOW_PRIVATE_NETWORK: "1",
      },
      stdio: "ignore",
    },
  );
  t.after(() => {
    server.kill("SIGTERM");
  });
  await waitForVersion(port, token);

  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-live-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const savedUrl = process.env.OBSCURA_CDP_URL;
  const savedToken = process.env.OBSCURA_CDP_TOKEN;
  process.env.OBSCURA_CDP_URL = `ws://127.0.0.1:${port}/devtools/browser`;
  process.env.OBSCURA_CDP_TOKEN = token;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.OBSCURA_CDP_URL;
    else process.env.OBSCURA_CDP_URL = savedUrl;
    if (savedToken === undefined) delete process.env.OBSCURA_CDP_TOKEN;
    else process.env.OBSCURA_CDP_TOKEN = savedToken;
  });

  const createProxy = async () => {
    throw new Error("egress proxy must not start in Obscura mode");
  };
  const browser = await createBrowserManager({ dataDir }, createProxy);
  try {
    const id = randomUUID();
    const created = await browser.create(id, TARGET);
    assert.equal(created.title, "", "plain-text trace document has no title");
    const first = await browser.read(id);
    assert.equal(first.url, TARGET);
    assert.equal(first.title, "");
    assert.match(first.text, /h=1\.1\.1\.1/);

    // Repeat same-domain navigation: without the clearCookies
    // mitigation this hangs in Obscura 0.2.6 once the site's cookies
    // are stored (verified by local probes, Nov 13, 2026).
    const again = await browser.navigate(id, TARGET);
    assert.equal(again.title, "");
    assert.match((await browser.read(id)).text, /h=1\.1\.1\.1/);

    await browser.closeSession(id);
  } finally {
    await browser.close();
  }
});

// Cookie regression test. The first navigation loads a page that sets a
// cookie for its domain; the second navigation to the same domain must
// not carry that cookie. In Obscura 0.2.6 a stored cookie makes every
// later request to that domain hang on real sites (verified by local
// probes against https sites, Nov 13, 2026), so navigate() clears
// cookies before goto. This test asserts the clearing itself: with the
// mitigation removed, the second navigation succeeds but sends
// "Cookie: probe=1" and the assertion fails (verified by negative
// control, Nov 13, 2026). The origin and the proxy are local: the
// worker only accepts public URLs, so the test serves a public IP
// literal (1.1.1.1) through a forward proxy that answers for that host
// from the local origin. HTTP only — a TLS-intercepting proxy is out
// of scope for this test.
test("Obscura mode repeat navigation survives a server-set cookie", {
  timeout: 180_000,
  skip: !LIVE || !binaryAvailable(),
}, async (t) => {
  let checkCookieHeader: string | undefined;
  const origin = createHttpServer((req, res) => {
    if (req.url === "/set") {
      res.writeHead(200, {
        "content-type": "text/plain",
        "set-cookie": "probe=1; Path=/",
      });
      res.end("set");
    } else if (req.url === "/check") {
      checkCookieHeader = req.headers.cookie;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as { port: number }).port;
  t.after(() => new Promise<void>((resolve) => origin.close(() => resolve())));

  const proxy = createHttpServer((req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (target.hostname !== "1.1.1.1") {
      res.writeHead(404);
      res.end();
      return;
    }
    const forwarded = httpRequest(
      {
        hostname: "127.0.0.1",
        port: originPort,
        path: target.pathname + target.search,
        method: req.method,
        headers: { ...req.headers, host: "1.1.1.1" },
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    forwarded.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(forwarded);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = (proxy.address() as { port: number }).port;
  t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));

  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  const server: ChildProcess = spawn(
    BIN,
    ["serve", "--port", String(port), "--host", "127.0.0.1", "--allow-private-network"],
    {
      env: {
        ...process.env,
        OBSCURA_CDP_TOKEN: token,
        OBSCURA_ALLOW_PRIVATE_NETWORK: "1",
        http_proxy: `http://127.0.0.1:${proxyPort}`,
        https_proxy: `http://127.0.0.1:${proxyPort}`,
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        no_proxy: "",
        NO_PROXY: "",
      },
      stdio: "ignore",
    },
  );
  t.after(() => {
    server.kill("SIGTERM");
  });
  await waitForVersion(port, token);

  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-cookie-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const savedUrl = process.env.OBSCURA_CDP_URL;
  const savedToken = process.env.OBSCURA_CDP_TOKEN;
  process.env.OBSCURA_CDP_URL = `ws://127.0.0.1:${port}/devtools/browser`;
  process.env.OBSCURA_CDP_TOKEN = token;
  t.after(() => {
    if (savedUrl === undefined) delete process.env.OBSCURA_CDP_URL;
    else process.env.OBSCURA_CDP_URL = savedUrl;
    if (savedToken === undefined) delete process.env.OBSCURA_CDP_TOKEN;
    else process.env.OBSCURA_CDP_TOKEN = savedToken;
  });

  const createProxy = async () => {
    throw new Error("egress proxy must not start in Obscura mode");
  };
  const browser = await createBrowserManager({ dataDir }, createProxy);
  try {
    const id = randomUUID();
    await browser.create(id, "http://1.1.1.1/set");
    assert.match((await browser.read(id)).text, /set/);
    await browser.navigate(id, "http://1.1.1.1/check");
    assert.match((await browser.read(id)).text, /ok/);
    assert.equal(
      checkCookieHeader,
      undefined,
      "the second navigation must not carry the cookie set by the first page",
    );
    await browser.closeSession(id);
  } finally {
    await browser.close();
  }
});
