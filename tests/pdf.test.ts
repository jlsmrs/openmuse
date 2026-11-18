import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deflateSync } from "node:zlib";
import {
  decodePDFRawStream,
  PDFContext,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
} from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  createSamplePdf,
  decryptPdfWithEmptyPassword,
  expandPdfObjectStream,
  fillPdf,
  inspectPdf,
  PdfError,
} from "../packages/integrations/src/pdf.ts";

// This test must stay first in this file: it asserts the decode-budget patch
// is not installed at import time, so no earlier test may have loaded a PDF.
test("decode-budget patch installs on first PDF load, not at import time", async () => {
  const decodeStreamPrototype = () => {
    let proto = Object.getPrototypeOf(
      decodePDFRawStream(
        PDFRawStream.of(PDFContext.create().obj({ Filter: "ASCIIHexDecode" }), new Uint8Array()),
      ),
    );
    while (proto && !Object.hasOwn(proto, "ensureBuffer")) proto = Object.getPrototypeOf(proto);
    return proto;
  };
  const before = decodeStreamPrototype().ensureBuffer;
  await inspectPdf(await createSamplePdf());
  assert.notEqual(decodeStreamPrototype().ensureBuffer, before);
});

test("sample is an actual two-page PDF with blank fillable fields", async () => {
  const bytes = await createSamplePdf();
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), "%PDF-");
  const details = await inspectPdf(bytes);
  assert.equal(details.pageCount, 2);
  for (const name of [
    "participant_name",
    "guardian_name",
    "emergency_contact",
    "emergency_phone",
  ]) {
    assert.deepEqual(
      details.fields.find((field) => field.name === name),
      { name, value: "", type: "text" },
    );
  }
  assert.deepEqual(
    details.fields.find((field) => field.name === "permission_granted"),
    {
      name: "permission_granted",
      value: "false",
      type: "checkbox",
    },
  );
});

test("filling changes only the new PDF and round-trips text and checkbox values", async () => {
  const source = await createSamplePdf();
  const original = new Uint8Array(source);
  const filled = await fillPdf(source, {
    participant_name: "Test Participant",
    guardian_name: "Test Guardian",
    permission_granted: true,
  });
  assert.deepEqual(source, original);
  assert.notDeepEqual(filled, source);
  const doc = await PDFDocument.load(filled);
  assert.equal(doc.getPageCount(), 2);
  assert.equal(doc.getForm().getTextField("participant_name").getText(), "Test Participant");
  assert.equal(doc.getForm().getCheckBox("permission_granted").isChecked(), true);
  assert.equal(
    (await PDFDocument.load(source)).getForm().getTextField("participant_name").getText() ?? "",
    "",
  );
  const cleared = await fillPdf(filled, { permission_granted: false });
  assert.equal(
    (await PDFDocument.load(cleared)).getForm().getCheckBox("permission_granted").isChecked(),
    false,
  );
});

test("PDF marker must sit at the start of the file, not buried inside it", async () => {
  const sample = await createSamplePdf();
  // A UTF-8 BOM before the marker is tolerated.
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...sample]);
  assert.equal((await inspectPdf(bom)).pageCount, 2);
  // The same marker 500 bytes in is not a PDF header.
  const buried = new Uint8Array(500 + sample.length);
  buried.set(sample, 500);
  await assert.rejects(inspectPdf(buried), /invalid|malformed/i);
  await assert.rejects(fillPdf(buried, {}), /invalid|malformed/i);
});

test("filling one field leaves an untouched field's appearance alone", async () => {
  // A form with no appearance streams at all: every field needs one, so the
  // old render-everything pass re-rendered all of them in Helvetica.
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const form = doc.getForm();
  form.createTextField("filled_name").addToPage(page, { x: 40, y: 700, width: 200, height: 24 });
  const untouched = form.createTextField("untouched_name");
  untouched.addToPage(page, { x: 40, y: 650, width: 200, height: 24 });
  // An untouched field holding characters Helvetica cannot render: the old
  // pass failed the whole fill on it.
  untouched.setText("漢字");
  for (const field of form.getFields()) {
    for (const widget of field.acroField.getWidgets()) widget.dict.delete(PDFName.of("AP"));
  }
  const bytes = await doc.save({ updateFieldAppearances: false });
  const filled = await fillPdf(bytes, { filled_name: "Test Participant" });
  const result = await PDFDocument.load(filled);
  assert.equal(result.getForm().getTextField("filled_name").getText(), "Test Participant");
  assert.equal(result.getForm().getTextField("untouched_name").getText(), "漢字");
});

test("PDF operations reject invalid bytes, encrypted input, unknown names, and wrong field types", async () => {
  for (const bytes of [new Uint8Array(), Buffer.from("not a PDF")]) {
    await assert.rejects(inspectPdf(bytes), /invalid|malformed|empty/i);
    await assert.rejects(fillPdf(bytes, {}), /invalid|malformed|empty/i);
  }
  const sample = await createSamplePdf();
  await assert.rejects(fillPdf(sample, { missing: "value" }), /unknown.*missing/i);
  await assert.rejects(fillPdf(sample, { permission_granted: "yes" }), /boolean/i);
  await assert.rejects(fillPdf(sample, { participant_name: true }), /text|string/i);

  const encrypted = await PDFDocument.create();
  encrypted.addPage();
  // An encryption dictionary is enough to exercise pdf-lib's encrypted-document guard.
  encrypted.context.trailerInfo.Encrypt = encrypted.context.register(
    encrypted.context.obj({ Filter: "Standard", V: 1 }),
  );
  await assert.rejects(inspectPdf(await encrypted.save()), /encrypted/i);
});

test("unsupported fields are disclosed and cannot be silently filled", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage();
  const dropdown = doc.getForm().createDropdown("visit_type");
  dropdown.addOptions(["Museum", "Garden"]);
  dropdown.select("Museum");
  dropdown.addToPage(page, { x: 40, y: 500, width: 180, height: 30 });
  const bytes = await doc.save();
  assert.deepEqual((await inspectPdf(bytes)).fields, [
    { name: "visit_type", value: "Museum", type: "unsupported" },
  ]);
  await assert.rejects(fillPdf(bytes, { visit_type: "Garden" }), /unsupported.*visit_type/i);
});

test("PDF output removes active actions before returning a filled document", async () => {
  const doc = await PDFDocument.load(await createSamplePdf());
  const jsAction = doc.context.obj({
    S: "JavaScript",
    JS: PDFString.of("app.alert('untrusted');"),
  });
  doc.catalog.set(PDFName.of("OpenAction"), jsAction);
  const text = doc.getForm().getTextField("participant_name");
  text.acroField.dict.set(PDFName.of("AA"), doc.context.obj({ K: jsAction }));
  const filled = await fillPdf(await doc.save(), { participant_name: "Test Participant" });
  const result = await PDFDocument.load(filled);
  assert.equal(result.catalog.has(PDFName.of("OpenAction")), false);
  assert.equal(
    result.getForm().getTextField("participant_name").acroField.dict.has(PDFName.of("AA")),
    false,
  );
});

test("XFA forms fail explicitly instead of silently losing their fields", async () => {
  const doc = await PDFDocument.load(await createSamplePdf());
  const acroForm = doc.getForm().acroForm.dict;
  acroForm.set(PDFName.of("XFA"), PDFString.of("<synthetic-xfa />"));
  const bytes = await doc.save({ updateFieldAppearances: false });
  await assert.rejects(inspectPdf(bytes), /unsupported.*XFA|XFA.*unsupported/i);
  await assert.rejects(
    fillPdf(bytes, { participant_name: "Test Participant" }),
    /unsupported.*XFA|XFA.*unsupported/i,
  );
});

