import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSamplePdf, fillPdf, inspectPdf } from "../packages/integrations/src/pdf.ts";
import {
  countXmlScanSteps,
  lookupKeyMissCount,
  pooledLeafCount,
  segmentArrayCount,
} from "../packages/integrations/src/xfa.ts";
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
  // characters, &amp; decodes, and numeric references DECODE to
  // their characters (round 9, A-2: &#65; is "A", so the value is
  // "AAB&C" — the round-8 version of this test pinned the wrong
  // literal value "A&#65;B&C"). "&#0;" is literal text — not a
  // character reference — inside CDATA and comments, so it must not
  // be rejected there.
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
    { name: "form.ref", value: "AAB&C", type: "text" },
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

// --- B1 fix round 9 (panel re-review #8, Nov 19, 2026) ---------------------
// Regression tests for the adopted chunk-A findings (A-1..A-4), the
// test-adequacy items, and the probe shapes in panel/probe-rereview8.mts.

test("A-1 (round 9): a dataGroup-marked xhtml child never classifies as rich text (Y1)", async () => {
  // Astra's counterexample verbatim: the <xhtml> child is explicitly
  // xfa:dataNode="dataGroup" and company-namespaced. The round-8
  // classifier read only the PARENT's marking and fabricated
  // form.note = "FIRSTSECOND". Now the container child's own
  // declarations defeat the classification: the parent has no data
  // node, and the children stay addressable.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml xmlns="urn:company:data" xfa:dataNode="dataGroup"><body>FIRST</body><head>SECOND</head></xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  const childBytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<subform name="xhtml"><bind match="default"/>' +
        '<field name="body"><ui><textEdit/></ui><bind match="default"/></field>' +
        '<field name="head"><ui><textEdit/></ui><bind match="default"/></field></subform></subform>',
      `<note><xhtml xmlns="urn:company:data" xfa:dataNode="dataGroup"><body>FIRST</body><head>SECOND</head></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(childBytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.xhtml.body", value: "FIRST", type: "text" },
    { name: "form.note.xhtml.head", value: "SECOND", type: "text" },
  ]);
});

test("A-1 (round 9): an empty dataGroup element is not a scalar leaf (Y2)", async () => {
  // Group classification runs before the empty-leaf branch: an empty
  // element the dataset marks a data group is a group with no
  // members, not a scalar leaf with value "".
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note xfa:dataNode="dataGroup"/>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  // Control (Y2b): an ordinary empty element with no dataGroup
  // marking is still a scalar leaf with value "".
  const controlBytes = await createXfaPdf(
    wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', `<note/>`),
  );
  const control = await inspectPdf(controlBytes);
  assert.deepEqual(control.fields, [{ name: "form.note", value: "", type: "text" }]);
});

test("A-1 (round 9): XHTML-namespaced legitimate rich text stays rich text", async () => {
  // What legitimate rich text carries: either no namespace
  // declaration (the round-8 X4 shape) or the XHTML namespace.
  // Both stay a rich-text leaf with value "A".
  for (const datasets of [
    '<note><exData contentType="text/html"><xhtml xmlns="http://www.w3.org/1999/xhtml"><body><p><b>A</b></p></body></xhtml></exData></note>',
    '<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><body><p><b>A</b></p></body></xhtml></note>',
  ]) {
    const bytes = await createXfaPdf(
      wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
    );
    const result = await inspectPdf(bytes);
    assert.deepEqual(result.fields, [{ name: "form.note", value: "A", type: "unsupported" }]);
  }
});

test("A-1 (round 9): a company-namespaced container is ordinary data", async () => {
  // Same skeleton shape as Y1 but WITHOUT the dataGroup marking: the
  // non-XHTML namespace alone defeats rich-text classification, and
  // the children stay addressable. Both positions are covered: the
  // namespace on the <xhtml> itself, and the namespace on the
  // <exData> wrapper — the wrapper's declaration governs its whole
  // content, so recursing past it must not let its bare <xhtml>
  // child classify the wrapper as a leaf anyway.
  const datasetsList = [
    `<note><xhtml xmlns="urn:company:data"><body>FIRST</body><head>SECOND</head></xhtml></note>`,
    `<note><exData xmlns="urn:company:data"><xhtml><body>FIRST</body><head>SECOND</head></xhtml></exData></note>`,
  ];
  for (const datasets of datasetsList) {
    const bytes = await createXfaPdf(
      wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
    );
    await assert.rejects(inspectPdf(bytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /has no data node/);
      return true;
    });
  }
  const datasets = datasetsList[0];
  const childBytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<subform name="xhtml"><bind match="default"/>' +
        '<field name="body"><ui><textEdit/></ui><bind match="default"/></field>' +
        '<field name="head"><ui><textEdit/></ui><bind match="default"/></field></subform></subform>',
      datasets,
    ),
  );
  const result = await inspectPdf(childBytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.xhtml.body", value: "FIRST", type: "text" },
    { name: "form.note.xhtml.head", value: "SECOND", type: "text" },
  ]);
  // Wrapper-declared namespace: the children stay addressable
  // through the wrapper too.
  const wrapperChildBytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<subform name="exData"><bind match="default"/>' +
        '<subform name="xhtml"><bind match="default"/>' +
        '<field name="body"><ui><textEdit/></ui><bind match="default"/></field>' +
        '<field name="head"><ui><textEdit/></ui><bind match="default"/></field></subform></subform></subform>',
      datasetsList[1],
    ),
  );
  const wrapperResult = await inspectPdf(wrapperChildBytes);
  assert.deepEqual(wrapperResult.fields, [
    { name: "form.note.exData.xhtml.body", value: "FIRST", type: "text" },
    { name: "form.note.exData.xhtml.head", value: "SECOND", type: "text" },
  ]);
});

test("A-1 (round 9): contentType text/plain wrapping an xhtml skeleton is ordinary data", async () => {
  // Rule (stated, probed either way — the classifier takes the
  // plain-text declaration at its word): contentType is supporting
  // evidence only, but a declared non-HTML content type contradicts
  // an HTML skeleton, so it defeats rich-text classification. The
  // children stay addressable; the parent has no data node.
  const datasets =
    '<note><exData contentType="text/plain"><xhtml><body>FIRST</body><head>SECOND</head></xhtml></exData></note>';
  const bytes = await createXfaPdf(
    wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  const childBytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<subform name="exData"><bind match="default"/>' +
        '<subform name="xhtml"><bind match="default"/>' +
        '<field name="body"><ui><textEdit/></ui><bind match="default"/></field>' +
        '<field name="head"><ui><textEdit/></ui><bind match="default"/></field></subform></subform></subform>',
      datasets,
    ),
  );
  const result = await inspectPdf(childBytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.exData.xhtml.body", value: "FIRST", type: "text" },
    { name: "form.note.exData.xhtml.head", value: "SECOND", type: "text" },
  ]);
});

test("A-1 (round 9): dataGroup on the container itself defeats rich text (child vs parent)", async () => {
  // dataGroup on the <exData> wrapper child (not the parent): the
  // wrapper is a data group, not a rich-text container — so neither
  // the parent nor the wrapper is a leaf. The wrapper's <xhtml>
  // child is ordinary data too, and the text stays addressable at
  // its own deep path.
  const datasets =
    '<note><exData xfa:dataNode="dataGroup" contentType="text/html"><xhtml><body><p><b>A</b></p></body></xhtml></exData></note>';
  const bytes = await createXfaPdf(
    wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  const wrapperBytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<field name="exData"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      datasets,
    ),
  );
  await assert.rejects(inspectPdf(wrapperBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  const deepBytes = await createXfaPdf(
    wrap(
      '<field name="b"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.exData.xhtml.body.p.b"/></field>',
      datasets,
    ),
  );
  const result = await inspectPdf(deepBytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.exData.xhtml.body.p.b", value: "A", type: "text" },
  ]);
  // dataGroup on the INNER <xhtml> inside an <exData>: the wrapper
  // is not a container either, and the inner <xhtml> is not one —
  // so body/head stay addressable as ordinary data.
  const innerDatasets =
    '<note><exData contentType="text/html"><xhtml xfa:dataNode="dataGroup"><body>FIRST</body><head>SECOND</head></xhtml></exData></note>';
  const innerBytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<subform name="exData"><bind match="default"/>' +
        '<subform name="xhtml"><bind match="default"/>' +
        '<field name="body"><ui><textEdit/></ui><bind match="default"/></field>' +
        '<field name="head"><ui><textEdit/></ui><bind match="default"/></field></subform></subform></subform>',
      innerDatasets,
    ),
  );
  const innerResult = await inspectPdf(innerBytes);
  assert.deepEqual(innerResult.fields, [
    { name: "form.note.exData.xhtml.body", value: "FIRST", type: "text" },
    { name: "form.note.exData.xhtml.head", value: "SECOND", type: "text" },
  ]);
});

test("A-2 (round 9): numeric character references decode — hex, leading zeros, escaped spellings, CDATA (Y3)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>' +
        '<field name="hex"><ui><textEdit/></ui><bind match="global"/></field>' +
        '<field name="escaped"><ui><textEdit/></ui><bind match="global"/></field>' +
        '<field name="cdata"><ui><textEdit/></ui><bind match="global"/></field>' +
        '<field name="markup"><ui><textEdit/></ui><bind match="global"/></field>',
      "<note>A&#65;B&amp;C</note>" +
        "<hex>A&#x42;B&#00065;C</hex>" +
        "<escaped>A&#65;B&amp;#65;C</escaped>" +
        "<cdata><![CDATA[&#65;]]></cdata>" +
        "<markup>A&#60;B&#38;C</markup>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    // Y3: the XML value is "AAB&C", not the literal spelling.
    { name: "form.note", value: "AAB&C", type: "text" },
    // Hex and leading-zero decimal references decode too.
    { name: "form.hex", value: "ABBAC", type: "text" },
    // "&amp;#65;" is an escaped literal spelling, not a reference:
    // it stays literal "&#65;" while the real reference decodes.
    { name: "form.escaped", value: "AAB&#65;C", type: "text" },
    // CDATA holds characters, not references: its text stays literal.
    { name: "form.cdata", value: "&#65;", type: "text" },
    // Decoded "<" and "&" become the characters, never markup: the
    // value is "A<B&C", not a broken document.
    { name: "form.markup", value: "A<B&C", type: "text" },
  ]);
});

test("A-2 (round 9): numeric character references decode in attribute values", async () => {
  // A dataRef whose segment spells "note" via &#111; ("o") resolves
  // only if the attribute value is decoded before parsing — the raw
  // spelling is not a valid ref segment. Likewise a field name
  // spelled with a reference decodes to its name.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.n&#111;te"/></field>' +
        '<field name="n&#111;te2"><ui><textEdit/></ui><bind match="default"/></field>',
      "<note>V</note><note2>W</note2>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note", value: "V", type: "text" },
    { name: "form.note2", value: "W", type: "text" },
  ]);
});

test("A-3 (round 9): the single-pass scanner is linear on the repeated-opener shape (Y4)", async () => {
  // Deterministic work counter, never a wall-clock threshold: the
  // round-8 regex strips scanned the remaining suffix from every
  // candidate opener (n=2000 → 11 ms, n=8000 → 125 ms, ~11–14x for
  // 4x input). A single forward scan is linear in the input (4x
  // input → ~4x steps), and the step count is a linear-work PROXY
  // (round 10 precision correction), not literally a count of every
  // examined character — delimiter lookahead and the characters
  // inside a matched delimiter are not individually charged. The
  // "&#0;" sits inside the comment, where it is literal text — the
  // scan must not throw on this shape.
  const scanDatasets = (n: number) =>
    `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><!-- &#0; ${"<![CDATA[".repeat(n)} --><note>V</note></form></xfa:data></xfa:datasets>`;
  const text2000 = scanDatasets(2000);
  const text8000 = scanDatasets(8000);
  const steps2000 = countXmlScanSteps(text2000);
  const steps8000 = countXmlScanSteps(text8000);
  assert.ok(
    steps2000 <= 2 * text2000.length,
    `steps(2000)=${steps2000} over ${text2000.length} chars`,
  );
  assert.ok(
    steps8000 <= 2 * text8000.length,
    `steps(8000)=${steps8000} over ${text8000.length} chars`,
  );
  assert.ok(
    steps8000 < 6 * steps2000,
    `steps must scale linearly: steps(8000)=${steps8000}, steps(2000)=${steps2000}`,
  );
  // The same shape still inspects: the comment is literal, the note
  // is real data.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      `<!-- &#0; ${"<![CDATA[".repeat(2000)} --><note>V</note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "V", type: "text" }]);
});

test("A-4 (round 9): the scanner is context-correct — comment/CDATA/PI delimiters (Y5/Y6)", async () => {
  // Y5: a CDATA opener inside the first comment must not match a
  // terminator inside the second — the real &#0; is rejected.
  const bypassBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      `<!-- <![CDATA[ --><note>&#0;</note><!-- ]]> -->`,
    ),
  );
  await assert.rejects(inspectPdf(bypassBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /character reference '&#0;' naming U\+0000/);
    return true;
  });
  // Y6: reference-like text inside a processing instruction is
  // literal data, not a character reference.
  const piBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      `<?probe &#0;?><note>V</note>`,
    ),
  );
  const piResult = await inspectPdf(piBytes);
  assert.deepEqual(piResult.fields, [{ name: "form.note", value: "V", type: "text" }]);
  // Delimiters inside each other's literal content: a CDATA section
  // may hold "<!--", a comment may hold "]]>", a PI may hold "-->".
  const delimiterBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>' +
        '<field name="cdata"><ui><textEdit/></ui><bind match="global"/></field>',
      `<!-- ]]> --><note>V</note><cdata><![CDATA[ <!-- ]]></cdata>`,
    ),
  );
  const delimiterResult = await inspectPdf(delimiterBytes);
  assert.deepEqual(delimiterResult.fields, [
    { name: "form.note", value: "V", type: "text" },
    { name: "form.cdata", value: " <!-- ", type: "text" },
  ]);
  const piDelimiterBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      `<?probe -->?><note>V</note>`,
    ),
  );
  const piDelimiterResult = await inspectPdf(piDelimiterBytes);
  assert.deepEqual(piDelimiterResult.fields, [{ name: "form.note", value: "V", type: "text" }]);
});

test("A-4 (round 9): overflowing and leading-zero references are rejected (Y7)", async () => {
  // Y7: a 400-digit reference used to parse to Infinity and skip the
  // rejection; saturating accumulation rejects it.
  const overflowBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      `<note>&#${"9".repeat(400)};</note>`,
    ),
  );
  await assert.rejects(inspectPdf(overflowBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /above U\+10FFFF.*not valid in XML 1\.0/);
    return true;
  });
  // Control (Y7b): a merely out-of-range reference names its exact
  // code point.
  const outOfRangeBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      `<note>&#x110000;</note>`,
    ),
  );
  await assert.rejects(inspectPdf(outOfRangeBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /naming U\+110000/);
    return true;
  });
  // Leading-zero references are still caught: &#x00; names U+0000.
  const leadingZeroBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      `<note>&#x00;</note>`,
    ),
  );
  await assert.rejects(inspectPdf(leadingZeroBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /naming U\+0000/);
    return true;
  });
});

