import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserManager, deriveObscuraHost, resolveObscuraConfig } from "../src/browser.ts";

const URL_ENV = "OBSCURA_CDP_URL";
const TOKEN_ENV = "OBSCURA_CDP_TOKEN";
const HOST_ENV = "OBSCURA_CDP_HOST";

function withEnv(values: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return (async () => {
    try {
      await fn();
    } finally {
      for (const key of Object.keys(values)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  })();
}

test("resolveObscuraConfig is null unless both variables are set", () => {
  assert.equal(resolveObscuraConfig({}), null);
  assert.equal(
    resolveObscuraConfig({ [URL_ENV]: "ws://obscura-browser:9222/devtools/browser" }),
    null,
  );
  assert.equal(resolveObscuraConfig({ [TOKEN_ENV]: "secret" }), null);
  assert.equal(resolveObscuraConfig({ [URL_ENV]: "   ", [TOKEN_ENV]: "secret" }), null);
  assert.equal(
    resolveObscuraConfig({
      [URL_ENV]: "ws://obscura-browser:9222/devtools/browser",
      [TOKEN_ENV]: "  ",
    }),
    null,
  );
});

test("resolveObscuraConfig returns the endpoint, token, and derived Host", () => {
  assert.deepEqual(
    resolveObscuraConfig({
      [URL_ENV]: "ws://obscura-browser:9222/devtools/browser",
      [TOKEN_ENV]: "secret-token",
    }),
    {
      endpoint: "ws://obscura-browser:9222/devtools/browser",
      token: "secret-token",
      host: "obscura-browser:9222",
    },
  );
  // No explicit port in the endpoint: the Host falls back to the scheme
  // default, which is the correct Host when connecting directly.
  assert.equal(
    resolveObscuraConfig({
      [URL_ENV]: "ws://obscura-browser/devtools/browser",
      [TOKEN_ENV]: "secret-token",
    })?.host,
    "obscura-browser:80",
  );
  // An uppercase scheme is valid: WHATWG parsing normalizes it.
  assert.deepEqual(
    resolveObscuraConfig({
      [URL_ENV]: "WS://obscura-browser:9222/devtools/browser",
      [TOKEN_ENV]: "secret-token",
    }),
    {
      endpoint: "ws://obscura-browser:9222/devtools/browser",
      token: "secret-token",
      host: "obscura-browser:9222",
    },
  );
});

test("resolveObscuraConfig rejects a non-WebSocket or hostless endpoint", () => {
  for (const endpoint of [
    "http://obscura-browser:9222/devtools/browser",
    "https://obscura-browser:9222/devtools/browser",
    "not a url",
    "ws:///devtools/browser",
    "ws://",
    // A fragment is not allowed on a WebSocket endpoint, including an
    // empty trailing fragment delimiter.
    "ws://obscura-browser:9222/devtools/browser#fragment",
    "ws://obscura-browser:9222/devtools/browser#",
    // A backslash is a separator for ws:/wss: URLs and can smuggle in a
    // phantom host; control characters are never valid in a URL. (A
    // trailing tab is trimmed away by the config reader and is fine.)
    "ws://\\obscura-browser:9222/devtools/browser",
    "ws://obscura-browser:9222/devtools/brow\tser",
    "ws://obscura-browser:9222/devtools/browser\x01",
  ]) {
    assert.throws(
      () => resolveObscuraConfig({ [URL_ENV]: endpoint, [TOKEN_ENV]: "secret" }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_OBSCURA_CONFIG",
      endpoint,
    );
  }
});

test("resolveObscuraConfig honors an explicit OBSCURA_CDP_HOST override", () => {
  // Azure ingress: connect on port 80, send Host with the server port.
  assert.deepEqual(
    resolveObscuraConfig({
      [URL_ENV]: "ws://obscura-browser/devtools/browser",
      [TOKEN_ENV]: "secret-token",
      [HOST_ENV]: "obscura-browser:9222",
    }),
    {
      endpoint: "ws://obscura-browser/devtools/browser",
      token: "secret-token",
      host: "obscura-browser:9222",
    },
  );
  assert.equal(
    resolveObscuraConfig({
      [URL_ENV]: "ws://127.0.0.1:9222/devtools/browser",
      [TOKEN_ENV]: "secret-token",
      [HOST_ENV]: "OBSCURA-BROWSER:9222",
    })?.host,
    "obscura-browser:9222",
  );
  for (const host of [
    "obscura-browser", // no port: cannot express a Host port that differs
    "ws://obscura-browser:9222", // a scheme is not a bare host:port value
    "obscura-browser:9222/devtools/browser", // no path
    "user@obscura-browser:9222", // no userinfo
    "obscura-browser:9222#frag", // no fragment
    "obscura-browser:notaport",
  ]) {
    assert.throws(
      () =>
        resolveObscuraConfig({
          [URL_ENV]: "ws://obscura-browser/devtools/browser",
          [TOKEN_ENV]: "secret-token",
          [HOST_ENV]: host,
        }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_OBSCURA_CONFIG",
      host,
    );
  }
});

test("deriveObscuraHost keeps the endpoint host and explicit port", () => {
  assert.equal(
    deriveObscuraHost("ws://obscura-browser:9222/devtools/browser"),
    "obscura-browser:9222",
  );
  assert.equal(
    deriveObscuraHost("wss://browser.example.com:9443/devtools/browser"),
    "browser.example.com:9443",
  );
  assert.equal(deriveObscuraHost("ws://127.0.0.1:9222/devtools/browser"), "127.0.0.1:9222");
  assert.equal(deriveObscuraHost("ws://[::1]:9222/devtools/browser"), "[::1]:9222");
  assert.equal(
    deriveObscuraHost("ws://OBSCURA-BROWSER:9222/devtools/browser"),
    "obscura-browser:9222",
  );
});

test("deriveObscuraHost falls back to the scheme default port", () => {
  assert.equal(deriveObscuraHost("ws://obscura-browser/devtools/browser"), "obscura-browser:80");
  assert.equal(deriveObscuraHost("wss://obscura-browser/devtools/browser"), "obscura-browser:443");
  assert.equal(deriveObscuraHost("ws://obscura-browser:80/devtools/browser"), "obscura-browser:80");
});

test("deriveObscuraHost rejects a malformed endpoint", () => {
  assert.throws(() => deriveObscuraHost("not a url"), TypeError);
  assert.throws(
    () => deriveObscuraHost("http://obscura-browser:9222/devtools/browser"),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "INVALID_OBSCURA_CONFIG",
  );
  assert.throws(
    () => deriveObscuraHost("https://obscura-browser:9222/devtools/browser"),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "INVALID_OBSCURA_CONFIG",
  );
});

test("Obscura mode does not start the egress proxy", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-config-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let proxyCalls = 0;
  const createProxy = async () => {
    proxyCalls += 1;
    return { url: "http://127.0.0.1:1", close: async () => {} };
  };
  await withEnv(
    {
      [URL_ENV]: "ws://obscura-browser:9222/devtools/browser",
      [TOKEN_ENV]: "secret-token",
    },
    async () => {
      const browser = await createBrowserManager({ dataDir }, createProxy);
      try {
        assert.equal(proxyCalls, 0, "Obscura mode must not start the egress proxy");
        assert.deepEqual(browser.list(), []);
      } finally {
        await browser.close();
      }
    },
  );
});

test("Chromium mode still starts the egress proxy when only one variable is set", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-config-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let proxyCalls = 0;
  const createProxy = async () => {
    proxyCalls += 1;
    return { url: "http://127.0.0.1:1", close: async () => {} };
  };
  await withEnv(
    { [URL_ENV]: "ws://obscura-browser:9222/devtools/browser", [TOKEN_ENV]: undefined },
    async () => {
      const browser = await createBrowserManager({ dataDir }, createProxy);
      try {
        assert.equal(proxyCalls, 1, "half-configured Obscura falls back to Chromium mode");
      } finally {
        await browser.close();
      }
    },
  );
});

test("a failed CDP connect surfaces as BROWSER_UNAVAILABLE", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-connect-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const createProxy = async () => {
    throw new Error("egress proxy must not start in Obscura mode");
  };
  await withEnv(
    {
      // Port 9 is the discard port: nothing listens, so the connect fails fast.
      [URL_ENV]: "ws://127.0.0.1:9/devtools/browser",
      [TOKEN_ENV]: "secret-token",
    },
    async () => {
      const browser = await createBrowserManager({ dataDir }, createProxy);
      try {
        // An IP literal passes URL validation without DNS: this VM's
        // resolver answers public names with CGNAT addresses, which the
        // worker correctly blocks. The connect itself must still fail.
        await assert.rejects(browser.create(randomUUID(), "https://1.1.1.1/"), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { code?: unknown }).code, "BROWSER_UNAVAILABLE");
          assert.equal((error as { status?: unknown }).status, 503);
          assert.ok(!error.message.includes("127.0.0.1"), "no endpoint detail leaks");
          assert.ok(!error.message.includes("secret-token"), "no token detail leaks");
          return true;
        });
        assert.deepEqual(browser.list(), [], "failed creation releases the session slot");
      } finally {
        await browser.close();
      }
    },
  );
});
