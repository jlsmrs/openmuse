// Convert-then-read pipeline: every uploaded file is identified, read
// directly when possible, converted and then read when a conversion exists,
// and refused plainly otherwise. These tests prove each conversion actually
// happens (real fixtures and real decoders), plus the archive guards.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  ARCHIVE_MAX_IMAGES,
  ARCHIVE_MAX_MEMBERS,
  isArchiveMime,
  readArchive,
} from "../apps/server/src/engine/archive.ts";
import { extractDocumentText } from "../apps/server/src/engine/document-text.ts";
import { extractPdfText } from "../apps/server/src/engine/pdf-text.ts";
import { visionParts } from "../apps/server/src/engine/vision.ts";
import { readabilityNote } from "../apps/server/src/files.ts";

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

// --- TIFF builder (little-endian, stripped, uncompressed) -----------------
function buildTiff(pages: Array<{ width: number; height: number; rgb: number[] }>): Buffer {
  // Pages are stored sequentially: header, IFD, strip, IFD, strip, ...
  const chunks: Buffer[] = [];
  let offset = 8;
  const pageOffsets: number[] = [];
  for (const page of pages) {
    const strip = Buffer.from(page.rgb);
    const entryCount = 10;
    const ifdSize = 2 + entryCount * 12 + 4;
    const stripOffset = offset + ifdSize;
    pageOffsets.push(offset);
    const ifd = Buffer.alloc(ifdSize);
    const view = new DataView(ifd.buffer, ifd.byteOffset, ifd.byteLength);
    view.setUint16(0, entryCount, true);
    const set = (i: number, tag: number, type: number, count: number, value: number) => {
      const o = 2 + i * 12;
      view.setUint16(o, tag, true);
      view.setUint16(o + 2, type, true);
      view.setUint32(o + 4, count, true);
      view.setUint32(o + 8, value, true);
    };
    set(0, 256, 4, 1, page.width);
    set(1, 257, 4, 1, page.height);
    set(2, 258, 3, 3, stripOffset + strip.length); // BitsPerSample lives after the strip
    set(3, 259, 3, 1, 1);
    set(4, 262, 3, 1, 2);
    set(5, 273, 4, 1, stripOffset);
    set(6, 277, 3, 1, 3);
    set(7, 278, 4, 1, page.height);
    set(8, 279, 4, 1, strip.length);
    set(9, 284, 3, 1, 1);
    const nextIfd = 0; // patched below once the next page offset is known
    view.setUint32(2 + entryCount * 12, nextIfd, true);
    const bits = Buffer.alloc(6);
    bits.writeUInt16LE(8, 0);
    bits.writeUInt16LE(8, 2);
    bits.writeUInt16LE(8, 4);
    chunks.push(ifd, strip, bits);
    offset = stripOffset + strip.length + 6;
  }
  // Chain the IFDs: each IFD's next pointer targets the following page's IFD.
  for (let p = 0; p < pages.length; p++) {
    const ifd = chunks[p * 3] as Buffer;
    const next = p + 1 < pages.length ? pageOffsets[p + 1] : 0;
    ifd.writeUInt32LE(next, 2 + 10 * 12);
  }
  const header = Buffer.alloc(8);
  header.write("II", 0);
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  return Buffer.concat([header, ...chunks]);
}

function buildGrayTiff(width: number, height: number, gray: number[]): Buffer {
  const strip = Buffer.from(gray);
  const entryCount = 9;
  const ifdSize = 2 + entryCount * 12 + 4;
  const stripOffset = 8 + ifdSize;
  const ifd = Buffer.alloc(ifdSize);
  const view = new DataView(ifd.buffer, ifd.byteOffset, ifd.byteLength);
  view.setUint16(0, entryCount, true);
  const set = (i: number, tag: number, type: number, count: number, value: number) => {
    const o = 2 + i * 12;
    view.setUint16(o, tag, true);
    view.setUint16(o + 2, type, true);
    view.setUint32(o + 4, count, true);
    view.setUint32(o + 8, value, true);
  };
  set(0, 256, 4, 1, width);
  set(1, 257, 4, 1, height);
  set(2, 258, 3, 1, 8);
  set(3, 259, 3, 1, 1);
  set(4, 262, 3, 1, 1);
  set(5, 273, 4, 1, stripOffset);
  set(6, 277, 3, 1, 1);
  set(7, 278, 4, 1, height);
  set(8, 279, 4, 1, strip.length);
  view.setUint32(2 + entryCount * 12, 0, true);
  const header = Buffer.alloc(8);
  header.write("II", 0);
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  return Buffer.concat([header, ifd, strip]);
}