test("Test adequacy (round 9): byte accounting rejects values over 1 MiB in bytes but under it in characters", async () => {
  // The round-8 non-ASCII test only succeeds below the bound — a
  // character-count implementation could also pass it. This is the
  // rejection proof: 11 × 51,200 "é" is 563,200 characters (under
  // 1 MiB) but 1,126,400 UTF-8 bytes (over 1 MiB), so byte
  // accounting must 422 while character counting would pass it.
  const value = "é".repeat(51_200 * 11);
  assert.equal(value.length, 563_200);
  assert.equal(new TextEncoder().encode(value).length, 1_126_400);
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="global"/></field>',
      `<note>${value}</note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /bytes of resolved fields/);
    return true;
  });
});

test("Test adequacy (round 9): the incremental output guard fires before a later conflicting merge", async () => {
  // Ten units of one checkbox field, each a DISTINCT scope identity
  // resolving to the same leaf (the round-8 ancestor-bit
  // construction): nine ~100 KiB on-values merge to ~921 KiB, under
  // both bounds — the round-8 test proves that succeeds. The tenth
  // unit also carries a ~200 KiB caption label, so its merge delta
  // pushes the serialized field past 1 MiB: the INCREMENTAL outBytes
  // guard in push() must reject with "bytes of resolved fields". An
  // eleventh unit carries a CONFLICTING label — if the incremental
  // guard had not fired, processing would reach it and
  // mergeDuplicate() would throw "conflicting labels" instead. So
  // the byte error here proves the incremental guard fired, not
  // merely the final exact JSON.stringify check, which runs only
  // after all units and would never be reached once the conflict
  // throws.
  const bigValue = (i: number) => String.fromCharCode(65 + i) + "X".repeat(102400 - 1);
  const bigLabel = "L".repeat(200_000);
  const otherLabel = "M".repeat(200_000);
  const refs = accumRefs(11);
  let subforms = accumCheckboxSubform(refs[0], "1");
  for (let i = 1; i <= 8; i++) subforms += accumCheckboxSubform(refs[i], bigValue(i - 1));
  subforms += accumCheckboxSubform(refs[9], bigValue(8), bigLabel);
  subforms += accumCheckboxSubform(refs[10], "1", otherLabel);
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
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /bytes of resolved fields/);
    return true;
  });
});

test("Test adequacy (round 9): control — small labels let the later conflicting merge surface", async () => {
  // The same construction with small (~1 KiB) labels: the tenth
  // unit's merge stays under 1 MiB, so no byte guard fires, and the
  // eleventh unit's conflicting label DOES surface — proving the
  // conflict is reachable and would have been the error if the
  // incremental guard in the test above had not fired first.
  const bigValue = (i: number) => String.fromCharCode(65 + i) + "X".repeat(102400 - 1);
  const refs = accumRefs(11);
  let subforms = accumCheckboxSubform(refs[0], "1");
  for (let i = 1; i <= 8; i++) subforms += accumCheckboxSubform(refs[i], bigValue(i - 1));
  subforms += accumCheckboxSubform(refs[9], bigValue(8), "L".repeat(1000));
  subforms += accumCheckboxSubform(refs[10], "1", "M".repeat(1000));
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
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /conflicting labels/);
    return true;
  });
});

// --- B1 fix round 10 (panel re-review #9, Nov 19, 2026) --------------------
// Regression tests for the adopted chunk-A findings (A-1..A-3), the
// test-adequacy items, and the probe shapes in panel/probe-rereview9.mts.

test("A-1 (round 10): a prefixed company-namespaced container is ordinary data (Z1)", async () => {
  // Astra #1 / Sol A9-1: <c:xhtml xmlns:c="urn:company:data"> with
  // <c:body>/<c:head> children. The round-9 classifier read only the
  // literal `xmlns` attribute, so the prefixed namespace was invisible
  // and the parent flattened to form.note = "FIRSTSECOND". Now the
  // container's RESOLVED namespace (prefix binding) defeats the
  // classification: the parent has no data node, and the children
  // stay addressable.
  const datasets = `<note><c:xhtml xmlns:c="urn:company:data"><c:body>FIRST</c:body><c:head>SECOND</c:head></c:xhtml></note>`;
  const bytes = await createXfaPdf(
    wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  const childBytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<subform name="xhtml"><bind match="default"/>' +
        '<field name="body"><ui><textEdit/></ui><bind match="default"/></field>' +
        '<field name="head"><ui><textEdit/></ui><bind match="default"/></field></subform></subform>',
      datasets,
    ),
  );
  const result = await inspectPdf(childBytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.xhtml.body", value: "FIRST", type: "text" },
    { name: "form.note.xhtml.head", value: "SECOND", type: "text" },
  ]);
});

test("A-1 (round 10): an inherited company default namespace defeats rich text (Z1b)", async () => {
  // The company namespace is declared as the DEFAULT namespace on
  // the parent <note>; the <xhtml> child inherits it. The round-9
  // SPEC called inherited namespaces a limit — both reviewers ruled
  // documenting the limit does not make silent fabrication safe, and
  // the parent's xmlns IS in the tree, so the walk carries it: the
  // child resolves to the company namespace and the parent has no
  // data node, with the children addressable as before.
  const datasets = `<note xmlns="urn:company:data"><xhtml><body>FIRST</body><head>SECOND</head></xhtml></note>`;
  const bytes = await createXfaPdf(
    wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  const childBytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<subform name="xhtml"><bind match="default"/>' +
        '<field name="body"><ui><textEdit/></ui><bind match="default"/></field>' +
        '<field name="head"><ui><textEdit/></ui><bind match="default"/></field></subform></subform>',
      datasets,
    ),
  );
  const result = await inspectPdf(childBytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.xhtml.body", value: "FIRST", type: "text" },
    { name: "form.note.xhtml.head", value: "SECOND", type: "text" },
  ]);
});

test("A-1 (round 10): a genuine XHTML-prefixed container stays rich text, even with an unrelated default namespace (Z1c, Z1d)", async () => {
  // Z1c converse: the container resolves its PREFIX to the XHTML
  // namespace, so the unrelated default namespace does not govern
  // it — the round-9 code rejected this shape ("no data node"), a
  // false negative. Z1d control: the same container with no
  // competing default namespace. Both stay rich text "A".
  for (const datasets of [
    `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml" xmlns="urn:company:data"><h:body>A</h:body></h:xhtml></note>`,
    `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:body>A</h:body></h:xhtml></note>`,
  ]) {
    const bytes = await createXfaPdf(
      wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
    );
    const result = await inspectPdf(bytes);
    assert.deepEqual(result.fields, [{ name: "form.note", value: "A", type: "unsupported" }]);
  }
  // Same converse for a wrapper: an <exData> declaring an unrelated
  // default namespace around a genuinely XHTML-prefixed inner
  // <xhtml> is rich text — the wrapper's default namespace defeats
  // the classification only insofar as the inner element inherits
  // it, and this inner element does not.
  const wrapperBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><exData xmlns="urn:company:data" contentType="text/html"><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:body>A</h:body></h:xhtml></exData></note>`,
    ),
  );
  const wrapperResult = await inspectPdf(wrapperBytes);
  assert.deepEqual(wrapperResult.fields, [{ name: "form.note", value: "A", type: "unsupported" }]);
});

test("A-1 (round 10): a skeleton-shaped container with an unbound prefix fails closed", async () => {
  // An unbound prefix is an UNKNOWN namespace, not "none": <x:xhtml>
  // with no binding for `x` anywhere in scope must not classify as
  // rich text merely because its local names look like a skeleton.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><x:xhtml><x:body>FIRST</x:body><x:head>SECOND</x:head></x:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
});

test("A-2 (round 10): an alternate prefix for the XFA data namespace still marks a dataGroup (Z2, Z2b)", async () => {
  // Astra #2: `d:dataNode="dataGroup"` with xmlns:d bound to the XFA
  // data namespace is the SAME attribute as xfa:dataNode in XML
  // terms — the round-9 code looked up the literal spelling only, so
  // a prefix change bypassed the Y2 fix. Both the empty-group shape
  // and the group-marked rich-text-shaped container now fail closed.
  const emptyBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note xmlns:d="http://www.xfa.org/schema/xfa-data/1.0/" d:dataNode="dataGroup"/>`,
    ),
  );
  await assert.rejects(inspectPdf(emptyBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  // Control (Z2c): the literal spelling still fails closed (the
  // round-9 Y2 shape).
  const literalBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note xfa:dataNode="dataGroup"/>`,
    ),
  );
  await assert.rejects(inspectPdf(literalBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  // Container variant (Z2b): the group-marked container flattens no
  // more, and its body stays addressable through a dataRef.
  const containerDatasets = `<note xmlns:d="http://www.xfa.org/schema/xfa-data/1.0/" d:dataNode="dataGroup"><xhtml><html><head></head><body>A</body></html></xhtml></note>`;
  const containerBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      containerDatasets,
    ),
  );
  await assert.rejects(inspectPdf(containerBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  const deepBytes = await createXfaPdf(
    wrap(
      '<field name="b"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.xhtml.html.body"/></field>',
      containerDatasets,
    ),
  );
  const deepResult = await inspectPdf(deepBytes);
  assert.deepEqual(deepResult.fields, [
    { name: "form.note.xhtml.html.body", value: "A", type: "text" },
  ]);
});

test("A-2 (round 10): a dataNode prefix bound to another namespace is not a group marking", async () => {
  // Expanded-name semantics cut both ways: `d:dataNode` where `d`
  // is bound to a company namespace is {urn:company:data}dataNode,
  // NOT the XFA marking — so an empty element carrying it is an
  // ordinary scalar leaf with value "", not a group. A literal
  // spelling check would have failed this closed; a prefix-blind
  // check would have too.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note xmlns:d="urn:company:data" d:dataNode="dataGroup"/>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "", type: "text" }]);
});

test("A-3 (round 10): a numeric reference cannot repair a malformed split entity (Z3, Z3b, Z3c)", async () => {
  // The scanner decodes numeric references BEFORE the only
  // well-formedness check, so `&am&#112;;` used to decode to `&amp;`
  // and report "&" for malformed input. Entity syntax is now
  // established on the ORIGINAL text first: a split entity fails
  // closed in text (Z3, Z3b) and in a quoted attribute value (Z3c).
  for (const datasets of [`<note>&am&#112;;</note>`, `<note>&a&#109;p;</note>`]) {
    const bytes = await createXfaPdf(
      wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
    );
    await assert.rejects(inspectPdf(bytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /malformed entity reference/);
      return true;
    });
  }
  const attrBytes = await createXfaPdf(
    wrap(
      '<field name="&am&#112;;"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note>V</note>`,
    ),
  );
  await assert.rejects(inspectPdf(attrBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /malformed entity reference/);
    return true;
  });
  // An undeclared named entity and an unterminated predefined one
  // are malformed the same way (no DTD can declare anything else —
  // DOCTYPE is refused outright).
  for (const datasets of [`<note>&foo;</note>`, `<note>&amp</note>`]) {
    const bytes = await createXfaPdf(
      wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
    );
    await assert.rejects(inspectPdf(bytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /malformed entity reference/);
      return true;
    });
  }
  // Controls: a legal numeric reference still decodes (Z3d), and the
  // predefined named entities still decode in text.
  const controlBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>' +
        '<field name="named"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note>A&#65;B&amp;C</note><named>&quot;hi&quot; &apos;x&apos;</named>`,
    ),
  );
  const control = await inspectPdf(controlBytes);
  assert.deepEqual(control.fields, [
    { name: "form.note", value: "AAB&C", type: "text" },
    { name: "form.named", value: `"hi" 'x'`, type: "text" },
  ]);
});

test("Test adequacy (round 10): numeric quote references decode in attributes, captions, and items", async () => {
  // A decoded quote is re-emitted as its named entity by the scanner
  // and decoded by the parser, so it can never break attribute
  // quoting — pin that directly, in all three places a quote
  // reference can reach output. Attribute values: a field name
  // spelled with &#34; / &#39; (bind none, so no dataset leaf with a
  // quote in its name is needed).
  const bytes = await createXfaPdf(
    wrap(
      '<field name="a&#34;b"><ui><textEdit/></ui><bind match="none"/></field>' +
        '<field name="c&#39;d"><ui><textEdit/></ui><bind match="none"/></field>' +
        '<field name="note"><ui><textEdit/></ui><bind match="default"/><caption><value><text>Say &#34;hi&#34;</text></value></caption></field>' +
        '<field name="pick"><ui><choiceList/></ui><bind match="none"/><items><text>it&#39;s</text><text>say &#34;hi&#34;</text></items></field>',
      `<note>V</note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: `form.a"b`, value: "", type: "unsupported" },
    { name: `form.c'd`, value: "", type: "unsupported" },
    { name: "form.note", value: "V", type: "text", label: `Say "hi"` },
    {
      name: "form.pick",
      value: "",
      type: "unsupported",
      options: ["it's", `say "hi"`],
    },
  ]);
});

test("Test adequacy (round 10): a decoded CR reports as LF (documented parser corner)", async () => {
  // &#13; decodes to a raw CR pre-parse, but the parser normalizes
  // line endings on input, so it reports as LF, not CR. Accepted
  // corner, pinned so a future parser change cannot silently change
  // the reported value.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note>A&#13;B</note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "A\nB", type: "text" }]);
});

// --- B1 fix round 11 (re-review #10, Sol alone, Nov 19, 2026) ---------------
// Regression tests for the two adopted P1s (A-1 namespace-map copying,
// A-2 second-level skeleton checks) plus the malformed-entity matrix in
// both lexical contexts. Fixtures are built in-test with the repo's own
// generator so the discriminating shape is visible in the test.

test("A-1 (round 11): a wide namespace environment x many declaring siblings fails closed (W1)", async () => {
  // Sol's construction, scaled down: a template root declaring 1,000
  // distinct prefixes, with 2,000 sibling empty elements each
  // declaring xmlns:q — 2M copied map entries on round-10 code
  // (838 ms, heap +91 MiB; the full 10,000 x 50,000 construction is
  // ~500M entries). Depth does not bound this: the tree is shallow
  // and field-less, and conversion runs before field collection, so
  // no join/output budget protects it. The cumulative budget fails
  // closed with a 422 before the over-budget copy is made.
  const decls = Array.from({ length: 1000 }, (_, i) => `xmlns:p${i}="urn:p${i}"`).join(" ");
  const sibs = Array.from(
    { length: 2000 },
    (_, i) => `<subform name="s${i}" xmlns:q="urn:q"></subform>`,
  ).join("");
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      `<subform name="form" layout="tb" ${decls}>${sibs}</subform></template>`,
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><note/></form></xfa:data></xfa:datasets>',
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /too many namespace bindings/);
    return true;
  });
});

test("A-1 (round 11): a wide namespace environment under the budget still inspects (W1a control)", async () => {
  // Same shape at 200 prefixes x 500 declaring siblings (100k copied
  // entries, under the 250,000 budget): a field-less template inspects
  // to zero fields, fast, with a small heap — the budget bounds the
  // amplification without rejecting legitimate wide environments.
  // (Passes on round-10 code too, slower; it pins the budget's
  // below-threshold behaviour, not the defect.)
  const decls = Array.from({ length: 200 }, (_, i) => `xmlns:p${i}="urn:p${i}"`).join(" ");
  const sibs = Array.from(
    { length: 500 },
    (_, i) => `<subform name="s${i}" xmlns:q="urn:q"></subform>`,
  ).join("");
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      `<subform name="form" layout="tb" ${decls}>${sibs}</subform></template>`,
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><note/></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, []);
});

test("A-2 (round 11): a mixed namespace one level down defeats rich text (W2)", async () => {
  // Sol's construction: <h:xhtml> has one immediate child <h:html>
  // (XHTML, skeleton name) — that passed the round-10 first-level
  // rule — but the html's children are company-namespaced
  // <c:body>/<c:head>. The round-10 code flattened them to
  // form.note = "FIRSTSECOND"; the company namespace is KNOWN
  // (declared on the container itself), so this is not covered by
  // the stated "lying document" limit. Now the whole subtree is
  // validated before flattening: the parent has no data node, and
  // the children stay addressable.
  const datasets =
    `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml" xmlns:c="urn:company:data">` +
    `<h:html><c:body>FIRST</c:body><c:head>SECOND</c:head></h:html></h:xhtml></note>`;
  const bytes = await createXfaPdf(
    wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  const childBytes = await createXfaPdf(
    wrap(
      '<subform name="note"><bind match="default"/>' +
        '<subform name="xhtml"><bind match="default"/>' +
        '<subform name="html"><bind match="default"/>' +
        '<field name="body"><ui><textEdit/></ui><bind match="default"/></field>' +
        '<field name="head"><ui><textEdit/></ui><bind match="default"/></field></subform></subform></subform>',
      datasets,
    ),
  );
  const result = await inspectPdf(childBytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.xhtml.html.body", value: "FIRST", type: "text" },
    { name: "form.note.xhtml.html.head", value: "SECOND", type: "text" },
  ]);
});

