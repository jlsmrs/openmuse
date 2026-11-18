import { XMLParser, XMLValidator } from "fast-xml-parser";
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
/**
 * Hard output bound for the SOM join: one template field can otherwise
 * resolve to thousands of repeat instances (P1-8). A form that would
 * report more than this many fields fails closed instead.
 */
const MAX_JOINED_FIELDS = 10000;

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

/**
 * Concatenate every text leaf under a node (captions, rich-text values),
 * in parser entry order. Fails closed (throws) when the depth guard is
 * hit. Mixed content has a documented parser limitation: fast-xml-parser
 * merges the text around child elements into a single #text value, so
 * their document order is lost. For field VALUES (strict) that is a
 * fail-closed 422 rather than an invented order; for captions (lenient)
 * the flattened label is best-effort — the parser exposes #text last, so
 * free text lands after the styled spans — and the label is display-only.
 * Whitespace-only #text (pretty-printing between elements) carries no
 * order-sensitive content and is skipped in strict mode.
 */
function nodeText(node: unknown, depth = 0, strict = false): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map((item) => nodeText(item, depth, strict)).join("");
  if (!isRecord(node)) return "";
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA packet is nested too deeply");
  const text = typeof node["#text"] === "string" ? node["#text"] : undefined;
  const elementEntries = Object.entries(node).filter(
    ([key]) => !key.startsWith("@_") && key !== "#text",
  );
  if (strict && text !== undefined && text.trim() !== "" && elementEntries.length > 0)
    throw new XfaError(
      "XFA packet has ambiguous mixed content: text interleaved with child elements cannot be ordered",
    );
  let out = "";
  for (const [, value] of elementEntries) out += nodeText(value, depth + 1, strict);
  if (elementEntries.length === 0) {
    out += text ?? "";
  } else if (!strict && text !== undefined) {
    out += text;
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
    // A duplicate packet name must fail closed: silently keeping the last
    // one would let a second template/datasets overwrite the first.
    if (packets.has(name)) throw new XfaError(`XFA form is malformed: duplicate '${name}' packet`);
    packets.set(name, decoded);
  }
  return packets;
}

/**
 * Strip namespace prefixes (xfa:, xhtml:) from element keys so prefixed
 * roots like <xfa:template> are recognised. Attribute keys (@_*) and
 * #text are left alone. Distinct-prefixed siblings that normalise to the
 * same key collapse (last wins) — acceptable for XFA packets, whose
 * element names are unprefixed in practice.
 */
function normalizeXmlKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeXmlKeys);
  if (!isRecord(node)) return node;
  const out: XmlRecord = {};
  for (const [key, value] of Object.entries(node)) {
    const normalized =
      key.startsWith("@_") || key === "#text" ? key : (key.split(":").at(-1) ?? key);
    out[normalized] = normalizeXmlKeys(value);
  }
  return out;
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
  // fast-xml-parser's parse step alone does not reject every malformed
  // document (a template missing only its final closing tag parses), so
  // validate well-formedness explicitly first, on every packet.
  const validation = XMLValidator.validate(text);
  if (validation !== true)
    throw new XfaError(
      `XFA packet '${packetName}' is not parseable XML: ${validation.err.msg} (line ${validation.err.line}, col ${validation.err.col})`,
    );
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(text);
  } catch (error) {
    throw new XfaError(`XFA packet '${packetName}' is not parseable XML`, { cause: error });
  }
  if (!isRecord(parsed)) throw new XfaError(`XFA packet '${packetName}' is not parseable XML`);
  return normalizeXmlKeys(parsed) as XmlRecord;
}

type BindKind = "default" | "global" | "none" | "dataRef" | "unsupported";

interface TemplateField {
  /** Template SOM path, e.g. topmostSubform.Page1.f1_01. */
  somPath: string;
  leafName: string;
  ui: XfaFieldType;
  bind: BindKind;
  ref?: string;
  /** Raw match value when the match is unknown (bind "unsupported"). */
  rawMatch?: string;
  options?: string[];
  label?: string;
  onValues?: string[];
}