// --- TAR builder ------------------------------------------------------------
function tarEntry(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write("0000644\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
  header.write("00000000000\0", 136);
  header[156] = "0".charCodeAt(0);
  header.write("ustar\0", 257);
  header.write("00", 263);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
  const blocks = Math.ceil(content.length / 512);
  const data = Buffer.alloc(blocks * 512);
  content.copy(data);
  return Buffer.concat([header, data]);
}

function tarArchive(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([...entries.map(([n, c]) => tarEntry(n, c)), Buffer.alloc(1024)]);
}

test("TIFF images are decoded to PNG and viewed", async () => {
  const tiff = buildTiff([{ width: 2, height: 1, rgb: [255, 0, 0, 0, 255, 0] }]);
  const result = await visionParts("scan.tiff", "image/tiff", new Uint8Array(tiff));
  assert.ok(!("error" in result));
  const [text, image] = result.parts;
  assert.equal(text.type, "text");
  if (text.type === "text") assert.match(text.content, /converted to PNG/);
  assert.equal(image.type, "image");
  if (image.type === "image") assert.equal(image.source.mimeType, "image/png");

  const gray = buildGrayTiff(2, 1, [0, 255]);
  const grayResult = await visionParts("gray.tiff", "image/tiff", new Uint8Array(gray));
  assert.ok(!("error" in grayResult));
  if ("parts" in grayResult) {
    const grayImage = grayResult.parts[1];
    assert.equal(grayImage?.type, "image");
  }
});

test("multi-page TIFFs show only the first page, and say so", async () => {
  const tiff = buildTiff([
    { width: 1, height: 1, rgb: [255, 0, 0] },
    { width: 1, height: 1, rgb: [0, 0, 255] },
  ]);
  const result = await visionParts("multi.tiff", "image/tiff", new Uint8Array(tiff));
  assert.ok(!("error" in result));
  const text = result.parts[0];
  assert.equal(text.type, "text");
  if (text.type === "text") assert.match(text.content, /only the first page/);
});

test("legacy .xls is extracted with the same xlsx reader", async () => {
  const extracted = await extractDocumentText(
    new Uint8Array(fixture("content-test.xls")),
    "application/vnd.ms-excel",
  );
  assert.ok(extracted.ok);
  assert.match(extracted.text, /Veritas vision test cell/);
  assert.match(extracted.text, /Second row value/);
});

test("legacy .doc is extracted with word-extractor", async () => {
  const extracted = await extractDocumentText(
    new Uint8Array(fixture("upload-test.doc")),
    "application/msword",
  );
  assert.ok(extracted.ok);
  assert.match(extracted.text, /Charlie docx test paragraph\./);
});

test("legacy .ppt is still refused plainly (no sound pure-JS reader)", async () => {
  const refused = await extractDocumentText(
    new Uint8Array([1, 2, 3]),
    "application/vnd.ms-powerpoint",
  );
  assert.ok(!refused.ok);
  assert.match(refused.error, /not available/);
  assert.match(readabilityNote("application/vnd.ms-powerpoint"), /not available/);
});

test("PDF full text is extracted in-process", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page1 = doc.addPage();
  page1.drawText("Veritas PDF extraction test page one", { x: 50, y: 700, font, size: 24 });
  const page2 = doc.addPage();
  page2.drawText("second page follows", { x: 50, y: 700, font, size: 24 });
  const bytes = await doc.save();
  const extracted = await extractPdfText(new Uint8Array(bytes));
  assert.ok(extracted.ok);
  assert.equal(extracted.pageCount, 2);
  assert.match(extracted.text, /Veritas PDF extraction test page one/);
  assert.match(extracted.text, /second page follows/);
  const broken = await extractPdfText(new Uint8Array([1, 2, 3, 4]));
  assert.ok(!broken.ok);
});

test("PDF text extraction accepts a Node Buffer, not just a plain Uint8Array", async () => {
  // Regression: production file bytes arrive as Buffers (fs.readFile),
  // and pdfjs-dist 6 rejects Buffer input. Passing a Buffer here must
  // extract, not fall back to the metadata reply.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  page.drawText("Buffer input PDF test", { x: 50, y: 700, font, size: 24 });
  const saved = await doc.save();
  const extracted = await extractPdfText(Buffer.from(saved));
  assert.ok(extracted.ok);
  assert.equal(extracted.pageCount, 1);
  assert.match(extracted.text, /Buffer input PDF test/);
});

test("ZIP members run through the same pipeline, including nested zips", async () => {
  const inner = new JSZip();
  inner.file("deep.txt", "deep inside");
  const innerBytes = await inner.generateAsync({ type: "uint8array" });
  const outer = new JSZip();
  outer.file("hello.txt", "hello archive world");
  outer.file("pic.png", pngBytes);
  outer.file("inner.zip", innerBytes);
  const bytes = await outer.generateAsync({ type: "uint8array" });
  const archive = await readArchive(new Uint8Array(bytes), "bundle.zip", "application/zip");
  assert.ok(archive.ok);
  assert.match(archive.summary, /hello archive world/);
  assert.match(archive.summary, /deep inside/);
  assert.match(archive.summary, /included for viewing/);
  const imageParts = archive.imageParts.filter((part) => part.type === "image");
  assert.equal(imageParts.length, 1);
  assert.equal(archive.truncated, false);
});

