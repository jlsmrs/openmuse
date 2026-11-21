/**
 * Regenerate the binary XFA fixtures in tests/fixtures/. Run with:
 *   ./node_modules/.bin/tsx tests/xfa-generate-fixtures.mts
 * The encrypted fixture needs pypdf (python3 -c "import pypdf").
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  createXfaPdf,
  dynamicDatasetsXml,
  dynamicTemplateXml,
  fieldlessDatasetsXml,
  fieldlessTemplateXml,
  staticDatasetsXml,
  staticTemplateXml,
} from "./xfa-fixtures.ts";

const dir = new URL("./fixtures/", import.meta.url).pathname;

async function write(name: string, bytes: Uint8Array): Promise<void> {
  writeFileSync(join(dir, name), bytes);
  console.log(name, bytes.length, "bytes");
}

await write("xfa-static.pdf", await createXfaPdf());
await write("xfa-dynamic.pdf", await createXfaPdf({ dynamic: true }));
await write(
  "xfa-fieldless.pdf",
  await createXfaPdf({ templateXml: fieldlessTemplateXml(), datasetsXml: fieldlessDatasetsXml() }),
);

// Malformed set — each built through the same generator with bad XML.
const xxeDatasets = [
  '<?xml version="1.0"?>',
  '<!DOCTYPE xfa:datasets [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
  '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>',
  "<form><fullName>&xxe;</fullName></form>",
  "</xfa:data></xfa:datasets>",
].join("");
await write("xfa-malformed-xxe.pdf", await createXfaPdf({ datasetsXml: xxeDatasets }));

const unclosedTemplate = staticTemplateXml().slice(0, -120);
await write("xfa-malformed-unclosed.pdf", await createXfaPdf({ templateXml: unclosedTemplate }));

await write("xfa-malformed-no-datasets.pdf", await createXfaPdf({ includeDatasets: false }));
await write("xfa-malformed-no-template.pdf", await createXfaPdf({ includeTemplate: false }));

const mismatchTemplate = staticTemplateXml().replace(
  "</subform>",
  '<field name="ghostField"><ui><textEdit/></ui><bind match="default"/><value><text></text></value></field></subform>',
);
await write("xfa-malformed-mismatch.pdf", await createXfaPdf({ templateXml: mismatchTemplate }));

const oversizedDatasets = [
  '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>',
  "<form><fullName>",
  "x".repeat(11 * 1024 * 1024),
  "</fullName></form>",
  "</xfa:data></xfa:datasets>",
].join("");
await write("xfa-malformed-oversized.pdf", await createXfaPdf({ datasetsXml: oversizedDatasets }));

// Encrypted: the static fixture re-encrypted with an EMPTY user password
// (pypdf, same tool as the PR #55 fixtures). clone_from preserves the
// whole document including /AcroForm + /XFA — append_pages_from_reader
// drops the AcroForm. The server's empty-password decryptor must run
// first, then the XFA path inspects the result.
execFileSync(
  "python3",
  [
    "-c",
    [
      "import pypdf",
      "w = pypdf.PdfWriter(clone_from='tests/fixtures/xfa-static.pdf')",
      "w.encrypt(user_password='', owner_password='xfa-owner-pw')",
      "w.write('tests/fixtures/xfa-encrypted.pdf')",
    ].join("; "),
  ],
  { stdio: "inherit" },
);
console.log("xfa-encrypted.pdf written");

// Sanity (round 6, test adequacy): the generator's own XML really
// round-trips through the parser — the old comment claimed this while
// the following lines were bare `void` references that checked
// nothing. Each generated packet must be valid XML whose parsed root
// is the expected element.
const parser = new XMLParser({ preserveOrder: true });
for (const [name, xml, root] of [
  ["dynamic template", dynamicTemplateXml(), "template"],
  ["dynamic datasets", dynamicDatasetsXml(), "datasets"],
  ["static template", staticTemplateXml(), "template"],
  ["static datasets", staticDatasetsXml(), "datasets"],
  ["field-less template", fieldlessTemplateXml(), "template"],
  ["field-less datasets", fieldlessDatasetsXml(), "datasets"],
] as const) {
  assert.equal(XMLValidator.validate(xml), true, `${name} is not valid XML`);
  const parsed: unknown[] = parser.parse(xml);
  const first = parsed[0] as Record<string, unknown> | undefined;
  const tagKey = first === undefined ? undefined : Object.keys(first).find((key) => key !== ":@");
  // Compare local names: the datasets root is qualified (<xfa:datasets>).
  assert.equal(tagKey?.split(":").at(-1), root, `${name} parses to the wrong root`);
  console.log(`sanity: ${name} round-trips through the parser (root <${root}>)`);
}
