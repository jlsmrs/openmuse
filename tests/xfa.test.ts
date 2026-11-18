import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSamplePdf, fillPdf, inspectPdf } from "../packages/integrations/src/pdf.ts";
import { createXfaPdf, staticDatasetsXml, staticTemplateXml } from "./xfa-fixtures.ts";

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

// --- B1 fix round (panel adjudication, Nov 18, 2026) ----------------------
// Each test below is a regression test for an adopted panel finding; the
// probe shape it mirrors is noted. Fixtures are built in-test with the
// repo's own generator so the discriminating shape is visible in the test.

const wrap = (templateBody: string, datasetsBody: string) => ({
  templateXml:
    '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
    '<subform name="form" layout="tb">' +
    templateBody +
    "</subform></template>",
  datasetsXml:
    '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
    "<form>" +
    datasetsBody +
    "</form></xfa:data></xfa:datasets>",
});

test("P1-2: default binding resolves each branch to its own value (probe A shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="customer"><field name="taxId"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="supplier"><field name="taxId"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<customer><taxId>CUSTOMER-ID</taxId></customer><supplier><taxId>SUPPLIER-ID</taxId></supplier>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.customer.taxId", value: "CUSTOMER-ID", type: "text" },
    { name: "form.supplier.taxId", value: "SUPPLIER-ID", type: "text" },
  ]);
});

test("P1-2: default binding never claims a same-named leaf from another branch", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="customer"><field name="taxId"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="supplier"><field name="taxId"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<supplier><taxId>SUPPLIER-ID</taxId></supplier>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.customer\.taxId/);
    return true;
  });
});

test("P1-2: default binding fails closed when no dataset path matches the scope", async () => {
  // Round 3: the scope rule replaced closest-match. Template
  // form.a.b.code has scope [form, a, b] (both subforms bind by name);
  // neither dataset parent ([form, a] nor [form, b]) equals it, so
  // there is no data node — still fail closed, now as a scope mismatch
  // rather than a tie.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="a"><subform name="b"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform></subform>',
      "<a><code>ONE</code></a><b><code>TWO</code></b>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), /form\.a\.b\.code.*has no data node/);
});

test("P1-2 (round 2): a dataset segment the template does not name never matches", async () => {
  // The old tie-test shape: template form.code, datasets form.a.code and
  // form.b.code. Under the one-sided rule neither dataset parent is a
  // subsequence of [form], so there is no candidate at all — fail closed
  // with "no data node", not an ambiguity.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>',
      "<a><code>ONE</code></a><b><code>TWO</code></b>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), /form\.code.*has no data node/);
});

test("P1-2: global binding takes the first same-named leaf in document order", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="global"/></field>',
      "<a><code>FIRST</code></a><b><code>SECOND</code></b>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.a.code", value: "FIRST", type: "text" }]);
});

test("P1-3: bind none never reads datasets, even with a colliding node (probe B shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="ssn"><ui><textEdit/></ui><bind match="none"/></field>',
      "<ssn>123-45-6789</ssn>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.ssn", value: "", type: "unsupported" }]);
});

test("P1-3: dataRef without a usable ref fails closed instead of falling back", async () => {
  for (const bind of ['<bind match="dataRef"/>', '<bind match="dataRef" ref=""/>']) {
    const bytes = await createXfaPdf(
      wrap(
        `<field name="taxId"><ui><textEdit/></ui>${bind}</field>`,
        "<taxId>FALLBACK-VALUE</taxId>",
      ),
    );
    await assert.rejects(inspectPdf(bytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /mismatch.*form\.taxId.*missing or empty ref/);
      return true;
    });
  }
});

test("P1-3: an indexed dataRef resolves to the repeat instances (probe C shape)", async () => {
  const bytes = await createXfaPdf({
    dynamic: true,
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      '<subform name="form" layout="tb">' +
      '<subform name="repeat">' +
      '<field name="itemName"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.repeat[1].itemName"/></field>' +
      "</subform></subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      "<form><repeat><itemName>Apples</itemName></repeat>" +
      "<repeat><itemName>Oranges</itemName></repeat></form>" +
      "</xfa:data></xfa:datasets>",
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.repeat[0].itemName", value: "Apples", type: "text" },
    { name: "form.repeat[1].itemName", value: "Oranges", type: "text" },
  ]);
});