/**
 * Read a <bind> element. No <bind> at all means "default"; a match value
 * outside the known set (dataRef/global/none) is "unsupported" — never
 * coerced to "default", so an XFA-defined value like match="once" cannot
 * silently acquire a binding it was never given.
 */
function parseBind(bindNode: XmlRecord): {
  bind: BindKind;
  ref?: string;
  rawMatch?: string;
} {
  const rawMatch = bindNode["@_match"];
  const bind: BindKind =
    rawMatch === "global" || rawMatch === "none" || rawMatch === "dataRef"
      ? rawMatch
      : rawMatch === undefined || rawMatch === "default"
        ? "default"
        : "unsupported";
  const refValue = bindNode["@_ref"];
  const ref = typeof refValue === "string" && refValue !== "" ? refValue : undefined;
  return {
    bind,
    ref,
    ...(bind === "unsupported" && typeof rawMatch === "string" ? { rawMatch } : {}),
  };
}

function fieldTypeFromUi(uiKind: string): XfaFieldType {
  if (uiKind === "textEdit" || uiKind === "dateTimeEdit" || uiKind === "numericEdit") return "text";
  if (uiKind === "checkButton") return "checkbox";
  return "unsupported";
}

/** Choice-list option texts from the field-level `<items><text>…`. Accepts
 * several <items> elements (the parser produces an array for them) and
 * merges their texts in order instead of silently dropping to []. */
function itemTexts(node: XmlRecord): string[] {
  const out: string[] = [];
  for (const items of asArray(node.items)) {
    if (!isRecord(items)) continue;
    out.push(...asArray(items.text).filter((text): text is string => typeof text === "string"));
  }
  return out;
}

