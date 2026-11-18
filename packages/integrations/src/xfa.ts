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
    // Final length cap (U-P2, round 5): no XfaError message can ever
    // exceed this many UTF-8 bytes, regardless of interpolation site.
    // shortName() bounds the known attacker-controlled components, but
    // a missed site (or a dependency diagnostic echoed verbatim, as
    // the XML validator does with a long tag name) must still stay
    // small. Truncation is by bytes so the cap holds even for
    // multi-byte text; the marker names the cut.
    super(capErrorMessage(message), options);
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

/** Hard cap on any XfaError message, in UTF-8 bytes (U-P2, round 5). */
const MAX_ERROR_MESSAGE_CHARS = 1024;

function capErrorMessage(message: string): string {
  if (utf8.encode(message).length <= MAX_ERROR_MESSAGE_CHARS) return message;
  const marker = "… [truncated]";
  let text = message.slice(0, MAX_ERROR_MESSAGE_CHARS - marker.length);
  while (utf8.encode(`${text}${marker}`).length > MAX_ERROR_MESSAGE_CHARS) text = text.slice(0, -1);
  return `${text}${marker}`;
}

/**
 * UTF-8 byte length without allocating an encoded copy: pure-ASCII
 * strings are one byte per character, and only a string containing a
 * non-ASCII code unit pays for a real encode. Used wherever a byte
 * budget is charged per leaf/field, so the charging itself does not
 * become the allocation the budget is meant to bound (U-2, round 5).
 */