test("P1-3: an unknown bind match is field-level unsupported, never coerced to default", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="taxId"><ui><textEdit/></ui><bind match="once"/></field>',
      "<taxId>SECRET</taxId>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.taxId", value: "", type: "unsupported" }]);
});

test("P1-5: the exclGroup's own binding governs; children bindings do not (probe E shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<exclGroup name="paymentMethod"><bind match="dataRef" ref="$data.form.selectedPayment"/>' +
        '<field name="card"><ui><checkButton/></ui><items><text>card</text></items><bind match="default"/></field>' +
        '<field name="cash"><ui><checkButton/></ui><items><text>cash</text></items><bind match="default"/></field>' +
        "</exclGroup>",
      "<selectedPayment>cash</selectedPayment><paymentMethod>STALE</paymentMethod>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    {
      name: "form.selectedPayment",
      value: "cash",
      type: "unsupported",
      options: ["card", "cash"],
    },
  ]);
});

test("P1-5: an exclGroup with no group binding fails closed when its children disagree", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<exclGroup name="paymentMethod">' +
        '<field name="card"><ui><checkButton/></ui><items><text>card</text></items><bind match="default"/></field>' +
        '<field name="cash"><ui><checkButton/></ui><items><text>cash</text></items><bind match="global"/></field>' +
        "</exclGroup>",
      "<paymentMethod>card</paymentMethod>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), /exclGroup.*disagree/);
});

test("P1-4: conflicting bindings for one somPath fail closed instead of first-wins", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>' +
        '<field name="code"><ui><textEdit/></ui><bind match="global"/></field>',
      "<code>VALUE</code>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), /form\.code.*conflicting bindings/);
});

test("P1-4: two fields resolving to one data node fail closed (public-name collision)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="a"><ui><textEdit/></ui><bind match="global"/></field>' +
        '<field name="b"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.a"/></field>',
      "<a>VALUE</a>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), /resolve to the same data node/);
});

test("P1-6: a template missing only its final closing tag fails closed (probe F shape)", async () => {
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      '<subform name="form" layout="tb">' +
      '<field name="fullName"><ui><textEdit/></ui><bind match="global"/></field>' +
      "</subform>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      "<form><fullName>Joshua Lewis Summers</fullName></form>" +
      "</xfa:data></xfa:datasets>",
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /not parseable XML/);
    return true;
  });
});

test("P1-6: a template nested past the depth guard fails closed (probe H shape)", async () => {
  let deep = "";
  for (let i = 0; i < 110; i++) deep += `<subform name="s${i}">`;
  deep += '<field name="deepField"><ui><textEdit/></ui><bind match="global"/></field>';
  for (let i = 0; i < 110; i++) deep += "</subform>";
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      '<subform name="form" layout="tb">' +
      deep +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      "<form><deepField>DEEP</deepField></form>" +
      "</xfa:data></xfa:datasets>",
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /nested too deeply/);
    return true;
  });
});

test("P1-7: dataset whitespace is preserved (probe G shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="global"/></field>',
      "<code> 001 </code>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.code", value: " 001 ", type: "text" }]);
});

test("P1-7: rich-text dataset values flatten to text and are flagged unsupported", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      "<note><xhtml><body><p>Hello</p><p>World</p></body></xhtml></note>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note", value: "HelloWorld", type: "unsupported" },
  ]);
});

test("P1-7 (round 2): interleaved mixed content flattens in document order", async () => {
  // Round 1 failed this closed because the key-grouped parser merged the
  // text around <b> into one #text value and its order could not be
  // recovered. The order-preserving parse keeps "Hello " before <b>, so
  // the value is now reported in document order instead of guessed.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      "<note><xhtml><body><p>Hello <b>World</b></p></body></xhtml></note>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note", value: "Hello World", type: "unsupported" },
  ]);
});