function buildTemplateField(node: XmlRecord, somPath: string): TemplateField | undefined {
  const name = node["@_name"];
  if (typeof name !== "string" || name === "") return undefined;
  const leafName = name;
  const uiNode = isRecord(node.ui) ? node.ui : {};
  const uiKind =
    Object.keys(uiNode).find((key) => !key.startsWith("@_") && key !== "#text") ?? "none";
  const bindNode = isRecord(node.bind) ? node.bind : {};
  const { bind, ref, rawMatch } = parseBind(bindNode);
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
    ref,
    rawMatch,
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
  if (!isRecord(node)) return;
  // Fail closed like the datasets walk: a form whose only fields are too
  // deep is a 422, never a silent field-less report.
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA template packet is nested too deeply");
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
        const groupPath = path === "" ? name : `${path}.${name}`;
        const options: string[] = [];
        const childBinds: { bind: BindKind; ref: string | undefined }[] = [];
        for (const optionField of asArray(group.field)) {
          if (!isRecord(optionField)) continue;
          const built = buildTemplateField(optionField, path);
          if (built) {
            options.push(built.onValues?.[0] ?? built.leafName);
            childBinds.push({ bind: built.bind, ref: built.ref });
          }
        }
        // The group's own <bind> governs the group field; the children's
        // bindings govern only their option identity, never the value.
        // With no group binding, the children must agree — if they
        // disagree, fail closed instead of letting the last child win.
        let bind: BindKind = "default";
        let ref: string | undefined;
        const groupBindNode = isRecord(group.bind) ? group.bind : undefined;
        if (groupBindNode) {
          ({ bind, ref } = parseBind(groupBindNode));
        } else if (childBinds.length > 0) {
          const first = childBinds[0];
          if (childBinds.some((child) => child.bind !== first.bind || child.ref !== first.ref))
            throw new XfaError(
              `XFA template/datasets mismatch: exclGroup '${groupPath}' has no group binding and its option fields disagree`,
            );
          bind = first.bind;
          ref = first.ref;
        }
        const caption = isRecord(group.caption) ? group.caption : undefined;
        const captionValue = caption !== undefined ? nodeText(caption.value) : "";
        out.push({
          somPath: groupPath,
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
    // Dataset whitespace is significant: the parser is configured with
    // trimValues: false, and no trimming happens here either.
    out.push({ path, value: node, markup: false });
    return;
  }
  if (!isRecord(node)) {
    out.push({ path, value: "", markup: false });
    return;
  }
  const children = Object.entries(node).filter(([key]) => !key.startsWith("@_") && key !== "#text");
  if (children.length === 0) {
    const text = typeof node["#text"] === "string" ? node["#text"] : "";
    out.push({ path, value: text, markup: false });
    return;
  }
  // Rich-text values are leaves: their flattened text content, flagged.
  // Only actual rich-text containers count (an <xhtml> subtree or an
  // <exData> element) — a bare colon in a key used to trigger this too.
  // The flattened value keeps the text as parsed (no whitespace
  // normalisation); block boundaries carry no separator in the flattened
  // value, and interleaved mixed content fails closed (strict nodeText)
  // because the parser cannot order it.
  if (children.some(([key]) => key === "xhtml" || key === "exData")) {
    out.push({ path, value: nodeText(node, 0, true), markup: true });
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

function isSubsequence(shorter: string[], longer: string[]): boolean {
  let index = 0;
  for (const segment of longer) {
    if (index < shorter.length && segment === shorter[index]) index++;
  }
  return index === shorter.length;
}

/**
 * Normalise a dataRef to a stripped SOM path, or fail closed naming the
 * field and the ref: a missing, empty, or unparseable ref never falls back
 * to name matching. Indexed refs ($data.form.repeat[1].itemName) are
 * normalised by stripping [N] segments, like dataset paths.
 */
function parseDataRef(field: TemplateField): string {
  const ref = field.ref;
  if (ref === undefined)
    throw new XfaError(
      `XFA template/datasets mismatch: field '${field.somPath}' has a dataRef binding with a missing or empty ref`,
    );
  const withoutPrefix = ref.replace(/^\$data\./, "").replace(/^\$/, "");
  const stripped = stripIndices(withoutPrefix);
  if (!/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(stripped))
    throw new XfaError(
      `XFA template/datasets mismatch: field '${field.somPath}' has an unparseable dataRef '${ref}'`,
    );
  return stripped;
}

/**
 * Find the datasets leaf/leaves a template field binds to.
 * - dataRef: the explicit SOM path, index-stripped, exact-matched.
 * - global: the first same-named leaf in document order, single field —
 *   the XFA semantic for global binding, distinct from default.
 * - default: the data node under the matching subform path. The match is
 *   structural, not name-only: the stripped leaf path and the template
 *   path must be equal up to subform segments present on one side only
 *   (one path is a subsequence of the other). Literal path equality was
 *   considered and rejected: the W-9's template nests fields under
 *   Page1 (topmostSubform.Page1.f1_01) while its datasets omit that
 *   subform (topmostSubform.f1_01), so literal equality would reject the
 *   real-world form. Among candidates the closest structural match wins
 *   (fewest skipped segments); repeat instances of one path all resolve;
 *   distinct paths tied for closest fail closed as ambiguous. A
 *   same-named leaf in an unrelated branch (customer vs supplier) is
 *   never a subsequence match, so it can never be claimed.
 */
function findLeaves(field: TemplateField, leaves: DataLeaf[]): DataLeaf[] {
  if (field.bind === "dataRef") {
    const target = parseDataRef(field);
    return leaves.filter((leaf) => stripIndices(leaf.path) === target);
  }
  if (field.bind === "global") {
    const first = leaves.find((leaf) => leafNameOf(leaf.path) === field.leafName);
    return first ? [first] : [];
  }
  // default
  const templateParts = field.somPath.split(".");
  const candidates: { leaf: DataLeaf; gap: number; stripped: string }[] = [];
  for (const leaf of leaves) {
    if (leafNameOf(leaf.path) !== field.leafName) continue;
    const stripped = stripIndices(leaf.path);
    const leafParts = stripped.split(".");
    const shorter = templateParts.length <= leafParts.length ? templateParts : leafParts;
    const longer = templateParts.length <= leafParts.length ? leafParts : templateParts;
    if (!isSubsequence(shorter, longer)) continue;
    candidates.push({ leaf, gap: longer.length - shorter.length, stripped });
  }
  if (candidates.length === 0) return [];
  const bestGap = Math.min(...candidates.map((candidate) => candidate.gap));
  const best = candidates.filter((candidate) => candidate.gap === bestGap);
  const distinctPaths = [...new Set(best.map((candidate) => candidate.stripped))];
  if (distinctPaths.length > 1)
    throw new XfaError(
      `XFA template/datasets mismatch: field '${field.somPath}' matches more than one data node (${distinctPaths.join(", ")})`,
    );
  return best.map((candidate) => candidate.leaf);
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
 * must never silently report a wrong value. Two distinct template paths
 * resolving to the same data node fail closed too (public-name collision),
 * and the resolved field count is capped at MAX_JOINED_FIELDS so no input
 * can produce unbounded output.
 */
function joinFields(templateFields: TemplateField[], leaves: DataLeaf[]): XfaField[] {
  const merged = new Map<string, TemplateField>();
  for (const field of templateFields) {
    const existing = merged.get(field.somPath);
    if (!existing) {
      merged.set(field.somPath, { ...field, onValues: field.onValues });
      continue;
    }
    // Same path, different binding: the first occurrence must not win
    // silently — fail closed naming the path.
    if (field.bind !== existing.bind || field.ref !== existing.ref || field.ui !== existing.ui)
      throw new XfaError(
        `XFA template/datasets mismatch: field '${field.somPath}' has conflicting bindings (bind '${existing.bind}' vs '${field.bind}')`,
      );
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
  const resolvedByName = new Map<string, string>();
  const push = (field: XfaField, somPath: string): void => {
    const previous = resolvedByName.get(field.name);
    if (previous !== undefined && previous !== somPath)
      throw new XfaError(
        `XFA template/datasets mismatch: fields '${previous}' and '${somPath}' resolve to the same data node '${field.name}'`,
      );
    resolvedByName.set(field.name, somPath);
    out.push(field);
    if (out.length > MAX_JOINED_FIELDS)
      throw new XfaError(
        `XFA join produced more than ${MAX_JOINED_FIELDS} fields; refusing to report an unbounded result`,
      );
  };
  const unbound = (field: TemplateField): XfaField => {
    const result: XfaField = { name: field.somPath, value: "", type: "unsupported" };
    if (field.options) result.options = field.options;
    if (field.label) result.label = field.label;
    return result;
  };
  for (const field of merged.values()) {
    if (field.bind === "none") {
      // No data binding: never consult the datasets, even when a
      // same-named node exists.
      push(unbound(field), field.somPath);
      continue;
    }
    if (field.bind === "unsupported") {
      // Unknown bind match: report the field as unsupported, never guess
      // a binding. (The raw match value has no field on XfaField to
      // carry it; the unsupported type is the signal.)
      push(unbound(field), field.somPath);
      continue;
    }
    const matches = findLeaves(field, leaves);
    if (matches.length === 0)
      throw new XfaError(
        `XFA template/datasets mismatch: field '${field.somPath}' has no data node`,
      );
    for (const match of matches) push(toXfaField(field, match), field.somPath);
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
  const datasetsRoot = datasetsParsed.datasets;
  if (!isRecord(datasetsRoot))
    throw new XfaError("XFA form is malformed: datasets packet has no <datasets> element");
  const dataRoot = datasetsRoot.data;
  if (dataRoot === undefined)
    throw new XfaError("XFA form is malformed: datasets packet has no <data> element");
  const templateFields: TemplateField[] = [];
  collectTemplateFields(templateRoot, "", 0, templateFields);
  const leaves: DataLeaf[] = [];
  collectDataLeaves(dataRoot, "", 0, leaves);
  return { fields: joinFields(templateFields, leaves), formKind: xfaFormKind(doc) ?? "xfa-static" };
}
