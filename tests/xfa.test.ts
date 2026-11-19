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

test("P1-3: an indexed dataRef selects only its occurrence (probe C shape, T-2 round 4)", async () => {
  // Round-4 correction (T-2): the old test expected BOTH repeat
  // instances for a [1] selector — the selector was stripped and the
  // ref reinterpreted as "every occurrence". An explicit selector is
  // now honoured: [1] selects only occurrence 1 (Oranges).
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
  // A bare (no $data.) indexed ref is now RELATIVE to the field's
  // inherited scope (U-1, round 5) — the old absolute reading is
  // gone, so the positive control uses the explicit $data. prefix:
  // [1] selects only occurrence 1 (T-2, round 4).
  const bare = await createXfaPdf({
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
  const result = await inspectPdf(bare);
  assert.deepEqual(result.fields, [
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
  // scan. Round-4 correction (R-7): the scan's budget is NOT simply
  // retired — the pre-resolution paths are now bounded instead by the
  // aggregate internal path/index byte bound (T-3) and the on-values
  // merge bound (T-4); see buildJoinIndex and joinFields. 1,100 fields
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

// --- B1 fix round 4 (panel re-review #3, T-1..T-4 + M1/M2, Nov 18, 2026) ---
// Regression tests for the four adopted P1 findings and the two
// observable minors. Probe shapes are noted per test; the probe
// harness is panel/probe-rereview3-astra.mts.

test("T-1: same-named subforms with different dataRef scopes both resolve (probe T1 shape)", async () => {
  // Two <subform name="s">, dataRef-bound to form.customer vs
  // form.supplier, each with a default-bound field `code`. The old
  // collapse grouped by somPath only and kept the first scope, so the
  // supplier field disappeared silently. Scope is now part of the
  // collapse identity, so both fields come out under their own scope.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.customer"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="s"><bind match="dataRef" ref="$data.form.supplier"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<customer><code>CUSTOMER</code></customer><supplier><code>SUPPLIER</code></supplier>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.customer.code", value: "CUSTOMER", type: "text" },
    { name: "form.supplier.code", value: "SUPPLIER", type: "text" },
  ]);
});

test("T-1: same-named subforms with distinct captions keep both captions (probe T1b shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.customer"/><field name="code"><ui><textEdit/></ui><bind match="default"/><caption><value><text>Customer code</text></value></caption></field></subform>' +
        '<subform name="s"><bind match="dataRef" ref="$data.form.supplier"/><field name="code"><ui><textEdit/></ui><bind match="default"/><caption><value><text>Supplier code</text></value></caption></field></subform>',
      "<customer><code>CUSTOMER</code></customer><supplier><code>SUPPLIER</code></supplier>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.customer.code", value: "CUSTOMER", type: "text", label: "Customer code" },
    { name: "form.supplier.code", value: "SUPPLIER", type: "text", label: "Supplier code" },
  ]);
});

test("T-1: same somPath under the SAME scope still collapses to one field (positive control)", async () => {
  // Two occurrences of one field under subforms with the same name AND
  // the same dataRef bind share one data identity, so they collapse
  // exactly as before (W-9 c1_1 ×7 shape, scoped).
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.customer"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="s"><bind match="dataRef" ref="$data.form.customer"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<customer><code>CUSTOMER</code></customer>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.customer.code", value: "CUSTOMER", type: "text" },
  ]);
});

test("T-2: a dataRef [1] selector selects only occurrence 1 (probe T2 shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="selected"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.person[1].taxId"/></field>',
      "<person><taxId>FIRST</taxId></person><person><taxId>SECOND</taxId></person>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.person[1].taxId", value: "SECOND", type: "text" },
  ]);
});

test("T-2: a dataRef [0] selector selects the first occurrence, including a lone element", async () => {
  // Occurrence 0 of a single <person> is that element; [0] resolves
  // it rather than failing closed.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="selected"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.person[0].taxId"/></field>',
      "<person><taxId>ONLY</taxId></person>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.person.taxId", value: "ONLY", type: "text" }]);
});

test("T-2: a nonexistent dataRef [999] selector fails closed (probe T2b shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="selected"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.person[999].taxId"/></field>',
      "<person><taxId>FIRST</taxId></person><person><taxId>SECOND</taxId></person>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.selected.*has no data node/);
    assert.doesNotMatch(error.message, /FIRST|SECOND/);
    return true;
  });
});

test("T-2: an indexed dataRef-bound subform scope selects only that occurrence", async () => {
  // The subform is dataRef-bound to $data.form.person[1]: fields
  // inside it resolve under occurrence 1 only, not under occurrence 0.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.person[1]"/><field name="taxId"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<person><taxId>FIRST</taxId></person><person><taxId>SECOND</taxId></person>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.person[1].taxId", value: "SECOND", type: "text" },
  ]);
});

test("T-2: an indexed dataRef-bound subform scope with no such occurrence fails closed", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.person[1]"/><field name="taxId"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<person><taxId>ONLY</taxId></person>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*has no data node/);
    assert.doesNotMatch(error.message, /ONLY/);
    return true;
  });
});

test("T-3: a long ancestor name times many leaves fails closed fast (probe T3 shape)", async () => {
  // Scaled probe: 64 KiB ancestor name × 2,000 leaves, zero template
  // fields. The old code built the join index anyway (~9.3 s / +165 MB
  // RSS); the field-less template now skips the index entirely, and
  // the same construction WITH a field hits the aggregate internal
  // path bound instead of materializing ~128 MB of key characters.
  const longName = "a".repeat(64 * 1024);
  const leaves = Array.from({ length: 2000 }, (_, i) => `<f${i}/>`).join("");
  const fieldless = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"></subform></template>',
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><${longName}>${leaves}</${longName}></form></xfa:data></xfa:datasets>`,
  });
  const started = Date.now();
  const fieldlessResult = await inspectPdf(fieldless);
  assert.ok(Date.now() - started < 5000, `field-less inspect took ${Date.now() - started}ms`);
  assert.deepEqual(fieldlessResult.fields, []);
  // The same datasets with one template field under the long ancestor:
  // the aggregate internal path bound must fire instead of indexing.
  const withField = await createXfaPdf(
    wrap(
      `<subform name="${longName}"><field name="f0"><ui><textEdit/></ui><bind match="default"/></field></subform>`,
      `<${longName}><f0>VALUE</f0>${leaves}</${longName}>`,
    ),
  );
  await assert.rejects(inspectPdf(withField), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /exceeds 4194304 bytes of internal paths/);
    return true;
  });
});

test("T-3: many leaves under a short ancestor still resolve (positive control)", async () => {
  // The T-3 control: 2,000 leaves under a short name with a field-less
  // template completes and reports no fields — the bound is a ceiling
  // on amplification, not on leaf count as such.
  const leaves = Array.from({ length: 2000 }, (_, i) => `<f${i}/>`).join("");
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"></subform></template>',
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><a>${leaves}</a></form></xfa:data></xfa:datasets>`,
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, []);
});

test("T-4: a large collapsed checkbox group with distinct on-values completes quickly (probe T4 shape)", async () => {
  // 10,000 occurrences of one checkbox field, each with a distinct
  // on-value. The old per-occurrence Set rebuild was superlinear
  // (1,000 → 111 ms, 5,000 → 922 ms); one Set per merged group is
  // linear, so this completes in well under the bound with all 10,000
  // on-values merged onto the single output field.
  const count = 10000;
  const occurrences = Array.from(
    { length: count },
    (_, i) =>
      `<field name="code"><ui><checkButton/></ui><items><text>v${i}</text></items><bind match="global"/></field>`,
  ).join("");
  const bytes = await createXfaPdf(wrap(occurrences, "<code>0</code>"));
  const started = Date.now();
  const result = await inspectPdf(bytes);
  assert.ok(Date.now() - started < 5000, `checkbox merge took ${Date.now() - started}ms`);
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0]?.onValues?.length, count);
  assert.equal(result.fields[0]?.onValues?.[0], "v0");
  assert.equal(result.fields[0]?.onValues?.[count - 1], `v${count - 1}`);
});

test("M1: an error naming a very long field stays bounded (probe T5 shape)", async () => {
  // A 100 KiB field name with no data node used to produce a
  // 102,462-byte error message. Names in errors are now truncated
  // with a marker, so the message stays small while still naming the
  // field's start.
  const longName = "x".repeat(100 * 1024);
  const bytes = await createXfaPdf(
    wrap(
      `<field name="${longName}"><ui><textEdit/></ui><bind match="default"/></field>`,
      "<other>no match</other>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.ok(Buffer.byteLength(error.message, "utf8") < 4096);
    assert.match(error.message, /has no data node/);
    assert.match(error.message, /\[truncated \d+ chars\]/);
    return true;
  });
});

test("M2: the output-byte bound counts the JSON array exactly (probe T7 shape)", async () => {
  // The old accounting summed JSON.stringify(field) + 1 per field,
  // undercounting the full array by exactly 1 byte (the opening `[`
  // against the closing `]`/separators). Boundary probe: one field
  // whose serialized JSON is exactly 1,048,575 bytes, so the array
  // is exactly 1,048,577 — one byte OVER the 1 MiB bound — and must
  // reject; one byte less (array exactly 1,048,576) must pass.
  const buildValue = (targetFieldJsonBytes: number): string => {
    // {"name":"form.a","value":"<v>","type":"text"} — a fixed-size
    // envelope plus the value. Solve for the value length, then verify
    // the serialized field is exactly the target size.
    const fixed = Buffer.byteLength(
      JSON.stringify({ name: "form.a", value: "", type: "text" }),
      "utf8",
    );
    const value = "V".repeat(targetFieldJsonBytes - fixed);
    assert.equal(
      Buffer.byteLength(JSON.stringify({ name: "form.a", value, type: "text" }), "utf8"),
      targetFieldJsonBytes,
    );
    return value;
  };
  const overBytes = await createXfaPdf(
    wrap(
      '<field name="a"><ui><textEdit/></ui><bind match="default"/></field>',
      `<a>${buildValue(1048575)}</a>`,
    ),
  );
  await assert.rejects(inspectPdf(overBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /more than 1048576 bytes of resolved fields/);
    return true;
  });
  const exactBytes = await createXfaPdf(
    wrap(
      '<field name="a"><ui><textEdit/></ui><bind match="default"/></field>',
      `<a>${buildValue(1048574)}</a>`,
    ),
  );
  const result = await inspectPdf(exactBytes);
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0]?.name, "form.a");
});