test("A-2 (round 11): a dataGroup marking on a skeleton descendant defeats rich text (W2b)", async () => {
  // A dataNode="dataGroup" marking on a skeleton DESCENDANT
  // (<h:body> inside a genuine XHTML skeleton) was not checked
  // before flattening: the round-10 code reported form.note =
  // "SECRET". Now the marking defeats the classification; the
  // unmarked sibling stays addressable and the marked body's text
  // is not a leaf.
  const datasets =
    `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml">` +
    `<h:html><h:head></h:head><h:body xfa:dataNode="dataGroup">SECRET</h:body></h:html></h:xhtml></note>`;
  const bytes = await createXfaPdf(
    wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
  const headBytes = await createXfaPdf(
    wrap(
      '<field name="head"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.xhtml.html.head"/></field>',
      datasets,
    ),
  );
  const headResult = await inspectPdf(headBytes);
  assert.deepEqual(headResult.fields, [
    { name: "form.note.xhtml.html.head", value: "", type: "text" },
  ]);
  const bodyBytes = await createXfaPdf(
    wrap(
      '<field name="body"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.xhtml.html.body"/></field>',
      datasets,
    ),
  );
  await assert.rejects(inspectPdf(bodyBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
});

test("A-2 (round 11): genuine two-level and first-level-mixed skeletons (W2c, W2d controls)", async () => {
  // W2c control: a genuine two-level XHTML skeleton stays rich text
  // "A" — the whole-subtree check must not reject honest XHTML.
  const genuineBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml">` +
        `<h:html><h:head></h:head><h:body>A</h:body></h:html></h:xhtml></note>`,
    ),
  );
  const genuine = await inspectPdf(genuineBytes);
  assert.deepEqual(genuine.fields, [{ name: "form.note", value: "A", type: "unsupported" }]);
  // W2d control: a mixed namespace at the FIRST level already failed
  // closed under the round-10 rule — it still does, proving the
  // bypass fixed above was specifically the second level.
  const firstLevelBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml" xmlns:c="urn:company:data">` +
        `<c:html><c:body>FIRST</c:body></c:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(firstLevelBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /has no data node/);
    return true;
  });
});

test("A-2 (round 11): contradictory descendants deeper than the skeleton still defeat rich text", async () => {
  // The check is the WHOLE subtree, not just two levels: a
  // company-namespaced <c:span> inside a <p> inside a genuine
  // <h:body>, and a dataGroup marking on a <p> inside a genuine
  // <h:body>, both defeat classification. An <html> whose children
  // are not <head>/<body> is not skeleton-shaped either.
  const shapes = [
    `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml" xmlns:c="urn:company:data">` +
      `<h:html><h:head></h:head><h:body><h:p><c:span>SECRET</c:span></h:p></h:body></h:html></h:xhtml></note>`,
    `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml">` +
      `<h:html><h:head></h:head><h:body><h:p xfa:dataNode="dataGroup">SECRET</h:p></h:body></h:html></h:xhtml></note>`,
    `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml">` +
      `<h:html><h:div>NOT-A-SKELETON</h:div></h:html></h:xhtml></note>`,
  ];
  for (const datasets of shapes) {
    const bytes = await createXfaPdf(
      wrap('<field name="note"><ui><textEdit/></ui><bind match="default"/></field>', datasets),
    );
    await assert.rejects(inspectPdf(bytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /has no data node/);
      return true;
    });
  }
});

test("A-3 (round 11): the full malformed-entity matrix fails closed in both lexical contexts", async () => {
  // Round 10 pinned Z3/Z3b in element content and Z3c in a quoted
  // attribute value (the attrBytes case in that test — a field's
  // name attribute carrying a split entity). Round 11 extends that
  // to the full matrix in both contexts: the scanner must reject
  // every malformed form in BOTH places a reference can occur —
  // element content and a quoted attribute value — and the legal
  // forms must still decode in both. Each malformed spelling is
  // tried in a <note> value and in a field's name attribute.
  const malformed = [
    "&#X41;", // uppercase X
    "&#;", // empty reference
    "&#65", // missing semicolon
    "&AMP;", // wrong-case named entity
    "& amp;", // whitespace inside the reference
    "&am&#112;;", // split entity
    "&a&#109;p;", // split entity, other split point
    "&foo;", // undeclared named entity
    "&amp", // unterminated named entity
  ];
  for (const spelling of malformed) {
    const contentBytes = await createXfaPdf(
      wrap(
        '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
        `<note>A${spelling}B</note>`,
      ),
    );
    await assert.rejects(inspectPdf(contentBytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /malformed entity reference/, spelling);
      return true;
    });
    const attrBytes = await createXfaPdf(
      wrap(
        `<field name="a${spelling}b"><ui><textEdit/></ui><bind match="none"/></field>`,
        `<note>V</note>`,
      ),
    );
    await assert.rejects(inspectPdf(attrBytes), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 422);
      assert.match(error.message, /malformed entity reference/, spelling);
      return true;
    });
  }
  // Legal controls in both contexts: a numeric reference and a
  // predefined named entity decode, in content and in an attribute.
  const controlBytes = await createXfaPdf(
    wrap(
      '<field name="a&#65;b"><ui><textEdit/></ui><bind match="none"/></field>' +
        '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note>A&#65;B&amp;C</note>`,
    ),
  );
  const control = await inspectPdf(controlBytes);
  assert.deepEqual(control.fields, [
    { name: "form.aAb", value: "", type: "unsupported" },
    { name: "form.note", value: "AAB&C", type: "text" },
  ]);
});

// --- B1 fix round 12 (re-review #11, Sol alone, Nov 19, 2026) ---------------
// Regression tests for the adopted P1 (A-1 wide-XHTML spread) plus the
// round-11 test-adequacy items: the named-entity attribute control, the
// datasets-side namespace amplification, exact namespace-budget
// boundaries, root declarations, and both packets independently
// approaching their budgets.

test("A-1 (round 12): wide XHTML content succeeds instead of throwing (X1)", async () => {
  // Sol's construction, verbatim from panel/probe-rereview11.mts:
  // <h:body> with 190,000 empty <h:p/> children inside a genuine
  // XHTML skeleton — well-formed, ~1.3 MB (under the 10 MiB packet
  // cap), ~190,005 `<` (under the 200,000 gate), shallow, one
  // namespace declaration, passing every classifier check. On
  // round-11 code isXhtmlDocument() spread the whole child array
  // into pending.push(...), hitting the engine's maximum argument
  // count (RangeError) and failing closed with a 422 that
  // misattributed the cause. Now the children are appended one at
  // a time and the inspection succeeds with an empty rich-text value.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:body>${"<h:p/>".repeat(190_000)}</h:body></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "", type: "unsupported" }]);
});

test("A-1 (round 12): wide XHTML content at 120k paragraphs succeeds (X1b control)", async () => {
  // Mid-size control for the X1 regression: the same shape at
  // 120,000 empty paragraphs also succeeds with an empty rich-text
  // value. (It passed on round-11 code too — it pins the
  // below-threshold behaviour, not the defect.)
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:body>${"<h:p/>".repeat(120_000)}</h:body></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "", type: "unsupported" }]);
});

test("Test adequacy (round 12): named entities decode in attribute values", async () => {
  // Round 11's entity matrix had a numeric-entity attribute control
  // (a&#65;b → aAb) and numeric/named entities in content, but no
  // named-entity ATTRIBUTE control. A named entity in a field's
  // name attribute is validated by scanXmlText() and left with its
  // spelling intact for the parser to decode — it does NOT go
  // through the decode/re-emit path: only a NUMERIC reference is
  // decoded by the scanner, and a decoded & or quote from that path
  // is re-emitted as its named entity before parsing, so it can
  // never become markup or break attribute quoting. (Round 13
  // correction of this comment's parenthetical, which used to imply
  // the re-emit applied to named entities too.)
  const bytes = await createXfaPdf(
    wrap(
      '<field name="a&amp;b"><ui><textEdit/></ui><bind match="none"/></field>' +
        '<field name="c&apos;d"><ui><textEdit/></ui><bind match="none"/></field>' +
        '<field name="e&quot;f"><ui><textEdit/></ui><bind match="none"/></field>',
      `<note>V</note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.a&b", value: "", type: "unsupported" },
    { name: "form.c'd", value: "", type: "unsupported" },
    { name: 'form.e"f', value: "", type: "unsupported" },
  ]);
});

test("Test adequacy (round 12): datasets-side namespace amplification fails closed", async () => {
  // W1 (round 11) proved the amplification on the template side.
  // The same shape on the datasets side must fail closed too: the
  // budget is per packet, and conversion runs before field
  // collection on either packet. A <form> declaring 1,000 prefixes
  // with 2,000 sibling elements each declaring xmlns:q copies
  // ~2M map entries on unbudgeted code; the cumulative budget fails
  // closed with a 422 before the over-budget copy is made.
  const decls = Array.from({ length: 1000 }, (_, i) => `xmlns:p${i}="urn:p${i}"`).join(" ");
  const sibs = Array.from({ length: 2000 }, (_, i) => `<s${i} xmlns:q="urn:q"/>`).join("");
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      '<subform name="form" layout="tb"></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      `<form ${decls}>${sibs}</form></xfa:data></xfa:datasets>`,
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /too many namespace bindings/);
    return true;
  });
});

test("Test adequacy (round 12): datasets-side namespace environment under the budget still inspects", async () => {
  // Same shape at 200 prefixes x 500 declaring siblings (101,704
  // copied entries, under the 250,000 budget): a field-less
  // template inspects to zero fields — the budget bounds the
  // amplification without rejecting a legitimate wide environment
  // on the datasets side either.
  const decls = Array.from({ length: 200 }, (_, i) => `xmlns:p${i}="urn:p${i}"`).join(" ");
  const sibs = Array.from({ length: 500 }, (_, i) => `<s${i} xmlns:q="urn:q"/>`).join("");
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      '<subform name="form" layout="tb"></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      `<form ${decls}>${sibs}</form></xfa:data></xfa:datasets>`,
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, []);
});

test("Test adequacy (round 12): namespace budget boundary is exact at 250,000 entries", async () => {
  // Charge arithmetic, per namespaceBindingsFor(): the <template>
  // root declaring its default xmlns charges 1 (ROOT size) + 1 = 2;
  // the <form> subform declaring 496 prefixes charges 2 + 496 =
  // 498; each declaring sibling charges 498 + 1 = 499. With 500
  // siblings the total is exactly 2 + 498 + 500 x 499 = 250,000 —
  // the check is `used + charge > 250,000`, so exactly at budget
  // still inspects. One more sibling (250,499 total) fails closed.
  const decls = Array.from({ length: 496 }, (_, i) => `xmlns:p${i}="urn:p${i}"`).join(" ");
  const atBudget = Array.from(
    { length: 500 },
    (_, i) => `<subform name="s${i}" xmlns:q="urn:q"></subform>`,
  ).join("");
  const overBudget = Array.from(
    { length: 501 },
    (_, i) => `<subform name="s${i}" xmlns:q="urn:q"></subform>`,
  ).join("");
  const datasetsXml =
    '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><note/></form></xfa:data></xfa:datasets>';
  const atBytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      `<subform name="form" layout="tb" ${decls}>${atBudget}</subform></template>`,
    datasetsXml,
  });
  const atResult = await inspectPdf(atBytes);
  assert.deepEqual(atResult.fields, []);
  const overBytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      `<subform name="form" layout="tb" ${decls}>${overBudget}</subform></template>`,
    datasetsXml,
  });
  await assert.rejects(inspectPdf(overBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /too many namespace bindings/);
    return true;
  });
});

test("Test adequacy (round 12): root declarations count toward the namespace budget", async () => {
  // The packet ROOT's own declarations are charged too (conversion
  // begins with ROOT_NS_BINDINGS, size 1, then passes through the
  // same function): a <template> root declaring its default xmlns
  // plus 249,998 prefixes charges 1 + (1 + 249,998) = 250,000 —
  // exactly at budget, so it inspects. One more prefix (250,001)
  // fails closed, even with no declaring descendants at all.
  const atBudget = Array.from({ length: 249_998 }, (_, i) => `xmlns:p${i}="urn:p${i}"`).join(" ");
  const overBudget = Array.from({ length: 249_999 }, (_, i) => `xmlns:p${i}="urn:p${i}"`).join(" ");
  const datasetsXml =
    '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><note/></form></xfa:data></xfa:datasets>';
  const atBytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/" ' +
      `${atBudget}><subform name="form" layout="tb"></subform></template>`,
    datasetsXml,
  });
  const atResult = await inspectPdf(atBytes);
  assert.deepEqual(atResult.fields, []);
  const overBytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/" ' +
      `${overBudget}><subform name="form" layout="tb"></subform></template>`,
    datasetsXml,
  });
  await assert.rejects(inspectPdf(overBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /too many namespace bindings/);
    return true;
  });
});

test("Test adequacy (round 12): both packets independently approach their namespace budgets", async () => {
  // The 250,000-entry budget is PER PACKET, not shared: a template
  // at 240,481 copied entries AND datasets at 240,481 (480,962
  // combined — over the budget if it were shared) still inspect,
  // and a real field still resolves. Per packet: root charge 2,
  // <form> declaring 477 prefixes charges 2 + 477 = 479, each of
  // 500 declaring siblings charges 479 + 1 = 480; total
  // 2 + 479 + 500 x 480 = 240,481.
  const decls = Array.from({ length: 477 }, (_, i) => `xmlns:p${i}="urn:p${i}"`).join(" ");
  const templateSibs = Array.from(
    { length: 500 },
    (_, i) => `<subform name="s${i}" xmlns:q="urn:q"></subform>`,
  ).join("");
  const datasetsSibs = Array.from({ length: 500 }, (_, i) => `<s${i} xmlns:q="urn:q"/>`).join("");
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      `<subform name="form" layout="tb" ${decls}>` +
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>' +
      `${templateSibs}</subform></template>`,
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      `<form ${decls}>${datasetsSibs}<note>OK</note></form></xfa:data></xfa:datasets>`,
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "OK", type: "text" }]);
});

// Regression tests for the round-11 cross-check P1s (C1 namespace-
// collision rebound, C2 skeleton-level direct text), the match(/</g)
// hardening, and the round-12 re-review's wide-and-failing-late note.

test("C1 (round 13): a prefix rebound between siblings fails closed (probe C1a shape)", async () => {
  // Two <p:code> siblings with the same spelling but different
  // expanded names (urn:first vs urn:second) used to pass the
  // collision gate — it compared the written qualified name — and
  // report as form.code[0]/[1], indistinguishable from genuine
  // same-namespace repeats. The gate now compares resolved
  // namespace identity, so this fails closed with a 422.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>',
      '<p:code xmlns:p="urn:first">FIRST</p:code><p:code xmlns:p="urn:second">SECOND</p:code>',
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /namespace collision.*'code'/);
    return true;
  });
});

test("C1 (round 13): genuine same-namespace repeats still report as [0]/[1] (probe C1b control)", async () => {
  // Positive control for the C1a regression: two <code> siblings in
  // the SAME namespace are two occurrences of one field and must
  // still report as form.code[0]/[1]. (This control also passes on
  // round-12 code — it pins the behaviour the fix must not break.)
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>',
      "<code>FIRST</code><code>SECOND</code>",
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.code[0]", value: "FIRST", type: "text" },
    { name: "form.code[1]", value: "SECOND", type: "text" },
  ]);
});

test("C1 (round 13): unprefixed siblings in different default namespaces fail closed (probe C1c shape)", async () => {
  // Same rebound through default-namespace declarations instead of
  // prefixes: two unprefixed <code> siblings declaring different
  // default namespaces are different expanded names, not repeats.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>',
      '<code xmlns="urn:first">FIRST</code><code xmlns="urn:second">SECOND</code>',
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /namespace collision.*'code'/);
    return true;
  });
});

test("C2 (round 13): non-whitespace text directly under <html> fails closed (probe C2a shape)", async () => {
  // <h:html>OUTSIDE<h:body>Inside</h:body></h:html>: the skeleton
  // check looked only at element children, but nodeText() included
  // the direct text, so the field flattened to "OUTSIDEInside".
  // Non-whitespace direct text at a skeleton position now fails
  // closed with a 422 (whole-container defeat).
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html>OUTSIDE<h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(
      error.message,
      /non-whitespace text directly under an XHTML skeleton element 'html'/,
    );
    return true;
  });
});

test("C2 (round 13): non-whitespace text directly under <xhtml> fails closed (probe C2c shape)", async () => {
  // Same defect one level up: text directly under <h:xhtml>,
  // outside <h:html>, used to flatten to "LOOSEInside".
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml">LOOSE<h:html><h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(
      error.message,
      /non-whitespace text directly under an XHTML skeleton element 'xhtml'/,
    );
    return true;
  });
});

test("C2 (round 13): whitespace-only direct text at skeleton positions is formatting (control)", async () => {
  // Whitespace-only direct text under <xhtml> and <html> is
  // pretty-printing indentation, not content: the same shape as
  // C2a/C2c with only newlines and spaces must still be accepted
  // and flatten the body text. (This control also passes on
  // round-12 code — it pins the behaviour the fix must not break.)
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml">\n  <h:html>\n  <h:body>Inside</h:body>\n  </h:html>\n</h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("C2 (round 13): text only inside <body> still flattens (probe C2b control)", async () => {
  // Positive control for the C2a/C2c regressions: text inside
  // <h:body> only is legitimate rich-text content and must still
  // flatten to "Inside". (This control also passes on round-12
  // code — it pins the behaviour the fix must not break.)
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("C2 (round 13): wide skeleton-level text fails closed (Terra reachability note)", async () => {
  // Terra (re-review #12 check pass): the round-12 spread fix made
  // WIDE instances of the skeleton-text defect newly reachable — a
  // <h:body> with 190,000 <h:p/> plus LEAK text under <h:html>
  // previously RangeError'd in isXhtmlDocument(); now it completes
  // and nodeText() includes LEAK. The regression must cover the
  // wide shape, not just the small one: this must fail closed with
  // a 422, not report a value containing LEAK.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html>LEAK<h:body>${"<h:p/>".repeat(190_000)}</h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(
      error.message,
      /non-whitespace text directly under an XHTML skeleton element 'html'/,
    );
    return true;
  });
});

test("Test adequacy (round 14): wide XHTML failing late still fails closed (Sonnet; shape fixed)", async () => {
  // Sonnet (re-review #12): no wide-and-failing-late XHTML test —
  // a wide subtree (~190k children) with a trailing
  // company-namespaced child, exercising the loop-append on the
  // `return false` path followed by the ordinary-data walk. The
  // round-13 shape was wrong two ways, and this test fixes both:
  // (1) the trailing child was `<c:p/>`, which shares the local
  // name `p` with the `<h:p/>` siblings, so convertEntries'
  // written-name gate threw during conversion, before the classifier
  // ever ran — the test pinned rejection, not late classifier
  // defeat. The contradictory child is now `<c:other/>`, a distinct
  // local name, so it reaches the classifier (probe S3b). (2) It now
  // comes FIRST, so the LIFO walk in isXhtmlDocument() pops it
  // AFTER the 190,000 `<h:p/>` siblings: the defeat is discovered
  // late, after the whole wide subtree has been walked. The
  // ordinary-data walk that follows produces ~190k leaves, so the
  // aggregate join-index bound (4 MiB of internal paths) fires
  // before lookup runs — each leaf charges 28 bytes (27 for the
  // stripped path `form.note.xhtml.html.body.p` + 1 for the leaf
  // name `p`, which buildJoinIndex charges too), so ~190k leaves
  // charge ~5.3 MB against the 4 MiB bound. The asserted outcome is
  // that bound, NOT the convertEntries gate and NOT a skeleton-text
  // throw. The small companion test below pins the "no data node"
  // outcome the ordinary-data walk produces when the leaf set fits
  // the index bound. Only the fail-closed outcome is asserted here,
  // not a fabricated scalar and no RangeError.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body><c:other xmlns:c="urn:company"/>${"<h:p/>".repeat(190_000)}</h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /join index exceeds 4194304 bytes/);
    return true;
  });
});

test("Test adequacy (round 14): the `<` cap boundary is exact at 200,000 (match() hardening)", async () => {
  // The round-13 test only asserted the over-cap case. The gate is
  // `tagCount > 200,000`, so the boundary is pinned exactly here:
  // the datasets packet carries 9 fixed `<` (wrapper, `<form>`,
  // `<note>`, the comment delimiters, and the three closing tags),
  // so 199,991 `<` inside the comment is exactly 200,000 total and
  // inspects — the note is an empty leaf — while 199,992 is 200,001
  // total and fails closed with a 422. (The comment carries the bulk
  // of the `<` characters, so the packet stays small — ~200 KB —
  // while tripping the count gate before any parsing happens. No
  // timing assertion: the property under test is the rejection, not
  // the speed.)
  const atBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><!--${"<".repeat(199_991)}--></note>`,
    ),
  );
  const atResult = await inspectPdf(atBytes);
  assert.deepEqual(atResult.fields, [{ name: "form.note", value: "", type: "text" }]);
  const overBytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><!--${"<".repeat(199_992)}--></note>`,
    ),
  );
  await assert.rejects(inspectPdf(overBytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /too many XML nodes/);
    return true;
  });
});

// --- B1 fix round 14 (re-review #13, cross-check panel, Nov 19, 2026) -----
// Regression tests for the five adopted P1s (A-1 ordering, A-2
// NBSP/non-XML whitespace, A-3 cross-ancestor namespace collision, A-4
// same-line skeleton whitespace, A-5 text under <head>) plus the
// re-review's test-adequacy items. Probe shapes are noted per test.
// Controls that already exist are NOT duplicated: S1b/T1b (qualifying
// skeleton + text still throws) are the round-13 C2c/C2a tests, and the
// plain space/newline whitespace control is the round-13 C2
// whitespace test.

test("A-1 (round 14): skeleton text plus an unrelated defeat still resolves the addressed leaf (probe S1 shape)", async () => {
  // Sol's counterexample, as an assertion-based positive regression:
  // <h:xhtml>LOOSE<h:html><h:div>VALUE</h:div></h:html></h:xhtml>
  // with a dataRef to form.note.xhtml.html.div. Round-13 code threw
  // 422 on LOOSE before the walk could discover the <div> under
  // <html>, which defeats classification — the subtree then recurses
  // as ordinary data and the explicitly addressed leaf resolves.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="selected"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.xhtml.html.div"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml">LOOSE<h:html><h:div>VALUE</h:div></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.xhtml.html.div", value: "VALUE", type: "text" },
  ]);
});

test("A-1 (round 14): html text plus a descendant namespace contradiction still resolves (probe S2 shape)", async () => {
  // The <html> carries direct text AND a descendant carries a
  // contradictory namespace (company-namespaced <c:p> under <body>).
  // The namespace contradiction defeats classification, so the
  // recorded text is never thrown on and the addressed leaf resolves.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="selected"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.xhtml.html.body.p"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html>OUTSIDE<h:body><c:p xmlns:c="urn:company">X</c:p></h:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.xhtml.html.body.p", value: "X", type: "text" },
  ]);
});

test("A-1 (round 14): html text plus a company-namespaced body still resolves (probe T1 shape)", async () => {
  // Same ordering defect, with the defeating contradiction a
  // company-namespaced <c:body> (child NAME passes, namespace
  // defeats). Round-13 code threw on LOOSE before reaching it.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="selected"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.xhtml.html.body"/></field>',
      `<note xmlns:h="http://www.w3.org/1999/xhtml" xmlns:c="urn:company"><h:xhtml><h:html>LOOSE<c:body>RIGHT</c:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.xhtml.html.body", value: "RIGHT", type: "text" },
  ]);
});

