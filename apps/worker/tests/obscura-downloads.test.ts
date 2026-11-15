import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { Browser, LaunchOptions } from "playwright";
import { chromium } from "playwright";
import {
  createBrowserManager,
  handleObscuraDownloadResponse,
  isDownloadResponse,
  type ObscuraDownloadContext,
  resolveSessionEngine,
} from "../src/browser.ts";
import {
  downloadFilenameFromResponse,
  MAX_DOWNLOAD_BYTES,
  readDownloadFailures,
} from "../src/downloads.ts";
import { WorkerError } from "../src/errors.ts";
import { createWorkerServer } from "../src/server.ts";

const URL_ENV = "OBSCURA_CDP_URL";
const TOKEN_ENV = "OBSCURA_CDP_TOKEN";

const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "utf8",
);

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

test("isDownloadResponse flags attachments and PDFs only", () => {
  assert.equal(
    isDownloadResponse({ "content-disposition": 'attachment; filename="report.pdf"' }),
    true,
  );
  assert.equal(
    isDownloadResponse({ "Content-Disposition": "Attachment; filename=report.pdf" }),
    true,
  );
  assert.equal(isDownloadResponse({ "content-type": "application/pdf" }), true);
  assert.equal(isDownloadResponse({ "content-type": "Application/PDF; charset=binary" }), true);
  assert.equal(
    isDownloadResponse({
      "content-disposition": 'attachment; filename="report.pdf"',
      "content-type": "text/html",
    }),
    true,
  );
  assert.equal(isDownloadResponse({ "content-type": "text/html" }), false);
  assert.equal(isDownloadResponse({ "content-disposition": "inline; filename=x.pdf" }), false);
  // A filename that merely contains the word "attachment" is not an
  // attachment: the disposition TYPE must be attachment.
  assert.equal(
    isDownloadResponse({
      "content-disposition": 'inline; filename="attachment-guide.html"',
      "content-type": "text/html",
    }),
    false,
  );
  assert.equal(isDownloadResponse({}), false);
});

test("downloadFilenameFromResponse parses dispositions and falls back to the URL", () => {
  assert.equal(
    downloadFilenameFromResponse("http://1.1.1.1/report.pdf", 'attachment; filename="report.pdf"'),
    "report.pdf",
  );
  assert.equal(
    downloadFilenameFromResponse("http://1.1.1.1/report.pdf", "attachment; filename=report.pdf"),
    "report.pdf",
  );
  assert.equal(
    downloadFilenameFromResponse(
      "http://1.1.1.1/other.pdf",
      "attachment; filename*=UTF-8''report%20final.pdf",
    ),
    "report final.pdf",
  );
  assert.equal(
    downloadFilenameFromResponse("http://1.1.1.1/files/annual-report.pdf", undefined),
    "annual-report.pdf",
  );
  assert.equal(downloadFilenameFromResponse("http://1.1.1.1/", undefined), "download");
  assert.equal(
    downloadFilenameFromResponse("http://1.1.1.1/report.pdf", "attachment"),
    "report.pdf",
  );
  assert.equal(
    downloadFilenameFromResponse("http://1.1.1.1/report.pdf", 'attachment; filename="a/b?.pdf"'),
    "a_b_.pdf",
  );
});

test("resolveSessionEngine resolves the default and validates overrides", () => {
  assert.equal(resolveSessionEngine(undefined, true), "obscura");
  assert.equal(resolveSessionEngine(undefined, false), "chromium");
  assert.equal(resolveSessionEngine("obscura", true), "obscura");
  assert.equal(resolveSessionEngine("chromium", true), "chromium");
  assert.equal(resolveSessionEngine("chromium", false), "chromium");
  assert.throws(
    () => resolveSessionEngine("obscura", false),
    (error: unknown) =>
      error instanceof WorkerError && error.code === "BROWSER_UNAVAILABLE" && error.status === 503,
  );
  for (const bad of ["safari", "OBSCURA", "", 42, null, {}]) {
    assert.throws(
      () => resolveSessionEngine(bad, true),
      (error: unknown) =>
        error instanceof WorkerError && error.code === "INVALID_ENGINE" && error.status === 400,
      String(bad),
    );
  }
});

