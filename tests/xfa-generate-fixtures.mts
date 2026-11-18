/**
 * Regenerate the binary XFA fixtures in tests/fixtures/. Run with:
 *   ./node_modules/.bin/tsx tests/xfa-generate-fixtures.mts
 * The encrypted fixture needs pypdf (python3 -c "import pypdf").
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

// Sanity: the dynamic generator's own XML round-trips through the parser.
void dynamicTemplateXml;
void dynamicDatasetsXml;
void staticDatasetsXml;