test("A-1 (round 14): LOOSE text plus a disqualifying div deeper in the tree still resolves (probe U4 shape)", async () => {
  // Terra's ordering variant: LOOSE text at the container plus a
  // <div> under <html> holding a <code> leaf. Classification is
  // defeated, so the addressed leaf resolves through the
  // ordinary-data walk.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="selected"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.xhtml.html.div.code"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml">LOOSE<h:html><h:div><h:code>RIGHT</h:code></h:div></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.xhtml.html.div.code", value: "RIGHT", type: "text" },
  ]);
});

test("A-1 (round 14): exData wrapper text plus inner skeleton text still resolves (probe T3a shape)", async () => {
  // Caller-side ordering: the <exData> wrapper carries its own
  // direct text (disqualifying) AND the inner <xhtml> carries
  // skeleton text. isRichTextContainer() must check the wrapper's
  // own text BEFORE calling the classifier, so nothing throws and
  // the addressed body leaf resolves through the ordinary-data walk.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="selected"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.exData.xhtml.html.body"/></field>',
      `<note><exData>WRAPPER<h:xhtml xmlns:h="http://www.w3.org/1999/xhtml">LOOSE<h:html><h:body>Inside</h:body></h:html></h:xhtml></exData></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.exData.xhtml.html.body", value: "Inside", type: "text" },
  ]);
});

test("A-1 (round 14): parent text plus child skeleton text still resolves (probe T3b shape)", async () => {
  // Caller-side ordering, the other site: the parent <note> carries
  // its own direct text AND the child <xhtml> carries skeleton text.
  // collectDataLeaves() must check the parent's own text BEFORE
  // calling the classifier, so nothing throws and the addressed
  // body leaf resolves through the ordinary-data walk.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="selected"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.xhtml.html.body"/></field>',
      `<note>PARENT<h:xhtml xmlns:h="http://www.w3.org/1999/xhtml">LOOSE<h:html><h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.xhtml.html.body", value: "Inside", type: "text" },
  ]);
});

test("A-1 (round 14): sibling <html> elements decide independently of LIFO pop order (text first)", async () => {
  // Sonnet's consistency nit, made an assertion: two sibling <html>
  // elements under one <xhtml> — one with LOOSE text and a
  // qualifying body, one with a dataGroup-marked body (a defeat).
  // Record-then-decide walks the whole subtree before deciding, so
  // the defeat wins and the field has no data node, whichever
  // sibling the LIFO walk pops first. (The dataGroup marking uses
  // the xfa: prefix the datasets wrapper already declares.)
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html>LOOSE<h:body>Inside</h:body></h:html><h:html><h:body xfa:dataNode="dataGroup">X</h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.note.*has no data node/);
    return true;
  });
});

test("A-1 (round 14): sibling <html> elements decide independently of LIFO pop order (text second)", async () => {
  // Same shape as the text-first test, with the two <html> siblings
  // in the opposite document order — the LIFO walk pops them in the
  // opposite order, so a pop-order-dependent implementation would
  // decide differently. The outcome must be identical: defeat wins,
  // no throw, field has no data node.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body xfa:dataNode="dataGroup">X</h:body></h:html><h:html>LOOSE<h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.note.*has no data node/);
    return true;
  });
});

test("A-2 (round 14): NBSP under <html> fails closed (probe T2 shape)", async () => {
  // U+00A0 (&#160;) at a skeleton position: JS trim() treats it as
  // whitespace, so the round-13 guard accepted it while nodeText()
  // retained it — the value was "\u00a0Inside". Only space/tab/CR/LF
  // are XML whitespace, so NBSP is non-whitespace skeleton text and
  // fails closed with a 422.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html>&#160;<h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(
      error.message,
      /non-whitespace text directly under an XHTML skeleton element 'html'/,
    );
    return true;
  });
});

test("A-2 (round 14): em space under <html> fails closed (probe T2c shape)", async () => {
  // Same class as T2, with U+2003 (em space, &#x2003;): not XML
  // whitespace, so it fails closed instead of leaking into the value.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html>&#x2003;<h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(
      error.message,
      /non-whitespace text directly under an XHTML skeleton element 'html'/,
    );
    return true;
  });
});

test("A-2 (round 14): U+2028 line separator under <html> fails closed", async () => {
  // Same class again, with U+2028 (&#x2028;): JS trim() treats it as
  // whitespace, XML does not, so it fails closed like NBSP and
  // em space.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html>&#x2028;<h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(
      error.message,
      /non-whitespace text directly under an XHTML skeleton element 'html'/,
    );
    return true;
  });
});

test("A-2 (round 14): NBSP as a parent's only direct text disqualifies the rich-text leaf", async () => {
  // The XML-whitespace predicate in the caller's own-text guard: a
  // parent whose only direct text is NBSP is not a clean rich-text
  // leaf (trim() would have called it whitespace, so the leaf
  // resolved "Inside" with the NBSP silently dropped as formatting).
  // It recurses as ordinary data instead, so the field bound to the
  // parent has no data node.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note>&#160;<h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.note.*has no data node/);
    return true;
  });
});