test("gap b: several <items> elements merge into one option list", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="color"><ui><choiceList/></ui>' +
        "<items><text>Red</text><text>Green</text></items>" +
        "<items><text>Blue</text></items>" +
        '<bind match="global"/></field>',
      "<color>Blue</color>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    {
      name: "form.color",
      value: "Blue",
      type: "unsupported",
      options: ["Red", "Green", "Blue"],
    },
  ]);
});

test("gap c: a namespace-prefixed template root is recognised", async () => {
  const bytes = await createXfaPdf({
    templateXml:
      '<xfa:template xmlns:xfa="http://www.xfa.org/schema/xfa-template/3.3/">' +
      '<xfa:subform name="form" layout="tb">' +
      '<xfa:field name="fullName"><xfa:ui><xfa:textEdit/></xfa:ui><xfa:bind match="global"/></xfa:field>' +
      "</xfa:subform></xfa:template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      "<form><fullName>Joshua Lewis Summers</fullName></form>" +
      "</xfa:data></xfa:datasets>",
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.fullName", value: "Joshua Lewis Summers", type: "text" },
  ]);
});

test("gap d: duplicate XFA packet names fail closed", async () => {
  const bytes = await createXfaPdf({
    packets: [
      ["template", staticTemplateXml()],
      ["template", staticTemplateXml()],
      ["datasets", staticDatasetsXml()],
    ],
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /duplicate 'template' packet/);
    return true;
  });
});

test("P1-8: the join output cap holds for a large same-named repeat set", async () => {
  const repeats = Array.from(
    { length: 10001 },
    (_, index) => `<repeat><itemName>Item ${index}</itemName></repeat>`,
  ).join("");
  const bytes = await createXfaPdf({
    dynamic: true,
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      '<subform name="form" layout="tb">' +
      '<subform name="repeat">' +
      '<field name="itemName"><ui><textEdit/></ui><bind match="default"/></field>' +
      "</subform></subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      `<form>${repeats}</form>` +
      "</xfa:data></xfa:datasets>",
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /more than 10000 fields/);
    return true;
  });
});

// --- B1 fix round 2 (panel re-review, Nov 18, 2026) ----------------------
// Regression tests for R-1..R-8. Probe shapes are noted per test; R-2's
// transaction tests live in tests/store.test.ts, R-9's in
// tests/files-search-pull.test.ts.

test("R-1: Astra's nested counterexample fails closed (probe R1 shape)", async () => {
  // Template form.customer.taxId vs datasets form.supplier.customer.taxId:
  // the dataset path carries `supplier`, which the template never names,
  // so the one-sided rule admits no candidate — the supplier subtree's
  // leaf is never claimed for the customer field.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="customer"><field name="taxId"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<customer><other>Customer exists but has no tax ID</other></customer><supplier><customer><taxId>SUPPLIER-CUSTOMER-ID</taxId></customer></supplier>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.customer\.taxId/);
    return true;
  });
});

test("R-1 (round 3): same-name nesting, template-deeper direction, fails closed", async () => {
  // Round 3: the round-2 residual ambiguity is PROVEN unsafe (S-1) and
  // fixed, not documented. The template names a supplier branch the
  // datasets omit (form.supplier.customer.taxId vs form.customer.taxId);
  // the supplier subform binds by name (no <bind>), so it is a data
  // segment, not layout — the scope is [form, supplier, customer] and
  // the sibling customer leaf is out of scope. This test used to expect
  // the guessed match; it now expects fail-closed.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="supplier"><subform name="customer"><field name="taxId"><ui><textEdit/></ui><bind match="default"/></field></subform></subform>',
      "<customer><taxId>CUSTOMER-ID</taxId></customer>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.supplier\.customer\.taxId.*has no data node/);
    return true;
  });
});

test("R-3: rich-text siblings flatten in document order (probe R2 shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      "<note><xhtml><body><p>A</p><div>B</div><p>C</p></body></xhtml></note>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "ABC", type: "unsupported" }]);
});

