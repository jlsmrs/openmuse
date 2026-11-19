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
 * Cumulative bound on namespace-map copying (A-1, round 11): an
 * element that declares a namespace gets a fresh copy of its
 * parent's whole bindings map, so one wide ancestor (thousands of
 * prefixes) times many declaring descendants multiplies retained
 * map entries as their PRODUCT — depth bounds ancestor count, NOT
 * declarations per ancestor, so the round-10 "O(depth²) and small"
 * claim was wrong and is RETRACTED here (see the R-7 correction
 * below). Each copy is charged its parent's map size plus the
 * element's own declaration count, and the total across one packet
 * conversion may not exceed this. 250,000 entries leaves ample
 * room for legitimate forms (the W-9 declares a handful of
 * namespaces; a form with 100 prefixes at its root and 1,000
 * declaring descendants charges 100,000) while capping the
 * amplification at a small multiple of the input: the worst
 * retained map total is ~250k entries, reached only by failing
 * closed with a 422 before the copy is made. Calibration is open:
 * a legitimate form with an unusually wide namespace environment
 * AND many declaring descendants could trip it.
 */
const MAX_CUMULATIVE_NS_BINDING_ENTRIES = 250_000;
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
 * Cumulative bound on duplicate-merge work (A-4, round 7): merging a
 * duplicate touches the accumulated field (value/options/label
 * comparisons), so duplicates × retained field size is the
 * amplification shape — 8,192 duplicates of one ~900 KiB field
 * re-serialized ~7,200 MiB with no bound tripping. Each duplicate
 * merge is charged the merged field's retained serialized size (the
 * work a naive re-serialization would have paid, and an upper bound
 * on the comparison work the merge can do against that field), and
 * the total across one inspect may not exceed this. 64 MiB leaves
 * ample room for legitimate repeats (the W-9's 7 duplicates of tiny
 * fields charge a few hundred bytes) while capping the amplification
 * at a small multiple of the input. Calibration is open: a legitimate
 * form with many duplicates of a near-1 MiB field could trip it.
 */
