import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import {
  decodePDFRawStream,
  PDFArray,
  PDFCheckBox,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  type PDFField,
  PDFHexString,
  PDFName,
  type PDFObject,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFString,
  PDFTextField,
  rgb,
  StandardFonts,
} from "pdf-lib";
import type { FormKind } from "../../../packages/domain/src/index.ts";
import { hasXfa, inspectXfa, XfaError } from "./xfa.ts";

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_PDF_PAGES = 500;
const MAX_DECODED_BYTES = 10 * MAX_PDF_BYTES;

export class PdfError extends Error {
  readonly status = 422;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PdfError";
  }
}

/** The budget error is the one fixed message every budget guard throws. */
function isBudgetPdfError(error: unknown): boolean {
  return (
    error instanceof PdfError && error.message === "PDF content expands beyond the supported size"
  );
}

async function pdfOperation<T>(operation: () => Promise<T>, fallback: string): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PdfError) throw error;
    throw new PdfError(fallback, { cause: error });
  }
}

export interface PdfInspection {
  pageCount: number;
  fields: {
    name: string;
    value: string;
    type: "text" | "checkbox" | "unsupported";
    /** Dropdown/radio option list (XFA choiceList / exclGroup). */
    options?: string[];
    /** Template caption text, when present. */
    label?: string;
    /** Checkbox on-values, one per template occurrence (XFA only). */
    onValues?: string[];
  }[];
  formKind: FormKind;
}

// pdf-lib decompresses object and cross-reference streams while loading, with no output limit,
// so a file under MAX_PDF_BYTES could still expand without bound. Every pdf-lib decoder grows its
// output buffer through DecodeStream.ensureBuffer, so cap what one load may allocate there.
const decodeBudget = new AsyncLocalStorage<{ remaining: number }>();
let decodeStreamPatched = false;
/**
 * Install the decode-budget cap on pdf-lib's DecodeStream.ensureBuffer.
 * Runs on first PDF load, not at import time: if pdf-lib changes internals,
 * the failure lands on a PDF load instead of breaking the import of this
 * whole module.
 */
function patchDecodeStreamBudget(): void {
  if (decodeStreamPatched) return;
  let decodeStream = Object.getPrototypeOf(
    decodePDFRawStream(
      PDFRawStream.of(PDFContext.create().obj({ Filter: "ASCIIHexDecode" }), new Uint8Array()),
    ),
  );
  while (decodeStream && !Object.hasOwn(decodeStream, "ensureBuffer"))
    decodeStream = Object.getPrototypeOf(decodeStream);
  if (!decodeStream) throw new Error("pdf-lib no longer decodes through DecodeStream");
  const ensureBuffer = decodeStream.ensureBuffer;
  decodeStream.ensureBuffer = function (this: { buffer: Uint8Array }, requested: number) {
    const before = this.buffer.byteLength;
    const budget = decodeBudget.getStore();
    // Check the requested size against the remaining budget BEFORE allocating:
    // the buffer grows to at least `requested`, so a request whose minimum
    // growth already exceeds the budget must fail without allocating it.
    // Mark the budget exhausted when refusing: pdf-lib can catch this throw
    // and keep parsing, so the balance alone would not identify it later.
    if (budget && requested - before > budget.remaining) {
      budget.remaining = -1;
      throw new PdfError("PDF content expands beyond the supported size");
    }
    const buffer: Uint8Array = ensureBuffer.call(this, requested);
    if (budget) {
      budget.remaining -= buffer.byteLength - before;
      if (budget.remaining < 0) throw new PdfError("PDF content expands beyond the supported size");
    }
    return buffer;
  };
  decodeStreamPatched = true;
}

/**
 * The "%PDF-" marker must start within the first 5 bytes of the file
 * (offset 0, or after a 3-byte UTF-8 BOM with an optional line feed).
 * A marker buried hundreds of bytes in is not a PDF header — it is trailing
 * garbage or a foreign file with PDF bytes inside. Shared by the importer
 * (loadPdf) and the browser-download sniffer so the two paths accept the
 * same leading bytes.
 */
export function pdfMarkerAtStart(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 9)).indexOf("%PDF-") >= 0;
}

/** Standard security-handler padding string (PDF 32000-1 §7.6.2, Algorithm 3.2). */
const PDF_PASSWORD_PADDING = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** RC4 (KSA + PRGA). Node's OpenSSL 3 build disables RC4 in node:crypto, so it is hand-rolled. */
function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    const tmp = s[i];
    s[i] = s[j];
    s[j] = tmp;
  }
  const out = new Uint8Array(data.length);
  let a = 0;
  j = 0;
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 0xff;
    j = (j + s[a]) & 0xff;
    const tmp = s[a];
    s[a] = s[j];
    s[j] = tmp;
    out[n] = data[n] ^ s[(s[a] + s[j]) & 0xff];
  }
  return out;
}

function md5(...parts: Uint8Array[]): Uint8Array {
  const hash = createHash("md5");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const padded = hex.length % 2 === 1 ? `${hex}0` : hex;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hexStringBytes(value: Uint8Array): Uint8Array {
  // Native hex encoding: no intermediate number array + map + join.
  return new TextEncoder().encode(`<${Buffer.from(value).toString("hex").toUpperCase()}>`);
}

/**
 * Index just past a literal string starting at `start` (text[start] === `(`),
 * skipping nested parens and backslash escapes. Returns text.length when the
 * string never terminates. The optional `limit` bounds the scan: when the
 * string does not close by `limit`, the return is `limit + 1` (greater
 * than the limit, so a caller that clamps to the limit can tell the
 * string extends beyond it — a plain `limit` return would be ambiguous
 * with a string that closes exactly at the limit). Callers that pass no
 * limit get the old whole-file behavior.
 */
function skipPdfLiteralString(text: string, start: number, limit = text.length): number {
  let i = start + 1;
  let depth = 1;
  while (i < limit && depth > 0) {
    const c = text[i];
    if (c === "\\") {
      // Backslash + CRLF is one line continuation; any other escaped char is one more.
      i += text[i + 1] === "\r" && text[i + 2] === "\n" ? 3 : 2;
    } else if (c === "(") {
      depth++;
      i++;
    } else if (c === ")") {
      depth--;
      i++;
    } else {
      i++;
    }
  }
  return depth > 0 ? limit + 1 : i;
}

/**
 * Index just past a PDF comment starting at `start` (text[start] === `%`).
 * A comment ends at CR, LF, or CRLF (PDF 32000-1 §7.2.4) — terminating
 * only at LF would mistake real syntax after a CR-only comment for
 * comment text. Returns text.length when the comment runs to EOF.
 * The optional `limit` bounds the scan: when the comment does not end
 * by `limit` (and `limit` is before EOF), the return is `limit + 1`
 * (greater than the limit, so a caller that clamps to the limit can
 * tell the comment extends beyond it — a plain `limit` return would
 * be ambiguous with a comment whose newline is exactly at the
 * limit). Callers that pass no limit get the old whole-file behavior
 * (text.length when the comment runs to EOF).
 */
function skipPdfComment(text: string, start: number, limit = text.length): number {
  let i = start;
  while (i < limit && text[i] !== "\r" && text[i] !== "\n") i++;
  if (i < limit) {
    if (text[i] === "\r" && text[i + 1] === "\n") return Math.min(i + 2, limit);
    return i + 1;
  }
  // No newline before the limit (i === limit). If the newline is exactly
  // at the limit, the comment ends there.
  if (limit < text.length && (text[limit] === "\r" || text[limit] === "\n")) return limit;
  // No newline at or before the limit. Whole-file call (limit === EOF):
  // the comment runs to EOF — the old text.length return. Bounded call:
  // the comment extends beyond the limit.
  return limit < text.length ? limit + 1 : limit;
}

/**
 * PDF whitespace is exactly NUL, TAB, LF, FF, CR, SPACE (PDF 32000-1
 * §7.2.2). JS `\s` also matches 0x0B, 0xA0, 0x1680, 0x2000–0x200A,
 * 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF — bytes that are REGULAR
 * characters inside a PDF name or token. Tokenizing on `\s` would split
 * one name into two (`/Custom<0xA0>Key /Type /XRef` reads as a `/Type`
 * entry) and silently copy a content stream as ciphertext. Every
 * PDF-tokenization site below uses these helpers, never `\s`.
 */
function isPdfWhitespace(c: string | undefined): boolean {
  return c === "\x00" || c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " ";
}

/** PDF whitespace or one of the delimiters `()<>[]{}/%`. */
function isPdfWhitespaceOrDelimiter(c: string | undefined): boolean {
  return c !== undefined && (isPdfWhitespace(c) || "()<>[]{}/%".includes(c));
}

/** Skip PDF whitespace and comments from `i` (comments end at CR/LF/CRLF). */
function skipPdfWhitespaceAndComments(text: string, i: number): number {
  for (;;) {
    while (i < text.length && isPdfWhitespace(text[i])) i++;
    if (text[i] === "%") {
      i = skipPdfComment(text, i);
      continue;
    }
    return i;
  }
}

/** Regex source for the six PDF whitespace bytes, for character classes. */
const PDF_WHITESPACE_CLASS = "\\x00\\t\\n\\f\\r ";

/** An integer with optional surrounding PDF whitespace. */
const PDF_INT_WITH_WS_REGEX = new RegExp(
  `^[${PDF_WHITESPACE_CLASS}]*(-?\\d+)[${PDF_WHITESPACE_CLASS}]*$`,
);

/**
 * Count indirect-object headers (`N G obj`, where the tokens may be
 * separated by PDF whitespace OR comments) in `text[from, limit)`,
 * capped at 2. Used ONLY by the removed-span second-header safeguard,
 * which must cover the same header grammar as discovery: a
 * comment-bearing genuine header inside a removed span must still
 * trigger the rejection.
 *
 * This is a LINEAR scan, not a regex: the previous comment-aware
 * regex `(?:[whitespace]|%[^\n\r]*)+` admitted exponentially many
 * partitions of a run of `%` characters (the inner comment body can
 * consume additional `%`s while the outer repetition can also
 * interpret each one as another comment alternative), so a failed
 * search against `"1 " + "%".repeat(n) + "\n"` backtracked
 * exponentially over untrusted stream ciphertext. This scanner
 * consumes each comment in one go (`%` to the next line break, never
 * reconsidered) and visits each byte once, so its work is O(range).
 * It DOES skip literal strings (like discovery): a `%` inside a
 * string is not a comment, so it cannot hide a subsequent genuine
 * header on the same line. It does NOT track depth — a digit inside
 * a dict/array interior could falsely match, which is safe for a
 * fail-closed safeguard (a false positive only rejects an
 * adversarial file, while a false negative would silently lose
 * content). An unmatched `(` (a string that never closes before
 * `limit`) does NOT hide later headers: the skip returns past
 * `limit`, so the scanner advances by 1 instead and sets a flag —
 * once a string skip has failed, no `)` remains in the range that
 * could close any later string either, so further `(`s are treated
 * as ordinary bytes without rescanning. That keeps the scan linear
 * even on binary data full of unmatched `(`s.
 */
function countPdfObjectHeaders(text: string, from: number, limit: number): number {
  let count = 0;
  let i = from;
  let prevInt: number | undefined;
  let prevPrevInt: number | undefined;
  // Once a literal-string skip has failed (no closing `)` before
  // `limit`), no later `(` can close either — treat them as ordinary
  // bytes instead of rescanning to `limit` for each one.
  let noMoreStrings = false;
  const resetInts = (): void => {
    prevInt = undefined;
    prevPrevInt = undefined;
  };
  while (i < limit) {
    const c = text[i];
    if (isPdfWhitespace(c)) {
      i++;
      continue;
    }
    // A comment: consume it whole (`%` to the next line break),
    // never reconsidered — no backtracking.
    if (c === "%") {
      i++;
      while (i < limit && text[i] !== "\n" && text[i] !== "\r") i++;
      continue;
    }
    // A literal string: skip it whole (nested parens, escapes), so a
    // `%` or digit inside it is not a token. If it never closes
    // before `limit`, advance by 1 instead of jumping past `limit`
    // (which would hide later headers) and stop trying to skip
    // strings — no `)` remains that could close a later one either.
    if (c === "(" && !noMoreStrings) {
      const end = skipPdfLiteralString(text, i, limit);
      if (end <= limit) {
        i = end;
      } else {
        noMoreStrings = true;
        i++;
      }
      resetInts();
      continue;
    }
    if (c !== undefined && c >= "0" && c <= "9") {
      const start = i;
      while (i < limit && text[i] !== undefined && text[i] >= "0" && text[i] <= "9") i++;
      // A digit run followed by a regular character is part of a longer
      // token (e.g. `123abc`), not a standalone integer.
      if (i < limit && !isPdfWhitespaceOrDelimiter(text[i])) {
        while (i < limit && !isPdfWhitespaceOrDelimiter(text[i])) i++;
        resetInts();
        continue;
      }
      const value = Number.parseInt(text.slice(start, i), 10);
      if (Number.isSafeInteger(value)) {
        prevPrevInt = prevInt;
        prevInt = value;
      } else {
        resetInts();
      }
      continue;
    }
    // A regular-character token (keyword or name body).
    if (c !== undefined && !isPdfWhitespaceOrDelimiter(c)) {
      const start = i;
      while (i < limit && !isPdfWhitespaceOrDelimiter(text[i])) i++;
      if (text.slice(start, i) === "obj" && prevInt !== undefined && prevPrevInt !== undefined) {
        count++;
        if (count >= 2) return count;
      }
      resetInts();
      continue;
    }
    // Any other delimiter (including `<`, which is NOT skipped as a
    // hex string here — an unmatched one must not hide a header later
    // in the range; and `(` when `noMoreStrings` is set, treated as
    // an ordinary byte for the same reason).
    i++;
    resetInts();
  }
  return count;
}

/**
 * A PDF name token (after the leading `/`): any regular character —
 * anything except PDF whitespace and the delimiters `()<>[]{}/%`. Names can
 * contain hyphens and other punctuation (`/Custom-Key` is one name, not
 * `Custom` followed by `-Key`), and `#xx` hex escapes. Matching only
 * `[A-Za-z0-9_#]` would split such a name and let a following `/Type`
 * value be mistaken for the dict's own `/Type` key.
 */
const PDF_NAME_CHARS = String.raw`[^\x00\t\n\f\r ()<>[\]{}\/%]+`;

function pdfNameToken(text: string, start: number): string | undefined {
  const match = new RegExp(`^${PDF_NAME_CHARS}`).exec(text.slice(start));
  return match ? match[0] : undefined;
}

/**
 * Decode `#xx` hex escapes in a PDF name (PDF 32000-1 §7.3.5): `#65`
 * is `e`, so `/L#65ngth` IS `/Length`. A `#` not followed by two hex
 * digits is left as-is. Names are matched on their DECODED spelling, so
 * an escaped `/Length` or `/Type` cannot evade length resolution or the
 * xref-stream exemption — the old code stored the raw spelling and
 * treated the escaped key as absent.
 */
function decodePdfNameEscapes(name: string): string {
  return name.replace(/#([0-9A-Fa-f]{2})/g, (_match: string, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * Find `token` at or after `from`, skipping PDF comments (`%` to end of
 * line), literal strings, and hex strings — so a token inside a string or
 * comment is never mistaken for syntax. Returns -1 when not found.
 *
 * When `regions` (binary stream-data intervals, sorted by start) are
 * given, the scan jumps over them: random stream bytes can contain an
 * unbalanced `(` that would otherwise make the string skipper swallow
 * the rest of the file, including a genuine keyword after the stream.
 * The `end` bound stops the scan there (used to keep a search inside one
 * object). Region tracking is indexed, not restarted per character.
 */
function findOutsideStrings(
  text: string,
  token: string,
  from: number,
  regions?: [number, number][],
  end?: number,
): number {
  let i = from;
  let regionIdx = 0;
  const limit = end === undefined ? text.length : Math.min(end, text.length);
  while (i < limit) {
    if (regions) {
      while (regionIdx < regions.length && regions[regionIdx][1] <= i) regionIdx++;
      if (regionIdx < regions.length && i >= regions[regionIdx][0] && i < regions[regionIdx][1]) {
        i = regions[regionIdx][1];
        continue;
      }
    }
    const c = text[i];
    if (c === "%") {
      i = skipPdfComment(text, i);
      continue;
    }
    if (c === "(") {
      i = skipPdfLiteralString(text, i);
      continue;
    }
    if (text.startsWith("<<", i)) {
      // A dictionary opener is one unit: without this, the second `<`
      // would enter the hex-string branch and skip to the next `>`,
      // which can sit inside a literal string (e.g. `(a > endobj b)`).
      i += 2;
      continue;
    }
    if (c === "<" && text[i + 1] !== "<") {
      const endHex = text.indexOf(">", i);
      i = endHex < 0 ? text.length : endHex + 1;
      continue;
    }
    if (text.startsWith(token, i)) return i;
    i++;
  }
  return -1;
}

/**
 * Parse a literal string starting at `start` (bytes[start] === `(`).
 * Returns the raw (unescaped) value. Unescaped CR / CRLF normalize to LF
 * (PDF 32000-1 §7.3.4.2). Throws PdfError("Encrypted PDFs are not
 * supported") on an unterminated string — malformed input fails closed
 * instead of being silently repaired.
 */
function parsePdfLiteralString(
  data: Uint8Array,
  start: number,
): { value: Uint8Array; end: number } {
  const out: number[] = [];
  let i = start + 1;
  let depth = 1;
  while (i < data.length && depth > 0) {
    const b = data[i];
    if (b === 0x5c) {
      if (i + 1 >= data.length) break;
      const n = data[i + 1];
      if (n === 0x6e) {
        out.push(0x0a);
        i += 2;
      } else if (n === 0x72) {
        out.push(0x0d);
        i += 2;
      } else if (n === 0x74) {
        out.push(0x09);
        i += 2;
      } else if (n === 0x62) {
        out.push(0x08);
        i += 2;
      } else if (n === 0x66) {
        out.push(0x0c);
        i += 2;
      } else if (n === 0x28 || n === 0x29 || n === 0x5c) {
        out.push(n);
        i += 2;
      } else if (n === 0x0d) {
        i += data[i + 2] === 0x0a ? 3 : 2; // line continuation
      } else if (n === 0x0a) {
        i += 2;
      } else if (n >= 0x30 && n <= 0x37) {
        let octal = 0;
        let k = 1;
        while (k <= 3 && i + k < data.length && data[i + k] >= 0x30 && data[i + k] <= 0x37) {
          octal = octal * 8 + (data[i + k] - 0x30);
          k++;
        }
        out.push(octal & 0xff);
        i += k;
      } else {
        out.push(n);
        i += 2;
      }
    } else if (b === 0x28) {
      depth++;
      out.push(b);
      i++;
    } else if (b === 0x29) {
      depth--;
      if (depth > 0) out.push(b);
      i++;
    } else if (b === 0x0d) {
      // Unescaped CR / CRLF normalizes to LF.
      out.push(0x0a);
      i += data[i + 1] === 0x0a ? 2 : 1;
    } else {
      out.push(b);
      i++;
    }
  }
  if (depth > 0) throw new PdfError("Encrypted PDFs are not supported");
  return { value: new Uint8Array(out), end: i };
}

/**
 * Parse a hex string starting at `start` (bytes[start] === `<`, next byte is
 * not `<`). Only hex digits and PDF whitespace are accepted; anything else
 * throws PdfError("Encrypted PDFs are not supported") instead of being
 * silently discarded. An unterminated hex string throws the same way.
 */
function parsePdfHexString(data: Uint8Array, start: number): { value: Uint8Array; end: number } {
  let hex = "";
  let i = start + 1;
  while (i < data.length && data[i] !== 0x3e) {
    const c = data[i];
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)) {
      hex += String.fromCharCode(c);
    } else if (c !== 0x00 && c !== 0x09 && c !== 0x0a && c !== 0x0c && c !== 0x0d && c !== 0x20) {
      throw new PdfError("Encrypted PDFs are not supported");
    }
    i++;
  }
  if (i >= data.length) throw new PdfError("Encrypted PDFs are not supported");
  if (hex.length % 2 === 1) hex += "0";
  return { value: hexToBytes(hex), end: i + 1 };
}

