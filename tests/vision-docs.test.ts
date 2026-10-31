// Vision + document reading: attached images are sent to the model as image
// content parts (never invented descriptions), and Word, spreadsheet, and
// presentation files are extracted to text. Unsupported or oversized files
// get plain errors, never fake contents.
import assert from "node:assert/strict";
import test from "node:test";
import { EventType } from "@ag-ui/core";
import { isContentPartArray } from "@tanstack/ai";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
  extractDocumentText,
  isExtractableDocumentMime,
} from "../apps/server/src/engine/document-text.ts";
import { textOnlyToolResult } from "../apps/server/src/engine/tanstack-agent.ts";
import { isVisionMime, VISION_MAX_BYTES, visionParts } from "../apps/server/src/engine/vision.ts";
import { readabilityNote } from "../apps/server/src/files.ts";

const pngBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("vision parts are valid content parts that round-trip the image bytes", async () => {
  const result = await visionParts("photo.png", "image/png", pngBytes);
  assert.ok(!("error" in result));
  assert.equal(isContentPartArray(result.parts), true);
  const [text, image] = result.parts;
  assert.equal(text.type, "text");
  assert.equal(image.type, "image");
  if (image.type === "image") {
    assert.equal(image.source.type, "data");
    assert.equal(image.source.mimeType, "image/png");
    if (image.source.type === "data")
      assert.deepEqual(Buffer.from(image.source.value, "base64"), pngBytes);
  }
});

test("vision rejects unsupported image types and oversized images plainly", async () => {
  assert.equal(isVisionMime("image/png"), true);
  assert.equal(isVisionMime("image/jpeg"), true);
  assert.equal(isVisionMime("image/bmp"), false);
  assert.equal(isVisionMime("image/svg+xml"), false);
  // PNG bytes labeled as BMP are not a BMP at all, so conversion fails
  // plainly instead of producing a fake image.
  const bmp = await visionParts("scan.bmp", "image/bmp", pngBytes);
  assert.ok("error" in bmp);
  assert.match(bmp.error, /could not be converted/);
  const big = await visionParts("huge.png", "image/png", Buffer.alloc(VISION_MAX_BYTES + 1));
  assert.ok("error" in big);
  assert.match(big.error, /too large to view in chat/);
});

test("stored history keeps only the text parts of a vision tool result", async () => {
  const result = await visionParts("photo.png", "image/png", pngBytes);
  assert.ok(!("error" in result));
  const event = {
    type: EventType.TOOL_CALL_RESULT,
    content: JSON.stringify(result.parts),
  } as Parameters<typeof textOnlyToolResult>[0];
  const stripped = textOnlyToolResult(event) as { content?: unknown };
  assert.equal(typeof stripped.content, "string");
  assert.match(stripped.content as string, /Attached image "photo\.png"/);
  assert.doesNotMatch(stripped.content as string, /iVBORw0KGgo/);
});

test("docx text is extracted from document paragraphs", async () => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello Veritas</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>',
  );
  const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  const extracted = await extractDocumentText(
    bytes,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.ok(extracted.ok);
  assert.match(extracted.text, /Hello Veritas/);
  assert.match(extracted.text, /Second paragraph/);
});

test("xlsx text is extracted sheet by sheet", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Name", "Fee"],
      ["Signing", "150"],
    ]),
    "Jobs",
  );
  const bytes = new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  const extracted = await extractDocumentText(
    bytes,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.ok(extracted.ok);
  assert.match(extracted.text, /Sheet: Jobs/);
  assert.match(extracted.text, /Signing/);
  assert.match(extracted.text, /150/);
});

test("pptx text is extracted from slide text runs", async () => {
  const zip = new JSZip();
  zip.file(
    "ppt/slides/slide1.xml",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Welcome slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
  );
  const bytes = new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
  const extracted = await extractDocumentText(
    bytes,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  );
  assert.ok(extracted.ok);
  assert.match(extracted.text, /Welcome slide/);
});

test("legacy binary PowerPoint and unknown types are refused plainly", async () => {
  assert.equal(
    isExtractableDocumentMime(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    true,
  );
  // Legacy .doc and .xls are now extracted (word-extractor / xlsx); only
  // legacy .ppt still has no sound pure-JS extractor.
  assert.equal(isExtractableDocumentMime("application/msword"), true);
  assert.equal(isExtractableDocumentMime("application/vnd.ms-excel"), true);
  assert.equal(isExtractableDocumentMime("application/vnd.ms-powerpoint"), false);
  const legacy = await extractDocumentText(
    new Uint8Array([1, 2, 3]),
    "application/vnd.ms-powerpoint",
  );
  assert.ok(!legacy.ok);
  assert.match(legacy.error, /not available/);
  const unknown = await extractDocumentText(new Uint8Array([1, 2, 3]), "application/zip");
  assert.ok(!unknown.ok);
  assert.match(unknown.error, /not readable as text/);
  assert.match(readabilityNote("image/bmp"), /converted to PNG/);
  assert.match(readabilityNote("application/msword"), /text is extracted/);
  assert.match(readabilityNote("application/vnd.ms-powerpoint"), /not available/);
});
