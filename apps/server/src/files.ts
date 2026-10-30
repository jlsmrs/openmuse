import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Artifact } from "../../../packages/domain/src/index.ts";
import { fillPdf, inspectPdf, type PdfInspection } from "../../../packages/integrations/src/pdf.ts";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { isExtractableDocumentMime } from "./engine/document-text.ts";
import { isVisionMime } from "./engine/vision.ts";
import { AppError } from "./errors.ts";

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

const MAX_FILE_BYTES = 10 * 1024 * 1024;

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

export function mimeTypeForFile(name: string, provided?: string): string {
  const clean = (provided ?? "").split(";")[0].trim().toLowerCase();
  if (clean && clean !== "application/octet-stream") return clean;
  return MIME_BY_EXTENSION[extensionOf(name)] ?? "application/octet-stream";
}

// Formats Charlie can actually read as text in chat (via read_workspace_file).
export function isTextReadableMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json");
}

// Plain-language readability note for a stored file. Used by the agent tool so
// an unreadable file is flagged, never silently ignored or faked.
export function readabilityNote(mime: string): string {
  if (isTextReadableMime(mime)) return "readable as text in chat";
  if (mime === "application/pdf") return "PDF — page text via document intake";
  if (mime.startsWith("image/"))
    return isVisionMime(mime)
      ? "image — shown to the model in chat"
      : "image type cannot be viewed in chat";
  if (isExtractableDocumentMime(mime)) return "office document — text is extracted for chat";
  if (
    mime === "application/msword" ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.ms-powerpoint"
  ) {
    return "legacy binary Office format — text extraction is not available in chat";
  }
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

export class Files {
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly auth: Auth,
  ) {}
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
      if (existing) return this.signed(owner, existing);
    }
    if (bytes.length > MAX_FILE_BYTES) throw new AppError("Files must be 10 MB or smaller", 413);
    const safeName = sanitizeFileName(name);
    const mime = mimeTypeForFile(safeName, mimeType);
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
    return { ...file, url: this.auth.sign(owner, `/api/files/${file.id}/content`) };
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