test("create() rejects an unknown engine and Obscura without config before launching", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-engine-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await withEnv({ [URL_ENV]: undefined, [TOKEN_ENV]: undefined }, async () => {
    const browser = await createBrowserManager({ dataDir }, async () => ({
      url: "http://127.0.0.1:1",
      close: async () => {},
    }));
    try {
      await assert.rejects(browser.create(randomUUID(), "https://1.1.1.1/", "safari"), {
        code: "INVALID_ENGINE",
      });
      await assert.rejects(browser.create(randomUUID(), "https://1.1.1.1/", "obscura"), {
        code: "BROWSER_UNAVAILABLE",
      });
      assert.deepEqual(browser.list(), []);
    } finally {
      await browser.close();
    }
  });
});

function chromiumAvailable(): boolean {
  try {
    accessSync(chromium.executablePath(), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

test("lazy proxy starts once on the first Chromium session in Obscura mode", {
  timeout: 120_000,
  skip: !chromiumAvailable(),
}, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-lazy-proxy-"));
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
        assert.equal(proxyCalls, 0, "Obscura mode must not start the egress proxy at creation");
        // The proxy URL is dead, so the navigation fails — but only after
        // the launch, which proves the proxy was started for the session.
        await assert.rejects(browser.create(randomUUID(), "https://1.1.1.1/", "chromium"), {
          code: "NAVIGATION_FAILED",
        });
        assert.equal(proxyCalls, 1, "first Chromium session starts the proxy");
        await assert.rejects(browser.create(randomUUID(), "https://1.1.1.1/", "chromium"), {
          code: "NAVIGATION_FAILED",
        });
        assert.equal(proxyCalls, 1, "second Chromium session reuses the cached proxy");
      } finally {
        await browser.close();
      }
    },
  );
});

function fakeDownload(bytes: Buffer = PDF_BYTES) {
  return {
    suggestedFilename: () => "report.pdf",
    createReadStream: async () => Readable.from([bytes]),
    cancel: async () => {},
    delete: async () => {},
  };
}

function fakeBrowserWithDownload(download: unknown | null) {
  const listeners = new Map<string, (arg: unknown) => void>();
  const page = {
    on: (event: string, fn: (arg: unknown) => void) => {
      listeners.set(event, fn);
    },
    once: (event: string, fn: (arg: unknown) => void) => {
      listeners.set(event, fn);
    },
    off: (event: string, fn: (arg: unknown) => void) => {
      if (listeners.get(event) === fn) listeners.delete(event);
    },
    goto: async () => {
      if (download) listeners.get("download")?.(download);
    },
  };
  return {
    newContext: async () => ({
      newPage: async () => page,
      close: async () => {},
    }),
    close: async () => {},
  };
}

function stubLauncher(
  calls: { count: number; options?: LaunchOptions[] },
  download: unknown | null,
): (options: LaunchOptions) => Promise<Browser> {
  return async (options: LaunchOptions) => {
    calls.count += 1;
    if (!calls.options) calls.options = [];
    calls.options.push(options);
    return fakeBrowserWithDownload(download) as unknown as Browser;
  };
}

async function makeDeps(
  t: { after: (fn: () => Promise<void> | void) => void },
  overrides: Partial<ObscuraDownloadContext> = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-obscura-dl-"));
  const tempDirectory = join(directory, "temp");
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-dl-data-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  });
  const launcherCalls = { count: 0 };
  const proxyCalls = { count: 0 };
  const deps: ObscuraDownloadContext = {
    directory,
    tempDirectory,
    dataDir,
    limitReached: false,
    ensureProxy: async () => {
      proxyCalls.count += 1;
      return { url: "http://127.0.0.1:1", close: async () => {} };
    },
    chromiumLauncher: stubLauncher(launcherCalls, fakeDownload()),
    downloadWaitMs: 50,
    ...overrides,
  };
  return { deps, launcherCalls, proxyCalls };
}

