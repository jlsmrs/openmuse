import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { capturePdfDownload, readDownloadFailures } from "../apps/worker/src/downloads.ts";
import { createSamplePdf, inspectPdf } from "../packages/integrations/src/pdf.ts";

test("browser PDF downloads accept the same bounded header prefix as PDF imports", async (t) => {
  const pdf = await createSamplePdf();
  for (const prefix of [Buffer.alloc(0), Buffer.from([0xef, 0xbb, 0xbf, 0x0a])]) {
    const directory = await mkdtemp(join(tmpdir(), "openmuse-pdf-prefix-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bytes = Buffer.concat([prefix, pdf]);
    assert.equal((await inspectPdf(bytes)).pageCount, 2);
    await capturePdfDownload({
      directory,
      tempFiles: [],
      tempDirectory: directory,
      limitReached: false,
      download: {
        suggestedFilename: () => "form.pdf",
        createReadStream: async () =>
          Readable.from([
            bytes.subarray(0, prefix.length + 2),
            bytes.subarray(prefix.length + 2, prefix.length + 4),
            bytes.subarray(prefix.length + 4),
          ]),
        cancel: async () => {},
        delete: async () => {},
      },
    });
    assert.deepEqual(await readDownloadFailures(directory), []);
    const metadataFiles = (await readdir(join(directory, "downloads"))).filter((name) =>
      name.endsWith(".json"),
    );
    assert.equal(metadataFiles.length, 1);
    const metadata = JSON.parse(
      await readFile(join(directory, "downloads", metadataFiles[0]), "utf8"),
    );
    assert.equal(metadata.name, "form.pdf");
    assert.equal(metadata.size, bytes.length);
    assert.deepEqual(await readFile(join(directory, "downloads", `${metadata.id}.pdf`)), bytes);
  }
});

test("browser PDF downloads and imports reject a marker buried past the first bytes", async (t) => {
  const pdf = await createSamplePdf();
  const bytes = Buffer.concat([Buffer.alloc(1019, 32), pdf]);
  await assert.rejects(inspectPdf(bytes));
  const directory = await mkdtemp(join(tmpdir(), "openmuse-pdf-buried-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await capturePdfDownload({
    directory,
    tempFiles: [],
    tempDirectory: directory,
    limitReached: false,
    download: {
      suggestedFilename: () => "form.pdf",
      createReadStream: async () => Readable.from([bytes]),
      cancel: async () => {},
      delete: async () => {},
    },
  });
  assert.equal((await readDownloadFailures(directory))[0]?.code, "UNSUPPORTED_DOWNLOAD");
  assert.deepEqual(await readdir(join(directory, "downloads")), []);
});

test("browser PDF sniffing rejects late markers and non-ASCII lookalikes", async (t) => {
  for (const bytes of [
    Buffer.concat([Buffer.alloc(1020, 32), Buffer.from("%PDF-1.7")]),
    Buffer.from([0xa5, 0xd0, 0xc4, 0xc6, 0xad]),
    Buffer.from("not a PDF"),
  ]) {
    const directory = await mkdtemp(join(tmpdir(), "openmuse-pdf-invalid-prefix-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await capturePdfDownload({
      directory,
      tempFiles: [],
      tempDirectory: directory,
      limitReached: false,
      download: {
        suggestedFilename: () => "invalid.pdf",
        createReadStream: async () => Readable.from([bytes]),
        cancel: async () => {},
        delete: async () => {},
      },
    });
    assert.equal((await readDownloadFailures(directory))[0]?.code, "UNSUPPORTED_DOWNLOAD");
    assert.deepEqual(await readdir(join(directory, "downloads")), []);
  }
});

test("browser PDF capture enforces the total-download quota, oldest first", async (t) => {
  const pdf = await createSamplePdf();
  const dataDir = await mkdtemp(join(tmpdir(), "openmuse-pdf-quota-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const directory = join(dataDir, randomUUID());
  const folder = join(directory, "downloads");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const oldId = "aaaaaaaa-1111-4111-8111-111111111111";
  const oldPdf = join(folder, `${oldId}.pdf`);
  await writeFile(oldPdf, Buffer.alloc(100, 37), { mode: 0o600 });
  await writeFile(
    join(folder, `${oldId}.json`),
    JSON.stringify({ id: oldId, name: "old.pdf", size: 100, mimeType: "application/pdf" }),
    { mode: 0o600 },
  );
  const oldTime = new Date("2020-01-01T00:00:00.000Z");
  await utimes(oldPdf, oldTime, oldTime);

  await capturePdfDownload({
    directory,
    dataDir,
    quotaBytes: 100,
    tempFiles: [],
    tempDirectory: directory,
    limitReached: false,
    download: {
      suggestedFilename: () => "form.pdf",
      createReadStream: async () => Readable.from([pdf]),
      cancel: async () => {},
      delete: async () => {},
    },
  });

  // The seeded PDF (oldest) was evicted with its metadata; the new one kept.
  await assert.rejects(readFile(oldPdf), { code: "ENOENT" });
  await assert.rejects(readFile(join(folder, `${oldId}.json`)), { code: "ENOENT" });
  const remaining = await readdir(folder);
  assert.equal(remaining.filter((name) => name.endsWith(".pdf")).length, 1);
  assert.equal(remaining.filter((name) => name.endsWith(".json")).length, 1);
  const metadataName = remaining.find((name) => name.endsWith(".json"));
  assert.ok(metadataName);
  const metadata = JSON.parse(await readFile(join(folder, metadataName), "utf8"));
  assert.equal(metadata.name, "form.pdf");
  assert.equal(metadata.size, pdf.length);
  assert.deepEqual(await readDownloadFailures(directory), []);
});
