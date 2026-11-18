import { XMLParser } from "fast-xml-parser";
import {
  decodePDFRawStream,
  PDFArray,
  PDFBool,
  PDFDict,
  type PDFDocument,
  PDFHexString,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFString,
} from "pdf-lib";
import type { FormKind } from "../../domain/src/index.ts";

/**
 * XFA inspect (scope B1). Reads the /XFA packet array through pdf-lib's
 * low-level API, parses `template` + `datasets` with fast-xml-parser, and
 * joins template fields to data nodes by SOM binding.
 *
 * Two pdf-lib facts shape this module:
 * - `PDFDocument.getForm()` DELETES the /XFA entry (pdf-lib does not
 *   support XFA), so packets must be read before any getForm() call.
 *   Callers (pdf.ts inspectPdf) branch on hasXfa() first.
 * - `decodePDFRawStream(stream).decode()` returns the decoded packet
 *   bytes; decoding runs inside pdf.ts's decode budget (see
 *   withDecodeBudget), so a hostile packet cannot expand without bound.
 */
export class XfaError extends Error {
  readonly status = 422;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "XfaError";
  }
}

/** One decoded XFA packet may not exceed 10 MiB (same cap as the PDF itself). */
const MAX_XFA_PACKET_BYTES = 10 * 1024 * 1024;
/** Fail closed on absurd XML: the real W-9 template has ~15k tags. */
const MAX_XFA_TAGS = 200000;
/** Recursive walks give up past this depth instead of overflowing the stack. */
const MAX_XFA_DEPTH = 100;

export type XfaFieldType = "text" | "checkbox" | "unsupported";

export interface XfaField {
  name: string;
  value: string;
  type: XfaFieldType;
  options?: string[];
  label?: string;
  /** Checkbox on-values, one per template occurrence (W-9 c1_1: 1–7). */
  onValues?: string[];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Values stay strings: XFA data values are text, and c1_1 = "0" must
  // not become numeric 0.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
});

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

type XmlRecord = Record<string, unknown>;

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value !== null;
}

/** Concatenate every text leaf under a node (captions, rich-text values). */
function nodeText(node: unknown, depth = 0): string {
  if (typeof node === "string") return node;
  if (!isRecord(node) || depth > MAX_XFA_DEPTH) return "";
  let out = "";
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_")) continue;
    out += nodeText(value, depth + 1);
  }
  return out;
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** The AcroForm dict, or undefined when the catalog has no (dict) AcroForm. */
function acroFormDict(doc: PDFDocument): PDFDict | undefined {
  const object = doc.catalog.lookup(PDFName.of("AcroForm"));
  return object instanceof PDFDict ? object : undefined;
}

/** Does the AcroForm dict carry an /XFA entry (whatever its shape)? */
export function hasXfa(doc: PDFDocument): boolean {
  return acroFormDict(doc)?.has(PDFName.of("XFA")) ?? false;
}

/** "xfa-dynamic" when /NeedsRendering is true, else "xfa-static"; null when no XFA. */
export function xfaFormKind(doc: PDFDocument): "xfa-static" | "xfa-dynamic" | null {
  if (!hasXfa(doc)) return null;
  const needsRendering = acroFormDict(doc)?.lookup(PDFName.of("NeedsRendering"));
  return needsRendering instanceof PDFBool && needsRendering.asBoolean()
    ? "xfa-dynamic"
    : "xfa-static";
}

/** Decode every /XFA packet stream, keyed by packet name. */
export function readXfaPackets(doc: PDFDocument): Map<string, Uint8Array> {
  const acroForm = acroFormDict(doc);
  if (!acroForm) throw new XfaError("XFA form is malformed: missing AcroForm dictionary");
  // Untyped lookup: the typed lookupMaybe THROWS on a type mismatch, and
  // a non-array /XFA must fail closed with our message, not pdf-lib's.
  const xfaObject = acroForm.lookup(PDFName.of("XFA"));
  if (!(xfaObject instanceof PDFArray))
    throw new XfaError("XFA form is malformed: /XFA must be an array of name/stream pairs");
  const entries = xfaObject.asArray();
  if (entries.length === 0 || entries.length % 2 !== 0)
    throw new XfaError("XFA form is malformed: /XFA must contain name/stream pairs");
  const packets = new Map<string, Uint8Array>();
  for (let i = 0; i < entries.length; i += 2) {
    const nameObject = entries[i];
    // The /XFA array pairs literal strings with streams ("(template) 12 0 R"),
    // not PDF names — accept either spelling. The empty-password decryptor
    // re-encodes literal strings as <HEX>, so hex strings count too.
    const name =
      nameObject instanceof PDFName
        ? nameObject.decodeText()
        : nameObject instanceof PDFString || nameObject instanceof PDFHexString
          ? nameObject.decodeText()
          : undefined;
    if (name === undefined)
      throw new XfaError("XFA form is malformed: /XFA entry is not a name/stream pair");
    const refObject = entries[i + 1];
    const streamObject = refObject instanceof PDFRef ? doc.context.lookup(refObject) : refObject;
    if (!(streamObject instanceof PDFRawStream))
      throw new XfaError(`XFA form is malformed: packet '${name}' is not a stream`);
    let decoded: Uint8Array;
    try {
      decoded = decodePDFRawStream(streamObject).decode();
    } catch (error) {
      throw new XfaError(`XFA form is malformed: packet '${name}' could not be decoded`, {
        cause: error,
      });
    }
    if (decoded.length > MAX_XFA_PACKET_BYTES)
      throw new XfaError(
        `XFA packet '${name}' is too large (${decoded.length} bytes, limit ${MAX_XFA_PACKET_BYTES})`,
      );
    packets.set(name, decoded);
  }
  return packets;
}