const MAX_CUMULATIVE_DUPLICATE_BYTES = 64 * 1024 * 1024;
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
 * Bound on dataRef segment count (A-1, round 6): a dataRef is folded
 * one segment at a time through ScopeInterner.child(), and no dataset
 * leaf path can exceed MAX_XFA_DEPTH segments (the whole-document
 * depth gate), so a ref with more segments than that can never
 * resolve — it fails closed at parse time, before any folding, so a
 * field-less subtree is charged too. 100 segments is far above any
 * legitimate SOM path (the W-9's longest ref is a handful).
 */
const MAX_DATA_REF_SEGMENTS = MAX_XFA_DEPTH;
/**
 * Bounds on `[N]` occurrence selectors (A-2, round 6): a selector's
 * digit run is capped at 7 characters and its value at 1,000,000. No
 * occurrence index can exceed the number of sibling repeats, itself
 * capped by MAX_XFA_TAGS (200,000), so a larger value can never match
 * a real leaf — rejecting it at parse time is fail-closed, and the cap
 * keeps selector parsing a bounded, once-per-field operation instead
 * of a per-candidate one.
 */
const MAX_SELECTOR_DIGITS = 7;
const MAX_SELECTOR_INDEX = 1_000_000;
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
 *
 * Namespace bindings (A-1, round 10; copying bounded A-1, round 11):
 * `ns` is the resolved namespace URI of the element's own qualified
 * name — the binding for its prefix, or the in-scope default
 * namespace for an unprefixed name — or undefined when the element
 * is in no namespace. `nsUnbound` is true when the name carries a
 * prefix with no binding in scope: its namespace is UNKNOWN, not
 * "none", and classification fails closed on it. `bindings` is the
 * full in-scope prefix→URI map ("" is the default namespace) at
 * this element, inherited down the walk: a binding declared on an
 * ancestor governs descendants until redeclared, exactly as XML
 * namespaces work. The map is shared, never mutated after creation
 * — an element that declares a namespace gets a fresh copy — but
 * that copy is NOT free: it copies every inherited entry, so a wide
 * ancestor times many declaring descendants multiplies retained
 * entries as their product (A-1, round 11). Copying is therefore
 * charged against a cumulative per-packet budget
 * (MAX_CUMULATIVE_NS_BINDING_ENTRIES) in namespaceBindingsFor(),
 * which fails closed before a copy that would exceed it; depth
 * bounds ancestor count, not declarations per ancestor, and no
 * depth-based bound is claimed for this work.
 */
interface XElement {
  name: string;
  local: string;
  attrs: Record<string, string>;
  content: Array<XElement | string>;
  ns: string | undefined;
  nsUnbound: boolean;
  bindings: ReadonlyMap<string, string>;
}

/** In-scope bindings at a packet root: only the implicit `xml` prefix. */
const ROOT_NS_BINDINGS: ReadonlyMap<string, string> = new Map([
  ["xml", "http://www.w3.org/XML/1998/namespace"],
]);

/**
 * Cumulative namespace-map copying charged so far in one packet
 * conversion (A-1, round 11): every fresh bindings map is charged
 * its parent's size (the entries copied) plus its own declaration
 * count, so the sum bounds the total retained map entries for the
 * packet. Created once per packet in parseXfaXml and threaded
 * through convertEntries/convertEntry; never shared across packets.
 */
interface NsBindingBudget {
  used: number;
}

/**
 * The in-scope namespace bindings for an element: its parent's map,
 * plus any `xmlns` / `xmlns:prefix` declaration the element itself
 * carries. A declaration of "" undeclares that prefix (or the default
 * namespace). Returns the parent map unchanged — shared, not copied —
 * when the element declares nothing. When the element DOES declare,
 * the fresh copy is charged against the packet's cumulative budget
 * BEFORE it is made (A-1, round 11): if the charge would exceed
 * MAX_CUMULATIVE_NS_BINDING_ENTRIES the inspect fails closed with a
 * 422 instead of building the copy. The check runs before the copy,
 * so no over-budget map is ever retained; a field-less template is
 * charged too, because conversion runs before field collection.
 */
function namespaceBindingsFor(
  rawAttrs: XmlRecord,
  parent: ReadonlyMap<string, string>,
  packetName: string,
  budget: NsBindingBudget,
): ReadonlyMap<string, string> {
  const declarations: Array<{ prefix: string; value: string }> = [];
  for (const [key, value] of Object.entries(rawAttrs)) {
    if (typeof value !== "string") continue;
    if (key === "@_xmlns") declarations.push({ prefix: "", value });
    else if (key.startsWith("@_xmlns:"))
      declarations.push({ prefix: key.slice("@_xmlns:".length), value });
  }
  if (declarations.length === 0) return parent;
  const charge = parent.size + declarations.length;
  if (budget.used + charge > MAX_CUMULATIVE_NS_BINDING_ENTRIES)
    throw new XfaError(
      `XFA ${shortName(packetName)} packet declares too many namespace bindings (cumulative copied bindings would exceed ${MAX_CUMULATIVE_NS_BINDING_ENTRIES} entries; refusing to build unbounded namespace maps)`,
    );
  budget.used += charge;
  const bindings = new Map(parent);
  for (const { prefix, value } of declarations) {
    if (value === "") bindings.delete(prefix);
    else bindings.set(prefix, value);
  }
  return bindings;
}

/** Resolve an element name against its in-scope bindings. */
function resolveElementNamespace(
  tagKey: string,
  bindings: ReadonlyMap<string, string>,
): { ns: string | undefined; nsUnbound: boolean } {
  const colon = tagKey.indexOf(":");
  if (colon < 0) return { ns: bindings.get(""), nsUnbound: false };
  const prefix = tagKey.slice(0, colon);
  const ns = bindings.get(prefix);
  return { ns, nsUnbound: ns === undefined };
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
function convertEntry(
  entry: unknown,
  packetName: string,
  depth: number,
  bindings: ReadonlyMap<string, string> = ROOT_NS_BINDINGS,
  budget: NsBindingBudget,
): XElement | string | null {
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
  // Namespace bindings in scope at this element: its own xmlns
  // declarations on top of its parent's, carried down to its children.
  const elementBindings = namespaceBindingsFor(rawAttrs, bindings, packetName, budget);
  const { ns, nsUnbound } = resolveElementNamespace(tagKey, elementBindings);
  return {
    name: tagKey,
    local: tagKey.split(":").at(-1) ?? tagKey,
    attrs,
    content: convertEntries(childEntries, packetName, depth + 1, elementBindings, budget),
    ns,
    nsUnbound,
    bindings: elementBindings,
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
  bindings: ReadonlyMap<string, string> = ROOT_NS_BINDINGS,
  budget: NsBindingBudget,
): Array<XElement | string> {
  if (depth > MAX_XFA_DEPTH)
    throw new XfaError(`XFA ${shortName(packetName)} packet is nested too deeply`);
  const out: Array<XElement | string> = [];
  for (const entry of entries) {
    const converted = convertEntry(entry, packetName, depth, bindings, budget);
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

/**
 * Collect a node's flattened text as (text, keep) segments, one per
 * text node, where `keep` is the effective xml:space state at that
 * text node (A-3, round 7). Mirrors nodeText()'s traversal exactly —
 * same descendant-override rule, same skip of newline-bearing
 * whitespace-only text between elements under default handling — but
 * keeps the preserve/default boundary per segment instead of merging
 * everything into one string, so normalizePreserving() can normalize
 * only the default segments.
 */
function collectTextSegments(
  node: XElement | string,
  preserve: boolean,
  out: Array<{ text: string; keep: boolean }>,
  depth = 0,
): void {
  if (typeof node === "string") {
    out.push({ text: node, keep: preserve });
    return;
  }
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA packet is nested too deeply");
  const keep = effectiveSpace(node, preserve);
  const children = elementChildren(node);
  for (const item of node.content) {
    if (typeof item === "string") {
      if (!keep && item.trim() === "" && children.length > 0 && /[\n\r]/.test(item)) continue;
      out.push({ text: item, keep });
    } else {
      collectTextSegments(item, keep, out, depth + 1);
    }
  }
}

/**
 * Flatten a caption's text with whitespace semantics preserved per
 * subtree (A-3, round 7): text under an xml:space="preserve"
 * descendant keeps its whitespace verbatim, while text under default
 * handling normalizes (whitespace runs collapse to one space, ends
 * trimmed) — even when the <caption> itself carries no preserve. The
 * old code flattened with nodeText() and then ran normalizeSpace()
 * over the whole result when the caption root was not preserving,
 * which destroyed a preserved descendant's newlines ("A\nB" →
 * "A B"): a single boolean at the caption root cannot normalize mixed
 * preserved/default subtrees after flattening erases their
 * boundaries. Preserved segments are replaced by NUL-delimited
 * placeholders before normalizing, then restored verbatim. NUL
 * cannot collide with real content: parseXfaXml rejects every
 * literal NUL — and every other illegal XML 1.0 character, and
 * numeric references naming one — before parsing, so no NUL can
 * reach this function from a packet (A-2, round 8). The round-7
 * comment asserted this without enforcement, and literal NUL bytes
 * demonstrably passed through the parser into values and labels;
 * the invariant is now enforced at parse time, not assumed.
 * With no preserved segment the result is exactly
 * normalizeSpace(nodeText(node)) as before.
 */
function normalizePreserving(node: XElement, preserve: boolean): string {
  const segments: Array<{ text: string; keep: boolean }> = [];
  collectTextSegments(node, preserve, segments);
  const preserved: string[] = [];
  let assembled = "";
  for (const segment of segments) {
    if (segment.keep) {
      preserved.push(segment.text);
      assembled += `\u0000${preserved.length - 1}\u0000`;
    } else {
      assembled += segment.text;
    }
  }
  const normalized = normalizeSpace(assembled);
  // Restore preserved segments by scanning for NUL-delimited indices
  // (no regex: \u0000 is a control character, which the linter
  // forbids in regex literals). Placeholders survive normalizeSpace
  // intact — NUL and digits are not whitespace — so each pair delimits
  // exactly one index.
  let restored = "";
  let cursor = 0;
  for (;;) {
    const open = normalized.indexOf("\u0000", cursor);
    if (open < 0) break;
    const close = normalized.indexOf("\u0000", open + 1);
    if (close < 0) break;
    restored += normalized.slice(cursor, open);
    const index = Number(normalized.slice(open + 1, close));
    if (Number.isInteger(index) && index >= 0 && index < preserved.length)
      restored += preserved[index];
    cursor = close + 1;
  }
  restored += normalized.slice(cursor);
  return restored;
}

/**
 * The effective xml:space state at an element (A-3, round 6):
 * an explicit xml:space="preserve" keeps whitespace verbatim for the
 * subtree, xml:space="default" resets to the skipping behaviour, and
 * no attribute inherits the parent's state. nodeText() already applies
 * this within its own traversal; the walks below apply it ACROSS
 * entry points, so state set above a flattening entry point (a
 * datasets ancestor, a template <items> or <caption>) is not lost.
 */
function effectiveSpace(element: XElement, inherited: boolean): boolean {
  const space = attr(element, "xml:space");
  return space === "preserve" ? true : space === "default" ? false : inherited;
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
 * XML 1.0 character validity (A-2, round 8): the Char production
 * admits #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] |
 * [#x10000-#x10FFFF] — everything else (C0 controls except tab/LF/CR,
 * surrogates, U+FFFE/U+FFFF, above U+10FFFF) is illegal. The literal
 * scan walks by code point (codePointAt): a valid surrogate pair
 * yields its astral value (legal); a lone surrogate yields its own
 * value and is rejected. Surrogate code points can also arrive via a
 * numeric character reference, so the reference check covers the full
 * range.
 */
function isIllegalXmlChar(codePoint: number): boolean {
  return (
    (codePoint >= 0x00 && codePoint <= 0x08) ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    codePoint === 0xfffe ||
    codePoint === 0xffff ||
    codePoint > 0x10ffff
  );
}

/**
 * The XHTML namespace URI. The parser itself does not resolve
 * namespace URIs, but the converter builds the in-scope bindings
 * from the preserved `xmlns` attributes (A-1, round 10), so the
 * rich-text classifier compares each element's RESOLVED namespace
 * URI against this value — not the literal `xmlns` string on one
 * element.
 */
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

/** The XFA data namespace URI, for `dataNode` attributes (A-2, round 10). */
const XFA_DATA_NAMESPACE = "http://www.xfa.org/schema/xfa-data/1.0/";

/**
 * The value of the attribute whose EXPANDED name is
 * `{namespaceUri}localName` on this element (A-2, round 10): the
 * attribute's prefix is resolved through the element's in-scope
 * bindings, so any prefix bound to that namespace matches and a
 * prefix bound elsewhere does not. An unprefixed attribute is in no
 * namespace, so it never matches a namespaced lookup. Returns
 * undefined when no such attribute is present.
 */
function attrInNamespace(
  element: XElement,
  localName: string,
  namespaceUri: string,
): string | undefined {
  for (const [key, value] of Object.entries(element.attrs)) {
    const raw = key.startsWith("@_") ? key.slice(2) : key;
    const colon = raw.indexOf(":");
    if (colon < 0) continue;
    if (raw.slice(colon + 1) !== localName) continue;
    if (element.bindings.get(raw.slice(0, colon)) === namespaceUri) return value;
  }
  return undefined;
}

/**
 * The dataset's `dataNode` marking on this element, by expanded name
 * (A-2, round 10): `{http://www.xfa.org/schema/xfa-data/1.0/}dataNode`,
 * whatever prefix the document chose for that namespace. One
 * documented exception, in the fail-closed direction: a literal
 * `xfa:dataNode` whose `xfa` prefix is UNDECLARED anywhere in scope
 * is read as the XFA marking too — the conventional XFA prefix, and
 * treating it as a group can only fail a field closed, never invent
 * a value. When `xfa` IS bound, the binding governs: bound to
 * anything else, the literal spelling is a different attribute and
 * is not a group marking.
 */
function dataNodeValue(element: XElement): string | undefined {
  const resolved = attrInNamespace(element, "dataNode", XFA_DATA_NAMESPACE);
  if (resolved !== undefined) return resolved;
  if (!element.bindings.has("xfa")) return attr(element, "xfa:dataNode");
  return undefined;
}

/** The text a single-pass XML scan returns, with its work accounted. */
interface XmlScanResult {
  /** Input text with legal numeric character references decoded (A-2, round 9). */
  text: string;
  /**
   * A linear-work PROXY for the scan, not literally a count of every
   * examined character (A-3, round 10 — precision correction): the
   * main loop charges one step per character it visits, and a
   * reference's digit/name characters are charged as they are read,
   * so `steps` stays within twice the input length and scales
   * linearly (asserted by test) — but delimiter lookahead
   * (`startsWith` compares of at most 9 characters per position)
   * and the characters inside a matched delimiter (`<!--`, `<![CDATA[`,
   * `<?`, `-->`, `]]>`, `?>`) are NOT individually charged, and some
   * output construction is omitted. Total work is O(steps) because
   * the uncharged work per position is bounded by a constant, so the
   * O(n) argument stands — the counter just does not literally count
   * every character the scan touches.
   */
  steps: number;
}

/**
 * Validate and decode one XFA packet's raw text in a SINGLE forward
 * pass (A-2/A-3/A-4, round 9). This replaces the round-8
 * `assertValidXmlChars`, whose two regex strips
 * (`/<![CDATA[[\s\S]*?]]>/` and `/<!--[\s\S]*?-->/`) rescanned the
 * remaining suffix from every candidate opener — quadratic work on a
 * comment holding repeated `<![CDATA[` openers with no terminator
 * (Y4: n=2000 → 11 ms, n=8000 → 125 ms, under the 200,000-`<` gate)
 * — and whose reference scan was neither context-correct nor
 * complete: it matched a CDATA opener inside one comment to a
 * terminator inside another, deleting a real `&#0;` from the scanned
 * text (Y5 bypass); it rejected reference-like text inside a
 * processing instruction, which is literal data (Y6 over-rejection);
 * and it skipped overflowing references, because
 * `Number.parseInt` yields `Infinity` and `Number.isInteger` is
 * false (Y7 missed rejection).
 *
 * The scan tracks lexical state — element content, inside a tag
 * (with its attribute-value quote state), comment, CDATA section,
 * or processing instruction — and makes ONE forward pass, visiting
 * each character in the main loop once (the step counter is a
 * linear-work proxy for that pass, not a literal per-character
 * count — see XmlScanResult.steps):
 * - a literal character illegal in XML 1.0 fails closed naming the
 *   code point, in EVERY state (a literal NUL is illegal inside
 *   CDATA and comments too);
 * - a numeric character reference is recognised ONLY in element
 *   content and in attribute values, where a reference is real.
 *   Inside comments, CDATA, and PIs the same spelling is literal
 *   text: it is neither validated nor decoded. The reference digits
 *   accumulate with saturation — exact while they fit in a safe
 *   integer, so a merely out-of-range reference still names its
 *   code point, and a digit run past that saturates instead of
 *   parsing to Infinity and skipping the rejection (Y7) — and
 *   leading zeros stay legal (`&#x00;` is still caught, `&#00065;`
 *   still decodes to `A`);
 * - entity syntax is established on the ORIGINAL text, BEFORE any
 *   decoding can repair it (A-3, round 10): in element content and
 *   in attribute values, every `&` must start a complete, valid
 *   entity reference — a numeric reference (`&#...;`, validated and
 *   decoded as above, and a malformed one fails closed instead of
 *   being passed through as plain text) or one of the five
 *   predefined named entities (`&amp;` `&lt;` `&gt;` `&quot;`
 *   `&apos;`, terminated by `;`). Anything else — a split entity
 *   such as `&am&#112;;` or `&a&#109;p;`, an unterminated `&amp`,
 *   an undeclared `&foo;` — fails closed here. This is the only
 *   sound order: decoding first turned `&am&#112;;` into the valid
 *   `&amp;` and reported `"&"` for malformed input (Z3/Z3b/Z3c).
 *   Only the predefined five can occur: DOCTYPE is refused before
 *   this scan runs, so no DTD can declare any other entity. Inside
 *   comments, CDATA, and PIs an `&` is literal text and is not
 *   validated, as before;
 * - a legal reference DECODES to its character (A-2, round 9):
 *   this parser version decodes named entities but leaves numeric
 *   references literal, so `&#65;` used to be reported as the wrong
 *   value `"&#65;"`. Decoding happens here, on the raw text before
 *   parsing, because after parsing the distinction is unrecoverable:
 *   `&#65;` and `&amp;#65;` both arrive as the parsed text `"&#65;"`,
 *   while only the first is a reference — the second must stay
 *   literal `"&#65;"`, and CDATA text must stay literal too (the
 *   existing `form.cdata = "A&#0;B"` expectation survives: CDATA is
 *   skipped by this scan, so its text reaches the parser untouched).
 *   A decoded `<`, `>`, `&`, or quote is re-emitted as its named
 *   entity (`&#60;` → `&lt;`), so a decoded character can never
 *   become markup or break attribute quoting; every other decoded
 *   character is emitted raw. Two corners are inherent to decoding
 *   before this parser and are accepted, not hidden: a decoded CR
 *   (`&#13;`) reaches the parser as a raw CR, which its line-ending
 *   normalization turns into LF (verified: the parser preserves a
 *   raw tab/LF in attribute values but normalizes CR to LF
 *   everywhere), so `&#13;` reports as LF, not CR; and decoded output
 *   is bounded by the input — each reference (at least 4 input
 *   characters) yields at most one character, or a 6-character
 *   entity for the five escaped results — so decoding cannot grow
 *   the text beyond a small constant factor of its size.
 * Illegal/overflowing references already fail here, BEFORE parsing,
 * so no decoded NUL can occur and the NUL-placeholder invariant in
 * caption normalization survives decoding.
 */
function scanXmlText(packetName: string, text: string): XmlScanResult {
  const out: string[] = [];
  let segmentStart = 0;
  let steps = 0;
  let i = 0;
  type LexicalState = "content" | "tag" | "comment" | "cdata" | "pi";
  let state: LexicalState = "content";
  let quote: string | null = null;

  const illegalCharError = (codePoint: number): XfaError =>
    new XfaError(
      `XFA packet '${shortName(packetName)}' contains character U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}, which is not valid in XML 1.0`,
    );
  const illegalRefError = (ref: string, codePoint: number): XfaError =>
    new XfaError(
      `XFA packet '${shortName(packetName)}' contains character reference '${shortName(ref)}' naming U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}, which is not valid in XML 1.0`,
    );
  const overflowRefError = (): XfaError =>
    new XfaError(
      `XFA packet '${shortName(packetName)}' contains a numeric character reference naming a code point above U+10FFFF, which is not valid in XML 1.0`,
    );
  /** A malformed entity reference: the raw spelling, capped for the message. */
  const malformedEntityError = (at: number, end: number): XfaError =>
    new XfaError(
      `XFA packet '${shortName(packetName)}' contains a malformed entity reference '${shortName(text.slice(at, Math.min(end, at + 32)))}', which is not valid XML`,
    );
  /** The only named entities a DTD-less document can use (A-3, round 10). */
  const PREDEFINED_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos"]);
  /**
   * Validate a named entity reference at `at` (`text[at]` is `&`,
   * `text[at + 1]` is not `#`). Returns the index just past the
   * terminating `;` when the reference is one of the five predefined
   * entities; throws on anything else — an unterminated, split, or
   * undeclared entity. Name characters are charged to `steps` as
   * they are read (they are then skipped, never re-walked), so the
   * step count stays a linear-work proxy. The set-membership check
   * is the real gate: any non-ASCII or otherwise exotic spelling
   * can never be a predefined name, so it throws here too.
   */
  const tryNamedEntity = (at: number): number => {
    let j = at + 1;
    while (j < text.length) {
      const ch = text[j];
      const code = ch.charCodeAt(0);
      const isNameChar =
        (ch >= "A" && ch <= "Z") ||
        (ch >= "a" && ch <= "z") ||
        (ch >= "0" && ch <= "9") ||
        ch === "." ||
        ch === "-" ||
        ch === "_" ||
        ch === ":" ||
        code >= 0x80;
      if (!isNameChar) break;
      steps++;
      j++;
    }
    const name = text.slice(at + 1, j);
    if (name.length === 0 || text[j] !== ";" || !PREDEFINED_ENTITIES.has(name))
      throw malformedEntityError(at, j + 1);
    return j + 1;
  };
  /**
   * Validate and consume one entity reference at `at` (`text[at]`
   * is `&`): a numeric reference is validated/decoded by
   * tryReference, a named one by tryNamedEntity. A malformed
   * numeric reference (no digits, no `;`) throws instead of being
   * passed through as plain text for a later validator to see —
   * passing it through is what let decoding repair it (Z3).
   */
  const consumeEntity = (at: number): number => {
    if (text[at + 1] === "#") {
      const after = tryReference(at);
      if (after === null) throw malformedEntityError(at, at + 32);
      return after;
    }
    return tryNamedEntity(at);
  };
  /** A decoded character, re-emitted so it can never become markup. */
  const emitDecoded = (codePoint: number): string => {
    switch (codePoint) {
      case 0x3c:
        return "&lt;";
      case 0x3e:
        return "&gt;";
      case 0x26:
        return "&amp;";
      case 0x22:
        return "&quot;";
      case 0x27:
        return "&apos;";
      default:
        return String.fromCodePoint(codePoint);
    }
  };
  /**
   * Try to read a numeric character reference at `i` (`text[i]` is
   * `&`, `text[i + 1]` is `#`). Returns the index just past the
   * reference when one is present — having validated and decoded it
   * into the output — or null when the text here is not a complete
   * reference, in which case nothing is consumed and the caller
   * re-walks the characters as plain text (at most one extra visit
   * per character). Throws on an illegal or overflowing reference.
   */
  const tryReference = (at: number): number | null => {
    let j = at + 2;
    let hex = false;
    if (text[j] === "x") {
      hex = true;
      j++;
    }
    const base = hex ? 16 : 10;
    const digitValue = (character: string): number => {
      if (character >= "0" && character <= "9") return character.charCodeAt(0) - 0x30;
      if (hex && character >= "a" && character <= "f") return character.charCodeAt(0) - 0x61 + 10;
      if (hex && character >= "A" && character <= "F") return character.charCodeAt(0) - 0x41 + 10;
      return -1;
    };
    let value = 0;
    let digits = 0;
    let overflow = false;
    while (j < text.length) {
      const digit = digitValue(text[j]);
      if (digit < 0) break;
      steps++;
      if (!overflow) {
        value = value * base + digit;
        // Saturating accumulation: the value stays exact while it
        // fits in a safe integer — so a merely out-of-range reference
        // (&#x110000;) still names its exact code point — and a digit
        // run past that saturates instead of parsing to Infinity and
        // skipping the rejection (Y7). Digits keep being consumed so
        // the scan stays a single forward pass.
        if (value > Number.MAX_SAFE_INTEGER) {
          overflow = true;
          value = Number.POSITIVE_INFINITY;
        }
      }
      j++;
      digits++;
    }
    if (digits === 0 || text[j] !== ";") return null;
    if (overflow) throw overflowRefError();
    const ref = text.slice(at, j + 1);
    if (isIllegalXmlChar(value)) throw illegalRefError(ref, value);
    out.push(text.slice(segmentStart, at));
    out.push(emitDecoded(value));
    segmentStart = j + 1;
    return j + 1;
  };

  while (i < text.length) {
    const codePoint = text.codePointAt(i) ?? 0;
    if (isIllegalXmlChar(codePoint)) throw illegalCharError(codePoint);
    const astral = codePoint > 0xffff;
    // An astral character is never structural: validate it as one
    // code point, count both code units as examined, move past both.
    if (astral) {
      steps += 2;
      i += 2;
      continue;
    }
    steps++;
    const character = text[i];
    if (state === "content") {
      if (character === "<") {
        if (text.startsWith("<!--", i)) {
          state = "comment";
          i += 4;
        } else if (text.startsWith("<![CDATA[", i)) {
          state = "cdata";
          i += 9;
        } else if (text.startsWith("<?", i)) {
          state = "pi";
          i += 2;
        } else {
          state = "tag";
          quote = null;
          i++;
        }
      } else if (character === "&") {
        // Every "&" in content must start a valid entity reference
        // (A-3, round 10): consumeEntity validates the ORIGINAL
        // spelling before any decoding, so a split entity can never
        // be repaired into a valid one.
        i = consumeEntity(i);
      } else {
        i++;
      }
    } else if (state === "tag") {
      if (quote !== null) {
        if (character === quote) {
          quote = null;
        } else if (character === "&") {
          // Same rule inside a quoted attribute value (Z3c): the
          // repair is reachable there too.
          i = consumeEntity(i);
          continue;
        }
        i++;
      } else if (character === '"' || character === "'") {
        quote = character;
        i++;
      } else if (character === ">") {
        state = "content";
        i++;
      } else {
        i++;
      }
    } else if (state === "comment") {
      if (text.startsWith("-->", i)) {
        state = "content";
        i += 3;
      } else {
        i++;
      }
    } else if (state === "cdata") {
      if (text.startsWith("]]>", i)) {
        state = "content";
        i += 3;
      } else {
        i++;
      }
    } else if (text.startsWith("?>", i)) {
      state = "content";
      i += 2;
    } else {
      i++;
    }
  }
  out.push(text.slice(segmentStart));
  return { text: out.join(""), steps };
}

/**
 * Test hook for the scanner's work bound (A-3, round 9; precision,
 * round 10): the scan's linear-work proxy for `text` — the main-loop
 * visits plus reference digit/name characters charged as read, NOT
 * literally every character the scan touches (delimiter lookahead and
 * the characters inside a matched delimiter are not individually
 * charged). The adversarial scanner test asserts a linear budget on
 * the repeated-opener shape against this count — never a wall-clock
 * threshold.
 */
export function countXmlScanSteps(text: string): number {
  return scanXmlText("test", text).steps;
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
  // Character validity is checked before that (A-2, round 8; single
  // forward scan + numeric-reference decoding, round 9): the validator
  // and parser both let literal NUL bytes through, so an explicit
  // check on the raw text is the only gate — and the decoded text is
  // what is validated and parsed, so a legal numeric reference
  // reports its character, not its spelling. Entity syntax is
  // established by the same scan on the ORIGINAL text, before any
  // decoding (A-3, round 10): a malformed entity can no longer be
  // repaired into a valid one by decoding, so what the validator
  // sees was already well-formed as written.
  text = scanXmlText(packetName, text).text;
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
  // One cumulative namespace-map budget per packet (A-1, round 11):
  // conversion is where the maps are built, before any field is
  // collected, so the budget must start here, not at the join.
  const nsBudget: NsBindingBudget = { used: 0 };
  return convertEntries(parsed, packetName, 0, ROOT_NS_BINDINGS, nsBudget).filter(
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
 * 5; representation corrected A-1, round 6). A scope is PARENT-LINKED:
 * a child holds its one segment plus a pointer to its parent, so
 * `child()` is O(1) and never copies the parent's segments — the
 * round-5 comment claimed "a child scope extends its parent's array
 * by one segment" while the code spread the whole array
 * (`[...parent.segments, segment]`), a full copy per segment, which
 * made folding a 20,000-segment dataRef quadratic (2,714 ms) with no
 * bound tripping. The segment array is materialized lazily by
 * `scopeSegments()`, memoized per context object — CORRECTION
 * (round 7): the round-6 comment claimed "once per distinct
 * (interned) scope", which is overstated. `child()` returns a fresh
 * context object per call, so two objects carrying the same interned
 * id materialize their segment arrays separately; the memoization is
 * per object, not per interned identity. The work is still bounded:
 * a materialization walks at most MAX_XFA_DEPTH parent links, and it
 * happens only when a field is actually built, so a field-less
 * subtree pays nothing per segment beyond the bounded fold. The fold
 * itself is bounded twice: `parseDataRefSegments` rejects refs over
 * MAX_DATA_REF_SEGMENTS before folding, and `child()` enforces the
 * whole-document depth gate, so no ref — field-less or not — can
 * drive unbounded scope construction. The template path strings that
 * ARE retained (each field's somPath) are still charged in aggregate
 * by countTemplatePath.
 */
interface ScopeContext {
  id: number;
  parent: ScopeContext | null;
  segment: string | null;
  depth: number;
  /** Memoized materialization of the segment array (see scopeSegments). */
  segmentsCache?: string[];
}

/** Materialize a scope's segment array, memoized on the scope itself. */
function scopeSegments(scope: ScopeContext): string[] {
  const cached = scope.segmentsCache;
  if (cached !== undefined) return cached;
  const reversed: string[] = [];
  let current: ScopeContext | null = scope;
  while (current !== null && current.segment !== null) {
    reversed.push(current.segment);
    current = current.parent;
  }
  const segments = reversed.reverse();
  scope.segmentsCache = segments;
  return segments;
}

/**
 * Scope interning (U-2, round 5): each distinct scope gets a small
 * integer id, keyed by (parent scope id, one segment). Interning
 * happens once per subform on the walk down — never per field — and
 * the key never contains a parent scope string, so neither a long
 * scope nor a long parent is copied or serialized per occurrence.
 * An absolute dataRef scope folds from the root one segment at a
 * time; a bare (relative) dataRef scope folds from the parent scope.
 * A child is O(1) (A-1, round 6): the scope is parent-linked, so no
 * segment array is copied per segment, and the depth gate bounds the
 * fold even for a ref that somehow bypasses the parse-time bound.
 */
class ScopeInterner {
  private nextId = 1;
  private readonly ids = new Map<string, number>();
  readonly root: ScopeContext = { id: 0, parent: null, segment: null, depth: 0 };

  child(parent: ScopeContext, segment: string): ScopeContext {
    if (parent.depth + 1 > MAX_XFA_DEPTH)
      throw new XfaError(
        `XFA template scope exceeds ${MAX_XFA_DEPTH} segments; refusing to report an unbounded result`,
      );
    const key = `${parent.id}\u0000${segment}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(key, id);
    }
    return { id, parent, segment, depth: parent.depth + 1 };
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
 * merges their texts in order instead of silently dropping to [].
 * `preserve` is the effective xml:space state at the field (A-3,
 * round 6); each <items> element's own attribute overrides it, so
 * state set on an <items> ancestor reaches the <text> children. */
function itemTexts(node: XElement, preserve = false): string[] {
  const out: string[] = [];
  for (const items of childrenNamed(node, "items")) {
    const keep = effectiveSpace(items, preserve);
    for (const text of childrenNamed(items, "text")) out.push(nodeText(text, 0, keep));
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
  preserve = false,
): TemplateField | undefined {
  const keep = effectiveSpace(node, preserve);
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
  const items = itemTexts(node, keep);
  let onValues: string[] | undefined;
  // On-values live in <items> only for checkButtons; a choiceList's
  // <items> are its options, not on-values.
  if (uiKind === "checkButton" && items.length > 0) onValues = [items[0]];
  const caption = singletonChild(node, "caption", context);
  const captionKeep = caption !== undefined ? effectiveSpace(caption, keep) : keep;
  // Caption labels normalize whitespace by default — EXCEPT where the
  // document says it is significant (A-3, round 6; SPEC §1 step 4):
  // normalizePreserving() (A-3, round 7) normalizes only the default
  // segments and keeps a preserved descendant's newlines verbatim,
  // even when the <caption> itself carries no preserve; a caption
  // under preserve keeps its whitespace verbatim, as before.
  const captionText =
    caption !== undefined
      ? normalizePreserving(singletonChild(caption, "value", context) ?? caption, captionKeep)
      : "";
  const label = captionText !== "" ? captionText : undefined;
  const options = uiKind === "choiceList" ? itemTexts(node, keep) : [];
  return {
    somPath: fieldPath,
    leafName,
    scope: scopeSegments(scope),
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
  preserve = false,
): void {
  // Fail closed like the datasets walk: a form whose only fields are too
  // deep is a 422, never a silent field-less report.
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA template packet is nested too deeply");
  // Effective xml:space at this element (A-3, round 6): state set on
  // this element or above reaches every field, option list, and
  // caption below it; each child element's own attribute overrides it
  // where the walk (or buildTemplateField) applies it.
  const keep = effectiveSpace(node, preserve);
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
        keep,
      );
    } else if (child.local === "field") {
      const field = buildTemplateField(child, pathSegments, scope, pathBytes, keep);
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
      // The group's own xml:space (A-3, round 6): state set on the
      // group element reaches its option fields and its caption.
      const groupKeep = effectiveSpace(child, keep);
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
          // The option field's OWN xml:space (A-3, round 7): its
          // effective state — its own attribute over the group's —
          // governs its items, so its own preserve is honoured and
          // its own default can reset an inherited preserve, exactly
          // as buildTemplateField() already does for named fields.
          const texts = itemTexts(optionField, effectiveSpace(optionField, groupKeep));
          if (texts.length > 0) options.push(texts[0]);
          continue;
        }
        const built = buildTemplateField(optionField, pathSegments, scope, pathBytes, groupKeep);
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
      const captionKeep = caption !== undefined ? effectiveSpace(caption, groupKeep) : groupKeep;
      // Same per-subtree normalization as a field caption (A-3,
      // round 7): a preserved descendant survives even when the group
      // caption itself carries no preserve.
      const captionText =
        caption !== undefined
          ? normalizePreserving(
              singletonChild(caption, "value", `exclGroup '${shortName(groupPath)}'`) ?? caption,
              captionKeep,
            )
          : "";
      out.push({
        somPath: groupPath,
        leafName: name,
        scope: scopeSegments(scope),
        scopeId: scope.id,
        ui: "unsupported",
        bind,
        ref,
        options: options.length > 0 ? options : undefined,
        label: captionText !== "" ? captionText : undefined,
      });
    } else {
      collectTemplateFields(child, pathSegments, scope, interner, depth + 1, out, pathBytes, keep);
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
  return parseSegment(segment).name;
}

function leafNameOf(segments: string[]): string {
  return stripSegmentIndex(segments.at(-1) ?? "");
}

function strippedSegments(segments: string[]): string[] {
  return segments.map(stripSegmentIndex);
}

/**
 * The element names an XHTML document skeleton may carry directly
 * under <xhtml> in XFA rich text (A-1, round 8): the <xhtml> wrapper
 * holds an XHTML document fragment — <html>/<head>/<body> — not
 * arbitrary data. An ordinary dataset element that happens to be
 * named `xhtml` holds data children, not an XHTML skeleton, so the
 * skeleton is what distinguishes rich text from a same-named data
 * element. (A-1, round 10) Namespace is the second distinguishing
 * evidence, now evaluated on EXPANDED names: each element's resolved
 * namespace URI (its prefix's binding, or the in-scope default
 * namespace, inherited down the walk) is compared, not the literal
 * `xmlns` string on one element. A company or other non-XHTML
 * namespace on the container — declared on the container itself, on
 * a prefix, or inherited from a parent's default namespace — means
 * the element is data in that namespace, not an XHTML document,
 * however skeleton-shaped its children are. A genuine XHTML
 * container under a prefix stays rich text even when an unrelated
 * default namespace is also declared (Z1c): the prefix resolves,
 * the default does not govern it. Absent namespace stays as before:
 * legitimate rich text in the wild carries either no declaration
 * (the round-8 X4 shape) or the XHTML namespace. What this still
 * cannot distinguish is stated plainly, not hidden: an element in
 * NO namespace is accepted exactly as before (the legacy shape), so
 * a namespace-less data element that is skeleton-shaped is still
 * read as rich text — the no-namespace convention is the accepted
 * ambiguity — and a namespace URI is only a string: a document that
 * declares the XHTML URI on company data is indistinguishable from
 * genuine XHTML by any evidence the tree holds. Where the evidence
 * genuinely cannot distinguish — an unbound prefix (namespace
 * unknown, not "none"), or a skeleton element in a different
 * namespace from its container, at ANY level of the subtree
 * (A-2, round 11: the round-10 rule checked the first level only)
 * — the classifier fails closed.
 */
const XHTML_SKELETON = new Set(["html", "head", "body"]);

/**
 * True when `element` is an <xhtml> holding an XHTML document
 * skeleton, in namespace terms as well as shape: the container's
 * expanded name must be XHTML or no-namespace (never a company or
 * other namespace, never an unbound prefix), and every skeleton
 * child must be in the SAME namespace as the container — a child in
 * a different namespace, or with an unbound prefix, is data in that
 * namespace, not part of this document, so the whole container fails
 * closed instead of flattening a mixture.
 *
 * (A-2, round 11) The check runs over the WHOLE subtree, not just
 * the first level: the skeleton is two levels deep (xhtml → html →
 * head/body → text), and the round-10 rule stopped at the first
 * level, so a mixed namespace one level down (<h:html> holding
 * <c:body>/<c:head>) still flattened into a fabricated scalar.
 * Every descendant element must share the container's namespace
 * (URI equality, never an unbound prefix) and must not carry a
 * dataGroup marking (by expanded `dataNode` name, any prefix) —
 * a contradictory descendant namespace or a group marking on any
 * descendant defeats the classification, and the walk then recurses
 * into the subtree as ordinary data, so the children stay
 * addressable. The <html> level is skeleton-shaped too: its element
 * children must be <head>/<body> only. Below head/body the content
 * is arbitrary XHTML markup (<p>, <b>, <span>, …), so only the
 * namespace and group-marking checks apply there — no element-name
 * restriction. The container's own dataGroup marking defeats it as
 * well (the callers check it too; this is the same rule applied at
 * the element itself).
 */
function isXhtmlDocument(element: XElement): boolean {
  if (element.local !== "xhtml") return false;
  if (element.nsUnbound) return false;
  if (element.ns !== undefined && element.ns !== XHTML_NAMESPACE) return false;
  if (dataNodeValue(element) === "dataGroup") return false;
  const children = elementChildren(element);
  if (
    children.length === 0 ||
    !children.every(
      (child) => XHTML_SKELETON.has(child.local) && !child.nsUnbound && child.ns === element.ns,
    )
  )
    return false;
  // Whole-subtree validation: every descendant shares the
  // container's namespace, carries no unbound prefix and no
  // dataGroup marking, and an <html> element's children are
  // <head>/<body> only. Iterative — the tree is already
  // depth-bounded by conversion, but no walk here assumes that.
  const pending: XElement[] = [...children];
  while (pending.length > 0) {
    const descendant = pending.pop() as XElement;
    if (descendant.nsUnbound || descendant.ns !== element.ns) return false;
    if (dataNodeValue(descendant) === "dataGroup") return false;
    const grandChildren = elementChildren(descendant);
    if (
      descendant.local === "html" &&
      !grandChildren.every((child) => child.local === "head" || child.local === "body")
    )
      return false;
    pending.push(...grandChildren);
  }
  return true;
}

/**
 * Is `child` a supported rich-text container (A-1, round 8; namespace
 * and data-group evidence, rounds 9–10)? Either a bare <xhtml>
 * holding an XHTML document skeleton, or an <exData> whose whole
 * content is exactly one such <xhtml> (whitespace-only direct text
 * besides). Anything else named `exData` or `xhtml` — a text-only
 * <exData>, an <exData> wrapping non-XHTML content, an <xhtml>
 * holding data children — is an ordinary dataset element, not a
 * rich-text container, and must not change its parent's
 * classification. The container child's own declarations defeat the
 * classification, not just the parent's (Y1, round 9): a container
 * marked a data group (by expanded `dataNode` name, any prefix —
 * A-2, round 10) is a data group, and a container whose RESOLVED
 * namespace is not the XHTML namespace is data in that namespace —
 * either way its children stay ordinary data. Namespace is judged
 * on the inner <xhtml>'s own expanded name, through its in-scope
 * bindings: a wrapper's default namespace defeats the classification
 * only insofar as the inner <xhtml> inherits it — a wrapper that
 * declares an unrelated default namespace around a genuinely
 * XHTML-prefixed inner <xhtml> does NOT defeat it (the Z1c converse
 * for wrappers; the round-9 standalone wrapper `xmlns` check, which
 * rejected that shape, is removed for exactly this reason).
 * `contentType` is supporting evidence only: it cannot establish
 * rich text on its own — namespace, data-group marking, and
 * structure do that — but a declared non-HTML content type
 * (`text/plain` wrapping an XHTML skeleton) contradicts an HTML
 * document, so it defeats the classification; absent `contentType`
 * stays as before. These checks guard the PARENT's flattening; the
 * matching node-side guard is `exDataDefeated()`, consulted by
 * collectDataLeaves when the walk stands ON the wrapper — without
 * it, recursing past a defeated wrapper would let its bare <xhtml>
 * child classify the wrapper as a rich-text leaf anyway.
 */
function isRichTextContainer(child: XElement): boolean {
  if (dataNodeValue(child) === "dataGroup") return false;
  if (child.local === "xhtml") return isXhtmlDocument(child);
  if (child.local !== "exData") return false;
  const contentType = attr(child, "contentType");
  if (contentType !== undefined && contentType.trim().toLowerCase() !== "text/html") return false;
  const children = elementChildren(child);
  if (children.length !== 1 || children[0].local !== "xhtml") return false;
  if (dataNodeValue(children[0]) === "dataGroup") return false;
  if (!isXhtmlDocument(children[0])) return false;
  return child.content.every((item) => typeof item !== "string" || item.trim() === "");
}

/**
 * Does an <exData> element itself carry a declaration that defeats
 * rich-text classification for the leaf IT would be (A-1, rounds 9–10)?
 * The wrapper's content type governs its whole content: a `text/plain`
 * wrapper holds data, not an HTML document — so when the walk stands
 * on the wrapper, its bare <xhtml> child must not classify the wrapper
 * as a rich-text leaf. (The parent-side counterpart lives in
 * isRichTextContainer, which stops the PARENT from flattening; this
 * one stops the wrapper itself. A dataGroup marking needs no check
 * here: collectDataLeaves already defeats the node on its own
 * `dataNode`, and an empty dataGroup returns before this point.)
 * Namespace is deliberately NOT checked here any more: the round-9
 * version defeated a wrapper on its own default-namespace
 * declaration, which is only a proxy for the inner <xhtml>'s
 * namespace — and a wrong proxy for a prefixed genuine inner
 * <xhtml> (Z1c converse). The inner element's resolved namespace is
 * now judged directly, through its inherited bindings, by
 * isXhtmlDocument() in the flattening condition below; a wrapper
 * whose default namespace the inner element inherits is defeated
 * there, and a wrapper around a genuinely XHTML-prefixed inner
 * element is not.
 */
function exDataDefeated(element: XElement): boolean {
  if (element.local !== "exData") return false;
  const contentType = attr(element, "contentType");
  return contentType !== undefined && contentType.trim().toLowerCase() !== "text/html";
}

/**
 * Walk <xfa:data> collecting leaf data nodes, in document order.
 * Repeated elements get an index in the path (form.repeat[0].item) so
 * repeating subforms stay distinct; a lone element keeps its plain
 * name. Sibling order is document order — the grouped-object walk used
 * to visit every `a` before every `b`, so a `global` bind could pick a
 * later leaf over an earlier one.
 */
function collectDataLeaves(
  node: XElement,
  path: string[],
  depth: number,
  out: DataLeaf[],
  preserve = false,
): void {
  if (depth > MAX_XFA_DEPTH) throw new XfaError("XFA datasets packet is nested too deeply");
  // Effective xml:space at this element (A-3, round 6): state set on
  // this element or above — including ancestors above the walk's
  // entry point, passed in by inspectXfa — reaches the rich-text
  // flattening below it.
  const keep = effectiveSpace(node, preserve);
  const children = elementChildren(node);
  // Group classification runs BEFORE the empty-leaf branch (A-1,
  // round 9): an empty element the dataset marks a data group is a
  // group with no members, not a scalar leaf with value "" (Y2) —
  // the round-8 order emitted the scalar first and never reached
  // any dataGroup check. A marked group WITH children still recurses
  // below, so its children stay addressable. The marking is read by
  // expanded name (A-2, round 10): any prefix bound to the XFA data
  // namespace counts, not just the literal `xfa:` spelling.
  const dataNode = dataNodeValue(node);
  if (dataNode === "dataGroup" && children.length === 0) return;
  if (children.length === 0) {
    // A leaf's value is its direct text, verbatim: dataset whitespace
    // is significant (the parser is configured with trimValues: false,
    // and no trimming happens here either).
    const value = node.content.filter((item): item is string => typeof item === "string").join("");
    out.push({ segments: path, value, markup: false });
    return;
  }
  // Rich-text values are leaves (A-1, round 8): a node is a rich-text
  // leaf ONLY when its whole element content is one supported
  // rich-text container — a bare <xhtml> holding an XHTML document
  // skeleton, or an <exData> wrapping exactly one such <xhtml> — with
  // no other element children and no non-whitespace direct text, and
  // never when the dataset explicitly marks the node a data group
  // (by expanded `dataNode` name — A-2, round 10). (A-1, round 10)
  // The container child's own declarations are consulted too, inside
  // isRichTextContainer(): a container marked dataGroup, or whose
  // RESOLVED namespace (prefix binding or inherited default, carried
  // through the walk) is not the XHTML namespace, is ordinary data,
  // not rich text — the round-9 check read only the literal `xmlns`
  // on one element, so a prefixed company-namespaced container
  // (Z1) and an inherited company default namespace (Z1b) still
  // flattened into a fabricated scalar. The node's OWN wrapper
  // declarations are consulted as well, via exDataDefeated() in the
  // condition below: a wrapper that declares a non-HTML contentType
  // governs its whole content, so recursing past it must not let its
  // bare <xhtml> child classify the wrapper as a leaf anyway
  // (namespace is judged on the inner <xhtml> itself now, not by a
  // wrapper-level `xmlns` proxy — see exDataDefeated). Anything else
  // named `exData` or `xhtml` is an ordinary dataset element: the
  // walk recurses into it like any other element, so its children
  // stay addressable (form.note.exData, form.note.other) and a field
  // bound to the group itself has no data node and fails closed —
  // instead of the old behaviour, which flattened the whole parent
  // (siblings and all) into one fabricated scalar. The flattened
  // value comes from the container child, not the parent, so a
  // same-line space beside the container cannot leak into the value.
  // The flattened value keeps the text in document order (no
  // whitespace normalisation); block boundaries carry no separator.
  // Resource bounds do not cover semantic classification (R-7,
  // round 8): this rule IS the classification, and the bounds only
  // cap the work and output around whatever it produces — a
  // misclassified leaf fits every byte bound, so no bound may be
  // claimed to establish it. Namespace resolution is part of that
  // classification, not of the bounds: it is justified on expanded
  // names and in-scope bindings, and it cannot prove a document's
  // namespace declarations are honest (see isXhtmlDocument).
  if (
    dataNode !== "dataGroup" &&
    !exDataDefeated(node) &&
    children.length === 1 &&
    isRichTextContainer(children[0]) &&
    node.content.every((item) => typeof item !== "string" || item.trim() === "")
  ) {
    out.push({ segments: path, value: nodeText(children[0], 0, keep), markup: true });
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
    collectDataLeaves(child, [...path, segment], depth + 1, out, keep);
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
  // Construction budget (A-1, round 6): a ref with more segments than
  // any dataset leaf path can hold can never resolve, so it fails
  // closed here, before subformScope folds it one segment at a time —
  // including for a field-less subform, which no field-based charge
  // would ever reach.
  if (segments.length > MAX_DATA_REF_SEGMENTS)
    throw new XfaError(
      `XFA template/datasets mismatch: ${ctx()} has a dataRef with ${segments.length} segments (limit ${MAX_DATA_REF_SEGMENTS}); refusing to report an unbounded result`,
    );
  // Selector budget (A-2, round 6): over-long digit runs and
  // out-of-range values fail closed at parse time, so lookup never
  // has to parse them — let alone once per candidate. The digits are
  // never interpolated into the message (they are unbounded input).
  for (const segment of segments) {
    const open = segment.lastIndexOf("[");
    if (open < 0) continue;
    const digits = segment.slice(open + 1, -1);
    if (digits.length > MAX_SELECTOR_DIGITS || Number(digits) > MAX_SELECTOR_INDEX)
      throw new XfaError(
        `XFA template/datasets mismatch: ${ctx()} has a dataRef with an out-of-range [N] selector (at most ${MAX_SELECTOR_DIGITS} digits, value at most ${MAX_SELECTOR_INDEX})`,
      );
  }
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

/**
 * Parse one path segment into its bare name plus its `[N]` occurrence
 * selector, if any (A-2, round 6). Regex-free and allocation-light: a
 * segment that does not end in "]" has no selector (the fast path —
 * no scan at all), and a trailing "[N]" puts the "[" within a few
 * characters of the end, so lastIndexOf never walks a long name. The
 * digits are bounded in every reachable case — ref selectors are
 * capped at parse time by parseDataRefSegments, dataset suffixes are
 * real occurrence counts — so Number() here is exact. The old
 * segmentIndex() ran a regex over the raw selector string on EVERY
 * candidate leaf at EVERY position — a 256 KiB selector over 5,000
 * leaves cost 8,299 ms vs 397 ms for "[0]". Selectors are now parsed
 * once per lookup (see lookupSelectors), never per candidate.
 */
function parseSegment(segment: string): { name: string; index: number | undefined } {
  if (!segment.endsWith("]")) return { name: segment, index: undefined };
  const open = segment.lastIndexOf("[");
  if (open <= 0) return { name: segment, index: undefined };
  const digits = segment.slice(open + 1, -1);
  if (!/^\d+$/.test(digits)) return { name: segment, index: undefined };
  return { name: segment.slice(0, open), index: Number(digits) };
}

/** The `[N]` selector on a path segment, or undefined when unindexed. */
function segmentIndex(segment: string): number | undefined {
  return parseSegment(segment).index;
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
 * unindexed selector accepts every occurrence of the name. The
 * selectors arrive pre-parsed (A-2, round 6): parsing them here, per
 * candidate, was the quadratic path.
 */
function matchesSelectors(
  leafSegments: string[],
  selectors: Array<{ name: string; index: number | undefined }>,
): boolean {
  if (leafSegments.length !== selectors.length) return false;
  return selectors.every((selector, position) => {
    const wanted = selector.index;
    return wanted === undefined || leafOccurrence(leafSegments[position]) === wanted;
  });
}

/**
 * The join index, built once per inspect: leaves by leaf name and by
 * stripped path, in document order. Indexing means a field only ever
 * looks up its own exact path or its own name — unrelated leaves cost
 * nothing. R-7 CORRECTION (round 7): the round-6 correction was
 * still unsound — shared onValues arrays let one merge grow fields
 * the output-byte accounting never saw (A-1), and duplicate
 * resolution re-serialized the accumulated field on every duplicate
 * with no bound on the cumulative work (A-4). This round closes both
 * paths directly, and the correction now states exactly what each
 * bound covers:
 * (a) construction work is bounded BEFORE resolution: dataRef segment
 * counts are capped at MAX_DATA_REF_SEGMENTS (100 — no dataset leaf
 * path can be longer, so a longer ref can never resolve) at parse
 * time, scopes are parent-linked (child() is O(1), no array copy),
 * and the aggregate internal path/index byte bound (4 MiB, charged
 * per leaf before the joined key string is built) caps index
 * construction. Scope segment arrays are memoized per context object,
 * not per interned identity (round-7 correction of the round-6
 * comment: child() returns a fresh object per call) — still bounded,
 * since a materialization walks at most 100 parent links;
 * (b) lookup work is bounded by parsing each selector ONCE per field
 * into a canonical form (never per candidate), rejecting over-long
 * selectors and out-of-range values at parse time, plus the aggregate
 * structural-comparison budget (1,000,000 candidate examinations
 * across all findLeaves calls) as the backstop — with selector-aware
 * narrowing, each examination is O(selector positions) with O(1)
 * occurrence checks (a segment not ending in "]" has no selector; a
 * trailing "[N]" puts the bracket within a few characters of the
 * end);
 * (c) duplicate work is bounded two ways: mergeDuplicate() keeps
 * persistent merge state (one dedup Set per resolved field, created
 * once) and returns the exact serialized byte delta of the merge, so
 * a duplicate never re-serializes or re-scans the accumulated field
 * — and every duplicate is additionally charged the merged field's
 * retained serialized size against a cumulative 64 MiB
 * duplicate-work budget (MAX_CUMULATIVE_DUPLICATE_BYTES), which
 * fails closed past it. The merged on-values byte bound (T-4, 1 MiB)
 * still applies to subgroup merges and to resolved-node merges;
 * (d) the output count/byte bounds (S-5): at most 10,000 resolved
 * fields totalling at most 1 MiB of serialized JSON — now enforced
 * twice: incrementally, because each resolved field owns its mutable
 * merge state (toXfaField() copies onValues, so a merge can never
 * grow a previously accounted field or a template unit), and finally
 * by an exact JSON.stringify(result.fields) byte check before
 * joinFields returns, so no accounting slip can emit more than the
 * bound;
 * (e) metadata compatibility is checked in BOTH merge paths:
 * subgroup collapse applies the same options check as resolved-node
 * merging (contents and order), while labels keep
 * first-nonempty-caption-wins within a subgroup — a lossy reporting
 * convention (round 8 wording), not a general XFA semantic
 * conclusion: differing captions are not proof of per-choice
 * captions, and a later caption fills an absent first caption —
 * and fail closed on conflict only across subgroups;
 * (f) xml:space is preserved through normalization: caption labels
 * normalize only their default segments, keeping a preserved
 * descendant's whitespace verbatim, and an unnamed option field's
 * own effective state governs its items.
 * (g) pre-parse work is bounded by construction, not by wall-clock
 * guesswork (A-3/A-4, round 9): character validity and numeric
 * character-reference decoding run as ONE forward lexical scan over
 * the packet text — comments, CDATA sections, and processing
 * instructions are recognised in context and skipped as literal
 * text, so no delimiter confusion can hide a reference or invent
 * one, and no suffix is ever rescanned. The scan's work is O(n) in
 * the packet size, which is itself capped at 10 MiB per packet,
 * with the work accounted as a step count that is a linear-work
 * PROXY, not literally every examined character (A-3, round 10 —
 * precision correction: delimiter lookahead and the characters
 * inside a matched delimiter are not individually charged, so the
 * counter must not be described as a per-character count; the O(n)
 * argument stands because the uncharged work per position is
 * bounded by a constant). Entity syntax is established by the same
 * scan on the ORIGINAL text, before decoding (A-3, round 10), so a
 * malformed entity cannot be repaired into a valid one. Numeric
 * decoding is bounded the same way: each reference yields at most
 * one character, or a 6-character named entity for the five results
 * that must not become markup (`<`, `>`, `&`, `"`, `'`), so the
 * decoded text is at most a small constant factor of the input.
 * (h) namespace-map copying is bounded by a cumulative entries
 * budget, NOT by depth (A-1, round 11 — sixth pass, RETRACTING the
 * round-10 claim): the round-10 prompt head (§0b) said a fresh map
 * copy happens only on a declaring element and depth is capped at
 * 100, "so the worst-case copy work is O(depth²) and small". That
 * is WRONG, and the sentence is replaced, not qualified: depth
 * bounds ancestor count, NOT the number of namespace declarations
 * on an ancestor, so one element declaring thousands of prefixes
 * times many declaring descendants multiplies retained map entries
 * as their product (a 10,000-prefix root × 50,000 declaring
 * siblings ≈ 500M entries from a ~2.5 MB packet). What bounds the
 * copying now is the cumulative budget in namespaceBindingsFor():
 * each copy is charged its parent's map size plus the element's own
 * declaration count, and the total across one packet conversion may
 * not exceed MAX_CUMULATIVE_NS_BINDING_ENTRIES (250,000), checked
 * BEFORE the copy is made, so the inspect fails closed with a 422
 * instead of building an over-budget map. The budget covers
 * pre-resolution conversion work — it runs before field collection,
 * so a field-less template is charged too — and it bounds retained
 * map entries (each map's entries are either copied, charged, or
 * newly declared, charged), not lookup time: lookups are single
 * Map.get calls on the retained maps. It does NOT cover the
 * parser's own internal work on the packet, and it does NOT prove
 * anything about namespace semantics — see below.
 * What this still does NOT cover — restated plainly (R-7, round 11,
 * sixth pass): semantic classification is outside what any resource
 * bound can establish (round 8, unchanged): the bounds cap work and
 * output size around whatever the dataset classification produces,
 * but they cannot prove the classification itself is right — a
 * misclassified leaf (a data group flattened into a scalar, A-1
 * round 8) fits every byte bound. The classifier in
 * collectDataLeaves is the classification, and it is justified on
 * its own structural, namespace, and data-group terms. Namespace
 * resolution (A-1, round 10) is semantic classification, outside
 * what any bound can establish — say so plainly, do not claim the
 * bounds prove it: the tree now carries in-scope namespace bindings
 * (default namespace + prefix bindings, inherited down the walk)
 * and the classifier evaluates EXPANDED names against them, so a
 * prefixed or inherited company namespace defeats rich-text
 * classification and a genuinely XHTML-prefixed container stays
 * rich text — but the evidence is still only namespace URI strings
 * as declared: a document that declares the XHTML URI on company
 * data is indistinguishable from genuine XHTML, a namespace-less
 * skeleton-shaped element is accepted by the legacy no-namespace
 * convention, and an unbound prefix fails closed as unknown rather
 * than being read as "none". (A-2, round 11) The skeleton check now
 * runs over the whole subtree, not just the first level, and a
 * descendant group marking defeats classification — but that is
 * still classification on the evidence the tree holds, not a bound:
 * no byte or count budget can establish that a descendant in the
 * XHTML namespace is genuine XHTML rather than company data
 * declared under that URI. A decoded `&#13;` (CR) reports as LF
 * because the parser normalizes line endings on input. The
 * per-packet size check still runs after decoding (the decode
 * budget is external), the duplicate-work charge is still a
 * conservative over-approximation, and the bounds say nothing about
 * the parser's own internal work on up to 10 MiB of XML — only
 * that the work THIS module adds around it is bounded as stated.
 * No single bound retires the others, and no coverage is claimed
 * beyond them: the depth gate still runs after dependency parsing.
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
  // Parse the selectors ONCE into their canonical form (A-2, round
  // 6): the old code re-ran segmentIndex() — regex + Number() over
  // the raw selector string — for every candidate leaf at every
  // position, so a 256 KiB selector over 5,000 leaves re-parsed
  // 256 KiB × 5,000 times. The bucket key is built from the parsed
  // bare names, never by re-joining the raw selector strings.
  const parsed = selectors.map(parseSegment);
  const bucket = index.byPath.get(parsed.map((selector) => selector.name).join("."));
  if (!bucket) return [];
  let candidates: DataLeaf[] | undefined;
  for (let position = 0; position < parsed.length; position++) {
    const wanted = parsed[position].index;
    if (wanted === undefined) continue;
    const narrowed = bucket.byOccurrence.get(position)?.get(wanted) ?? [];
    if (candidates === undefined || narrowed.length < candidates.length) candidates = narrowed;
  }
  const pool = candidates ?? bucket.leaves;
  const out: DataLeaf[] = [];
  for (const leaf of pool) {
    budget.comparisons += 1;
    checkComparisons(budget);
    if (matchesSelectors(leaf.segments, parsed)) out.push(leaf);
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
  // Options are shared read-only: no code path ever mutates an
  // options array after construction (merges only assign or compare
  // it), so sharing is safe — and it is what lets mergeDuplicate()
  // compare options by reference in O(1) in the common case. onValues
  // MUST be an owned copy (A-1, round 7): mergeDuplicate() pushes
  // merged on-values onto the resolved field's array, and sharing the
  // template unit's array let one merge corrupt every other field
  // resolved from the same unit — and left those fields' growth
  // uncharged by the output-byte bound.
  if (field.options) out.options = field.options;
  if (field.label) out.label = field.label;
  if (field.onValues) out.onValues = [...field.onValues];
  return out;
}

/** Byte length of one JSON string literal (quotes + escapes), UTF-8. */
function jsonStringBytes(value: string): number {
  return utf8Length(JSON.stringify(value));
}

/**
 * One resolved field's retained merge accounting (A-4, round 7):
 * the serialized size is kept incrementally (never re-serialized per
 * duplicate), the on-values dedup set is created once at first push
 * (never rebuilt per duplicate), and the merged on-values' byte total
 * is kept alongside it for the T-4 bound.
 */
interface ResolvedFieldEntry {
  field: XfaField;
  somPath: string;
  /** Serialized JSON byte length of `field`, plus 1 for its separator. */
  bytes: number;
  /** Persistent dedup set for the field's on-values. */
  onValuesSeen: Set<string>;
  /**
   * Byte length of the field's merged on-values, charged in the T-4
   * convention: utf8Length(value) + 2 per value — NOT escaped
   * JSON-literal bytes (round 8 correction of this comment: the
   * charge never included escapes). Escaped content cannot bypass
   * the output limit anyway: mergeDuplicate() charges the exact
   * JSON-literal delta to the output bound, and the final
   * JSON.stringify check verifies the exact serialized size.
   */
  onValuesBytes: number;
}

/**
 * Merge a second occurrence of one resolved data node onto the field
 * already reported for it (A-4, round 6; accounting and persistent
 * state round 7). Same node, so the value must agree; the type,
 * options, and label describe that one node, so they must agree too
 * when both sides state them — disagreement is a genuine conflict
 * between two template occurrences, not a merge, and fails closed.
 * Checkbox on-values union (dedup, first-seen order), byte-bounded
 * like the group merge in joinFields.
 *
 * Round 7: the merge state is PERSISTENT, not rebuilt per duplicate —
 * `onValuesSeen` is the resolved field's own Set, created once at
 * first push, so a duplicate never re-scans the accumulated
 * on-values (the old code rebuilt `new Set(existing.onValues)` and
 * recounted accumulated strings on every duplicate). The function
 * returns the exact byte delta the merge adds to the field's
 * serialized JSON, so push() can re-charge the output bound
 * incrementally instead of re-serializing the whole accumulated field
 * per duplicate. Adding a key to a non-empty JSON object always costs
 * exactly `,"key":value`, and appending to an array costs `,value`
 * per element, so the delta is exact for any insertion position;
 * byte lengths use the JSON literal form (escapes included).
 */
function mergeDuplicate(previous: ResolvedFieldEntry, incoming: XfaField): number {
  const existing = previous.field;
  const somPath = previous.somPath;
  const conflict = (detail: string): XfaError =>
    new XfaError(
      `XFA template/datasets mismatch: field '${shortName(somPath)}' has conflicting ${detail} for data node '${shortName(existing.name)}'`,
    );
  if (existing.type !== incoming.type) throw conflict("types");
  if (existing.value !== incoming.value) throw conflict("values");
  let delta = 0;
  if (existing.options !== undefined && incoming.options !== undefined) {
    // Reference fast path first: resolved fields built from one
    // template unit share its options array, so the common case is
    // O(1); only genuinely different arrays pay an element-wise
    // comparison, never a re-serialization.
    if (
      existing.options !== incoming.options &&
      (existing.options.length !== incoming.options.length ||
        existing.options.some((option, index) => option !== incoming.options?.[index]))
    )
      throw conflict("options");
  } else if (incoming.options !== undefined) {
    existing.options = incoming.options;
    delta += 1 + utf8Length('"options":') + utf8Length(JSON.stringify(incoming.options));
  }
  // Labels: first-nonempty-caption-wins reporting convention (round 8
  // wording) — a later label fills an absent first label; two stated
  // labels must agree, or the merge is a conflict, not a merge.
  if (existing.label !== undefined && incoming.label !== undefined) {
    if (existing.label !== incoming.label) throw conflict("labels");
  } else if (incoming.label !== undefined) {
    existing.label = incoming.label;
    delta += 1 + utf8Length('"label":') + jsonStringBytes(incoming.label);
  }
  if (incoming.onValues !== undefined) {
    if (existing.onValues === undefined) {
      existing.onValues = [...incoming.onValues];
      for (const value of incoming.onValues) previous.onValuesSeen.add(value);
      previous.onValuesBytes = incoming.onValues.reduce(
        (total, value) => total + utf8Length(value) + 2,
        0,
      );
      if (previous.onValuesBytes > MAX_JOINED_BYTES)
        throw new XfaError(
          `XFA join produced more than ${MAX_JOINED_BYTES} bytes of checkbox on-values for field '${shortName(somPath)}'; refusing to report an unbounded result`,
        );
      delta += 1 + utf8Length('"onValues":') + utf8Length(JSON.stringify(incoming.onValues));
    } else {
      for (const value of incoming.onValues) {
        if (previous.onValuesSeen.has(value)) continue;
        previous.onValuesSeen.add(value);
        existing.onValues.push(value);
        // Appending one element to the serialized array: one comma
        // plus the element's JSON literal.
        delta += 1 + jsonStringBytes(value);
        previous.onValuesBytes += utf8Length(value) + 2;
        if (previous.onValuesBytes > MAX_JOINED_BYTES)
          throw new XfaError(
            `XFA join produced more than ${MAX_JOINED_BYTES} bytes of checkbox on-values for field '${shortName(somPath)}'; refusing to report an unbounded result`,
          );
      }
    }
  }
  return delta;
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
 * (public-name collision). Two units of ONE template path that
 * resolve to the same data node (overlapping scopes, A-4, round 6)
 * merge into one field when their metadata agrees, and fail closed
 * when it conflicts — the resolved node, not the scope id, is the
 * identity. The resolved output is capped twice: at
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
        // Labels keep first-nonempty-caption-wins (A-2, round 7;
        // wording round 8): repeat occurrences of one field carry
        // per-occurrence captions — the W-9's seven c1_1 boxes are
        // captioned "Individual/sole proprietor", "C corporation", "S
        // corporation", ... — and the collapsed field reports the
        // first nonempty occurrence's caption. That is a lossy
        // reporting convention for this API, NOT a general XFA
        // semantic conclusion: differing captions are not proof of
        // per-choice captions, and a later caption fills an absent
        // first caption. (Cross-subgroup label conflicts still fail
        // closed in mergeDuplicate().) Options are different: they
        // state the one field's value domain, so two occurrences of
        // the same identity that disagree on options — contents or
        // order — fail closed here, exactly as mergeDuplicate() does
        // for resolved-node merges across subgroups.
        if (!merged.label && field.label) merged.label = field.label;
        if (merged.options !== undefined && field.options !== undefined) {
          if (JSON.stringify(merged.options) !== JSON.stringify(field.options))
            throw new XfaError(
              `XFA template/datasets mismatch: field '${shortName(somPath)}' has conflicting options`,
            );
        } else if (!merged.options && field.options) {
          merged.options = field.options;
        }
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
  const resolvedByName = new Map<string, ResolvedFieldEntry>();
  // Cumulative duplicate-work budget (A-4, round 7): every duplicate
  // merge is charged the merged field's retained serialized size —
  // the work a naive re-serialization would have paid, and an upper
  // bound on the comparison work the merge can do against that field
  // (value/options/label comparisons each touch at most the field).
  // Incoming-side work needs no charge here: each unit's on-values
  // and options are built once from the template, so their total
  // across all duplicates is bounded by the template input. Past the
  // budget the inspect fails closed instead of letting duplicates ×
  // retained field size grow without bound.
  let duplicateWorkBytes = 0;
  const push = (field: XfaField, somPath: string): void => {
    const previous = resolvedByName.get(field.name);
    if (previous !== undefined) {
      if (previous.somPath !== somPath)
        throw new XfaError(
          `XFA template/datasets mismatch: fields '${shortName(previous.somPath)}' and '${shortName(somPath)}' resolve to the same data node '${shortName(field.name)}'`,
        );
      // Charge BEFORE merging (A-4, round 7): the charge is what
      // bounds the work — tripping it must not require doing the
      // merge first.
      duplicateWorkBytes += previous.bytes;
      if (duplicateWorkBytes > MAX_CUMULATIVE_DUPLICATE_BYTES)
        throw new XfaError(
          `XFA join exceeded ${MAX_CUMULATIVE_DUPLICATE_BYTES} bytes of cumulative duplicate-merge work; refusing to report an unbounded result`,
        );
      // Same template path, same resolved data node (A-4, round 6):
      // overlapping scopes split one somPath group into units that
      // resolve to the same leaf. They are occurrences of ONE field,
      // so merge compatible metadata onto it (on-values union) and
      // reject incompatible metadata instead of reporting the same
      // public name twice. Scope ids alone cannot establish that two
      // units' resolved node sets are disjoint — the resolved node
      // is the identity, checked here. The merged field keeps its
      // place in the output; only its serialized size is re-charged,
      // incrementally (A-4, round 7) — mergeDuplicate() returns the
      // exact byte delta, so the accumulated field is never
      // re-serialized per duplicate.
      const delta = mergeDuplicate(previous, field);
      previous.bytes += delta;
      outBytes += delta;
      if (outBytes > MAX_JOINED_BYTES)
        throw new XfaError(
          `XFA join produced more than ${MAX_JOINED_BYTES} bytes of resolved fields; refusing to report an unbounded result`,
        );
      return;
    }
    const bytes = utf8.encode(JSON.stringify(field)).length + 1;
    resolvedByName.set(field.name, {
      field,
      somPath,
      bytes,
      onValuesSeen: new Set(field.onValues ?? []),
      onValuesBytes:
        field.onValues?.reduce((total, value) => total + utf8Length(value) + 2, 0) ?? 0,
    });
    out.push(field);
    if (out.length > MAX_JOINED_FIELDS)
      throw new XfaError(
        `XFA join produced more than ${MAX_JOINED_FIELDS} fields; refusing to report an unbounded result`,
      );
    // Aggregate output-byte bound (S-5): the serialized size of every
    // resolved field so far (name, value, label, options, on-values).
    // Enforced here, during the join — before persistence or HTTP
    // serialization can ever see the result.
    outBytes += bytes;
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
  // Final output-byte verification (A-1, round 7): the running
  // outBytes accounting is exact-incremental, but the 1 MiB guarantee
  // is only as sound as every mutation staying charged — the round-6
  // code proved a shared-array mutation could grow fields the
  // accounting never saw. Verify the exact serialized size once,
  // before returning, so no future accounting slip can emit more than
  // MAX_JOINED_BYTES. One serialization of at most ~1 MiB of retained
  // output; the bound it checks keeps that cost bounded.
  if (utf8Length(JSON.stringify(out)) > MAX_JOINED_BYTES)
    throw new XfaError(
      `XFA join produced more than ${MAX_JOINED_BYTES} bytes of resolved fields; refusing to report an unbounded result`,
    );
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
  // xml:space state at the datasets roots (A-3, round 6): the walk
  // starts at <data>, but the state may be set on <datasets> above it.
  collectDataLeaves(dataRoot, [], 0, leaves, effectiveSpace(datasetsRoot, false));
  return { fields: joinFields(templateFields, leaves), formKind: xfaFormKind(doc) ?? "xfa-static" };
}
