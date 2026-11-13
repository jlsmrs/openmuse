import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Download } from "playwright";

export const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024;

/**
 * Total-download quota, enforced by evicting the oldest PDFs first.
 * The per-session caps alone allow 20 profiles × 20 PDFs × 10 MiB
 * (~3.9 GiB), so a deployment whose disk is smaller than that needs a
 * total quota or the disk can fill before any per-session limit trips
 * (G2). The quota is a deployment policy: it is only enforced when a
 * value is configured (WORKER_DOWNLOAD_QUOTA_BYTES, declared by the
 * Render template); when unset, the store keeps the current unbounded
 * behavior — the live Azure worker's disk dwarfs the per-session-cap
 * maximum, so no quota is needed there.
 */
export function parseDownloadQuotaBytes(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error("WORKER_DOWNLOAD_QUOTA_BYTES must be a positive integer number of bytes.");
  return parsed;
}

export interface EvictionResult {
  evicted: string[];
  totalBytes: number;
}

/**
 * Enforce a total quota on published PDFs across every session under
 * `dataDir`, evicting the oldest first. A PDF and its metadata file are
 * removed together, so an evicted download stops listing. The
 * just-published download (`exceptId`) is never evicted. Best-effort
 * per file: an unreadable entry is skipped, never counted, and never
 * blocks the rest.
 */
export async function enforceDownloadQuota(options: {
  dataDir: string;
  quotaBytes: number;
  exceptId?: string;
}): Promise<EvictionResult> {
  const { dataDir, quotaBytes, exceptId } = options;
  interface Entry {
    id: string;
    size: number;
    mtimeMs: number;
    pdfPath: string;
    metadataPath: string;
  }
  const entries: Entry[] = [];
  for (const session of await readdir(dataDir).catch(() => [])) {
    const folder = join(dataDir, session, "downloads");
    for (const name of await readdir(folder).catch(() => [])) {
      if (!name.endsWith(".pdf")) continue;
      const pdfPath = join(folder, name);
      const info = await stat(pdfPath).catch(() => null);
      if (!info?.isFile()) continue;
      const id = name.slice(0, -".pdf".length);
      entries.push({
        id,
        size: info.size,
        mtimeMs: info.mtimeMs,
        pdfPath,
        metadataPath: join(folder, `${id}.json`),
      });
    }
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  let totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  const evicted: string[] = [];
  for (const entry of entries) {
    if (totalBytes <= quotaBytes) break;
    if (entry.id === exceptId) continue;
    await rm(entry.pdfPath, { force: true }).catch(() => {});
    await rm(entry.metadataPath, { force: true }).catch(() => {});
    totalBytes -= entry.size;
    evicted.push(entry.id);
  }
  return { evicted, totalBytes };
}

/**
 * The "%PDF-" marker must start within the first 5 bytes of the file
 * (offset 0, or after a 3-byte UTF-8 BOM with an optional line feed).
 * Defined locally, not imported: the worker image contains only
 * apps/worker, so a cross-package import (packages/...) resolves in the
 * repo-root test run but crash-loops the deployed worker with
 * ERR_MODULE_NOT_FOUND (S-B7 did exactly that). Keep in agreement with
 * pdfMarkerAtStart() in packages/integrations/src/pdf.ts — the
 * browser-pdf-prefix tests pin both paths to the same cases.
 */
function pdfMarkerAtStart(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 9)).indexOf("%PDF-") >= 0;
}
export interface PdfDownload {
  id: string;
  name: string;
  size: number;
  mimeType: "application/pdf";
}
export interface DownloadFailure {
  id: string;
  name: string;
  code: string;
  message: string;
  createdAt: string;
}
type Outcome = DownloadFailure & { status: "pending" | "failed" };

async function persist(path: string, value: unknown) {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

function parseOutcome(text: string): Outcome {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid download outcome");
  }
  const { id, status, createdAt } = value as Partial<Outcome>;
  if (
    typeof id !== "string" ||
    (status !== "pending" && status !== "failed") ||
    typeof createdAt !== "string"
  ) {
    throw new Error("Invalid download outcome");
  }
  return value as Outcome;
}

export async function quarantineFile(path: string) {
  // Best effort only: never delete a corrupt bookkeeping file — move it
  // aside so the operator can inspect it, and so it stops breaking every read.
  let target = `${path}.corrupt`;
  for (let attempt = 1; await stat(target).catch(() => null); attempt++) {
    target = `${path}.corrupt-${attempt}`;
  }
  await rename(path, target).catch(() => {});
}