/**
 * Index just past a PDF value starting at `start`: a nested dictionary
 * (`<<`…`>>`), an array (`[…]`), a literal or hex string, a name, a
 * number (or `N G R` indirect reference), or a boolean/null keyword.
 * Comments and whitespace inside values are skipped structurally, so a
 * value's raw text is never confused with the next key. Returns
 * text.length when the value never terminates (malformed input fails
 * closed in the caller, which validates what it got).
 */
/**
 * Try to extend a bare integer at `pos` (just after the integer) into
 * an indirect reference `N G R`, where the tokens may be separated by
 * PDF whitespace OR comments (comments act as whitespace between PDF
 * tokens, §7.2.4 — so `9 % length reference\n0 R` is a reference to
 * object 9, not the number 9). Returns the index just past the `R`
 * when the tail parses, or undefined when it does not (the caller
 * keeps the bare integer). The `R` must be a whole token (followed by
 * whitespace, a delimiter, or EOF) so `9 0 Rx` does not extend.
 */
function skipPdfRefTail(text: string, pos: number): number | undefined {
  let i = pos;
  // Skip whitespace and comments.
  for (;;) {
    while (i < text.length && isPdfWhitespace(text[i])) i++;
    if (text[i] === "%") {
      i = skipPdfComment(text, i);
      continue;
    }
    break;
  }
  // Generation: a non-negative integer.
  const genStart = i;
  while (i < text.length && /\d/.test(text[i])) i++;
  if (i === genStart) return undefined;
  // Skip whitespace and comments again.
  for (;;) {
    while (i < text.length && isPdfWhitespace(text[i])) i++;
    if (text[i] === "%") {
      i = skipPdfComment(text, i);
      continue;
    }
    break;
  }
  if (text[i] !== "R") return undefined;
  const after = i + 1;
  if (after < text.length && !isPdfWhitespaceOrDelimiter(text[after])) return undefined;
  return after;
}

/**
 * Parse a raw dictionary value that may be an indirect reference
 * `N G R`, where the tokens may be separated by PDF whitespace OR
 * comments (same §7.2.4 rule as skipPdfRefTail, but for a value string
 * already extracted by parsePdfDictEntries — e.g. `9 % note\n0 R`).
 * Returns `{num, gen}` when the whole raw string is a reference, or
 * undefined otherwise. This replaces PDF_REF_REGEX, whose whitespace-
 * only character classes cannot express comments.
 */
function parsePdfRefValue(raw: string): { num: number; gen: number } | undefined {
  let i = 0;
  const skipWsAndComments = (): void => {
    for (;;) {
      while (i < raw.length && isPdfWhitespace(raw[i])) i++;
      if (raw[i] === "%") {
        i = skipPdfComment(raw, i);
        continue;
      }
      break;
    }
  };
  const readInt = (): number | undefined => {
    const start = i;
    while (i < raw.length && /\d/.test(raw[i])) i++;
    if (i === start) return undefined;
    const n = Number.parseInt(raw.slice(start, i), 10);
    return Number.isSafeInteger(n) ? n : undefined;
  };
  skipWsAndComments();
  const num = readInt();
  if (num === undefined) return undefined;
  skipWsAndComments();
  const gen = readInt();
  if (gen === undefined) return undefined;
  skipWsAndComments();
  if (raw[i] !== "R") return undefined;
  i++;
  skipWsAndComments();
  if (i !== raw.length) return undefined;
  return { num, gen };
}