test("R-3: global takes the first same-named leaf in document order (probe R3 shape)", async () => {
  // Document order is b/code FIRST, then a/code SECOND. The grouped
  // walk used to visit both `a` instances before `b` and pick SECOND.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="global"/></field>',
      "<a><other>unused</other></a><b><code>FIRST</code></b><a><code>SECOND</code></a>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.b.code", value: "FIRST", type: "text" }]);
});

test("R-4: a namespace collision fails closed (probe R4 shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="global"/></field>',
      '<form xmlns:a="urn:example" xmlns:b="urn:example"><a:code>FIRST</a:code><b:code>SECOND</b:code></form>',
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /namespace collision.*'code'/);
    return true;
  });
});

test('R-5: duplicate <bind match="none"/> fails closed (probe R5 shape)', async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="ssn"><ui><textEdit/></ui><bind match="none"/><bind match="none"/></field>',
      "<ssn>SECRET</ssn>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /more than one <bind>/);
    return true;
  });
});

test("R-5: a duplicate group <bind> fails closed", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<exclGroup name="paymentMethod"><bind match="global"/><bind match="global"/>' +
        '<field name="card"><ui><checkButton/></ui><items><text>card</text></items><bind match="global"/></field>' +
        '<field name="cash"><ui><checkButton/></ui><items><text>cash</text></items><bind match="global"/></field>' +
        "</exclGroup>",
      "<paymentMethod>card</paymentMethod>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), /more than one <bind>/);
});

test("R-5: duplicate <ui> and duplicate <caption> fail closed, not misread", async () => {
  const twoUis = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><ui><textEdit/></ui><bind match="global"/></field>',
      "<code>VALUE</code>",
    ),
  );
  await assert.rejects(inspectPdf(twoUis), /more than one <ui>/);
  const twoCaptions = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui>' +
        "<caption><value><text>One</text></value></caption>" +
        "<caption><value><text>Two</text></value></caption>" +
        '<bind match="global"/></field>',
      "<code>VALUE</code>",
    ),
  );
  await assert.rejects(inspectPdf(twoCaptions), /more than one <caption>/);
});

test("R-6: a dataRef with an index embedded in a name fails closed (probe R6 shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="taxId"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.cust[0]omer.taxId"/></field>',
      "<customer><taxId>SECRET</taxId></customer>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /unparseable dataRef/);
    return true;
  });
});

test("R-6: other malformed dataRefs fail closed, valid indexed refs still resolve", async () => {
  // Each malformed shape must 422 as unparseable, never be repaired.
  for (const ref of [
    "$form.taxId",
    "$data.form.a[0][1].b",
    "$data.form.a[x].b",
    "$data.form.[0]b",
    "$data.form..taxId",
    "$data.form.taxId ",
  ]) {
    const bytes = await createXfaPdf(
      wrap(
        `<field name="taxId"><ui><textEdit/></ui><bind match="dataRef" ref="${ref}"/></field>`,
        "<taxId>SECRET</taxId>",
      ),
    );
    await assert.rejects(inspectPdf(bytes), /unparseable dataRef/, ref);
  }
  // A bare (no $data.) indexed ref is a permitted prefix and resolves.
  const bare = await createXfaPdf({
    dynamic: true,
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      '<subform name="form" layout="tb">' +
      '<subform name="repeat">' +
      '<field name="itemName"><ui><textEdit/></ui><bind match="dataRef" ref="form.repeat[1].itemName"/></field>' +
      "</subform></subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      "<form><repeat><itemName>Apples</itemName></repeat>" +
      "<repeat><itemName>Oranges</itemName></repeat></form>" +
      "</xfa:data></xfa:datasets>",
  });
  const result = await inspectPdf(bare);
  assert.deepEqual(result.fields, [
    { name: "form.repeat[0].itemName", value: "Apples", type: "text" },
    { name: "form.repeat[1].itemName", value: "Oranges", type: "text" },
  ]);
});

