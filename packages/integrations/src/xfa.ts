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
 *
 * The parser runs with `preserveOrder: true`, so the parsed tree is an
 * ordered node list, not a key-grouped object: sibling and text order
 * are document order throughout (rich text flattens to "ABC", a
 * `global` bind takes the first same-named leaf in document order).
 * The ordered tree is built once per packet by `convertEntries`, which
 * is also the whole-document depth gate and the namespace-collision
 * gate — every later walk runs over a tree that is already
 * depth-bounded and collision-free.
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
/**
 * Hard work bound for the SOM join: one structural path comparison per
 * same-named candidate leaf (R-7). Leaves are indexed by name, so
 * unrelated leaves cost nothing; a form whose same-named candidates
 * would need more than this many comparisons fails closed instead of
 * burning CPU in the request path.
 */
const MAX_JOIN_WORK = 1000000;

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
  // Ordered output: sibling/text order is document order. Without this
  // the parser groups same-named siblings into arrays, so neither rich
  // text ("ABC" vs "ACB") nor first-in-document-order `global` picks
  // can be recovered from the parsed tree.
  preserveOrder: true,
});

type XmlRecord = Record<string, unknown>;

/**
 * A record is a plain object — never an array. Arrays are repeated
 * elements (or repeated attributes), not singletons: treating one as a
 * record let duplicate <bind>/<ui>/<caption> elements silently pass as
 * a single binding or UI (R-5).
 */
function isRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One element of the ordered XML tree: its qualified tag name as
 * written, its local name (after the last ":"), its string attributes,
 * and its mixed content — element children and text, in document
 * order. Keeping text interleaved with elements (instead of merging it
 * into one #text value) is what makes rich-text order recoverable.
 */
interface XElement {
  name: string;
  local: string;
  attrs: Record<string, string>;
  content: Array<XElement | string>;
}

function elementChildren(element: XElement): XElement[] {
  return element.content.filter((item): item is XElement => typeof item !== "string");
}

function childrenNamed(element: XElement, local: string): XElement[] {
  return elementChildren(element).filter((child) => child.local === local);
}

/**
 * The single child element with this local name, or undefined when
 * there is none. More than one is malformed XFA for a singleton slot
 * (bind/ui/caption/value/data): fail closed naming the element instead
 * of letting the first (or an array read as a record) win silently.
 */
function singletonChild(element: XElement, local: string, context: string): XElement | undefined {
  const found = childrenNamed(element, local);
  if (found.length > 1)
    throw new XfaError(`XFA packet is malformed: ${context} has more than one <${local}> element`);
  return found[0];
}

/** A string attribute (`@_name`, `@_match`, `@_ref`), or undefined. */
function attr(element: XElement, name: string): string | undefined {
  const value = element.attrs[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

/**
 * Convert one preserveOrder entry to an ordered-tree node, a text
 * string, or null (processing instructions, comments, and anything
 * else that carries no data). Recursion is depth-bounded by
 * `convertEntries`, which throws at MAX_XFA_DEPTH.
 */
function convertEntry(entry: unknown, packetName: string, depth: number): XElement | string | null {
  if (!isRecord(entry)) return null;
  const keys = Object.keys(entry);
  if (keys.includes("#comment")) return null;
  const textKey = keys.find((key) => key === "#text" || key === "#cdata");
  if (textKey !== undefined) {
    const value = entry[textKey];
    return typeof value === "string" ? value : "";
  }
  const tagKey = keys.find((key) => key !== ":@");
  if (tagKey === undefined) return null;
  // Processing instructions (<?xml ...?>) and declarations carry no data.
  if (tagKey.startsWith("?") || tagKey.startsWith("!")) return null;
  const rawChildren = entry[tagKey];
  const childEntries = Array.isArray(rawChildren) ? rawChildren : [];
  const rawAttrs = isRecord(entry[":@"]) ? entry[":@"] : {};
  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawAttrs)) {
    if (typeof value === "string") attrs[key] = value;
  }
  return {
    name: tagKey,
    local: tagKey.split(":").at(-1) ?? tagKey,
    attrs,
    content: convertEntries(childEntries, packetName, depth + 1),
  };
}

/**
 * Convert a preserveOrder entry list to ordered-tree nodes. This is the
 * preprocessing pass, so it carries both whole-document gates (R-8,
 * R-4): the depth guard throws the malformed-XFA error at
 * MAX_XFA_DEPTH before any later walk can reach a stack failure, and a
 * namespace collision — two sibling elements whose different qualified
 * names normalize to the same local name (e.g. `<a:code>` and
 * `<b:code>`) — fails closed instead of silently overwriting, because
 * the discarded node would be invisible to repeat handling and to the
 * public-name collision check.
 */
function convertEntries(
  entries: unknown[],
  packetName: string,
  depth: number,
): Array<XElement | string> {
  if (depth > MAX_XFA_DEPTH) throw new XfaError(`XFA ${packetName} packet is nested too deeply`);
  const out: Array<XElement | string> = [];
  for (const entry of entries) {
    const converted = convertEntry(entry, packetName, depth);
    if (converted !== null) out.push(converted);
  }
  const seen = new Map<string, string>();
  for (const item of out) {
    if (typeof item === "string") continue;
    const previous = seen.get(item.local);
    if (previous !== undefined && previous !== item.name)
      throw new XfaError(
        `XFA ${packetName} packet has a namespace collision on element '${item.local}': '${previous}' and '${item.name}' normalize to the same name`,
      );
    seen.set(item.local, item.name);
  }
  return out;
}

/**
 * Concatenate the text under a node in document order. Whitespace-only
 * text between elements is pretty-printing, not content, and is
 * skipped; text inside a leaf (no element siblings) is kept verbatim,
 * so dataset whitespace (" 001 ") is preserved exactly. Fails closed
 * (throws) when the depth guard is hit — a local defense; the
 * conversion pass already bounds the whole document.
 */
function nodeText(node: XElement | string, depth = 0): string {
  if (typeof node === "string") return node;
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA packet is nested too deeply");
  const children = elementChildren(node);
  let out = "";
  for (const item of node.content) {
    if (typeof item === "string") {
      if (item.trim() === "" && children.length > 0) continue;
      out += item;
    } else {
      out += nodeText(item, depth + 1);
    }
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
      // The decode budget throws a PdfError with one fixed message
      // ("PDF content expands beyond the supported size"); let it
      // through unwrapped, so budget exhaustion is reported as budget
      // exhaustion — wrapping it would mask it as a generic decode
      // failure and hide which guard fired.
      if (
        error instanceof Error &&
        error.message === "PDF content expands beyond the supported size"
      )
        throw error;
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
 * Parse one XFA packet to its ordered root elements. Well-formedness is
 * validated explicitly before parsing (the parser alone accepts a
 * template missing only its final closing tag), and namespace prefixes
 * are stripped only by the local-name mapping in the converter — a
 * prefixed root like <xfa:template> is recognised by its local name.
 */
function parseXfaXml(packetName: string, bytes: Uint8Array): XElement[] {
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
  if (!Array.isArray(parsed)) throw new XfaError(`XFA packet '${packetName}' is not parseable XML`);
  return convertEntries(parsed, packetName, 0).filter(
    (item): item is XElement => typeof item !== "string",
  );
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
function parseBind(bindNode: XElement | undefined): {
  bind: BindKind;
  ref?: string;
  rawMatch?: string;
} {
  if (bindNode === undefined) return { bind: "default" };
  const rawMatch = attr(bindNode, "match");
  const bind: BindKind =
    rawMatch === "global" || rawMatch === "none" || rawMatch === "dataRef"
      ? rawMatch
      : rawMatch === undefined || rawMatch === "default"
        ? "default"
        : "unsupported";
  const refValue = attr(bindNode, "ref");
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
 * several <items> elements (the parser produces one per element) and
 * merges their texts in order instead of silently dropping to []. */
function itemTexts(node: XElement): string[] {
  const out: string[] = [];
  for (const items of childrenNamed(node, "items")) {
    for (const text of childrenNamed(items, "text")) out.push(nodeText(text));
  }
  return out;
}

function buildTemplateField(node: XElement, somPath: string): TemplateField | undefined {
  const name = attr(node, "name");
  if (typeof name !== "string" || name === "") return undefined;
  const leafName = name;
  const fieldPath = somPath === "" ? leafName : `${somPath}.${leafName}`;
  const context = `field '${fieldPath}'`;
  const uiNode = singletonChild(node, "ui", context);
  const uiChildren = uiNode ? elementChildren(uiNode) : [];
  // More than one UI element in one field is malformed: reading the
  // first key off an array-valued ui used to yield a nonsense uiKind.
  if (uiChildren.length > 1)
    throw new XfaError(
      `XFA packet is malformed: ${context} has more than one user-interface element`,
    );
  const uiKind = uiChildren[0]?.local ?? "none";
  const bindNode = singletonChild(node, "bind", context);
  const { bind, ref, rawMatch } = parseBind(bindNode);
  const items = itemTexts(node);
  let onValues: string[] | undefined;
  // On-values live in <items> only for checkButtons; a choiceList's
  // <items> are its options, not on-values.
  if (uiKind === "checkButton" && items.length > 0) onValues = [items[0]];
  const caption = singletonChild(node, "caption", context);
  const captionValue =
    caption !== undefined ? nodeText(singletonChild(caption, "value", context) ?? caption) : "";
  const label = captionValue !== "" ? normalizeSpace(captionValue) : undefined;
  const options = uiKind === "choiceList" ? itemTexts(node) : [];
  return {
    somPath: fieldPath,
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
 * Depth accounting: the conversion pass already bounds the whole
 * document to MAX_XFA_DEPTH, so this walk's own guard is defense in
 * depth — including for field subtrees (ui/items/captions) this walk
 * never recurses into, which the conversion pass covers.
 */
function collectTemplateFields(
  node: XElement,
  path: string,
  depth: number,
  out: TemplateField[],
): void {
  // Fail closed like the datasets walk: a form whose only fields are too
  // deep is a 422, never a silent field-less report.
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA template packet is nested too deeply");
  for (const child of elementChildren(node)) {
    if (child.local === "subform") {
      const name = attr(child, "name");
      const childPath =
        typeof name === "string" && name !== "" ? (path === "" ? name : `${path}.${name}`) : path;
      collectTemplateFields(child, childPath, depth + 1, out);
    } else if (child.local === "field") {
      const field = buildTemplateField(child, path);
      if (field) out.push(field);
    } else if (child.local === "exclGroup") {
      const name = attr(child, "name");
      if (typeof name !== "string" || name === "") continue;
      const groupPath = path === "" ? name : `${path}.${name}`;
      const options: string[] = [];
      const childBinds: { bind: BindKind; ref: string | undefined }[] = [];
      for (const optionField of childrenNamed(child, "field")) {
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
      const groupBindNode = singletonChild(child, "bind", `exclGroup '${groupPath}'`);
      if (groupBindNode) {
        ({ bind, ref } = parseBind(groupBindNode));
      } else if (childBinds.length > 0) {
        const first = childBinds[0];
        if (
          childBinds.some(
            (childBind) => childBind.bind !== first.bind || childBind.ref !== first.ref,
          )
        )
          throw new XfaError(
            `XFA template/datasets mismatch: exclGroup '${groupPath}' has no group binding and its option fields disagree`,
          );
        bind = first.bind;
        ref = first.ref;
      }
      const caption = singletonChild(child, "caption", `exclGroup '${groupPath}'`);
      const captionValue =
        caption !== undefined
          ? nodeText(singletonChild(caption, "value", `exclGroup '${groupPath}'`) ?? caption)
          : "";
      out.push({
        somPath: groupPath,
        leafName: name,
        ui: "unsupported",
        bind,
        ref,
        options: options.length > 0 ? options : undefined,
        label: captionValue !== "" ? normalizeSpace(captionValue) : undefined,
      });
    } else {
      collectTemplateFields(child, path, depth + 1, out);
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
 * Walk <xfa:data> collecting leaf data nodes, in document order.
 * Repeated elements get an index in the path (form.repeat[0].item) so
 * repeating subforms stay distinct; a lone element keeps its plain
 * name. Sibling order is document order — the grouped-object walk used
 * to visit every `a` before every `b`, so a `global` bind could pick a
 * later leaf over an earlier one.
 */
function collectDataLeaves(node: XElement, path: string, depth: number, out: DataLeaf[]): void {
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA datasets packet is nested too deeply");
  const children = elementChildren(node);
  if (children.length === 0) {
    // A leaf's value is its direct text, verbatim: dataset whitespace
    // is significant (the parser is configured with trimValues: false,
    // and no trimming happens here either).
    const value = node.content.filter((item): item is string => typeof item === "string").join("");
    out.push({ path, value, markup: false });
    return;
  }
  // Rich-text values are leaves: their flattened text content, flagged.
  // Only actual rich-text containers count (an <xhtml> subtree or an
  // <exData> element) — a bare colon in a key used to trigger this too.
  // The flattened value keeps the text in document order (no whitespace
  // normalisation); block boundaries carry no separator.
  if (children.some((child) => child.local === "xhtml" || child.local === "exData")) {
    out.push({ path, value: nodeText(node), markup: true });
    return;
  }
  const counts = new Map<string, number>();
  for (const child of children) counts.set(child.local, (counts.get(child.local) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const child of children) {
    const index = seen.get(child.local) ?? 0;
    seen.set(child.local, index + 1);
    const segment = (counts.get(child.local) ?? 1) > 1 ? `${child.local}[${index}]` : child.local;
    collectDataLeaves(child, path === "" ? segment : `${path}.${segment}`, depth + 1, out);
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
 * to name matching. The ORIGINAL ref grammar is validated BEFORE any
 * normalization: the prefix must be `$data.` or bare, and every segment
 * must be a name with at most one trailing `[N]` index selector. An
 * index embedded inside a name (`cust[0]omer`) is unparseable — stripping
 * it first used to silently repair it into a different, valid reference
 * (`customer`). Indexed refs (`$data.form.repeat[1].itemName`) are
 * normalised by stripping `[N]` segments, like dataset paths.
 */
function parseDataRef(field: TemplateField): string {
  const ref = field.ref;
  if (ref === undefined)
    throw new XfaError(
      `XFA template/datasets mismatch: field '${field.somPath}' has a dataRef binding with a missing or empty ref`,
    );
  const withoutPrefix = ref.startsWith("$data.") ? ref.slice("$data.".length) : ref;
  const segments = withoutPrefix.split(".");
  if (segments.some((segment) => !/^[A-Za-z_][\w-]*(\[\d+\])?$/.test(segment)))
    throw new XfaError(
      `XFA template/datasets mismatch: field '${field.somPath}' has an unparseable dataRef '${ref}'`,
    );
  return stripIndices(withoutPrefix);
}

/**
 * The join index, built once per inspect (R-7): leaves by leaf name and
 * by stripped path, in document order, plus the running count of
 * structural comparisons spent. Indexing means a field only ever
 * compares against same-named leaves — unrelated leaves cost nothing
 * — and the work budget bounds even the same-named worst case.
 */
interface JoinIndex {
  byName: Map<string, DataLeaf[]>;
  byPath: Map<string, DataLeaf[]>;
  work: number;
}

function buildJoinIndex(leaves: DataLeaf[]): JoinIndex {
  const byName = new Map<string, DataLeaf[]>();
  const byPath = new Map<string, DataLeaf[]>();
  for (const leaf of leaves) {
    const name = leafNameOf(leaf.path);
    const named = byName.get(name);
    if (named) named.push(leaf);
    else byName.set(name, [leaf]);
    const stripped = stripIndices(leaf.path);
    const pathed = byPath.get(stripped);
    if (pathed) pathed.push(leaf);
    else byPath.set(stripped, [leaf]);
  }
  return { byName, byPath, work: 0 };
}

/**
 * Find the datasets leaf/leaves a template field binds to.
 * - dataRef: the explicit SOM path, index-stripped, exact-matched.
 * - global: the first same-named leaf in document order, single field —
 *   the XFA semantic for global binding, distinct from default.
 * - default: ONE-SIDED structural match — the dataset path (stripped,
 *   minus leaf) must be a subsequence of the template path (minus
 *   leaf). The template may carry extra segments the datasets omit
 *   (the W-9 nests fields under Page1, which its datasets omit), but
 *   the datasets must never carry a data-scope segment the template
 *   does not name: a same-named leaf in an unrelated branch (customer
 *   vs supplier, in either nesting direction from the dataset side)
 *   can never be claimed. Among candidates the closest structural
 *   match wins (fewest template-only segments skipped); repeat
 *   instances of one path all resolve; distinct paths tied for closest
 *   fail closed as ambiguous.
 * Residual ambiguity, recorded explicitly rather than hidden: a
 * template-only segment is ASSUMED layout-only. A template field under
 * a real data branch whose datasets omit that branch still matches —
 * the rule cannot distinguish a layout subform (Page1) from a data
 * subform the datasets happen to omit. The datasets side is the sound
 * half: no dataset segment may go unnamed by the template.
 */
function findLeaves(field: TemplateField, index: JoinIndex): DataLeaf[] {
  if (field.bind === "dataRef") {
    const target = parseDataRef(field);
    return index.byPath.get(target) ?? [];
  }
  if (field.bind === "global") {
    const first = (index.byName.get(field.leafName) ?? [])[0];
    return first ? [first] : [];
  }
  // default: one-sided — dataset path (minus leaf) ⊆ template path (minus leaf).
  const templateParent = field.somPath.split(".").slice(0, -1);
  const candidates: { leaf: DataLeaf; gap: number; stripped: string }[] = [];
  for (const leaf of index.byName.get(field.leafName) ?? []) {
    index.work += 1;
    if (index.work > MAX_JOIN_WORK)
      throw new XfaError(
        `XFA join exceeded the work budget of ${MAX_JOIN_WORK} structural comparisons; refusing to keep matching`,
      );
    const stripped = stripIndices(leaf.path);
    const leafParent = stripped.split(".").slice(0, -1);
    if (!isSubsequence(leafParent, templateParent)) continue;
    candidates.push({ leaf, gap: templateParent.length - leafParent.length, stripped });
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
  const index = buildJoinIndex(leaves);
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
    const matches = findLeaves(field, index);
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
  const templateRoot = templateParsed.find((element) => element.local === "template");
  if (!templateRoot)
    throw new XfaError("XFA form is malformed: template packet has no <template> element");
  const datasetsParsed = parseXfaXml("datasets", datasetsBytes);
  const datasetsRoot = datasetsParsed.find((element) => element.local === "datasets");
  if (!datasetsRoot)
    throw new XfaError("XFA form is malformed: datasets packet has no <datasets> element");
  const dataRoot = singletonChild(datasetsRoot, "data", "the datasets packet");
  if (dataRoot === undefined)
    throw new XfaError("XFA form is malformed: datasets packet has no <data> element");
  const templateFields: TemplateField[] = [];
  collectTemplateFields(templateRoot, "", 0, templateFields);
  const leaves: DataLeaf[] = [];
  collectDataLeaves(dataRoot, "", 0, leaves);
  return { fields: joinFields(templateFields, leaves), formKind: xfaFormKind(doc) ?? "xfa-static" };
}