// --- B1 fix round 5 (panel re-review #4, U-1..U-5 + U-P2, Nov 18, 2026) --
// Regression tests for the six adopted findings. Probe shapes are
// noted per test; the probe harness is panel/probe-rereview4.mts.

test("U-1: bare dataRefs resolve relative to their inherited scope (probe U1 shape)", async () => {
  // Astra's exact construction: two <subform name="s"> dataRef-bound
  // to $data.form.customer vs $data.form.supplier, each with a field
  // whose dataRef is the BARE `taxId`. The old code resolved the bare
  // ref from the dataset root and collapsed both fields onto the
  // ROOT-DECOY leaf. Relative resolution gives each field its own
  // branch's value, and the collapse identity now includes the
  // effective ref path, so both fields survive.
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      '<subform name="s"><bind match="dataRef" ref="$data.form.customer"/><field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="taxId"/></field></subform>' +
      '<subform name="s"><bind match="dataRef" ref="$data.form.supplier"/><field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="taxId"/></field></subform>' +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><taxId>ROOT-DECOY</taxId><form><customer><taxId>CUSTOMER</taxId></customer><supplier><taxId>SUPPLIER</taxId></supplier></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.customer.taxId", value: "CUSTOMER", type: "text" },
    { name: "form.supplier.taxId", value: "SUPPLIER", type: "text" },
  ]);
});

test("U-1: a bare dataRef with no matching relative node fails closed, never the root decoy", async () => {
  // The customer branch has no taxId; the dataset ROOT does. Relative
  // resolution must fail closed with no data node, not fall through
  // to the root leaf.
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      '<subform name="s"><bind match="dataRef" ref="$data.form.customer"/><field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="taxId"/></field></subform>' +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><taxId>ROOT-DECOY</taxId><form><customer><other>no tax id here</other></customer></form></xfa:data></xfa:datasets>',
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    assert.doesNotMatch(error.message, /ROOT-DECOY/);
    return true;
  });
});

test("U-1: a bare dataRef on a subform resolves relative to the parent scope", async () => {
  // The subform's bare ref `customer` sits under the parent scope
  // [form], so its scope is [form, customer] — not [customer] from
  // the dataset root, and not the same-named template subform's
  // branch.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="customer"/><field name="taxId"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<customer><taxId>CUSTOMER</taxId></customer><s><taxId>WRONG</taxId></s>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.customer.taxId", value: "CUSTOMER", type: "text" },
  ]);
});

test("U-1: the same bare ref under the same scope still collapses (positive control)", async () => {
  // Two occurrences of one field under subforms with the same name
  // AND the same dataRef bind share one effective identity, so they
  // collapse exactly as before.
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      '<subform name="s"><bind match="dataRef" ref="$data.form.customer"/><field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="taxId"/></field></subform>' +
      '<subform name="s"><bind match="dataRef" ref="$data.form.customer"/><field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="taxId"/></field></subform>' +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><customer><taxId>CUSTOMER</taxId></customer></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.customer.taxId", value: "CUSTOMER", type: "text" },
  ]);
});

test("U-2: a long ancestor times many leaves fails closed fast (probe U2 shape)", async () => {
  // Scaled probe: 256 KiB ancestor name × 10,000 identical leaves,
  // one short field. The old code charged the index bound only for
  // NEW keys, so the retained key (~256 KiB) stayed below the 4 MiB
  // bound while ~2.5 GiB of path strings were constructed (~5.2 s).
  // Per-leaf charging trips the bound after ~16 leaves instead.
  const longName = "a".repeat(256 * 1024);
  const leaves = "<f/>".repeat(10000);
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      '<field name="ok"><ui><textEdit/></ui><bind match="default"/></field>' +
      "</subform></template>",
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><${longName}>${leaves}</${longName}><ok>V</ok></form></xfa:data></xfa:datasets>`,
  });
  const started = Date.now();
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /exceeds 4194304 bytes of internal paths/);
    return true;
  });
  // The bound trip itself is fast (after ~16 leaves); the residual
  // time is the dependency parser's work on the 256 KiB tag name plus
  // machine load, which also dominates the pre-fix run — so the
  // timing bound here is a gross-slowness guard only. The
  // discrimination against the old code is the rejection itself: the
  // old code returned fields successfully after ~2.5 GiB of path
  // construction.
  assert.ok(Date.now() - started < 20000, `U2 inspect took ${Date.now() - started}ms`);
});

test("U-2b: a long shared scope times many fields completes fast (probe U2b shape)", async () => {
  // 8 KiB scope segment shared by 2,000 default-bound fields. The old
  // code called JSON.stringify(scope) per occurrence in the collapse
  // identity; scopes are now interned ids, so the shared scope is
  // never re-serialized. All 2,000 occurrences collapse to one field.
  // The collapse itself is asserted deterministically below; the 5 s
  // bound is a gross-slowness guard only — there is no work counter
  // to assert against, so timing is the only performance signal here
  // (round 6, test adequacy).
  const longSeg = "s".repeat(8 * 1024);
  const fields = Array.from(
    { length: 2000 },
    () => '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>',
  ).join("");
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      `<subform name="s"><bind match="dataRef" ref="$data.form.${longSeg}"/>${fields}</subform>` +
      "</subform></template>",
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><${longSeg}><code>SHARED</code></${longSeg}></form></xfa:data></xfa:datasets>`,
  });
  const started = Date.now();
  const result = await inspectPdf(bytes);
  assert.ok(Date.now() - started < 5000, `U2b inspect took ${Date.now() - started}ms`);
  assert.deepEqual(result.fields, [
    { name: `form.${longSeg}.code`, value: "SHARED", type: "text" },
  ]);
});

test("U-2: a wide tree under one long parent scope completes fast", async () => {
  // One 8 KiB parent scope with 100 child subforms, each with one
  // field. The walk carries parent-linked scopes (materialized once
  // per distinct scope, memoized), so the parent scope's characters
  // are never copied per child; the retained field paths (~820 KB
  // total) stay under the aggregate template-path bound, and the
  // output (~830 KB) stays under the 1 MiB output bound. The field
  // results are asserted deterministically below; the 5 s bound is a
  // gross-slowness guard only (round 6, test adequacy).
  const longParent = "p".repeat(8 * 1024);
  const count = 100;
  const templateFields = Array.from(
    { length: count },
    (_, i) =>
      `<subform name="c${i}"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>`,
  ).join("");
  const datasets = Array.from(
    { length: count },
    (_, i) => `<c${i}><code>V${i}</code></c${i}>`,
  ).join("");
  const bytes = await createXfaPdf(
    wrap(
      `<subform name="${longParent}">${templateFields}</subform>`,
      `<${longParent}>${datasets}</${longParent}>`,
    ),
  );
  const started = Date.now();
  const result = await inspectPdf(bytes);
  assert.ok(Date.now() - started < 5000, `wide-tree inspect took ${Date.now() - started}ms`);
  assert.equal(result.fields.length, count);
  assert.deepEqual(result.fields[0], {
    name: `form.${longParent}.c0.code`,
    value: "V0",
    type: "text",
  });
  assert.deepEqual(result.fields[count - 1], {
    name: `form.${longParent}.c${count - 1}.code`,
    value: `V${count - 1}`,
    type: "text",
  });
});