test("A-2 (round 14): NBSP wrapper text plus inner skeleton text still resolves the body", async () => {
  // The same predicate in the exData wrapper's own-text guard: NBSP
  // wrapper text disqualifies the wrapper before the classifier
  // runs, so the inner skeleton text never throws and the addressed
  // body leaf resolves through the ordinary-data walk.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="selected"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.note.exData.xhtml.html.body"/></field>',
      `<note><exData>&#160;<h:xhtml xmlns:h="http://www.w3.org/1999/xhtml">LOOSE<h:html><h:body>Inside</h:body></h:html></h:xhtml></exData></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.exData.xhtml.html.body", value: "Inside", type: "text" },
  ]);
});

test("A-3 (round 14): same-local-name leaves in different namespaces under repeated parents fail closed (probe U1 shape)", async () => {
  // Two <person> elements each with a lone <p:code> child in a
  // DIFFERENT namespace used to resolve as form.person[0].code /
  // [1].code, indistinguishable from genuine repeats. The
  // convertEntries sibling gate cannot cover it — the <code>
  // elements sit under different parents — so the join compares
  // expanded names at resolution time and fails closed when repeat
  // instances of one stripped path disagree on namespace.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="person"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><p:code xmlns:p="urn:first">FIRST</p:code></person><person><p:code xmlns:p="urn:second">SECOND</p:code></person>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.person\.code.*different namespaces/);
    return true;
  });
});

test("A-3 (round 14): same-local-name leaves in the same namespace under repeated parents still report as [0]/[1] (probe U1b control)", async () => {
  // Positive control for the U1 regression: the same shape with
  // BOTH codes in urn:first is genuine repeats and must still
  // report as form.person[0].code / [1].code. (This control also
  // passes on round-13 code — it pins the behaviour the fix must
  // not break.)
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="person"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><p:code xmlns:p="urn:first">FIRST</p:code></person><person><p:code xmlns:p="urn:first">SECOND</p:code></person>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.person[0].code", value: "FIRST", type: "text" },
    { name: "form.person[1].code", value: "SECOND", type: "text" },
  ]);
});

test("A-4 (round 14): same-line spaces under <html> do not leak into the value (probe U2 shape)", async () => {
  // `<h:html> <h:body>Inside</h:body> </h:html>` used to flatten to
  // " Inside ". The round-13 whitespace control asserts newline
  // indentation flattens to "Inside", establishing that skeleton
  // formatting whitespace does not appear in the value — same-line
  // spaces must behave the same way.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html> <h:body>Inside</h:body> </h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("A-4 (round 14): same-line spaces under <html> do not leak even with xml:space preserve (probe U2b shape)", async () => {
  // Same leak under xml:space="preserve" on an ancestor. Preserve
  // governs actual body content (see the control below), not the
  // skeleton framing around it, so the skeleton spaces still do not
  // enter the value.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note xml:space="preserve"><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html> <h:body>Inside</h:body> </h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("A-4 (round 14): xml:space preserve still keeps body-content whitespace verbatim (control)", async () => {
  // Control proving the A-4 stripping is scoped to skeleton
  // positions, not body content: a newline between two <p> elements
  // inside a preserve <body> is kept ("A\nB"), while the same shape
  // without preserve skips it ("AB", the pre-existing default
  // behaviour). The fix must not flatten preserve semantics away.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body xml:space="preserve"><h:p>A</h:p>\n<h:p>B</h:p></h:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "A\nB", type: "unsupported" }]);
});

test("A-5 (round 14): non-whitespace text directly under <head> fails closed (probe U3 shape)", async () => {
  // <head> is a skeleton element, so its direct text is outside
  // <body> just as <html>-level text is — but the round-13 checks
  // covered <xhtml> and <html> only, so `<h:head>OUTSIDE</h:head>`
  // flattened to "OUTSIDEInside". It now fails closed with a 422,
  // under the same ordering rules as A-1 (throw only once the
  // container otherwise qualifies).
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:head>OUTSIDE</h:head><h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(
      error.message,
      /non-whitespace text directly under an XHTML skeleton element 'head'/,
    );
    return true;
  });
});

test("A-5 (round 14): an empty <head> still flattens to the body text (probe U3b control)", async () => {
  // Positive control for the U3 regression: an empty <head> beside
  // the body is legitimate skeleton and must still flatten to
  // "Inside". (This control also passes on round-13 code — it pins
  // the behaviour the fix must not break.)
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:head/><h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("Test adequacy (round 14): C1b is a no-namespace control only — prefixed same-namespace repeats still report as [0]/[1]", async () => {
  // The round-13 C1b control used unprefixed <code> siblings, so it
  // never exercised the resolved-namespace path at all. Two
  // <p:code> siblings in the SAME namespace (urn:first) are genuine
  // repeats through the prefixed path and must still report as
  // form.code[0]/[1].
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>',
      '<p:code xmlns:p="urn:first">FIRST</p:code><p:code xmlns:p="urn:first">SECOND</p:code>',
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.code[0]", value: "FIRST", type: "text" },
    { name: "form.code[1]", value: "SECOND", type: "text" },
  ]);
});

test("Test adequacy (round 14): small wide-and-failing-late shape reaches the classifier and has no data node", async () => {
  // Small companion to the rewritten wide test above: the same
  // shape at 3 paragraphs — contradictory `<c:other/>` first, then
  // the `<h:p/>` siblings — reaches the classifier (the distinct
  // local name passes convertEntries) and the ordinary-data walk,
  // where the field bound to form.note has no data node. This is
  // the ordinary-data-path outcome the wide shape cannot assert
  // directly, because its ~190k leaves trip the join-index bound
  // first.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body><c:other xmlns:c="urn:company"/><h:p/><h:p/><h:p/></h:body></h:html></h:xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.note.*has no data node/);
    return true;
  });
});

// --- B1 fix round 15 (re-review #14, cross-check panel, Nov 19, 2026) -----
// Regression tests for the seven converged P1s (B-1 cross-unit namespace
// agreement, B-2 position-based skeleton rule, B-3 exData wrapper framing,
// B-4 head-subtree text, B-5 unbound prefix in repeat agreement, B-6
// namespace-URI comparison work, B-7 NBSP+newline body content) plus the
// re-review's comment nits (fixed in place, see below). Probe shapes are
// noted per test.

test("B-1 (round 15): two scoped units assembling repeats from different namespaces fail closed (probe V1 shape)", async () => {
  // Two <subform name="s"> units dataRef-scoped to person[0] and
  // person[1], each resolving one <p:code> leaf in a DIFFERENT
  // namespace, used to report as form.person[0].code / [1].code —
  // indistinguishable from genuine repeats. The per-unit agreement
  // check cannot see it (one match per unit), so the units' matches
  // are pooled by stripped dataset path and compared across units.
  // The stated [N] boundary does not cover this: a single selector
  // narrowing to one leaf makes no claim of repeats, but two units
  // collectively reporting repeats of one template field do.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.person[0]"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="s"><bind match="dataRef" ref="$data.form.person[1]"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><p:code xmlns:p="urn:first">FIRST</p:code></person><person><p:code xmlns:p="urn:second">SECOND</p:code></person>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.s\.code.*different namespaces/);
    return true;
  });
});

test("B-1 (round 15): two scoped units in the same namespace still report as [0]/[1] (probe V1b control)", async () => {
  // Positive control for the V1 regression: the same shape with BOTH
  // codes in urn:first is genuine repeats through the scoped units
  // and must still report as form.person[0].code / [1].code.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.person[0]"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="s"><bind match="dataRef" ref="$data.form.person[1]"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><p:code xmlns:p="urn:first">FIRST</p:code></person><person><p:code xmlns:p="urn:first">SECOND</p:code></person>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.person[0].code", value: "FIRST", type: "text" },
    { name: "form.person[1].code", value: "SECOND", type: "text" },
  ]);
});

test("B-1 (round 15): units bound to different dataset paths are not compared (intentional bindings)", async () => {
  // Scope guard for the cross-unit check: two units of one template
  // field bound to DIFFERENT dataset paths (form.a.code vs
  // form.b.code, in different namespaces) are intentional bindings
  // to different data nodes, not repeats, and must still resolve —
  // the pool key is the stripped dataset path, so they are never
  // compared against each other.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.a"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="s"><bind match="dataRef" ref="$data.form.b"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<a><p:code xmlns:p="urn:first">FIRST</p:code></a><b><p:code xmlns:p="urn:second">SECOND</p:code></b>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.a.code", value: "FIRST", type: "text" },
    { name: "form.b.code", value: "SECOND", type: "text" },
  ]);
});

test("B-2 (round 15): a <head> nested in body content keeps its text (probe V3 shape)", async () => {
  // The round-14 skeleton strip was local-name-based: a <head> inside
  // <body> — body content, not skeleton — had its whitespace-only
  // text stripped ("A" instead of " A "). Skeleton position is now
  // carried from the classified frame, so body-content elements
  // named head/html/xhtml keep their text.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body><h:head xml:space="preserve"> <h:b>A</h:b> </h:head></h:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: " A ", type: "unsupported" }]);
});

test("B-2 (round 15): a <head> in body content keeps inter-element spaces (probe V4 shape)", async () => {
  // Same position defect with sibling <b> elements: the whitespace
  // between them is body content under a body-content <head>, not
  // skeleton formatting. (Round 16 refinement: the whitespace is a
  // NEWLINE, not a same-line space — a same-line space is kept
  // under default handling too (S-3), so the old " " shape could
  // not tell preserve from default. The newline is skipped under
  // default and kept under preserve, so this test now distinguishes
  // both: a regressed position-blind strip would drop it, and a
  // dropped preserve would skip it — either way "A\nB" becomes
  // "AB".)
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><body><head xml:space="preserve"><b>A</b>\n<b>B</b></head></body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "A\nB", type: "unsupported" }]);
});

test("B-2 (round 16): the V4 shape without preserve skips the newline (control)", async () => {
  // Control for the refined V4 test above: the same body-content
  // <head> shape with NO xml:space="preserve" anywhere skips the
  // newline between the <b> elements as formatting ("AB") — the
  // newline is kept only because the head preserves it.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><body><head><b>A</b>\n<b>B</b></head></body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "AB", type: "unsupported" }]);
});

test("B-2 (round 15): whitespace under a body-content <head> is kept (probe V5 shape)", async () => {
  // <body xml:space="preserve">A<head> </head>B</body>: the <head>
  // is body content, so its whitespace-only text is content — "A B",
  // not "AB".
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><body xml:space="preserve">A<head> </head>B</body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "A B", type: "unsupported" }]);
});

test("B-2 (round 15): an inner <xhtml> in body content is not skeleton text (probe V7 shape)", async () => {
  // The reverse direction: the classifier tracked only the immediate
  // parent's local name, so a <head> under an inner <xhtml> inside
  // body content triggered the skeleton-text 422. The inner <xhtml>
  // is body content, so its <head> text flattens as body content.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><body><xhtml><head>CONTENT</head></xhtml></body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "CONTENT", type: "unsupported" }]);
});

test("B-2 (round 15): whitespace under an inner body-content <xhtml> is body content (probe V7b shape)", async () => {
  // Same shape as V7 with whitespace-only head text. The space is
  // body content now, not skeleton formatting, so the value is " "
  // (round-14 code reported "" — the strip that produced it was the
  // position-blind rule this round removes).
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><body><xhtml><head> </head></xhtml></body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: " ", type: "unsupported" }]);
});

test("B-2 (round 15): text under a body-content <html> is kept, not rejected", async () => {
  // The <html>-direction of the same false rejection: an <html>
  // nested inside <body> is body content, so its direct text neither
  // throws as skeleton text nor gets stripped.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><body><html>TEXT</html></body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "TEXT", type: "unsupported" }]);
});

test("B-2 (round 15): template <items> text never applies the skeleton rule", async () => {
  // Template items carry no skeleton context at all: a <head> inside
  // an <items><text> used to have its space stripped ("Label"), but
  // it is template text, not rich-text framing — the space is kept.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="agree"><ui><checkButton/></ui><items><text><head> </head>Label</text></items><bind match="global"/></field>',
      `<agree>Label</agree>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.agree", value: "Label", type: "checkbox", onValues: [" Label"] },
  ]);
});

test("B-3 (round 15): same-line spaces under an <exData> wrapper do not leak (probe V2 shape)", async () => {
  // collectDataLeaves flattened the WRAPPER, not the classified inner
  // xhtml, so the wrapper's own direct spaces entered the value
  // (" Inside "). The classified inner node is flattened now, so the
  // wrapper framing contributes nothing.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><exData contentType="text/html"> <xhtml xmlns="http://www.w3.org/1999/xhtml"><body>Inside</body></xhtml> </exData></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("B-3 (round 15): newlines under an <exData> wrapper do not leak even with preserve (probe V2b shape)", async () => {
  // Same leak with preserve newlines around the inner xhtml:
  // "\nInside\n" used to be reported. Flattening the inner node
  // (with the wrapper's effective xml:space state carried into it)
  // reports "Inside".
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><exData contentType="text/html" xml:space="preserve">\n<xhtml xmlns="http://www.w3.org/1999/xhtml"><body>Inside</body></xhtml>\n</exData></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("B-3 (round 15): bare xhtml with same-line spaces still flattens clean (probe V2c control)", async () => {
  // Control for the V2/V2b regressions: a bare <xhtml> (no wrapper)
  // with same-line spaces beside it already flattened to "Inside"
  // — the wrapper fix must not change the bare case.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note> <xhtml xmlns="http://www.w3.org/1999/xhtml"><body>Inside</body></xhtml> </note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("B-3 (round 15): a preserve on the <exData> wrapper still governs body content", async () => {
  // The wrapper's effective xml:space state is carried into the inner
  // node, not dropped with the wrapper: a newline between two <p>
  // elements inside a preserve wrapper's body is kept ("A\nB").
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><exData contentType="text/html" xml:space="preserve"><xhtml xmlns="http://www.w3.org/1999/xhtml"><body><p>A</p>\n<p>B</p></body></xhtml></exData></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "A\nB", type: "unsupported" }]);
});

test("B-3 (round 15): newlines inside a default <exData> wrapper body are still skipped (control)", async () => {
  // Control for the preserve-carry test: without preserve anywhere,
  // the same newline between two <p> elements is formatting and is
  // skipped ("AB") — carrying the wrapper state must not invent a
  // preserve where there is none.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><exData contentType="text/html"><xhtml xmlns="http://www.w3.org/1999/xhtml"><body><p>A</p>\n<p>B</p></body></xhtml></exData></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "AB", type: "unsupported" }]);
});

test("B-4 (round 15): text nested in a skeleton <head> does not enter the value (probe V6 shape)", async () => {
  // A-5 covered only DIRECT text under <head>; nodeText() recursively
  // flattened the head's descendants, so a nested <title> leaked
  // ("OUTSIDEInside"). Head content is legitimate XHTML metadata,
  // not malformed input, so the head subtree is excluded from
  // flattening (not failed closed) — the value is the body text.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:head><h:title>OUTSIDE</h:title></h:head><h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("B-4 (round 15): a nested <span> in a skeleton <head> does not enter the value (probe V6b shape)", async () => {
  // Same leak through a non-title descendant: a <span> under the
  // skeleton <head> is head content too, and is excluded the same way.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:head><h:span>OUTSIDE</h:span></h:head><h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("B-4 (round 15): whitespace plus a nested title under a skeleton <head> still flattens to the body", async () => {
  // The head-subtree exclusion also covers the whitespace-only direct
  // text beside the nested title: neither the spaces nor the title
  // enter the value, and the whitespace does not throw (it is
  // XML-whitespace skeleton text, accepted as before).
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:head> <h:title>TITLE</h:title> </h:head><h:body>Inside</h:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("B-5 (round 15): an unbound prefix never agrees with no namespace in repeat validation", async () => {
  // DataLeaf carried only child.ns, so an unbound prefix (namespace
  // UNKNOWN) read as undefined and "agreed" with no-namespace:
  // <code>FIRST</code> + <p:code>SECOND</p:code> with p UNDECLARED
  // reported as [0]/[1] repeats. The unknown state is now carried
  // into repeat validation and fails closed when compared.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="person"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><code>FIRST</code></person><person><p:code>SECOND</p:code></person>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.person\.code.*unknown.*unbound prefix/);
    return true;
  });
});

test("B-5 (round 15): no-namespace vs a declared namespace still fails closed as a disagreement (control)", async () => {
  // Control for the unbound regression: the same shape with p
  // DECLARED (xmlns:p="urn:second") is the round-14 U1 disagreement
  // with the first leaf in no namespace — it must still fail closed,
  // now with the different-namespaces message rather than the
  // unknown-namespace one.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="person"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><code>FIRST</code></person><person><p:code xmlns:p="urn:second">SECOND</p:code></person>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.person\.code.*different namespaces/);
    return true;
  });
});

test("B-5 (round 15): two unbound prefixes never agree with each other either", async () => {
  // Both repeats carry the same undeclared prefix, but the namespace
  // is still unknown on both sides — two unknowns that might be
  // different namespaces cannot be established as repeats, so the
  // comparison fails closed rather than assuming the spelling
  // establishes identity.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="person"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><p:code>FIRST</p:code></person><person><p:code>SECOND</p:code></person>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.person\.code.*unknown.*unbound prefix/);
    return true;
  });
});

test("B-6 (round 15): many repeat matches sharing a long URI still resolve (interned comparison)", async () => {
  // Repeat agreement used to re-compare raw URI strings per matched
  // leaf per segment, so a long URI shared by many matches multiplied
  // the join work by its length. (Round 16 correction of this
  // comment: the ~6x timing and ~7 s extrapolation it used to cite
  // are removed — the timing did not isolate comparison work, and
  // the extrapolation was not a measurement.) URIs are interned to
  // ids once per inspect — once per element at walk time, through
  // the parent-linked namespace path (round 16, C-5/C-6) — and
  // compared as ids, so 200 repeats sharing a ~4 KiB URI resolve
  // exactly like short-URI repeats. No timing assertion: the
  // property under test is that the comparison path completes
  // correctly without tripping the structural budget — the timing
  // shape is pinned by the probe harness, not by a wall-clock
  // assertion in the suite. This test checks count + endpoints
  // only, as designed; the round-16 C-6 test pins the interning
  // contract more directly (inherited bindings, interning by
  // value across separately declared identical URIs).
  const longUri = `urn:${"x".repeat(4000)}`;
  const persons = Array.from(
    { length: 200 },
    (_, index) => `<person><p:code xmlns:p="${longUri}">V${index}</p:code></person>`,
  ).join("");
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="person"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      persons,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.equal(result.fields.length, 200);
  assert.deepEqual(result.fields[0], { name: "form.person[0].code", value: "V0", type: "text" });
  assert.deepEqual(result.fields[199], {
    name: "form.person[199].code",
    value: "V199",
    type: "text",
  });
});

test("B-7 (round 15): NBSP+newline body content is preserved, not dropped (probe T3 shape)", async () => {
  // nodeText()'s newline-skip rule used trim(), which treats NBSP as
  // whitespace, so "&#160;\n" between two <p> elements was dropped
  // ("AB"). The rule now uses isXmlWhitespace(), so a segment holding
  // a non-XML-whitespace character is preserved verbatim.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body><h:p>A</h:p>&#160;\n<h:p>B</h:p></h:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "A \nB", type: "unsupported" }]);
});

test("B-7 (round 15): plain space+newline body content is still skipped as formatting (control)", async () => {
  // Control for the T3 regression: a plain space plus newline between
  // the same <p> elements IS XML whitespace, so it is still skipped
  // as pretty-printing indentation ("AB", by design).
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body><h:p>A</h:p> \n<h:p>B</h:p></h:body></h:html></h:xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "AB", type: "unsupported" }]);
});

