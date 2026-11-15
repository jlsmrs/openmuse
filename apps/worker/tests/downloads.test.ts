import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBrowserManager } from "../src/browser.ts";
import {
  capturePdfDownloadFromBytes,
  enforceDownloadQuota,
  MAX_DOWNLOAD_BYTES,
  parseDownloadQuotaBytes,
  readDownloadFailures,
  recordDownloadFailure,
} from "../src/downloads.ts";

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

async function seedDownload(directory: string, name: string, body: string) {
  const folder = join(directory, "downloads");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await writeFile(join(folder, name), body, { mode: 0o600 });
}

function downloadMetadata(id: string) {
  return JSON.stringify({
    id,
    name: "document.pdf",
    size: 1234,
    mimeType: "application/pdf",
  });
}

test("a corrupt download metadata file is quarantined and the healthy downloads still list", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-sb12-"));
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
  await seedDownload(sessionDir, `${healthyId}.json`, downloadMetadata(healthyId));
  await seedDownload(sessionDir, `${randomUUID()}.json`, "{corrupt");
  await seedDownload(
    sessionDir,
    `${randomUUID()}.json`,
    JSON.stringify({ id: "x", name: "bad.pdf", size: "not-a-number", mimeType: "application/pdf" }),
  );

  // The proxy is stubbed: listing never touches it.
  const browser = await createBrowserManager({ dataDir }, async () => ({
    url: "http://127.0.0.1:1",
    close: async () => {},
  }));
  t.after(async () => {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const listed = await browser.downloads(id);
  assert.deepEqual(
    listed.downloads.map((item) => item.id),
    [healthyId],
  );
  const remaining = await readdir(join(sessionDir, "downloads"));
  assert.equal(remaining.filter((name) => name.endsWith(".json")).length, 1);
  assert.equal(remaining.filter((name) => name.endsWith(".corrupt")).length, 2);

  // A second list is stable: quarantined files are never re-read.
  assert.deepEqual(
    (await browser.downloads(id)).downloads.map((item) => item.id),
    [healthyId],
  );
});

test("a malformed stored session is quarantined and never listed", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-browser-sb12-"));
  const badId = randomUUID();
  const badDir = join(dataDir, badId);
  await mkdir(badDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(badDir, "session.json"),
    JSON.stringify({
      id: badId,
      title: 42,
      url: "about:blank",
      status: "closed",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    { mode: 0o600 },
  );
  const arrayId = randomUUID();
  const arrayDir = join(dataDir, arrayId);
  await mkdir(arrayDir, { recursive: true, mode: 0o700 });
  await writeFile(join(arrayDir, "session.json"), "[]", { mode: 0o600 });

  const browser = await createBrowserManager({ dataDir }, async () => ({
    url: "http://127.0.0.1:1",
    close: async () => {},
  }));
  t.after(async () => {
    await browser.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  assert.deepEqual(browser.list(), []);
  const badRemaining = await readdir(badDir);
  assert.deepEqual(badRemaining, ["session.json.corrupt"]);
  const arrayRemaining = await readdir(arrayDir);
  assert.deepEqual(arrayRemaining, ["session.json.corrupt"]);
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

async function seedPdf(dataDir: string, sessionId: string, id: string, size: number, mtime: Date) {
  const folder = join(dataDir, sessionId, "downloads");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const pdfPath = join(folder, `${id}.pdf`);
  await writeFile(pdfPath, Buffer.alloc(size, 37), { mode: 0o600 });
  await writeFile(
    join(folder, `${id}.json`),
    JSON.stringify({ id, name: "document.pdf", size, mimeType: "application/pdf" }),
    { mode: 0o600 },
  );
  await utimes(pdfPath, mtime, mtime);
}

test("download quota evicts the oldest PDFs first across sessions", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-download-quota-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const sessionA = randomUUID();
  const sessionB = randomUUID();
  const oldId = "aaaaaaaa-1111-4111-8111-111111111111";
  const midId = "bbbbbbbb-2222-4222-8222-222222222222";
  const newId = "cccccccc-3333-4333-8333-333333333333";
  await seedPdf(dataDir, sessionA, oldId, 100, new Date("2026-01-01T00:00:00.000Z"));
  await seedPdf(dataDir, sessionB, midId, 100, new Date("2026-01-02T00:00:00.000Z"));
  await seedPdf(dataDir, sessionA, newId, 100, new Date("2026-01-03T00:00:00.000Z"));

  // 300 bytes total against a 250-byte quota: only the oldest goes.
  const result = await enforceDownloadQuota({ dataDir, quotaBytes: 250 });
  assert.deepEqual(result.evicted, [oldId]);
  assert.equal(result.totalBytes, 200);
  await assert.rejects(readFile(join(dataDir, sessionA, "downloads", `${oldId}.pdf`)), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(join(dataDir, sessionA, "downloads", `${oldId}.json`)), {
    code: "ENOENT",
  });
  assert.equal((await readFile(join(dataDir, sessionB, "downloads", `${midId}.pdf`))).length, 100);
  assert.equal((await readFile(join(dataDir, sessionA, "downloads", `${newId}.pdf`))).length, 100);

  // Under quota, enforcement is a no-op.
  assert.deepEqual(await enforceDownloadQuota({ dataDir, quotaBytes: 1000 }), {
    evicted: [],
    totalBytes: 200,
  });
});

test("download quota never evicts the just-published download", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-download-quota-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const session = randomUUID();
  const oldId = "aaaaaaaa-1111-4111-8111-111111111111";
  const midId = "bbbbbbbb-2222-4222-8222-222222222222";
  const newId = "cccccccc-3333-4333-8333-333333333333";
  await seedPdf(dataDir, session, oldId, 100, new Date("2026-01-01T00:00:00.000Z"));
  await seedPdf(dataDir, session, midId, 100, new Date("2026-01-02T00:00:00.000Z"));
  await seedPdf(dataDir, session, newId, 100, new Date("2026-01-03T00:00:00.000Z"));

  // 300 bytes against a 150-byte quota with the oldest protected: the
  // other two go instead, leaving only the just-published one.
  const result = await enforceDownloadQuota({
    dataDir,
    quotaBytes: 150,
    exceptId: oldId,
  });
  assert.deepEqual(result.evicted, [midId, newId]);
  assert.equal(result.totalBytes, 100);
  assert.equal((await readFile(join(dataDir, session, "downloads", `${oldId}.pdf`))).length, 100);
});

test("download quota parsing accepts bytes and rejects bad values", () => {
  assert.equal(parseDownloadQuotaBytes(undefined), undefined);
  assert.equal(parseDownloadQuotaBytes(""), undefined);
  assert.equal(parseDownloadQuotaBytes("   "), undefined);
  assert.equal(parseDownloadQuotaBytes("838860800"), 838860800);
  assert.equal(parseDownloadQuotaBytes("  123  "), 123);
  assert.throws(() => parseDownloadQuotaBytes("abc"), /WORKER_DOWNLOAD_QUOTA_BYTES/);
  assert.throws(() => parseDownloadQuotaBytes("0"), /WORKER_DOWNLOAD_QUOTA_BYTES/);
  assert.throws(() => parseDownloadQuotaBytes("-5"), /WORKER_DOWNLOAD_QUOTA_BYTES/);
  assert.throws(() => parseDownloadQuotaBytes("1.5"), /WORKER_DOWNLOAD_QUOTA_BYTES/);
});

const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "utf8",
);

async function listPublished(directory: string) {
  const names = await readdir(join(directory, "downloads")).catch(() => []);
  return names.filter((name) => name.endsWith(".json"));
}

test("capturePdfDownloadFromBytes publishes a valid PDF from bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-bytes-"));
  const tempDirectory = await mkdtemp(join(tmpdir(), "openmuse-download-bytes-tmp-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(tempDirectory, { recursive: true, force: true });
  });

  const published = await capturePdfDownloadFromBytes({
    directory,
    tempDirectory,
    limitReached: false,
    url: "http://1.1.1.1/report.pdf",
    contentDisposition: 'attachment; filename="report.pdf"',
    bytes: MINIMAL_PDF,
  });
  assert.equal(published, true);

  const metadataNames = await listPublished(directory);
  assert.equal(metadataNames.length, 1);
  const metadata = JSON.parse(
    await readFile(join(directory, "downloads", metadataNames[0]), "utf8"),
  ) as { id: string; name: string; size: number; mimeType: string };
  assert.equal(metadata.name, "report.pdf");
  assert.equal(metadata.size, MINIMAL_PDF.length);
  assert.equal(metadata.mimeType, "application/pdf");
  assert.equal(
    (await readFile(join(directory, "downloads", `${metadata.id}.pdf`))).subarray(0, 5).toString(),
    "%PDF-",
  );
  assert.deepEqual(await readDownloadFailures(directory), []);
});

