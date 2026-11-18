import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFString,
  StandardFonts,
} from "pdf-lib";

/**
 * Synthetic XFA fixture generator (B1). Hand-built template + datasets
 * packets with an AcroForm /XFA array via pdf-lib; deterministic, no
 * licence question. The static fixture is a hybrid (AcroForm twin +
 * /XFA); the dynamic fixture is pure XFA with /NeedsRendering.
 */

export function staticTemplateXml(): string {
  return [
    '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">',
    '<subform name="form" layout="tb">',
    '<field name="fullName"><ui><textEdit/></ui>',
    "<caption><value><text>Full name</text></value></caption>",
    '<bind match="global"/><value><text></text></value></field>',
    '<field name="email"><ui><textEdit/></ui>',
    "<caption><value><text>Email address</text></value></caption>",
    '<bind match="global"/><value><text></text></value></field>',
    '<field name="amount"><ui><numericEdit/></ui>',
    "<caption><value><text>Amount</text></value></caption>",
    '<bind match="global"/><value><text></text></value></field>',
    '<field name="agree"><ui><checkButton/></ui>',
    "<items><text>1</text><text>0</text></items>",
    "<caption><value><text>I agree</text></value></caption>",
    '<bind match="global"/><value><text>0</text></value></field>',
    '<field name="color"><ui><choiceList/></ui>',
    "<items><text>Red</text><text>Green</text><text>Blue</text></items>",
    "<caption><value><text>Favourite colour</text></value></caption>",
    '<bind match="global"/><value><text>Green</text></value></field>',
    '<exclGroup name="paymentMethod"><bind match="global"/>',
    '<field name="card"><ui><checkButton/></ui><items><text>card</text><text>0</text></items><bind match="global"/></field>',
    '<field name="cash"><ui><checkButton/></ui><items><text>cash</text><text>0</text></items><bind match="global"/></field>',
    "</exclGroup>",
    "</subform>",
    "</template>",
  ].join("");
}

export function staticDatasetsXml(): string {
  return [
    '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>',
    "<form>",
    "<fullName>Joshua Lewis Summers</fullName>",
    "<email>josh@example.com</email>",
    "<amount>42</amount>",
    "<agree>1</agree>",
    "<color>Green</color>",
    "<paymentMethod>card</paymentMethod>",
    "</form>",
    "</xfa:data></xfa:datasets>",
  ].join("");
}

export function dynamicTemplateXml(): string {
  return [
    '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">',
    '<subform name="form" layout="tb">',
    '<field name="title"><ui><textEdit/></ui>',
    "<caption><value><text>Order title</text></value></caption>",
    '<bind match="global"/><value><text></text></value></field>',
    '<subform name="repeat">',
    '<field name="itemName"><ui><textEdit/></ui><bind match="default"/><value><text></text></value></field>',
    '<field name="itemQty"><ui><numericEdit/></ui><bind match="default"/><value><text></text></value></field>',
    "</subform>",
    "</subform>",
    "</template>",
  ].join("");
}

export function dynamicDatasetsXml(): string {
  return [
    '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>',
    "<form>",
    "<title>Order</title>",
    "<repeat><itemName>Apples</itemName><itemQty>3</itemQty></repeat>",
    "<repeat><itemName>Oranges</itemName><itemQty>5</itemQty></repeat>",
    "</form>",
    "</xfa:data></xfa:datasets>",
  ].join("");
}

export function fieldlessTemplateXml(): string {
  return [
    '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">',
    '<subform name="form" layout="tb">',
    '<draw name="note"><value><text>A flat XFA document with no fields.</text></value></draw>',
    "</subform>",
    "</template>",
  ].join("");
}

export function fieldlessDatasetsXml(): string {
  return [
    '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>',
    "<form><note>A flat XFA document with no fields.</note></form>",
    "</xfa:data></xfa:datasets>",
  ].join("");
}

export interface XfaFixtureOptions {
  /** Pure dynamic XFA: no AcroForm twin, /NeedsRendering true. */
  dynamic?: boolean;
  templateXml?: string;
  datasetsXml?: string;
  includeTemplate?: boolean;
  includeDatasets?: boolean;
  /** Explicit packet list, replacing the template/datasets pair (e.g. to
   * build a PDF with a duplicate packet name). */
  packets?: [string, string][];
}

/**
 * Build a one-page PDF carrying the given XFA packets. The AcroForm twin
 * (static only) is built FIRST: pdf-lib's getForm() deletes any /XFA
 * entry, so the /XFA array is attached to the AcroForm dict afterwards.
 */
export async function createXfaPdf(options: XfaFixtureOptions = {}): Promise<Uint8Array> {
  const dynamic = options.dynamic ?? false;
  const templateXml = options.templateXml ?? (dynamic ? dynamicTemplateXml() : staticTemplateXml());
  const datasetsXml = options.datasetsXml ?? (dynamic ? dynamicDatasetsXml() : staticDatasetsXml());
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(dynamic ? "Please wait… (dynamic XFA form)" : "Synthetic XFA form", {
    x: 48,
    y: 700,
    size: 14,
    font,
  });
  if (!dynamic) {
    // Hybrid twin: real AcroForm fields mirroring two XFA fields.
    const form = doc.getForm();
    form.createTextField("fullName").addToPage(page, { x: 48, y: 650, width: 300, height: 24 });
    form.createTextField("email").addToPage(page, { x: 48, y: 600, width: 300, height: 24 });
  } else {
    // Pure XFA still needs the AcroForm dict to carry /XFA — getForm()
    // creates it (with an empty /Fields), and no twin fields are added.
    doc.getForm();
  }
  const acroForm = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (!acroForm) throw new Error("fixture: AcroForm dict was not created");
  const encoder = new TextEncoder();
  const packets: [string, string][] = options.packets ?? [];
  if (options.packets === undefined) {
    if (options.includeTemplate !== false) packets.push(["template", templateXml]);
    if (options.includeDatasets !== false) packets.push(["datasets", datasetsXml]);
  }
  const xfaArray = PDFArray.withContext(doc.context);
  for (const [name, xml] of packets) {
    const stream = doc.context.flateStream(encoder.encode(xml));
    const ref = doc.context.nextRef();
    doc.context.assign(ref, stream);
    xfaArray.push(PDFString.of(name));
    xfaArray.push(ref);
  }
  acroForm.set(PDFName.of("XFA"), xfaArray);
  if (dynamic) acroForm.set(PDFName.of("NeedsRendering"), PDFBool.True);
  return doc.save({ updateFieldAppearances: false });
}