test("TAR and TAR.GZ members are read", async () => {
  const tar = tarArchive([
    ["notes.txt", Buffer.from("tar note here")],
    ["data.csv", Buffer.from("a,b\n1,2\n")],
  ]);
  const plain = await readArchive(new Uint8Array(tar), "bundle.tar", "application/x-tar");
  assert.ok(plain.ok);
  assert.match(plain.summary, /tar note here/);
  assert.match(plain.summary, /1,2/);
  const gzipped = gzipSync(tar);
  const gz = await readArchive(new Uint8Array(gzipped), "bundle.tgz", "application/gzip");
  assert.ok(gz.ok);
  assert.match(gz.summary, /tar note here/);
});

test("archive guards: member count, total size, per-member size, depth, image count", async () => {
  // Member count cap.
  const many = new JSZip();
  for (let i = 0; i < ARCHIVE_MAX_MEMBERS + 1; i++) many.file(`f${i}.txt`, "x");
  const manyBytes = await many.generateAsync({ type: "uint8array" });
  const manyResult = await readArchive(new Uint8Array(manyBytes), "many.zip", "application/zip");
  assert.ok(manyResult.ok);
  assert.equal(manyResult.truncated, true);
  assert.match(manyResult.summary, /member limit/);

  // Total uncompressed cap via tar (3 x 9 MB zeros = 27 MB).
  const big = Buffer.alloc(9 * 1024 * 1024);
  const tar = tarArchive([
    ["a.bin", big],
    ["b.bin", big],
    ["c.bin", big],
  ]);
  const totalResult = await readArchive(new Uint8Array(tar), "big.tar", "application/x-tar");
  assert.ok(totalResult.ok);
  assert.equal(totalResult.truncated, true);
  assert.match(totalResult.summary, /exceed 25 MB/);

  // Per-member cap via a deflated zip bomb (30 MB of zeros).
  const bomb = new JSZip();
  bomb.file("zeros.bin", Buffer.alloc(30 * 1024 * 1024), { compression: "DEFLATE" });
  const bombBytes = await bomb.generateAsync({ type: "uint8array" });
  const bombResult = await readArchive(new Uint8Array(bombBytes), "bomb.zip", "application/zip");
  assert.ok(bombResult.ok);
  assert.equal(bombResult.truncated, true);
  assert.match(bombResult.summary, /exceeds 10 MB/);

  // Depth cap: outer -> mid -> inner -> deep.txt; deep.txt never appears.
  const innermost = new JSZip();
  innermost.file("deep.txt", "too deep");
  const innerBytes = await innermost.generateAsync({ type: "uint8array" });
  const middle = new JSZip();
  middle.file("inner.zip", innerBytes);
  const middleBytes = await middle.generateAsync({ type: "uint8array" });
  const outer = new JSZip();
  outer.file("mid.zip", middleBytes);
  const outerBytes = await outer.generateAsync({ type: "uint8array" });
  const depthResult = await readArchive(new Uint8Array(outerBytes), "outer.zip", "application/zip");
  assert.ok(depthResult.ok);
  assert.doesNotMatch(depthResult.summary, /too deep/);
  assert.match(depthResult.summary, /deeper than 2 levels/);

  // Image count cap.
  const images = new JSZip();
  for (let i = 0; i < ARCHIVE_MAX_IMAGES + 1; i++) images.file(`p${i}.png`, pngBytes);
  const imagesBytes = await images.generateAsync({ type: "uint8array" });
  const imagesResult = await readArchive(
    new Uint8Array(imagesBytes),
    "pics.zip",
    "application/zip",
  );
  assert.ok(imagesResult.ok);
  assert.equal(
    imagesResult.imageParts.filter((part) => part.type === "image").length,
    ARCHIVE_MAX_IMAGES,
  );
  assert.match(imagesResult.summary, /image limit reached/);
});

test("non-archives and broken archives are refused plainly", async () => {
  const notArchive = await readArchive(pngBytes, "pic.png", "image/png");
  assert.ok(!notArchive.ok);
  const broken = await readArchive(new Uint8Array([1, 2, 3, 4]), "broken.zip", "application/zip");
  if (broken.ok) assert.match(broken.summary, /could not be opened/);
});

test("readability notes reflect the pipeline", () => {
  assert.match(readabilityNote("application/pdf"), /full text is extracted/);
  assert.match(readabilityNote("image/tiff"), /converted to PNG/);
  assert.match(readabilityNote("application/zip"), /archive/);
  assert.match(readabilityNote("application/x-tar"), /archive/);
  assert.match(readabilityNote("application/vnd.ms-excel"), /text is extracted/);
  assert.equal(isArchiveMime("application/zip", "a.zip"), true);
  assert.equal(isArchiveMime("application/x-tar", "a.tar"), true);
  assert.equal(isArchiveMime("application/gzip", "a.tgz"), true);
  assert.equal(isArchiveMime("application/gzip", "a.gz"), false);
  assert.equal(isArchiveMime("image/png", "a.png"), false);
});
