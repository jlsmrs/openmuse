import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Artifact, FormKind } from "../../../packages/domain/src/index.ts";
import { fillPdf, inspectPdf, type PdfInspection } from "../../../packages/integrations/src/pdf.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { isIndeterminateCommit, type Store } from "./db.ts";
import { isExtractableDocumentMime } from "./engine/document-text.ts";
import { isConvertibleImageMime, isVisionMime } from "./engine/vision.ts";
import { AppError } from "./errors.ts";
import { reportBackgroundFailure } from "./log.ts";

const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "document.pdf";
  // Slice code points, not UTF-16 units, so a surrogate pair is never split in half.
  const cleaned = Array.from(base)
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .slice(0, 180)
    .join("");
  return cleaned || "document.pdf";
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** One audited cross-company pull: who pulled what, from where, to where, when. */
export interface FilePullAudit {
  id: string;
  who: string;
  fileId: string;
  fileName: string;
  sourceId: string;
  from: string;
  to: string;
  when: string;
}
export const FILE_PULL_AUDIT_COLLECTION = "file-pull-audit";

// MIME types the workspace recognises by file extension. Anything else is
// still accepted and stored — it is recorded as application/octet-stream and
// flagged as not text-readable, never rejected for its type.
const MIME_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  xml: "text/xml",
  html: "text/html",
  htm: "text/html",
  log: "text/plain",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
  tar: "application/x-tar",
  tgz: "application/gzip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
};

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(base);
  return match ? match[1].toLowerCase() : "";
}

/** Every MIME type the workspace recognises by extension. */
const KNOWN_MIME_TYPES = new Set(Object.values(MIME_BY_EXTENSION));

export function mimeTypeForFile(name: string, provided?: string): string {
  const clean = (provided ?? "").split(";")[0].trim().toLowerCase();
  const byExtension = MIME_BY_EXTENSION[extensionOf(name)] ?? "application/octet-stream";
  // A caller-supplied type is a claim, not evidence: accept it only when it
  // agrees with the extension, or when the extension says nothing and the
  // claim is a type the workspace recognises. A mismatched claim (e.g. HTML
  // bytes uploaded as "text/plain", or a PDF claimed as an image) never
  // becomes the stored type.
  if (clean && clean !== "application/octet-stream") {
    if (clean === byExtension) return clean;
    if (byExtension === "application/octet-stream" && KNOWN_MIME_TYPES.has(clean)) return clean;
  }
  return byExtension;
}

function startsWith(bytes: Uint8Array, prefix: number[] | string): boolean {
  if (typeof prefix === "string") {
    if (bytes.length < prefix.length) return false;
    for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix.charCodeAt(i)) return false;
    return true;
  }
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return false;
  return true;
}

/**
 * Identify a file's type from its bytes, not from what the uploader claimed.
 * Returns undefined when the bytes match no known signature; the caller then
 * falls back to the extension-derived type. ZIP is deliberately included:
 * office documents are ZIP containers, so the caller keeps the extension
 * type when the sniffed type is ZIP and the extension names an office
 * document — a real ZIP stays application/zip.
 */
export function sniffMimeType(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return "image/gif";
  if (startsWith(bytes, "%PDF-")) return "application/pdf";
  if (
    startsWith(bytes, "RIFF") &&
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  )
    return "image/webp";
  if (
    startsWith(bytes, "RIFF") &&
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WAVE"
  )
    return "audio/wav";
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]))
    return "image/tiff";
  if (startsWith(bytes, "BM")) return "image/bmp";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]))
    return "application/zip";
  if (startsWith(bytes, [0x1f, 0x8b])) return "application/gzip";
  if (startsWith(bytes, "ID3")) return "audio/mpeg";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    (bytes[1] & 0xe0) === 0xe0 &&
    ((bytes[1] >> 1) & 0x3) !== 0
  )
    return "audio/mpeg";
  if (bytes.length >= 8 && String.fromCharCode(...bytes.subarray(4, 8)) === "ftyp")
    return "video/mp4";
  // Text that opens with an HTML or SVG tag is active content, whatever the
  // filename or the claimed type says.
  const text = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, 512))
    .replace(/^\uFEFF/, "")
    .trimStart();
  if (/^<!doctype html|^<html[\s>]/i.test(text)) return "text/html";
  if (/^<svg[\s>]/i.test(text)) return "image/svg+xml";
  return undefined;
}

// Formats Charlie can actually read as text in chat (via read_workspace_file).
export function isTextReadableMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json");
}