test("B-7 (round 15): NBSP+newline in a caption is preserved through normalization (caption variant)", async () => {
  // The same trim() rule lived in collectTextSegments(), the caption
  // path: NBSP+newline between two <b> elements was dropped ("AB").
  // The segment is now preserved, and caption normalization collapses
  // the NBSP+newline run to a single space ("A B").
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><caption><value><b>A</b>&#160;\n<b>B</b></value></caption><bind match="default"/></field>',
      `<note>X</note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "X", type: "text", label: "A B" }]);
});

test("B-7 (round 15): plain space+newline in a caption is still skipped (caption control)", async () => {
  // Control for the caption variant: a plain space plus newline is
  // XML whitespace, so it is still skipped and the caption flattens
  // to "AB".
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><caption><value><b>A</b> \n<b>B</b></value></caption><bind match="default"/></field>',
      `<note>X</note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "X", type: "text", label: "AB" }]);
});

// Regression tests for the six converged P1s (C-1 pooled-key
// re-materialization, C-2 singleton unbound prefix, C-3 unbound
// exData wrapper, C-4 same-leaf duplicate pooling, C-5 per-leaf
// namespace arrays, C-6 per-leaf URI interning) plus the re-review's
// test-adequacy items (body-content <html> boundary, wrapper-vs-inner
// xml:space, direct-root skeleton-head exclusion). Probe shapes are
// noted per test. All assertions are value/error assertions — no
// timing thresholds anywhere in this block.

test("C-1 (round 16): long-path overlapping pooling resolves once per leaf (probe shape)", async () => {
  // 16 overlapping units of one template field — 16 sibling <subform
  // name="s"> dataRef-scoped to the same 4-singleton chain + 8 KiB
  // segment, one [0]/bare variant per ancestor — each resolving the
  // same 50 <code> leaves. The round-15 pooling loop rebuilt the
  // stripped key per match per unit (16 × 50 × 8 KiB of key
  // construction here; 256 units × 50 × 8 KiB ≈ 100 MB in the probe
  // shape) before any merge bound could fire. Pooling now keys by
  // the canonical path id assigned once at index time and dedupes
  // by leaf identity, so the 50 leaves report once each with the
  // right values. Positive control by design: the old code reports
  // the same 50 fields (slowly) — the fix is work-accounting, and
  // no assertion-based test can observe removed key construction
  // except through the fail-closed budgets, which this shape stays
  // under (duplicate charges ≈ 6 MB of the 64 MiB budget; output
  // ≈ 410 KB of the 1 MiB bound).
  const longSeg = "a".repeat(8 * 1024);
  const leaves = Array.from({ length: 50 }, (_, i) => `<code>V${i}</code>`).join("");
  const units = Array.from({ length: 16 }, (_, variant) => {
    const selectors = [0, 1, 2, 3].map((level) =>
      (variant >> level) & 1 ? `a${level}[0]` : `a${level}`,
    );
    const ref = `$data.form.${selectors.join(".")}.${longSeg}`;
    return `<subform name="s"><bind match="dataRef" ref="${ref}"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>`;
  }).join("");
  const bytes = await createXfaPdf(
    wrap(units, `<a0><a1><a2><a3><${longSeg}>${leaves}</${longSeg}></a3></a2></a1></a0>`),
  );
  const result = await inspectPdf(bytes);
  assert.equal(result.fields.length, 50);
  assert.deepEqual(result.fields[0], {
    name: `form.a0.a1.a2.a3.${longSeg}.code[0]`,
    value: "V0",
    type: "text",
  });
  assert.deepEqual(result.fields[49], {
    name: `form.a0.a1.a2.a3.${longSeg}.code[49]`,
    value: "V49",
    type: "text",
  });
});

test("C-2 (round 16): a singleton default lookup with an undeclared prefix fails closed (probe X1)", async () => {
  // assertExpandedNamesAgree() used to return early when fewer than
  // two matches were compared, so a lone <p:code>VALUE</p:code>
  // with p undeclared resolved as form.code = "VALUE". The
  // documented [N] boundary covers selecting one leaf in a KNOWN
  // foreign namespace — an undeclared prefix has no expanded name,
  // so the singleton fails closed on the unknown namespace.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>',
      `<p:code>VALUE</p:code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.code.*unknown.*unbound prefix/);
    assert.doesNotMatch(error.message, /VALUE/);
    return true;
  });
});

test("C-2 (round 16): a singleton global lookup with an undeclared prefix fails closed (probe X1b)", async () => {
  // The global path never called the agreement check at all, so the
  // same undeclared-prefix singleton resolved there too. The
  // first-same-named-leaf rule does not exempt the leaf from the
  // unknown-namespace rule.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="global"/></field>',
      `<p:code>VALUE</p:code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.code.*unknown.*unbound prefix/);
    return true;
  });
});

test("C-2 (round 16): a selector-narrowed singleton with an undeclared prefix fails closed (probe X1c)", async () => {
  // A [0] selector narrowing to one leaf is not a repeat claim, but
  // it is not an exemption from the unknown-namespace rule either:
  // the selected leaf's prefix is undeclared, so its expanded name
  // is unknown and the lookup fails closed.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.person[0].code"/></field>',
      `<person><p:code>VALUE</p:code></person>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.code.*unknown.*unbound prefix/);
    return true;
  });
});

test("C-2 (round 16): a singleton in a DECLARED foreign namespace still resolves (probe X1d control)", async () => {
  // Control for the X1/X1b/X1c regressions: the same singleton
  // shape with p DECLARED (xmlns:p="urn:second") is the decided
  // [N] boundary — one leaf in a known foreign namespace — and
  // must still report "VALUE".
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>',
      `<p:code xmlns:p="urn:second">VALUE</p:code>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.code", value: "VALUE", type: "text" }]);
});

test("C-3 (round 16): an unbound exData wrapper does not disappear into a rich-text binding (probe X3)", async () => {
  // <p:exData> with p undeclared wrapping correctly-namespaced
  // <h:xhtml> used to flatten to "Inside": isRichTextContainer
  // checked the wrapper's local name/group/content-type/shape but
  // never its namespace state, and the emitted leaf's path is the
  // parent's, so the wrapper never appeared in any namespace check.
  // The unknown wrapper now defeats classification — the parent
  // recurses as ordinary data, so the field has no data node.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><p:exData contentType="text/html"><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body>Inside</h:body></h:html></h:xhtml></p:exData></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.note.*has no data node/);
    assert.doesNotMatch(error.message, /Inside/);
    return true;
  });
});

test("C-3 (round 16): a DECLARED exData wrapper around genuine XHTML still flattens (probe X3b control)", async () => {
  // Control for the X3 regression: the same wrapper with p
  // DECLARED (xmlns:p="urn:wrapper") is the documented case of a
  // known unrelated wrapper namespace around genuine inner XHTML,
  // and must still report "Inside".
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><p:exData contentType="text/html" xmlns:p="urn:wrapper"><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body>Inside</h:body></h:html></h:xhtml></p:exData></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("C-4 (round 16): one leaf, two overlapping units, unbound prefix fails closed on the prefix — not on repeats (probe X2)", async () => {
  // Two units scoped $data.form.person and $data.form.person[0] on
  // ONE leaf with undeclared p used to throw a repeats error: the
  // pooling loop appended the same DataLeaf twice and the agreement
  // check compared it with itself. Pooling now dedupes by leaf
  // identity, so the pooled set is one leaf — and the deduped
  // singleton then fails closed on its unbound prefix (C-2), which
  // is the correct failure: the message names the unknown
  // namespace, never repeats.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.person"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="s"><bind match="dataRef" ref="$data.form.person[0]"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><p:code>VALUE</p:code></person>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.s\.code.*unknown.*unbound prefix/);
    assert.doesNotMatch(error.message, /repeats/);
    return true;
  });
});

test("C-4 (round 16): one leaf, two overlapping units, declared namespace resolves once (probe X2b control)", async () => {
  // Control for the X2 regression: the same two-unit shape with p
  // DECLARED resolves the one leaf once — the overlapping scopes
  // merge onto the shared data node instead of reporting it twice.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.person"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="s"><bind match="dataRef" ref="$data.form.person[0]"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><p:code xmlns:p="urn:first">VALUE</p:code></person>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.person.code", value: "VALUE", type: "text" }]);
});

test("C-4 (round 16): one leaf, two overlapping units, no namespace resolves once (probe X2c control)", async () => {
  // Control for the X2 regression: the same two-unit shape with no
  // namespace at all likewise resolves the one leaf once.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.person"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="s"><bind match="dataRef" ref="$data.form.person[0]"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><code>VALUE</code></person>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.person.code", value: "VALUE", type: "text" }]);
});

test("C-5 (round 16): deep/wide field-less allocation reports zero fields", async () => {
  // The probe shape: a 40-deep chain ending in 20,000 empty sibling
  // leaves, under a field-less template — a form yielding ZERO
  // fields. Every leaf used to retain three full namespace arrays
  // before any index check ran. Leaf collection is now skipped
  // entirely when the template has no fields (the datasets packet
  // is still parsed and validated), and the leaves that ARE
  // collected carry one parent-linked namespace path pointer, not
  // per-leaf arrays. Assertion-based: the count/bound under test
  // is the zero-field result itself, not wall-clock time.
  let inner = Array.from({ length: 20000 }, (_, i) => `<f${i}/>`).join("");
  for (let depth = 0; depth < 40; depth++) inner = `<d${depth}>${inner}</d${depth}>`;
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"></subform></template>',
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form>${inner}</form></xfa:data></xfa:datasets>`,
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, []);
});

test("C-5 (round 16): a field-less form with a dataset classification error still reports zero fields", async () => {
  // JUDGMENT CALL for the re-review to rule on: skipping leaf
  // collection for field-less templates also skips
  // classification-only errors inside the datasets — non-whitespace
  // text directly under an XHTML skeleton element used to throw
  // here during collection (isXhtmlDocument), and now reports zero
  // fields instead. The datasets packet is still parsed and
  // validated (malformed XML still fails closed); only the leaf
  // classification a field-less report has nothing to classify for
  // is skipped. If the panel prefers the throw, the skip must be
  // narrowed to plain leaves.
  const bytes = await createXfaPdf(
    wrap(
      "",
      `<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><html>TEXT<body>Inside</body></html></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, []);
});

test("C-6 (round 16): repeat leaves inheriting the same long URI from separately declared parents still agree (interning by value)", async () => {
  // Each <person> declares xmlns:p to the SAME ~4 KiB URI text, but
  // each declaration is a distinct string object from the parser,
  // and each <code> inherits the URI through its parent's bindings
  // rather than declaring it. Interning must canonicalize by VALUE
  // (one id for the one URI) and carry the id through the inherited
  // binding — the round-15 code paid a per-leaf string-key lookup
  // per segment for exactly this shape. Pins the interning contract
  // more directly than the B-6 test, which checks count + endpoints
  // only. No timing assertion.
  const longUri = `urn:${"x".repeat(4000)}`;
  const persons = Array.from(
    { length: 200 },
    (_, index) => `<person xmlns:p="${longUri}"><p:code>V${index}</p:code></person>`,
  ).join("");
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="person"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      persons,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.equal(result.fields.length, 200);
  assert.deepEqual(result.fields[0], { name: "form.person[0].code", value: "V0", type: "text" });
  assert.deepEqual(result.fields[199], {
    name: "form.person[199].code",
    value: "V199",
    type: "text",
  });
});

test("C-7 (round 16): a body-content <html> with non-head/body children defeats rich text", async () => {
  // The <html>-child shape rule stays whole-subtree (round 16
  // ruling): an <html> nested inside <body> is body content, so
  // its direct text is kept (see the B-2 body-content <html> test)
  // — but an <html> whose children are not <head>/<body> only
  // (<div> here) defeats the classification, wherever it sits.
  // The container recurses as ordinary data, so the field bound to
  // the group itself has no data node.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><body><html><div>Deep</div></html></body></xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.note.*has no data node/);
    assert.doesNotMatch(error.message, /Deep/);
    return true;
  });
});

test("C-7 (round 16): a skeleton-position <html> with direct text still throws the skeleton error (contrast)", async () => {
  // Contrast for the body-content defeat above: the SAME <html>
  // shape at a skeleton position (direct child of the <xhtml>
  // frame) with non-whitespace direct text is not a defeat — it is
  // the skeleton-text error, because the text sits outside <body>.
  // The two shapes must fail with different messages.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><html>TEXT<body>Inside</body></html></xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(
      error.message,
      /non-whitespace text directly under an XHTML skeleton element 'html'/,
    );
    return true;
  });
});

test("C-7 (round 16): an inner xhtml xml:space=default overrides a preserve wrapper", async () => {
  // Wrapper-vs-inner xml:space disagreement: the wrapper carries
  // preserve, the inner <xhtml> declares default. The inner
  // element's own state governs its subtree (nodeText applies the
  // inner element's attribute over the carried-in state), so the
  // newline between the <p> elements is formatting and skipped
  // ("AB") — the wrapper's preserve does not leak past the inner
  // declaration.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><exData contentType="text/html" xml:space="preserve"><xhtml xmlns="http://www.w3.org/1999/xhtml" xml:space="default"><body><p>A</p>\n<p>B</p></body></xhtml></exData></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "AB", type: "unsupported" }]);
});

test("C-7 (round 16): an inner xhtml xml:space=preserve overrides a default wrapper", async () => {
  // The disagreement in the other direction: the wrapper carries
  // no preserve, the inner <xhtml> declares preserve. The inner
  // state governs, so the newline between the <p> elements is
  // content and kept ("A\nB").
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><exData contentType="text/html"><xhtml xmlns="http://www.w3.org/1999/xhtml" xml:space="preserve"><body><p>A</p>\n<p>B</p></body></xhtml></exData></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "A\nB", type: "unsupported" }]);
});

test("C-7 (round 16): a <head> directly under the <xhtml> frame root is metadata, not body content", async () => {
  // Direct-root skeleton-head metadata exclusion (B-4, round 15,
  // extended to the frame root itself): a <head> that is a DIRECT
  // child of the classified <xhtml> frame — not only a <head> under
  // <html> — contributes nothing to the value. Its whole subtree
  // (the <title> here) is XHTML metadata, so the value is the body
  // text only.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><head><title>META</title></head><body>Body</body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Body", type: "unsupported" }]);
});

// --- B1 fix round 17 (re-review #16, cross-check panel, Nov 20, 2026) -----
// Regression tests for the three converged P1s (D-1 parent-linked
// segment paths, D-2 unbound structural names, D-3 unbound dataNode
// attribute) plus the re-review's test-adequacy items (lookup-key
// cache hit/miss, "join lookup exceeds", separate C-6 tests,
// dedupe counter, field-less SOM-name scope, exData node-side
// consistency). Probe shapes are noted per test. All assertions
// are value/error/counter assertions, with ONE timing assertion:
// the D-1 test's gross-slowness guard (elapsed < 20 s, in the style
// of the existing U2 guard) — a slowness guard, not a performance
// measurement. (E-9a, round 18) The earlier wording here ("no timing
// thresholds except the one gross-slowness guard") understated it:
// the D-1 test DOES assert on elapsed time, and that is the only
// timing assertion in this block.
// Test-breakdown correction (4a): the round-16 brief claimed C-1 ×2,
// C-5 ×3, C-6 ×2, C-7 ×3; the diff actually has C-1 ×1, C-5 ×2,
// C-6 ×1, C-7 ×5 (total still 19). The missing tests are added
// here: lookup-key-cache (hit + miss), field-present deep/wide
// (D-1), separate C-6 tests, "join lookup exceeds", keyCache
// hit/miss.