test("U-3: many indexed fields over one repeated-path bucket complete quickly (probe U3 shape)", async () => {
  // Scaled probe: 1,000 fields × 4,000 persons. The old code filtered
  // the entire 4,000-leaf bucket per field (~1.6 s and growing with
  // fields × bucket size); the occurrence index narrows each lookup
  // to its one branch first. The deterministic signal is completion
  // itself: a whole-bucket scan would examine 1,000 × 4,000 =
  // 4,000,000 candidates and trip the 1,000,000 comparison budget,
  // so returning all 1,000 fields proves the narrowing. The 5 s bound
  // is a gross-slowness guard only (round 6, test adequacy; was a
  // 1 s performance assertion).
  const nFields = 1000;
  const nPersons = 4000;
  const templateFields = Array.from(
    { length: nFields },
    (_, i) =>
      `<subform name="p${i}"><field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.person[${i}].code"/></field></subform>`,
  ).join("");
  const persons = Array.from(
    { length: nPersons },
    (_, i) => `<person><code>V${i}</code></person>`,
  ).join("");
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      templateFields +
      "</subform></template>",
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>${persons}</form></xfa:data></xfa:datasets>`,
  });
  const started = Date.now();
  const result = await inspectPdf(bytes);
  assert.ok(Date.now() - started < 5000, `U3 inspect took ${Date.now() - started}ms`);
  assert.equal(result.fields.length, nFields);
  assert.deepEqual(result.fields[0], {
    name: "form.person[0].code",
    value: "V0",
    type: "text",
  });
  assert.deepEqual(result.fields[nFields - 1], {
    name: `form.person[${nFields - 1}].code`,
    value: `V${nFields - 1}`,
    type: "text",
  });
});

test("U-3: the aggregate comparison budget fails closed (backstop)", async () => {
  // 10,001 indexed fields over a 100 × 100 grid of leaves: each
  // lookup narrows to 100 candidates and matches exactly 1, so the
  // output stays under its count bound while the comparisons cross
  // 1,000,000 during the last field — the restored aggregate budget
  // (the original R-7 number) trips instead of the work growing
  // without bound.
  const grid = 100;
  const fieldCount = 10001;
  const persons = Array.from(
    { length: grid },
    (_, i) =>
      `<g>${Array.from({ length: grid }, (_, j) => `<item><code>V${i}-${j}</code></item>`).join("")}</g>`,
  ).join("");
  const templateFields = Array.from(
    { length: fieldCount },
    (_, k) =>
      `<subform name="p${k}"><field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.g[${k % grid}].item[${Math.floor(k / grid) % grid}].code"/></field></subform>`,
  ).join("");
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      templateFields +
      "</subform></template>",
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>${persons}</form></xfa:data></xfa:datasets>`,
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /exceeded 1000000 structural comparisons/);
    return true;
  });
});

test("U-4: an unnamed field with an explicit dataRef is reported under its derived name (probe U4 shape)", async () => {
  // Astra's exact construction: the field has no name but an explicit
  // dataRef bind. The old code returned undefined before ever reading
  // the bind, so the form reported fields: []. The derived name comes
  // from the ref's last segment.
  const bytes = await createXfaPdf(
    wrap(
      '<field><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.code"/></field>',
      "<code>VALUE</code>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.code", value: "VALUE", type: "text" }]);
});

test("U-4: an unnamed exclGroup with bound options fails closed (probe U4b shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<exclGroup><field name="a"><ui><radioButton/></ui><bind match="default"/></field><field name="b"><ui><radioButton/></ui><bind match="default"/></field></exclGroup>',
      "<a>1</a><b>0</b>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /exclGroup with no name.*has an explicit binding/);
    return true;
  });
});

test("U-4: an unnamed field with an explicit default binding fails closed", async () => {
  const bytes = await createXfaPdf(
    wrap('<field><ui><textEdit/></ui><bind match="default"/></field>', "<code>VALUE</code>"),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /template field with no name.*has an explicit 'default' binding/);
    return true;
  });
});

test("U-4: an unnamed field with no bind is still dropped (no behaviour change)", async () => {
  // No <bind> at all means no data semantics: the field is dropped
  // exactly as before, and the named field still resolves.
  const bytes = await createXfaPdf(
    wrap(
      '<field><ui><textEdit/></ui></field><field name="code"><ui><textEdit/></ui><bind match="default"/></field>',
      "<code>VALUE</code>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.code", value: "VALUE", type: "text" }]);
});

test("U-4: unnamed options inside a named group — bind fails closed, items text is the option, neither is skipped", async () => {
  // An unnamed option WITH a bind fails closed.
  const bound = await createXfaPdf(
    wrap(
      '<exclGroup name="pay"><field name="a"><ui><checkButton/></ui><items><text>a</text></items><bind match="default"/></field><field><ui><checkButton/></ui><items><text>b</text></items><bind match="default"/></field></exclGroup>',
      "<pay>a</pay>",
    ),
  );
  await assert.rejects(inspectPdf(bound), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /unnamed option field with an explicit binding/);
    return true;
  });
  // An unnamed option with <items> text but no bind contributes its
  // first item text as the option; one with neither bind nor items
  // is skipped.
  const items = await createXfaPdf(
    wrap(
      '<exclGroup name="pay"><field name="a"><ui><checkButton/></ui><items><text>a</text></items><bind match="default"/></field><field><ui><checkButton/></ui><items><text>b</text><text>0</text></items></field><field><ui><checkButton/></ui></field></exclGroup>',
      "<pay>a</pay>",
    ),
  );
  const result = await inspectPdf(items);
  assert.deepEqual(result.fields, [
    {
      name: "form.pay",
      value: "a",
      type: "unsupported",
      options: ["a", "b"],
    },
  ]);
});

test("U-5: xml:space=preserve keeps the newline in rich text (probe U5 shape)", async () => {
  // Astra's exact construction: the newline between <b>A</b> and
  // <b>B</b> is explicitly significant, so the value is "A\nB", not "AB".
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml><body><p xml:space="preserve"><b>A</b>\n<b>B</b></p></body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "A\nB", type: "unsupported" }]);
});

test("U-5: the same markup without xml:space still reports AB (non-preserve control)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml><body><p><b>A</b>\n<b>B</b></p></body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "AB", type: "unsupported" }]);
});

test("U-5: xml:space=default resets preservation inside a preserve ancestor", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml><body><p xml:space="preserve"><span xml:space="default"><b>A</b>\n<b>B</b></span></p></body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "AB", type: "unsupported" }]);
});

test("U-P2: a namespace collision with very long names stays bounded (probe P2 shape)", async () => {
  // Two qualified siblings share a 100 KiB local name. The old error
  // interpolated the long name 3× raw (307,301 bytes); the names are
  // now shortName'd and the final message is capped at 1,024 bytes.
  const longLocal = "n".repeat(100 * 1024);
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"></subform></template>',
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xmlns:a="urn:a" xmlns:b="urn:b"><xfa:data><form><a:${longLocal}/><b:${longLocal}/></form></xfa:data></xfa:datasets>`,
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.ok(Buffer.byteLength(error.message, "utf8") <= 1024);
    assert.match(error.message, /namespace collision/);
    assert.match(error.message, /\[truncated \d+ chars\]/);
    return true;
  });
});

test("U-P2: a validator message with a very long tag stays bounded (probe P2b shape)", async () => {
  // Malformed XML with a 100 KiB tag name: the dependency echoes the
  // long tag into its diagnostic, which used to pass through raw
  // (102,546 bytes). The validator message is now shortName'd and the
  // final message capped at 1,024 bytes.
  const longTag = "t".repeat(100 * 1024);
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"></subform></template>',
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><${longTag}></form></xfa:data></xfa:datasets>`,
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.ok(Buffer.byteLength(error.message, "utf8") <= 1024);
    assert.match(error.message, /not parseable XML/);
    return true;
  });
});

test("U-P2: a short error message is not truncated", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>',
      "<other>no match</other>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    assert.doesNotMatch(error.message, /\[truncated/);
    return true;
  });
});

test("T-4 (round 5): merged on-values over 1 MiB fail closed deterministically", async () => {
  // 200 occurrences of one checkbox field, each with a distinct ~6 KiB
  // on-value: ~1.2 MB merged, past the 1 MiB merge bound. The old
  // coverage had only the fast 10,000-value positive case.
  const count = 200;
  const occurrences = Array.from(
    { length: count },
    (_, i) =>
      `<field name="code"><ui><checkButton/></ui><items><text>${`v${i}`}${"x".repeat(6000)}</text></items><bind match="global"/></field>`,
  ).join("");
  const bytes = await createXfaPdf(wrap(occurrences, "<code>0</code>"));
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /more than 1048576 bytes of checkbox on-values/);
    return true;
  });
});

test("T-3 (round 5): template paths over 4 MiB in aggregate fail closed", async () => {
  // 100 fields under one 50 KiB subform name: each retained somPath
  // is ~51 KiB, so the aggregate passes 4 MiB partway through the
  // template walk and the inspect fails closed on the path bound.
  const longName = "a".repeat(50 * 1024);
  const fields = Array.from(
    { length: 100 },
    (_, i) => `<field name="f${i}"><ui><textEdit/></ui><bind match="default"/></field>`,
  ).join("");
  const bytes = await createXfaPdf(
    wrap(
      `<subform name="${longName}">${fields}</subform>`,
      `<${longName}><f0>VALUE</f0></${longName}>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /template paths exceed 4194304 bytes/);
    return true;
  });
});

// --- B1 fix round 6 (panel re-review #5, chunked Astra, Nov 19, 2026) --------
// Each test below is a regression test for an adopted P1 finding; the
// probe shape it mirrors (panel/probe-rereview5.mts) is noted.

test("A-1 (round 6): a many-segment dataRef fails closed deterministically, field-less (probe V1 shape)", async () => {
  // 10,000 segments on a field-less subform: the old code folded it
  // one segment at a time through a scope array copied per segment
  // (quadratic, 275 ms) and no bound ever tripped, because
  // countTemplatePath only charges built fields. The ref is now
  // rejected at parse time (limit 100 segments) in milliseconds.
  for (const n of [10000, 20000]) {
    const ref = `$data.${Array(n).fill("a").join(".")}`;
    const bytes = await createXfaPdf({
      templateXml:
        '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
        `<subform name="s"><bind match="dataRef" ref="${ref}"/></subform>` +
        "</subform></template>",
      datasetsXml:
        '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><ok>V</ok></form></xfa:data></xfa:datasets>',
    });
    await assert.rejects(inspectPdf(bytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, new RegExp(`dataRef with ${n} segments \\(limit 100\\)`));
      return true;
    });
  }
});

test("A-1 (round 6): a many-segment dataRef fails closed with a field under it too", async () => {
  // The same bound applies when the long-ref subform HAS a field: the
  // rejection happens at parse time, before the field is ever built.
  const ref = `$data.${Array(5000).fill("a").join(".")}`;
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      `<subform name="s"><bind match="dataRef" ref="${ref}"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>` +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><ok>V</ok></form></xfa:data></xfa:datasets>',
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /dataRef with 5000 segments \(limit 100\)/);
    return true;
  });
});

