import assert from "node:assert/strict";
import { type ChildProcess, fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBrowserManager } from "../src/browser.ts";
import { createBrowserFixture, fixtureOrigin, fixtureText, fixtureTitle } from "./fixtures.ts";
import { checkBrowserWorker, type WorkerAddress } from "./worker-checks.ts";

test("real Chromium cleans failed profiles and restores a saved UUID after worker restart", {
  timeout: 90_000,
}, async (t) => {
  const fixture = await createBrowserFixture();
  t.after(async () => {
    try {
      await fixture.close();
    } finally {
      assert.deepEqual(fixture.unexpected, []);
    }
  });
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-lifecycle-"));
  const id = randomUUID();
  const failedId = randomUUID();
  let browser: Awaited<ReturnType<typeof createBrowserManager>> | undefined;
  try {
    const createProxy = fixture.createProxy;
    browser = await createBrowserManager({ dataDir }, createProxy);

    // A private destination must be rejected before the injected sender runs.
    const proxyAddress = new URL(fixture.proxyUrl);
    const blocked = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: proxyAddress.hostname,
          port: proxyAddress.port,
          path: "http://127.0.0.1/blocked",
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    assert.equal(blocked, 403);
    assert.deepEqual(fixture.paths, [], "private requests never reach the fixture server");
    await assert.rejects(browser.create(failedId, "http://127.0.0.1/blocked"), {
      code: "BLOCKED_URL",
    });
    await assert.rejects(browser.create(failedId, `${fixtureOrigin}/redirect-private`), {
      code: "BLOCKED_URL",
    });
    assert.equal(fixture.paths.filter((path) => path === "/redirect-private").length, 1);
    assert.equal(browser.list().length, 0, "failed creation must release its saved-profile slot");
    assert.equal(
      (await readdir(dataDir)).includes(failedId),
      false,
      "unclaimed profile is removed",
    );

    await browser.create(id, `${fixtureOrigin}/page`);
    assert.deepEqual(await browser.read(id), {
      url: `${fixtureOrigin}/page`,
      title: fixtureTitle,
      text: fixtureText,
      truncated: false,
    });
    await browser.navigate(id, `${fixtureOrigin}/seed`);
    await browser.closeSession(id);
    // The per-session temp dir is removed on close, not left in /tmp.
    await assert.rejects(stat(join("/tmp", `openmuse-downloads-${id}`)));
    await browser.close();
    // A temp dir left behind by a crashed run is swept at startup.
    await mkdir(join("/tmp", `openmuse-downloads-${id}`), { recursive: true });
    await writeFile(join("/tmp", `openmuse-downloads-${id}`, "stale.bin"), "stale");
    browser = await createBrowserManager({ dataDir }, createProxy);
    await assert.rejects(stat(join("/tmp", `openmuse-downloads-${id}`)));
    assert.equal(browser.list()[0]?.status, "closed");
    const reopened = await browser.create(id, `${fixtureOrigin}/page`);
    assert.equal(reopened.id, id);
    assert.equal(reopened.title, fixtureTitle);
    assert.deepEqual(await browser.read(id), {
      url: `${fixtureOrigin}/page`,
      title: fixtureTitle,
      text: fixtureText,
      truncated: false,
    });
    await browser.navigate(id, `${fixtureOrigin}/state`);
    assert.equal((await browser.read(id)).text, "retained");
    assert.equal(fixture.paths.filter((path) => path === "/seed").length, 1);

    for (const size of [100_000, 100_001]) {
      const url = `${fixtureOrigin}/large?size=${size}`;
      await browser.navigate(id, url);
      assert.deepEqual(await browser.read(id), {
        url,
        title: fixtureTitle,
        text: "x".repeat(100_000),
        truncated: size > 100_000,
      });
    }
    await browser.closeSession(id);
    const state = JSON.parse(await readFile(join(dataDir, id, "storage.json"), "utf8"));
    assert.equal(
      (await stat(join(dataDir, id, "storage.json"))).mode & 0o777,
      0o600,
      "the cookie jar is owner-only like session.json and download files",
    );
    assert(
      state.origins
        .find((item: { origin: string }) => item.origin === fixtureOrigin)
        ?.localStorage.some(
          (item: { name: string; value: string }) =>
            item.name === "openmuse-profile-test" && item.value === "retained",
        ),
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      for (const sessionId of [id, failedId])
        await rm(join("/tmp", `openmuse-downloads-${sessionId}`), { recursive: true, force: true });
    }
  }
});