test("D-1 (round 17): a field-present deep/wide form resolves its one field (probe D1 shape)", async () => {
  // The round-16 C-5 test is field-less and never reaches this path:
  // one bound field makes collection run over the whole dataset.
  // The probe shape (40-deep chain, 20,000 empty sibling leaves)
  // used to retain one `segments` array per leaf, built by
  // `[...path, segment]` per child before the index budget charged
  // anything (1,936 ms / +263 MiB probed on round-16 code). The
  // segment path is now parent-linked (one SegPath node per
  // element, shared by the subtree), the occurrence index is built
  // lazily per bucket, and the 20,000 sibling leaves are never
  // pooled (pooledLeafCount() === 1: only the matched `ok` leaf).
  // (E-4, round 18) The pooled-leaf counter does NOT pin the
  // allocation fix — pooling is unchanged by it (the siblings were
  // never pooled on round-16 code either); it pins pooling only.
  // segmentArrayCount() === 20,001 pins the lazy-memoized
  // materialization mechanism instead: every indexed leaf's array
  // is built exactly once, after its charge (20,000 siblings + the
  // `ok` leaf). The allocation fix itself is proven by the heap
  // probe (panel/probe-rereview17.mts E5), not by either counter.
  // Assertion-based: the one field, its value, and the two
  // counters; the gross time guard is the U2-style slowness guard
  // only — and it IS a timing assertion (see the block header).
  let inner = Array.from({ length: 20000 }, (_, i) => `<leaf${i}/>`).join("");
  for (let d = 40; d >= 1; d--) inner = `<d${d}>${inner}</d${d}>`;
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"><field name="ok"><ui><textEdit/></ui><bind match="default"/></field></subform></template>',
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><ok>V</ok>${inner}</form></xfa:data></xfa:datasets>`,
  });
  const started = Date.now();
  const result = await inspectPdf(bytes);
  assert.ok(Date.now() - started < 20000, `D-1 inspect took ${Date.now() - started}ms`);
  assert.deepEqual(result.fields, [{ name: "form.ok", value: "V", type: "text" }]);
  assert.equal(pooledLeafCount(), 1);
  assert.equal(segmentArrayCount(), 20001);
});

test("D-1 (round 17): the bind-none variant of the deep/wide shape also resolves (probe D1b shape)", async () => {
  // One `bind match="none"` field brings the whole allocation back
  // on round-16 code (1,482 ms / +263.9 MiB probed): the field-less
  // skip only triggers at zero fields, so a single unbound field
  // still collects the entire dataset. The parent-linked path
  // covers it the same way — the field never consults the leaves
  // it forces collection of.
  let inner = Array.from({ length: 20000 }, (_, i) => `<leaf${i}/>`).join("");
  for (let d = 40; d >= 1; d--) inner = `<d${d}>${inner}</d${d}>`;
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"><field name="ok"><ui><textEdit/></ui><bind match="none"/></field></subform></template>',
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><ok>V</ok>${inner}</form></xfa:data></xfa:datasets>`,
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.ok", value: "", type: "unsupported" }]);
});

test("D-2 (round 17): an unbound <p:data> wrapper fails closed (probe D2)", async () => {
  // The data root was selected by local name without checking
  // nsUnbound, so <p:data> with `p` undeclared resolved silently.
  const wrapped = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><p:data><form><code>VALUE</code></form></p:data></xfa:datasets>',
  });
  await assert.rejects(inspectPdf(wrapped), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:data.*unbound prefix/);
    assert.doesNotMatch(error.message, /VALUE/);
    return true;
  });
});

test("D-2 (round 17): an unbound <p:datasets> wrapper fails closed (probe D2b)", async () => {
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform></template>',
    datasetsXml:
      '<p:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><code>VALUE</code></form></xfa:data></p:datasets>',
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:datasets.*unbound prefix/);
    assert.doesNotMatch(error.message, /VALUE/);
    return true;
  });
});

test("D-2 (round 17): an unbound <p:template> root fails closed (probe D2c)", async () => {
  const bytes = await createXfaPdf({
    templateXml:
      '<p:template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform></p:template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><code>VALUE</code></form></xfa:data></xfa:datasets>',
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:template.*unbound prefix/);
    assert.doesNotMatch(error.message, /VALUE/);
    return true;
  });
});

test("D-2 (round 17): a DECLARED <p:data> wrapper still resolves (probe D2d control)", async () => {
  // Control: the same wrapper with `p` DECLARED (a known foreign
  // namespace) is not an unknown name and must still report "VALUE".
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/" xmlns:p="urn:example:data"><p:data><form><code>VALUE</code></form></p:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.code", value: "VALUE", type: "text" }]);
});

test("D-2 (round 17): an unbound <p:subform> fails closed", async () => {
  // A subform establishes scope, so an unbound <p:subform> is a
  // structural name that must fail closed, not a wrapper to skip.
  const bytes = await createXfaPdf(
    wrap(
      '<p:subform name="s"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></p:subform>',
      `<s><code>VALUE</code></s>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:subform.*unbound prefix/);
    assert.doesNotMatch(error.message, /VALUE/);
    return true;
  });
});

test("D-2 (round 17): an unbound <p:exclGroup> fails closed", async () => {
  // An exclGroup establishes a group field, so an unbound
  // <p:exclGroup> fails closed like an unbound <p:field>.
  const bytes = await createXfaPdf(
    wrap(
      '<p:exclGroup name="pay"><bind match="global"/><field name="card"><ui><checkButton/></ui><items><text>card</text></items><bind match="global"/></field></p:exclGroup>',
      `<pay>card</pay>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:exclGroup.*unbound prefix/);
    return true;
  });
});

test('D-2 (round 17): an unbound <p:bind match="none"/> fails closed (probe D3)', async () => {
  // The bind was honoured without a namespace check, so the field
  // reported blank/unsupported as if `none` had been declared.
  // An undeclared prefix is unknown, not "none" — fail closed.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><p:bind match="none"/></field>',
      `<code>VALUE</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:bind.*unbound prefix/);
    assert.doesNotMatch(error.message, /VALUE/);
    return true;
  });
});

test("D-2 (round 17): an unbound <p:field> fails closed (probe D3b)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<p:field name="code"><ui><textEdit/></ui><bind match="default"/></p:field>',
      `<code>VALUE</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:field.*unbound prefix/);
    assert.doesNotMatch(error.message, /VALUE/);
    return true;
  });
});

test("D-2 (round 17): a DECLARED <p:field> still resolves (probe D3c control)", async () => {
  // Control: the same field with `p` DECLARED on the template root
  // is a known foreign namespace and must still report "VALUE".
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/" xmlns:p="urn:example:tmpl"><subform name="form" layout="tb"><p:field name="code"><ui><textEdit/></ui><bind match="default"/></p:field></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><code>VALUE</code></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.code", value: "VALUE", type: "text" }]);
});

test('D-2 (round 17): an unbound <p:bind match="dataRef"/> fails closed (probe E1)', async () => {
  // The binding element's unknown namespace was ignored AND it
  // redirected resolution: the field reported form.other = "OTHER"
  // from an uninterpretable binding element. (Dispute recorded in
  // requireKnownNamespace: Sonnet graded this P2/policy; the
  // coordinator adopted it as P1 per the round-11 unbound-prefix
  // policy and the C-2 singleton precedent.)
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><p:bind match="dataRef" ref="$data.form.other"/></field>',
      `<other>OTHER</other><code>CODE</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:bind.*unbound prefix/);
    assert.doesNotMatch(error.message, /OTHER/);
    return true;
  });
});

test('D-2 (round 17): a DECLARED <p:bind match="dataRef"/> still redirects (probe E1b control)', async () => {
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/" xmlns:p="urn:example:tmpl"><subform name="form" layout="tb"><field name="code"><ui><textEdit/></ui><p:bind match="dataRef" ref="$data.form.other"/></field></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><other>OTHER</other><code>CODE</code></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.other", value: "OTHER", type: "text" }]);
});

test('D-2 (round 17): a plain <bind match="dataRef"/> still redirects (probe E1c control)', async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="dataRef" ref="$data.form.other"/></field>',
      `<other>OTHER</other><code>CODE</code>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.other", value: "OTHER", type: "text" }]);
});

test("D-3 (round 17): an unbound p:dataNode attribute fails closed (probe D4)", async () => {
  // attrInNamespace() ignored the unresolvable prefix and the
  // fallback applied only to the literal `xfa:dataNode` spelling,
  // so <note p:dataNode="dataGroup"> with `p` undeclared classified
  // as rich text and reported "Inside" despite the unknown
  // attribute namespace.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note p:dataNode="dataGroup"><xhtml xmlns="http://www.w3.org/1999/xhtml"><body>Inside</body></xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /dataNode.*unbound prefix/);
    assert.doesNotMatch(error.message, /Inside/);
    return true;
  });
});

test("D-3 (round 17): a literal xfa:dataNode still defeats the group (probe D4b control)", async () => {
  // Control: the documented literal-`xfa:dataNode` fallback — the
  // `xfa` prefix UNDECLARED anywhere in scope — is still read as
  // the XFA marking, so the field has no data node. (E-5, round
  // 18) The earlier version of this test declared `xmlns:xfa` on
  // the <note> AND inherited it from wrap()'s datasets root, so it
  // never reached the fallback path (`!element.bindings.has("xfa")`)
  // at all. This version declares no `xfa` prefix anywhere: the
  // datasets roots are unprefixed <datasets>/<data>, and the note
  // carries the literal spelling only. The declared-prefix spelling
  // is covered by the D4c control below (the resolved branch of
  // dataNodeValue, any prefix bound to the XFA data namespace).
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"><field name="note"><ui><textEdit/></ui><bind match="default"/></field></subform></template>',
    datasetsXml:
      '<datasets><data><form><note xfa:dataNode="dataGroup"><xhtml xmlns="http://www.w3.org/1999/xhtml"><body>Inside</body></xhtml></note></form></data></datasets>',
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.note.*has no data node/);
    return true;
  });
});

test("D-3 (round 17): a DECLARED p:dataNode still defeats the group (probe D4c control)", async () => {
  // Control: `p` DECLARED to the XFA data namespace — the marking
  // is a known expanded name and still defeats the group.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note xmlns:p="http://www.xfa.org/schema/xfa-data/1.0/" p:dataNode="dataGroup"><xhtml xmlns="http://www.w3.org/1999/xhtml"><body>Inside</body></xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.note.*has no data node/);
    return true;
  });
});

test("D-3/h (round 17): an unbound <p:exData> wrapper standing as the bound node fails closed", async () => {
  // Node-side consistency with the parent-side C-3 check: when the
  // walk stands ON an unbound <p:exData> wrapper (here the field
  // binds to the wrapper node itself, with a sibling so the parent
  // does not classify as rich text first), its bare <xhtml> child
  // must not classify the wrapper as a rich-text leaf.
  // (E-6, round 18) This test discriminates on the ERROR MESSAGE,
  // not on the 422-vs-value outcome: without the node-side guard
  // the same shape still fails closed via the C-2 parent-side
  // check, with different wording — only the "has no data node"
  // wording for the bound node itself pins the node-side guard.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="note"><field name="exData"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<note><other>X</other><p:exData contentType="text/html"><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body>Inside</h:body></h:html></h:xhtml></p:exData></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /mismatch.*form\.note\.exData.*has no data node/);
    assert.doesNotMatch(error.message, /Inside/);
    return true;
  });
});

test("D-3/h (round 17): a DECLARED <p:exData> wrapper standing as the bound node still flattens (control)", async () => {
  // Control for the node-side check above: the same wrapper with
  // `p` DECLARED is a known namespace and still flattens to
  // "Inside" as an unsupported rich-text leaf.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="note"><field name="exData"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<note><other>X</other><p:exData contentType="text/html" xmlns:p="urn:wrapper"><h:xhtml xmlns:h="http://www.w3.org/1999/xhtml"><h:html><h:body>Inside</h:body></h:html></h:xhtml></p:exData></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.note.exData", value: "Inside", type: "unsupported" },
  ]);
});

test("C-1 (round 17): a second lookup under the same scope and leaf name reuses the cached key (hit)", async () => {
  // Deterministic counter for the keyCache hit claim (4a): two
  // template fields under the same interned scope (one subform
  // dataRef-bound absolutely, one relatively — both fold to the
  // same scope id) with the same leaf name look up the same key
  // twice, but the aggregate budget is charged once: the second
  // lookup is a hit. The two fields resolve to the same data node
  // and fail closed on the public-name collision — the collision
  // error (not a budget error) is itself the evidence the second
  // lookup ran, and lookupKeyMissCount() === 1 proves it was a
  // hit. (E-9c, round 18) The earlier wording claimed a
  // budget-boundary test alone CANNOT show a hit: that is not
  // universal. The two boundary designs tried in round 17 (L=1.4M
  // hit, L=600k miss) both made the resolved field's public name
  // trip the 1 MiB output bound first, so those designs fail — but
  // a budget-boundary design may exist, and this counter pin stands
  // on its own rather than as proof that none does.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.shared"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="t"><bind match="dataRef" ref="shared"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<shared><code>VALUE</code></shared>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /resolve to the same data node/);
    assert.doesNotMatch(error.message, /join lookup exceeds/);
    return true;
  });
  assert.equal(lookupKeyMissCount(), 1);
});

test("C-1 (round 17): two leaf names under one scope charge two lookup keys (miss)", async () => {
  // Companion to the hit test: two DIFFERENT leaf names under one
  // scope are two distinct keys, so both lookups miss and charge.
  // Both fields resolve, so the counter is read after a success.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.shared"/><field name="code1"><ui><textEdit/></ui><bind match="default"/></field><field name="code2"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<shared><code1>ONE</code1><code2>TWO</code2></shared>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.shared.code1", value: "ONE", type: "text" },
    { name: "form.shared.code2", value: "TWO", type: "text" },
  ]);
  assert.equal(lookupKeyMissCount(), 2);
});

test('C-1 (round 17): a lookup key past the shared budget fails closed as a lookup ("join lookup exceeds")', async () => {
  // The shared pathBytes budget (4 MiB, index + lookups together):
  // one leaf under a 2.5 MiB ancestor charges ~2.5 MiB at index
  // time (under the bound), and its lookup key charges another
  // ~2.5 MiB — the total trips on the LOOKUP charge, so the
  // message names the lookup site, not the index. (4d documents
  // the shared-budget behaviour change in code + SPEC.)
  const longSeg = "a".repeat(2_500_000);
  const bytes = await createXfaPdf({
    templateXml: `<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"><subform name="s"><bind match="dataRef" ref="$data.form.${longSeg}"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform></subform></template>`,
    datasetsXml: `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><${longSeg}><code>VALUE</code></${longSeg}></form></xfa:data></xfa:datasets>`,
  });
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /join lookup exceeds 4194304 bytes/);
    return true;
  });
});

test("C-6 (round 17): repeat leaves under different prefixes bound to the SAME URI still agree", async () => {
  // Interning is by namespace URI VALUE, not by prefix spelling:
  // <p:code> and <q:code> with p and q both bound to urn:shared
  // are the same expanded name, so the repeats agree.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="person"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person xmlns:p="urn:shared"><p:code>V0</p:code></person><person xmlns:q="urn:shared"><q:code>V1</q:code></person>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.person[0].code", value: "V0", type: "text" },
    { name: "form.person[1].code", value: "V1", type: "text" },
  ]);
});

test("C-6 (round 17): repeat leaves in URIs differing only by case fail closed as different namespaces", async () => {
  // The converse pin: interning compares the URI string exactly,
  // so urn:AAA and urn:aaa are different namespaces and the
  // repeats fail closed instead of reporting as one field.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="person"><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person xmlns:p="urn:AAA"><p:code>V0</p:code></person><person xmlns:p="urn:aaa"><p:code>V1</p:code></person>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /different namespaces for segment 'code'/);
    return true;
  });
});

test("C-4 (round 17): dedupe is observable — one leaf, two overlapping units, pooled once (counter)", async () => {
  // (4b) The X2 test does not discriminate dedupe: it fails in
  // findLeaves() before pooling. This shape does: two units of one
  // template field resolve overlapping leaf sets (unit 1: both
  // person codes; unit 2: person[0] only), and the pooled-leaf
  // counter proves the shared leaf was pooled ONCE (2, not 3) —
  // the deterministic counter in the style of countXmlScanSteps.
  // A value assertion alone cannot observe dedupe: deduped and
  // un-deduped runs report the same two fields.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.person"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="s"><bind match="dataRef" ref="$data.form.person[0]"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><code>V0</code></person><person><code>V1</code></person>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.person[0].code", value: "V0", type: "text" },
    { name: "form.person[1].code", value: "V1", type: "text" },
  ]);
  assert.equal(pooledLeafCount(), 2);
});