test("A-1 (round 6): a 101-segment dataRef fails closed, a 98-segment ref resolves (boundary)", async () => {
  // The parse bound is 100 segments; the deepest resolvable leaf path
  // is 98 (the <xfa:datasets> + <xfa:data> wrappers consume depth in
  // the conversion pass — verified empirically: 98 resolves, 99-deep
  // datasets trip the depth gate). So the boundary has three distinct
  // outcomes, all deterministic: 98 resolves, 100 parses but matches
  // nothing, 101 is rejected at parse time.
  const nested = (depth: number, leaf: string): string => {
    let open = "";
    let close = "";
    for (let i = 0; i < depth; i++) {
      open += `<a${i}>`;
      close = `</a${i}>${close}`;
    }
    return `<form>${open}${leaf}${close}</form>`;
  };
  const segments = (count: number): string =>
    ["form", ...Array.from({ length: count - 2 }, (_, i) => `a${i}`), "code"].join(".");
  // 98 segments: form + a0..a95 + code, nested 96 deep under <form>.
  const ok = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      `<field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="$data.${segments(98)}"/></field>` +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      nested(96, "<code>DEEP</code>") +
      "</xfa:data></xfa:datasets>",
  });
  const result = await inspectPdf(ok);
  assert.deepEqual(result.fields, [{ name: `${segments(98)}`, value: "DEEP", type: "text" }]);
  // 100 segments: parses (at the limit) but can never match a leaf.
  const noMatch = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      `<field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="$data.${segments(100)}"/></field>` +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><ok>V</ok></form></xfa:data></xfa:datasets>',
  });
  await assert.rejects(inspectPdf(noMatch), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  // 101 segments: one too many, rejected at parse time.
  const tooLong = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      `<field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="$data.${segments(101)}"/></field>` +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><ok>V</ok></form></xfa:data></xfa:datasets>',
  });
  await assert.rejects(inspectPdf(tooLong), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /dataRef with 101 segments \(limit 100\)/);
    return true;
  });
});

test("A-2 (round 6): a 256 KiB selector fails closed deterministically (probe V2 shape)", async () => {
  // One person, 5,000 <code> leaves, a 256 KiB zero selector: the old
  // code re-parsed the selector (regex + Number) for every candidate
  // (8,299 ms vs 397 ms for "[0]"). The selector is now rejected at
  // parse time — over-long digit run — before any lookup runs.
  const zeroSelector = "0".repeat(256 * 1024);
  const codes = "<code>V</code>".repeat(5000);
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      `<subform name="s"><bind match="dataRef" ref="$data.form.person"/><field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.person[${zeroSelector}].code"/></field></subform>` +
      "</subform></template>",
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><person>${codes}</person></form></xfa:data></xfa:datasets>`,
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /out-of-range \[N\] selector/);
    return true;
  });
});

test("A-2 (round 6): selector bounds — [1000000] parses but matches nothing, [1000001] fails closed at parse", async () => {
  // The value ceiling is 1,000,000: the maximum is accepted at parse
  // time and fails closed at lookup (no such occurrence), while one
  // past it — and an 8-digit leading-zero run with value 1 — are
  // rejected at parse time.
  const atMax = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.person[1000000].code"/></field>',
      "<person><code>ONLY</code></person>",
    ),
  );
  await assert.rejects(inspectPdf(atMax), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  for (const selector of ["1000001", "00000001"]) {
    const bytes = await createXfaPdf(
      wrap(
        `<field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.person[${selector}].code"/></field>`,
        "<person><code>ONLY</code></person>",
      ),
    );
    await assert.rejects(inspectPdf(bytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /out-of-range \[N\] selector/);
      return true;
    });
  }
});

test("A-3 (round 6): xml:space=preserve on the datasets form ancestor keeps the newline (probe V3a shape)", async () => {
  // Astra's exact shape: preserve sits on <form>, above the nodeText
  // entry point at <note>. The state is now carried through the
  // datasets walk, so the value is "A\nB", not "AB".
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>' +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      `<form xml:space="preserve"><note><xhtml><body><p><b>A</b>\n<b>B</b></p></body></xhtml></note></form>` +
      "</xfa:data></xfa:datasets>",
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "A\nB", type: "unsupported" }]);
  // Control: the same markup without xml:space still reports "AB".
  const control = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml><body><p><b>A</b>\n<b>B</b></p></body></xhtml></note>`,
    ),
  );
  const controlResult = await inspectPdf(control);
  assert.deepEqual(controlResult.fields, [{ name: "form.note", value: "AB", type: "unsupported" }]);
});

test("A-3 (round 6): xml:space on the datasets roots reaches the walk, and default resets it", async () => {
  // Preserve on <xfa:data> — above the walk's entry point at <data> —
  // reaches the rich text; a default on the <form> below it resets
  // the state back, so the same markup reports "AB".
  const preserved = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>' +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data xml:space="preserve">' +
      `<form><note><xhtml><body><p><b>A</b>\n<b>B</b></p></body></xhtml></note></form>` +
      "</xfa:data></xfa:datasets>",
  });
  const preservedResult = await inspectPdf(preserved);
  assert.deepEqual(preservedResult.fields, [
    { name: "form.note", value: "A\nB", type: "unsupported" },
  ]);
  const reset = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>' +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data xml:space="preserve">' +
      `<form xml:space="default"><note><xhtml><body><p><b>A</b>\n<b>B</b></p></body></xhtml></note></form>` +
      "</xfa:data></xfa:datasets>",
  });
  const resetResult = await inspectPdf(reset);
  assert.deepEqual(resetResult.fields, [{ name: "form.note", value: "AB", type: "unsupported" }]);
});

test("A-3 (round 6): xml:space=preserve on a template items ancestor keeps the newline in options (probe V3b shape)", async () => {
  // The preserve sits on <items>, above itemTexts()' entry point at
  // the <text> child. Options are ["A\nB"], not ["AB"].
  const bytes = await createXfaPdf(
    wrap(
      '<field name="pick"><ui><choiceList/></ui><bind match="none"/><items xml:space="preserve"><text><b>A</b>\n<b>B</b></text></items></field>',
      "<ok>V</ok>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.pick", value: "", type: "unsupported", options: ["A\nB"] },
  ]);
  // Control: the same items without xml:space still report ["AB"].
  const control = await createXfaPdf(
    wrap(
      '<field name="pick"><ui><choiceList/></ui><bind match="none"/><items><text><b>A</b>\n<b>B</b></text></items></field>',
      "<ok>V</ok>",
    ),
  );
  const controlResult = await inspectPdf(control);
  assert.deepEqual(controlResult.fields, [
    { name: "form.pick", value: "", type: "unsupported", options: ["AB"] },
  ]);
});

test("A-3 (round 6): a caption under xml:space=preserve keeps its newlines (probe V3c shape)", async () => {
  // DECIDED (round 6, SPEC §1 step 4): a caption under
  // xml:space="preserve" keeps its whitespace verbatim — the document
  // says it is significant — while a caption without preserve still
  // normalizes, as before.
  const bytes = await createXfaPdf(
    wrap(
      `<field name="note"><ui><textEdit/></ui><bind match="none"/><caption xml:space="preserve"><value><p><b>A</b>\n<b>B</b></p></value></caption></field>`,
      "<ok>V</ok>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note", value: "", type: "unsupported", label: "A\nB" },
  ]);
  // Control: the same caption without preserve normalizes to "AB".
  const control = await createXfaPdf(
    wrap(
      `<field name="note"><ui><textEdit/></ui><bind match="none"/><caption><value><p><b>A</b>\n<b>B</b></p></value></caption></field>`,
      "<ok>V</ok>",
    ),
  );
  const controlResult = await inspectPdf(control);
  assert.deepEqual(controlResult.fields, [
    { name: "form.note", value: "", type: "unsupported", label: "AB" },
  ]);
});

test("A-3 (round 6): xml:space=preserve on the template root reaches a field caption", async () => {
  // State set on <template> itself — the template walk's root — must
  // reach the fields below it, not just state set on nearer ancestors.
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/" xml:space="preserve"><subform name="form" layout="tb">' +
      `<field name="note"><ui><textEdit/></ui><bind match="none"/><caption><value><p><b>A</b>\n<b>B</b></p></value></caption></field>` +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><ok>V</ok></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note", value: "", type: "unsupported", label: "A\nB" },
  ]);
});

test("A-4 (round 6): overlapping scopes merge to one field with unioned on-values (probe V4 shape)", async () => {
  // Astra's exact construction: two subforms named s, dataRef-bound
  // to $data.form.person and $data.form.person[0], each with a
  // checkButton field code; one person, one code 0. The old code
  // reported the same public name twice (onValues ["1"] and ["2"]);
  // the resolved node is the identity, so they merge to one field.
  const sub = (ref: string, on: string) =>
    `<subform name="s"><bind match="dataRef" ref="${ref}"/>` +
    `<field name="code"><ui><checkButton/></ui><bind match="dataRef" ref="code"/>` +
    `<items><text>${on}</text><text>0</text></items></field></subform>`;
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      sub("$data.form.person", "1") +
      sub("$data.form.person[0]", "2") +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><person><code>0</code></person></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.person.code", value: "0", type: "checkbox", onValues: ["1", "2"] },
  ]);
});

test("A-4 (round 6): overlapping scopes with conflicting options fail closed", async () => {
  // Same overlapping shape, but the two occurrences disagree about
  // the node's options: that is incompatible metadata for one data
  // node, not a merge — fail closed instead of letting one side win.
  const sub = (ref: string, options: string) =>
    `<subform name="s"><bind match="dataRef" ref="${ref}"/>` +
    `<field name="code"><ui><choiceList/></ui><bind match="dataRef" ref="code"/>` +
    `<items>${options}</items></field></subform>`;
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      sub("$data.form.person", "<text>Red</text><text>Green</text>") +
      sub("$data.form.person[0]", "<text>Red</text><text>Blue</text>") +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><person><code>Red</code></person></form></xfa:data></xfa:datasets>',
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /conflicting options/);
    return true;
  });
});

test("A-4 (round 6): overlapping scopes with conflicting labels fail closed", async () => {
  // Same overlapping shape, but the two occurrences caption the node
  // differently: incompatible metadata, fail closed.
  const sub = (ref: string, label: string) =>
    `<subform name="s"><bind match="dataRef" ref="${ref}"/>` +
    `<field name="code"><ui><checkButton/></ui><bind match="dataRef" ref="code"/>` +
    `<items><text>1</text><text>0</text></items><caption><value>${label}</value></caption></field></subform>`;
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      sub("$data.form.person", "First label") +
      sub("$data.form.person[0]", "Second label") +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><person><code>0</code></person></form></xfa:data></xfa:datasets>',
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /conflicting labels/);
    return true;
  });
});

test("A-4 (round 6): overlapping scopes merge for unnamed fields too", async () => {
  // Unnamed checkButton fields (derived name from the bare ref's last
  // segment) under the same overlapping scopes: the same resolved
  // node, so they merge exactly like the named shape.
  const sub = (ref: string, on: string) =>
    `<subform name="s"><bind match="dataRef" ref="${ref}"/>` +
    `<field><ui><checkButton/></ui><bind match="dataRef" ref="code"/>` +
    `<items><text>${on}</text><text>0</text></items></field></subform>`;
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      sub("$data.form.person", "1") +
      sub("$data.form.person[0]", "2") +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><person><code>0</code></person></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.person.code", value: "0", type: "checkbox", onValues: ["1", "2"] },
  ]);
});

// --- B1 fix round 7 (panel re-review #6, chunked Astra, Nov 19, 2026) --------
// Each test below is a regression test for an adopted P1 finding; the
// probe shape it mirrors (panel/probe-rereview6.mts) is noted.

test("A-1 (round 7): overlapping scopes do not leak on-values between resolved fields (probe W1 shape)", async () => {
  // Two persons; the first unit scopes $data.form.person (both), the
  // second scopes $data.form.person[0] (person 0 only). The old code
  // assigned the template unit's onValues array directly to every
  // resolved field, so merging "2" into person 0 also gave it to
  // person 1 (sameArrayRef=true). Each resolved field now owns its
  // merge state: person 0 merges ["1", "2"], person 1 stays ["1"].
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      `<subform name="s"><bind match="dataRef" ref="$data.form.person"/>` +
      `<field name="code"><ui><checkButton/></ui><bind match="default"/><items><text>1</text><text>0</text></items></field></subform>` +
      `<subform name="s"><bind match="dataRef" ref="$data.form.person[0]"/>` +
      `<field name="code"><ui><checkButton/></ui><bind match="default"/><items><text>2</text><text>0</text></items></field></subform>` +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><person><code>0</code></person><person><code>0</code></person></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.person[0].code", value: "0", type: "checkbox", onValues: ["1", "2"] },
    { name: "form.person[1].code", value: "0", type: "checkbox", onValues: ["1"] },
  ]);
  // The two fields must not share one array object: mutating one
  // resolved field's onValues must not change the other.
  result.fields[0].onValues?.push("MUTATED");
  assert.deepEqual(result.fields[1].onValues, ["1"]);
});

test("A-1 (round 7): the W1b output-byte bound holds on the final serialized fields (probe W1b shape)", async () => {
  // 100 persons + a 12,000-char on-value on the second unit
  // (person 0 only). The old code returned 1,208,191 serialized bytes
  // with no 422: the shared array gave all 100 fields the 12 KiB
  // value while only person 0 was ever charged for it. With owned
  // merge state the true total is small — only person 0 carries the
  // big value — so the inspect SUCCEEDS with a genuinely small
  // result; the bound is what the final JSON.stringify(result.fields)
  // size is asserted against. (The "must 422" reading of the probe
  // note does not follow from the required fix: owning the arrays
  // makes the output genuinely under the bound instead of inflating
  // it. The companion test below covers the genuinely-over-budget
  // case, which does 422.)
  const big = "X".repeat(12000);
  const persons = "<person><code>0</code></person>".repeat(100);
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      `<subform name="s"><bind match="dataRef" ref="$data.form.person"/>` +
      `<field name="code"><ui><checkButton/></ui><bind match="default"/><items><text>1</text><text>0</text></items></field></subform>` +
      `<subform name="s"><bind match="dataRef" ref="$data.form.person[0]"/>` +
      `<field name="code"><ui><checkButton/></ui><bind match="default"/><items><text>${big}</text><text>0</text></items></field></subform>` +
      "</subform></template>",
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>${persons}</form></xfa:data></xfa:datasets>`,
  });
  const result = await inspectPdf(bytes);
  assert.equal(result.fields.length, 100);
  const totalBytes = JSON.stringify(result.fields).length;
  assert.ok(totalBytes <= 1024 * 1024, `final serialized fields are ${totalBytes} bytes`);
  assert.ok(totalBytes > 12000, "the big on-value is present in the output");
  assert.deepEqual(result.fields[0].onValues, ["1", big]);
  for (let i = 1; i < 100; i++) assert.deepEqual(result.fields[i].onValues, ["1"], `person ${i}`);
});