test("real worker API preserves fixture downloads and browser storage across process restart", {
  timeout: 90_000,
}, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-worker-fixtures-"));
  const token = randomBytes(32).toString("hex");
  let child: ChildProcess | undefined;
  let output = "";
  async function start(): Promise<WorkerAddress> {
    child = fork(fileURLToPath(new URL("./fixture-worker.ts", import.meta.url)), [], {
      execArgv: ["--experimental-strip-types"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        WORKER_TOKEN: token,
        WORKER_DATA_DIR: dataDir,
        WORKER_HOST: "127.0.0.1",
        WORKER_TEST_PORT: "0",
        WORKER_FIXTURE_PORT: "0",
      },
    });
    output = "";
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => {
        output = `${output}${chunk}`.slice(-6000);
      });
    const [address] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(15_000) }),
      once(child, "exit").then(() => {
        throw new Error(`Fixture worker exited before startup: ${output}`);
      }),
    ]);
    assert(address && typeof address.base === "string" && typeof address.fixtureBase === "string");
    return address;
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const deadline = setTimeout(() => child?.kill("SIGKILL"), 35_000);
    deadline.unref();
    const [code] = await exited;
    clearTimeout(deadline);
    assert.equal(code, 0, output);
  }
  try {
    await checkBrowserWorker(token, await start(), async () => {
      await stop();
      return start();
    });
  } finally {
    try {
      await stop();
    } finally {
      for (const id of await readdir(dataDir))
        await rm(join("/tmp", `openmuse-downloads-${id}`), { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  }
});

test("a stale oversized file in the session temp dir does not cancel a small download", {
  timeout: 90_000,
}, async (t) => {
  const fixture = await createBrowserFixture();
  t.after(async () => {
    try {
      await fixture.close();
    } finally {
      assert.deepEqual(fixture.unexpected, []);
    }
  });
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-sb12-"));
  const id = randomUUID();
  let browser: Awaited<ReturnType<typeof createBrowserManager>> | undefined;
  try {
    browser = await createBrowserManager({ dataDir }, fixture.createProxy);
    await browser.create(id, `${fixtureOrigin}/page`);
    // A leftover from a crashed earlier capture: oversized, but it belongs
    // to no live capture and must not trip this download's monitor.
    await writeFile(
      join("/tmp", `openmuse-downloads-${id}`, "stale.bin"),
      Buffer.alloc(11 * 1024 * 1024),
    );
    await browser.navigate(id, `${fixtureOrigin}/slow-download.pdf`);
    let downloads: { name: string }[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      downloads = (await browser.downloads(id)).downloads;
      if (downloads.length) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0]?.name, "slow.pdf");
    assert.deepEqual((await browser.downloads(id)).failures, []);
  } finally {
    try {
      await browser?.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(join("/tmp", `openmuse-downloads-${id}`), { recursive: true, force: true });
    }
  }
});

test("a download-store failure clears on a subsequent successful capture", {
  timeout: 90_000,
}, async (t) => {
  const fixture = await createBrowserFixture();
  t.after(async () => {
    try {
      await fixture.close();
    } finally {
      assert.deepEqual(fixture.unexpected, []);
    }
  });
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-sb12-"));
  const id = randomUUID();
  let browser: Awaited<ReturnType<typeof createBrowserManager>> | undefined;
  try {
    browser = await createBrowserManager({ dataDir }, fixture.createProxy);
    await browser.create(id, `${fixtureOrigin}/page`);
    const downloadsDir = join(dataDir, id, "downloads");
    // Break the download store: a file where the downloads directory
    // belongs makes every capture fail to record its outcome.
    await writeFile(downloadsDir, "sabotage");
    await browser.navigate(id, `${fixtureOrigin}/download.txt`);
    // Repair the store, then prove the flag is sticky until a capture
    // succeeds: listing still throws DOWNLOAD_STORE_FAILED.
    await rm(downloadsDir, { force: true });
    await mkdir(downloadsDir, { recursive: true, mode: 0o700 });
    let flagged = false;
    for (let attempt = 0; attempt < 25; attempt++) {
      try {
        await browser.downloads(id);
      } catch (error) {
        if ((error as { code?: string })?.code === "DOWNLOAD_STORE_FAILED") {
          flagged = true;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(flagged, "downloads must throw DOWNLOAD_STORE_FAILED while the flag is set");
    // A successful capture clears the flag; the list works again.
    await browser.navigate(id, `${fixtureOrigin}/download.pdf`);
    let listed: { downloads: unknown[]; failures: unknown[] } | undefined;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        listed = await browser.downloads(id);
        break;
      } catch (error) {
        if ((error as { code?: string })?.code !== "DOWNLOAD_STORE_FAILED") throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    assert.ok(listed, "downloads must list again after a successful capture");
    assert.equal(listed.downloads.length, 1);
    assert.deepEqual(listed.failures, []);
  } finally {
    try {
      await browser?.close();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(join("/tmp", `openmuse-downloads-${id}`), { recursive: true, force: true });
    }
  }
});