test("R-7: many distinct fields over many unrelated leaves complete quickly", async () => {
  // 2,000 template fields (each with its matching leaf) plus 2,000
  // unrelated dataset leaves. The name index means each field compares
  // against its one same-named leaf only — the unrelated leaves cost
  // nothing — so this completes in well under the bound.
  const fieldCount = 2000;
  const templateFields = Array.from(
    { length: fieldCount },
    (_, i) => `<field name="f${i}"><ui><textEdit/></ui><bind match="default"/></field>`,
  ).join("");
  const datasets = Array.from({ length: fieldCount }, (_, i) => `<f${i}>value-${i}</f${i}>`).join(
    "",
  );
  const unrelated = Array.from(
    { length: fieldCount },
    (_, i) => `<u${i}>unrelated-${i}</u${i}>`,
  ).join("");
  const bytes = await createXfaPdf(wrap(templateFields, datasets + unrelated));
  const started = Date.now();
  const result = await inspectPdf(bytes);
  assert.ok(Date.now() - started < 5000, `join took ${Date.now() - started}ms`);
  assert.equal(result.fields.length, fieldCount);
  assert.equal(result.fields[0]?.name, "form.f0");
  assert.equal(result.fields[0]?.value, "value-0");
  assert.equal(result.fields[fieldCount - 1]?.name, `form.f${fieldCount - 1}`);
});

test("R-7 (round 3): same-named candidate spam now resolves fast and correctly", async () => {
  // Round 3: exact scope-path matching replaced the per-field name
  // scan, so the join-work budget it guarded is retired. 1,100 fields
  // named `code` under distinct parents, each with its own matching
  // leaf plus 1,100 same-named leaves under unrelated parents: every
  // field looks up its own exact path only, so this completes quickly
  // with the right value per field instead of failing on the budget.
  const count = 1100;
  const templateFields = Array.from(
    { length: count },
    (_, i) =>
      `<subform name="s${i}"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>`,
  ).join("");
  const matching = Array.from(
    { length: count },
    (_, i) => `<s${i}><code>match-${i}</code></s${i}>`,
  ).join("");
  const unrelated = Array.from(
    { length: count },
    (_, i) => `<t${i}><code>noise-${i}</code></t${i}>`,
  ).join("");
  const bytes = await createXfaPdf(wrap(templateFields, matching + unrelated));
  const started = Date.now();
  const result = await inspectPdf(bytes);
  assert.ok(Date.now() - started < 5000, `join took ${Date.now() - started}ms`);
  assert.equal(result.fields.length, count);
  assert.deepEqual(result.fields[0], { name: "form.s0.code", value: "match-0", type: "text" });
  assert.deepEqual(result.fields[count - 1], {
    name: `form.s${count - 1}.code`,
    value: `match-${count - 1}`,
    type: "text",
  });
});

test("R-8: depth only reachable through the preprocessing pass fails closed", async () => {
  // 150 levels of nesting inside a field's <ui> subtree: no guarded
  // walk ever recurses there (the collector reads only the ui's first
  // child kind), so only the conversion pass — the whole-document depth
  // gate — can catch it. Pre-fix this inspected successfully.
  let deep = "";
  for (let i = 0; i < 150; i++) deep += `<w${i}>`;
  deep += "<textEdit/>";
  for (let i = 149; i >= 0; i--) deep += `</w${i}>`;
  const bytes = await createXfaPdf(
    wrap(`<field name="code"><ui>${deep}</ui><bind match="global"/></field>`, "<code>VALUE</code>"),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /nested too deeply/);
    return true;
  });
});

test("R-8: whole-document depth — a deeply nested datasets packet fails closed", async () => {
  let deep = "";
  for (let i = 0; i < 110; i++) deep += `<d${i}>`;
  deep += "<code>DEEP</code>";
  for (let i = 109; i >= 0; i--) deep += `</d${i}>`;
  const bytes = await createXfaPdf(
    wrap('<field name="code"><ui><textEdit/></ui><bind match="global"/></field>', deep),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /nested too deeply/);
    return true;
  });
});