test("A-1 (round 7): a genuinely over-budget output still fails closed", async () => {
  // The big on-value here sits on the ALL-persons unit, so all 100
  // fields genuinely carry 12 KiB: ~1.2 MB of serialized fields, past
  // the 1 MiB bound. The running accounting and the final exact check
  // must both fail closed on it. (Guard test: the old code 422s this
  // shape too via the running bound — the discriminator for the fix
  // is the W1b test above, where the old code returned >1 MiB.)
  const big = "X".repeat(12000);
  const persons = "<person><code>0</code></person>".repeat(100);
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      `<subform name="s"><bind match="dataRef" ref="$data.form.person"/>` +
      `<field name="code"><ui><checkButton/></ui><bind match="default"/><items><text>${big}</text><text>0</text></items></field></subform>` +
      `<subform name="s"><bind match="dataRef" ref="$data.form.person[0]"/>` +
      `<field name="code"><ui><checkButton/></ui><bind match="default"/><items><text>2</text><text>0</text></items></field></subform>` +
      "</subform></template>",
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>${persons}</form></xfa:data></xfa:datasets>`,
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /bytes of resolved fields/);
    return true;
  });
});

test("A-2 (round 7): same-identity collapse with conflicting options fails closed (probe W2 shape)", async () => {
  // Two fields named color, same SOM path, default binding, choiceList
  // with different items; dataset value Blue (only in the second
  // list). The old subgroup collapse took the first options with no
  // conflict check and reported value "Blue" with options
  // ["Red", "Green"] — the second list silently discarded.
  const bytes = await createXfaPdf(
    wrap(
      `<field name="color"><ui><choiceList/></ui><bind match="default"/><items><text>Red</text><text>Green</text></items></field>` +
        `<field name="color"><ui><choiceList/></ui><bind match="default"/><items><text>Red</text><text>Blue</text></items></field>`,
      "<color>Blue</color>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /conflicting options/);
    return true;
  });
});

test("A-2 (round 7): same-identity collapse with conflicting option ORDER fails closed (probe W2b shape)", async () => {
  // Same shape, but the two lists hold the same options in a
  // different order (Red/Green vs Green/Red): order is part of the
  // value domain, so silently taking the first list is still a
  // conflict, not a merge.
  const bytes = await createXfaPdf(
    wrap(
      `<field name="color"><ui><choiceList/></ui><bind match="default"/><items><text>Red</text><text>Green</text></items></field>` +
        `<field name="color"><ui><choiceList/></ui><bind match="default"/><items><text>Green</text><text>Red</text></items></field>`,
      "<color>Red</color>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /conflicting options/);
    return true;
  });
});

test("A-2 (round 7): identical options collapse, and labels keep first-occurrence-wins (controls)", async () => {
  // Guards against over-rejection from the new subgroup check: two
  // occurrences that AGREE on options collapse to one field, and two
  // occurrences with DIFFERENT captions keep the first caption —
  // the W-9 policy (its seven c1_1 boxes carry per-occurrence
  // captions and the collapsed field reports the first).
  const options = await createXfaPdf(
    wrap(
      `<field name="color"><ui><choiceList/></ui><bind match="default"/><items><text>Red</text><text>Green</text></items></field>` +
        `<field name="color"><ui><choiceList/></ui><bind match="default"/><items><text>Red</text><text>Green</text></items></field>`,
      "<color>Green</color>",
    ),
  );
  assert.deepEqual((await inspectPdf(options)).fields, [
    { name: "form.color", value: "Green", type: "unsupported", options: ["Red", "Green"] },
  ]);
  const labels = await createXfaPdf(
    wrap(
      `<field name="code"><ui><textEdit/></ui><bind match="default"/><caption><value><text>First caption</text></value></caption></field>` +
        `<field name="code"><ui><textEdit/></ui><bind match="default"/><caption><value><text>Second caption</text></value></caption></field>`,
      "<code>V</code>",
    ),
  );
  assert.deepEqual((await inspectPdf(labels)).fields, [
    { name: "form.code", value: "V", type: "text", label: "First caption" },
  ]);
});

test("A-3 (round 7): a caption descendant's xml:space=preserve survives normalization (probe W3a shape)", async () => {
  // The <value> carries preserve but the <caption> does not: the old
  // code flattened to "A\nB" and then normalized the whole label to
  // "A B" because the caption-level boolean was false.
  const bytes = await createXfaPdf(
    wrap(
      `<field name="note"><ui><textEdit/></ui><bind match="none"/>` +
        `<caption><value xml:space="preserve"><text>A\nB</text></value></caption></field>`,
      "<ok>V</ok>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note", value: "", type: "unsupported", label: "A\nB" },
  ]);
});

test("A-3 (round 7): an unnamed option field's own xml:space=preserve governs its items (probe W3b shape)", async () => {
  // The unnamed radio-option field carries preserve, but the old code
  // passed the GROUP's state to itemTexts(), never the field's own
  // effective state, so the newline was dropped ("AB").
  const bytes = await createXfaPdf(
    wrap(
      `<exclGroup name="pay"><bind match="none"/>` +
        `<field xml:space="preserve"><ui><radioButton/></ui><items><text><b>A</b>\n<b>B</b></text></items></field></exclGroup>`,
      "<ok>V</ok>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.pay", value: "", type: "unsupported", options: ["A\nB"] },
  ]);
  // Control: the same option field with xml:space="default" under a
  // preserving group resets to default ("AB"), proving the field's
  // own state — not just the group's — is what itemTexts() sees.
  const control = await createXfaPdf(
    wrap(
      `<exclGroup name="pay" xml:space="preserve"><bind match="none"/>` +
        `<field xml:space="default"><ui><radioButton/></ui><items><text><b>A</b>\n<b>B</b></text></items></field></exclGroup>`,
      "<ok>V</ok>",
    ),
  );
  assert.deepEqual((await inspectPdf(control)).fields, [
    { name: "form.pay", value: "", type: "unsupported", options: ["AB"] },
  ]);
});

test("A-3 (round 7): a caption mixes preserved and default subtrees (mixed normalization)", async () => {
  // One caption, two whitespace regimes: the plain <text> normalizes
  // ("X" plus its same-line space) while the preserved <b> keeps its
  // newline verbatim. A single boolean at the caption root cannot
  // express this; per-segment normalization can.
  const bytes = await createXfaPdf(
    wrap(
      `<field name="note"><ui><textEdit/></ui><bind match="none"/>` +
        `<caption><value><text>X</text> <b xml:space="preserve">A\nB</b></value></caption></field>`,
      "<ok>V</ok>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note", value: "", type: "unsupported", label: "X A\nB" },
  ]);
});

test("A-3 (round 7): xml:space=preserve directly on <xfa:datasets> reaches the walk (minor item b)", async () => {
  // The round-6 "datasets roots" test put preserve on <xfa:data>
  // only; preserve directly on <xfa:datasets> is threaded in code
  // (inspectXfa passes the datasets root's effective state into the
  // walk) but had no assertion. Same rich-text shape as the round-6
  // test, preserve one level higher.
  const preserved = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>' +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xml:space="preserve"><xfa:data>' +
      `<form><note><xhtml><body><p><b>A</b>\n<b>B</b></p></body></xhtml></note></form>` +
      "</xfa:data></xfa:datasets>",
  });
  assert.deepEqual((await inspectPdf(preserved)).fields, [
    { name: "form.note", value: "A\nB", type: "unsupported" },
  ]);
  // Control: a default on <xfa:data> below the preserving datasets
  // root resets the state back, so the same markup reports "AB".
  const reset = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>' +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xml:space="preserve"><xfa:data xml:space="default">' +
      `<form><note><xhtml><body><p><b>A</b>\n<b>B</b></p></body></xhtml></note></form>` +
      "</xfa:data></xfa:datasets>",
  });
  assert.deepEqual((await inspectPdf(reset)).fields, [
    { name: "form.note", value: "AB", type: "unsupported" },
  ]);
});

test("A-4 (round 7): duplicate resolution of a ~900 KiB field trips the cumulative work bound (probe W4 shape)", async () => {
  // 13 singleton ancestors + one ~900 KiB code leaf, 1,024 sibling
  // subforms each with a distinct [0]-variant dataRef, all resolving
  // to the same node. The old code re-serialized the ~900 KiB field
  // on every duplicate (~900 MiB cumulative, 3,297 ms) with no bound
  // tripping. The cumulative duplicate-work budget (64 MiB, charged
  // the retained field size per duplicate) now fails closed
  // deterministically — the trip is by byte counting, not by timing.
  // The 5 s bound is a gross-slowness guard only.
  const ancestors = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"];
  const big = "Y".repeat(900 * 1024);
  const n = 1024;
  let subforms = "";
  for (let i = 0; i < n; i++) {
    const ref = ancestors.map((name, pos) => ((i >> pos) & 1 ? `${name}[0]` : name)).join(".");
    subforms +=
      `<subform name="s"><bind match="dataRef" ref="$data.form.${ref}"/>` +
      `<field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>`;
  }
  const datasetPath =
    ancestors.map((name) => `<${name}>`).join("") +
    `<code>${big}</code>` +
    ancestors
      .map((name) => `</${name}>`)
      .reverse()
      .join("");
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      subforms +
      "</subform></template>",
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>${datasetPath}</form></xfa:data></xfa:datasets>`,
  });
  const started = Date.now();
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /cumulative duplicate-merge work/);
    return true;
  });
  assert.ok(Date.now() - started < 5000, `W4 inspect took ${Date.now() - started}ms`);
});