// Plain-language readability note for a stored file. Used by the agent tool so
// an unreadable file is flagged, never silently ignored or faked.
export function readabilityNote(mime: string): string {
  if (isTextReadableMime(mime)) return "readable as text in chat";
  if (mime === "application/pdf") return "PDF — full text is extracted for chat";
  if (mime.startsWith("image/")) {
    if (isVisionMime(mime)) return "image — shown to the model in chat";
    if (isConvertibleImageMime(mime))
      return "image — converted to PNG and shown to the model in chat";
    return "image type cannot be viewed in chat";
  }
  if (isExtractableDocumentMime(mime)) return "office document — text is extracted for chat";
  if (mime === "application/vnd.ms-powerpoint")
    return "legacy binary PowerPoint format — text extraction is not available in chat";
  if (
    mime === "application/zip" ||
    mime === "application/x-zip-compressed" ||
    mime === "application/x-zip" ||
    mime === "application/x-tar" ||
    mime === "application/gzip"
  )
    return "archive — members are read through the same pipeline in chat";
  return "stored but not readable as text in chat";
}

function assertFileId(id: string): void {
  if (!FILE_ID.test(id)) throw new AppError("File not found", 404);
}

// Keyed operations need the same ID on every retry, so the ID is derived from the
// owner and operation key instead of random. It is shaped as a version 5 UUID
// (first 128 bits of a SHA-256 hash, version and variant bits set) so it is
// accepted anywhere a random file UUID is.
export function deterministicFileId(owner: string, operationKey: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify([owner, operationKey]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** One row of a file's lineage: provenance only. No field values, no
 * applied field map, and no signed URL ever cross owners here — the
 * chain (ids, names, times) is what lineage reconstructs, and
 * the full Artifact rows stay behind the owner-scoped `get`. (M5,
 * round 4: the old comment promised "owners" here, but this entry
 * carries no owner field — the chain is identified by ids, names, and
 * times, and the starting file's owner is the caller's.) */
export interface FileLineageEntry {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  pageCount: number;
  formKind: FormKind;
  source: string;
  parentId?: string;
  createdAt: string;
}

/**
 * Strict ISO date/datetime validation for search `from`/`to` (re-review
 * #2 minor): `Date.parse` alone is not calendar-strict — "2026-02-30"
 * normalizes to March 2 instead of rejecting. Only ISO date-only
 * (YYYY-MM-DD) and ISO datetimes are accepted, and the calendar date
 * must really exist (month 1–12, day within the month, leap years
 * honoured) with a valid time of day. Returns the epoch-ms instant, or
 * throws a 422 naming the value. The days-in-month check is arithmetic
 * (M3, round 4), never `new Date(Date.UTC(year, month, 0))`: Date.UTC
 * remaps years 0–99 to 1900–1999, which wrongly rejected the valid
 * leap date 0000-02-29. Timezone-less datetimes are interpreted in the
 * server's local timezone (M4, round 4): that is `Date.parse`
 * behaviour, documented in the SPEC's date semantics — a bare
 * `2026-11-18T12:00:00` is not UTC unless it carries a `Z` or offset.
 */
export function parseSearchDate(value: string): number {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const match =
    dateOnly ??
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
      value,
    );
  if (!match) throw new AppError(`Search date '${value}' is not a valid ISO date`, 422);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Arithmetic leap years (proleptic Gregorian): divisible by 4, except
  // centuries, except centuries divisible by 400. Year 0 is divisible
  // by 400, so 0000-02-29 exists; 0100-02-29 does not.
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth =
    month >= 1 && month <= 12
      ? [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
      : 0;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth)
    throw new AppError(`Search date '${value}' is not a real calendar date`, 422);
  if (match[4] !== undefined) {
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = match[6] === undefined ? 0 : Number(match[6]);
    if (hour > 23 || minute > 59 || second > 59)
      throw new AppError(`Search date '${value}' is not a valid time`, 422);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed))
    throw new AppError(`Search date '${value}' is not a valid ISO date`, 422);
  return parsed;
}

/** True when the value is a strict ISO date/datetime (see parseSearchDate). */
export function isValidSearchDate(value: string): boolean {
  try {
    parseSearchDate(value);
    return true;
  } catch {
    return false;
  }
}

function toLineageEntry(file: Artifact): FileLineageEntry {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    pageCount: file.pageCount,
    formKind: file.formKind ?? "none",
    source: file.source,
    ...(file.parentId !== undefined ? { parentId: file.parentId } : {}),
    createdAt: file.createdAt,
  };
}