test("C-4 (round 17): the X2b control pools its one shared leaf once (counter)", async () => {
  // Companion to the dedupe test above, on the existing X2b
  // control shape (one leaf, two overlapping units, DECLARED
  // namespace): the leaf resolves once and is pooled once.
  const bytes = await createXfaPdf(
    wrap(
      '<subform name="s"><bind match="dataRef" ref="$data.form.person"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>' +
        '<subform name="s"><bind match="dataRef" ref="$data.form.person[0]"/><field name="code"><ui><textEdit/></ui><bind match="default"/></field></subform>',
      `<person><code xmlns:p="urn:first">VALUE</code></person>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.person.code", value: "VALUE", type: "text" }]);
  assert.equal(pooledLeafCount(), 1);
});

test("C-5/e (round 17): the field-less skip also drops collection-time SOM-name validation", async () => {
  // (4e) The skip is broader than "no leaves": validateSomName runs
  // inside collectDataLeaves, so a field-less form with a dotted
  // dataset name (<a.b>) passes while the same datasets under a
  // one-field template fail closed. Documented in SPEC.md §1; this
  // test pins the behaviour.
  const fieldless = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb"></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><a.b>X</a.b></form></xfa:data></xfa:datasets>',
  });
  assert.deepEqual((await inspectPdf(fieldless)).fields, []);
  const withField = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>',
      `<a.b>X</a.b><code>VALUE</code>`,
    ),
  );
  await assert.rejects(inspectPdf(withField), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /cannot be represented in a SOM path/);
    return true;
  });
});

// --- B1 fix round 18 (re-review #17, SONNET TEST, Nov 21, 2026) --------
// Regression tests for the converged findings (E-1 unnamed unbound
// exclGroup option — the round-17 P1; E-2 xmlns:dataNode false
// rejection; E-3 unbound ui/items/caption/value metadata) plus the
// re-review's test-adequacy items (E-4 segment-array counter in the
// D-1 test, E-5 genuine undeclared-xfa D4b, E-6 (h) message
// discrimination, E-9a timing wording, E-9c cache-hit wording —
// those five are comment/test-shape corrections in the round-17
// block above, not new tests here). Probe shapes are noted per
// test. All assertions are value/error/counter assertions; no test
// in this block asserts on elapsed time.

test("E-1 (round 18): an unnamed unbound option field in an exclGroup fails closed (probe E1)", async () => {
  // The unnamed-option branch read <items> and contributed the
  // option without ever reaching buildTemplateField, so its
  // requireKnownNamespace never ran: form.pay reported options
  // ["UNDEFINED-OPTION"] from an unbound <p:field>. The guard now
  // runs at the top of the option loop, before the name branches.
  const bytes = await createXfaPdf(
    wrap(
      '<exclGroup name="pay"><bind match="default"/><p:field><items><text>UNDEFINED-OPTION</text></items></p:field></exclGroup>',
      `<pay>VALUE</pay>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:field.*unbound prefix/);
    assert.doesNotMatch(error.message, /UNDEFINED-OPTION/);
    return true;
  });
});

test("E-1 (round 18): a DECLARED unnamed option field in an exclGroup still reports (probe E1b control)", async () => {
  // Control: the same option with `p` DECLARED is a known foreign
  // namespace and must still report as the group's option.
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/" xmlns:p="urn:example:tmpl"><subform name="form" layout="tb"><exclGroup name="pay"><bind match="default"/><p:field><items><text>DECLARED-OPTION</text></items></p:field></exclGroup></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><pay>VALUE</pay></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.pay", value: "VALUE", type: "unsupported", options: ["DECLARED-OPTION"] },
  ]);
});

test("E-1 (round 18): a NAMED unbound option field in an exclGroup still fails closed (probe E1c control)", async () => {
  // Control: the named path was already guarded (via
  // buildTemplateField) — the hole was exactly the unnamed branch.
  const bytes = await createXfaPdf(
    wrap(
      '<exclGroup name="pay"><bind match="default"/><p:field name="x"><items><text>OPT</text></items></p:field></exclGroup>',
      `<pay>VALUE</pay>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:field.*unbound prefix/);
    assert.doesNotMatch(error.message, /OPT/);
    return true;
  });
});

test("E-2 (round 18): a legal xmlns:dataNode declaration is not an unbound prefix (probe E2)", async () => {
  // `<note xmlns:dataNode="urn:x">` DECLARES a prefix named
  // `dataNode`; it carries no dataNode attribute. The old
  // dataNodeValue loop read the declaration's `xmlns` prefix
  // against `bindings` (which never contains "xmlns") and threw
  // "unbound prefix 'xmlns'". The note is plain rich text and must
  // report "Inside", exactly like the E2c control.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note xmlns:dataNode="urn:x"><xhtml xmlns="http://www.w3.org/1999/xhtml"><body>Inside</body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("E-2 (round 18): a plain rich-text note still reports its body text (probe E2c control)", async () => {
  // Control: no dataNode attribute at all — the note classifies as
  // rich text and reports "Inside". (The E2b control — a DECLARED
  // p:dataNode="dataGroup" failing closed with "has no data node" —
  // is the round-17 D4c test; not duplicated here.)
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note><xhtml xmlns="http://www.w3.org/1999/xhtml"><body>Inside</body></xhtml></note>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [{ name: "form.note", value: "Inside", type: "unsupported" }]);
});

test("E-3 (round 18): an unbound <p:checkButton/> inside <ui> fails closed (probe E3)", async () => {
  // The <ui> child was read by local name without a namespace
  // check, so an unbound <p:checkButton/> still made the field a
  // checkbox with on-values ["1"]. The value itself was correct —
  // this is a policy-completeness gap (P2), not a wrong value.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><p:checkButton/></ui><items><text>1</text><text>0</text></items><bind match="default"/></field>',
      `<code>1</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:checkButton.*unbound prefix/);
    return true;
  });
});

test("E-3 (round 18): an unbound <p:ui> wrapper fails closed (probe E3b)", async () => {
  // The <ui> element itself was read by local name, so an unbound
  // <p:ui> wrapper around a checkButton likewise established UI
  // semantics from an unknown namespace.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><p:ui><checkButton/></p:ui><items><text>1</text><text>0</text></items><bind match="default"/></field>',
      `<code>1</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:ui.*unbound prefix/);
    return true;
  });
});

test("E-3 (round 18): a DECLARED <p:checkButton/> still makes a checkbox (probe E3c control)", async () => {
  // Control: the same UI with `p` DECLARED is a known foreign
  // namespace — checkbox type and on-values ["1"] are correct.
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/" xmlns:p="urn:example:tmpl"><subform name="form" layout="tb"><field name="code"><ui><p:checkButton/></ui><items><text>1</text><text>0</text></items><bind match="default"/></field></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><code>1</code></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.code", value: "1", type: "checkbox", onValues: ["1"] },
  ]);
});

// --- B1 fix round 19 (re-review #18, EXPANDED PANEL, Nov 21, 2026) --------
// Regression tests for the converged findings F-1 (unbound descendants
// in consumed template text), F-2 (stale attrInNamespace reference in
// the D4b comment — comment-only, no test), and F-3 (unpinned guards).
// Probe shapes are noted per test. F-1's guard is scoped to the
// template-metadata call sites (itemTexts + the two caption paths):
// nodeText()/collectTextSegments() themselves are shared with dataset
// rich-text flattening, where unbound descendants are handled by the
// classifier — so the guard lives at the call sites, not in the
// shared flatteners. Controls pin the boundary: declared-prefix and
// no-namespace descendants keep their labels/on-values.

test("F-1 (round 19): an unbound descendant inside a caption <value> fails closed (probe F1)", async () => {
  // E-3 guarded the <caption>/<value> wrappers, but
  // normalizePreserving() recursed into their descendants unchecked,
  // so <p:text>UNBOUND-LABEL</p:text> became the field's label.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/><caption><value><p:text>UNBOUND-LABEL</p:text></value></caption></field>',
      `<code>V</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:text.*unbound prefix/);
    assert.doesNotMatch(error.message, /UNBOUND-LABEL/);
    return true;
  });
});

test("F-1 (round 19): a DECLARED descendant inside a caption <value> still labels (probe F1b control)", async () => {
  // Control: the same descendant with `p` DECLARED is a known
  // foreign namespace and must still supply the label.
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/" xmlns:p="urn:example:tmpl"><subform name="form" layout="tb"><field name="code"><ui><textEdit/></ui><bind match="default"/><caption><value><p:text>DECLARED-LABEL</p:text></value></caption></field></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><code>V</code></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.code", value: "V", type: "text", label: "DECLARED-LABEL" },
  ]);
});

test("F-1 (round 19): plain nested markup inside a caption <value> still labels (probe F1c control)", async () => {
  // Control: a no-namespace nested element is legacy markup, not an
  // unknown namespace — its text still supplies the label.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/><caption><value><b>PLAIN-LABEL</b></value></caption></field>',
      `<code>V</code>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.code", value: "V", type: "text", label: "PLAIN-LABEL" },
  ]);
});

test("F-1 (round 19): an unbound descendant inside an <items> <text> fails closed (probe F2)", async () => {
  // E-3 guarded the <items>/<text> wrappers, but nodeText() recursed
  // into their descendants unchecked, so <p:b>UNBOUND-ON</p:b> became
  // the checkButton's on-value — semantic metadata, not display text.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><checkButton/></ui><items><text><p:b>UNBOUND-ON</p:b></text><text>0</text></items><bind match="default"/></field>',
      `<code>0</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:b.*unbound prefix/);
    assert.doesNotMatch(error.message, /UNBOUND-ON/);
    return true;
  });
});

test("F-1 (round 19): a DECLARED descendant inside an <items> <text> still supplies the on-value (probe F2b control)", async () => {
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/" xmlns:p="urn:example:tmpl"><subform name="form" layout="tb"><field name="code"><ui><checkButton/></ui><items><text><p:b>DECLARED-ON</p:b></text><text>0</text></items><bind match="default"/></field></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><code>0</code></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.code", value: "0", type: "checkbox", onValues: ["DECLARED-ON"] },
  ]);
});

test("F-1 (round 19): plain nested markup inside an <items> <text> still supplies the on-value (probe F2c control)", async () => {
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><checkButton/></ui><items><text><b>PLAIN-ON</b></text><text>0</text></items><bind match="default"/></field>',
      `<code>0</code>`,
    ),
  );
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    { name: "form.code", value: "0", type: "checkbox", onValues: ["PLAIN-ON"] },
  ]);
});

test("F-1 (round 19): an unbound descendant inside an exclGroup caption fails closed (probe F3)", async () => {
  // Same gap in the group caption path: the exclGroup's caption is
  // normalized through the same normalizePreserving() call, so an
  // unbound descendant there became the group's label.
  const bytes = await createXfaPdf(
    wrap(
      '<exclGroup name="pay"><bind match="default"/><caption><value><p:text>UNBOUND-GROUP-LABEL</p:text></value></caption><field><items><text>OPT</text></items></field></exclGroup>',
      `<pay>OPT</pay>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:text.*unbound prefix/);
    assert.doesNotMatch(error.message, /UNBOUND-GROUP-LABEL/);
    return true;
  });
});

test("F-1 (round 19): a DECLARED descendant inside an exclGroup caption still labels (probe F3b control)", async () => {
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/" xmlns:p="urn:example:tmpl"><subform name="form" layout="tb"><exclGroup name="pay"><bind match="default"/><caption><value><p:text>DECLARED-GROUP-LABEL</p:text></value></caption><field><items><text>OPT</text></items></field></exclGroup></subform></template>',
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form><pay>OPT</pay></form></xfa:data></xfa:datasets>',
  });
  const result = await inspectPdf(bytes);
  assert.deepEqual(result.fields, [
    {
      name: "form.pay",
      value: "OPT",
      type: "unsupported",
      options: ["OPT"],
      label: "DECLARED-GROUP-LABEL",
    },
  ]);
});

test("F-1 (round 19): an unbound descendant inside a bare caption fails closed (probe F4)", async () => {
  // No <value> child: the caption itself is the consumed subtree,
  // so the same descendant gap applies without any wrapper at all.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/><caption><p:text>UNBOUND-BARE-LABEL</p:text></caption></field>',
      `<code>V</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:text.*unbound prefix/);
    assert.doesNotMatch(error.message, /UNBOUND-BARE-LABEL/);
    return true;
  });
});

test("F-3 (round 19): an unbound <p:items> wrapper fails closed", async () => {
  // Pin: the <items> guard (E-3) is exercised directly — the list
  // itself carries the unbound prefix, not its <text> child.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><p:items><text>OPT</text></p:items><bind match="default"/></field>',
      `<code>V</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:items.*unbound prefix/);
    assert.doesNotMatch(error.message, /OPT/);
    return true;
  });
});

test("F-3 (round 19): an unbound <p:text> inside <items> fails closed", async () => {
  // Pin: the <text> child itself carries the unbound prefix (the
  // F-1 defect was its DESCENDANT; this pins the wrapper itself).
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><items><p:text>OPT</p:text></items><bind match="default"/></field>',
      `<code>V</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:text.*unbound prefix/);
    assert.doesNotMatch(error.message, /OPT/);
    return true;
  });
});

test("F-3 (round 19): an unbound <p:caption> wrapper fails closed", async () => {
  // Pin: the <caption> itself carries the unbound prefix.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/><p:caption><value>LABEL</value></p:caption></field>',
      `<code>V</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:caption.*unbound prefix/);
    assert.doesNotMatch(error.message, /LABEL/);
    return true;
  });
});

test("F-3 (round 19): an unbound <p:value> inside a caption fails closed", async () => {
  // Pin: the <value> child itself carries the unbound prefix (the
  // F-1 defect was its DESCENDANT; this pins the wrapper itself).
  const bytes = await createXfaPdf(
    wrap(
      '<field name="code"><ui><textEdit/></ui><bind match="default"/><caption><p:value>LABEL</p:value></caption></field>',
      `<code>V</code>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:value.*unbound prefix/);
    assert.doesNotMatch(error.message, /LABEL/);
    return true;
  });
});

test("F-3 (round 19): an unbound <p:caption> on an exclGroup fails closed", async () => {
  // Pin: the exclGroup caption guard (E-3) exercised directly — the
  // group's own caption carries the unbound prefix.
  const bytes = await createXfaPdf(
    wrap(
      '<exclGroup name="pay"><bind match="default"/><p:caption><value>GROUP-LABEL</value></p:caption><field><items><text>OPT</text></items></field></exclGroup>',
      `<pay>OPT</pay>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /p:caption.*unbound prefix/);
    assert.doesNotMatch(error.message, /GROUP-LABEL/);
    return true;
  });
});

test("F-3 (round 19): a later unbound dataNode attribute still fails closed alongside an earlier resolvable one", async () => {
  // Pin: dataNodeValue's single merged pass (E-2, round 18) collects
  // the first resolved value but still throws on ANY unbound
  // dataNode prefix before returning it — so an earlier resolvable
  // `p:dataNode` (bound to the XFA data namespace) must NOT mask a
  // later unbound `q:dataNode`. The shape would otherwise resolve
  // to "has no data node" (the marking defeats the group); the
  // unbound-prefix error must win instead, and "Inside" must never
  // be reported.
  const bytes = await createXfaPdf(
    wrap(
      '<field name="note"><ui><textEdit/></ui><bind match="default"/></field>',
      `<note xmlns:p="http://www.xfa.org/schema/xfa-data/1.0/" p:dataNode="dataGroup" q:dataNode="dataGroup"><xhtml xmlns="http://www.w3.org/1999/xhtml"><body>Inside</body></xhtml></note>`,
    ),
  );
  await assert.rejects(inspectPdf(bytes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal((error as { status?: number }).status, 422);
    assert.match(error.message, /dataNode.*unbound prefix/);
    assert.doesNotMatch(error.message, /Inside/);
    return true;
  });
});