function fakeResponse(headers: Record<string, string>, body: Buffer | Error) {
  let bodyCalls = 0;
  return {
    response: {
      headers: () => headers,
      body: async () => {
        bodyCalls += 1;
        if (body instanceof Error) throw body;
        return body;
      },
    },
    bodyCalls: () => bodyCalls,
  };
}

async function publishedNames(directory: string) {
  const names = await readdir(join(directory, "downloads")).catch(() => []);
  return names.filter((name) => name.endsWith(".json"));
}

test("native path publishes from body() and never launches the fallback", async (t) => {
  const { deps, launcherCalls, proxyCalls } = await makeDeps(t);
  const fake = fakeResponse(
    {
      "content-disposition": 'attachment; filename="report.pdf"',
      "content-type": "application/pdf",
      "content-length": String(PDF_BYTES.length),
    },
    PDF_BYTES,
  );
  const published = await handleObscuraDownloadResponse(
    deps,
    fake.response,
    "http://1.1.1.1/report.pdf",
  );
  assert.equal(published, true);
  assert.equal(launcherCalls.count, 0, "native success must not launch Chromium");
  assert.equal(proxyCalls.count, 0, "native success must not start the proxy");
  assert.equal(fake.bodyCalls(), 1);
  assert.equal((await publishedNames(deps.directory)).length, 1);
  assert.deepEqual(await readDownloadFailures(deps.directory), []);
});

test("body() throwing falls back to Chromium and publishes", async (t) => {
  const { deps, launcherCalls, proxyCalls } = await makeDeps(t);
  const fake = fakeResponse(
    {
      "content-disposition": 'attachment; filename="report.pdf"',
      "content-type": "application/pdf",
      "content-length": String(PDF_BYTES.length),
    },
    new Error("body unavailable"),
  );
  const published = await handleObscuraDownloadResponse(
    deps,
    fake.response,
    "http://1.1.1.1/report.pdf",
  );
  assert.equal(published, true);
  assert.equal(launcherCalls.count, 1, "body() failure must launch the fallback once");
  assert.equal(proxyCalls.count, 1, "fallback starts the lazy proxy");
  assert.equal((await publishedNames(deps.directory)).length, 1);
  assert.deepEqual(await readDownloadFailures(deps.directory), []);
});

test("absent content-length falls back to Chromium and publishes", async (t) => {
  const { deps, launcherCalls } = await makeDeps(t);
  const fake = fakeResponse(
    {
      "content-disposition": 'attachment; filename="report.pdf"',
      "content-type": "application/pdf",
    },
    PDF_BYTES,
  );
  const published = await handleObscuraDownloadResponse(
    deps,
    fake.response,
    "http://1.1.1.1/report.pdf",
  );
  assert.equal(published, true);
  assert.equal(launcherCalls.count, 1, "absent length must launch the fallback once");
  assert.equal(fake.bodyCalls(), 0, "body() must not be called without a length");
  assert.equal((await publishedNames(deps.directory)).length, 1);
});

test("fallback with no download event records DOWNLOAD_INTERRUPTED", async (t) => {
  const launcherCalls = { count: 0 };
  const { deps } = await makeDeps(t, {
    chromiumLauncher: stubLauncher(launcherCalls, null),
  });
  const fake = fakeResponse(
    {
      "content-disposition": 'attachment; filename="report.pdf"',
      "content-type": "application/pdf",
    },
    PDF_BYTES,
  );
  const published = await handleObscuraDownloadResponse(
    deps,
    fake.response,
    "http://1.1.1.1/report.pdf",
  );
  assert.equal(published, false);
  assert.equal(launcherCalls.count, 1);
  assert.deepEqual(await publishedNames(deps.directory), []);
  const failures = await readDownloadFailures(deps.directory);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "DOWNLOAD_INTERRUPTED");
  assert.equal(failures[0].name, "report.pdf");
});