function utf8Length(value: string): number {
  for (let i = 0; i < value.length; i++)
    if (value.charCodeAt(i) > 127) return utf8.encode(value).length;
  return value.length;
}

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
function singletonChild(
  element: XElement,
  local: string,
  context: string | (() => string),
): XElement | undefined {
  const found = childrenNamed(element, local);
  if (found.length > 1)
    throw new XfaError(
      `XFA packet is malformed: ${shortName(typeof context === "function" ? context() : context)} has more than one <${local}> element`,
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
  if (depth > MAX_XFA_DEPTH)
    throw new XfaError(`XFA ${shortName(packetName)} packet is nested too deeply`);
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
        `XFA ${shortName(packetName)} packet has a namespace collision on element '${shortName(item.local)}': '${shortName(previous)}' and '${shortName(item.name)}' normalize to the same name`,
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
function nodeText(node: XElement | string, depth = 0, preserve = false): string {
  if (typeof node === "string") return node;
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA packet is nested too deeply");
  // Whitespace preservation is inherited (U-5, round 5): an
  // xml:space="preserve" ancestor means keep whitespace verbatim
  // (including newlines) for the whole subtree; xml:space="default"
  // resets to the current behaviour. Without an explicit attribute
  // the parent's state carries through.
  const space = attr(node, "xml:space");
  const keep = space === "preserve" ? true : space === "default" ? false : preserve;
  const children = elementChildren(node);
  let out = "";
  for (const item of node.content) {
    if (typeof item === "string") {
      if (!keep && item.trim() === "" && children.length > 0 && /[\n\r]/.test(item)) continue;
      out += item;
    } else {
      out += nodeText(item, depth + 1, keep);
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
    throw new XfaError(`XFA packet '${shortName(packetName)}' is not valid UTF-8 XML`, {
      cause: error,
    });
  }
  // fast-xml-parser refuses external entities, but a DOCTYPE is still
  // refused outright: no DTD of any kind is legitimate in an XFA packet.
  if (/<!DOCTYPE/i.test(text))
    throw new XfaError(
      `XFA packet '${shortName(packetName)}' contains a DOCTYPE declaration, which is not allowed`,
    );
  if ((text.match(/</g) ?? []).length > MAX_XFA_TAGS)
    throw new XfaError(`XFA packet '${shortName(packetName)}' has too many XML nodes`);
  // fast-xml-parser's parse step alone does not reject every malformed
  // document (a template missing only its final closing tag parses), so
  // validate well-formedness explicitly first, on every packet.
  const validation = XMLValidator.validate(text);
  if (validation !== true)
    throw new XfaError(
      `XFA packet '${shortName(packetName)}' is not parseable XML: ${shortName(validation.err.msg)} (line ${validation.err.line}, col ${validation.err.col})`,
    );
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(text);
  } catch (error) {
    throw new XfaError(`XFA packet '${shortName(packetName)}' is not parseable XML`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed))
    throw new XfaError(`XFA packet '${shortName(packetName)}' is not parseable XML`);
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
   * contributes its ref's path: an absolute (`$data.`) ref replaces
   * the accumulated scope, while a bare ref resolves RELATIVE to the
   * parent scope (U-1, round 5) — WITH any `[N]` occurrence selector
   * the ref carries preserved on its segment (T-2, round 4) so the lookup
   * narrows to that occurrence. A global or unknown subform bind fails
   * closed at collection time: it cannot establish a data scope.
   */
  scope: string[];
  /**
   * Interned identity of `scope` (U-2, round 5): two scopes are the
   * same exactly when their ids are equal, so the collapse identity
   * never serializes a scope — `JSON.stringify(field.scope)` per
   * occurrence used to re-serialize a long shared parent scope for
   * every field under it, charged to no bound.
   */
  scopeId: number;
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
 * A dataset-side scope as carried down the template walk (U-2, round
 * 5). `segments` is shared by reference — a child scope extends its
 * parent's array by one segment (an array of references, never a
 * re-join of the parent's path string), so a wide tree under one long
 * parent scope does not copy that scope's characters per child. The
 * template path strings that ARE retained (each field's somPath) are
 * still charged in aggregate by countTemplatePath, which trips after
 * a bounded number of long paths; a field-less subtree builds no
 * path string at all, because the walk carries segment arrays and
 * joins them only when a field is actually built.
 */
interface ScopeContext {
  id: number;
  segments: string[];
}

/**
 * Scope interning (U-2, round 5): each distinct scope gets a small
 * integer id, keyed by (parent scope id, one segment). Interning
 * happens once per subform on the walk down — never per field — and
 * the key never contains a parent scope string, so neither a long
 * scope nor a long parent is copied or serialized per occurrence.
 * An absolute dataRef scope folds from the root one segment at a
 * time; a bare (relative) dataRef scope folds from the parent scope.
 */
class ScopeInterner {
  private nextId = 1;
  private readonly ids = new Map<string, number>();
  readonly root: ScopeContext = { id: 0, segments: [] };

  child(parent: ScopeContext, segment: string): ScopeContext {
    const key = `${parent.id}\u0000${segment}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(key, id);
    }
    return { id, segments: [...parent.segments, segment] };
  }
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
  pathBytes.bytes += utf8Length(fieldPath);
  if (pathBytes.bytes > MAX_INTERNAL_PATH_BYTES)
    throw new XfaError(
      `XFA template paths exceed ${MAX_INTERNAL_PATH_BYTES} bytes in aggregate; refusing to report an unbounded result`,
    );
}

function buildTemplateField(
  node: XElement,
  pathSegments: string[],
  scope: ScopeContext,
  pathBytes: { bytes: number },
): TemplateField | undefined {
  const parentPath = (): string => segmentPath(pathSegments);
  // The binding is read BEFORE the name check (U-4, round 5): an
  // explicitly bound unnamed field must be inspected or rejected,
  // never dropped silently. Only a field with no <bind> at all keeps
  // the old behaviour (dropped — it has no data semantics).
  const bindNode = singletonChild(node, "bind", () => `field under '${shortName(parentPath())}'`);
  const { bind, ref, rawMatch } = parseBind(bindNode);
  const name = attr(node, "name");
  let leafName: string;
  let fieldPath: string;
  if (typeof name !== "string" || name === "") {
    if (bindNode === undefined) return undefined;
    if (bind === "dataRef" && ref !== undefined) {
      let segments: string[];
      try {
        segments = parseDataRefSegments(
          ref,
          () => `unnamed field under '${shortName(parentPath())}'`,
        ).segments;
      } catch {
        throw new XfaError(
          `XFA template/datasets mismatch: template field with no name under '${shortName(parentPath())}' has an explicit 'dataRef' binding and cannot be reported`,
        );
      }
      // Inspect under a derived name taken from the ref's last
      // segment, stripped of any [N] selector (U-4): the datasets
      // path supplies a usable public name, so silent omission is
      // not forced by the format.
      leafName = stripSegmentIndex(segments.at(-1) ?? "");
      fieldPath = pathSegments.length === 0 ? leafName : `${parentPath()}.${leafName}`;
    } else {
      throw new XfaError(
        `XFA template/datasets mismatch: template field with no name under '${shortName(parentPath())}' has an explicit '${bind === "unsupported" ? (rawMatch ?? bind) : bind}' binding and cannot be reported`,
      );
    }
  } else {
    leafName = name;
    validateSomName(
      leafName,
      () => `field '${pathSegments.length === 0 ? leafName : `${parentPath()}.${leafName}`}'`,
    );
    fieldPath = pathSegments.length === 0 ? leafName : `${parentPath()}.${leafName}`;
  }
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
    scope: scope.segments,
    scopeId: scope.id,
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
function subformScope(
  subform: XElement,
  pathSegments: string[],
  scope: ScopeContext,
  interner: ScopeInterner,
): ScopeContext {
  const name = attr(subform, "name");
  const context = (): string => `subform '${shortName(segmentPath(pathSegments))}'`;
  const bindNode = singletonChild(subform, "bind", context);
  if (bindNode === undefined) {
    if (typeof name === "string" && name !== "") return interner.child(scope, name);
    return scope;
  }
  const { bind, ref } = parseBind(bindNode);
  if (bind === "none") return scope;
  if (bind === "default") {
    if (typeof name === "string" && name !== "") return interner.child(scope, name);
    return scope;
  }
  if (bind === "dataRef") {
    // A dataRef-bound subform's scope is its ref's path — absolute
    // when the ref is "$data."-prefixed (it replaces the accumulated
    // scope, as before), RELATIVE to the parent scope when the ref is
    // bare (U-1, round 5): a bare ref under form.customer means
    // form.customer.<ref>, not <ref> from the dataset root.
    const { segments, absolute } = parseDataRefSegments(ref, context);
    let next = absolute ? interner.root : scope;
    for (const segment of segments) next = interner.child(next, segment);
    return next;
  }
  throw new XfaError(
    `XFA template/datasets mismatch: ${context()} has a '${bind}' binding, which cannot establish a data scope`,
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
  pathSegments: string[],
  scope: ScopeContext,
  interner: ScopeInterner,
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
        typeof name === "string" && name !== "" ? [...pathSegments, name] : pathSegments;
      if (typeof name === "string" && name !== "")
        validateSomName(name, () => `subform '${segmentPath(childPath)}'`);
      collectTemplateFields(
        child,
        childPath,
        subformScope(child, childPath, scope, interner),
        interner,
        depth + 1,
        out,
        pathBytes,
      );
    } else if (child.local === "field") {
      const field = buildTemplateField(child, pathSegments, scope, pathBytes);
      if (field) out.push(field);
    } else if (child.local === "exclGroup") {
      const name = attr(child, "name");
      if (typeof name !== "string" || name === "") {
        // U-4, round 5: an unnamed group is dropped ONLY when it
        // carries no binding anywhere — a group <bind>, or a <bind>
        // on any child option field, means the group has data
        // semantics and disappearing silently would hide it.
        const hasGroupBind = childrenNamed(child, "bind").length > 0;
        const hasChildBind = childrenNamed(child, "field").some(
          (optionField) => childrenNamed(optionField, "bind").length > 0,
        );
        if (hasGroupBind || hasChildBind)
          throw new XfaError(
            `XFA template/datasets mismatch: exclGroup with no name under '${shortName(segmentPath(pathSegments))}' has an explicit binding and cannot be reported`,
          );
        continue;
      }
      const groupPathSegments = [...pathSegments, name];
      validateSomName(name, () => `exclGroup '${segmentPath(groupPathSegments)}'`);
      const groupPath = segmentPath(groupPathSegments);
      countTemplatePath(pathBytes, groupPath);
      const options: string[] = [];
      const childBinds: { bind: BindKind; ref: string | undefined }[] = [];
      for (const optionField of childrenNamed(child, "field")) {
        const optionName = attr(optionField, "name");
        if (typeof optionName !== "string" || optionName === "") {
          // U-4: an unnamed option inside a NAMED group — a <bind>
          // on it fails closed; <items> text supplies the option
          // (first item text); with neither it is skipped, as before.
          if (childrenNamed(optionField, "bind").length > 0)
            throw new XfaError(
              `XFA template/datasets mismatch: exclGroup '${shortName(groupPath)}' has an unnamed option field with an explicit binding and cannot be reported`,
            );
          const texts = itemTexts(optionField);
          if (texts.length > 0) options.push(texts[0]);
          continue;
        }
        const built = buildTemplateField(optionField, pathSegments, scope, pathBytes);
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
        scope: scope.segments,
        scopeId: scope.id,
        ui: "unsupported",
        bind,
        ref,
        options: options.length > 0 ? options : undefined,
        label: captionValue !== "" ? normalizeSpace(captionValue) : undefined,
      });
    } else {
      collectTemplateFields(child, pathSegments, scope, interner, depth + 1, out, pathBytes);
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
  // Fast path (U-2, round 5): most segments carry no "[N]" suffix,
  // so return the original string instead of allocating a copy per
  // segment on every strip. Only a trailing "]" can hold a selector.
  if (!segment.endsWith("]")) return segment;
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
 *
 * The absolute/bare distinction is PRESERVED (U-1, round 5): a
 * `$data.`-prefixed ref is absolute from the dataset root, while a
 * bare ref resolves RELATIVE to the field's (or subform's parent's)
 * inherited scope. Callers must not treat the segments as absolute
 * without checking `absolute`.
 */
function parseDataRefSegments(
  ref: string | undefined,
  context: string | (() => string),
): { segments: string[]; absolute: boolean } {
  const ctx = (): string => (typeof context === "function" ? context() : context);
  if (ref === undefined)
    throw new XfaError(
      `XFA template/datasets mismatch: ${ctx()} has a dataRef binding with a missing or empty ref`,
    );
  const absolute = ref.startsWith("$data.");
  const withoutPrefix = absolute ? ref.slice("$data.".length) : ref;
  const segments = withoutPrefix.split(".");
  if (segments.some((segment) => !/^[A-Za-z_][\w-]*(\[\d+\])?$/.test(segment)))
    throw new XfaError(
      `XFA template/datasets mismatch: ${ctx()} has an unparseable dataRef '${shortName(ref)}'`,
    );
  return { segments, absolute };
}

/**
 * The dataset-side path a dataRef field resolves to (U-1, round 5):
 * an absolute ref is its own path; a bare ref resolves relative to
 * the field's inherited scope.
 */
function effectiveDataRefSegments(field: TemplateField): string[] {
  const { segments, absolute } = parseDataRefSegments(
    field.ref,
    () => `field '${shortName(field.somPath)}'`,
  );
  return absolute ? segments : [...field.scope, ...segments];
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
 * nothing. R-7 CORRECTION (round 5): the round-4 correction claimed
 * the retired per-field comparison budget was covered by the
 * aggregate internal path/index byte bound (T-3) and the on-values
 * merge bound (T-4). That was still unsound — neither bound covers
 * construction work per repeated leaf (U-2) or per-field filtering
 * work inside one repeated-path bucket (U-3). The work bound is
 * therefore the COMBINATION of all four, each covering exactly what
 * it names and nothing more:
 * (a) the construction-bytes budget below (U-2): every leaf's
 * stripped-path bytes and name bytes are charged as they are
 * processed, per leaf, before the joined key string is built — so
 * repeated leaves under one long ancestor trip the bound after a
 * bounded number of leaves instead of after the whole index is
 * built; plus scope interning in the template walk, so a long scope
 * is never re-serialized per field occurrence;
 * (b) the aggregate structural-comparison budget (U-3, restored):
 * every candidate leaf examined by findLeaves, counted across ALL
 * findLeaves calls in one inspect, capped at 1,000,000 (the
 * original R-7 number) — the backstop for filtering work that
 * remains after selector-aware narrowing;
 * (c) the on-values merge byte bound in joinFields (T-4): merged
 * checkbox on-values for one collapsed group may not exceed the
 * 1 MiB output bound;
 * (d) the output count/byte bounds (S-5): at most 10,000 resolved
 * fields totalling at most 1 MiB of serialized JSON.
 * No single one of these retires the others, and no claim is made
 * beyond them: in particular, the depth gate still runs after
 * dependency parsing, and the byte budgets bound work done inside
 * this module, not the parser's internal work.
 */
interface PathBucket {
  leaves: DataLeaf[];
  /**
   * Occurrence index (U-3, round 5): byOccurrence.get(position) maps
   * an occurrence index at that segment position to the leaves whose
   * segment there has that occurrence — so a `[N]` selector narrows
   * to its branch BEFORE any filtering, instead of filtering the
   * whole repeated-path bucket per field.
   */
  byOccurrence: Map<number, Map<number, DataLeaf[]>>;
}

interface JoinIndex {
  byName: Map<string, DataLeaf[]>;
  byPath: Map<string, PathBucket>;
}

/** Aggregate cap on structural comparisons across one inspect (U-3, round 5). */
const MAX_STRUCTURAL_COMPARISONS = 1_000_000;

interface JoinBudget {
  comparisons: number;
}

function checkComparisons(budget: JoinBudget): void {
  if (budget.comparisons > MAX_STRUCTURAL_COMPARISONS)
    throw new XfaError(
      `XFA join exceeded ${MAX_STRUCTURAL_COMPARISONS} structural comparisons; refusing to report an unbounded result`,
    );
}

function buildJoinIndex(leaves: DataLeaf[]): JoinIndex {
  const byName = new Map<string, DataLeaf[]>();
  const byPath = new Map<string, PathBucket>();
  // Aggregate internal path/index bytes (T-3, corrected U-2, round
  // 5): the bytes are charged for EVERY leaf, not only when a NEW key
  // is materialized — the construction work (building the stripped
  // path string and looking it up) happens per leaf whether the key
  // already exists or not, so charging only new keys let 10,000
  // leaves under one 256 KiB ancestor construct ~2.5 GiB of path
  // strings while the retained key stayed far below the bound. The
  // charge is computed from the segments' byte lengths BEFORE the
  // joined key string is built, and the bound is checked per leaf,
  // so it trips promptly after a bounded amount of work.
  let indexBytes = 0;
  for (const leaf of leaves) {
    const name = leafNameOf(leaf.segments);
    indexBytes += utf8Length(name);
    if (indexBytes > MAX_INTERNAL_PATH_BYTES)
      throw new XfaError(
        `XFA join index exceeds ${MAX_INTERNAL_PATH_BYTES} bytes of internal paths; refusing to report an unbounded result`,
      );
    const named = byName.get(name);
    if (named) named.push(leaf);
    else byName.set(name, [leaf]);
    const strippedSegmentsList = strippedSegments(leaf.segments);
    let strippedBytes = strippedSegmentsList.length - 1;
    for (const segment of strippedSegmentsList) strippedBytes += utf8Length(segment);
    indexBytes += strippedBytes;
    if (indexBytes > MAX_INTERNAL_PATH_BYTES)
      throw new XfaError(
        `XFA join index exceeds ${MAX_INTERNAL_PATH_BYTES} bytes of internal paths; refusing to report an unbounded result`,
      );
    const stripped = strippedSegmentsList.join(".");
    let bucket = byPath.get(stripped);
    if (!bucket) {
      bucket = { leaves: [], byOccurrence: new Map() };
      byPath.set(stripped, bucket);
    }
    bucket.leaves.push(leaf);
    leaf.segments.forEach((segment, position) => {
      const occurrence = leafOccurrence(segment);
      let byOccurrence = bucket.byOccurrence.get(position);
      if (!byOccurrence) {
        byOccurrence = new Map();
        bucket.byOccurrence.set(position, byOccurrence);
      }
      const list = byOccurrence.get(occurrence);
      if (list) list.push(leaf);
      else byOccurrence.set(occurrence, [leaf]);
    });
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
 *   instance of its path, as before. A bare (no `$data.`) ref is
 *   RELATIVE to the field's inherited scope (U-1, round 5): under a
 *   customer scope, `taxId` means `form.customer.taxId`, never the
 *   dataset-root `taxId`.
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
/**
 * Look up the leaves for a selector path in one stripped-path bucket.
 * A `[N]` selector narrows BEFORE filtering (U-3, round 5): the
 * indexed selector position with the smallest candidate set is
 * followed, so `person[1]` examines only that branch instead of
 * filtering all 4,000 persons. Every candidate leaf actually
 * examined is counted against the aggregate comparison budget, so
 * filtering work that remains (e.g. an unindexed fan-out) still
 * fails closed instead of growing with fields × bucket size.
 */
function lookupSelectors(index: JoinIndex, selectors: string[], budget: JoinBudget): DataLeaf[] {
  const bucket = index.byPath.get(stripIndices(selectors.join(".")));
  if (!bucket) return [];
  let candidates: DataLeaf[] | undefined;
  for (let position = 0; position < selectors.length; position++) {
    const wanted = segmentIndex(selectors[position]);
    if (wanted === undefined) continue;
    const narrowed = bucket.byOccurrence.get(position)?.get(wanted) ?? [];
    if (candidates === undefined || narrowed.length < candidates.length) candidates = narrowed;
  }
  const pool = candidates ?? bucket.leaves;
  const out: DataLeaf[] = [];
  for (const leaf of pool) {
    budget.comparisons += 1;
    checkComparisons(budget);
    if (matchesSelectors(leaf.segments, selectors)) out.push(leaf);
  }
  return out;
}

function findLeaves(field: TemplateField, index: JoinIndex, budget: JoinBudget): DataLeaf[] {
  if (field.bind === "dataRef") {
    return lookupSelectors(index, effectiveDataRefSegments(field), budget);
  }
  if (field.bind === "global") {
    const first = (index.byName.get(field.leafName) ?? [])[0];
    return first ? [first] : [];
  }
  // default: exact scope-path match (selectors in the scope honoured).
  const selectors = [...field.scope, field.leafName];
  return lookupSelectors(index, selectors, budget);
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
    // data identity (T-1, round 4; U-1, round 5): for `default` the
    // identity is the inherited scope (as its interned id — never a
    // re-serialized scope string), for `dataRef` it is the EFFECTIVE
    // ref path — an absolute ref resolves identically whatever the
    // scope, but a bare ref resolves relative to it, so two
    // same-template-path fields with identical bare refs under
    // different scopes are DIFFERENT fields and must NOT collapse
    // (the old identity keyed dataRef fields by the string
    // "dataRef" alone and collapsed them onto a dataset-root decoy),
    // and for `global` the scope plays no part in the lookup. Same
    // somPath + different default scopes are DIFFERENT fields — two
    // same-named subforms dataRef-bound to different branches — so
    // they split into one unit each instead of the first scope
    // silently swallowing the rest. Unbound occurrences keep the
    // old behaviour (one unit per occurrence, scope irrelevant: they
    // share no data node at all).
    const identityOf = (field: TemplateField): string => {
      if (field.bind === "default") return `default:${field.scopeId}`;
      if (field.bind === "dataRef") {
        const { absolute } = parseDataRefSegments(
          field.ref,
          () => `field '${shortName(field.somPath)}'`,
        );
        return absolute ? `dataRef:${field.ref}` : `dataRef:${field.scopeId}:${field.ref}`;
      }
      return field.bind;
    };
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
      let onValuesBytes = onValues?.reduce((total, value) => total + utf8Length(value) + 2, 0) ?? 0;
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
            onValuesBytes = onValues.reduce((total, value) => total + utf8Length(value) + 2, 0);
            checkOnValuesBytes();
          } else {
            for (const value of field.onValues) {
              if (seen.has(value)) continue;
              seen.add(value);
              onValues.push(value);
              onValuesBytes += utf8Length(value) + 2;
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
  // Aggregate comparison budget (U-3, round 5): one shared counter
  // across every findLeaves call in this inspect.
  const budget: JoinBudget = { comparisons: 0 };
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
    const matches = findLeaves(field, index, budget);
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
  const interner = new ScopeInterner();
  collectTemplateFields(templateRoot, [], interner.root, interner, 0, templateFields, {
    bytes: 0,
  });
  const leaves: DataLeaf[] = [];
  collectDataLeaves(dataRoot, [], 0, leaves);
  return { fields: joinFields(templateFields, leaves), formKind: xfaFormKind(doc) ?? "xfa-static" };
}
