import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSamplePdf, fillPdf, inspectPdf } from "../packages/integrations/src/pdf.ts";

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

test("W-9 inspects to 17 fields with values, 6 pages, xfa-static", async () => {
  const result = await inspectPdf(fixture("fw9.pdf"));
  assert.equal(result.pageCount, 6);
  assert.equal(result.formKind, "xfa-static");
  assert.equal(result.fields.length, 17);
  const textNames: Record<string, string> = {
    f1_01: "topmostSubform.f1_01",
    f1_02: "topmostSubform.f1_02",
    f1_03: "topmostSubform.Boxes3a-b_ReadOrder.f1_03",
    f1_04: "topmostSubform.Boxes3a-b_ReadOrder.f1_04",
    f1_05: "topmostSubform.f1_05",
    f1_06: "topmostSubform.f1_06",
    f1_07: "topmostSubform.Address_ReadOrder.f1_07",
    f1_08: "topmostSubform.Address_ReadOrder.f1_08",
    f1_09: "topmostSubform.f1_09",
    f1_10: "topmostSubform.f1_10",
    f1_11: "topmostSubform.f1_11",
    f1_12: "topmostSubform.f1_12",
    f1_13: "topmostSubform.f1_13",
    f1_14: "topmostSubform.f1_14",
    f1_15: "topmostSubform.f1_15",
  };
  for (const [short, full] of Object.entries(textNames)) {
    const field = result.fields.find((candidate) => candidate.name === full);
    assert.deepEqual(
      { name: field?.name, value: field?.value, type: field?.type },
      { name: full, value: "", type: "text" },
      short,
    );
  }
  for (const name of ["c1_1", "c1_2"]) {
    const field = result.fields.find((candidate) => candidate.name === `topmostSubform.${name}`);
    assert.equal(field?.value, "0");
    assert.equal(field?.type, "checkbox");
  }
  assert.deepEqual(result.fields.find((field) => field.name === "topmostSubform.c1_1")?.onValues, [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
  ]);
  assert.equal(
    result.fields.find((field) => field.name === "topmostSubform.c1_1")?.label,
    "Individual/sole proprietor",
  );
  assert.match(
    result.fields.find((field) => field.name === "topmostSubform.f1_01")?.label ?? "",
    /Name of entity\/individual/,
  );
});

test("synthetic static XFA inspects exactly", async () => {
  const result = await inspectPdf(fixture("xfa-static.pdf"));
  assert.equal(result.pageCount, 1);
  assert.equal(result.formKind, "xfa-static");
  assert.deepEqual(result.fields, [
    { name: "form.fullName", value: "Joshua Lewis Summers", type: "text", label: "Full name" },
    { name: "form.email", value: "josh@example.com", type: "text", label: "Email address" },
    { name: "form.amount", value: "42", type: "text", label: "Amount" },
    {
      name: "form.agree",
      value: "1",
      type: "checkbox",
      label: "I agree",
      onValues: ["1"],
    },
    {
      name: "form.color",
      value: "Green",
      type: "unsupported",
      options: ["Red", "Green", "Blue"],
      label: "Favourite colour",
    },
    {
      name: "form.paymentMethod",
      value: "card",
      type: "unsupported",
      options: ["card", "cash"],
    },
  ]);
});

test("synthetic dynamic XFA inspects with one field per repeating instance", async () => {
  const result = await inspectPdf(fixture("xfa-dynamic.pdf"));
  assert.equal(result.pageCount, 1);
  assert.equal(result.formKind, "xfa-dynamic");
  assert.deepEqual(result.fields, [
    { name: "form.title", value: "Order", type: "text", label: "Order title" },
    { name: "form.repeat[0].itemName", value: "Apples", type: "text" },
    { name: "form.repeat[1].itemName", value: "Oranges", type: "text" },
    { name: "form.repeat[0].itemQty", value: "3", type: "text" },
    { name: "form.repeat[1].itemQty", value: "5", type: "text" },
  ]);
});

test("field-less XFA inspects to zero fields and still stores a page count", async () => {
  const result = await inspectPdf(fixture("xfa-fieldless.pdf"));
  assert.deepEqual(result, { pageCount: 1, fields: [], formKind: "xfa-static" });
});

test("malformed XFA fixtures fail closed with a 422 naming the problem", async () => {
  const cases: [string, RegExp][] = [
    ["xfa-malformed-xxe.pdf", /DOCTYPE/i],
    ["xfa-malformed-unclosed.pdf", /not parseable XML/],
    ["xfa-malformed-no-datasets.pdf", /missing 'datasets' packet/],
    ["xfa-malformed-no-template.pdf", /missing 'template' packet/],
    ["xfa-malformed-mismatch.pdf", /mismatch.*ghostField/],
    ["xfa-malformed-oversized.pdf", /too large/],
  ];
  for (const [name, message] of cases) {
    await assert.rejects(inspectPdf(fixture(name)), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, message);
      return true;
    });
  }
});

test("empty-password-encrypted XFA inspects after the decryptor runs", async () => {
  const result = await inspectPdf(fixture("xfa-encrypted.pdf"));
  assert.equal(result.formKind, "xfa-static");
  assert.equal(result.fields.length, 6);
  assert.equal(
    result.fields.find((field) => field.name === "form.fullName")?.value,
    "Joshua Lewis Summers",
  );
});

test("filling an XFA form still rejects explicitly (fill is B2)", async () => {
  await assert.rejects(
    fillPdf(fixture("xfa-static.pdf"), { "form.fullName": "Nobody" }),
    /Unsupported XFA PDF form: filling XFA forms is not supported yet/,
  );
});

test("formKind classifies AcroForm and form-less PDFs", async () => {
  const sample = await inspectPdf(await createSamplePdf());
  assert.equal(sample.formKind, "acroform");
  assert.equal(sample.fields.length, 6);
});