function parseXfaXml(packetName: string, bytes: Uint8Array): XmlRecord {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new XfaError(`XFA packet '${packetName}' is not valid UTF-8 XML`, { cause: error });
  }
  // fast-xml-parser refuses external entities, but a DOCTYPE is still
  // refused outright: no DTD of any kind is legitimate in an XFA packet.
  if (/<!DOCTYPE/i.test(text))
    throw new XfaError(
      `XFA packet '${packetName}' contains a DOCTYPE declaration, which is not allowed`,
    );
  if ((text.match(/</g) ?? []).length > MAX_XFA_TAGS)
    throw new XfaError(`XFA packet '${packetName}' has too many XML nodes`);
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(text);
  } catch (error) {
    throw new XfaError(`XFA packet '${packetName}' is not parseable XML`, { cause: error });
  }
  if (!isRecord(parsed)) throw new XfaError(`XFA packet '${packetName}' is not parseable XML`);
  return parsed;
}

interface TemplateField {
  /** Template SOM path, e.g. topmostSubform.Page1.f1_01. */
  somPath: string;
  leafName: string;
  ui: XfaFieldType;
  bind: "default" | "global" | "none" | "dataRef";
  ref?: string;
  options?: string[];
  label?: string;
  onValues?: string[];
}

function fieldTypeFromUi(uiKind: string): XfaFieldType {
  if (uiKind === "textEdit" || uiKind === "dateTimeEdit" || uiKind === "numericEdit") return "text";
  if (uiKind === "checkButton") return "checkbox";
  return "unsupported";
}

/** Choice-list option texts from the field-level `<items><text>…`. */
function itemTexts(node: XmlRecord): string[] {
  const items = node.items;
  if (!isRecord(items)) return [];
  return asArray(items.text).filter((text): text is string => typeof text === "string");
}

function buildTemplateField(node: XmlRecord, somPath: string): TemplateField | undefined {
  const name = node["@_name"];
  if (typeof name !== "string" || name === "") return undefined;
  const leafName = name;
  const uiNode = isRecord(node.ui) ? node.ui : {};
  const uiKind =
    Object.keys(uiNode).find((key) => !key.startsWith("@_") && key !== "#text") ?? "none";
  const bindNode = isRecord(node.bind) ? node.bind : {};
  const match = bindNode["@_match"];
  const bind = match === "global" || match === "none" || match === "dataRef" ? match : "default";
  const ref = bindNode["@_ref"];
  const items = itemTexts(node);
  let onValues: string[] | undefined;
  // On-values live in <items> only for checkButtons; a choiceList's
  // <items> are its options, not on-values.
  if (uiKind === "checkButton" && items.length > 0) onValues = [items[0]];
  const caption = isRecord(node.caption) ? node.caption : undefined;
  const captionValue = caption !== undefined ? nodeText(caption.value) : "";
  const label = captionValue !== "" ? normalizeSpace(captionValue) : undefined;
  const options = uiKind === "choiceList" ? itemTexts(node) : [];
  return {
    somPath: somPath === "" ? leafName : `${somPath}.${leafName}`,
    leafName,
    ui: fieldTypeFromUi(uiKind),
    bind,
    ref: typeof ref === "string" && ref !== "" ? ref : undefined,
    options: options.length > 0 ? options : undefined,
    label,
    onValues,
  };
}