test("honest oversized content-length records DOWNLOAD_TOO_LARGE without body() or fallback", async (t) => {
  const { deps, launcherCalls } = await makeDeps(t);
  const fake = fakeResponse(
    {
      "content-disposition": 'attachment; filename="big.pdf"',
      "content-type": "application/pdf",
      "content-length": String(MAX_DOWNLOAD_BYTES + 1),
    },
    PDF_BYTES,
  );
  const published = await handleObscuraDownloadResponse(
    deps,
    fake.response,
    "http://1.1.1.1/big.pdf",
  );
  assert.equal(published, false);
  assert.equal(fake.bodyCalls(), 0, "oversized length must not buffer the body");
  assert.equal(launcherCalls.count, 0, "a content verdict must not trigger the fallback");
  assert.deepEqual(await publishedNames(deps.directory), []);
  const failures = await readDownloadFailures(deps.directory);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "DOWNLOAD_TOO_LARGE");
  assert.equal(failures[0].name, "big.pdf");
});

test("native path records UNSUPPORTED_DOWNLOAD for non-PDF bytes without fallback", async (t) => {
  const { deps, launcherCalls } = await makeDeps(t);
  const text = Buffer.from("not a pdf", "utf8");
  const fake = fakeResponse(
    {
      "content-disposition": 'attachment; filename="report.pdf"',
      "content-type": "application/pdf",
      "content-length": String(text.length),
    },
    text,
  );
  const published = await handleObscuraDownloadResponse(
    deps,
    fake.response,
    "http://1.1.1.1/report.pdf",
  );
  assert.equal(published, false);
  assert.equal(launcherCalls.count, 0, "a content verdict must not trigger the fallback");
  assert.deepEqual(await publishedNames(deps.directory), []);
  const failures = await readDownloadFailures(deps.directory);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "UNSUPPORTED_DOWNLOAD");
});

test("native path records DOWNLOAD_LIMIT when the session limit is reached", async (t) => {
  const { deps, launcherCalls } = await makeDeps(t, { limitReached: true });
  const fake = fakeResponse(
    {
      "content-disposition": 'attachment; filename="report.pdf"',
      "content-type": "application/pdf",
      "content-length": String(PDF_BYTES.length),
    },
    PDF_BYTES,
  );
  const published = await handleObscuraDownloadResponse(
    deps,
    fake.response,
    "http://1.1.1.1/report.pdf",
  );
  assert.equal(published, false);
  assert.equal(launcherCalls.count, 0);
  const failures = await readDownloadFailures(deps.directory);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "DOWNLOAD_LIMIT");
});

test("POST /sessions passes engine through to browser.create", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-worker-engine-http-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let capturedEngine: unknown = "not-called";
  const stubBrowser = {
    list: () => [],
    create: async (id: string, url: string, engine?: unknown) => {
      capturedEngine = engine;
      resolveSessionEngine(engine, false);
      return {
        id,
        title: "Stub",
        url,
        status: "active" as const,
        updatedAt: new Date().toISOString(),
      };
    },
    close: async () => {},
  };
  const worker = await createWorkerServer(
    { token: "x".repeat(32), dataDir },
    async () => stubBrowser as never,
  );
  worker.server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => worker.server.once("listening", resolve));
  const port = (worker.server.address() as { port: number }).port;
  t.after(async () => {
    await worker.close();
  });
  const token = "x".repeat(32);
  const post = async (body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${port}/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };

  const id = randomUUID();
  const ok = await post({ id, url: "https://1.1.1.1/", engine: "chromium" });
  assert.equal(ok.status, 201);
  assert.equal(capturedEngine, "chromium");

  capturedEngine = "not-called";
  const absent = await post({ id, url: "https://1.1.1.1/" });
  assert.equal(absent.status, 201);
  assert.equal(capturedEngine, undefined);

  const bad = await post({ id, url: "https://1.1.1.1/", engine: "safari" });
  assert.equal(bad.status, 400);
  assert.equal((bad.json.error as { code?: unknown }).code, "INVALID_ENGINE");
});