test("PDF failures expose safe typed 422 errors including malformed field and font errors", async () => {
  const sample = await createSamplePdf();
  const checks: [Promise<unknown>, RegExp][] = [
    [inspectPdf(Buffer.from("not a pdf")), /invalid/i],
    [fillPdf(sample, { missing: "value" }), /unknown.*missing/i],
    [fillPdf(sample, { permission_granted: "yes" }), /boolean/i],
    [fillPdf(sample, { participant_name: "漢字" }), /font|character|encod/i],
  ];
  await Promise.all(
    checks.map(([operation, message]) =>
      assert.rejects(
        operation,
        (error: unknown) =>
          error instanceof PdfError &&
          error.name === "PdfError" &&
          error.status === 422 &&
          message.test(error.message),
      ),
    ),
  );
  const malformed = await PDFDocument.load(sample);
  malformed
    .getForm()
    .getTextField("participant_name")
    .acroField.dict.set(PDFName.of("V"), malformed.context.obj(["invalid"]));
  await assert.rejects(
    inspectPdf(await malformed.save({ updateFieldAppearances: false })),
    (error: unknown) => error instanceof PdfError && /malformed|inspect|field/i.test(error.message),
  );
});

test("PDFs whose compressed content expands past the decode limit are rejected", async () => {
  // A valid one-page PDF plus an object stream that decompresses to just over 100 MiB.
  const content = deflateSync(
    Buffer.concat([
      Buffer.from("5 0 "),
      Buffer.alloc(100 * 1024 * 1024, 0x20),
      Buffer.from("null"),
    ]),
  );
  const oversized = Buffer.concat([
    Buffer.from(
      "%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n" +
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n" +
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] >>\nendobj\n" +
        `4 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${content.length} >>\nstream\n`,
    ),
    content,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R /Size 5 >>\n%%EOF\n"),
  ]);
  assert.ok(oversized.length < 10 * 1024 * 1024);
  const [rejected, sample] = await Promise.allSettled([
    inspectPdf(oversized),
    createSamplePdf().then(inspectPdf),
  ]);
  assert.equal(rejected.status, "rejected");
  assert.ok(rejected.reason instanceof PdfError);
  assert.match(rejected.reason.message, /expands beyond the supported size/);
  // The limit is per load: a concurrent ordinary PDF is unaffected.
  assert.equal(sample.status === "fulfilled" && sample.value.pageCount, 2);
});

const pdfFixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

/** Page text via pdfjs — the check page count / fields cannot do: it catches silently dropped content. */
async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
  }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
  }
  return parts.join("\n");
}

/** The xref-table entry for one object number in a rebuilt classic xref. */
function xrefEntryFor(bytes: Uint8Array, num: number): string | undefined {
  const text = Buffer.from(bytes).toString("latin1");
  const lines = text.slice(text.indexOf("\nxref\n")).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header = /^(\d+) (\d+)$/.exec(lines[i]);
    if (!header) continue;
    const first = Number.parseInt(header[1], 10);
    const count = Number.parseInt(header[2], 10);
    if (num >= first && num < first + count) return lines[i + 1 + (num - first)];
  }
  return undefined;
}

test("incident PDF (encrypted, empty password) imports after genuine decryption", async () => {
  const incident = pdfFixture("pdf-test.pdf");
  // The exact live bytes: the public test PDF from orimi.com.
  assert.equal(incident.length, 20597);
  assert.equal(
    createHash("sha256").update(incident).digest("hex"),
    "f6edcd8a1b4f7cb85486d0c6777f9174eadbc4d1d0d9e5aeba7132f30b34bc3e",
  );
  assert.deepEqual(await inspectPdf(incident), { pageCount: 1, fields: [] });
  const decrypted = pdfFixture("pdf-test-decrypted.pdf");
  assert.deepEqual(await inspectPdf(decrypted), { pageCount: 1, fields: [] });
  // The decrypted control is still linearized + ObjStm, just unencrypted:
  // linearization and object streams were never the problem.
  const text = Buffer.from(decrypted).toString("latin1");
  assert.ok(text.includes("/Linearized"));
  assert.ok(text.includes("/ObjStm"));
  assert.equal(text.includes("/Encrypt"), false);
  // The routine's own output expands the object stream (a classic xref
  // table cannot represent compressed objects) and decrypts the content
  // itself — the full page text survives the round-trip, byte-identical
  // (whitespace-normalized) to the independent pypdf decryption.
  const own = decryptPdfWithEmptyPassword(incident);
  assert.deepEqual(await inspectPdf(own), { pageCount: 1, fields: [] });
  assert.equal(Buffer.from(own).includes(Buffer.from("/ObjStm")), false);
  assert.equal(Buffer.from(own).includes(Buffer.from("/Encrypt")), false);
  assert.equal(
    (await pdfText(own)).split(/\s+/).join(" "),
    "PDF Test File Congratulations, your computer is equipped with a PDF (Portable Document Format) reader! You should be able to view any of the PDF documents and forms available on our site. PDF forms are indicated by these icons: or . Yukon Department of Education Box 2703 Whitehorse,Yukon Canada Y1A 2C6 Please visit our website at: http://www.education.gov.yk.ca/",
  );
});

test("decryption work is charged against the shared decode budget", () => {
  const incident = pdfFixture("pdf-test.pdf");
  const tiny = { remaining: 100 };
  assert.throws(
    () => decryptPdfWithEmptyPassword(incident, tiny),
    (error: unknown) =>
      error instanceof PdfError &&
      /PDF content expands beyond the supported size/.test(error.message),
  );
  const ample = { remaining: 100 * 1024 * 1024 };
  const out = decryptPdfWithEmptyPassword(incident, ample);
  // Two charges: the object-stream inflation (a few KB here) plus the
  // output length. The total must be more than the output alone (the
  // inflation was charged) but within 1 MiB of it (the inflation is
  // small for this file — a bomb would trip the budget error above).
  assert.ok(ample.remaining < 100 * 1024 * 1024 - out.length);
  assert.ok(ample.remaining > 100 * 1024 * 1024 - out.length - 1024 * 1024);
});

test("object-stream inflation is bounded by the shared budget", () => {
  // A Flate stream inflating to 200,000 bytes of zeros, as one object.
  const inflated = Buffer.concat([Buffer.from("9 0 "), Buffer.alloc(200000, 0)]);
  const compressed = deflateSync(inflated);
  const dict = "<< /Type /ObjStm /N 1 /First 4 /Length 0 /Filter /FlateDecode >>";
  const tiny = { remaining: 1000 };
  assert.throws(
    () => expandPdfObjectStream(new Uint8Array(compressed), dict, tiny),
    (error: unknown) =>
      error instanceof PdfError &&
      /PDF content expands beyond the supported size/.test(error.message),
  );
  const ample = { remaining: 1000000 };
  const members = expandPdfObjectStream(new Uint8Array(compressed), dict, ample);
  assert.equal(members.length, 1);
  assert.equal(members[0].num, 9);
  assert.equal(members[0].body.length, 200000);
  assert.equal(ample.remaining, 1000000 - inflated.length);
});

test("empty-password RC4-40 (V=1, R=2) decrypts too", async () => {
  const bytes = pdfFixture("pdf-empty-password-rc4-40.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(
    await pdfText(decryptPdfWithEmptyPassword(bytes)),
    /Congratulations, your computer is equipped/,
  );
});

test("indirect stream /Length is resolved, not read as the byte count", async () => {
  const bytes = pdfFixture("pdf-indirect-length.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(
    await pdfText(decryptPdfWithEmptyPassword(bytes)),
    /Congratulations, your computer is equipped/,
  );
});

test("a forged /Type /XRef comment inside a stream dict is not an xref stream", async () => {
  const bytes = pdfFixture("pdf-xref-comment.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(
    await pdfText(decryptPdfWithEmptyPassword(bytes)),
    /Congratulations, your computer is equipped/,
  );
});

test("a /Type /XRef inside an array-valued entry is not an xref stream", async () => {
  const bytes = pdfFixture("pdf-array-xref.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(
    await pdfText(decryptPdfWithEmptyPassword(bytes)),
    /Congratulations, your computer is equipped/,
  );
});

