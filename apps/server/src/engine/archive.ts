// Archive reading for read_workspace_file: unpack an archive and run every
// member through the same convert-then-read pipeline as a top-level file —
// text is read, office documents and PDFs are extracted, images are sent to
// vision (including BMP/TIFF conversion), nested archives are unpacked one
// level deep, and anything else is noted as skipped with a plain reason.
// Never invents contents: a member that cannot be read is reported, not
// described.
//
// Formats: ZIP (via jszip), TAR, and TAR.GZ (gzip via node:zlib + a small
// tar header parser). RAR, 7z, and other formats are refused plainly.
//
// Guards (a small archive can expand without bound, so every expansion is
// capped): at most 100 members, 25 MB total uncompressed, 10 MB per member,
// nesting depth 2 (an archive inside an archive, no deeper), at most 5
// images sent to vision, and the summary text is capped at 30,000 chars
// like every other text read. Members are streamed with a byte counter
// where the format allows it, so a decompression bomb is cut off instead
// of being fully materialized.

import { createGunzip } from "node:zlib";
import JSZip from "jszip";
import { isTextReadableMime, mimeTypeForFile, readabilityNote } from "../files.ts";
import { extractDocumentText, isExtractableDocumentMime } from "./document-text.ts";
import { extractPdfText } from "./pdf-text.ts";
import { type VisionPart, visionParts } from "./vision.ts";

export const ARCHIVE_MAX_MEMBERS = 100;
export const ARCHIVE_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
export const ARCHIVE_MAX_MEMBER_BYTES = 10 * 1024 * 1024;
export const ARCHIVE_MAX_DEPTH = 2;
export const ARCHIVE_MAX_IMAGES = 5;
export const ARCHIVE_TEXT_LIMIT = 30000;

export type ArchiveRead =
  | { ok: true; summary: string; truncated: boolean; imageParts: VisionPart[] }
  | { ok: false; error: string };

const ZIP_MIMES = new Set(["application/zip", "application/x-zip-compressed", "application/x-zip"]);

export function isArchiveMime(mime: string, name: string): boolean {
  if (ZIP_MIMES.has(mime) || mime === "application/x-tar") return true;
  if (mime === "application/gzip" && /\.t(ar\.)?gz$/i.test(name)) return true;
  return false;
}

interface Budget {
  members: number;
  bytes: number;
  images: number;
}

interface Accumulator {
  lines: string[];
  images: VisionPart[];
  truncated: boolean;
  budget: Budget;
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function readHeaderString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && bytes[end] !== 0) end++;
  return decodeText(bytes.subarray(offset, end));
}

function parseOctal(bytes: Uint8Array, offset: number, length: number): number | null {
  // Base-256 encoding (high bit set) is only used for sizes no archive here
  // can reach; treat it as a bad header rather than misreading a size.
  if ((bytes[offset] ?? 0) & 0x80) return null;
  const text = readHeaderString(bytes, offset, length).trim();
  if (!/^[0-7]*$/.test(text)) return null;
  const value = Number.parseInt(text || "0", 8);
  return Number.isSafeInteger(value) ? value : null;
}

interface TarMember {
  name: string;
  offset: number;
  size: number;
}

function parseTar(bytes: Uint8Array): { members: TarMember[] } | { error: string } {
  const members: TarMember[] = [];
  let offset = 0;
  let pendingLongName: string | null = null;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readHeaderString(header, 0, 100);
    const size = parseOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] ?? 0);
    const prefix = readHeaderString(header, 345, 155);
    if (size === null) return { error: "This archive could not be read (bad tar header)." };
    const dataStart = offset + 512;
    const dataBlocks = Math.ceil(size / 512);
    if (dataStart + dataBlocks * 512 > bytes.length) return { error: "This archive is truncated." };
    if (typeflag === "L") {
      pendingLongName = decodeText(bytes.subarray(dataStart, dataStart + size)).replace(
        /\0.*$/s,
        "",
      );
    } else if (typeflag === "0" || typeflag === "\0") {
      const fullName = pendingLongName ?? (prefix ? `${prefix}/${name}` : name);
      members.push({ name: fullName, offset: dataStart, size });
      pendingLongName = null;
    }
    offset = dataStart + dataBlocks * 512;
  }
  return { members };
}