test("capturePdfDownloadFromBytes records UNSUPPORTED_DOWNLOAD for non-PDF bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-bytes-"));
  const tempDirectory = await mkdtemp(join(tmpdir(), "openmuse-download-bytes-tmp-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(tempDirectory, { recursive: true, force: true });
  });

  const published = await capturePdfDownloadFromBytes({
    directory,
    tempDirectory,
    limitReached: false,
    url: "http://1.1.1.1/report.pdf",
    contentDisposition: 'attachment; filename="report.pdf"',
    bytes: Buffer.from("hello, not a pdf", "utf8"),
  });
  assert.equal(published, false);
  assert.deepEqual(await listPublished(directory), []);
  const failures = await readDownloadFailures(directory);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "UNSUPPORTED_DOWNLOAD");
  assert.equal(failures[0].name, "report.pdf");
});

test("capturePdfDownloadFromBytes records DOWNLOAD_TOO_LARGE for oversized bytes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-bytes-"));
  const tempDirectory = await mkdtemp(join(tmpdir(), "openmuse-download-bytes-tmp-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(tempDirectory, { recursive: true, force: true });
  });

  const published = await capturePdfDownloadFromBytes({
    directory,
    tempDirectory,
    limitReached: false,
    url: "http://1.1.1.1/big.pdf",
    bytes: Buffer.alloc(MAX_DOWNLOAD_BYTES + 1, 0x25),
  });
  assert.equal(published, false);
  assert.deepEqual(await listPublished(directory), []);
  const failures = await readDownloadFailures(directory);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "DOWNLOAD_TOO_LARGE");
});