test("A-4 (round 7): a small duplicate count over the same ~900 KiB field still resolves", async () => {
  // Guard against an over-aggressive work bound: 32 duplicates charge
  // ~29 MiB against the 64 MiB budget, so the inspect succeeds with
  // the one field and its full value — the bound trips only on
  // amplification-scale duplication, not on ordinary repeats.
  const ancestors = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"];
  const big = "Y".repeat(900 * 1024);
  const n = 32;
  let subforms = "";
  for (let i = 0; i < n; i++) {
    const ref = ancestors.map((name, pos) => ((i >> pos) & 1 ? `${name}[0]` : name)).join(".");
    subforms +=
      `<subform name="s"><bind match="dataRef" ref="$data.form.${ref}"/>` +
      `<field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>`;
  }
  const datasetPath =
    ancestors.map((name) => `<${name}>`).join("") +
    `<code>${big}</code>` +
    ancestors
      .map((name) => `</${name}>`)
      .reverse()
      .join("");
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      subforms +
      "</subform></template>",
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>${datasetPath}</form></xfa:data></xfa:datasets>`,
  });
  const result = await inspectPdf(bytes);
  assert.equal(result.fields.length, 1);
  assert.equal(result.fields[0].value.length, 900 * 1024);
  assert.equal(result.fields[0].value, big);
});

test("A-4 (round 7): duplicate merges resolve to MULTIPLE leaves with independent on-values (multi-leaf)", async () => {
  // Test-adequacy requirement (round 6 adjudication): the round-6
  // merge tests all resolved to a SINGLE dataset leaf, which hid the
  // shared-array defect. Here overlapping units resolve to TWO
  // leaves, and each leaf's field merges its own on-values: person 0
  // gets ["1", "2"], person 1 gets ["1", "3"] — never each other's.
  const sub = (ref: string, on: string) =>
    `<subform name="s"><bind match="dataRef" ref="${ref}"/>` +
    `<field name="code"><ui><checkButton/></ui><bind match="default"/>` +
    `<items><text>${on}</text><text>0</text></items></field></subform>`;
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      sub("$data.form.person", "1") +
      sub("$data.form.person[0]", "2") +
      sub("$data.form.person[1]", "3") +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><person><code>0</code></person><person><code>0</code></person></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.person[0].code", value: "0", type: "checkbox", onValues: ["1", "2"] },
    { name: "form.person[1].code", value: "0", type: "checkbox", onValues: ["1", "3"] },
  ]);
});

test("A-4 (round 7): duplicate merges accumulate on-values incrementally up to the bound, then fail closed", async () => {
  // Each duplicate adds one distinct ~100 KiB on-value to the same
  // field. Nine additions (~920 KiB of merged on-values) succeed with
  // the exact union — proving the incremental byte accounting does
  // not over-charge and trip early — while twelve additions push the
  // merged on-values past 1 MiB and fail closed on the T-4 bound
  // (deterministic byte counting; the duplicate-work budget, which
  // would trip only around 35 such duplicates, is not what trips).
  const bigValue = (i: number) => String.fromCharCode(65 + i) + "X".repeat(102400 - 1);
  const subforms = (count: number): string => {
    let out =
      `<subform name="s"><bind match="dataRef" ref="$data.form.person"/>` +
      `<field name="code"><ui><checkButton/></ui><bind match="default"/>` +
      `<items><text>1</text><text>0</text></items></field></subform>`;
    for (let i = 0; i < count; i++) {
      out +=
        `<subform name="s"><bind match="dataRef" ref="$data.form.person[0]"/>` +
        `<field name="code"><ui><checkButton/></ui><bind match="default"/>` +
        `<items><text>${bigValue(i)}</text><text>0</text></items></field></subform>`;
    }
    return out;
  };
  const build = (count: number) =>
    createXfaPdf({
      templateXml:
        '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
        subforms(count) +
        "</subform></template>",
      datasetsXml:
        '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><person><code>0</code></person></form></xfa:data></xfa:datasets>',
    });
  const ok = await inspectPdf(await build(9));
  assert.deepEqual(ok.fields, [
    {
      name: "form.person.code",
      value: "0",
      type: "checkbox",
      onValues: ["1", ...Array.from({ length: 9 }, (_, i) => bigValue(i))],
    },
  ]);
  await assert.rejects(inspectPdf(await build(12)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /bytes of checkbox on-values/);
    return true;
  });
});

// --- B1 fix round 8 (panel re-review #7, Nov 19, 2026) ----------------------
// Regression tests for the adopted P1s (A-1 dataset classification, A-2
// NUL / illegal XML 1.0 characters) and the round-7 test-adequacy gap
// (distinct-scope resolved-node accumulation). Probe shapes are noted
// per test (panel/probe-rereview7.mts). The B-1 cleanup-hardening mock
// tests live in tests/store.test.ts.

test("A-1 (round 8): X1 data group with an exData child fails closed, no fabricated leaf", async () => {
  // Astra's construction: <note> is explicitly a data group with two
  // ordinary data children. The old code flattened both into one leaf
  // form.note = "FIRSTSECOND". Now the group has no scalar value, so
  // a field bound to it has no data node and fails closed.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      '<note xfa:dataNode="dataGroup"><exData>FIRST</exData><other>SECOND</other></note>',
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
});

test("A-1 (round 8): X2 children named exData stay independently addressable", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<field name="exData"><ui><textEdit/></ui><bind match="default"/></field>' +
        '<field name="other"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<note><exData>FIRST</exData><other>SECOND</other></note>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.exData", value: "FIRST", type: "text" },
    { name: "form.note.other", value: "SECOND", type: "text" },
  ]);
});

test("A-1 (round 8): X3 xhtml mixed with an ordinary sibling fails closed, no concatenation", async () => {
  // The old code reported form.note = "ASECOND": the sibling was
  // concatenated into the rich-text value. Now the mixture is not a
  // rich-text leaf, so a field bound to the parent has no data node.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      "<note><xhtml><body><p><b>A</b></p></body></xhtml><other>SECOND</other></note>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
});

test("A-1 (round 8): X3 mixed shape keeps each child addressable", async () => {
  // The same mixture, addressed child by child: the ordinary sibling
  // resolves on its own, and the rich text is reachable through its
  // own path — nothing is concatenated into anything else. (The
  // rich-text leaf sits at ...p.b, under the <b> inside the <p>.)
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<field name="other"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<field name="b"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.xhtml.body.p.b"/></field>',
      "<note><xhtml><body><p><b>A</b></p></body></xhtml><other>SECOND</other></note>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.other", value: "SECOND", type: "text" },
    { name: "form.note.xhtml.body.p.b", value: "A", type: "text" },
  ]);
});

test("A-1 (round 8): X4 legitimate single exData wrapping xhtml stays a rich-text leaf", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      '<note><exData contentType="text/html"><xhtml><body><p><b>A</b></p></body></xhtml></exData></note>',
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "A", type: "unsupported" }]);
});

test("A-1 (round 8): a lone text-only exData child is ordinary data, not rich text", async () => {
  // A single <exData> with text content (no <xhtml> inside) is not a
  // supported rich-text container: it stays an addressable data
  // element, and its parent is not a leaf.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<field name="exData"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      "<note><exData>FIRST</exData></note>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note.exData", value: "FIRST", type: "text" }]);
  const parentBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      "<note><exData>FIRST</exData></note>",
    ),
  );
  await assert.rejects(inspectPdf(parentBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
});

test("A-1 (round 8): a lone xhtml child holding data children is ordinary data", async () => {
  // <xhtml> whose children are data elements, not an XHTML document
  // skeleton (<html>/<head>/<body>), is an ordinary dataset element:
  // its children stay addressable.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<subform name="xhtml"><bind match="default"/>' +
        '<field name="item"><ui><textEdit/></ui><bind match="default"/></field></subform></subform>',
      "<note><xhtml><item>1</item></xhtml></note>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note.xhtml.item", value: "1", type: "text" }]);
});

test("A-1 (round 8): direct text beside a rich-text container is not flattened into the value", async () => {
  // The parent's own direct text must not leak into the rich-text
  // value: with real text beside the container the parent is not a
  // rich-text leaf at all.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      "<note>LEAK<xhtml><body><p>A</p></body></xhtml></note>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
});

test("A-1 (round 8): an explicit dataGroup is never a rich-text leaf", async () => {
  // Even a single supported rich-text child does not make an
  // explicitly declared data group a leaf: the dataset's own
  // declaration wins, and the child stays addressable.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<field name="exData"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      '<note xfa:dataNode="dataGroup"><exData contentType="text/html"><xhtml><body><p><b>A</b></p></body></xhtml></exData></note>',
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note.exData", value: "A", type: "unsupported" }]);
  const parentBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      '<note xfa:dataNode="dataGroup"><exData contentType="text/html"><xhtml><body><p><b>A</b></p></body></xhtml></exData></note>',
    ),
  );
  await assert.rejects(inspectPdf(parentBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
});

test("A-2 (round 8): a literal NUL in a dataset value fails closed", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      "<note>A\u0000B</note>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /U\+0000.*not valid in XML 1\.0/);
    return true;
  });
});

test("A-2 (round 8): a literal NUL in a template caption fails closed (X5a shape)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="none"/>' +
        '<caption><value><text>X</text></value><value xml:space="preserve"><text>A\u0000B</text></value></caption></field>',
      "<ok>V</ok>",
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /U\+0000.*not valid in XML 1\.0/);
    return true;
  });
});

test("A-2 (round 8): numeric references to NUL fail closed in datasets and template", async () => {
  // &#0; / &#x0; arrive as literal strings from this parser, not as
  // NUL — but a conformant parser decodes them to NUL and rejects
  // the document, so the packet must not be accepted either way.
  for (const ref of ["&#0;", "&#x0;"]) {
    const datasetBytes = await createXfaPdf(
      wrap(
        '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
        `<note>A${ref}B</note>`,
      ),
    );
    await assert.rejects(inspectPdf(datasetBytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(
        error.message,
        new RegExp(
          `character reference '${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}' naming U\\+0000`,
        ),
      );
      return true;
    });
    const templateBytes = await createXfaPdf(
      wrap(
        '<field name="note"><ui><textEdit/></ui><bind match="none"/>' +
          `<caption><value><text>A${ref}B</text></value></caption></field>`,
        "<ok>V</ok>",
      ),
    );
    await assert.rejects(inspectPdf(templateBytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /naming U\+0000/);
      return true;
    });
  }
});

test("A-2 (round 8): the X5c collision shape fails closed, the X5d control keeps its true label", async () => {
  // X5c: a default caption segment containing a literal "\u00000\u0000"
  // run plus a real preserved segment "KEEP\nME" — pre-fix the real
  // NULs were treated as placeholder index 0 and the label came out
  // "PKEEP\nMEQKEEP\nME". Post-fix the packet 422s on the NUL.
  const collisionBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="none"/>' +
        '<caption><value><text>P\u00000\u0000Q</text><text xml:space="preserve">KEEP\nME</text></value></caption></field>',
      "<ok>V</ok>",
    ),
  );
  await assert.rejects(inspectPdf(collisionBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /U\+0000.*not valid in XML 1\.0/);
    return true;
  });
  // X5d control: the same caption without NULs reports its true label.
  const controlBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="none"/>' +
        '<caption><value><text>P Q</text><text xml:space="preserve">KEEP\nME</text></value></caption></field>',
      "<ok>V</ok>",
    ),
  );
  const result = await inspectPdf(controlBytes);
  assert.deepEqual(result.fields, [
    { name: "form.note", value: "", type: "unsupported", label: "P QKEEP\nME" },
  ]);
});

test("A-2 (round 8): other illegal XML 1.0 characters and references fail closed", async () => {
  // Literal C0 controls (other than tab/LF/CR), U+FFFE, and numeric
  // references naming a surrogate, U+FFFE, or a code point above
  // U+10FFFF are all illegal in XML 1.0.
  for (const bad of ["\u0001", "\u000b", "\u000c", "\u001f", "\uFFFE"]) {
    const bytes = await createXfaPdf(
      wrap(
        '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
        `<note>A${bad}B</note>`,
      ),
    );
    await assert.rejects(inspectPdf(bytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /not valid in XML 1\.0/);
      return true;
    });
  }
  for (const ref of ["&#xD800;", "&#xFFFE;", "&#x110000;", "&#11;", "&#12;"]) {
    const bytes = await createXfaPdf(
      wrap(
        '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
        `<note>A${ref}B</note>`,
      ),
    );
    await assert.rejects(inspectPdf(bytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /not valid in XML 1\.0/);
      return true;
    });
  }
});

test("A-2 (round 8): legal characters and references still pass (no over-rejection)", async () => {
  // Guard the other way: tab and newline are legal XML 1.0
  // characters, &amp; decodes, and numeric references are legal and
  // pass through (this parser leaves &#65; literal rather than
  // decoding it — only named entities decode — so the value carries
  // it verbatim). "&#0;" is literal text — not a character reference
  // — inside CDATA and comments, so it must not be rejected there.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>' +
        '<field name="tab"><ui><textEdit/></ui><bind match="global"/></field>' +
        '<field name="ref"><ui><textEdit/></ui><bind match="global"/></field>' +
        '<field name="cdata"><ui><textEdit/></ui><bind match="global"/></field>',
      "<note>A\nB</note><tab>A\tB</tab><ref>A&#65;B&amp;C</ref><cdata><![CDATA[A&#0;B]]></cdata>",
    ),
  );
  // A comment carrying "&#0;" must not trip the reference scan either.
  const commentBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      "<!-- &#0; --><note>V</note>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note", value: "A\nB", type: "text" },
    { name: "form.tab", value: "A\tB", type: "text" },
    { name: "form.ref", value: "A&#65;B&C", type: "text" },
    { name: "form.cdata", value: "A&#0;B", type: "text" },
  ]);
  const commentResult = await inspectPdf(commentBytes);
  assert.deepEqual(commentResult.fields, [{ name: "form.note", value: "V", type: "text" }]);
});

// --- Test adequacy (round 8): distinct-scope resolved-node merges -----
// The round-7 incremental-accumulation test (tests/xfa.test.ts:2593)
// used ONE scope identity ($data.form.person[0]) for every addition,
// so all additions collapsed into ONE subgroup before resolution — it
// exercised one resolved-node merge, not the claimed sequence. These
// tests use the ancestor-bit construction from the W4 test: each
// subform carries a DISTINCT dataRef scope identity, and every scope
// resolves to the SAME dataset leaf, so each addition is a genuine
// resolved-node merge in push()/mergeDuplicate().

const ACCUM_ANCESTORS = ["a", "b", "c", "d"];
const accumDataset = "<a><b><c><d><code>0</code></d></c></b></a>";

/** Distinct dataRef scope identities over the ancestors (bit patterns). */
function accumRefs(count: number): string[] {
  const refs: string[] = [];
  for (let i = 0; i < count; i++) {
    refs.push(ACCUM_ANCESTORS.map((name, pos) => ((i >> pos) & 1 ? `${name}[0]` : name)).join("."));
  }
  return refs;
}

const accumCheckboxSubform = (ref: string, on: string, caption?: string) =>
  `<subform name="s"><bind match="dataRef" ref="$data.form.${ref}"/>` +
  `<field name="code"><ui><checkButton/></ui><bind match="default"/>` +
  `<items><text>${on}</text><text>0</text></items>` +
  (caption !== undefined ? `<caption><value><text>${caption}</text></value></caption>` : "") +
  `</field></subform>`;

test("Test adequacy (round 8): DISTINCT scopes accumulate on-values through resolved-node merges", async () => {
  // Nine DISTINCT scope identities, each contributing a different
  // ~100 KiB on-value to the same leaf: nine genuine resolved-node
  // merges succeed with the exact union (~920 KiB, under T-4).
  // Twelve additions push the merged on-values past 1 MiB and fail
  // closed on the T-4 bound — the duplicate-work budget (~7 MiB
  // charged at that point) is not what trips.
  const bigValue = (i: number) => String.fromCharCode(65 + i) + "X".repeat(102400 - 1);
  const build = (count: number) => {
    const refs = accumRefs(count + 1);
    let subforms = accumCheckboxSubform(refs[0], "1");
    for (let i = 1; i <= count; i++) subforms += accumCheckboxSubform(refs[i], bigValue(i - 1));
    return createXfaPdf({
      templateXml:
        '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
        subforms +
        "</subform></template>",
      datasetsXml:
        '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>' +
        accumDataset +
        "</form></xfa:data></xfa:datasets>",
    });
  };
  const ok = await inspectPdf(await build(9));
  assert.deepEqual(ok.fields, [
    {
      name: "form.a.b.c.d.code",
      value: "0",
      type: "checkbox",
      onValues: ["1", ...Array.from({ length: 9 }, (_, i) => bigValue(i))],
    },
  ]);
  await assert.rejects(inspectPdf(await build(12)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /bytes of checkbox on-values/);
    return true;
  });
});

test("Test adequacy (round 8): escaping on-values are charged exactly near the output boundary", async () => {
  // Each value is ~100 KiB of double-quote characters: the T-4 charge
  // (utf8Length + 2) counts ~102 KiB per value, but the true JSON
  // literal is ~205 KiB per value (every quote escapes). Four values
  // succeed (true size ~820 KiB, under 1 MiB); nine values must still
  // fail closed — on the EXACT output bound ("bytes of resolved
  // fields"), not on T-4, which never trips here.
  const escValue = (i: number) => String.fromCharCode(65 + i) + '"'.repeat(102400 - 1);
  const build = (count: number) => {
    const refs = accumRefs(count + 1);
    let subforms = accumCheckboxSubform(refs[0], "1");
    for (let i = 1; i <= count; i++) subforms += accumCheckboxSubform(refs[i], escValue(i - 1));
    return createXfaPdf({
      templateXml:
        '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
        subforms +
        "</subform></template>",
      datasetsXml:
        '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>' +
        accumDataset +
        "</form></xfa:data></xfa:datasets>",
    });
  };
  const ok = await inspectPdf(await build(4));
  assert.deepEqual(ok.fields, [
    {
      name: "form.a.b.c.d.code",
      value: "0",
      type: "checkbox",
      onValues: ["1", ...Array.from({ length: 4 }, (_, i) => escValue(i))],
    },
  ]);
  await assert.rejects(inspectPdf(await build(9)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /bytes of resolved fields/);
    assert.doesNotMatch(error.message, /bytes of checkbox on-values/);
    return true;
  });
});

test("Test adequacy (round 8): non-ASCII on-values accumulate by UTF-8 bytes, not characters", async () => {
  // Eight values of 51,200 "é" (2 bytes each = 102,400 bytes) plus one
  // value of 25,600 "😀" (4 bytes each = 102,400 bytes): nine DISTINCT
  // scope identities, each contributing exactly 102,400 charged
  // bytes — the same arithmetic as the ASCII case, proving the byte
  // accounting measures bytes, so a character count would have
  // under-charged by 2×–4×.
  const values = [
    ...Array.from({ length: 8 }, (_, i) => String.fromCharCode(0xe9 + i) + "é".repeat(51200 - 1)),
    "😀".repeat(25600),
  ];
  const refs = accumRefs(values.length + 1);
  let subforms = accumCheckboxSubform(refs[0], "1");
  values.forEach((value, i) => {
    subforms += accumCheckboxSubform(refs[i + 1], value);
  });
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      subforms +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>' +
      accumDataset +
      "</form></xfa:data></xfa:datasets>",
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    {
      name: "form.a.b.c.d.code",
      value: "0",
      type: "checkbox",
      onValues: ["1", ...values],
    },
  ]);
});

test("Test adequacy (round 8): label introduction near the exact output boundary", async () => {
  // Ten DISTINCT scopes contribute ~100 KiB on-values each to the
  // same leaf (~1,024 KiB total, ~24 KiB under the 1 MiB output
  // bound); an eleventh DISTINCT scope contributes no new on-value
  // ("1", already seen) but INTRODUCES a label. The label length is
  // calibrated in-test from the exact serialized field, so the
  // under-case lands exactly 50 bytes below the bound and the
  // over-case exactly 50 bytes above it.
  const bigValue = (i: number) => String.fromCharCode(65 + i) + "X".repeat(102400 - 1);
  const onValues = ["1", ...Array.from({ length: 10 }, (_, i) => bigValue(i))];
  const fieldName = "form.a.b.c.d.code";
  const noLabel = { name: fieldName, value: "0", type: "checkbox", onValues };
  const baseLen = JSON.stringify(noLabel).length;
  // Field JSON with a label of length L: baseLen + 1 + 8 + (L + 2);
  // the serialized array adds 2 more. MAX = 1,048,576.
  const labelLenUnder = 1024 * 1024 - 50 - 13 - baseLen;
  const labelLenOver = 1024 * 1024 + 50 - 13 - baseLen;
  assert.ok(labelLenUnder > 0, `label calibration went negative: ${labelLenUnder}`);
  const build = (labelLen: number) => {
    const refs = accumRefs(12);
    let subforms = accumCheckboxSubform(refs[0], "1");
    for (let i = 1; i <= 10; i++) subforms += accumCheckboxSubform(refs[i], bigValue(i - 1));
    subforms += accumCheckboxSubform(refs[11], "1", "L".repeat(labelLen));
    return createXfaPdf({
      templateXml:
        '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
        subforms +
        "</subform></template>",
      datasetsXml:
        '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>' +
        accumDataset +
        "</form></xfa:data></xfa:datasets>",
    });
  };
  const under = await inspectPdf(await build(labelLenUnder));
  assert.deepEqual(under.fields, [{ ...noLabel, label: "L".repeat(labelLenUnder) }]);
  assert.equal(JSON.stringify(under.fields).length, 1024 * 1024 - 50);
  await assert.rejects(inspectPdf(await build(labelLenOver)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /bytes of resolved fields/);
    return true;
  });
});

test("Test adequacy (round 8): options introduction near the exact output boundary", async () => {
  // A choiceList field whose first DISTINCT scope carries no <items>
  // (no options) and whose second DISTINCT scope introduces an
  // options array. The options size is calibrated in-test from the
  // exact serialized field, so the under-case lands exactly 50 bytes
  // below the 1 MiB output bound and the over-case exactly 50 bytes
  // above it — proving the introduction delta is charged exactly.
  const fieldName = "form.a.b.c.d.code";
  const noOptions = { name: fieldName, value: "0", type: "unsupported" };
  const baseLen = JSON.stringify(noOptions).length;
  // Field JSON with options: baseLen + 1 + 10 + JSON(options); the
  // serialized array adds 2 more. MAX = 1,048,576.
  const optionsJsonTarget = (total: number) => total - 13 - baseLen;
  const buildOptions = (jsonLen: number): string[] => {
    // Nine fixed ~100 KiB options plus one calibrated option that
    // brings the options JSON to exactly jsonLen.
    const fixed = Array.from(
      { length: 9 },
      (_, i) => String.fromCharCode(65 + i) + "X".repeat(102400 - 1),
    );
    const fixedJsonLen = JSON.stringify(fixed).length;
    // Options JSON: "[" + items joined by "," + "]"; appending one
    // more item of length L costs 1 (comma) + (L + 2) (quoted).
    const lastLen = jsonLen - fixedJsonLen - 3;
    assert.ok(lastLen > 0, `options calibration went negative: ${lastLen}`);
    return [...fixed, "J".repeat(lastLen)];
  };
  const build = (jsonLen: number) => {
    const refs = accumRefs(2);
    const choiceSubform = (ref: string, items?: string[]) =>
      `<subform name="s"><bind match="dataRef" ref="$data.form.${ref}"/>` +
      `<field name="code"><ui><choiceList/></ui><bind match="default"/>` +
      (items !== undefined
        ? `<items>${items.map((text) => `<text>${text}</text>`).join("")}</items>`
        : "") +
      `</field></subform>`;
    const subforms = choiceSubform(refs[0]) + choiceSubform(refs[1], buildOptions(jsonLen));
    return createXfaPdf({
      templateXml:
        '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
        subforms +
        "</subform></template>",
      datasetsXml:
        '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>' +
        accumDataset +
        "</form></xfa:data></xfa:datasets>",
    });
  };
  const underOptions = buildOptions(optionsJsonTarget(1024 * 1024 - 50));
  const under = await inspectPdf(await build(optionsJsonTarget(1024 * 1024 - 50)));
  assert.deepEqual(under.fields, [{ ...noOptions, options: underOptions }]);
  assert.equal(JSON.stringify(under.fields).length, 1024 * 1024 - 50);
  await assert.rejects(
    inspectPdf(await build(optionsJsonTarget(1024 * 1024 + 50))),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /bytes of resolved fields/);
      return true;
    },
  );
});
