// Live Obscura test. Opt-in only: run with OBSCURA_TEST_LIVE=1 and
// OBSCURA_BIN pointing at an Obscura binary. Skipped everywhere else,
// including CI without a binary. Spawns a local Obscura server (token
// auth on, --allow-private-network for this VM's egress proxy) and drives
// a real session through the worker's Obscura mode.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