test("capturePdfDownloadFromBytes records DOWNLOAD_LIMIT when the session limit is reached", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-bytes-"));
  const tempDirectory = await mkdtemp(join(tmpdir(), "openmuse-download-bytes-tmp-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
    await rm(tempDirectory, { recursive: true, force: true });
  });

  const published = await capturePdfDownloadFromBytes({
    directory,
    tempDirectory,
    limitReached: true,
    url: "http://1.1.1.1/report.pdf",
    bytes: MINIMAL_PDF,
  });
  assert.equal(published, false);
  assert.deepEqual(await listPublished(directory), []);
  const failures = await readDownloadFailures(directory);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "DOWNLOAD_LIMIT");
});

test("recordDownloadFailure persists the failure, clears the partial PDF, and trims to 100", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-download-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const oldestId = "00000000-0000-4000-8000-000000000000";
  for (let i = 0; i < 100; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    await seedOutcome(
      directory,
      `${id}.json`,
      failedOutcome(id, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()),
    );
  }
  const newId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  await seedDownload(directory, `${newId}.pdf`, "partial bytes");

  await recordDownloadFailure(directory, {
    id: newId,
    name: "report.pdf",
    code: "DOWNLOAD_TOO_LARGE",
    message: "The download exceeds 10 MiB. Choose a smaller PDF.",
    createdAt: new Date(Date.UTC(2026, 1, 1)).toISOString(),
  });

  // The partial PDF for the failed download is gone.
  await assert.rejects(readFile(join(directory, "downloads", `${newId}.pdf`)), {
    code: "ENOENT",
  });
  // 101 failures went in; only the 100 newest remain, oldest evicted.
  const failures = await readDownloadFailures(directory);
  assert.equal(failures.length, 100);
  assert.ok(failures.some((failure) => failure.id === newId));
  assert.ok(!failures.some((failure) => failure.id === oldestId));
  assert.equal(failures.find((failure) => failure.id === newId)?.code, "DOWNLOAD_TOO_LARGE");
});