test("non-decimal content-length values route to the fallback, not the native path", async (t) => {
  // Number() would accept "0x10" (16), "1e3" (1000), and "" (0) — none
  // is a valid Content-Length, so none may bound body().
  for (const bad of ["0x10", "1e3", "", " 12x", "-5"]) {
    const { deps, launcherCalls } = await makeDeps(t);
    const fake = fakeResponse(
      {
        "content-disposition": 'attachment; filename="report.pdf"',
        "content-type": "application/pdf",
        "content-length": bad,
      },
      PDF_BYTES,
    );
    const published = await handleObscuraDownloadResponse(
      deps,
      fake.response,
      "http://1.1.1.1/report.pdf",
    );
    assert.equal(published, true, `length ${JSON.stringify(bad)}`);
    assert.equal(launcherCalls.count, 1, `length ${JSON.stringify(bad)} must take the fallback`);
    assert.equal(fake.bodyCalls(), 0, "body() must not be called without a trusted length");
  }
});

test("non-identity content-encoding routes to the fallback without calling body()", async (t) => {
  const { deps, launcherCalls } = await makeDeps(t);
  const fake = fakeResponse(
    {
      "content-disposition": 'attachment; filename="report.pdf"',
      "content-type": "application/pdf",
      "content-length": String(PDF_BYTES.length),
      "content-encoding": "gzip",
    },
    PDF_BYTES,
  );
  const published = await handleObscuraDownloadResponse(
    deps,
    fake.response,
    "http://1.1.1.1/report.pdf",
  );
  assert.equal(published, true);
  assert.equal(launcherCalls.count, 1, "an encoded response must take the bounded fallback");
  assert.equal(fake.bodyCalls(), 0, "body() must not be called for an encoded response");
});

test("identity content-encoding stays on the native path", async (t) => {
  const { deps, launcherCalls } = await makeDeps(t);
  const fake = fakeResponse(
    {
      "content-disposition": 'attachment; filename="report.pdf"',
      "content-type": "application/pdf",
      "content-length": String(PDF_BYTES.length),
      "content-encoding": "identity",
    },
    PDF_BYTES,
  );
  const published = await handleObscuraDownloadResponse(
    deps,
    fake.response,
    "http://1.1.1.1/report.pdf",
  );
  assert.equal(published, true);
  assert.equal(launcherCalls.count, 0);
  assert.equal(fake.bodyCalls(), 1);
});

test("fallback launches Chromium with the allowlisted env and shared args", async (t) => {
  const launcherCalls: { count: number; options?: LaunchOptions[] } = { count: 0 };
  const { deps } = await makeDeps(t, {
    chromiumLauncher: stubLauncher(launcherCalls, fakeDownload()),
  });
  await withEnv({ WORKER_TOKEN: "secret-token", OBSCURA_CDP_TOKEN: "secret-token" }, async () => {
    const fake = fakeResponse(
      {
        "content-disposition": 'attachment; filename="report.pdf"',
        "content-type": "application/pdf",
      },
      PDF_BYTES,
    );
    const published = await handleObscuraDownloadResponse(
      deps,
      fake.response,
      "http://1.1.1.1/report.pdf",
    );
    assert.equal(published, true);
  });
  assert.equal(launcherCalls.count, 1);
  const options = launcherCalls.options?.[0];
  assert.ok(options, "the launcher must have been called");
  const env = options.env ?? {};
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH"]);
  assert.equal(env.HOME, process.env.HOME ?? "/tmp");
  assert.deepEqual(options.args, [
    "--disable-quic",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-extensions",
    "--disable-dev-shm-usage",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
  ]);
});