export async function readDownloadFailures(directory: string, recoverInterrupted = false) {
  const folder = join(directory, "download-outcomes");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const failures: DownloadFailure[] = [];
  for (const name of await readdir(folder)) {
    if (!name.endsWith(".json")) continue;
    const path = join(folder, name);
    let outcome: Outcome;
    try {
      outcome = parseOutcome(await readFile(path, "utf8"));
    } catch {
      // One corrupt bookkeeping file must not fail the whole read (or
      // worker startup): move it aside and keep the healthy outcomes.
      // Only the read+parse is guarded here: a failure in the recovery
      // steps below (inspecting metadata, clearing unpublished files,
      // recording the failure) must reject instead, so the journal stays
      // pending and the next recovery can retry the cleanup.
      await quarantineFile(path);
      continue;
    }
    if (outcome.status === "pending" && recoverInterrupted) {
      const metadata = await stat(join(directory, "downloads", `${outcome.id}.json`)).catch(
        (error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (metadata) {
        await rm(path, { force: true });
        continue;
      }
      // Clear unpublished files first so an incomplete cleanup can be retried.
      await rm(join(directory, "downloads", `${outcome.id}.pdf`), { force: true });
      await rm(join(directory, "downloads", `${outcome.id}.json.tmp`), { force: true });
      outcome.status = "failed";
      await persist(path, outcome);
    }
    if (outcome.status === "failed") {
      const { status: _status, ...failure } = outcome;
      failures.push(failure);
    }
  }
  return failures.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function capturePdfDownload(options: {
  directory: string;
  tempDirectory: string;
  /**
   * In-flight temp filenames belonging to this capture (the `.crdownload`
   * names the browser created for it, established by the caller diffing
   * the temp dir when the download event fired). Chromium names an
   * in-flight download `<uuid>.crdownload`, and that UUID is not exposed
   * by the Download object — so ownership is by event-time diff, never
   * by scanning the whole directory: a stale leftover or another
   * concurrent download's file must not cancel this capture.
   */
  tempFiles: string[];
  limitReached: boolean;
  /**
   * The worker data dir (the parent of the per-session directories) and
   * the total-download quota to enforce after a publish. Both are
   * optional: when either is absent no total quota is enforced, which
   * preserves the current behavior on deployments that do not declare
   * one (the Render template declares WORKER_DOWNLOAD_QUOTA_BYTES).
   */
  dataDir?: string;
  quotaBytes?: number;
  download: Pick<Download, "suggestedFilename" | "createReadStream" | "cancel" | "delete">;
}) {
  const { directory, tempDirectory, tempFiles, download, limitReached, dataDir, quotaBytes } =
    options;
  const folder = join(directory, "downloads");
  const outcomes = join(directory, "download-outcomes");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await mkdir(outcomes, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const name =
    download
      .suggestedFilename()
      .replace(/[^a-zA-Z0-9._ -]/g, "_")
      .slice(0, 180) || "download";
  const outcome: Outcome = {
    id,
    name,
    status: "pending",
    code: "DOWNLOAD_INTERRUPTED",
    message: "The download was interrupted or could not be retrieved. Try downloading it again.",
    createdAt: new Date().toISOString(),
  };
  const outcomePath = join(outcomes, `${id}.json`);
  const destination = join(folder, `${id}.pdf`);
  // A worker restart can now report an interrupted transfer even if Chromium
  // never reaches its completion callback.
  await persist(outcomePath, outcome);
  let monitor: ReturnType<typeof setInterval> | undefined;
  let oversized = false;
  let published = false;
  try {
    if (limitReached) {
      outcome.code = "DOWNLOAD_LIMIT";
      outcome.message = "This session has reached its 20 PDF download limit.";
      await download.cancel();
      throw new Error("Download limit reached");
    }
    monitor = setInterval(() => {
      // Only this capture's in-flight files are watched. The pipeline
      // byte counter below is the primary cap; the monitor is the backstop
      // for a stream that stalls while Chromium keeps writing to disk.
      void (async () => {
        for (const file of tempFiles) {
          const info = await stat(join(tempDirectory, file)).catch(() => null);
          if (info?.isFile() && info.size > MAX_DOWNLOAD_BYTES) {
            oversized = true;
            await download.cancel();
          }
        }
      })().catch(() => {});
    }, 100);
    const source = await download.createReadStream();
    if (!source) throw new Error("Download unavailable");
    let bytes = 0;
    let prefix = Buffer.alloc(0);
    await pipeline(
      source,
      new Transform({
        transform(chunk: Buffer, _encoding, done) {
          bytes += chunk.length;
          if (prefix.length < 9)
            prefix = Buffer.concat([prefix, chunk.subarray(0, 9 - prefix.length)]);
          if (bytes > MAX_DOWNLOAD_BYTES) {
            oversized = true;
            done(new Error("Download too large"));
          } else done(null, chunk);
        },
      }),
      createWriteStream(destination, { mode: 0o600, flags: "wx" }),
    );
    // Match the importer's marker-at-start check, without lossy ASCII decoding.
    if (!pdfMarkerAtStart(prefix)) {
      outcome.code = "UNSUPPORTED_DOWNLOAD";
      outcome.message = "Only PDF downloads can be imported. This file was not a PDF.";
      throw new Error("Unsupported download");
    }
    const metadata: PdfDownload = {
      id,
      name: name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`,
      size: bytes,
      mimeType: "application/pdf",
    };
    await persist(join(folder, `${id}.json`), metadata);
    published = true;
    await rm(outcomePath, { force: true });
    // Enforce the deployment's total-download quota (G2): the
    // per-session caps alone allow ~3.9 GiB, so without a total quota
    // the store can fill the disk before any per-session limit trips.
    // Eviction is best-effort and never fails a successful capture.
    if (quotaBytes !== undefined && dataDir !== undefined) {
      await enforceDownloadQuota({ dataDir, quotaBytes, exceptId: id }).catch(() => {});
    }
  } catch (error) {
    // Once metadata is visible, its PDF must remain available even if clearing
    // the transfer journal fails. Restart recovery reconciles that journal.
    if (published) throw error;
    if (oversized) {
      outcome.code = "DOWNLOAD_TOO_LARGE";
      outcome.message = "The download exceeds 10 MiB. Choose a smaller PDF.";
    }
    outcome.status = "failed";
    await persist(outcomePath, outcome);
    await rm(destination, { force: true });
    // Keep a bounded recent failure history alongside the bounded PDF store.
    for (const stale of (await readDownloadFailures(directory)).slice(100)) {
      await rm(join(outcomes, `${stale.id}.json`), { force: true });
    }
  } finally {
    clearInterval(monitor);
    await download.delete().catch(() => {});
  }
}