/**
 * Walk the template tree collecting every <field> (and every <exclGroup>,
 * reported as one unsupported field whose options are its radio choices).
 * Repeated occurrences of one field collapse later, in the join.
 */
function collectTemplateFields(
  node: unknown,
  path: string,
  depth: number,
  out: TemplateField[],
): void {
  if (!isRecord(node) || depth > MAX_XFA_DEPTH) return;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@_") || key === "#text") continue;
    if (key === "subform") {
      for (const subform of asArray(value)) {
        if (!isRecord(subform)) continue;
        const name = subform["@_name"];
        const childPath =
          typeof name === "string" && name !== "" ? (path === "" ? name : `${path}.${name}`) : path;
        collectTemplateFields(subform, childPath, depth + 1, out);
      }
    } else if (key === "field") {
      for (const fieldNode of asArray(value)) {
        if (!isRecord(fieldNode)) continue;
        const field = buildTemplateField(fieldNode, path);
        if (field) out.push(field);
      }
    } else if (key === "exclGroup") {
      for (const group of asArray(value)) {
        if (!isRecord(group)) continue;
        const name = group["@_name"];
        if (typeof name !== "string" || name === "") continue;
        const options: string[] = [];
        let bind: TemplateField["bind"] = "default";
        let ref: string | undefined;
        for (const optionField of asArray(group.field)) {
          if (!isRecord(optionField)) continue;
          const built = buildTemplateField(optionField, path);
          if (built) {
            options.push(built.onValues?.[0] ?? built.leafName);
            bind = built.bind;
            ref = built.ref;
          }
        }
        const caption = isRecord(group.caption) ? group.caption : undefined;
        const captionValue = caption !== undefined ? nodeText(caption.value) : "";
        out.push({
          somPath: path === "" ? name : `${path}.${name}`,
          leafName: name,
          ui: "unsupported",
          bind,
          ref,
          options: options.length > 0 ? options : undefined,
          label: captionValue !== "" ? normalizeSpace(captionValue) : undefined,
        });
      }
    } else if (isRecord(value) || Array.isArray(value)) {
      collectTemplateFields(value, path, depth + 1, out);
    }
  }
}

interface DataLeaf {
  path: string;
  value: string;
  /** True when the value carried markup (xhtml rich text). */
  markup: boolean;
}

function leafNameOf(path: string): string {
  const last = path.split(".").at(-1) ?? "";
  return last.replace(/\[\d+\]$/, "");
}

function stripIndices(path: string): string {
  return path.replace(/\[\d+\]/g, "");
}

/**
 * Walk <xfa:data> collecting leaf data nodes. Repeated elements get an
 * index in the path (form.repeat[0].item) so repeating subforms stay
 * distinct; a lone element keeps its plain name.
 */
function collectDataLeaves(node: unknown, path: string, depth: number, out: DataLeaf[]): void {
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA datasets packet is nested too deeply");
  if (typeof node === "string") {
    out.push({ path, value: node.trim(), markup: false });
    return;
  }
  if (!isRecord(node)) {
    out.push({ path, value: "", markup: false });
    return;
  }
  const children = Object.entries(node).filter(([key]) => !key.startsWith("@_") && key !== "#text");
  if (children.length === 0) {
    const text = typeof node["#text"] === "string" ? node["#text"] : "";
    out.push({ path, value: text.trim(), markup: false });
    return;
  }
  // Rich-text values (<xhtml>…) are leaves: their text content, flagged.
  if (children.some(([key]) => key === "xhtml" || key.includes(":"))) {
    out.push({ path, value: normalizeSpace(nodeText(node)), markup: true });
    return;
  }
  for (const [key, value] of children) {
    const items = asArray(value);
    items.forEach((item, index) => {
      const segment = items.length > 1 ? `${key}[${index}]` : key;
      collectDataLeaves(item, path === "" ? segment : `${path}.${segment}`, depth + 1, out);
    });
  }
}

/** Suffix score: how many trailing segments template and leaf paths share. */
function suffixScore(templatePath: string, leafPath: string): number {
  const templateParts = templatePath.split(".");
  const leafParts = stripIndices(leafPath).split(".");
  let score = 0;
  while (
    score < templateParts.length &&
    score < leafParts.length &&
    templateParts[templateParts.length - 1 - score] === leafParts[leafParts.length - 1 - score]
  ) {
    score++;
  }
  return score;
}

/**
 * Find the datasets leaf/leaves a template field binds to.
 * - dataRef: the explicit SOM path (leading "$data." stripped).
 * - default/global: leaves with the same leaf name, keeping only the
 *   best suffix match — so a repeated subform yields one field per
 *   instance, while a same-named leaf in an unrelated branch loses.
 */
