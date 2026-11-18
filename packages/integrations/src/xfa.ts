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
 * Hard aggregate byte bound for the SOM join (S-5): the count cap alone
 * does not bound output size — one 10 KiB caption × 500 instances
 * serializes to ~5 MB, and 1 MiB × 10,000 would be ~10 GiB. The
 * resolved fields' serialized JSON (names, values, labels, options,
 * on-values) may not exceed this many bytes in total; past it the
 * inspect fails closed, before anything is persisted or serialized
 * over HTTP. 1 MiB leaves ample room for a maxed-out legitimate form
 * (10,000 fields of short labels/values serialize to well under it)
 * while capping the amplification at a small multiple of the input.
 */
const MAX_JOINED_BYTES = 1024 * 1024;
/**
 * Aggregate bound on internal path/index bytes (T-3, round 4): the
 * 1 MiB output bound does not bound the work done BEFORE any field is
 * emitted — `buildJoinIndex` materializes one dotted path string per
 * distinct leaf path, so a 64 KiB ancestor name × 2,000 leaves
 * materializes ~128 MB of key characters (9.3 s / +165 MB RSS probed)
 * without ever calling push(). The retained index keys and the
 * retained template SOM paths are each capped at this many bytes in
 * total; past it the inspect fails closed with a clear 422 instead of
 * materializing more. 4 MiB leaves ample room for a maxed-out
 * legitimate form (10,000 fields × ~100-char paths ≈ 1 MB) while
 * capping the amplification at a small multiple of the input.
 */
const MAX_INTERNAL_PATH_BYTES = 4 * 1024 * 1024;
/**
 * Error messages never interpolate an unbounded name (M1, round 4):
 * a 100 KiB field name with no data node used to produce a 102,462-byte
 * error. Names longer than this are truncated with a marker naming how
 * much was cut, so every error stays small while still identifying the
 * field.
 */
const MAX_ERROR_NAME_CHARS = 200;

function shortName(value: string): string {
  return value.length > MAX_ERROR_NAME_CHARS
    ? `${value.slice(0, MAX_ERROR_NAME_CHARS)}… [truncated ${value.length - MAX_ERROR_NAME_CHARS} chars]`
    : value;
}

const utf8 = new TextEncoder();

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
    throw new XfaError(
      `XFA packet is malformed: ${shortName(context)} has more than one <${local}> element`,
    );
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
 * Concatenate the text under a node in document order. A whitespace-only
 * text node between elements is kept when it holds no line break: a
 * same-line space (`<b>A</b> <b>B</b>` → `"A B"`) is deliberate content,
 * not formatting. A whitespace-only node WITH a line break is
 * pretty-printing indentation and is skipped, as before. Text inside a
 * leaf (no element siblings) is kept verbatim, so dataset whitespace
 * (" 001 ") is preserved exactly. Fails closed (throws) when the depth
 * guard is hit — a local defense; the conversion pass already bounds
 * the whole document.
 */