function gunzipCapped(bytes: Uint8Array, cap: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const gunzip = createGunzip();
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    gunzip.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        settled = true;
        gunzip.destroy(new Error(`Archive expands beyond ${cap / (1024 * 1024)} MB.`));
        return;
      }
      chunks.push(chunk);
    });
    gunzip.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    gunzip.on("error", (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    gunzip.end(bytes);
  });
}

type MemberBytes = { kind: "ok"; bytes: Uint8Array } | { kind: "skipped"; reason: string };

async function readZipMember(file: JSZip.JSZipObject): Promise<MemberBytes> {
  const stream = file.nodeStream() as unknown as NodeJS.ReadableStream | null | undefined;
  if (!stream || typeof (stream as { on?: unknown }).on !== "function") {
    // Fallback (should not happen on Node): whole-member read with a
    // post-read size check.
    const bytes = await file.async("uint8array");
    if (bytes.length > ARCHIVE_MAX_MEMBER_BYTES)
      return { kind: "skipped", reason: `exceeds ${ARCHIVE_MAX_MEMBER_BYTES / (1024 * 1024)} MB` };
    return { kind: "ok", bytes };
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    stream.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > ARCHIVE_MAX_MEMBER_BYTES && !settled) {
        settled = true;
        (stream as { destroy?: (error?: Error) => void }).destroy?.(new Error("member too large"));
        resolve({
          kind: "skipped",
          reason: `exceeds ${ARCHIVE_MAX_MEMBER_BYTES / (1024 * 1024)} MB`,
        });
        return;
      }
      if (!settled) chunks.push(chunk);
    });
    stream.on("end", () => {
      if (!settled) {
        settled = true;
        resolve({ kind: "ok", bytes: Buffer.concat(chunks) });
      }
    });
    stream.on("error", () => {
      if (!settled) {
        settled = true;
        resolve({ kind: "skipped", reason: "could not be read" });
      }
    });
  });
}

async function processMember(
  name: string,
  bytes: Uint8Array,
  depth: number,
  acc: Accumulator,
): Promise<void> {
  const mime = mimeTypeForFile(name);
  if (isTextReadableMime(mime)) {
    acc.lines.push(`== ${name} ==`, decodeText(bytes));
    return;
  }
  if (isExtractableDocumentMime(mime)) {
    const extracted = await extractDocumentText(bytes, mime);
    acc.lines.push(`== ${name} ==`, extracted.ok ? extracted.text : extracted.error);
    return;
  }
  if (mime === "application/pdf") {
    const extracted = await extractPdfText(bytes);
    acc.lines.push(`== ${name} ==`, extracted.ok ? extracted.text : extracted.error);
    return;
  }
  if (mime.startsWith("image/")) {
    if (acc.budget.images >= ARCHIVE_MAX_IMAGES) {
      acc.lines.push(`Image: ${name} — omitted (image limit reached).`);
      return;
    }
    const vision = await visionParts(name, mime, bytes);
    if ("error" in vision) {
      acc.lines.push(`Image: ${name} — ${vision.error}`);
    } else {
      acc.budget.images++;
      acc.images.push(...vision.parts);
      acc.lines.push(`Image: ${name} — included for viewing.`);
    }
    return;
  }
  if (isArchiveMime(mime, name) && depth < ARCHIVE_MAX_DEPTH) {
    await unpackArchive(bytes, name, mime, depth + 1, acc);
    return;
  }
  if (isArchiveMime(mime, name)) {
    acc.lines.push(`Skipped: ${name} (nested archives deeper than 2 levels are not unpacked).`);
    return;
  }
  acc.lines.push(`Skipped: ${name} (${readabilityNote(mime)}).`);
}