test("a CR-only comment does not swallow the string after it", async () => {
  const bytes = pdfFixture("pdf-cr-comment.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  // The /Producer hex string sits after a CR-terminated comment; it must
  // be decrypted (hex for "pypdf"), not copied as ciphertext.
  const own = decryptPdfWithEmptyPassword(bytes);
  assert.equal(Buffer.from(own).includes(Buffer.from("<7079706466>")), true);
});

test("a fake trailer inside a comment cannot redirect the document root", async () => {
  const bytes = pdfFixture("pdf-fake-trailer.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  // The comment's /Root 1 0 R must not reach the rebuilt trailer.
  const own = decryptPdfWithEmptyPassword(bytes);
  const text = Buffer.from(own).toString("latin1");
  assert.match(text, /trailer\n<< \/Size \d+ \/Root 3 0 R \/Info 1 0 R/);
});

test("a comment-shadowed /P in the Encrypt dict does not change the key", async () => {
  const bytes = pdfFixture("pdf-shadow-p.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(
    await pdfText(decryptPdfWithEmptyPassword(bytes)),
    /Congratulations, your computer is equipped/,
  );
});

test("a malformed /P value is unsupported, not password-protected", async () => {
  const bytes = pdfFixture("pdf-bad-permissions.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError &&
      error.status === 422 &&
      error.message === "Encrypted PDFs are not supported",
  );
});

test("an encrypted object-stream bomb hits the budget error, not an OOM", async () => {
  const bytes = pdfFixture("pdf-objstm-bomb.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError &&
      error.status === 422 &&
      error.message === "PDF content expands beyond the supported size",
  );
});

test("primitive object-stream members get token separation on emission", async () => {
  const bytes = pdfFixture("pdf-primitive-objstm.pdf");
  const own = decryptPdfWithEmptyPassword(bytes);
  const text = Buffer.from(own).toString("latin1");
  assert.equal(text.includes("7 0 obj\n42"), true);
  assert.equal(text.includes("7 0 obj42"), false);
  // Breaking the structure tree does not break pages, fields, or text.
  assert.deepEqual(await inspectPdf(own), { pageCount: 1, fields: [] });
  assert.match(await pdfText(own), /Congratulations, your computer is equipped/);
});

test("nonzero object generations survive the xref rebuild", async () => {
  const bytes = pdfFixture("pdf-nonzero-gen.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  // Object 1 was rewritten with generation 2; the rebuilt xref must carry
  // that generation, not the hardcoded 00000 of the first draft.
  const out = decryptPdfWithEmptyPassword(bytes);
  assert.match(xrefEntryFor(out, 1) ?? "", /00002 n\s*$/);
});

// --- Round 3 (Astra re-review #2): parser hardening against hostile dicts ---

test("a hyphenated name is not split, so /Type /XRef is not misread", async () => {
  // The content stream's dict carries `/Custom-Key /Type /XRef true`: the
  // old name regex stopped at the hyphen and read `/Type` = `/XRef`,
  // exempting the stream as an xref stream and copying its ciphertext —
  // the page loaded with empty text. The full name token must be read.
  const bytes = pdfFixture("pdf-hyphen-name.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(
    await pdfText(decryptPdfWithEmptyPassword(bytes)),
    /Congratulations, your computer is equipped/,
  );
});

test("a commented-out object header is not promoted into a live object", async () => {
  // A `% 4 0 obj … endobj` comment line after the real page object: the
  // old header regex recorded it, and its xref entry replaced the real
  // page's — page count preserved, text lost. The comment must be skipped.
  const bytes = pdfFixture("pdf-comment-page.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(
    await pdfText(decryptPdfWithEmptyPassword(bytes)),
    /Congratulations, your computer is equipped/,
  );
});

test("a literal string holding `endobj` does not truncate its object", async () => {
  // The Encrypt dict carries `/Note (a > endobj b)`: the old string
  // skipper consumed `<<` one byte at a time, entered the hex-string
  // branch at the second `<`, and returned the `endobj` inside the
  // literal string as syntax — truncating the dict. `<<` is atomic now.
  const bytes = pdfFixture("pdf-ltlt-string.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(
    await pdfText(decryptPdfWithEmptyPassword(bytes)),
    /Congratulations, your computer is equipped/,
  );
});

test("an incremental update replacing a compressed object wins the rebuild", async () => {
  // The incident file's ObjStm member 7 (StructTreeRoot, carrying
  // `/ParentTreeNextKey 2`) is superseded by a plain object 7 appended
  // later (`/K []`): the old code rejected ANY such collision, but the
  // active revision is the last occurrence in the file.
  const bytes = pdfFixture("pdf-incremental-objstm.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  const own = decryptPdfWithEmptyPassword(bytes);
  const text = Buffer.from(own).toString("latin1");
  assert.equal(text.includes("/K []"), true);
  assert.equal(text.includes("/ParentTreeNextKey 2"), false);
  assert.match(await pdfText(own), /Congratulations, your computer is equipped/);
});

test("a thousand-object PDF decrypts in well under ten seconds", async () => {
  // The old per-object stream search rescanned the whole remaining file
  // for every object (quadratic): 702 ms on this 1,006-object file with
  // the round-2 code, 13 ms with the search bounded to the object's own
  // span — and ~100x worse again at 10,000 objects. The bound is the
  // regression guard, not a performance target.
  const bytes = pdfFixture("pdf-many-objects.pdf");
  const started = Date.now();
  const own = decryptPdfWithEmptyPassword(bytes);
  assert.ok(Date.now() - started < 10_000, "decryption took over 10 seconds");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(own), /MANY/);
});

test("a stream whose ciphertext contains `endstream` still decrypts (direct /Length)", async () => {
  // The content stream is unfiltered and its RC4 ciphertext reads
  // `endstream` at offset 1 (forced bytes inside a `%` comment). The old
  // code took the FIRST `endstream` as the boundary and rejected the
  // file; the boundary is now checked AT the resolved length.
  const bytes = pdfFixture("pdf-endstream-direct.pdf");
  const text = Buffer.from(bytes).toString("latin1");
  const streamAt = text.indexOf("stream\n");
  assert.equal(text.slice(streamAt + 8, streamAt + 17), "endstream");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(decryptPdfWithEmptyPassword(bytes)), /MARKER/);
});

test("a stream whose ciphertext contains `endstream` still decrypts (indirect /Length)", async () => {
  const bytes = pdfFixture("pdf-endstream-indirect.pdf");
  const text = Buffer.from(bytes).toString("latin1");
  const streamAt = text.indexOf("stream\n");
  assert.equal(text.slice(streamAt + 8, streamAt + 17), "endstream");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(decryptPdfWithEmptyPassword(bytes)), /MARKER/);
});

test("a non-breaking space inside a name is not PDF whitespace, so /Type /XRef is not misread", async () => {
  // The content stream's dict carries `/Custom<0xA0>Key /Type /XRef
  // true`: 0xA0 is a regular character in PDF (whitespace is only
  // 0x00 0x09 0x0A 0x0C 0x0D 0x20), so the whole thing is ONE name and
  // there is no /Type entry at all. A JS `\s` tokenizer splits at 0xA0,
  // reads `/Type` = `/XRef`, and copies the stream as ciphertext — the
  // old code loaded the file with EMPTY text.
  const bytes = pdfFixture("pdf-nbsp-name.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(
    await pdfText(decryptPdfWithEmptyPassword(bytes)),
    /Congratulations, your computer is equipped/,
  );
});

test("an indirect stream /Length living in an object stream is resolved", async () => {
  // The content stream's /Length is `999 0 R` and object 999 lives in
  // ObjStm 40 (reached through a cross-reference stream, which a file
  // using object streams must use). The old code could not see it — the
  // length map held top-level objects only — so it fell back to the
  // first `endstream` in the ciphertext and rejected the file. The
  // decryptor now expands object streams into the length map before
  // rebuilding.
  const bytes = pdfFixture("pdf-length-in-objstm.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  const own = decryptPdfWithEmptyPassword(bytes);
  assert.match(await pdfText(own), /MARKER/);
  // The output must not carry the source's cross-reference stream: its
  // dict holds /Encrypt, and pdf-lib reads any xref-stream dict as a
  // trailer — copying it verbatim made the decrypted file report as
  // encrypted again.
  assert.equal(Buffer.from(own).includes(Buffer.from("/Encrypt")), false);
  assert.equal(Buffer.from(own).includes(Buffer.from("/Type /XRef")), false);
});

test("an indirect stream /Length that cannot be resolved fails closed", async () => {
  // `/Length 999 0 R` with no object 999 anywhere (dangling reference).
  // The old code fell back to the first `endstream` and copied the
  // ciphertext tail unchanged, silently accepting a broken document
  // with empty text. A present-but-unresolvable length now rejects the
  // file instead.
  const bytes = pdfFixture("pdf-length-unresolved.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("many streams whose ciphertext is an unterminated `(` do not slow the scan", async () => {
  // 5,000 one-byte streams whose RC4 ciphertext is exactly `(`: the old
  // scanner searched for `endobj` through the binary stream data first,
  // and the unterminated string ran to EOF for every object — ~5 s on
  // this file. The scanner now locates streams dict-first and never
  // lexically scans stream data: 0.2–0.4 s here. The bound is the
  // regression guard, not a performance target.
  const bytes = pdfFixture("pdf-paren-streams.pdf");
  const started = Date.now();
  const own = decryptPdfWithEmptyPassword(bytes);
  assert.ok(Date.now() - started < 2000, "decryption took over 2 seconds");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(own), /STREAMY/);
});

test("decryption refuses to return bytes that drove the budget negative", () => {
  // The round-3 code charged the output size AFTER concatenating it and
  // never threw when the adjustment went negative — so the caller parsed
  // bytes the budget had already rejected. The total charge is measured
  // with an ample budget first; a budget one byte short of it must throw
  // the budget error instead of returning bytes.
  const incident = pdfFixture("pdf-test.pdf");
  const ample = { remaining: 100 * 1024 * 1024 };
  const out = decryptPdfWithEmptyPassword(incident, ample);
  const totalCharge = 100 * 1024 * 1024 - ample.remaining;
  assert.ok(totalCharge > out.length); // the object-stream inflation was charged too
  const short = { remaining: totalCharge - 1 };
  assert.throws(
    () => decryptPdfWithEmptyPassword(incident, short),
    (error: unknown) =>
      error instanceof PdfError &&
      /PDF content expands beyond the supported size/.test(error.message),
  );
});

test("object-stream headers must be whole integers, not prefixes", () => {
  // Astra's exact example: `deflateSync("9x 0x 42")` with `/N 1.5
  // /First 6.5` was read as one member, object 9, body `42` — parseInt
  // silently normalized both the dict values and the header parts.
  const compressed = deflateSync("9x 0x 42");
  assert.throws(
    () =>
      expandPdfObjectStream(
        new Uint8Array(compressed),
        "<< /Type /ObjStm /N 1.5 /First 6.5 /Length 0 /Filter /FlateDecode >>",
      ),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
  assert.throws(
    () =>
      expandPdfObjectStream(
        new Uint8Array(compressed),
        "<< /Type /ObjStm /N 1 /First 5 /Length 0 /Filter /FlateDecode >>",
      ),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
  // An indirect /N is not resolved here either: failing closed beats
  // guessing a member count from a reference.
  assert.throws(
    () =>
      expandPdfObjectStream(
        new Uint8Array(deflateSync("9 0 42")),
        "<< /Type /ObjStm /N 5 0 R /First 4 /Length 0 /Filter /FlateDecode >>",
      ),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("the input-size budget reserve fires before the rebuild loop", () => {
  // A budget that cannot even cover the input bytes must fail at the
  // reserve (taken right after authentication), before any decryption
  // allocates — and the deduction sticks, so a later retry in the same
  // budget sees the negative remainder.
  const incident = pdfFixture("pdf-test.pdf");
  const budget = { remaining: incident.length - 1 };
  assert.throws(
    () => decryptPdfWithEmptyPassword(incident, budget),
    (error: unknown) =>
      error instanceof PdfError &&
      /PDF content expands beyond the supported size/.test(error.message),
  );
  assert.ok(budget.remaining < 0);
});

test("password-protected PDFs are rejected honestly (RC4-128 and RC4-40)", async () => {
  for (const name of ["pdf-password.pdf", "pdf-password-rc4-40.pdf"]) {
    const bytes = pdfFixture(name);
    await assert.rejects(
      inspectPdf(bytes),
      (error: unknown) =>
        error instanceof PdfError &&
        error.status === 422 &&
        error.message === "This PDF is password-protected",
    );
    assert.throws(
      () => decryptPdfWithEmptyPassword(bytes),
      (error: unknown) =>
        error instanceof PdfError && error.message === "This PDF is password-protected",
    );
  }
});

test("strict-parse casualty is rejected as unparseable, not malformed", async () => {
  const bytes = pdfFixture("strict-parse-casualty.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError &&
      error.status === 422 &&
      error.message === "PDF could not be parsed",
  );
  // F3 evidence anchor: lenient recovery preserves this file completely,
  // which is exactly why the strict rejection needs its own message.
  // The text check runs on the leniently recovered document itself
  // (re-saved), not on the original bytes.
  const recovered = await PDFDocument.load(new Uint8Array(bytes), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  assert.equal(recovered.getPageCount(), 2);
  assert.equal(recovered.getForm().getTextField("participant_name").getText() ?? "", "");
  assert.match(await pdfText(await recovered.save()), /Community visit/);
});

test("bad token in a dict: lenient recovery loads but silently drops page text", async () => {
  // The F3 reason strict parsing is kept: page count and fields survive
  // lenient recovery, but the page text is silently empty — no check in
  // inspectPdf could certify that recovery.
  const bytes = pdfFixture("bad-token-in-dict.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError &&
      error.status === 422 &&
      error.message === "PDF could not be parsed",
  );
  const recovered = await PDFDocument.load(new Uint8Array(bytes), {
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  assert.equal(recovered.getPageCount(), 1);
  assert.equal(recovered.getForm().getTextField("my_field").getText() ?? "", "field-value-abc");
  // The text check runs on the leniently recovered document itself
  // (re-saved): its page text is empty, which is what lenient recovery
  // actually preserved.
  assert.equal((await pdfText(await recovered.save())).trim(), "");
});

test("genuinely malformed PDF keeps the generic message and preserves the parser cause", async () => {
  const bytes = pdfFixture("malformed.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError &&
      error.status === 422 &&
      error.message === "Invalid or malformed PDF" &&
      error.cause instanceof Error &&
      /Trying to parse invalid object/i.test(error.cause.message),
  );
});

test("a #xx-escaped dictionary name is still that name (/L#65ngth is /Length)", async () => {
  // PDF 32000-1 §7.3.5: `#65` is `e`, so `/L#65ngth` IS `/Length`. The
  // old code stored the raw spelling, treated the length as absent, and
  // fell back to the first `endstream` in the ciphertext — decrypting
  // one byte and copying the rest as ciphertext, so the file loaded
  // with EMPTY text. The length is now recognized and used.
  const bytes = pdfFixture("pdf-length-escaped.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(decryptPdfWithEmptyPassword(bytes)), /MARKER/);
});

test("a /Length of the wrong type fails closed instead of being treated as absent", async () => {
  // `/Length (49)` — a literal string where an integer or a reference
  // belongs. The old code saw no usable length and guessed the stream
  // boundary from the first `endstream`, silently accepting a broken
  // document with empty text. A present-but-wrong-type /Length now
  // rejects the file, the same as an unresolvable reference.
  const bytes = pdfFixture("pdf-length-string.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("ciphertext forged as objects does not replace the real page", async () => {
  // An unreferenced stream whose /Length is `9 0 R` (the real length
  // object 9 sits before it) has ciphertext reading `AAAA endstream
  // endobj 9 0 obj 4 endobj 4 0 obj << /Type /Page ... >> endobj`. The
  // old scanner cut the stream short at the forged endobj, discovered
  // the forged objects, and latest-wins let the forged page (no
  // /Contents) replace the real one — the file loaded with EMPTY text.
  // The length is now resolved from the real object before the stream,
  // and spans inside the true data range are removed as forgeries.
  const bytes = pdfFixture("pdf-forged-objects.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  const own = decryptPdfWithEmptyPassword(bytes);
  assert.match(await pdfText(own), /REALPAGE/);
  assert.equal(Buffer.from(own).includes(Buffer.from("/Encrypt")), false);
  // The forged page (a bare /MediaBox [0 0 100 100] dict) must not
  // survive into the output at all.
  assert.equal(Buffer.from(own).includes(Buffer.from("/MediaBox [0 0 100 100]")), false);
  assert.equal(Buffer.from(own).includes(Buffer.from("/Contents 5 0 R")), true);
});

test("a second object-stream bomb is refused after the first exhausts the budget", () => {
  // The pre-pass used to swallow the budget error from an oversized
  // object stream and retry it on every fixpoint pass (and the rebuild
  // loop tried it again), so each bomb inflated up to the cap per pass
  // and total work was bounded only by (bombs x passes x cap). A
  // cap-hit now marks the budget exhausted (sticky), and an exhausted
  // budget is refused before zlib runs — so even a VALID stream is
  // refused once the budget is gone, proving no second inflation
  // happens. (The observable outcome is the same either way — both
  // paths throw the budget error — so the stickiness and the
  // immediate-refusal checks are the real guards.)
  const inflated = Buffer.concat([Buffer.from("9 0 "), Buffer.alloc(200000, 0)]);
  const compressed = deflateSync(inflated);
  const dict = "<< /Type /ObjStm /N 1 /First 4 /Length 0 /Filter /FlateDecode >>";
  const budget = { remaining: 1000 };
  assert.throws(
    () => expandPdfObjectStream(new Uint8Array(compressed), dict, budget),
    (error: unknown) =>
      error instanceof PdfError &&
      /PDF content expands beyond the supported size/.test(error.message),
  );
  assert.ok(budget.remaining < 0, "the cap-hit must exhaust the budget");
  assert.throws(
    () => expandPdfObjectStream(new Uint8Array(deflateSync("9 0 42")), dict, budget),
    (error: unknown) =>
      error instanceof PdfError &&
      /PDF content expands beyond the supported size/.test(error.message),
  );
});

test("a corrupted object stream fails the decrypt instead of being retried", async () => {
  // Two object streams whose Flate data has a corrupted Adler-32
  // checksum: the data decompresses fully and only then fails the
  // checksum (a LATE failure). The round-5 pre-pass caught every
  // expansion error and deferred the stream, so each corrupted stream
  // inflated up to the cap uncharged on every fixpoint pass. Only a
  // length-resolution failure is deferred now; a decompression failure
  // propagates immediately and rejects the file.
  const bytes = pdfFixture("pdf-objstm-corrupt.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("a corrupted checksum is a decompression failure, not a budget error", () => {
  // The unit-level guard for the test above: corrupting the Adler-32
  // (the last four bytes of the zlib stream) must throw the
  // unsupported error, not the budget error — so the pre-pass treats
  // it as a decompression failure and propagates it instead of
  // deferring it as an unresolvable length.
  const compressed = Buffer.from(deflateSync("9 0 42"));
  compressed[compressed.length - 1] ^= 0xff; // corrupt the Adler-32
  assert.throws(
    () =>
      expandPdfObjectStream(
        new Uint8Array(compressed),
        "<< /Type /ObjStm /N 1 /First 4 /Length 0 /Filter /FlateDecode >>",
      ),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("a forged span that swallows a genuine object rejects the file", async () => {
  // A real page (object 4, text REALPAGE) and a real length object 9
  // before an unreferenced stream (object 6, /Length 9 0 R) whose
  // ciphertext embeds an early `endstream endobj` plus a forged
  // `40 0 obj << /Length L >> stream` whose direct length lands the
  // scanner's `indexOf("endobj", dataStart + L)` on the genuine
  // page-content object 5's `endobj` — so the scanner never records
  // object 5. Removing the forged span does not recover it, so the
  // round-5 code silently accepted the file with EMPTY text (the page
  // lost its content). A removed span whose byte range contains a
  // second object header now rejects the file rather than silently
  // losing content.
  const bytes = pdfFixture("pdf-forged-skip.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("many independent forged streams are cleaned in one pass", async () => {
  // Fifty unreferenced streams, each with a forged `7 0 obj` inside
  // its ciphertext (all sharing one indirect /Length 9 0 R), plus a
  // real page (text MANYFORGED). The round-5 fixpoint restarted after
  // the first stream with removals, so this file needed fifty passes
  // (O(N^2) candidate-building work). A pass now restarts only when a
  // removed forgery is a /Length target — a forgery no stream's length
  // depends on cannot change any later resolution — so all fifty are
  // cleaned in one pass and the real page survives. The bound is the
  // regression guard, not a performance target.
  const bytes = pdfFixture("pdf-many-forged.pdf");
  const started = Date.now();
  const own = decryptPdfWithEmptyPassword(bytes);
  assert.ok(Date.now() - started < 5000, "decryption took over 5 seconds");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(own), /MANYFORGED/);
});

test("a `(` in ciphertext that skips a genuine object rejects the file", async () => {
  // An unreferenced stream (object 6, /Length 9 0 R) whose ciphertext
  // reads `AAAA endstream endobj (` then filler with no parens, before
  // its actual end. The scanner truncates the stream at the forged
  // endobj, then `findOutsideStrings` treats the ciphertext `(` as a
  // literal-string opener and skips over the genuine page-content
  // object 5 — the only balancing `)` is in a `% )` comment after it.
  // No forged span is recorded (the stream's length resolves and its
  // data range is clean), so the round-6 second-header check cannot
  // trigger, and the round-6 code silently accepted the file with
  // EMPTY text (the page lost its content). A `(` in the skipped
  // region (between the guessed end and the true data end) whose
  // literal-string skip lands beyond the true data end now rejects
  // the file rather than silently losing content.
  const bytes = pdfFixture("pdf-paren-skip.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("an object stream with /DecodeParms is rejected, not silently altered", async () => {
  // An ObjStm with `/DecodeParms << /Predictor 15 /Columns 8 >>`:
  // two decoded 8-byte rows, each prefixed with filter byte 0x00,
  // giving member 9 the string (ABCD). The old code inflated without
  // applying the predictor and mis-parsed the filter bytes as syntax
  // (0x00 reads as PDF whitespace, so `9 0 (ABC` parsed as a valid
  // header) — silently returning a member body with an extra NUL and
  // a wrong field value. Predictor decoding is not implemented, so
  // the file is rejected rather than silently altered.
  const bytes = pdfFixture("pdf-predictor-objstm.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("an object stream with /DecodeParms is rejected at the expansion boundary", () => {
  // The unit-level guard for the test above: /DecodeParms in the
  // ObjStm dict must throw the unsupported error before any inflation
  // happens — so the pre-pass propagates it immediately instead of
  // expanding a predictor-encoded stream into corrupted members.
  // (Checked via the entries map: a /DecodeParms value is a dict, and
  // pdfDictTopLevelRaw returns undefined for dict-valued entries.)
  const compressed = Buffer.from(deflateSync("9 0 (ABCD)"));
  assert.throws(
    () =>
      expandPdfObjectStream(
        new Uint8Array(compressed),
        "<< /Type /ObjStm /N 1 /First 4 /Length 0 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Columns 8 >> >>",
      ),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("a dependency chain of object streams deeper than the pass cap is rejected", async () => {
  // Twelve object streams (objects 40..51): stream i's /Length is
  // indirect (member 100+i+1, living in stream i+1) except the last
  // (object 51), which is direct. In physical order the first pass
  // expands only stream 51; each following pass unlocks one
  // predecessor, and every pass revisits every unresolved stream
  // (rebuilding text, parsing dicts, throwing/catching the
  // unresolved-range error) — O(N^2) work, synchronous in the request
  // path. The pre-pass is capped at ten passes; a twelve-deep chain
  // exceeds it and is rejected rather than processed. The cap (not a
  // timing assertion) is the deterministic guard.
  const bytes = pdfFixture("pdf-objstm-chain.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("a `<` in ciphertext that skips a genuine object rejects the file", async () => {
  // The round-7 guard covers only literal strings (`(`). But
  // `findOutsideStrings` ALSO skips apparent hex strings: a lone `<`
  // (not followed by `<`) jumps to the next `>`. An unreferenced
  // stream (object 6, /Length 9 0 R) whose ciphertext reads
  // `AAAA endstream endobj <` then filler with neither `>` nor `(`
  // before its true end: after the forged endobj the scanner hits the
  // `<` and jumps to the next `>` — the first `>` of the genuine
  // page-content object 5's dict close `>>` — so it skips object 5's
  // header and never records its span. No forged span is removed (no
  // second-header check) and there is no `(` in the skipped region (no
  // paren guard), so the round-7 code silently accepts the file with
  // EMPTY text (pages=1, 990 output bytes). The sequential walk
  // replicates the hex-string branch and rejects the file rather than
  // silently losing content.
  const bytes = pdfFixture("pdf-lt-skip.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("balanced nested parens in the skipped region decrypt fast and intact", async () => {
  // An unreferenced stream (object 6, /Length 9 0 R) whose ciphertext
  // reads `AAAA endstream endobj (` then 40,000 opens then 40,000
  // closes (balanced), before its true end. The parens balance INSIDE
  // the skipped region, so the scanner resumes inside the stream data
  // and finds the genuine page-content object 5 — the file MUST
  // decrypt successfully with the text intact. The round-7 guard
  // called `skipPdfLiteralString` from EVERY `(` (advancing one byte
  // after each), so the successive scans traverse ~2N, 2N-2, … bytes:
  // O(N^2) synchronous work — it takes ~8.9 s on this file. The
  // round-8 walk visits each byte once (skips advance past the skipped
  // span), so it takes ~9 ms. The 5 s bound is the regression guard
  // for the quadratic path; the text assertion proves the guard does
  // not falsely reject balanced parens.
  const bytes = pdfFixture("pdf-nested-parens.pdf");
  const started = Date.now();
  const own = decryptPdfWithEmptyPassword(bytes);
  assert.ok(Date.now() - started < 5000, "decryption took over 5 seconds");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(own), /NESTED/);
});

// --- Round 9 (Astra re-review #8): comment restart + budget before allocation ---

test("a `(` inside a `%` comment that skips a genuine object rejects the file", async () => {
  // Round-8's walk skipped `%` comments as a whole, but the scanner
  // does not scan continuously: it stops at a discovered header,
  // computes that header's end with a plain `indexOf("endobj", …)`
  // (which can land inside a `%` comment), and restarts searching
  // INSIDE the comment, where it treats a `(` or `<` later on that
  // line as syntax. An unreferenced stream (object 6, /Length 9 0 R)
  // whose ciphertext reads `AAAA endstream endobj` + a forged object
  // 40 (`40 0 obj << /Length 0 >> stream`) + a `% endobj (` comment
  // whose `(` is unbalanced through the outer stream's true end and
  // the genuine page-content object 5, with the balancing `)` in a
  // `% )` comment after object 5: the scanner truncates the outer
  // stream at the forged endobj, discovers forged object 40, finds
  // its end at the `endobj` INSIDE the `%` comment, restarts inside
  // the comment, treats the `(` as a string opener, and skips over
  // object 5. The round-8 walk skipped the whole `%` comment and
  // never saw the `(`; the removed-span second-header check saw only
  // object 40's own header — so the round-8 code silently accepted
  // the file with EMPTY text (pages=1, 1032 output bytes). The walk
  // now treats `%` as an ordinary byte (advance by one), so every
  // `(` and `<` in the region is checked even inside a comment, and
  // the file is rejected rather than silently losing content.
  const bytes = pdfFixture("pdf-comment-skip.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("an over-budget object-stream member output is refused before emission", () => {
  // Round-9 finding 2 (Astra re-review #8): Phase 1 used to
  // materialize every candidate chunk with `concatBytes` — including
  // superseded candidates Phase 2 discards — and only then did the
  // budget check run on the total output length. A small compressed
  // ObjStm can inflate a large member (whitespace + `null`); the
  // inflation is capped and charged immediately, but Phase 1 then
  // copied that large member again despite insufficient budget for
  // the rebuilt output. The rebuild now determines winners and
  // output lengths from the recorded piece lengths, checks the
  // budget, and only then materializes the winner chunks — so an
  // over-budget file is refused before its expanded output is
  // allocated (and superseded candidates are never materialized).
  // This test applies the one-byte-short pattern to an ObjStm
  // fixture: the total charge is measured with an ample budget, and
  // a budget one byte short of it must throw the budget error
  // instead of returning bytes. (The "before allocation" property
  // itself is structural — no winner chunk is concatenated before
  // the budget check — and is verified by reading the rebuild; the
  // outcome here guards the refactor.)
  const bytes = pdfFixture("pdf-primitive-objstm.pdf");
  const ample = { remaining: 100 * 1024 * 1024 };
  const out = decryptPdfWithEmptyPassword(bytes, ample);
  const totalCharge = 100 * 1024 * 1024 - ample.remaining;
  assert.ok(totalCharge > out.length); // the object-stream inflation was charged too
  const short = { remaining: totalCharge - 1 };
  assert.throws(
    () => decryptPdfWithEmptyPassword(bytes, short),
    (error: unknown) =>
      error instanceof PdfError &&
      /PDF content expands beyond the supported size/.test(error.message),
  );
});

// --- Round 10 (Astra re-review #9): restart inside a literal string ---

test("a `<` inside a balanced literal string that skips a genuine object rejects the file", async () => {
  // Round-9's walk skipped a balanced literal string as a whole, but
  // the scanner can restart INSIDE that string (after a forged endobj
  // found by plain `indexOf("endobj", …)` inside the string) with
  // fresh lexical state, where it treats a `<` after the restart as a
  // hex-string opener. An unreferenced stream (object 6, /Length
  // 9 0 R) whose ciphertext reads `AAAA endstream endobj` + a forged
  // object 40 (`40 0 obj << /Length 0 >> stream`) + a balanced
  // literal string `( endobj < ZZZ )` whose `)` is before the outer
  // stream's true data end, with the genuine page-content object 5
  // after the outer stream: the scanner truncates the outer stream
  // at the forged endobj, discovers forged object 40, finds its end
  // at the `endobj` INSIDE the literal string, restarts inside the
  // string, treats the `<` as a hex-string opener, and jumps to the
  // next `>` — the genuine object 5's dict close `>>` — skipping
  // object 5's header. The round-9 walk encountered the `(` and
  // jumped past its balanced `)`, never seeing the `<` inside; the
  // removed-span second-header check saw only object 40's own header
  // — so the round-9 code silently accepted the file with EMPTY text
  // (pages=1, 984 output bytes). The walk now splits the region into
  // segments at the scanner's restart points (the ends of removed
  // spans), so the segment starting inside the string re-examines
  // the `<` with fresh state and rejects the file rather than
  // silently losing content.
  const bytes = pdfFixture("pdf-string-skip.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

// --- Round 11 (Astra re-review #10): comment state + bounded scans ---

test("a `(` inside a `%` comment that hides a `<` rejects the file", async () => {
  // Round-10's walk treated `%` as an ordinary byte, so a `(` inside
  // a comment became a string opener for the walk — but the SCANNER
  // skips `%` comments, so the `(` is not a string opener for it. An
  // unreferenced stream (object 6, /Length 9 0 R) whose ciphertext
  // reads `AAAA endstream endobj % (` then a newline, then `< ZZZ )
  // filler` before its actual end: the scanner truncates the outer
  // stream at the forged endobj, skips `% (` as a comment (through
  // the newline), encounters the `<` on the next line and jumps to
  // the next `>` — the genuine page-content object 5's dict close
  // `>>` — skipping object 5's header. The round-10 walk treated `%`
  // as ordinary, encountered the `(` in the comment, called
  // skipPdfLiteralString, and jumped past the `)` (after the `<`),
  // never seeing the `<` — and there is no forged object, so
  // removedSpans is empty (no segmentation, no second-header check).
  // The round-10 code silently accepted the file with EMPTY text
  // (pages=1, 950 output bytes). The round-11 walk restores
  // comment-skipping (bounded to the segment end, clamped at restart
  // points): it skips `% (` as a comment, encounters the `<`, and
  // rejects the file rather than silently losing content.
  const bytes = pdfFixture("pdf-comment-lt-skip.pdf");
  await assert.rejects(
    inspectPdf(bytes),
    (error: unknown) =>
      error instanceof PdfError && error.message === "Encrypted PDFs are not supported",
  );
});

test("many restart points decrypt fast and intact", async () => {
  // An unreferenced stream (object 6, /Length 9 0 R) whose ciphertext
  // reads `AAAA endstream endobj` + 10,000 forged objects, each
  // `N 0 obj << /Length 0 >> stream` + `% ( endobj` (an unmatched
  // `(` in a comment), before its actual end. The scanner finds each
  // forged object's endobj inside its comment and restarts after it,
  // so there are 10,000 restart points (10,000 segments). The
  // round-10 walk called skipPdfLiteralString (whole file, unbounded)
  // and clamped afterward — in each segment it scanned the entire
  // remaining suffix looking for a `)` (there is none), then clamped:
  // O(k * fileSize) quadratic work, ~15.3 s on this file. The round-11
  // walk bounds every search to the segment end (the literal-string
  // and comment skips take `segEnd` as their limit; the hex-string
  // `>` is found by a manual scan that never goes past `segEnd`), so
  // each segment costs O(segment length) — ~350 ms on this file. The
  // 5 s bound is the regression guard for the quadratic path; the text
  // assertion proves the guard does not falsely reject (the forged
  // objects are removed and object 5 is preserved).
  const bytes = pdfFixture("pdf-many-restarts.pdf");
  const started = Date.now();
  const own = decryptPdfWithEmptyPassword(bytes);
  assert.ok(Date.now() - started < 5000, "decryption took over 5 seconds");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(own), /MANYRESTART/);
});

// --- Round 12 (Astra re-review #11): comments as whitespace in tokenization ---

test("a comment inside an indirect /Length reference resolves to the length object", async () => {
  // Comments act as whitespace between PDF tokens (§7.2.4), but
  // skipPdfValue's reference regex allowed only PDF_WHITESPACE_CLASS
  // — so `/Length 9 % length reference\n0 R` read as the DIRECT
  // number 9, not a reference to object 9 (which holds 69). The
  // stream's ciphertext contains `endstream` at data offset 9, so the
  // 9-byte boundary check passes — and the old code decrypted only 9
  // bytes, copying the rest as ciphertext, so pdfjs extracted NO text
  // (pages=1, empty text, 993 output bytes). The new code parses the
  // reference structurally (comments skipped as whitespace) and
  // resolves it to object 9, decrypting all 69 bytes. The test
  // asserts the COMPLETE decrypted content (the text), not just the
  // page count — a partial decryption would still report 1 page.
  // Note: pypdf cannot parse this fixture either (it shares the same
  // comment-blindness — it fails on `0 R` with "Expecting a
  // NameObject"); verification is by direct RC4-decrypt (see the
  // fixture README), not pypdf.
  const bytes = pdfFixture("pdf-length-comment-ref.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(decryptPdfWithEmptyPassword(bytes)), /LENGTHCOMMENT/);
});

test("a comment inside an indirect-object header does not drop the object", async () => {
  // An indirect-object header can legally contain a comment between
  // tokens, but scanPdfObjects walked backward through whitespace
  // only — so `9 0 % ordinary header comment\nobj` made it stop at
  // the comment text instead of the generation number, and the
  // genuine object was skipped (never rebuilt). The field's /V
  // references object 9, so the old code returned the field value as
  // "" (missing) — pages=1, text intact, but the value object absent
  // (1,096 output bytes). The new code skips whitespace AND comments
  // backward from `obj`, finds object 9, and preserves it — the test
  // asserts BOTH the object preservation (via the exact field value)
  // and the page text. Note: pypdf cannot parse this fixture either
  // (same header-comment blindness); verification is by direct
  // RC4-decrypt (see the fixture README), not pypdf.
  const bytes = pdfFixture("pdf-header-comment.pdf");
  assert.deepEqual(await inspectPdf(bytes), {
    pageCount: 1,
    fields: [{ name: "F1", value: "FIELDVALUE", type: "text" }],
  });
  assert.match(await pdfText(decryptPdfWithEmptyPassword(bytes)), /HEADERCOMMENT/);
});

// --- Round 13 (Astra re-review #12): forward header tokenization ---

test("a `%` inside a literal string does not hide the next object", async () => {
  // The round-12 backward header scan decided its position was inside
  // a comment whenever it found a `%` before the preceding newline —
  // but it did not establish whether that `%` was inside an earlier
  // literal string. Here object 8 is an unreferenced literal string
  // whose RC4 CIPHERTEXT contains a `%` byte, on the same physical
  // line as the next referenced field-value object (object 9, an
  // encrypted hex string "FIELDVALUE"). The old code, walking backward
  // from object 9's `obj`, scanned left through `endobj` and the
  // string, found the `%` inside it, treated everything after it as
  // comment text, and silently skipped object 9 — so the field value
  // came back "" (pages=1, text intact, 1,202 output bytes). The new
  // forward tokenizer skips the string (its `%` is not a comment) and
  // finds object 9. The test asserts the EXACT field value (not just
  // the page count) plus the page text.
  const bytes = pdfFixture("pdf-percent-string.pdf");
  assert.deepEqual(await inspectPdf(bytes), {
    pageCount: 1,
    fields: [{ name: "F1", value: "FIELDVALUE", type: "text" }],
  });
  assert.match(await pdfText(decryptPdfWithEmptyPassword(bytes)), /PERCENTSTRING/);
});

test("many same-line objects decrypt in linear time", async () => {
  // The round-12 backward header scan traversed a progressively longer
  // prefix for each header (it scanned backward to a newline/`%`/
  // file-start, twice per header), so 15,000 null objects all on ONE
  // line cost Theta(N^2) — ~12.4 s under the round-12 code, before any
  // budget reservation. The new forward tokenizer scans the line once
  // (linear) — ~0.64 s. The 5 s bound is the regression guard for the
  // quadratic path; the text assertion proves the guard does not
  // falsely reject (all 15,000 objects are preserved and the page text
  // is intact). Both codes produce identical output ("SAMELINE" text,
  // 649,856 output bytes); the difference is the work, not the outcome.
  const bytes = pdfFixture("pdf-many-sameline.pdf");
  const start = Date.now();
  const out = decryptPdfWithEmptyPassword(bytes);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `decrypt took ${elapsed} ms, expected < 5000 ms`);
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(out), /SAMELINE/);
});

test("a comment-bearing genuine header is still caught by the second-header safeguard", async () => {
  // The forged-skip construction (a forged stream whose direct length
  // lands the scanner past the genuine content object 5), but object
  // 5's header is comment-bearing (`5 0 % ordinary header comment`
  // + newline + `obj`). The old second-header safeguard used a
  // whitespace-only regex and did not detect the comment-bearing
  // genuine header, so the file was silently accepted with EMPTY text
  // (pages=1, 983 output bytes — the genuine content object is lost).
  // The new comment-aware regex detects it and REJECTS. The test
  // asserts rejection (not merely a page-count check — a silent
  // acceptance would still report 1 page).
  const bytes = pdfFixture("pdf-forged-skip-comment-header.pdf");
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof PdfError);
    assert.equal(error.message, "Encrypted PDFs are not supported");
    return true;
  });
});

// --- Round 14 (Astra re-review #13): no depth tracking, linear safeguard ---

test("an unclosed `[` in ciphertext does not hide the next object", async () => {
  // The round-13 tokenizer recognized headers only at depth === 0,
  // but the skipped-region walk did not track depth — so a `[` in a
  // stream's ciphertext, after a forged `endstream endobj`, put the
  // tokenizer at nonzero depth and suppressed every genuine header
  // after it, while the walk accepted the `[` as an ordinary byte and
  // no forged span was recorded (so the second-header safeguard did
  // not run). Here an indirect-length stream (object 6, /Length 7 0
  // R) has ciphertext reading `AAAA endstream endobj [ ZZZ ...` (the
  // `[` is unclosed — no `]` before the genuine object), with the
  // field's referenced value object (object 9, an encrypted hex
  // string "FIELDVALUE") AFTER the stream. The old code silently
  // omitted object 9 — so the field value came back "" (pages=1,
  // text intact, 1,285 output bytes). The new tokenizer does NOT
  // track depth (a `[` is an ordinary delimiter), so it finds object
  // 9. The test asserts the EXACT field value (not just the page
  // count) plus the page text.
  const bytes = pdfFixture("pdf-bracket-skip.pdf");
  assert.deepEqual(await inspectPdf(bytes), {
    pageCount: 1,
    fields: [{ name: "F1", value: "FIELDVALUE", type: "text" }],
  });
  assert.match(await pdfText(decryptPdfWithEmptyPassword(bytes)), /BRACKETSKIP/);
});

test("an unclosed `<<` in ciphertext does not hide the next object", async () => {
  // Same construction as the bracket variant, with `<<` (a dict
  // opener) instead of `[` in the ciphertext (`AAAA endstream endobj
  // << ZZZ ...`). The old tokenizer treated `<<` as a dict open
  // (depth=1) and suppressed object 9 — so the field value came back
  // "" (pages=1, text intact, 1,280 output bytes). The new tokenizer
  // treats `<<` as an ordinary two-byte delimiter, so it finds object
  // 9. The test asserts the EXACT field value plus the page text.
  const bytes = pdfFixture("pdf-dict-skip.pdf");
  assert.deepEqual(await inspectPdf(bytes), {
    pageCount: 1,
    fields: [{ name: "F1", value: "FIELDVALUE", type: "text" }],
  });
  assert.match(await pdfText(decryptPdfWithEmptyPassword(bytes)), /DICTSKIP/);
});

test("a long `%` run in a removed forged span does not backtrack exponentially", async () => {
  // The round-13 comment-aware second-header regex
  // `(?:[whitespace]|%[^\n\r]*)+` admitted exponentially many
  // partitions of a run of `%` characters, so a failed search against
  // a removed forged span containing a long `%` run backtracked
  // exponentially over untrusted stream ciphertext. Here a removed
  // forged span (object 40, inside the attack stream's data range)
  // contains a 28-`%` run in a comment in its dict, with NO second
  // header — so the old regex backtracked trying (and failing) to find
  // one (~21.7 s), while the new linear header-counting scan is fast
  // (~16 ms). The file decrypts successfully in both codes (the
  // genuine content object 5 is BEFORE the attack stream, not in the
  // forged span's range, so no content is lost; identical output,
  // 1,155 bytes) — the difference is the work, not the outcome. The
  // 5 s bound is the regression guard for the exponential path; the
  // text assertion proves the guard does not falsely reject.
  const bytes = pdfFixture("pdf-percent-run.pdf");
  const start = Date.now();
  const out = decryptPdfWithEmptyPassword(bytes);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `decrypt took ${elapsed} ms, expected < 5000 ms`);
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(out), /PERCENTRUN/);
});

// --- Round 15 (Astra re-review #14): string-skipping counter, bounded dict ---

test("a `%` inside a string does not hide a genuine header from the safeguard", async () => {
  // The round-14 header counter did not skip strings, so a `%` inside
  // a literal string was treated as a comment opener and could hide a
  // subsequent genuine header on the same line — contradicting the
  // claimed superset property. Here a removed forged span (object 40,
  // inside the attack stream's data range) contains a balanced literal
  // string `(A%B)` (with a `%` inside it) and a genuine header
  // (object 9, an encrypted hex string "FIELDVALUE") on the SAME line
  // after the `%`. The old counter counted object 40, reached the `%`,
  // skipped through object 9's header to the newline, and returned 1
  // (not 2) — so the safeguard did not reject and the file was
  // silently accepted with object 9 missing (field value "", pages=1,
  // text intact, 1,328 output bytes). The new counter skips strings,
  // finds object 9, returns 2, and REJECTS. The test asserts rejection
  // (not merely a page-count check — a silent acceptance would still
  // report 1 page). Note: Astra's construction as stated (forged L
  // landing simultaneously on the outer `endstream` for its own
  // boundary check AND past the outer `endobj` to include object 9)
  // is geometrically impossible; this fixture uses the workable
  // variant — object 9 sits inside the FORGED object 40's own stream
  // data (before its `endstream`), so the forged L lands on the
  // forged `endstream` (boundary check passes) and the span includes
  // object 9.
  const bytes = pdfFixture("pdf-percent-string-skip.pdf");
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof PdfError);
    assert.equal(error.message, "Encrypted PDFs are not supported");
    return true;
  });
});

test("many unclosed forged dictionaries decrypt in linear time", async () => {
  // The round-14 `parseBalancedDict` scanned the remaining file for
  // each unclosed dict (no balancing closes), returning undefined,
  // then the fallback found the nearby `endobj` and discovery advanced
  // to the next forged header and repeated — Theta(N^2) work in
  // `scanPdfObjects`, before authentication and before the input-size
  // budget reserve. Here 10,000 forged headers, each `K 0 obj <<
  // endobj` (K = 40..10039), sit inside one correctly sized encrypted
  // stream. The old code took ~8.8 s; the new code returns undefined
  // immediately on the bare `endobj` (fail fast) and is bounded to 256
  // KiB, so each call is O(1) and the total is linear (~0.2 s). The
  // 5 s bound is the regression guard for the quadratic path; the text
  // assertion proves the guard does not falsely reject. Both codes
  // produce identical output ("UNCLOSED" text, 210,085 output bytes);
  // the difference is the work, not the outcome.
  const bytes = pdfFixture("pdf-many-unclosed-dicts.pdf");
  const start = Date.now();
  const out = decryptPdfWithEmptyPassword(bytes);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `decrypt took ${elapsed} ms, expected < 5000 ms`);
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(out), /UNCLOSED/);
});

// --- Round 16 (Astra re-review #15): prefix-consistent endobj check ---

test("many `endobjx` forged dictionaries decrypt in linear time", async () => {
  // The round-15 `parseBalancedDict` stopped early only on a
  // WHOLE-TOKEN `endobj`, but the fallback `findOutsideStrings`
  // accepts `endobj` as a substring — so `endobjx` bypassed the early
  // exit (the dict scan went to its limit for each header) while the
  // fallback matched its `endobj` prefix. Here 10,000 forged headers,
  // each `K 0 obj << endobjx` (K = 40..10039), sit inside one correctly
  // sized encrypted stream. The old code took ~13.9 s; the new code
  // triggers on the `endobj` prefix (when not preceded by `/` or a
  // regular char), consistent with the fallback, so each call fails
  // fast and the total is linear (~0.34 s). The 5 s bound is the
  // regression guard for the quadratic path; the text assertion proves
  // the guard does not falsely reject. Both codes produce identical
  // output ("ENDOBJX" text, 220,083 output bytes); the difference is
  // the work, not the outcome.
  const bytes = pdfFixture("pdf-many-endobjx.pdf");
  const start = Date.now();
  const out = decryptPdfWithEmptyPassword(bytes);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `decrypt took ${elapsed} ms, expected < 5000 ms`);
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(out), /ENDOBJX/);
});

test("a stream dict containing the name `/endobj` decrypts successfully", async () => {
  // The round-15 `parseBalancedDict` treated `/endobj` (a NAME) as an
  // object terminator, because `/` is a delimiter and the whole-token
  // check passed (preceding `/`, following whitespace). It returned
  // undefined, `scanPdfObjects` fell back to a lexical `endobj` search
  // (which also matched inside `/endobj`), and recorded a truncated
  // object — so the old code REJECTED the file ("Encrypted PDFs are not
  // supported"). The new check excludes `/` from the `before` test (a
  // `/` makes it a name, not a keyword), so the dict
  // `<< /Length 52 /Custom /endobj >>` parses normally and the stream
  // decrypts successfully. The test asserts successful import with the
  // page text preserved (not merely a page-count check).
  const bytes = pdfFixture("pdf-endobj-name.pdf");
  assert.deepEqual(await inspectPdf(bytes), { pageCount: 1, fields: [] });
  assert.match(await pdfText(decryptPdfWithEmptyPassword(bytes)), /ENDOBJNAME/);
});
