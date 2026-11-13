import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserManager } from "../src/browser.ts";
import { readDownloadFailures } from "../src/downloads.ts";

async function seedOutcome(directory: string, name: string, body: string) {
  const folder = join(directory, "download-outcomes");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, name), body, { mode: 0o600 });
}

function failedOutcome(id: string, createdAt: string) {
  return JSON.stringify({
    id,
    name: "document.pdf",
    status: "failed",
    code: "DOWNLOAD_INTERRUPTED",
    message: "The download was interrupted or could not be retrieved. Try downloading it again.",
    createdAt,
  });
}

function pendingOutcome(id: string, createdAt: string) {
  return JSON.stringify({
    id,
    name: "document.pdf",
    status: "pending",
    code: "DOWNLOAD_INTERRUPTED",
    message: "The download was interrupted or could not be retrieved. Try downloading it again.",
    createdAt,
  });
}

test("a corrupt outcome JSON is quarantined and the healthy failures still list", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-downloads-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await seedOutcome(
    directory,
    "aaaaaaaa-1111-4111-8111-111111111111.json",
    failedOutcome("aaaaaaaa-1111-4111-8111-111111111111", "2026-01-02T00:00:00.000Z"),
  );
  await seedOutcome(directory, "bbbbbbbb-2222-4222-8222-222222222222.json", "{not json");
  await seedOutcome(directory, "cccccccc-3333-4333-8333-333333333333.json", "null");
  await seedOutcome(
    directory,
    "dddddddd-4444-4444-8444-444444444444.json",
    pendingOutcome("dddddddd-4444-4444-8444-444444444444", "2026-01-01T00:00:00.000Z"),
  );

  const failures = await readDownloadFailures(directory, true);
  assert.deepEqual(
    failures.map((failure) => failure.id),
    ["aaaaaaaa-1111-4111-8111-111111111111", "dddddddd-4444-4444-8444-444444444444"],
  );

  const remaining = await readdir(join(directory, "download-outcomes"));
  assert.deepEqual(
    remaining.sort(),
    [
      "aaaaaaaa-1111-4111-8111-111111111111.json",
      "bbbbbbbb-2222-4222-8222-222222222222.json.corrupt",
      "cccccccc-3333-4333-8333-333333333333.json.corrupt",
      "dddddddd-4444-4444-8444-444444444444.json",
    ].sort(),
  );

  // A second read is stable: quarantined files are never re-read as outcomes.
  assert.deepEqual(
    (await readDownloadFailures(directory, true)).map((failure) => failure.id),
    ["aaaaaaaa-1111-4111-8111-111111111111", "dddddddd-4444-4444-8444-444444444444"],
  );
});

test("the worker starts with a corrupt outcome file and lists the healthy downloads", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-mb3-"));
  const id = randomUUID();
  const sessionDir = join(dataDir, id);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(sessionDir, "session.json"),
    JSON.stringify({
      id,
      title: "Fixture",
      url: "about:blank",
      status: "closed",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  const healthyId = randomUUID();
  await seedOutcome(
    sessionDir,
    `${healthyId}.json`,
    failedOutcome(healthyId, "2026-01-02T00:00:00.000Z"),
  );
  await seedOutcome(sessionDir, `${randomUUID()}.json`, "{corrupt");

  // The proxy is stubbed: startup never touches it, only create() does.
  const browser = await createBrowserManager({ dataDir }, async () => ({
    url: "http://127.0.0.1:1",
    close: async () => {},
  }));
  t.after(async () => {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.equal(browser.list()[0]?.id, id);
  assert.equal(browser.list()[0]?.status, "closed");
  const listed = await browser.downloads(id);
  assert.deepEqual(listed.downloads, []);
  assert.deepEqual(
    listed.failures.map((failure) => failure.id),
    [healthyId],
  );
});