function nodeText(node: XElement | string, depth = 0): string {
  if (typeof node === "string") return node;
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA packet is nested too deeply");
  const children = elementChildren(node);
  let out = "";
  for (const item of node.content) {
    if (typeof item === "string") {
      if (item.trim() === "" && children.length > 0 && /[\n\r]/.test(item)) continue;
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
      throw new XfaError(`XFA form is malformed: packet '${shortName(name)}' is not a stream`);
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
      throw new XfaError(
        `XFA form is malformed: packet '${shortName(name)}' could not be decoded`,
        {
          cause: error,
        },
      );
    }
    if (decoded.length > MAX_XFA_PACKET_BYTES)
      throw new XfaError(
        `XFA packet '${shortName(name)}' is too large (${decoded.length} bytes, limit ${MAX_XFA_PACKET_BYTES})`,
      );
    // A duplicate packet name must fail closed: silently keeping the last
    // one would let a second template/datasets overwrite the first.
    if (packets.has(name))
      throw new XfaError(`XFA form is malformed: duplicate '${shortName(name)}' packet`);
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
  /**
   * The dataset-side parent path this field binds under, as segments
   * (S-1): carried from the enclosing subforms' bindings while the
   * template is collected, so resolution never has to guess which
   * template segments are data scope and which are layout. A subform
   * with no <bind> (or an explicit default bind) contributes its name;
   * a subform with <bind match="none"/> contributes nothing — its
   * transparency is established by the explicit declaration, as the
   * W-9's Page1/Page3/Page5 subforms show; a dataRef-bound subform
   * contributes its ref's path (replacing the accumulated scope, since
   * a $data. ref is absolute), WITH any `[N]` occurrence selector the
   * ref carries preserved on its segment (T-2, round 4) so the lookup
   * narrows to that occurrence. A global or unknown subform bind fails
   * closed at collection time: it cannot establish a data scope.
   */
  scope: string[];
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
 * A name that becomes a SOM path segment must be representable in a
 * dotted SOM path (S-2): a literal "." / "[" / "]" in a name would make
 * two distinct nodes collapse to one path string (a literal `<a.b>`
 * and a nested `a` > `b` both became `form.a.b.code`). Such names fail
 * closed naming the element instead of being silently misread. The
 * context may be a thunk so a long diagnostic path is only built when
 * validation actually fails (T-3, round 4): building it per child
 * would duplicate a long ancestor name across every leaf.
 */
function validateSomName(name: string, context: string | (() => string)): void {
  if (/[.[\]]/.test(name)) {
    const resolved = typeof context === "function" ? context() : context;
    throw new XfaError(
      `XFA packet is malformed: ${shortName(resolved)} has a name '${shortName(name)}' that cannot be represented in a SOM path`,
    );
  }
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

/**
 * Count one retained template SOM path against the aggregate internal
 * path bound (T-3, round 4): a long ancestor name is duplicated into
 * every field's somPath, so the retained total — not any single path —
 * is what must stay bounded. Throws a clear 422 past the bound.
 */
function countTemplatePath(pathBytes: { bytes: number }, fieldPath: string): void {
  pathBytes.bytes += utf8.encode(fieldPath).length;
  if (pathBytes.bytes > MAX_INTERNAL_PATH_BYTES)
    throw new XfaError(
      `XFA template paths exceed ${MAX_INTERNAL_PATH_BYTES} bytes in aggregate; refusing to report an unbounded result`,
    );
}

function buildTemplateField(
  node: XElement,
  somPath: string,
  scope: string[],
  pathBytes: { bytes: number },
): TemplateField | undefined {
  const name = attr(node, "name");
  if (typeof name !== "string" || name === "") return undefined;
  validateSomName(name, `field '${somPath === "" ? name : `${somPath}.${name}`}'`);
  const leafName = name;
  const fieldPath = somPath === "" ? leafName : `${somPath}.${leafName}`;
  countTemplatePath(pathBytes, fieldPath);
  const context = `field '${shortName(fieldPath)}'`;
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
    scope,
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
 * The dataset-side scope a subform contributes to the fields inside it
 * (S-1). A subform's <bind> is its data-scope declaration — the round-2
 * code never read it, so a dataRef-bound subform's fields were resolved
 * as if the subform were layout. Transparency is established only by
 * the binding itself: no <bind> (or an explicit default bind) binds by
 * name, <bind match="none"/> contributes nothing (the W-9's Page1 is
 * explicitly none-bound, which is why its fields resolve under
 * topmostSubform), and a dataRef replaces the accumulated scope with
 * its ref's path. A global or unknown subform bind cannot establish a
 * data scope and fails closed; so does a dataRef with a missing or
 * unparseable ref. No name-based "recognised layout segment" list is
 * kept: skipping a segment because of its name is the guessing this
 * fix removes.
 */
function subformScope(subform: XElement, path: string, scope: string[]): string[] {
  const name = attr(subform, "name");
  const context = `subform '${shortName(path)}'`;
  const bindNode = singletonChild(subform, "bind", context);
  if (bindNode === undefined) {
    if (typeof name === "string" && name !== "") return [...scope, name];
    return scope;
  }
  const { bind, ref } = parseBind(bindNode);
  if (bind === "none") return scope;
  if (bind === "default") {
    if (typeof name === "string" && name !== "") return [...scope, name];
    return scope;
  }
  if (bind === "dataRef") return parseDataRefSegments(ref, context);
  throw new XfaError(
    `XFA template/datasets mismatch: ${context} has a '${bind}' binding, which cannot establish a data scope`,
  );
}

/**
 * Walk the template tree collecting every <field> (and every <exclGroup>,
 * reported as one unsupported field whose options are its radio choices).
 * Repeated occurrences of one field collapse later, in the join — but
 * only for bound fields sharing a data node (see joinFields). Depth
 * accounting: the conversion pass already bounds the whole document to
 * MAX_XFA_DEPTH, so this walk's own guard is defense in depth —
 * including for field subtrees (ui/items/captions) this walk never
 * recurses into, which the conversion pass covers.
 */
function collectTemplateFields(
  node: XElement,
  path: string,
  scope: string[],
  depth: number,
  out: TemplateField[],
  pathBytes: { bytes: number },
): void {
  // Fail closed like the datasets walk: a form whose only fields are too
  // deep is a 422, never a silent field-less report.
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA template packet is nested too deeply");
  for (const child of elementChildren(node)) {
    if (child.local === "subform") {
      const name = attr(child, "name");
      const childPath =
        typeof name === "string" && name !== "" ? (path === "" ? name : `${path}.${name}`) : path;
      if (typeof name === "string" && name !== "") validateSomName(name, `subform '${childPath}'`);
      collectTemplateFields(
        child,
        childPath,
        subformScope(child, childPath, scope),
        depth + 1,
        out,
        pathBytes,
      );
    } else if (child.local === "field") {
      const field = buildTemplateField(child, path, scope, pathBytes);
      if (field) out.push(field);
    } else if (child.local === "exclGroup") {
      const name = attr(child, "name");
      if (typeof name !== "string" || name === "") continue;
      validateSomName(name, `exclGroup '${path === "" ? name : `${path}.${name}`}'`);
      const groupPath = path === "" ? name : `${path}.${name}`;
      countTemplatePath(pathBytes, groupPath);
      const options: string[] = [];
      const childBinds: { bind: BindKind; ref: string | undefined }[] = [];
      for (const optionField of childrenNamed(child, "field")) {
        const built = buildTemplateField(optionField, path, scope, pathBytes);
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
      const groupBindNode = singletonChild(child, "bind", `exclGroup '${shortName(groupPath)}'`);
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
            `XFA template/datasets mismatch: exclGroup '${shortName(groupPath)}' has no group binding and its option fields disagree`,
          );
        bind = first.bind;
        ref = first.ref;
      }
      const caption = singletonChild(child, "caption", `exclGroup '${shortName(groupPath)}'`);
      const captionValue =
        caption !== undefined
          ? nodeText(
              singletonChild(caption, "value", `exclGroup '${shortName(groupPath)}'`) ?? caption,
            )
          : "";
      out.push({
        somPath: groupPath,
        leafName: name,
        scope,
        ui: "unsupported",
        bind,
        ref,
        options: options.length > 0 ? options : undefined,
        label: captionValue !== "" ? normalizeSpace(captionValue) : undefined,
      });
    } else {
      collectTemplateFields(child, path, scope, depth + 1, out, pathBytes);
    }
  }
}

interface DataLeaf {
  /**
   * The dataset path as segments (S-2), not a joined string: a literal
   * `<a.b>` element and a nested `a` > `b` are different segment
   * arrays (`["form", "a.b", "code"]` vs `["form", "a", "b", "code"]`)
   * and must never collapse before collision checks. Repeat instances
   * carry their `[N]` suffix on the segment (`"repeat[1]"`). Segment
   * names can never contain "." / "[" / "]" (see validateSomName), so
   * joining the array with "." for the public SOM path is unambiguous.
   */
  segments: string[];
  value: string;
  /** True when the value carried markup (xhtml rich text). */
  markup: boolean;
}

/** The public SOM path for a segment array, e.g. form.repeat[1].itemName. */
function segmentPath(segments: string[]): string {
  return segments.join(".");
}

function stripSegmentIndex(segment: string): string {
  return segment.replace(/\[\d+\]$/, "");
}

function leafNameOf(segments: string[]): string {
  return stripSegmentIndex(segments.at(-1) ?? "");
}

function strippedSegments(segments: string[]): string[] {
  return segments.map(stripSegmentIndex);
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
function collectDataLeaves(node: XElement, path: string[], depth: number, out: DataLeaf[]): void {
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA datasets packet is nested too deeply");
  const children = elementChildren(node);
  if (children.length === 0) {
    // A leaf's value is its direct text, verbatim: dataset whitespace
    // is significant (the parser is configured with trimValues: false,
    // and no trimming happens here either).
    const value = node.content.filter((item): item is string => typeof item === "string").join("");
    out.push({ segments: path, value, markup: false });
    return;
  }
  // Rich-text values are leaves: their flattened text content, flagged.
  // Only actual rich-text containers count (an <xhtml> subtree or an
  // <exData> element) — a bare colon in a key used to trigger this too.
  // The flattened value keeps the text in document order (no whitespace
  // normalisation); block boundaries carry no separator.
  if (children.some((child) => child.local === "xhtml" || child.local === "exData")) {
    out.push({ segments: path, value: nodeText(node), markup: true });
    return;
  }
  const counts = new Map<string, number>();
  for (const child of children) counts.set(child.local, (counts.get(child.local) ?? 0) + 1);
  const seen = new Map<string, number>();
  for (const child of children) {
    // The diagnostic path is built lazily (thunk): it duplicates every
    // ancestor name, so building it per child would multiply a long
    // ancestor name across every leaf (T-3, round 4).
    validateSomName(child.local, () => `datasets element '${segmentPath([...path, child.local])}'`);
    const index = seen.get(child.local) ?? 0;
    seen.set(child.local, index + 1);
    const segment = (counts.get(child.local) ?? 1) > 1 ? `${child.local}[${index}]` : child.local;
    collectDataLeaves(child, [...path, segment], depth + 1, out);
  }
}

/**
 * Parse a dataRef to its path segments, PRESERVING any `[N]` occurrence
 * selectors (T-2, round 4) — or fail closed naming the context and the
 * ref: a missing, empty, or unparseable ref never falls back to name
 * matching. The ORIGINAL ref grammar is validated BEFORE any
 * normalization: the prefix must be `$data.` or bare, and every segment
 * must be a name with at most one trailing `[N]` index selector. An
 * index embedded inside a name (`cust[0]omer`) is unparseable —
 * stripping it first used to silently repair it into a different,
 * valid reference (`customer`). The round-3 code stripped `[N]` and
 * resolved every occurrence (`$data.form.person[1].taxId` reported
 * BOTH people; `[999]` resolved to the real people); a selector is now
 * honoured at lookup time instead of discarded. Each returned segment
 * keeps its selector (`"person[1]"` or `"person"`).
 */
function parseDataRefSegments(ref: string | undefined, context: string): string[] {
  if (ref === undefined)
    throw new XfaError(
      `XFA template/datasets mismatch: ${context} has a dataRef binding with a missing or empty ref`,
    );
  const withoutPrefix = ref.startsWith("$data.") ? ref.slice("$data.".length) : ref;
  const segments = withoutPrefix.split(".");
  if (segments.some((segment) => !/^[A-Za-z_][\w-]*(\[\d+\])?$/.test(segment)))
    throw new XfaError(
      `XFA template/datasets mismatch: ${context} has an unparseable dataRef '${shortName(ref)}'`,
    );
  return segments;
}

function parseDataRef(field: TemplateField): string[] {
  return parseDataRefSegments(field.ref, `field '${shortName(field.somPath)}'`);
}

/** The `[N]` selector on a path segment, or undefined when unindexed. */
function segmentIndex(segment: string): number | undefined {
  const match = /\[(\d+)\]$/.exec(segment);
  return match ? Number(match[1]) : undefined;
}

/**
 * The occurrence index a dataset segment IS: its `[N]` suffix, or 0
 * for a lone (unindexed) element — occurrence 0 of a single element is
 * that element, so `person[0]` selects it and `person[1]` does not.
 */
function leafOccurrence(segment: string): number {
  return segmentIndex(segment) ?? 0;
}

/**
 * Do a leaf's segments satisfy a selector path (a dataRef, or a scope
 * that carries a dataRef-bound subform's selectors)? The stripped paths
 * must already be equal (the byPath lookup guarantees that); each
 * `[N]` selector then narrows to that one occurrence, and an
 * unindexed selector accepts every occurrence of the name.
 */
function matchesSelectors(leafSegments: string[], selectors: string[]): boolean {
  if (leafSegments.length !== selectors.length) return false;
  return selectors.every((selector, position) => {
    const wanted = segmentIndex(selector);
    return wanted === undefined || leafOccurrence(leafSegments[position]) === wanted;
  });
}

/**
 * The join index, built once per inspect: leaves by leaf name and by
 * stripped path, in document order. Indexing means a field only ever
 * looks up its own exact path or its own name — unrelated leaves cost
 * nothing. CORRECTION (round 4, R-7): the round-3 claim that the
 * round-2 join-work budget (1,000,000 structural comparisons) could
 * simply be retired with the per-field name-scan was WRONG as a
 * blanket retirement — the scan is gone, but index construction and
 * pre-resolution occurrence merging are themselves amplification
 * paths the retirement left open (T-3/T-4). The budget is therefore
 * NOT retired unconditionally: the aggregate internal path/index byte
 * bound below (T-3) and the on-values merge bound in joinFields (T-4)
 * are the work bound that covers the pre-resolution paths, in place
 * of the retired per-field comparison count.
 */
interface JoinIndex {
  byName: Map<string, DataLeaf[]>;
  byPath: Map<string, DataLeaf[]>;
}

function buildJoinIndex(leaves: DataLeaf[]): JoinIndex {
  const byName = new Map<string, DataLeaf[]>();
  const byPath = new Map<string, DataLeaf[]>();
  // Aggregate internal path/index bytes (T-3): each distinct key
  // string is retained, so the total — not any single path — is what
  // must stay bounded. Counted only when a NEW key is materialized
  // (repeat instances of one path share its key); past the bound the
  // inspect fails closed instead of materializing more keys. This is
  // what stops a 64 KiB ancestor name × 2,000 leaves (~128 MB of key
  // characters) early, after only a few megabytes of work.
  let indexBytes = 0;
  for (const leaf of leaves) {
    const name = leafNameOf(leaf.segments);
    const named = byName.get(name);
    if (named) named.push(leaf);
    else {
      byName.set(name, [leaf]);
      indexBytes += utf8.encode(name).length;
    }
    const stripped = segmentPath(strippedSegments(leaf.segments));
    const pathed = byPath.get(stripped);
    if (pathed) pathed.push(leaf);
    else {
      byPath.set(stripped, [leaf]);
      indexBytes += utf8.encode(stripped).length;
    }
    if (indexBytes > MAX_INTERNAL_PATH_BYTES)
      throw new XfaError(
        `XFA join index exceeds ${MAX_INTERNAL_PATH_BYTES} bytes of internal paths; refusing to report an unbounded result`,
      );
  }
  return { byName, byPath };
}

/**
 * Find the datasets leaf/leaves a template field binds to.
 * - dataRef: the explicit SOM path, exact-matched, with any `[N]`
 *   occurrence selector honoured (T-2): `$data.form.person[1].taxId`
 *   selects only occurrence 1, and `[999]` matches nothing, so the
 *   field fails closed with no data node instead of resolving to the
 *   existing people. An unindexed ref still resolves every repeat
 *   instance of its path, as before.
 * - global: the first same-named leaf in document order, single field —
 *   the XFA semantic for global binding, distinct from default.
 * - default: EXACT scope-path match — the leaf's stripped path must
 *   equal the field's scope (carried from its enclosing subforms'
 *   bindings) plus its leaf name. A scope segment may itself carry a
 *   `[N]` selector from a dataRef-bound subform, which narrows the
 *   match to that occurrence the same way. No subsequence, no
 *   closest-match, no skipping: a template segment is skipped only
 *   where the subform binding establishes it (match="none" contributes
 *   nothing to the scope; a dataRef contributes its ref path), so a
 *   same-named leaf in an unrelated branch can never be claimed in
 *   either direction — template-deeper (the supplier scope contains no
 *   taxId, so the sibling customer leaf is out of scope) or
 *   dataset-deeper (a dataset segment the template never names is not
 *   in the scope). Repeat instances of the one exact path all resolve.
 *   The W-9 stays green because its Page1 is explicitly none-bound
 *   (scope [topmostSubform]) while its data-group subforms
 *   (Boxes3a-b_ReadOrder, Address_ReadOrder) carry no bind and so
 *   contribute their names, matching the datasets exactly.
 * Residual scope note, recorded explicitly: a subform with no <bind>
 * binds by name, so a template field under a real data branch whose
 * datasets omit that branch fails closed (no data node) — it does not
 * silently fall through to a same-named leaf elsewhere.
 */
function findLeaves(field: TemplateField, index: JoinIndex): DataLeaf[] {
  if (field.bind === "dataRef") {
    const selectors = parseDataRef(field);
    const candidates = index.byPath.get(stripIndices(selectors.join("."))) ?? [];
    return candidates.filter((leaf) => matchesSelectors(leaf.segments, selectors));
  }
  if (field.bind === "global") {
    const first = (index.byName.get(field.leafName) ?? [])[0];
    return first ? [first] : [];
  }
  // default: exact scope-path match (selectors in the scope honoured).
  const selectors = [...field.scope, field.leafName];
  const candidates = index.byPath.get(segmentPath(strippedSegments(selectors))) ?? [];
  return candidates.filter((leaf) => matchesSelectors(leaf.segments, selectors));
}

function toXfaField(field: TemplateField, leaf: DataLeaf, nameOverride?: string): XfaField {
  const out: XfaField = {
    name: nameOverride ?? segmentPath(leaf.segments),
    value: leaf.value,
    type: leaf.markup ? "unsupported" : field.ui,
  };
  if (field.options) out.options = field.options;
  if (field.label) out.label = field.label;
  if (field.onValues) out.onValues = field.onValues;
  return out;
}

/**
 * Join template fields to data nodes. Occurrence identity is retained
 * through resolution (S-4): template occurrences are grouped by
 * somPath, and occurrences that disagree on bind/ref/ui fail closed
 * instead of letting the first win. A group of BOUND occurrences
 * (default/global/dataRef) collapses to ONE field per shared data
 * identity — they share one data node, so they are repeat occurrences
 * of one field (W-9 c1_1 ×7 → one field); the per-occurrence
 * on-values are merged onto it. For `default` the identity includes
 * the inherited scope (T-1, round 4): same somPath under different
 * scopes binds different data nodes and must NOT collapse.
 * A group of UNBOUND occurrences (bind none, or an unknown match)
 * never shares a data node, so it must NOT collapse: each occurrence
 * is reported as its own field, with an occurrence index on the
 * public name when there is more than one (`form.code[0]`,
 * `form.code[1]` — the SOM occurrence syntax). A field with no data
 * node and no `bind none` fails closed — a template/datasets name
 * mismatch must never silently report a wrong value. Two distinct
 * template paths resolving to the same data node fail closed too
 * (public-name collision). The resolved output is capped twice: at
 * MAX_JOINED_FIELDS fields, and at MAX_JOINED_BYTES of serialized
 * resolved fields (S-5) — so no input can produce unbounded output
 * in count or in bytes.
 */
function joinFields(templateFields: TemplateField[], leaves: DataLeaf[]): XfaField[] {
  // Group occurrences by somPath, in first-occurrence order.
  const groups = new Map<string, TemplateField[]>();
  for (const field of templateFields) {
    const group = groups.get(field.somPath);
    if (group) group.push(field);
    else groups.set(field.somPath, [field]);
  }
  // Collapse each group to its resolution units: one unit for a bound
  // group (merged), one unit per occurrence for an unbound group.
  const units: TemplateField[] = [];
  for (const [somPath, occurrences] of groups) {
    const first = occurrences[0];
    for (const field of occurrences) {
      if (field.bind !== first.bind || field.ref !== first.ref || field.ui !== first.ui)
        throw new XfaError(
          `XFA template/datasets mismatch: field '${shortName(somPath)}' has conflicting bindings (bind '${first.bind}' vs '${field.bind}')`,
        );
    }
    if (first.bind === "none" || first.bind === "unsupported") {
      // No shared data node: keep every occurrence. A lone occurrence
      // keeps the plain somPath name; several get occurrence indices.
      occurrences.forEach((field, index) => {
        units.push({
          ...field,
          ...(occurrences.length > 1 ? { somPath: `${somPath}[${index}]` } : {}),
        });
      });
      continue;
    }
    // Bound occurrences collapse to one unit ONLY when they share one
    // data identity (T-1, round 4): for `default` the identity is the
    // inherited scope, for `dataRef` it is the ref (already checked
    // equal above), and for `global` the scope plays no part in the
    // lookup. Same somPath + different default scopes are DIFFERENT
    // fields — two same-named subforms dataRef-bound to different
    // branches — so they split into one unit each instead of the first
    // scope silently swallowing the rest. Unbound occurrences keep the
    // old behaviour (one unit per occurrence, scope irrelevant: they
    // share no data node at all).
    const identityOf = (field: TemplateField): string =>
      field.bind === "default" ? `default:${JSON.stringify(field.scope)}` : field.bind;
    const subGroups = new Map<string, TemplateField[]>();
    for (const field of occurrences) {
      const key = identityOf(field);
      const subGroup = subGroups.get(key);
      if (subGroup) subGroup.push(field);
      else subGroups.set(key, [field]);
    }
    for (const subOccurrences of subGroups.values()) {
      const merged: TemplateField = { ...subOccurrences[0] };
      // Checkbox on-values merge (T-4, round 4): ONE Set per merged
      // group, kept across occurrences — the old code rebuilt
      // `new Set(merged.onValues)` for every occurrence, which is
      // quadratic in the occurrence count. The merged on-values are
      // also byte-bounded here, before any output-byte check can see
      // them: a merged set larger than MAX_JOINED_BYTES could never
      // be emitted, so it fails closed at merge time instead of
      // accumulating without bound.
      let onValues: string[] | undefined =
        subOccurrences[0].onValues !== undefined ? [...subOccurrences[0].onValues] : undefined;
      const seen = new Set<string>(onValues ?? []);
      let onValuesBytes =
        onValues?.reduce((total, value) => total + utf8.encode(value).length + 2, 0) ?? 0;
      const checkOnValuesBytes = (): void => {
        if (onValuesBytes > MAX_JOINED_BYTES)
          throw new XfaError(
            `XFA join produced more than ${MAX_JOINED_BYTES} bytes of checkbox on-values for field '${shortName(somPath)}'; refusing to report an unbounded result`,
          );
      };
      checkOnValuesBytes();
      for (const field of subOccurrences.slice(1)) {
        if (field.onValues) {
          if (onValues === undefined) {
            onValues = [...field.onValues];
            for (const value of onValues) seen.add(value);
            onValuesBytes = onValues.reduce(
              (total, value) => total + utf8.encode(value).length + 2,
              0,
            );
            checkOnValuesBytes();
          } else {
            for (const value of field.onValues) {
              if (seen.has(value)) continue;
              seen.add(value);
              onValues.push(value);
              onValuesBytes += utf8.encode(value).length + 2;
              checkOnValuesBytes();
            }
          }
        }
        if (!merged.label && field.label) merged.label = field.label;
        if (!merged.options && field.options) merged.options = field.options;
      }
      merged.onValues = onValues;
      units.push(merged);
    }
  }
  // No template fields, no index (T-3, round 4): the join index was
  // built unconditionally, so a field-less template still paid the
  // full index cost of its datasets. Skipping it is necessary but not
  // sufficient — the general case is bounded by MAX_INTERNAL_PATH_BYTES.
  if (units.length === 0) return [];
  const index = buildJoinIndex(leaves);
  const out: XfaField[] = [];
  // M2, round 4: the serialized array opens with `[` (1 byte) and each
  // field contributes its JSON plus 1 byte for its `,` separator (or
  // the closing `]` on the last field) — so the running total starts
  // at 1, not 0. Starting at 0 undercounted the full array by exactly
  // 1 byte.
  let outBytes = 1;
  const resolvedByName = new Map<string, string>();
  const push = (field: XfaField, somPath: string): void => {
    const previous = resolvedByName.get(field.name);
    if (previous !== undefined && previous !== somPath)
      throw new XfaError(
        `XFA template/datasets mismatch: fields '${shortName(previous)}' and '${shortName(somPath)}' resolve to the same data node '${shortName(field.name)}'`,
      );
    resolvedByName.set(field.name, somPath);
    out.push(field);
    if (out.length > MAX_JOINED_FIELDS)
      throw new XfaError(
        `XFA join produced more than ${MAX_JOINED_FIELDS} fields; refusing to report an unbounded result`,
      );
    // Aggregate output-byte bound (S-5): the serialized size of every
    // resolved field so far (name, value, label, options, on-values).
    // Enforced here, during the join — before persistence or HTTP
    // serialization can ever see the result.
    outBytes += utf8.encode(JSON.stringify(field)).length + 1;
    if (outBytes > MAX_JOINED_BYTES)
      throw new XfaError(
        `XFA join produced more than ${MAX_JOINED_BYTES} bytes of resolved fields; refusing to report an unbounded result`,
      );
  };
  const unbound = (field: TemplateField): XfaField => {
    const result: XfaField = { name: field.somPath, value: "", type: "unsupported" };
    if (field.options) result.options = field.options;
    if (field.label) result.label = field.label;
    return result;
  };
  for (const field of units) {
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
        `XFA template/datasets mismatch: field '${shortName(field.somPath)}' has no data node`,
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
  collectTemplateFields(templateRoot, "", [], 0, templateFields, { bytes: 0 });
  const leaves: DataLeaf[] = [];
  collectDataLeaves(dataRoot, [], 0, leaves);
  return { fields: joinFields(templateFields, leaves), formKind: xfaFormKind(doc) ?? "xfa-static" };
}