export class Files {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
  ) {}
  private async bytesExist(id: string, name: string): Promise<boolean> {
    try {
      await stat(this.pathFor(id, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /**
   * The stored type follows the bytes: a sniffed signature wins, except a
   * ZIP sniff on an office extension stays the office type (docx/xlsx/pptx
   * are ZIP containers). With no sniffed signature the extension-derived
   * type wins over the caller-supplied claim.
   */
  private mimeTypeForImport(name: string, provided: string | undefined, bytes: Uint8Array): string {
    const sniffed = sniffMimeType(bytes);
    if (sniffed) {
      const byExtension = MIME_BY_EXTENSION[extensionOf(name)];
      if (
        sniffed === "application/zip" &&
        (byExtension ===
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
          byExtension === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
          byExtension ===
            "application/vnd.openxmlformats-officedocument.presentationml.presentation")
      )
        return byExtension;
      return sniffed;
    }
    return mimeTypeForFile(name, provided);
  }

  async import(
    owner: string,
    name: string,
    bytes: Uint8Array,
    source: string,
    parentId?: string,
    operationKey?: string,
    mimeType?: string,
  ): Promise<Artifact> {
    const id = operationKey === undefined ? randomUUID() : deterministicFileId(owner, operationKey);
    if (operationKey !== undefined) {
      const existing = await this.db.get<Artifact>(owner, "files", id);
      if (existing) {
        // The row can outlive its bytes (data dir wiped, restored from a
        // backup, moved): verify the bytes are still on disk before
        // returning the row, and re-import when they are gone.
        if (await this.bytesExist(id, existing.name)) return this.signed(owner, existing);
      }
    }
    if (bytes.length > MAX_FILE_BYTES) throw new AppError("Files must be 10 MB or smaller", 413);
    const safeName = sanitizeFileName(name);
    const mime = this.mimeTypeForImport(safeName, mimeType, bytes);
    const isPdf = mime === "application/pdf";
    // PDFs keep the existing inspection (page count + form fields). Every
    // other type is accepted as-is: pageCount 0, no fields, stored under its
    // real extension. Nothing is rejected for its type.
    let metadata: PdfInspection | undefined;
    if (isPdf) {
      metadata = await inspectPdf(bytes);
      if (metadata.pageCount > 500) throw new AppError("PDFs must have 500 pages or fewer", 422);
    }
    const directory = join(this.config.dataDir, "files");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = this.pathFor(id, safeName);
    if (operationKey === undefined) {
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    } else {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
        try {
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            bytes = await readFile(path);
            if (isPdf) metadata = await inspectPdf(bytes);
          } else if ((error as NodeJS.ErrnoException).code === "ENOTSUP") {
            // Azure Files (SMB) does not support hard links: fall back to rename.
            try {
              bytes = await readFile(path);
              if (isPdf) metadata = await inspectPdf(bytes);
            } catch (readError) {
              if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
              await rename(temporary, path);
            }
          } else throw error;
        }
      } finally {
        await rm(temporary, { force: true });
      }
    }
    const artifact: Artifact = {
      id,
      name: safeName,
      mimeType: mime,
      size: bytes.length,
      pageCount: metadata?.pageCount ?? 0,
      fields: metadata?.fields,
      formKind: metadata?.formKind ?? "none",
      url: "",
      createdAt: new Date().toISOString(),
      source,
      parentId,
    };
    if (operationKey === undefined) {
      await this.db.put(owner, "files", artifact);
      return this.signed(owner, artifact);
    }
    const persisted = await this.db.insertIfAbsent(owner, "files", artifact);
    return this.signed(owner, persisted ?? (await this.get(owner, id)));
  }
  signed(owner: string, file: Artifact): Artifact {
    // The returned Artifact projection: legacy rows imported before B1
    // have no formKind on their row, and they report "none" until
    // re-imported (the pre-B1 kind is never guessed). The fallback lives
    // here so list() and search() — both of which project through
    // signed() — report it, not just the search filter.
    return {
      ...file,
      formKind: file.formKind ?? "none",
      url: this.auth.sign(owner, `/api/files/${file.id}/content`),
    };
  }
  async list(owner: string) {
    return (await this.db.list<Artifact>(owner, "files")).map((file) => this.signed(owner, file));
  }
  async get(owner: string, id: string) {
    assertFileId(id);
    const file = await this.db.get<Artifact>(owner, "files", id);
    if (!file) throw new AppError("File not found", 404);
    return file;
  }
  /**
   * Search the caller's own files (milestone 1: filter-over-list — the
   * corpus is hundreds of files, not millions). Substring match over the
   * file name and over field names/values, plus formKind and createdAt
   * filters. Owner-scoped: another owner's files can never match.
   * Returned rows keep the existing Artifact shape, INCLUDING field
   * values — search returns full Artifact rows to their owner, exactly
   * as list() does. The no-snippet rule only prevents a SEPARATE
   * snippet surface (field values excerpted into logs or other
   * surfaces); it does not redact the rows themselves. Including field
   * values in search results is Josh's P1-1 decision (Nov 18, 2026:
   * INCLUDE) — search stays as-is.
   * Date-interval semantics: `from` is inclusive of its start (a bare
   * date means the start of that day); `to` is inclusive of the whole
   * day when given as a bare date (2026-11-18 matches files created at
   * any time that day) and inclusive of the instant when given as a full
   * timestamp. `from` after `to` is a 422, and so is a date that is not
   * a real calendar date (`2026-02-30` normalizes under `Date.parse`,
   * so bounds are validated strictly — see parseSearchDate).
   */
  async search(
    owner: string,
    query: { q?: string; formKind?: FormKind; from?: string; to?: string },
  ): Promise<Artifact[]> {
    const needle = query.q?.trim().toLowerCase();
    const from = query.from === undefined ? Number.NaN : parseSearchDate(query.from);
    let to = query.to === undefined ? Number.NaN : parseSearchDate(query.to);
    if (Number.isFinite(to) && /^\d{4}-\d{2}-\d{2}$/.test(query.to ?? "")) to += 86400000 - 1;
    if (Number.isFinite(from) && Number.isFinite(to) && from > to)
      throw new AppError("Search date range is invalid: 'from' must be on or before 'to'", 422);
    return (await this.list(owner)).filter((file) => {
      if (query.formKind !== undefined && (file.formKind ?? "none") !== query.formKind)
        return false;
      const createdAt = Date.parse(file.createdAt);
      if (Number.isFinite(from) && createdAt < from) return false;
      if (Number.isFinite(to) && createdAt > to) return false;
      if (!needle) return true;
      if (file.name.toLowerCase().includes(needle)) return true;
      return (file.fields ?? []).some(
        (field) =>
          field.name.toLowerCase().includes(needle) || field.value.toLowerCase().includes(needle),
      );
    });
  }
  /**
   * Cross-company pull: an explicit, audited COPY of one file into
   * another owner's workspace. Type-agnostic — bytes + the metadata row
   * are copied as-is, so PDFs, Office docs, text, images, audio/video,
   * archives, and application/octet-stream all pull the same way; no
   * PDF-specific logic lives anywhere in this path. The source row is
   * untouched and the copy gets a fresh id, `parentId` = source id, and
   * `source` = "Pulled from <source-owner>/<id>". The audit entry is
   * written in the same database transaction as the copy, so the two
   * commit or roll back together: a failed audit write can never leave
   * a visible, unaudited copy. The bytes file is written before the
   * transaction and removed again if the transaction fails before its
   * work completes (a removal failure is logged loudly, never
   * swallowed). Once the work has completed, the outcome is
   * unknown-or-committed — a lost COMMIT acknowledgement, a
   * commit-phase failure, or a wrapper throwing after commit — and the
   * bytes are RETAINED, never deleted (B-1, round 6): only a failure
   * inside the work callback establishes a rollback. Retained bytes
   * from a genuinely rolled-back commit are orphaned files under
   * dataDir/files, left for operator reconciliation.
   */
  async pull(owner: string, id: string, toOwner: string): Promise<Artifact> {
    if (typeof toOwner !== "string" || toOwner.trim() === "" || toOwner !== toOwner.trim())
      throw new AppError("A target workspace is required", 422);
    // Same hygiene as sanitizeFileName: no path separators, no control characters.
    if (
      toOwner.includes("/") ||
      toOwner.includes("\\") ||
      [...toOwner].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
    )
      throw new AppError("Target workspace is invalid", 422);
    if (toOwner === owner) throw new AppError("File is already in this workspace", 422);
    // Read access to the source is required: without it this is a 404,
    // not a 403 with details — existence must not leak.
    const source = await this.get(owner, id);
    const bytes = await this.bytes(owner, id);
    const newId = randomUUID();
    const directory = join(this.config.dataDir, "files");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = this.pathFor(newId, source.name);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    const when = new Date().toISOString();
    const artifact: Artifact = {
      ...source,
      id: newId,
      url: "",
      createdAt: when,
      source: `Pulled from ${owner}/${id}`,
      parentId: id,
    };
    const audit: FilePullAudit = {
      id: randomUUID(),
      who: owner,
      fileId: newId,
      fileName: source.name,
      sourceId: id,
      from: owner,
      to: toOwner,
      when,
    };
    // The bytes file is removed ONLY when non-commit is established:
    // the work callback threw before COMMIT was attempted, so the
    // transaction rolled the copy and the audit entry back together
    // (B-1, round 6). Once the work completed, the outcome is
    // unknown-or-committed — a lost COMMIT acknowledgement, a
    // commit-phase failure (marked indeterminate by the pg
    // transaction), or a wrapper that threw after commit — and
    // deleting the bytes could destroy a committed copy's data, so
    // they are retained and the failure is logged loudly for
    // reconciliation instead. A removal failure is logged loudly,
    // never swallowed.
    let workCompleted = false;
    try {
      await this.db.transaction(async (tx) => {
        await tx.put(toOwner, "files", artifact);
        await tx.put("system", FILE_PULL_AUDIT_COLLECTION, audit);
        workCompleted = true;
      });
    } catch (error) {
      if (!workCompleted && !isIndeterminateCommit(error)) {
        await rm(path, { force: true }).catch((removeError: unknown) =>
          reportBackgroundFailure("file pull cleanup", removeError),
        );
      } else {
        // (B-1, round 9) The log call is the shared non-throwing
        // wrapper: a throwing logger must never replace the original
        // transaction error the `throw error` below rethrows.
        reportBackgroundFailure("file pull indeterminate commit — bytes retained", error);
      }
      throw error;
    }
    return this.signed(toOwner, artifact);
  }
  /**
   * Full lineage of a file, oldest → newest, by walking parentId links
   * across owners (a hop lives under its target owner, so the walk reads
   * the whole files table, not one owner's rows). Rows are
   * provenance-only (see FileLineageEntry): the chain (ids, names,
   * times) — never field values or signed URLs. A missing or deleted
   * ancestor ends the chain; a cycle cannot loop forever.
   */
  async lineage(owner: string, id: string): Promise<FileLineageEntry[]> {
    const start = await this.get(owner, id);
    const byId = new Map(
      (await this.db.scan<Artifact>("files")).map((row) => [row.value.id, row.value]),
    );
    const chain: FileLineageEntry[] = [toLineageEntry(start)];
    const seen = new Set([start.id]);
    let current = start;
    while (current.parentId !== undefined && !seen.has(current.parentId)) {
      const parent = byId.get(current.parentId);
      if (!parent) break;
      seen.add(parent.id);
      chain.push(toLineageEntry(parent));
      current = parent;
    }
    return chain.reverse();
  }
  private pathFor(id: string, name?: string): string {
    assertFileId(id);
    const directory = resolve(this.config.dataDir, "files");
    // Legacy rows (and callers without a name) are PDFs stored as <id>.pdf.
    // New rows store under their real extension so the bytes round-trip.
    const ext = name === undefined ? "pdf" : extensionOf(name);
    const resolved = resolve(directory, `${id}${ext ? `.${ext}` : ""}`);
    if (!resolved.startsWith(`${directory}${sep}`)) throw new AppError("File not found", 404);
    return resolved;
  }
  async bytes(owner: string, id: string) {
    const file = await this.get(owner, id);
    return readFile(this.pathFor(id, file.name));
  }
  async fill(
    owner: string,
    id: string,
    values: Record<string, string | boolean>,
    operationKey?: string,
  ) {
    const file = await this.get(owner, id);
    if (file.mimeType !== "application/pdf")
      throw new AppError("Only PDF forms can be filled", 422);
    const bytes = await this.bytes(owner, id);
    const output = await fillPdf(bytes, values);
    return this.import(
      owner,
      `${file.name.replace(/\.pdf$/i, "")} — filled.pdf`,
      output,
      `Filled from ${file.name}`,
      id,
      operationKey === undefined
        ? undefined
        : JSON.stringify([
            "fill",
            operationKey,
            id,
            Object.keys(values)
              .sort()
              .map((name) => [name, values[name]]),
          ]),
    );
  }
}