async function unpackArchive(
  bytes: Uint8Array,
  name: string,
  mime: string,
  depth: number,
  acc: Accumulator,
): Promise<void> {
  if (ZIP_MIMES.has(mime)) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      acc.lines.push(`Archive ${name} could not be opened.`);
      acc.truncated = true;
      return;
    }
    for (const entryName of Object.keys(zip.files)) {
      if (acc.budget.members >= ARCHIVE_MAX_MEMBERS) {
        acc.lines.push(`Stopped: archive member limit (${ARCHIVE_MAX_MEMBERS}) reached.`);
        acc.truncated = true;
        return;
      }
      if (entryName.endsWith("/") || entryName.startsWith("__MACOSX/")) continue;
      const file = zip.files[entryName];
      if (!file) continue;
      acc.budget.members++;
      const member = await readZipMember(file);
      if (member.kind === "skipped") {
        acc.lines.push(`Skipped: ${entryName} (${member.reason}).`);
        acc.truncated = true;
        continue;
      }
      acc.budget.bytes += member.bytes.length;
      if (acc.budget.bytes > ARCHIVE_MAX_TOTAL_BYTES) {
        acc.lines.push(
          `Stopped: archive contents exceed ${ARCHIVE_MAX_TOTAL_BYTES / (1024 * 1024)} MB uncompressed.`,
        );
        acc.truncated = true;
        return;
      }
      await processMember(entryName, member.bytes, depth, acc);
    }
    return;
  }
  // TAR / TAR.GZ.
  let tarBytes = bytes;
  if (mime === "application/gzip") {
    try {
      tarBytes = await gunzipCapped(bytes, ARCHIVE_MAX_TOTAL_BYTES);
    } catch {
      acc.lines.push(
        `Archive ${name} expands beyond ${ARCHIVE_MAX_TOTAL_BYTES / (1024 * 1024)} MB.`,
      );
      acc.truncated = true;
      return;
    }
  }
  const parsed = parseTar(tarBytes);
  if ("error" in parsed) {
    acc.lines.push(`Archive ${name} could not be read (${parsed.error}).`);
    acc.truncated = true;
    return;
  }
  for (const member of parsed.members) {
    if (acc.budget.members >= ARCHIVE_MAX_MEMBERS) {
      acc.lines.push(`Stopped: archive member limit (${ARCHIVE_MAX_MEMBERS}) reached.`);
      acc.truncated = true;
      return;
    }
    if (member.name.endsWith("/") || member.name.startsWith("__MACOSX/")) continue;
    acc.budget.members++;
    const memberBytes = tarBytes.subarray(member.offset, member.offset + member.size);
    acc.budget.bytes += memberBytes.length;
    if (acc.budget.bytes > ARCHIVE_MAX_TOTAL_BYTES) {
      acc.lines.push(
        `Stopped: archive contents exceed ${ARCHIVE_MAX_TOTAL_BYTES / (1024 * 1024)} MB uncompressed.`,
      );
      acc.truncated = true;
      return;
    }
    await processMember(member.name, memberBytes, depth, acc);
  }
}

export async function readArchive(
  bytes: Uint8Array,
  name: string,
  mime: string,
): Promise<ArchiveRead> {
  const acc: Accumulator = {
    lines: [],
    images: [],
    truncated: false,
    budget: { members: 0, bytes: 0, images: 0 },
  };
  if (!isArchiveMime(mime, name))
    return { ok: false, error: "This file is not a supported archive." };
  try {
    await unpackArchive(bytes, name, mime, 1, acc);
  } catch {
    return { ok: false, error: "This archive could not be read." };
  }
  if (acc.lines.length === 0) acc.lines.push("This archive contains no readable files.");
  const summary = acc.lines.join("\n");
  const truncated = acc.truncated || summary.length > ARCHIVE_TEXT_LIMIT;
  return {
    ok: true,
    summary: summary.length > ARCHIVE_TEXT_LIMIT ? summary.slice(0, ARCHIVE_TEXT_LIMIT) : summary,
    truncated,
    imageParts: acc.images,
  };
}