test("fallback cancels a stalled capture at the capture deadline", async (t) => {
  // Models real Playwright behavior: cancelling a download rejects the
  // stream createReadStream is waiting on.
  let cancelCalls = 0;
  let rejectStream: (error: Error) => void = () => {};
  const stalled = {
    suggestedFilename: () => "report.pdf",
    createReadStream: async () =>
      new Promise<never>((_resolve, reject) => {
        rejectStream = reject;
      }),
    cancel: async () => {
      cancelCalls += 1;
      rejectStream(new Error("Download cancelled"));
    },
    delete: async () => {},
  };
  const launcherCalls = { count: 0 };
  const { deps } = await makeDeps(t, {
    chromiumLauncher: stubLauncher(launcherCalls, stalled),
    captureWaitMs: 50,
  });
  const fake = fakeResponse(
    {
      "content-disposition": 'attachment; filename="report.pdf"',
      "content-type": "application/pdf",
    },
    PDF_BYTES,
  );
  const started = Date.now();
  const published = await handleObscuraDownloadResponse(
    deps,
    fake.response,
    "http://1.1.1.1/report.pdf",
  );
  const elapsed = Date.now() - started;
  assert.equal(published, false);
  assert.equal(cancelCalls, 1, "the stalled download must be cancelled at the deadline");
  assert.ok(elapsed < 10_000, `the capture must not stall the caller (took ${elapsed} ms)`);
  const failures = await readDownloadFailures(deps.directory);
  assert.equal(failures.length, 1, "the stalled capture records exactly one failure");
  assert.equal(failures[0].code, "DOWNLOAD_INTERRUPTED");
});

test("fallback failure recording that fails throws instead of reporting a silent success", async (t) => {
  const launcherCalls = { count: 0 };
  const { deps } = await makeDeps(t, {
    chromiumLauncher: stubLauncher(launcherCalls, null),
  });
  // Break the failure store: recordDownloadFailure's mkdir fails when
  // the outcomes path is a file.
  await writeFile(join(deps.directory, "download-outcomes"), "not a directory");
  const fake = fakeResponse(
    {
      "content-disposition": 'attachment; filename="report.pdf"',
      "content-type": "application/pdf",
    },
    PDF_BYTES,
  );
  await assert.rejects(
    handleObscuraDownloadResponse(deps, fake.response, "http://1.1.1.1/report.pdf"),
  );
});

test("a failed lazy proxy startup retries on the next Chromium session", {
  timeout: 120_000,
  skip: !chromiumAvailable(),
}, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-obscura-proxy-retry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let proxyCalls = 0;
  const createProxy = async () => {
    proxyCalls += 1;
    if (proxyCalls === 1) throw new Error("proxy down");
    // A dead proxy URL: the launch succeeds and the navigation fails,
    // which is exactly the point — the failure moves downstream from
    // proxy startup (BROWSER_UNAVAILABLE) to navigation
    // (NAVIGATION_FAILED), proving the startup itself was retried.
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
        // The first attempt fails at the proxy, so session creation is
        // refused — but the failed startup must not poison later use.
        await assert.rejects(
          browser.create(randomUUID(), "https://1.1.1.1/cdn-cgi/trace", "chromium"),
          { code: "BROWSER_UNAVAILABLE" },
        );
        assert.equal(proxyCalls, 1);
        assert.deepEqual(browser.list(), []);
        await assert.rejects(
          browser.create(randomUUID(), "https://1.1.1.1/cdn-cgi/trace", "chromium"),
          { code: "NAVIGATION_FAILED" },
        );
        assert.equal(proxyCalls, 2, "the second session must retry the proxy startup");
        assert.deepEqual(browser.list(), []);
      } finally {
        await browser.close();
      }
    },
  );
});