function skipPdfValue(text: string, start: number): number {
  let i = start;
  while (i < text.length && isPdfWhitespace(text[i])) i++;
  if (i >= text.length) return i;
  if (text[i] === "%") return skipPdfValue(text, skipPdfComment(text, i));
  if (text.startsWith("<<", i)) {
    let depth = 0;
    while (i < text.length) {
      if (text[i] === "%") {
        i = skipPdfComment(text, i);
        continue;
      }
      if (text[i] === "(") {
        i = skipPdfLiteralString(text, i);
        continue;
      }
      if (text.startsWith("<<", i)) {
        depth++;
        i += 2;
        continue;
      }
      if (text.startsWith(">>", i)) {
        depth--;
        i += 2;
        if (depth <= 0) return i;
        continue;
      }
      if (text[i] === "<") {
        const end = text.indexOf(">", i);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      i++;
    }
    return i;
  }
  if (text[i] === "[") {
    let depth = 0;
    while (i < text.length) {
      if (text[i] === "%") {
        i = skipPdfComment(text, i);
        continue;
      }
      if (text[i] === "(") {
        i = skipPdfLiteralString(text, i);
        continue;
      }
      if (text.startsWith("<<", i)) {
        // A nested dict inside the array: skip it as a value.
        i = skipPdfValue(text, i);
        continue;
      }
      if (text[i] === "[") {
        depth++;
        i++;
        continue;
      }
      if (text[i] === "]") {
        depth--;
        i++;
        if (depth <= 0) return i;
        continue;
      }
      if (text[i] === "<") {
        const end = text.indexOf(">", i);
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      i++;
    }
    return i;
  }
  if (text[i] === "(") return skipPdfLiteralString(text, i);
  if (text[i] === "<") {
    const end = text.indexOf(">", i);
    return end < 0 ? text.length : end + 1;
  }
  // A bare token: name, number, `N G R` reference, true/false/null. The
  // decimal form comes first so `-4.5` is one token (rejected as a
  // malformed integer by the caller) rather than `-4` with `.5` left over.
  // If the match stops short of a following regular character (e.g.
  // `-4junk`, `9 0 Rx`), consume the rest of the run so callers see the
  // whole malformed token and reject it instead of its integer prefix.
  // The regex's reference alternative allows only whitespace between
  // the reference tokens — but comments act as whitespace too, so a
  // bare integer is extended structurally (via skipPdfRefTail) when
  // the tokens are separated by comments (e.g. `9 % note\n0 R`).
  const token = new RegExp(
    `^(?:\\/${PDF_NAME_CHARS}|-?\\d*\\.\\d+|-?\\d+(?:[${PDF_WHITESPACE_CLASS}]+\\d+[${PDF_WHITESPACE_CLASS}]+R)?|true|false|null|[^${PDF_WHITESPACE_CLASS}<>[\\]()/%]+)`,
  ).exec(text.slice(i));
  let end = token ? i + token[0].length : i + 1;
  if (token && /^-?\d+$/.test(token[0])) {
    const refEnd = skipPdfRefTail(text, end);
    if (refEnd !== undefined) end = refEnd;
  }
  if (token && end < text.length && !isPdfWhitespaceOrDelimiter(text[end])) {
    while (end < text.length && !isPdfWhitespaceOrDelimiter(text[end])) end++;
  }
  return end;
}

type PdfDictValueKind = "name" | "number" | "ref" | "bool" | "null" | "string" | "dict" | "array";

interface PdfDictEntry {
  raw: string;
  kind: PdfDictValueKind;
  /** Byte offset of the value inside the dictionary text. */
  valueStart: number;
}

/**
 * Parse a dictionary's TOP-LEVEL entries structurally: keys are matched
 * only at depth 1 outside arrays, comments (CR/LF/CRLF-terminated),
 * strings, nested dicts, and arrays are skipped as values — so a key
 * inside a comment, a string, a nested dict, or an array (e.g.
 * `/Custom [/Type /XRef]`) is never mistaken for the dict's own key.
 * First occurrence of a key wins. Returns undefined when the text is not
 * a dictionary at all. Accepts both the full `<<…>>` form and a bare
 * inner dict body (trailer dicts are stored without their delimiters).
 */
function parsePdfDictEntries(dictText: string): Map<string, PdfDictEntry> | undefined {
  let i = 0;
  // Leading whitespace/comments before `<<` — skipped in place so every
  // recorded valueStart stays an offset into the original dictText.
  for (;;) {
    while (i < dictText.length && isPdfWhitespace(dictText[i])) i++;
    if (dictText[i] === "%") {
      i = skipPdfComment(dictText, i);
      continue;
    }
    break;
  }
  if (dictText.startsWith("<<", i)) i += 2;
  const entries = new Map<string, PdfDictEntry>();
  for (;;) {
    while (i < dictText.length && isPdfWhitespace(dictText[i])) i++;
    if (i >= dictText.length) return entries;
    if (dictText[i] === "%") {
      i = skipPdfComment(dictText, i);
      continue;
    }
    if (dictText.startsWith(">>", i)) return entries;
    if (dictText[i] !== "/") {
      // Not a key where a key is expected: skip the value and carry on.
      i = skipPdfValue(dictText, i);
      continue;
    }
    const rawName = pdfNameToken(dictText, i + 1);
    if (rawName === undefined) return entries;
    // Match on the decoded spelling: /L#65ngth is /Length (§7.3.5).
    const name = decodePdfNameEscapes(rawName);
    i += 1 + rawName.length;
    while (i < dictText.length && isPdfWhitespace(dictText[i])) i++;
    if (i < dictText.length && dictText[i] === "%") {
      i = skipPdfComment(dictText, i);
      while (i < dictText.length && isPdfWhitespace(dictText[i])) i++;
    }
    const valueStart = i;
    const valueEnd = skipPdfValue(dictText, i);
    const raw = dictText.slice(valueStart, valueEnd);
    let kind: PdfDictValueKind;
    if (raw.startsWith("<<")) kind = "dict";
    else if (raw.startsWith("[")) kind = "array";
    else if (raw.startsWith("(") || (raw.startsWith("<") && !raw.startsWith("<<"))) kind = "string";
    else if (raw.startsWith("/")) kind = "name";
    else if (parsePdfRefValue(raw) !== undefined) kind = "ref";
    else if (/^-?\d+$/.test(raw) || /^-?\d*\.\d+$/.test(raw)) kind = "number";
    else if (raw === "true" || raw === "false") kind = "bool";
    else if (raw === "null") kind = "null";
    else kind = "name";
    // A name VALUE is also stored decoded, so /Type /X#52ef is read as
    // /XRef — the same evasion applies to values as to keys.
    if (!entries.has(name))
      entries.set(name, {
        raw: kind === "name" ? decodePdfNameEscapes(raw) : raw,
        kind,
        valueStart,
      });
    i = valueEnd;
  }
}

/**
 * Read a TOP-LEVEL key from a dictionary's text, parsed structurally
 * (see parsePdfDictEntries). Returns the raw value token (`/Name`, `123`,
 * `9 0 R`, a number) or undefined when the key is absent or its value is
 * a string, dict, or array.
 */
function pdfDictTopLevelRaw(dictText: string, key: string): string | undefined {
  const entry = parsePdfDictEntries(dictText)?.get(key);
  if (!entry) return undefined;
  if (entry.kind === "string" || entry.kind === "dict" || entry.kind === "array") return undefined;
  return entry.raw;
}

function pdfDictInt(dict: string, key: string): number | undefined {
  const raw = pdfDictTopLevelRaw(dict, key);
  if (raw === undefined || !/^-?\d+$/.test(raw)) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : undefined;
}

function pdfDictRef(dict: string, key: string): { num: number; gen: number } | undefined {
  const raw = pdfDictTopLevelRaw(dict, key);
  if (raw === undefined) return undefined;
  return parsePdfRefValue(raw);
}

function pdfDictString(bytes: Uint8Array, dictText: string, key: string): Uint8Array | undefined {
  const entry = parsePdfDictEntries(dictText)?.get(key);
  if (entry?.kind !== "string") return undefined;
  const at = entry.valueStart;
  if (bytes[at] === 0x28) return parsePdfLiteralString(bytes, at).value;
  if (bytes[at] === 0x3c && bytes[at + 1] !== 0x3c) return parsePdfHexString(bytes, at).value;
  return undefined;
}

/**
 * Locate a stream keyword that follows a dict close (`>>`), outside any
 * string or comment, so the word "stream" inside a string, a comment, or
 * a name (e.g. `/Downstream`) is never mistaken for one. Returns the
 * index of the `stream` keyword, or -1. When `end` is given, the search
 * never passes it — the caller bounds the search to the object's own
 * span instead of scanning the rest of the file for every object.
 */
function findPdfStream(text: string, from: number, end?: number): number {
  let at = from;
  for (;;) {
    const candidate = findOutsideStrings(text, "stream", at, undefined, end);
    if (candidate < 0) return -1;
    const prev = text[candidate - 1];
    if (prev !== undefined && !isPdfWhitespaceOrDelimiter(prev)) {
      at = candidate + 6;
      continue;
    }
    let before = candidate - 1;
    while (before >= 0 && isPdfWhitespace(text[before])) before--;
    const after = candidate + 6;
    const eol = text.startsWith("\r\n", after) || text[after] === "\n" || text[after] === "\r";
    if (eol && text[before] === ">" && text[before - 1] === ">") return candidate;
    at = candidate + 6;
  }
}

/**
 * Resolve a stream's byte length from its dictionary: a direct integer,
 * or an indirect reference resolved through the parsed objects (last
 * revision wins). Returns undefined when absent or unresolvable — the
 * caller then falls back to the endstream search and validates the
 * boundary instead of trusting a guessed length.
 */
function resolvePdfStreamLength(dictText: string, bodies: Map<string, string>): number | undefined {
  const raw = pdfDictTopLevelRaw(dictText, "Length");
  if (raw === undefined) return undefined;
  const direct = /^(-?\d+)$/.exec(raw);
  if (direct) {
    const n = Number.parseInt(direct[1], 10);
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  }
  const ref = parsePdfRefValue(raw);
  if (!ref) return undefined;
  const body = bodies.get(`${ref.num} ${ref.gen}`);
  if (body === undefined) return undefined;
  const value = PDF_INT_WITH_WS_REGEX.exec(body);
  if (!value) return undefined;
  const n = Number.parseInt(value[1], 10);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * The byte range [dataStart, dataEnd) of a stream's data, from its dict
 * and `bodies` map (see the pre-pass in decryptPdfWithEmptyPassword for
 * why the map must include object-stream members). A resolved /Length
 * must land exactly on `endstream` (allowing one EOL); otherwise the file
 * is malformed and fails closed. A /Length that is absent, present but
 * the wrong type (a string, dict, or array), an unresolvable reference,
 * or a malformed integer THROWS — it must never fall back to the first
 * `endstream` and copy the ciphertext tail unchanged, which silently
 * produced a broken (empty-text) document. A stream with no trustworthy
 * extent is ambiguous and is rejected rather than guessed at. Shared by
 * the rebuild loop and the object-stream pre-pass, so the two never
 * disagree about where a stream ends.
 */
function pdfStreamDataRange(
  bodyText: string,
  streamAt: number,
  bodies: Map<string, string>,
): { dataStart: number; dataEnd: number } {
  const unsupported = () => new PdfError("Encrypted PDFs are not supported");
  let dataStart = streamAt + 6;
  if (bodyText[dataStart] === "\r" && bodyText[dataStart + 1] === "\n") dataStart += 2;
  else if (bodyText[dataStart] === "\n" || bodyText[dataStart] === "\r") dataStart += 1;
  const dictText = bodyText.slice(0, streamAt);
  const length = resolvePdfStreamLength(dictText, bodies);
  if (length === undefined) throw unsupported();
  const dataEnd = dataStart + length;
  let after = dataEnd;
  if (bodyText[after] === "\r" && bodyText[after + 1] === "\n") after += 2;
  else if (bodyText[after] === "\n" || bodyText[after] === "\r") after += 1;
  if (!bodyText.startsWith("endstream", after)) throw unsupported();
  return { dataStart, dataEnd };
}

interface PdfObjectSpan {
  num: number;
  gen: number;
  start: number;
  bodyStart: number;
  end: number; // just past "endobj"
}

/**
 * Scan indirect objects in file order. Object headers are discovered
 * through genuine lexical boundaries — the `obj` keyword outside strings
 * and comments, with `N G` before it — so a commented-out header
 * (`% N 0 obj … endobj`) is never promoted into a live object.
 *
 * A stream is detected DICT-FIRST: the body must start (after
 * whitespace/comments) with a balanced dictionary, and the `stream`
 * keyword must follow its close directly (plus EOL). The stream's end is
 * then located from its direct /Length (a native `indexOf` past the data)
 * or, when the length is indirect or absent, from the first `endstream`
 * (a plain search). Binary stream data is NEVER scanned lexically: the
 * old code searched for `endobj` through the stream bytes first, and a
 * single `(` byte with no later `)` made the string skipper run to EOF
 * for every object — quadratic on files with many small streams.
 *
 * A non-stream body still locates its end with the lexical `endobj`
 * search, confined to the object's own body: a never-closing object
 * aborts on the first EOF scan instead of repeating it per object.
 * Throws PdfError("Encrypted PDFs are not supported") on an object that
 * never closes — malformed input fails closed.
 */
/**
 * Find the next indirect-object header `N G obj` at or after `from`
 * (up to `limit`), scanning FORWARD with full lexical state. Tokens
 * may be separated by PDF whitespace OR comments (comments act as
 * whitespace between PDF tokens, §7.2.4), and the header must be
 * outside any string. Returns the header (object number, generation,
 * the number's start, the `obj` keyword position, and the body start
 * just after `obj`) or undefined when no header is found before
 * `limit`.
 *
 * This replaces the old backward walk from `obj` (which inferred
 * comment state from an unrestricted backward search for `%` — it
 * could jump into a previous object's literal string, e.g. `(A%B)`,
 * and silently skip the next genuine object; and which scanned
 * backward to a newline/`%`/file-start for EVERY header, twice per
 * header, so many same-line objects cost Θ(N²) before any budget
 * reservation). A single forward pass is linear: `scanPdfObjects`
 * advances `from` monotonically (each span's end), so every byte is
 * tokenized once. The integer sequence is reset by any non-integer
 * token, so a header is exactly `int int obj` with only
 * whitespace/comments between the three tokens — a reference (`N G
 * R`) or a stray keyword cannot form one.
 *
 * Deliberately NO dict/array depth tracking: a `[` or `<<` in
 * ciphertext (binary stream data the scanner truncated at a forged
 * `endobj`) would put a depth-tracking lexer at depth > 0 and
 * suppress every genuine header after it — a new silent-content-loss
 * path the skipped-region walk (which treats `[` as an ordinary byte
 * and `<<` as a two-byte advance, without tracking depth) does not
 * account for. Instead `[`, `]`, `<<`, and `>>` are ordinary
 * delimiters that reset the integer sequence. A false header from a
 * dict/array interior is still largely prevented because the closing
 * `>>`/`]` resets the sequence before any following `obj` — only an
 * UNCLOSED dict/array could pair its interior integers with a later
 * `obj`, and that is a malformed file (the old backward-walk scanner
 * had the same exposure). The discovery lexer and the skipped-region
 * walk now model the SAME state (strings, comments, `<<`/`<` — no
 * depth), so no nesting state can suppress a header the walk does
 * not see.
 */
function findNextPdfObjectHeader(
  text: string,
  from: number,
  limit = text.length,
): { num: number; gen: number; numStart: number; objAt: number; bodyStart: number } | undefined {
  let i = from;
  // The last two integer tokens seen, in order. Any other token resets
  // both (a header's three tokens are consecutive).
  let prevInt: { value: number; start: number; end: number } | undefined;
  let prevPrevInt: { value: number; start: number; end: number } | undefined;
  const resetInts = (): void => {
    prevInt = undefined;
    prevPrevInt = undefined;
  };
  while (i < limit) {
    const c = text[i];
    // Whitespace and comments are skipped, not tokens — they never
    // reset the integer sequence.
    if (isPdfWhitespace(c)) {
      i++;
      continue;
    }
    if (c === "%") {
      i = skipPdfComment(text, i, limit);
      continue;
    }
    // A literal string: skip it whole (nested parens, escapes). Its
    // contents are not tokens — a `%` inside it is not a comment and
    // digits inside it are not integers.
    if (c === "(") {
      i = skipPdfLiteralString(text, i, limit);
      resetInts();
      continue;
    }
    // A dict open or a hex string. A `<<` is an ordinary delimiter
    // (no depth tracking — see the doc comment above).
    if (c === "<") {
      if (text[i + 1] === "<") {
        i += 2;
        resetInts();
        continue;
      }
      // Hex string: skip to the closing `>`. Its contents are not tokens.
      const close = text.indexOf(">", i + 1);
      if (close < 0 || close >= limit) return undefined;
      i = close + 1;
      resetInts();
      continue;
    }
    if (c === ">") {
      if (text[i + 1] === ">") {
        i += 2;
      } else {
        i++;
      }
      resetInts();
      continue;
    }
    if (c === "[") {
      i++;
      resetInts();
      continue;
    }
    if (c === "]") {
      i++;
      resetInts();
      continue;
    }
    // An integer token (a run of digits, a whole token).
    if (c >= "0" && c <= "9") {
      const start = i;
      while (i < limit && text[i] >= "0" && text[i] <= "9") i++;
      // A digit run followed by a regular character is part of a longer
      // token (e.g. `123abc`), not a standalone integer.
      if (i < limit && !isPdfWhitespaceOrDelimiter(text[i])) {
        while (i < limit && !isPdfWhitespaceOrDelimiter(text[i])) i++;
        resetInts();
        continue;
      }
      const value = Number.parseInt(text.slice(start, i), 10);
      if (Number.isSafeInteger(value)) {
        prevPrevInt = prevInt;
        prevInt = { value, start, end: i };
      } else {
        resetInts();
      }
      continue;
    }
    // A name: `/` followed by regular characters. Skip it whole.
    if (c === "/") {
      i++;
      while (i < limit && !isPdfWhitespaceOrDelimiter(text[i])) i++;
      resetInts();
      continue;
    }
    // A keyword or other regular-character token.
    if (!isPdfWhitespaceOrDelimiter(c)) {
      const start = i;
      while (i < limit && !isPdfWhitespaceOrDelimiter(text[i])) i++;
      const word = text.slice(start, i);
      if (word === "obj" && prevInt !== undefined && prevPrevInt !== undefined) {
        return {
          num: prevPrevInt.value,
          gen: prevInt.value,
          numStart: prevPrevInt.start,
          objAt: start,
          bodyStart: start + 3,
        };
      }
      resetInts();
      continue;
    }
    // Any other delimiter.
    i++;
    resetInts();
  }
  return undefined;
}

function scanPdfObjects(text: string): PdfObjectSpan[] {
  const spans: PdfObjectSpan[] = [];
  let searchFrom = 0;
  for (;;) {
    // Forward header discovery (findNextPdfObjectHeader): the header
    // tokens `N G obj` are found by a single forward lexical pass,
    // with strings, comments, and dict/array depth tracked — so a `%`
    // inside a previous object's literal string cannot be mistaken
    // for a comment start, and the work is linear (searchFrom advances
    // monotonically, so every byte is tokenized once). The tokenizer
    // guarantees the number starts at a lexical boundary and `obj` is
    // a whole token; the `before` check below is defensive.
    const header = findNextPdfObjectHeader(text, searchFrom);
    if (!header) break;
    const { num, gen, numStart, objAt, bodyStart } = header;
    const before = text[numStart - 1];
    if (before !== undefined && !isPdfWhitespaceOrDelimiter(before)) {
      searchFrom = objAt + 3;
      continue;
    }
    // Dict-first stream detection: a stream object always opens with its
    // dictionary, and `stream` follows the dict close (plus EOL). A body
    // with no leading dict cannot be a stream — a `stream` word after a
    // non-dict body (e.g. inside an array) is not one. The dict scan is
    // bounded (256 KiB): an unclosed dict in ciphertext must not make
    // discovery rescan the whole remaining file for every forged
    // header (quadratic work, before any budget reserve). A legitimate
    // object-body dict is far smaller; a dict that does not close
    // within the bound is treated as no dict (the object falls back
    // to the lexical `endobj` search, fail-closed).
    let streamAt = -1;
    let dictText: string | undefined;
    const dictOpen = skipPdfWhitespaceAndComments(text, bodyStart);
    if (text.startsWith("<<", dictOpen)) {
      const parsed = parseBalancedDict(text, dictOpen, Math.min(text.length, dictOpen + 262144));
      if (parsed) {
        dictText = parsed.dictText;
        let k = parsed.end;
        while (k < text.length && isPdfWhitespace(text[k])) k++;
        if (text.startsWith("stream", k)) {
          const eolAt = k + 6;
          if (text.startsWith("\r\n", eolAt) || text[eolAt] === "\n" || text[eolAt] === "\r")
            streamAt = k;
        }
      }
    }
    // Stream objects locate their end from past the data: scanning for
    // endobj through binary stream data would mistake its bytes for
    // strings and swallow the real endobj.
    let end: number;
    if (streamAt >= 0 && dictText !== undefined) {
      let dataStart = streamAt + 6;
      if (text[dataStart] === "\r" && text[dataStart + 1] === "\n") dataStart += 2;
      else if (text[dataStart] === "\n" || text[dataStart] === "\r") dataStart += 1;
      const directLength = pdfDictTopLevelRaw(dictText, "Length");
      // Only a DIRECT integer length is trusted here; an indirect length
      // (`/Length 9 0 R`) must never be read as the byte count 9 — it is
      // resolved later, and the span is located via endstream meanwhile.
      const directBytes =
        directLength !== undefined && /^-?\d+$/.test(directLength)
          ? Number.parseInt(directLength, 10)
          : undefined;
      if (directBytes !== undefined && Number.isSafeInteger(directBytes) && directBytes >= 0) {
        end = text.indexOf("endobj", dataStart + directBytes);
      } else {
        // Plain search through the stream bytes: they hold no PDF strings,
        // so skipping "strings" here would only swallow the real marker.
        const endStream = text.indexOf("endstream", dataStart);
        end = endStream >= 0 ? text.indexOf("endobj", endStream) : -1;
      }
    } else {
      end = findOutsideStrings(text, "endobj", bodyStart);
    }
    if (end < 0) throw new PdfError("Encrypted PDFs are not supported");
    spans.push({ num, gen, start: numStart, bodyStart, end: end + 6 });
    searchFrom = end + 6;
  }
  return spans;
}

/**
 * Decrypt the literal/hex strings in a non-stream object segment,
 * re-encoding each as `<HEX>`. Comments (`%` to end of line) are not
 * strings and are copied verbatim.
 */
function decryptPdfStrings(segment: Uint8Array, key: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let i = 0;
  // Unchanged bytes are copied as whole runs, not one typed-array view
  // per byte: a near-limit object of mostly whitespace would otherwise
  // allocate millions of views before concatenation.
  let runStart = 0;
  const flushRun = (end: number): void => {
    if (end > runStart) chunks.push(segment.subarray(runStart, end));
  };
  while (i < segment.length) {
    const b = segment[i];
    if (b === 0x25) {
      // Comment: copy through the end of the line, unmodified. A comment
      // ends at CR, LF, or CRLF — stopping only at LF would swallow real
      // syntax after a CR-only comment and leave its strings encrypted.
      flushRun(i);
      let end = i;
      while (end < segment.length && segment[end] !== 0x0a && segment[end] !== 0x0d) end++;
      if (segment[end] === 0x0d && segment[end + 1] === 0x0a) end += 2;
      else if (end < segment.length) end++;
      chunks.push(segment.subarray(i, end));
      i = end;
      runStart = i;
    } else if (b === 0x3c && segment[i + 1] === 0x3c) {
      // Dictionary open `<<` — emit as a unit, never as a hex-string start.
      flushRun(i);
      chunks.push(segment.subarray(i, i + 2));
      i += 2;
      runStart = i;
    } else if (b === 0x28) {
      flushRun(i);
      const parsed = parsePdfLiteralString(segment, i);
      chunks.push(hexStringBytes(rc4(key, parsed.value)));
      i = parsed.end;
      runStart = i;
    } else if (b === 0x3c) {
      flushRun(i);
      const parsed = parsePdfHexString(segment, i);
      chunks.push(hexStringBytes(rc4(key, parsed.value)));
      i = parsed.end;
      runStart = i;
    } else {
      i++;
    }
  }
  flushRun(segment.length);
  return concatBytes(chunks);
}

/**
 * Parse the /ID array from a trailer dictionary's bytes, using the real
 * string parsers (hex or literal). The /ID entry is located through the
 * structural dict parser, so a `/ID` inside a comment, string, or nested
 * dict is never mistaken for the trailer's. Returns the elements in
 * order; the caller re-encodes them as hex, so no raw byte ever passes
 * through a UTF-8 text encoder.
 */
function parseTrailerIds(dictBytes: Uint8Array): Uint8Array[] {
  const text = Buffer.from(dictBytes).toString("latin1");
  const entry = parsePdfDictEntries(text)?.get("ID");
  if (entry?.kind !== "array") return [];
  let i = entry.valueStart + 1; // just past `[`
  const ids: Uint8Array[] = [];
  for (let k = 0; k < 2; k++) {
    while (i < dictBytes.length && isPdfWhitespace(text[i])) i++;
    if (dictBytes[i] === 0x3c && dictBytes[i + 1] !== 0x3c) {
      const parsed = parsePdfHexString(dictBytes, i);
      ids.push(parsed.value);
      i = parsed.end;
    } else if (dictBytes[i] === 0x28) {
      const parsed = parsePdfLiteralString(dictBytes, i);
      ids.push(parsed.value);
      i = parsed.end;
    } else {
      break;
    }
  }
  return ids;
}

/**
 * Expand a decrypted object stream into its member objects. A classic xref
 * table cannot represent compressed objects (type-2 entries exist only in
 * xref streams), so the members are emitted as ordinary indirect objects
 * instead — otherwise the rebuilt xref would be incomplete and readers
 * would depend on parser recovery to find them. Only FlateDecode streams
 * are expanded; anything else (other filters, /Extends) fails closed.
 *
 * Inflation is BOUNDED: `maxOutputLength` caps the inflated bytes at the
 * remaining shared budget (or MAX_DECODED_BYTES when no budget is given),
 * and the inflated length is charged against the budget immediately — an
 * encrypted object-stream bomb cannot expand past the budget before any
 * check runs. Exported for tests; production callers go through
 * decryptPdfWithEmptyPassword.
 */
export function expandPdfObjectStream(
  decryptedStream: Uint8Array,
  dictText: string,
  budget?: { remaining: number },
): { num: number; body: Uint8Array }[] {
  const unsupported = () => new PdfError("Encrypted PDFs are not supported");
  // Whole-token integers only: `Number.parseInt` would read `1.5` as 1 and
  // `9x` as 9, silently normalizing malformed headers.
  const strictInt = (raw: string | undefined): number | undefined => {
    if (raw === undefined || !/^-?\d+$/.test(raw)) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isSafeInteger(n) ? n : undefined;
  };
  const count = strictInt(pdfDictTopLevelRaw(dictText, "N"));
  const first = strictInt(pdfDictTopLevelRaw(dictText, "First"));
  if (count === undefined || count < 0 || first === undefined || first < 0) throw unsupported();
  if (pdfDictTopLevelRaw(dictText, "Extends") !== undefined) throw unsupported();
  // /DecodeParms (e.g. a PNG predictor) is not applied: inflateSync
  // returns the filter bytes as data, and the header/body split then
  // mis-parses them as syntax — a predictor-encoded ObjStm silently
  // corrupts member strings (a filter byte 0x00 reads as PDF
  // whitespace, so `9 0 (ABC` parses as a valid header with a NUL in
  // the body). Reject rather than silently alter valid content;
  // predictor-encoded object streams are valid but rare, and pypdf
  // does not produce them by default. (Checked via the entries map,
  // not pdfDictTopLevelRaw — a /DecodeParms value is a dict or an
  // array of dicts, and that helper returns undefined for those.)
  if (parsePdfDictEntries(dictText)?.has("DecodeParms")) throw unsupported();
  if (count === 0) return [];
  // An exhausted budget is refused BEFORE zlib runs (rather than passing
  // maxOutputLength: 0 and relying on the cap error to say so).
  if (budget && budget.remaining <= 0)
    throw new PdfError("PDF content expands beyond the supported size");
  const limit = budget ? Math.max(budget.remaining, 0) : MAX_DECODED_BYTES;
  let inflated: Uint8Array;
  try {
    inflated = inflateSync(decryptedStream, { maxOutputLength: limit });
  } catch (error) {
    // Hitting the output cap is budget exhaustion, not malformed input.
    // Mark it sticky: the cap-hit consumed inflation work up to the cap
    // without debiting the budget, so a later caller must not get a
    // fresh allowance to inflate another bomb (see the pre-pass, which
    // used to swallow this error and retry the failed stream).
    const code = (error as { code?: unknown } | null)?.code;
    if (error instanceof Error && code === "ERR_BUFFER_TOO_LARGE") {
      if (budget) budget.remaining = -1;
      throw new PdfError("PDF content expands beyond the supported size");
    }
    throw unsupported();
  }
  if (budget) {
    budget.remaining -= inflated.length;
    if (budget.remaining < 0) throw new PdfError("PDF content expands beyond the supported size");
  }
  if (first > inflated.length) throw unsupported();
  const headerText = Buffer.from(inflated.subarray(0, first)).toString("latin1");
  const parts = headerText
    .replace(new RegExp(`^[${PDF_WHITESPACE_CLASS}]+|[${PDF_WHITESPACE_CLASS}]+$`, "g"), "")
    .split(new RegExp(`[${PDF_WHITESPACE_CLASS}]+`))
    .filter((part) => part.length > 0);
  if (parts.length !== count * 2) throw unsupported();
  const numbers = parts.map((part) => {
    if (!/^-?\d+$/.test(part)) throw unsupported();
    const n = Number.parseInt(part, 10);
    if (!Number.isSafeInteger(n) || n < 0) throw unsupported();
    return n;
  });
  // Header offsets are ascending and start at 0 (bodies begin at /First).
  if (numbers[1] !== 0) throw unsupported();
  for (let k = 1; k < count; k++)
    if (numbers[k * 2 + 1] <= numbers[(k - 1) * 2 + 1]) throw unsupported();
  const members: { num: number; body: Uint8Array }[] = [];
  for (let k = 0; k < count; k++) {
    const num = numbers[k * 2];
    const start = first + numbers[k * 2 + 1];
    const end = k + 1 < count ? first + numbers[k * 2 + 3] : inflated.length;
    if (start > end || end > inflated.length) throw unsupported();
    members.push({ num, body: inflated.subarray(start, end) });
  }
  return members;
}

/**
 * Binary stream-data regions in the file, as [start, end) offsets into
 * the file text: `findOutsideStrings` cannot be trusted inside them,
 * because random stream bytes can contain an unbalanced `(` that makes
 * the literal-string skipper swallow the rest of the file. Trailer and
 * startxref keywords are only genuine outside these regions (and outside
 * strings/comments). Regions are computed from the object spans: the
 * stream data runs from just past the `stream` keyword's EOL to
 * `endstream`.
 */
function streamDataRegions(
  text: string,
  spans: PdfObjectSpan[],
  bodies: Map<string, string>,
): [number, number][] {
  const regions: [number, number][] = [];
  for (const span of spans) {
    const bodyText = text.slice(span.bodyStart, span.end - 6);
    const streamAt = findPdfStream(bodyText, 0);
    if (streamAt < 0) continue;
    let dataStart = streamAt + 6;
    if (bodyText[dataStart] === "\r" && bodyText[dataStart + 1] === "\n") dataStart += 2;
    else dataStart += 1;
    // When the length is known, the region ends exactly at the validated
    // boundary — encrypted stream data may itself contain the ASCII
    // sequence `endstream`, and taking the first occurrence would expose
    // the remaining binary payload to whole-file syntax searches.
    // Without a resolvable length, fall back to the first `endstream`
    // (the rebuild loop still validates that boundary before trusting it).
    const dictText = bodyText.slice(0, streamAt);
    const length = resolvePdfStreamLength(dictText, bodies);
    let dataEnd: number;
    if (length !== undefined) {
      dataEnd = dataStart + length;
      if (dataEnd > bodyText.length) continue;
    } else {
      const endStreamAt = bodyText.indexOf("endstream", dataStart);
      if (endStreamAt < 0) continue;
      dataEnd = endStreamAt;
    }
    regions.push([span.bodyStart + dataStart, span.bodyStart + dataEnd]);
  }
  return regions;
}

/**
 * Like findOutsideStrings, but a token inside a binary stream-data region
 * is never a match either. The regions must be sorted by start offset.
 */
function findOutsideStringsAndStreams(
  text: string,
  token: string,
  from: number,
  regions: [number, number][],
): number {
  return findOutsideStrings(text, token, from, regions);
}

/**
 * Parse a dictionary starting at `open` (text[open] is the first `<` of
 * `<<`): returns the dict's inner text and the index just past its closing
 * `>>`, or undefined when the dict never closes. Strings, comments, and
 * nested dicts are skipped structurally, so a `>>` inside a literal
 * string or a nested dictionary never ends the parse early.
 */
/**
 * Parse a balanced dictionary starting at `open` (which must be
 * `<<`). Returns the dict's inner text and the index just past its
 * closing `>>`, or undefined when the dict does not balance before
 * `limit` (default: end of file). A dict containing a bare `endobj`
 * keyword (outside strings/comments) before its close is unclosed —
 * the object ended prematurely — so it returns undefined immediately
 * instead of scanning to `limit`: a forged `<< endobj` must not make
 * discovery rescan the whole remaining file for every forged header
 * (quadratic work in `scanPdfObjects`, before any budget reserve).
 * Callers that need a bounded scan pass `limit`; the default scans to
 * end of file (used by trailer discovery, where the dict is expected
 * to close and a missing close means a malformed file, not a
 * speculative probe).
 */
function parseBalancedDict(
  text: string,
  open: number,
  limit = text.length,
): { dictText: string; end: number } | undefined {
  if (!text.startsWith("<<", open)) return undefined;
  let i = open + 2;
  let depth = 1;
  while (i < limit && depth > 0) {
    const c = text[i];
    if (c === "%") {
      i = skipPdfComment(text, i, limit);
      continue;
    }
    if (c === "(") {
      i = skipPdfLiteralString(text, i, limit);
      continue;
    }
    // A bare `endobj` keyword before the dict closes means the object
    // ended prematurely — the dict is unclosed. Return undefined now
    // instead of scanning to `limit` (a forged `<< endobj` must fail
    // fast). The `endobj` must NOT be part of a name (a `/` before it
    // makes it the name `/endobj`, not the keyword — so `/Custom
    // /endobj` does not trigger this) and must NOT be part of a longer
    // word on the left (a regular character before it, e.g. `xendobj`,
    // does not trigger it). What FOLLOWS is deliberately not checked:
    // `endobjx` DOES trigger this, because the non-stream fallback
    // (`findOutsideStrings`) matches `endobj` as a substring and
    // would accept the `endobj` prefix of `endobjx` as the object end
    // — the two must agree, or `endobjx` bypasses the early exit and
    // the dict scan repeats quadratically. A bare `endobjx` keyword
    // is not valid PDF syntax (it is not a keyword, a name, or a
    // string — strings are already skipped above), so treating it as
    // an object terminator is fail-closed. Strings and comments are
    // already skipped above, so an `endobj` inside one never reaches
    // this check.
    if (text.startsWith("endobj", i)) {
      const before = text[i - 1];
      if (before !== undefined && before !== "/" && isPdfWhitespaceOrDelimiter(before)) {
        return undefined;
      }
    }
    if (text.startsWith("<<", i)) {
      depth++;
      i += 2;
      continue;
    }
    if (text.startsWith(">>", i)) {
      depth--;
      i += 2;
      continue;
    }
    if (c === "<") {
      const end = text.indexOf(">", i);
      if (end < 0 || end >= limit) return undefined;
      i = end + 1;
      continue;
    }
    i++;
  }
  if (depth > 0) return undefined;
  return { dictText: text.slice(open + 2, i - 2), end: i };
}

/**
 * Genuine trailer dictionaries, in file order. A `trailer` keyword is
 * only accepted outside strings and comments, its dict must parse as a
 * balanced dictionary, and the next non-whitespace token after the dict
 * must be `startxref` — a `trailer <<…>>` inside a comment, a string, or
 * stream data can never select the document root.
 */
function findTrailerDicts(
  text: string,
  regions: [number, number][],
): { dictText: string; end: number }[] {
  const found: { dictText: string; end: number }[] = [];
  let at = 0;
  for (;;) {
    const keyword = findOutsideStringsAndStreams(text, "trailer", at, regions);
    if (keyword < 0) return found;
    let i = keyword + 7;
    i = skipPdfWhitespaceAndComments(text, i);
    const parsed = parseBalancedDict(text, i);
    if (!parsed) {
      at = keyword + 7;
      continue;
    }
    let after = parsed.end;
    after = skipPdfWhitespaceAndComments(text, after);
    if (text.startsWith("startxref", after)) found.push(parsed);
    at = parsed.end;
  }
}

/**
 * The trailer the file's own last `startxref` points at: the offset names
 * the last xref section, whose trailer is the active revision. Returns
 * the trailer dict text, or undefined when the anchor cannot be followed
 * (the caller falls back to the trailer scan).
 */
function trailerAtStartxref(text: string, regions: [number, number][]): string | undefined {
  let last: { offset: number } | undefined;
  let at = 0;
  for (;;) {
    const keyword = findOutsideStringsAndStreams(text, "startxref", at, regions);
    if (keyword < 0) break;
    let i = keyword + 9;
    i = skipPdfWhitespaceAndComments(text, i);
    const num = /^\d+/.exec(text.slice(i));
    if (num) last = { offset: Number.parseInt(num[0], 10) };
    at = i;
  }
  if (!last || !Number.isSafeInteger(last.offset) || last.offset >= text.length) return undefined;
  const offset = last.offset;
  if (text.startsWith("xref", offset)) {
    const keyword = findOutsideStrings(text, "trailer", offset + 4);
    if (keyword < 0) return undefined;
    let i = keyword + 7;
    i = skipPdfWhitespaceAndComments(text, i);
    return parseBalancedDict(text, i)?.dictText;
  }
  const header = new RegExp(
    `^(\\d+)[${PDF_WHITESPACE_CLASS}]+(\\d+)[${PDF_WHITESPACE_CLASS}]+obj\\b`,
  ).exec(text.slice(offset));
  if (!header) return undefined;
  const bodyStart = offset + header[0].length;
  const streamAt = findPdfStream(text, bodyStart);
  const endObj = findOutsideStrings(text, "endobj", bodyStart);
  const dictEnd = streamAt >= 0 ? streamAt : endObj < 0 ? text.length : endObj;
  const dictText = text.slice(bodyStart, dictEnd);
  return pdfDictTopLevelRaw(dictText, "Type") === "/XRef" ? dictText : undefined;
}

/**
 * Decrypt a Standard-security PDF (V=1/2, R=2/3, RC4) that opens with the
 * EMPTY user password, and return equivalent unencrypted bytes: every
 * stream and string decrypted in place, object streams expanded into
 * ordinary indirect objects, a fresh classic xref table (one subsection
 * per run of present object numbers, so no object number can amplify
 * the output), and a trailer without /Encrypt. The rebuilt file is no
 * longer linearized (advisory only); object numbers and the document
 * structure are kept.
 *
 * When `budget` is given, the decrypted output length is charged against
 * it (the same shared decode budget the caller loads under), so
 * decryption work cannot escape the budget. Object-stream inflation is
 * capped at the remaining budget before it happens (see
 * expandPdfObjectStream), and the output length is charged before the
 * final concatenation — the routine never allocates an unbounded
 * expansion and then rejects it afterwards.
 *
 * Exported for tests; production callers go through loadPdf, which runs
 * the normal inspection pipeline on the returned bytes under the same
 * decode budget. Throws PdfError("This PDF is password-protected") when
 * the empty password does not authenticate, and PdfError("Encrypted PDFs
 * are not supported") for unsupported or malformed encryption.
 */
export function decryptPdfWithEmptyPassword(
  bytes: Uint8Array,
  budget?: { remaining: number },
): Uint8Array {
  const unsupported = () => new PdfError("Encrypted PDFs are not supported");
  const text = Buffer.from(bytes).toString("latin1");
  const spans = scanPdfObjects(text);
  if (!spans.length) throw unsupported();
  // Object bodies by number+generation (latest revision wins), for
  // resolving indirect /Length references — built before trailer
  // discovery because stream-data regions are derived from validated
  // lengths and need it. (Last-physical-wins is a documented limitation:
  // a superseded revision's /Length object is used if the active one
  // shares its number — the rebuild loop still validates the boundary.)
  const bodies = new Map<string, string>();
  for (const span of spans)
    bodies.set(`${span.num} ${span.gen}`, text.slice(span.bodyStart, span.end - 6));
  // The document trailer: prefer the one the file's own last `startxref`
  // points at (the active revision); otherwise the LAST genuine trailer
  // carrying /Root (an incremental update can replace it). Fall back to
  // the last trailer with an /ID, and then to the cross-reference
  // stream's own dictionary (xref-stream-only files carry /Root,
  // /Encrypt and /ID there).
  let trailerDict = "";
  let trailerDictBytes: Uint8Array | undefined;
  const setTrailer = (dictText: string): void => {
    trailerDict = dictText;
    trailerDictBytes = Buffer.from(dictText, "latin1");
  };
  const anchored = trailerAtStartxref(text, streamDataRegions(text, spans, bodies));
  if (anchored !== undefined && pdfDictRef(anchored, "Root") !== undefined) {
    setTrailer(anchored);
  } else {
    const candidates = findTrailerDicts(text, streamDataRegions(text, spans, bodies));
    const withRoot = candidates.filter((c) => pdfDictRef(c.dictText, "Root") !== undefined);
    if (withRoot.length > 0) setTrailer(withRoot[withRoot.length - 1].dictText);
    else {
      const withId = candidates.filter((c) => parsePdfDictEntries(c.dictText)?.has("ID"));
      if (withId.length > 0) setTrailer(withId[withId.length - 1].dictText);
    }
  }
  if (!trailerDict) {
    // Xref-stream-only file: the /Type /XRef object's dict is the trailer.
    const xrefSpan = [...spans].reverse().find((span) => {
      const body = bytes.subarray(span.bodyStart, span.end - 6);
      const bodyText = Buffer.from(body).toString("latin1");
      const streamAt = findPdfStream(bodyText, 0);
      const dictText = streamAt >= 0 ? bodyText.slice(0, streamAt) : bodyText;
      return pdfDictTopLevelRaw(dictText, "Type") === "/XRef";
    });
    if (xrefSpan) {
      const body = bytes.subarray(xrefSpan.bodyStart, xrefSpan.end - 6);
      const bodyText = Buffer.from(body).toString("latin1");
      const streamAt = findPdfStream(bodyText, 0);
      const dictText = streamAt >= 0 ? bodyText.slice(0, streamAt) : bodyText;
      trailerDict = dictText;
      trailerDictBytes = Buffer.from(dictText, "latin1");
    }
  }
  if (!trailerDict || !trailerDictBytes) throw unsupported();
  const encryptRef = pdfDictRef(trailerDict, "Encrypt");
  if (!encryptRef) throw unsupported();
  const encryptNum = encryptRef.num;
  const encryptGen = encryptRef.gen;
  const ids = parseTrailerIds(trailerDictBytes);
  const id0 = ids[0];
  if (!id0 || id0.length === 0) throw unsupported();
  // The encryption dictionary object (latest revision wins on duplicates),
  // matched by number AND generation.
  const encryptSpan = [...spans]
    .reverse()
    .find((span) => span.num === encryptNum && span.gen === encryptGen);
  if (!encryptSpan) throw unsupported();
  const encryptBody = bytes.subarray(encryptSpan.bodyStart, encryptSpan.end - 6);
  const encryptText = Buffer.from(encryptBody).toString("latin1");
  const encryptEntries = parsePdfDictEntries(encryptText);
  const filter = encryptEntries?.get("Filter");
  if (filter?.kind !== "name" || filter.raw !== "/Standard") throw unsupported();
  const version = pdfDictInt(encryptText, "V") ?? 0;
  const revision = pdfDictInt(encryptText, "R") ?? 0;
  const permissions = pdfDictInt(encryptText, "P");
  if (permissions === undefined) throw unsupported();
  // /Length is strict too: a present-but-malformed value (e.g. `-4.5`)
  // must reject the file, not silently fall back to the 40-bit default.
  const lengthEntry = encryptEntries?.get("Length");
  const keyBits =
    lengthEntry === undefined
      ? 40
      : /^-?\d+$/.test(lengthEntry.raw)
        ? Number.parseInt(lengthEntry.raw, 10)
        : undefined;
  if (keyBits === undefined) throw unsupported();
  if (!((version === 1 || version === 2) && (revision === 2 || revision === 3)))
    throw unsupported();
  // R=2 implies 40-bit keys; R=3 allows 40 or 128. Anything else is not a
  // well-formed Standard file, so authentication failure on it must not be
  // reported as merely "password-protected".
  if (revision === 2 && keyBits !== 40) throw unsupported();
  if (revision === 3 && keyBits !== 40 && keyBits !== 128) throw unsupported();
  const owner = pdfDictString(encryptBody, encryptText, "O");
  const user = pdfDictString(encryptBody, encryptText, "U");
  if (owner?.length !== 32 || user?.length !== 32) throw unsupported();
  // File encryption key from the EMPTY password (Algorithm 3.2).
  const keyBytes = keyBits / 8;
  const permissionsBytes = new Uint8Array(4);
  new DataView(permissionsBytes.buffer).setInt32(0, permissions, true);
  let fileKey = md5(PDF_PASSWORD_PADDING, owner, permissionsBytes, id0);
  if (revision >= 3) {
    for (let round = 0; round < 50; round++) fileKey = md5(fileKey.subarray(0, keyBytes));
  }
  fileKey = fileKey.subarray(0, keyBytes);
  // Verify the empty password (Algorithm 3.4 for R=2, 3.6 for R=3).
  if (revision === 2) {
    if (!bytesEqual(rc4(fileKey, PDF_PASSWORD_PADDING), user))
      throw new PdfError("This PDF is password-protected");
  } else {
    let value = rc4(fileKey, md5(PDF_PASSWORD_PADDING, id0));
    for (let i = 1; i <= 19; i++) {
      const roundKey = fileKey.map((b) => b ^ i);
      value = rc4(roundKey, value);
    }
    if (!bytesEqual(value, user.subarray(0, 16)))
      throw new PdfError("This PDF is password-protected");
  }
  // Reserve the input size from the budget BEFORE the rebuild loop: the
  // decrypted output is O(input size), and RC4 + string re-encoding
  // allocate before any output charge could be taken. The reserve is
  // adjusted to the actual output size at the end, so the total charge
  // stays the same — only the timing moves earlier, bounding the
  // intermediate allocation. (Object-stream inflation is charged
  // separately, as it happens, under its own cap.)
  if (budget) {
    budget.remaining -= bytes.length;
    if (budget.remaining < 0) throw new PdfError("PDF content expands beyond the supported size");
  }
  // Per-object key (Algorithm 3.1).
  const objectKey = (num: number, gen: number): Uint8Array => {
    const extension = new Uint8Array(5);
    extension[0] = num & 0xff;
    extension[1] = (num >> 8) & 0xff;
    extension[2] = (num >> 16) & 0xff;
    extension[3] = gen & 0xff;
    extension[4] = (gen >> 8) & 0xff;
    return md5(fileKey, extension).subarray(0, Math.min(keyBytes + 5, 16));
  };
  // Object-stream pre-pass: expand every ObjStm ONCE (charging the budget
  // once) into an enriched length map — top-level bodies plus member
  // bodies — because a content stream's indirect /Length may legitimately
  // live inside an object stream, and the top-level-only `bodies` map
  // cannot see it. The rebuild loop reuses these expansions (no double
  // inflation charge) and resolves lengths through the enriched map.
  // Iterate to a fixpoint: one ObjStm's /Length may live in another.
  // An ObjStm whose length cannot be resolved yet is deferred, not
  // failed: the rebuild loop expands it when reached (with the enriched
  // map) and fails closed if it is truly unresolvable. A malformed
  // ObjStm is likewise deferred — the rebuild loop throws on it.
  const lengthBodies = new Map<string, string>(bodies);
  const objStmMembers = new Map<number, { num: number; body: Uint8Array }[]>();
  // The fixpoint is bounded: a dependency chain of N object streams
  // (each one's /Length in the next) costs one pass per link, and every
  // pass revisits every unresolved stream — rebuilding its text, parsing
  // its dict, throwing/catching the unresolved-range error — so the
  // dict/range/exception work is O(N^2), all synchronous in the request
  // path. Ten passes cover any legitimate file (ObjStm lengths are
  // almost always direct); a deeper chain is pathological and is
  // rejected rather than processed.
  let prePassPasses = 0;
  let prePassProgressed = true;
  while (prePassProgressed) {
    if (++prePassPasses > 10) throw unsupported();
    prePassProgressed = false;
    spans.forEach((span, spanIndex) => {
      if (objStmMembers.has(spanIndex)) return;
      const spanBody = bytes.subarray(span.bodyStart, span.end - 6);
      const spanText = Buffer.from(spanBody).toString("latin1");
      const spanStreamAt = findPdfStream(spanText, 0);
      if (spanStreamAt < 0) return;
      const spanDictText = spanText.slice(0, spanStreamAt);
      if (pdfDictTopLevelRaw(spanDictText, "Type") !== "/ObjStm") return;
      if (pdfDictTopLevelRaw(spanDictText, "Filter") !== "/FlateDecode") return;
      // Resolve the stream's extent FIRST: only an unresolvable length
      // is deferred (a forward reference to a member this pass has not
      // reached, or a length in another ObjStm). A decompression
      // failure or a malformed object stream fails the decrypt
      // immediately — deferring it let a corrupted stream re-inflate
      // (up to the cap, uncharged: the budget is debited only after a
      // SUCCESSFUL inflation, and a late checksum failure produces its
      // output internally before failing) on every fixpoint pass. The
      // rebuild loop expands a deferred stream when reached and fails
      // closed if it is truly unresolvable.
      let range: { dataStart: number; dataEnd: number };
      try {
        range = pdfStreamDataRange(spanText, spanStreamAt, lengthBodies);
      } catch (error) {
        // Budget errors are not deferred: an oversized object stream is
        // exhaustion of the shared budget, and swallowing it let every
        // oversized stream re-inflate up to the cap on each fixpoint
        // pass (and again in the rebuild loop), so total work was
        // bounded only by (bombs x passes x cap). Fail the decrypt.
        if (isBudgetPdfError(error)) throw error;
        return; // Deferred: another ObjStm may yet provide the length.
      }
      const streamData = rc4(
        objectKey(span.num, span.gen),
        spanBody.subarray(range.dataStart, range.dataEnd),
      );
      const members = expandPdfObjectStream(streamData, spanDictText, budget);
      objStmMembers.set(spanIndex, members);
      for (const member of members)
        lengthBodies.set(`${member.num} 0`, Buffer.from(member.body).toString("latin1"));
      prePassProgressed = true;
    });
  }
  // Rebuild the length map in file order so latest-wins is exact: a
  // top-level body later in the file beats an earlier ObjStm member with
  // the same number, and vice versa. (During the fixpoint above the map
  // was only approximate — members were added as their streams expanded.)
  lengthBodies.clear();
  spans.forEach((span, spanIndex) => {
    lengthBodies.set(`${span.num} ${span.gen}`, text.slice(span.bodyStart, span.end - 6));
    const members = objStmMembers.get(spanIndex);
    if (members)
      for (const member of members)
        lengthBodies.set(`${member.num} 0`, Buffer.from(member.body).toString("latin1"));
  });
  // Forged-object validation (panel re-review #4, finding 3): the scanner
  // locates a stream's end from the first `endstream` when its /Length is
  // indirect, so ciphertext that reads as `endstream endobj N 0 obj ...`
  // promotes forged objects, and latest-wins lets a forged object replace
  // a real one. A forged object duplicates an earlier number and lies
  // inside the stream's TRUE data range. Resolve each stream's length
  // preferring a length object that appears BEFORE the stream (it cannot
  // lie inside the stream's data); fall back to the latest candidate
  // overall (a forward reference — the existing indirect-length fixtures
  // all use forward references). If the resolved length's data range
  // extends beyond the span's guessed end, every top-level span starting
  // inside the range is forged and is removed. Repeat until stable
  // (removing a forged length object can change another stream's
  // resolution). A stream whose /Length is absent or unresolvable is
  // rejected (see pdfStreamDataRange) rather than guessed at.
  const removedSpans = new Set<PdfObjectSpan>();
  // Each stream span's validated true data end (file offset), from the
  // final fixpoint pass — used below to extend spans the scanner cut
  // short at a forged endobj.
  const validatedDataEnds = new Map<PdfObjectSpan, number>();
  // Every (num gen) key any stream's /Length indirectly references.
  // A removed forgery only makes the candidates map stale for streams
  // that reference it, so the pass restarts only when a removed forgery
  // is such a key — otherwise the pass continues and many independent
  // forgeries are cleaned in one pass instead of one pass each (which
  // is what made the fixpoint quadratic for many-forged files).
  const lengthRefKeys = new Set<string>();
  for (const span of spans) {
    const spanBody = text.slice(span.bodyStart, span.end - 6);
    const spanStreamAt = findPdfStream(spanBody, 0);
    if (spanStreamAt < 0) continue;
    const spanDict = spanBody.slice(0, spanStreamAt);
    const spanRef = pdfDictRef(spanDict, "Length");
    if (spanRef) lengthRefKeys.add(`${spanRef.num} ${spanRef.gen}`);
  }
  // The fixpoint is bounded: each pass restarts only when a removed
  // forgery is a /Length target (a fresh candidates map each pass, so
  // no pass reads a stale length). A file with N independent forged
  // streams costs O(N) validation work in one pass, not O(N^2); the
  // pass cap bounds the remaining restart cost (a dependency chain of
  // forged length objects). Ten passes clean a chain ten deep; beyond
  // that the file is pathological and is rejected rather than
  // processed. A legitimate file needs one pass (no forgeries, so the
  // first pass removes nothing).
  let validationPasses = 0;
  for (;;) {
    if (++validationPasses > 10) throw unsupported();
    // Candidate length bodies, in file order, from surviving top-level
    // spans and object-stream members (a member's position is its parent
    // stream's span start).
    const lengthCandidates = new Map<string, { body: string; pos: number }[]>();
    const addCandidate = (key: string, body: string, pos: number): void => {
      const list = lengthCandidates.get(key);
      if (list) list.push({ body, pos });
      else lengthCandidates.set(key, [{ body, pos }]);
    };
    spans.forEach((span, spanIndex) => {
      if (removedSpans.has(span)) return;
      addCandidate(`${span.num} ${span.gen}`, text.slice(span.bodyStart, span.end - 6), span.start);
      const members = objStmMembers.get(spanIndex);
      if (members)
        for (const member of members)
          addCandidate(`${member.num} 0`, Buffer.from(member.body).toString("latin1"), span.start);
    });
    const resolveValidationLength = (streamSpan: PdfObjectSpan, dictText: string): number => {
      const direct = pdfDictInt(dictText, "Length");
      if (direct !== undefined) {
        if (direct < 0) throw unsupported();
        return direct;
      }
      const ref = pdfDictRef(dictText, "Length");
      if (!ref) throw unsupported();
      const candidates = lengthCandidates.get(`${ref.num} ${ref.gen}`);
      if (!candidates || candidates.length === 0) throw unsupported();
      // Prefer the latest candidate before the stream; a candidate after
      // it is a forward reference (only one when no earlier revision
      // exists). In the reported construction the forged length object
      // is after the stream AND duplicates the earlier real length, so
      // the before-candidate wins over it.
      let chosen = candidates[candidates.length - 1];
      for (let j = candidates.length - 1; j >= 0; j--) {
        if (candidates[j].pos < streamSpan.start) {
          chosen = candidates[j];
          break;
        }
      }
      const value = PDF_INT_WITH_WS_REGEX.exec(chosen.body);
      if (!value) throw unsupported();
      const n = Number.parseInt(value[1], 10);
      if (!Number.isSafeInteger(n) || n < 0) throw unsupported();
      return n;
    };
    let removedAny = false;
    for (let si = 0; si < spans.length; si++) {
      const span = spans[si];
      if (removedSpans.has(span)) continue;
      const bodyText = text.slice(span.bodyStart, span.end - 6);
      const streamAt = findPdfStream(bodyText, 0);
      if (streamAt < 0) continue;
      const dictText = bodyText.slice(0, streamAt);
      const length = resolveValidationLength(span, dictText);
      // Data range in FILE coordinates: the span's guessed end may
      // truncate the true data (a forged endstream/endobj can sit
      // inside it), so the span's own body text is too short to hold
      // the range — use the whole file text instead.
      let dataStart = span.bodyStart + streamAt + 6;
      if (text[dataStart] === "\r" && text[dataStart + 1] === "\n") dataStart += 2;
      else if (text[dataStart] === "\n" || text[dataStart] === "\r") dataStart += 1;
      const dataEnd = dataStart + length;
      let after = dataEnd;
      if (text[after] === "\r" && text[after + 1] === "\n") after += 2;
      else if (text[after] === "\n" || text[after] === "\r") after += 1;
      if (!text.startsWith("endstream", after)) throw unsupported();
      validatedDataEnds.set(span, dataEnd);
      const fileDataEnd = dataEnd;
      // Spans are in file order, and no span starts inside this stream's
      // own dict, so every forged span follows this one and precedes the
      // true data end — scan forward from si + 1, not over the whole file.
      let affectsLength = false;
      for (let oi = si + 1; oi < spans.length && spans[oi].start < fileDataEnd; oi++) {
        if (removedSpans.has(spans[oi])) continue;
        const removed = spans[oi];
        removedSpans.add(removed);
        removedAny = true;
        if (lengthRefKeys.has(`${removed.num} ${removed.gen}`)) affectsLength = true;
        const members = objStmMembers.get(oi);
        if (members)
          for (const member of members)
            if (lengthRefKeys.has(`${member.num} 0`)) {
              affectsLength = true;
              break;
            }
      }
      // Restart only when a removed forgery is a /Length target (the
      // candidates map is stale for streams that reference it); a
      // forgery no stream's length depends on cannot change any later
      // resolution, so the pass continues.
      if (affectsLength) break;
    }
    if (!removedAny) break;
  }
  // Extend every surviving stream span to its true endobj: the scanner
  // cut a span short at a forged endobj when the stream's data embeds
  // one, so Phase 1's body (span.bodyStart .. span.end - 6) would be
  // truncated and its boundary check would fail on the true data end.
  // A stream with no forgery keeps its end (the first `endobj` after
  // the true data end is the one the scanner already found).
  // Capture each span's end before extension: the bytes between the
  // guessed end and the true data end are the region the scanner
  // treated as syntax (not stream data) when it searched for the next
  // header — the span was truncated, so no region covered them.
  const preExtensionEnds = new Map<PdfObjectSpan, number>();
  for (const span of spans) preExtensionEnds.set(span, span.end);
  for (const span of spans) {
    if (removedSpans.has(span)) continue;
    const trueDataEnd = validatedDataEnds.get(span);
    if (trueDataEnd === undefined) continue;
    const endObjAt = text.indexOf("endobj", trueDataEnd);
    if (endObjAt < 0) throw unsupported();
    span.end = endObjAt + 6;
  }
  // Walk the skipped region, replicating findOutsideStrings's lexical
  // skipping — comments ARE skipped (as the scanner does), `(` opens
  // a literal string, `<<` a dict opener, and a lone `<` a hex string.
  // The region is walked in SEGMENTS split by the scanner's restart
  // points — the ends of removed spans inside the region. The scanner
  // does not scan continuously: it stops at a discovered header,
  // computes that header's end with a plain `indexOf("endobj", …)`
  // (which can land inside a `%` comment or a literal string — a
  // forged object with a direct `/Length 0` finds the `endobj`
  // written inside one), and restarts searching INSIDE the
  // comment/string with FRESH lexical state, where it treats a `(`
  // or `<` later on that line (or after the `endobj` inside the
  // string) as syntax. A walk that starts only from the outer span's
  // old end and skips a whole balanced string (or a whole comment)
  // never sees a `<` inside it — but the scanner, having restarted
  // inside it, treats the `<` as a hex-string opener and skips the
  // genuine object. Each segment therefore starts fresh at its
  // restart point; a skip that would jump past a restart point is
  // clamped to it (the scanner restarts there instead of skipping),
  // and only a skip past the true data end in the LAST segment (no
  // more restart points) rejects the file. A skip landing inside its
  // segment is harmless. Only extended spans are checked — a stream
  // the scanner did not truncate has no skipped region.
  // Linearity: every search is BOUNDED to the segment end — the
  // literal-string and comment skips take `segEnd` as their limit
  // (returning `limit + 1` when the construct does not close by it),
  // and the hex-string `>` is found by a manual scan that never goes
  // past `segEnd` — so no skip scans the whole remaining file before
  // clamping. Each byte is visited once: skips advance past the
  // skipped span (clamped to the segment end), not by one, and the
  // segments partition the region. A `<<` is also clamped to the
  // segment end, so a restart landing between its two `<` is covered
  // too (the second `<` is re-examined as a lone `<` in the next
  // segment). The restart points are collected once (sorted removed-
  // span ends) and binary-searched per span, not re-scanned from
  // `removedSpans` for every extended stream.
  const removedEnds = [...removedSpans].map((s) => s.end).sort((a, b) => a - b);
  const lowerBound = (arr: number[], value: number): number => {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((arr[mid] as number) < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (const span of spans) {
    if (removedSpans.has(span)) continue;
    const trueDataEnd = validatedDataEnds.get(span);
    if (trueDataEnd === undefined) continue;
    const oldEnd = preExtensionEnds.get(span);
    if (oldEnd === undefined || span.end <= oldEnd || oldEnd >= trueDataEnd) continue;
    // Restart points inside this region: the ends of removed spans
    // (each is just past an "endobj" the scanner found by plain
    // indexOf, so the scanner restarts there with fresh state).
    const fromIdx = lowerBound(removedEnds, oldEnd + 1);
    const toIdx = lowerBound(removedEnds, trueDataEnd);
    const boundaries = [oldEnd, ...removedEnds.slice(fromIdx, toIdx), trueDataEnd];
    for (let seg = 0; seg < boundaries.length - 1; seg++) {
      const segStart = boundaries[seg] as number;
      const segEnd = boundaries[seg + 1] as number;
      const isLast = seg === boundaries.length - 2;
      let i = segStart;
      while (i < segEnd) {
        const c = text[i];
        if (c === "%") {
          const after = skipPdfComment(text, i, segEnd);
          if (after > segEnd) {
            if (isLast) throw unsupported();
            i = segEnd;
          } else {
            i = after;
          }
        } else if (c === "(") {
          const after = skipPdfLiteralString(text, i, segEnd);
          if (after > segEnd) {
            if (isLast) throw unsupported();
            i = segEnd;
          } else {
            i = after;
          }
        } else if (text.startsWith("<<", i)) {
          i = Math.min(i + 2, segEnd);
        } else if (c === "<") {
          // Bounded hex-string search: never scan past segEnd. (A plain
          // `indexOf(">", i)` would scan the whole remaining file
          // before clamping.)
          let endHex = -1;
          for (let j = i; j < segEnd; j++) {
            if (text[j] === ">") {
              endHex = j;
              break;
            }
          }
          if (endHex < 0) {
            if (isLast) throw unsupported();
            i = segEnd;
          } else {
            i = endHex + 1;
          }
        } else {
          i++;
        }
      }
    }
  }
  // A removed forged span can hide a genuine object: the scanner may
  // have skipped it while computing the forged span's end from a forged
  // direct length (a forged `40 0 obj << /Length L >> stream` whose L
  // lands the scanner's `indexOf("endobj", dataStart + L)` past a
  // genuine object). Removing the forged span does not recover it — so
  // if a removed span's byte range contains a SECOND object header
  // (besides its own, at its start), a genuine object may have been
  // skipped and the file is rejected rather than silently losing
  // content. Rescuing it would require re-scanning speculative ranges;
  // the file is adversarial (it contains a forged object), so failing
  // closed is the right call.
  for (const span of removedSpans) {
    // A linear header count (not a regex — the comment-aware regex
    // backtracked exponentially on runs of `%` in ciphertext). The
    // span's own header is the first; a second header means a genuine
    // object may have been skipped.
    if (countPdfObjectHeaders(text, span.start, span.end) >= 2) throw unsupported();
  }
  // Rebuild the length map from the surviving spans so the rebuild loop
  // resolves indirect lengths through the same (forgery-free) objects
  // the validation used.
  lengthBodies.clear();
  spans.forEach((span, spanIndex) => {
    if (removedSpans.has(span)) return;
    lengthBodies.set(`${span.num} ${span.gen}`, text.slice(span.bodyStart, span.end - 6));
    const members = objStmMembers.get(spanIndex);
    if (members)
      for (const member of members)
        lengthBodies.set(`${member.num} 0`, Buffer.from(member.body).toString("latin1"));
  });
  // Rebuild: original header, every object decrypted in place, a fresh
  // classic xref table, and a trailer without /Encrypt, /Prev, /XRefStm.
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const headerEnd = spans[0].start;
  parts.push(bytes.subarray(0, headerEnd));
  // Phase 1 — decrypt every candidate (top-level spans and object-stream
  // members) into its emission PIECES (not a concatenated chunk) and
  // record the total length. Phase 2 selects the latest occurrence per
  // object number, computes the total output length from the winners'
  // piece lengths, checks the budget, and only THEN materializes the
  // winner chunks. Materializing every candidate chunk up front (the
  // old code) allocated and copied expanded member output — including
  // superseded candidates Phase 2 discards — before the budget charge
  // was checked, so the work was unaccounted. The decrypted pieces
  // themselves are still allocated here (the decryption produces them,
  // and inflation is already charged in expandPdfObjectStream); only
  // the extra `concatBytes` copy is deferred. An incremental update can
  // legitimately replace a compressed object with a plain one (or vice
  // versa), and the active revision is the last one in the file — the
  // old code rejected any such collision outright.
  interface PdfRebuildItem {
    num: number;
    gen: number;
    spanIndex: number;
    memberIndex: number; // -1 for a top-level span; the member index within its stream otherwise
    pieces: Uint8Array[]; // the `N G obj … endobj\n` chunk, as unconcatenated pieces
    length: number; // sum of the piece lengths (the chunk length, without allocating it)
  }
  const itemLength = (pieces: Uint8Array[]): number =>
    pieces.reduce((sum, piece) => sum + piece.length, 0);
  const items: PdfRebuildItem[] = [];
  spans.forEach((span, spanIndex) => {
    // Forged spans (removed by the validation above) never reach the
    // rebuild: their objects were ciphertext, not objects.
    if (removedSpans.has(span)) return;
    const key = objectKey(span.num, span.gen);
    const body = bytes.subarray(span.bodyStart, span.end - 6);
    const bodyText = Buffer.from(body).toString("latin1");
    const streamAt = findPdfStream(bodyText, 0);
    const dictText = streamAt >= 0 ? bodyText.slice(0, streamAt) : bodyText;
    const isEncryptDict = span.num === encryptNum && span.gen === encryptGen;
    const isXRefStream = pdfDictTopLevelRaw(dictText, "Type") === "/XRef";
    if (isXRefStream) {
      // A cross-reference stream is dropped, not copied: its dictionary
      // IS a trailer dictionary, and a sole-xref-stream file carries
      // /Root and /Encrypt there — copying it verbatim would plant a
      // second /Encrypt-bearing trailer in the output, and pdf-lib reads
      // any xref-stream dict as a trailer, so the decrypted file would
      // still report as encrypted. The rebuilt classic xref table and
      // trailer below replace it completely (the /Root, /Info, and /ID
      // are carried into the rebuilt trailer), and nothing references
      // the stream itself.
      return;
    }
    if (isEncryptDict) {
      // The encryption dict becomes an orphan once /Encrypt leaves the
      // trailer.
      const pieces = [
        encoder.encode(`${span.num} ${span.gen} obj`),
        body,
        encoder.encode("endobj\n"),
      ];
      items.push({
        num: span.num,
        gen: span.gen,
        spanIndex,
        memberIndex: -1,
        pieces,
        length: itemLength(pieces),
      });
      return;
    }
    if (streamAt >= 0) {
      // Exact stream boundaries (see pdfStreamDataRange): a resolved
      // /Length must land exactly on endstream; an indirect /Length that
      // is present but unresolvable throws instead of leaving ciphertext
      // behind. The check is `startsWith` at the calculated boundary —
      // encrypted stream data may itself contain an earlier `endstream`
      // sequence, so the first occurrence is not the boundary.
      if (pdfDictTopLevelRaw(dictText, "Type") === "/ObjStm") {
        // Expand the object stream: its members become ordinary objects.
        // Reuse the pre-pass expansion when present (no double inflation
        // charge); otherwise expand here, resolving lengths through the
        // enriched map, and fail closed if it cannot be resolved.
        if (pdfDictTopLevelRaw(dictText, "Filter") !== "/FlateDecode") throw unsupported();
        let members = objStmMembers.get(spanIndex);
        if (!members) {
          const range = pdfStreamDataRange(bodyText, streamAt, lengthBodies);
          const streamData = rc4(key, body.subarray(range.dataStart, range.dataEnd));
          members = expandPdfObjectStream(streamData, dictText, budget);
        }
        members.forEach((member, memberIndex) => {
          // The newline after `obj` is required: a member body is a bare
          // value (`42`, `null`, `true`) with no leading whitespace, and
          // `17 0 obj42` is not two tokens.
          const pieces = [
            encoder.encode(`${member.num} 0 obj\n`),
            member.body,
            encoder.encode("\nendobj\n"),
          ];
          items.push({
            num: member.num,
            gen: 0,
            spanIndex,
            memberIndex,
            pieces,
            length: itemLength(pieces),
          });
        });
      } else {
        const range = pdfStreamDataRange(bodyText, streamAt, lengthBodies);
        const head = decryptPdfStrings(body.subarray(0, range.dataStart), key);
        const streamData = rc4(key, body.subarray(range.dataStart, range.dataEnd));
        const tail = body.subarray(range.dataEnd);
        const pieces = [
          encoder.encode(`${span.num} ${span.gen} obj`),
          head,
          streamData,
          tail,
          encoder.encode("endobj\n"),
        ];
        items.push({
          num: span.num,
          gen: span.gen,
          spanIndex,
          memberIndex: -1,
          pieces,
          length: itemLength(pieces),
        });
      }
    } else {
      // A stray `stream` word with no dict close is malformed, not a
      // plain object: fail closed rather than string-decrypting stream
      // data. (A name containing "stream", e.g. /Downstream, is not one.)
      let stray = findOutsideStrings(bodyText, "stream", 0);
      while (stray >= 0) {
        const prev = bodyText[stray - 1];
        if (prev === undefined || isPdfWhitespaceOrDelimiter(prev)) throw unsupported();
        stray = findOutsideStrings(bodyText, "stream", stray + 6);
      }
      const pieces = [
        encoder.encode(`${span.num} ${span.gen} obj`),
        decryptPdfStrings(body, key),
        encoder.encode("endobj\n"),
      ];
      items.push({
        num: span.num,
        gen: span.gen,
        spanIndex,
        memberIndex: -1,
        pieces,
        length: itemLength(pieces),
      });
    }
  });
  // Phase 2 — the latest occurrence per number wins; emit winners in
  // file order so the output layout matches the old single-pass form.
  // Offsets are computed from the winners' recorded lengths, the
  // xref/trailer are built from those offsets, and the total output
  // length is checked against the budget — all BEFORE any winner chunk
  // is materialized. Only after the budget check passes are the winner
  // pieces concatenated into `parts` and the final output allocated.
  const winners = new Map<number, PdfRebuildItem>();
  for (const item of items) {
    const current = winners.get(item.num);
    if (
      current === undefined ||
      item.spanIndex > current.spanIndex ||
      (item.spanIndex === current.spanIndex && item.memberIndex > current.memberIndex)
    )
      winners.set(item.num, item);
  }
  const entries = new Map<number, { offset: number; gen: number }>();
  let pos = headerEnd;
  const ordered = [...winners.values()].sort(
    (a, b) => a.spanIndex - b.spanIndex || a.memberIndex - b.memberIndex,
  );
  for (const item of ordered) {
    entries.set(item.num, { offset: pos, gen: item.gen });
    pos += item.length;
  }
  let maxNum = 0;
  for (const num of entries.keys()) if (num > maxNum) maxNum = num;
  // A bound on the largest object number: the xref below is emitted as
  // subsections (one per run of present numbers), so no object number can
  // amplify the output — but an absurd /Size is still rejected outright.
  if (!Number.isSafeInteger(maxNum) || maxNum > 10_000_000) throw unsupported();
  const size = maxNum + 1;
  const xrefPos = pos;
  let xref = "xref\n0 1\n0000000000 65535 f \n";
  const present = [...entries.keys()].sort((a, b) => a - b);
  let runStart = -1;
  let runEntries: { offset: number; gen: number }[] = [];
  const flushRun = (): void => {
    if (runStart < 0) return;
    xref += `${runStart} ${runEntries.length}\n`;
    for (const entry of runEntries)
      xref += `${String(entry.offset).padStart(10, "0")} ${String(entry.gen).padStart(5, "0")} n \n`;
    runStart = -1;
    runEntries = [];
  };
  for (const num of present) {
    if (runStart < 0) {
      runStart = num;
      runEntries = [entries.get(num) as { offset: number; gen: number }];
    } else if (num === runStart + runEntries.length) {
      runEntries.push(entries.get(num) as { offset: number; gen: number });
    } else {
      flushRun();
      runStart = num;
      runEntries = [entries.get(num) as { offset: number; gen: number }];
    }
  }
  flushRun();
  const rootRef = pdfDictRef(trailerDict, "Root");
  const infoRef = pdfDictRef(trailerDict, "Info");
  let trailer = `trailer\n<< /Size ${size}`;
  if (rootRef) trailer += ` /Root ${rootRef.num} ${rootRef.gen} R`;
  if (infoRef) trailer += ` /Info ${infoRef.num} ${infoRef.gen} R`;
  if (ids.length > 0)
    trailer += ` /ID [${ids
      .map(
        (id) =>
          `<${[...id]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase()}>`,
      )
      .join("")}]`;
  trailer += ` >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  const xrefTrailerBytes = encoder.encode(xref + trailer);
  // Charge the output size BEFORE allocating it: the reserve taken before
  // the rebuild was the input size, so the adjustment is the
  // output-minus-input difference — and it must throw when it drives the
  // budget negative, instead of returning bytes the caller would then
  // parse before any budget check runs. The output length is computed
  // from the winners' recorded piece lengths plus the xref/trailer —
  // no winner chunk has been materialized yet, so an over-budget file
  // is refused before its expanded output is allocated (and superseded
  // candidates, which Phase 2 discards, are never materialized at all).
  const outLength = pos + xrefTrailerBytes.length;
  if (budget) {
    budget.remaining += bytes.length - outLength;
    if (budget.remaining < 0) throw new PdfError("PDF content expands beyond the supported size");
  }
  for (const item of ordered) parts.push(concatBytes(item.pieces));
  parts.push(xrefTrailerBytes);
  return concatBytes(parts);
}

async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  if (!bytes.length || bytes.length > MAX_PDF_BYTES || !pdfMarkerAtStart(bytes)) {
    throw new PdfError("Invalid PDF: expected nonempty PDF bytes up to 10 MiB");
  }
  patchDecodeStreamBudget();
  const budget = { remaining: MAX_DECODED_BYTES };
  return decodeBudget.run(budget, () => loadPdfInner(bytes, budget, false));
}

async function loadPdfInner(
  bytes: Uint8Array,
  budget: { remaining: number },
  decrypted: boolean,
): Promise<PDFDocument> {
  // Entry check: a decryptor call made as the argument to the recursive
  // loadPdfInner below returns its bytes before this function is entered,
  // so the budget must be checked here too — before PDFDocument.load
  // parses bytes that already drove it negative.
  if (budget.remaining < 0) throw new PdfError("PDF content expands beyond the supported size");
  try {
    const doc = await PDFDocument.load(new Uint8Array(bytes), {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
    });
    if (budget.remaining < 0) throw new PdfError("PDF content expands beyond the supported size");
    if (doc.isEncrypted) {
      if (decrypted) throw new PdfError("Encrypted PDFs are not supported");
      return loadPdfInner(decryptPdfWithEmptyPassword(bytes, budget), budget, true);
    }
    if (doc.getPageCount() < 1 || doc.getPageCount() > MAX_PDF_PAGES)
      throw new PdfError("PDF must contain between 1 and 500 pages");
    return doc;
  } catch (error) {
    // pdf-lib's parser can catch the limit error, then succeed or fail with its own error.
    if (budget.remaining < 0) throw new PdfError("PDF content expands beyond the supported size");
    if (error instanceof PdfError) throw error;
    if (error instanceof Error && /encrypt/i.test(error.message)) {
      if (decrypted) throw new PdfError("Encrypted PDFs are not supported", { cause: error });
      return loadPdfInner(decryptPdfWithEmptyPassword(bytes, budget), budget, true);
    }
    if (error instanceof Error && /Trying to parse invalid object/i.test(error.message)) {
      // Lenient retry PURELY to classify, inside the SAME decode budget:
      // the retry shares this one budget object, so it cannot double the
      // per-request decode work.
      try {
        await PDFDocument.load(new Uint8Array(bytes), {
          ignoreEncryption: false,
          throwOnInvalidObject: false,
          updateMetadata: false,
        });
      } catch (retryError) {
        if (budget.remaining < 0)
          throw new PdfError("PDF content expands beyond the supported size");
        if (retryError instanceof PdfError) throw retryError;
        if (retryError instanceof Error && /encrypt/i.test(retryError.message)) {
          if (decrypted)
            throw new PdfError("Encrypted PDFs are not supported", { cause: retryError });
          return loadPdfInner(decryptPdfWithEmptyPassword(bytes, budget), budget, true);
        }
        throw new PdfError("Invalid or malformed PDF", { cause: error });
      }
      // Lenient load succeeded: a strict-parse casualty. Strict parsing is
      // kept deliberately — lenient recovery can silently drop page text
      // (see SPEC.md F3) — so reject with an accurate message. The budget
      // is checked first: pdf-lib can swallow a budget error and still
      // return a document, and that must not become a parse message.
      if (budget.remaining < 0) throw new PdfError("PDF content expands beyond the supported size");
      throw new PdfError("PDF could not be parsed", { cause: error });
    }
    throw new PdfError("Invalid or malformed PDF", { cause: error });
  }
}

function inspectField(field: PDFField): PdfInspection["fields"][number] {
  const name = field.getName();
  if (field instanceof PDFTextField) {
    const value = field.acroField.dict.lookup(PDFName.of("V"));
    if (value !== undefined && !(value instanceof PDFString) && !(value instanceof PDFHexString)) {
      throw new PdfError("Cannot inspect PDF: a text field contains a malformed value");
    }
    return { name, value: field.getText() ?? "", type: "text" };
  }
  if (field instanceof PDFCheckBox)
    return { name, value: String(field.isChecked()), type: "checkbox" };
  const value =
    field instanceof PDFDropdown || field instanceof PDFOptionList
      ? field.getSelected().join(", ")
      : field instanceof PDFRadioGroup
        ? (field.getSelected() ?? "")
        : "";
  return { name, value, type: "unsupported" };
}

export async function inspectPdf(bytes: Uint8Array): Promise<PdfInspection> {
  return pdfOperation(async () => {
    // XFA packet decoding runs inside its own decode budget (loadPdf's
    // budget ends when loadPdf returns): a hostile packet still cannot
    // expand without bound after the document itself has loaded.
    return decodeBudget.run({ remaining: MAX_DECODED_BYTES }, async () => {
      const doc = await loadPdf(bytes);
      const pageCount = doc.getPageCount();
      if (hasXfa(doc)) {
        // Read packets BEFORE any getForm() call: pdf-lib's getForm()
        // deletes the /XFA entry from the loaded document.
        try {
          const xfa = inspectXfa(doc);
          return { pageCount, fields: xfa.fields, formKind: xfa.formKind };
        } catch (error) {
          if (error instanceof XfaError) throw new PdfError(error.message, { cause: error });
          throw error;
        }
      }
      const fields = doc.getForm().getFields().map(inspectField);
      return {
        pageCount,
        fields,
        formKind: fields.length > 0 ? "acroform" : "none",
      };
    });
  }, "Cannot inspect PDF: the document contains malformed or unsupported form fields");
}

/** Strip action entry points in the new output; never execute PDF scripts. */
function removeActions(doc: PDFDocument): void {
  const visited = new Set<PDFObject>();
  const visit = (object: PDFObject): void => {
    if (visited.has(object)) return;
    visited.add(object);
    if (object instanceof PDFDict) {
      for (const key of ["OpenAction", "AA", "A", "JS", "JavaScript"])
        object.delete(PDFName.of(key));
      for (const value of object.values()) visit(value);
    } else if (object instanceof PDFArray) {
      for (const value of object.asArray()) visit(value);
    }
  };
  for (const [, object] of doc.context.enumerateIndirectObjects()) visit(object);
}

export async function fillPdf(
  bytes: Uint8Array,
  values: Record<string, string | boolean>,
): Promise<Uint8Array> {
  return pdfOperation(async () => {
    const doc = await loadPdf(bytes);
    // Fill is B2: never let getForm() silently delete the XFA entry and
    // fill only the AcroForm twin of a hybrid form.
    if (hasXfa(doc))
      throw new PdfError("Unsupported XFA PDF form: filling XFA forms is not supported yet");
    const form = doc.getForm();
    const fields = new Map(form.getFields().map((field) => [field.getName(), field]));
    const filled: PDFField[] = [];
    for (const [name, value] of Object.entries(values)) {
      const field = fields.get(name);
      if (!field) throw new PdfError(`Unknown PDF field: ${name}`);
      if (field instanceof PDFTextField) {
        if (typeof value !== "string")
          throw new PdfError(`PDF text field requires a string: ${name}`);
        if (value.length > 10000) throw new PdfError(`PDF text field value is too long: ${name}`);
        field.setText(value);
      } else if (field instanceof PDFCheckBox) {
        if (typeof value !== "boolean")
          throw new PdfError(`PDF checkbox requires a boolean: ${name}`);
        if (value) field.check();
        else field.uncheck();
      } else {
        throw new PdfError(`Unsupported PDF field: ${name}`);
      }
      filled.push(field);
    }
    removeActions(doc);
    try {
      // Re-render appearances only for the fields actually filled. Rendering
      // every field rewrites untouched fields in Helvetica, discarding the
      // form's own fonts for values this call never touched. save() must not
      // re-render either: its default updateFieldAppearances pass would
      // regenerate every field lacking an appearance stream in the form
      // default font. The filled fields above are already rendered.
      const font = await doc.embedFont(StandardFonts.Helvetica);
      for (const field of filled) {
        if (field instanceof PDFTextField) field.updateAppearances(font);
        else if (field instanceof PDFCheckBox) field.updateAppearances();
      }
      return await doc.save({ updateFieldAppearances: false });
    } catch {
      throw new PdfError(
        "Could not render PDF field values; use characters supported by this form's font or choose a compatible PDF form",
      );
    }
  }, "Could not fill PDF: the document contains malformed or unsupported form fields");
}

/** Original synthetic fixture. Personal details remain blank until explicitly supplied. */
export async function createSamplePdf(): Promise<Uint8Array> {
  return pdfOperation(async () => {
    const doc = await PDFDocument.create();
    doc.setTitle("Community visit - permission form");
    doc.setAuthor("OpenMuse");
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const ink = rgb(0.12, 0.19, 0.2);
    const teal = rgb(0.18, 0.4, 0.4);
    const form = doc.getForm();
    const pages = [doc.addPage([612, 792]), doc.addPage([612, 792])];
    for (const [index, page] of pages.entries()) {
      page.drawRectangle({ x: 0, y: 682, width: 612, height: 110, color: rgb(0.9, 0.95, 0.93) });
      page.drawText("OPENMUSE / COMMUNITY VISIT", {
        x: 48,
        y: 750,
        size: 10,
        font: bold,
        color: teal,
      });
      page.drawText(index === 0 ? "Community visit" : "Permission & contacts", {
        x: 48,
        y: 710,
        size: 28,
        font: bold,
        color: ink,
      });
      page.drawLine({
        start: { x: 48, y: 55 },
        end: { x: 564, y: 55 },
        color: rgb(0.8, 0.85, 0.83),
        thickness: 1,
      });
      page.drawText("EXAMPLE FORM - no real participant or organization", {
        x: 48,
        y: 35,
        size: 9,
        font: regular,
        color: teal,
      });
      page.drawText(`${index + 1} / 2`, { x: 535, y: 35, size: 9, font: regular, color: teal });
    }
    const first = pages[0];
    const second = pages[1];
    first.drawText("A day of discovery at the community museum", {
      x: 48,
      y: 640,
      size: 16,
      font: bold,
      color: ink,
    });
    const details = [
      "Please complete both pages of this permission form.",
      "The visit, organization, and schedule below are fictional.",
      "Schedule: Saturday, October 10, 2026 / 10:00-14:00",
      "Activities: guided exhibits, a sketching workshop, and a lunch break.",
      "Bring: a packed lunch, water, and comfortable shoes.",
    ];
    details.forEach((line, index) => {
      first.drawText(line, { x: 48, y: 606 - index * 25, size: 11, font: regular, color: ink });
    });
    const addText = (
      page: typeof first,
      name: string,
      label: string,
      y: number,
      multiline = false,
    ) => {
      page.drawText(label, {
        x: 48,
        y: y + (multiline ? 72 : 40),
        size: 11,
        font: bold,
        color: ink,
      });
      const field = form.createTextField(name);
      if (multiline) field.enableMultiline();
      field.addToPage(page, {
        x: 48,
        y,
        width: 516,
        height: multiline ? 62 : 30,
        borderWidth: 1,
        borderColor: rgb(0.65, 0.75, 0.71),
        backgroundColor: rgb(1, 1, 1),
        font: regular,
      });
      field.setFontSize(12);
    };
    addText(first, "participant_name", "Participant name", 395);
    addText(first, "guardian_name", "Parent or guardian name (if applicable)", 305);
    first.drawText("Continue to page 2 for emergency contacts and permission.", {
      x: 48,
      y: 210,
      size: 11,
      font: regular,
      color: teal,
    });
    addText(second, "emergency_contact", "Emergency contact name", 580);
    addText(second, "emergency_phone", "Emergency contact phone", 490);
    addText(second, "additional_notes", "Additional notes (optional)", 375, true);
    const permission = form.createCheckBox("permission_granted");
    permission.addToPage(second, {
      x: 48,
      y: 290,
      width: 18,
      height: 18,
      borderWidth: 1,
      borderColor: teal,
    });
    second.drawText("I give permission for the participant to attend the community visit.", {
      x: 78,
      y: 295,
      size: 11,
      font: regular,
      color: ink,
    });
    second.drawText("This checkbox records permission; it is not a digital signature.", {
      x: 48,
      y: 235,
      size: 10,
      font: regular,
      color: teal,
    });
    form.updateFieldAppearances(regular);
    return doc.save();
  }, "Could not create the sample PDF");
}