test("decode budget: XFA packets whose aggregate decoded size exceeds the budget fail closed", async () => {
  // Each packet is exactly the 10 MiB per-packet cap, so no single packet
  // trips it — but 11 of them decode to 110 MiB inside one inspect, past
  // the 100 MiB aggregate decode budget. The packets compress to almost
  // nothing (one repeated byte), so the PDF itself stays small.
  const filler = "x".repeat(10 * 1024 * 1024);
  const packets: [string, string][] = [
    ["template", staticTemplateXml()],
    ["datasets", staticDatasetsXml()],
  ];
  for (let i = 0; i < 11; i++) packets.push([`filler${i}`, filler]);
  const bytes = await createXfaPdf({ packets });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /expands beyond the supported size/);
    return true;
  });
});

// --- B1 fix round 3 (panel re-review #2, S-1..S-5, Nov 18, 2026) ---------
// Regression tests for the five adopted P1 findings. Probe shapes are
// noted per test; the probe harness is panel/probe-rereview2.mts.

test("S-1: a dataRef-bound subform's scope is honoured (probe A1 shape)", async () => {
  // The supplier subform is dataRef-bound to $data.form.supplier, so
  // the field's scope is [form, supplier] — and the supplier branch
  // has no taxId. The sibling form.customer.taxId must NOT be claimed
  // for it: the one-sided rule used to skip `supplier` as a
  // template-only segment, but the subform's binding establishes that
  // it is data scope.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="supplier"><bind match="dataRef" ref="$data.form.supplier"/><subform name="customer"><field name="taxId"><ui><textEdit/></ui><bind match="default"/></field></subform></subform>',
      "<supplier><customer><other>No tax ID here</other></customer></supplier><customer><taxId>CUSTOMER-ID</taxId></customer>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.supplier\.customer\.taxId.*has no data node/);
    return true;
  });
});

test("S-1: a bound subform's fields DO resolve under its dataRef (positive case)", async () => {
  // The same A1 template, but the datasets DO carry the scoped node:
  // form.supplier.taxId is inside the supplier scope, so it resolves.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="supplier"><bind match="dataRef" ref="$data.form.supplier"/><field name="taxId"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<supplier><taxId>SUPPLIER-ID</taxId></supplier><customer><taxId>CUSTOMER-ID</taxId></customer>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.supplier.taxId", value: "SUPPLIER-ID", type: "text" },
  ]);
});

test("S-1: a dataRef-bound subform redirects scope even when its name differs", async () => {
  // The subform is named `s` but dataRef-bound to $data.form.other:
  // the scope is the ref's path, not the name. The field resolves to
  // form.other.f — and NOT to a same-named leaf under form.s.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.other"/><field name="f"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<s><f>WRONG</f></s><other><f>RIGHT</f></other>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.other.f", value: "RIGHT", type: "text" }]);
});

test("S-1: a none-bound subform is transparent, like the W-9's Page1", async () => {
  // The template nests the field under a page subform that is
  // explicitly <bind match="none"/>; the datasets omit it. The scope
  // is [form], so the field resolves — this is the W-9's own shape
  // (Page1), and the transparency is established by the bind, not by
  // the segment's name.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="Page1"><bind match="none"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<code>VALUE</code>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.code", value: "VALUE", type: "text" }]);
});

test("S-1: subform bindings that cannot establish a scope fail closed", async () => {
  // A global-bound subform: global is a value lookup, not a scope.
  const globalSubform = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="global"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<s><code>VALUE</code></s>",
    ),
  );
  await assert.rejects(
    inspectPdf(globalSubform),
    /subform 'form\.s'.*cannot establish a data scope/,
  );
  // A dataRef-bound subform with no ref: missing scope, fail closed.
  const missingRef = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<s><code>VALUE</code></s>",
    ),
  );
  await assert.rejects(inspectPdf(missingRef), /subform 'form\.s'.*missing or empty ref/);
  // An unknown subform bind match: unsupported scope mapping.
  const unknownMatch = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="once"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<s><code>VALUE</code></s>",
    ),
  );
  await assert.rejects(
    inspectPdf(unknownMatch),
    /subform 'form\.s'.*cannot establish a data scope/,
  );
});

