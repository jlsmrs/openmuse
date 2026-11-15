import assert from "node:assert/strict";
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
import {
  createSamplePdf,
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