function findLeaves(field: TemplateField, leaves: DataLeaf[]): DataLeaf[] {
  if (field.bind === "dataRef" && field.ref) {
    const target = field.ref.replace(/^\$data\./, "").replace(/^\$/, "");
    return leaves.filter((leaf) => stripIndices(leaf.path) === target);
  }
  const candidates = leaves.filter((leaf) => leafNameOf(leaf.path) === field.leafName);
  if (candidates.length === 0) return [];
  let best = 0;
  for (const leaf of candidates) best = Math.max(best, suffixScore(field.somPath, leaf.path));
  return candidates.filter((leaf) => suffixScore(field.somPath, leaf.path) === best);
}

function toXfaField(field: TemplateField, leaf: DataLeaf, nameOverride?: string): XfaField {
  const out: XfaField = {
    name: nameOverride ?? leaf.path,
    value: leaf.value,
    type: leaf.markup ? "unsupported" : field.ui,
  };
  if (field.options) out.options = field.options;
  if (field.label) out.label = field.label;
  if (field.onValues) out.onValues = field.onValues;
  return out;
}

/**
 * Join template fields to data nodes. Repeated template occurrences of
 * one field collapse to ONE field (W-9 c1_1 ×7 → one field); the
 * per-occurrence on-values are merged onto it. A field with no data node
 * and no `bind none` fails closed — a template/datasets name mismatch
 * must never silently report a wrong value.
 */
function joinFields(templateFields: TemplateField[], leaves: DataLeaf[]): XfaField[] {
  const merged = new Map<string, TemplateField>();
  for (const field of templateFields) {
    const existing = merged.get(field.somPath);
    if (!existing) {
      merged.set(field.somPath, { ...field, onValues: field.onValues });
      continue;
    }
    if (field.onValues && existing.onValues) {
      const seen = new Set(existing.onValues);
      for (const value of field.onValues) {
        if (!seen.has(value)) {
          existing.onValues.push(value);
          seen.add(value);
        }
      }
    } else if (field.onValues) {
      existing.onValues = field.onValues;
    }
    if (!existing.label && field.label) existing.label = field.label;
    if (!existing.options && field.options) existing.options = field.options;
  }
  const out: XfaField[] = [];
  for (const field of merged.values()) {
    if (field.bind === "none") {
      // No data binding: use the datasets value only when a node with
      // this name exists anyway; otherwise report "" / unsupported.
      const match = findLeaves(field, leaves)[0];
      if (match) {
        out.push(toXfaField(field, match));
      } else {
        const unbound: XfaField = { name: field.somPath, value: "", type: "unsupported" };
        if (field.options) unbound.options = field.options;
        if (field.label) unbound.label = field.label;
        out.push(unbound);
      }
      continue;
    }
    const matches = findLeaves(field, leaves);
    if (matches.length === 0)
      throw new XfaError(
        `XFA template/datasets mismatch: field '${field.somPath}' has no data node`,
      );
    for (const match of matches) out.push(toXfaField(field, match));
  }
  return out;
}

/** Inspect an XFA document: template inventory joined to datasets values. */
export function inspectXfa(doc: PDFDocument): {
  fields: XfaField[];
  formKind: FormKind;
} {
  const packets = readXfaPackets(doc);
  const templateBytes = packets.get("template");
  if (!templateBytes) throw new XfaError("XFA form is malformed: missing 'template' packet");
  const datasetsBytes = packets.get("datasets");
  if (!datasetsBytes) throw new XfaError("XFA form is malformed: missing 'datasets' packet");
  const templateParsed = parseXfaXml("template", templateBytes);
  const templateRoot = templateParsed.template;
  if (!isRecord(templateRoot))
    throw new XfaError("XFA form is malformed: template packet has no <template> element");
  const datasetsParsed = parseXfaXml("datasets", datasetsBytes);
  const datasetsRoot = datasetsParsed["xfa:datasets"];
  if (!isRecord(datasetsRoot))
    throw new XfaError("XFA form is malformed: datasets packet has no <xfa:datasets> element");
  const dataRoot = datasetsRoot["xfa:data"];
  if (dataRoot === undefined)
    throw new XfaError("XFA form is malformed: datasets packet has no <xfa:data> element");
  const templateFields: TemplateField[] = [];
  collectTemplateFields(templateRoot, "", 0, templateFields);
  const leaves: DataLeaf[] = [];
  collectDataLeaves(dataRoot, "", 0, leaves);
  return { fields: joinFields(templateFields, leaves), formKind: xfaFormKind(doc) ?? "xfa-static" };
}