test("S-2: a literal dotted dataset name is rejected, never read as hierarchy (probe A2 shape)", async () => {
  // Both branches present: the literal <a.b> must not collapse with
  // the nested a > b into one form.a.b.code, and neither value may be
  // reported as the other's.
  const both = await createXfaPdf(
    wrap(
      '<subform name="a"><subform name="b"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform></subform>',
      "<a.b><code>DECOY</code></a.b><a><b><code>RIGHT</code></b></a>",
    ),
  );
  await assert.rejects(inspectPdf(both), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /cannot be represented in a SOM path/);
    assert.doesNotMatch(error.message, /DECOY/);
    return true;
  });
  // Only the dotted branch present: must NOT silently report DECOY as
  // the nested template field's value.
  const onlyDotted = await createXfaPdf(
    wrap(
      '<subform name="a"><subform name="b"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform></subform>',
      "<a.b><code>DECOY</code></a.b>",
    ),
  );
  await assert.rejects(inspectPdf(onlyDotted), /cannot be represented in a SOM path/);
});

test("S-2: a dotted template name is rejected the same way", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="a.b"><ui><textEdit/></ui><bind match="global"/></field>',
      "<code>VALUE</code>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), /cannot be represented in a SOM path/);
});

test("S-3: rich-text whitespace between elements is preserved (probe A3 shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      "<note><xhtml><body><p><b>A</b> <b>B</b></p></body></xhtml></note>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "A B", type: "unsupported" }]);
});

test("S-3: pretty-printing indentation is still skipped, not kept as content", async () => {
  // The same shape, but the whitespace between the elements holds line
  // breaks (formatting indentation): it is dropped, as before.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      "<note><xhtml><body><p><b>A</b>\n  <b>B</b>\n</p></body></xhtml></note>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "AB", type: "unsupported" }]);
});

test("S-4: two unbound sibling fields both survive, distinctly named (probe A4 shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="none"/><caption><value><text>First code</text></value></caption></field><field name="code"><ui><textEdit/></ui><bind match="none"/><caption><value><text>Second code</text></value></caption></field>',
      "<other>no code data</other>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.code[0]", value: "", type: "unsupported", label: "First code" },
    { name: "form.code[1]", value: "", type: "unsupported", label: "Second code" },
  ]);
});

test("S-4: a lone unbound field keeps its plain SOM name", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="none"/><caption><value><text>Only code</text></value></caption></field>',
      "<other>no code data</other>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.code", value: "", type: "unsupported", label: "Only code" },
  ]);
});

test("S-5: the aggregate output-byte bound fails closed on a scaled amplification (probe A5 shape)", async () => {
  // 10 KiB caption × 500 instances: ~5 MB of serialized labels from a
  // small input. The 1 MiB aggregate bound must reject it before
  // persistence or serialization. (The full 1 MiB × 10,000 shape is
  // deliberately NOT run.)
  const caption = "C".repeat(10 * 1024);
  const instances = Array.from({ length: 500 }, (_, i) => `<item><code>V${i}</code></item>`).join(
    "",
  );
  const bytes = await createXfaPdf(
    wrap(
      `<subform name="item"><field name="code"><ui><textEdit/></ui><bind match="default"/><caption><value><text>${caption}</text></value></caption></field></subform>`,
      instances,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /more than 1048576 bytes of resolved fields/);
    return true;
  });
});

test("S-5: a bounded input stays under the byte bound and resolves", async () => {
  // Same 500-instance shape with a short caption: ~25 KB of output,
  // well under the 1 MiB bound — it resolves, proving the bound is a
  // ceiling on amplification, not on repeat instances as such.
  const instances = Array.from({ length: 500 }, (_, i) => `<item><code>V${i}</code></item>`).join(
    "",
  );
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="item"><field name="code"><ui><textEdit/></ui><bind match="default"/><caption><value><text>Code</text></value></caption></field></subform>',
      instances,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.equal(result.fields.length, 500);
  assert.equal(result.fields[0]?.name, "form.item[0].code");
  assert.equal(result.fields[0]?.value, "V0");
  assert.equal(result.fields[0]?.label, "Code");
  assert.equal(result.fields[499]?.name, "form.item[499].code");
});
