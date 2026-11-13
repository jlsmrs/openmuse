import { randomUUID } from "node:crypto";
import { type DefaultTreeAdapterMap, parseFragment } from "parse5";
import { z } from "zod";
import {
  type CalendarEvent,
  calendarEventSchema,
  calendarRangeSchema,
  type EmailDraft,
  type EventDraft,
  emailDraftSchema,
  eventDraftSchema,
  type Mail,
  type MailMetadata,
  mailSchema,
  toMailMetadata,
} from "../../domain/src/index.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR = "https://www.googleapis.com/calendar/v3";
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 1024 * 1024;

/** At most this many Gmail message fetches run at once inside a mail list. */
export const MAIL_LIST_CONCURRENCY = 10;
/**
 * Overall deadline for one mail-list fetch, just inside the agent runtime's
 * ~5-second window: a slow list fails with a clear timeout instead of being
 * killed opaquely by the runtime.
 */
export const MAIL_LIST_DEADLINE_MS = 4_500;
/** Quota (429) and transient 5xx responses back off on reads only, never writes. */
const READ_RETRY_ATTEMPTS = 3;
const READ_RETRY_BASE_MS = 200;
const READ_RETRY_MAX_DELAY_MS = 5_000;
const MAIL_LIST_TIMEOUT_MESSAGE =
  "Mail list timed out before Google finished; narrow the search and try again";
/** The 1 MiB cap on one message's visible text; the limit itself never moves. */
const OVERSIZED_MESSAGE_TEXT = "Gmail message text exceeds the 1 MiB limit";
/** Body carried by a list row whose message was too large to include (M8). */
const OVERSIZED_MESSAGE_NOTE =
  "This message exceeds the 1 MiB limit, so its text was not included in this list.";
/**
 * True only for the size errors one message's text can throw while mapping:
 * the 1 MiB body cap, and the per-part decode cap (a single text part over
 * 1 MiB). In the list path the decode helper only runs on message text, so
 * these mean "this message is too big" — anything else still fails the list.
 */
function isOversizedMessageError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === OVERSIZED_MESSAGE_TEXT ||
      error.message === "Attachment or message body exceeds the size limit" ||
      error.message === "Attachment or message body is too large")
  );
}
/** The 30-deep cap on one message's MIME nesting; the limit itself never moves. */
const OVER_NESTED_MESSAGE_TEXT = "Gmail message MIME nesting exceeds the limit";
/** Body carried by a list row whose message is nested too deeply to include (M9). */
const OVER_NESTED_MESSAGE_NOTE =
  "This message is nested too deeply to display, so its text was not included in this list.";
/**
 * True only for the nesting error one message's MIME tree can throw while
 * mapping: the >30 depth guard in the body walk and in hydration. Anything
 * else still fails the list.
 */
function isOverNestedMessageError(error: unknown): boolean {
  return error instanceof Error && error.message === OVER_NESTED_MESSAGE_TEXT;
}

/**
 * True only for a fetch failure that proves the request never reached
 * Google: DNS lookup or TCP connect failed (undici surfaces these as a
 * TypeError whose cause carries the system code; some runtimes put the code
 * on the error itself). A reset, abort, or timeout after dispatch is not
 * definite — the write may have landed — so it stays outcome-unknown.
 */
function isDefiniteTransportFailure(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const code =
    (cause as { code?: unknown } | null)?.code ?? (error as { code?: unknown } | null)?.code;
  return (
    typeof code === "string" &&
    ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH"].includes(code)
  );
}

export class OutcomeUnknownError extends Error {
  readonly code = "outcome_unknown";
  constructor(
    message = "Google may have completed this action. Check Google before trying again.",
  ) {
    super(message);
    this.name = "OutcomeUnknownError";
  }
}

export class GoogleApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`Google API (${status}): ${detail}`);
    this.name = "GoogleApiError";
  }
}

export class RecurringEventError extends Error {
  readonly status = 422;
  constructor() {
    super(
      "Recurring events cannot be changed here yet. Open Google Calendar to choose one occurrence or the whole series.",
    );
    this.name = "RecurringEventError";
  }
}

export interface CalendarListEntry {
  id: string;
  name: string;
  timeZone: string;
  accessRole: string;
}
export interface ListEventsOptions {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  /** Opaque page token from a previous listEventsPage result, if any. */
  pageToken?: string;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
const partSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
    body: z
      .object({
        data: z.string().optional(),
        size: z.number().nonnegative().optional(),
        attachmentId: z.string().optional(),
      })
      .optional(),
    parts: z.array(partSchema).optional(),
  }),
);
const messageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  snippet: z.string().default(""),
  internalDate: z.string().optional(),
  labelIds: z.array(z.string()).default([]),
  payload: partSchema.optional(),
});
const googleEventSchema = z.object({
  id: z.string().min(1),
  etag: z.string().optional(),
  recurrence: z.array(z.string()).optional(),
  recurringEventId: z.string().optional(),
  summary: z.string().default("(Untitled event)"),
  start: z.object({
    date: z.string().optional(),
    dateTime: z.string().optional(),
    timeZone: z.string().optional(),
  }),
  end: z.object({ date: z.string().optional(), dateTime: z.string().optional() }),
  location: z.string().default(""),
  description: z.string().default(""),
  attendees: z.array(z.object({ email: z.string() })).default([]),
});
export interface MailAttachment {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

function idPath(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid Google resource ID");
  return encodeURIComponent(id);
}
function calendarPath(calendarId: string): string {
  if (
    !calendarId ||
    calendarId.length > 1024 ||
    Array.from(calendarId).some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
    calendarId === "." ||
    calendarId === ".."
  )
    throw new Error("Invalid Google calendar ID");
  return `${CALENDAR}/calendars/${encodeURIComponent(calendarId)}/events`;
}
function singleLine(value: string, field: string): string {
  if (Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))
    throw new Error(`Invalid ${field}: header control characters are not allowed`);
  return value;
}
function decodeBase64url(encoded: string, limit = MAX_ATTACHMENT_BYTES): Buffer {
  if (encoded.length > Math.ceil((limit * 4) / 3) + 4)
    throw new Error("Attachment or message body exceeds the size limit");
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(encoded))
    throw new Error("Invalid base64url attachment or message body");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length > limit) throw new Error("Attachment or message body is too large");
  if (bytes.toString("base64url") !== encoded.replace(/=+$/, ""))
    throw new Error("Invalid base64url attachment or message body");
  return bytes;
}
function headers(part?: GmailPart): Map<string, string> {
  return new Map((part?.headers ?? []).map(({ name, value }) => [name.toLowerCase(), value]));
}
/**
 * Every value for a header name, in order. headers() above collapses
 * duplicates last-wins, which drops recipients when a message carries more
 * than one To header (and hides a second From).
 */
function headersAll(part?: GmailPart): Map<string, string[]> {
  const all = new Map<string, string[]>();
  for (const { name, value } of part?.headers ?? []) {
    const key = name.toLowerCase();
    const values = all.get(key) ?? [];
    values.push(value);
    all.set(key, values);
  }
  return all;
}
function decodeHeader(value: string): string {
  // RFC 2047: ignore linear whitespace, including folding, between encoded words.
  return value
    .replace(/(\?=)(?:[ \t]|\r\n[ \t])+(?==\?)/g, "$1")
    .replace(
      /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
      (original, charset: string, encoding: string, text: string) => {
        try {
          const bytes =
            encoding.toLowerCase() === "b"
              ? Buffer.from(text, "base64")
              : Buffer.from(
                  text
                    .replace(/_/g, " ")
                    .replace(/=([0-9a-f]{2})/gi, (_, code: string) =>
                      String.fromCharCode(Number.parseInt(code, 16)),
                    ),
                  "latin1",
                );
          return new TextDecoder(charset.split("*")[0]).decode(bytes);
        } catch {
          return original;
        }
      },
    );
}
function decodeSnippet(value: string): string {
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (original, entity: string) => {
      if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? original;
      const code =
        entity[1].toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      // Surrogates are not scalar values: fromCodePoint throws on them, and one
      // such reference in a snippet must not reject the whole message list.
      const scalar = code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
      return scalar ? String.fromCodePoint(code) : original;
    },
  );
}
function addresses(value: string): string[] {
  // Comments may contain addresses, nested comments and escaped parentheses.
  // Quoted display names treat parentheses literally instead.
  let uncommented = "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  // Encoded words are display text, never mailbox syntax, even if their raw
  // payload happens to contain an address or parentheses.
  for (const character of value.replace(/=\?[^?]+\?[bq]\?[^?]*\?=/gi, "")) {
    if (escaped) {
      if (!depth) uncommented += character;
      escaped = false;
    } else if (character === "\\") {
      if (!depth) uncommented += character;
      escaped = true;
    } else if (!depth && character === '"') {
      quoted = !quoted;
      uncommented += character;
    } else if (!quoted && character === "(") {
      if (!depth) uncommented += " ";
      depth++;
    } else if (depth && character === ")") {
      depth--;
    } else if (!depth) uncommented += character;
  }
  // A quoted display name may itself contain an e-mail-looking string; only
  // addresses outside display names count.
  return (
    uncommented
      .replace(/"(?:[^"\\]|\\.)*"\s*(?=<)/g, " ")
      .match(/[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+/g) ?? []
  );
}
/** Extract text from a parsed HTML tree. Nothing is rendered or fetched. */
function htmlToPlainText(html: string): string {
  const root = parseFragment(html);
  const excluded = new Set([
    "script",
    "style",
    "head",
    "template",
    "noscript",
    "iframe",
    "object",
    "svg",
    "math",
  ]);
  const blocks = new Set([
    "address",
    "article",
    "aside",
    "blockquote",
    "div",
    "footer",
    "form",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "li",
    "main",
    "ol",
    "p",
    "pre",
    "section",
    "table",
    "tr",
    "ul",
  ]);
  const stack: (DefaultTreeAdapterMap["node"] | string)[] = [root];
  const text: string[] = [];
  while (stack.length) {
    const node = stack.pop();
    if (node === undefined) break;
    if (typeof node === "string") {
      text.push(node);
      continue;
    }
    if ("value" in node) {
      text.push(node.value);
      continue;
    }
    if ("tagName" in node) {
      if (excluded.has(node.tagName)) continue;
      if (node.tagName === "br") {
        text.push("\n");
        continue;
      }
      if (blocks.has(node.tagName)) {
        text.push("\n");
        stack.push("\n");
      }
      if (node.tagName === "td" || node.tagName === "th") stack.push("\t");
    }
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index--)
        stack.push(node.childNodes[index]);
    }
  }
  return text
    .join("")
    .replace(/[\t \u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
/** UTF-8 when the declared charset is not one TextDecoder knows (`unknown-8bit`, `utf-7`). */
function decoderFor(charset: string): TextDecoder {
  try {
    return new TextDecoder(charset);
  } catch {
    return new TextDecoder();
  }
}
/**
 * Replace unpaired surrogates with U+FFFD so encodeURIComponent cannot throw "URI
 * malformed" on a sender-supplied name. (String.prototype.toWellFormed, but the
 * project targets ES2023.)
 */
const wellFormed = (value: string): string =>
  value.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "\uFFFD",
  );

function isAttachedPart(part: GmailPart): boolean {
  return (
    Boolean(part.filename) ||
    part.mimeType === "message/rfc822" ||
    headers(part).get("content-disposition")?.split(";")[0].trim().toLowerCase() === "attachment"
  );
}

/**
 * Validate a mapper's output against its shared domain schema (R2). A shape
 * failure is a mapping bug, not a per-message content problem: it throws
 * with the offending fields named. The list path treats it like any other
 * mapping failure — the list fails visibly — instead of a note row, which
 * is reserved for oversized/over-nested messages.
 */
function parseMapped<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`${what} failed validation: ${detail}`);
}

function mapMessage(message: z.infer<typeof messageSchema>): Mail {
  const metadata = headers(message.payload);
  const allHeaders = headersAll(message.payload);
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: string[] = [];
  // Recurse into every part's children, including attached ones: a forwarded
  // message (message/rfc822) carries readable text of its own. Text stays
  // suppressed under a file attachment — an attached file's children are
  // file content, never parent text (pinned by google-disposition.test.ts).
  const visit = (part: GmailPart, depth: number, underFileAttachment = false) => {
    if (depth > 30) throw new Error(OVER_NESTED_MESSAGE_TEXT);
    const attached = isAttachedPart(part);
    const fileAttachment = attached && part.mimeType !== "message/rfc822";
    const suppressed = underFileAttachment || fileAttachment;
    if (attached && part.body?.attachmentId) {
      const name =
        part.filename ||
        (part.mimeType === "message/rfc822" ? "forwarded-message.eml" : "attachment");
      attachments.push(
        `${message.id}:${part.body.attachmentId}:${encodeURIComponent(wellFormed(name))}`,
      );
    }
    if (
      !suppressed &&
      (part.mimeType === "text/plain" || part.mimeType === "text/html") &&
      part.body?.data
    ) {
      const charset =
        headers(part)
          .get("content-type")
          ?.match(/charset=["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
      const text = decoderFor(charset).decode(decodeBase64url(part.body.data, 1024 * 1024));
      if (part.mimeType === "text/plain") plain.push(text);
      else html.push(htmlToPlainText(text));
    }
    for (const child of part.parts ?? []) visit(child, depth + 1, suppressed);
  };
  if (message.payload) visit(message.payload, 0);
  // Duplicate headers: From takes the first value (only one is valid), To
  // keeps every address across all To headers.
  const rawFrom = allHeaders.get("from")?.[0] ?? metadata.get("from") ?? "";
  const from = decodeHeader(rawFrom);
  const address = addresses(rawFrom)[0] ?? from;
  const displayName = from.includes("<")
    ? from.slice(0, from.indexOf("<")).trim().replace(/^"|"$/g, "")
    : "";
  const sender = displayName || address;
  const time = message.internalDate
    ? Number(message.internalDate)
    : Date.parse(metadata.get("date") ?? "");
  const date = new Date(time);
  const rawDate = metadata.get("date") ?? "";
  const body = plain.length
    ? plain.join("\n\n")
    : html.length
      ? html.join("\n\n")
      : decodeSnippet(message.snippet);
  if (body.length > 1024 * 1024) throw new Error(OVERSIZED_MESSAGE_TEXT);
  const mail: Mail = {
    id: message.id,
    threadId: message.threadId,
    from: address,
    sender,
    to: addresses((allHeaders.get("to") ?? []).join(", ")),
    subject: decodeHeader(metadata.get("subject") ?? "(No subject)"),
    body,
    // A malformed date falls back to the raw header instead of vanishing:
    // the row stays sortable-by-nothing but still shows when it arrived.
    date: Number.isFinite(date.getTime()) ? date.toISOString() : rawDate,
    unread: message.labelIds.includes("UNREAD"),
    label: message.labelIds.includes("INBOX")
      ? "Inbox"
      : message.labelIds.includes("SENT")
        ? "Sent"
        : message.labelIds.includes("TRASH")
          ? "Trash"
          : message.labelIds.includes("SPAM")
            ? "Spam"
            : "Mail",
    attachments,
  };
  return parseMapped(mailSchema, mail, "Mapped mail");
}

function mapEvent(value: unknown, calendarId: string, calendarTimeZone = "UTC"): CalendarEvent {
  const event = googleEventSchema.parse(value);
  const allDay = Boolean(event.start.date);
  const start = allDay ? event.start.date : event.start.dateTime;
  const end = allDay ? event.end.date : event.end.dateTime;
  if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)))
    throw new Error("Invalid Google event time range");
  const mapped: CalendarEvent = {
    id: event.id,
    calendarId,
    title: event.summary,
    start,
    end,
    allDay,
    timeZone: event.start.timeZone ?? calendarTimeZone,
    location: event.location,
    description: event.description,
    attendees: event.attendees.map((attendee) => attendee.email),
  };
  return parseMapped(calendarEventSchema, mapped, "Mapped calendar event");
}
function eventBody(draft: EventDraft, patch = false) {
  return {
    summary: draft.title,
    start: draft.allDay
      ? { date: draft.start, ...(patch ? { dateTime: null } : {}) }
      : { dateTime: draft.start, timeZone: draft.timeZone, ...(patch ? { date: null } : {}) },
    end: draft.allDay
      ? { date: draft.end, ...(patch ? { dateTime: null } : {}) }
      : { dateTime: draft.end, timeZone: draft.timeZone, ...(patch ? { date: null } : {}) },
    location: draft.location,
    description: draft.description,
    attendees: draft.attendees.map((email) => ({ email })),
  };
}
function encodedSubject(subject: string): string {
  const chunks: string[] = [];
  let chunk = "";
  for (const char of subject) {
    if (Buffer.byteLength(chunk + char) > 42) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((part) => `=?UTF-8?B?${Buffer.from(part).toString("base64")}?=`).join("\r\n ");
}
function wrapBase64(bytes: Uint8Array): string {
  return (
    Buffer.from(bytes)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  );
}
function validateAttachments(attachments: MailAttachment[]): void {
  if (attachments.length > 10) throw new Error("Attachment count exceeds the limit of 10");
  let total = 0;
  for (const attachment of attachments) {
    singleLine(attachment.name, "attachment name");
    if (!attachment.name || Buffer.byteLength(attachment.name) > 180)
      throw new Error("Invalid attachment name length");
    if (!/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(attachment.mimeType))
      throw new Error("Invalid attachment MIME type");
    if (attachment.bytes.length > MAX_ATTACHMENT_BYTES)
      throw new Error("Attachment is too large (10 MiB limit)");
    total += attachment.bytes.length;
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES)
    throw new Error("Total attachment size exceeds the 20 MiB limit");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Backoff for a failed read: honor Retry-After when present, else exponential. */
function readRetryDelayMs(response: Response, attempt: number): number {
  const raw = response.headers.get("retry-after");
  if (raw !== null) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, READ_RETRY_MAX_DELAY_MS);
  }
  return Math.min(READ_RETRY_BASE_MS * 2 ** attempt, READ_RETRY_MAX_DELAY_MS);
}

async function readJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_JSON_BYTES) {
    await response.body?.cancel();
    throw new Error("Google response exceeds the size limit");
  }
  if (!response.body) throw new Error("Google returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error("Google response exceeds the size limit");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

export class GoogleClient {
  private readonly fetcher: typeof fetch;
  private readonly getAccessToken: () => Promise<string>;
  private readonly mailListConcurrency: number;
  private readonly mailListDeadlineMs: number;
  constructor(options: {
    getAccessToken: () => Promise<string>;
    fetch?: typeof fetch;
    mailListConcurrency?: number;
    mailListDeadlineMs?: number;
  }) {
    this.fetcher = options.fetch ?? fetch;
    this.getAccessToken = options.getAccessToken;
    this.mailListConcurrency = Math.max(
      1,
      Math.floor(options.mailListConcurrency ?? MAIL_LIST_CONCURRENCY),
    );
    this.mailListDeadlineMs = options.mailListDeadlineMs ?? MAIL_LIST_DEADLINE_MS;
  }

  private async mapMessage(message: z.infer<typeof messageSchema>): Promise<Mail> {
    const hydrate = async (part: GmailPart, depth: number): Promise<void> => {
      if (depth > 30) throw new Error(OVER_NESTED_MESSAGE_TEXT);
      // Attached MIME trees are not part of the parent body. Leave their content
      // lazy, matching the module-level mapMessage visible-text extractor.
      // (Item 8 recurses the *mapping* walk into attached children so a
      // forwarded message's inline text reads; remote content inside an
      // attached tree is still never fetched — pinned by the "attached MIME
      // trees are not fetched" test.)
      if (isAttachedPart(part)) return;
      if (
        (part.mimeType === "text/plain" || part.mimeType === "text/html") &&
        part.body?.data === undefined &&
        part.body?.attachmentId
      ) {
        if ((part.body.size ?? 0) > 1024 * 1024) throw new Error(OVERSIZED_MESSAGE_TEXT);
        const bytes = await this.getAttachment(message.id, part.body.attachmentId);
        if (bytes.length > 1024 * 1024) throw new Error(OVERSIZED_MESSAGE_TEXT);
        part.body.data = Buffer.from(bytes).toString("base64url");
      }
      for (const child of part.parts ?? []) await hydrate(child, depth + 1);
    };
    if (message.payload) await hydrate(message.payload, 0);
    return mapMessage(message);
  }

  async getThread(threadId: string): Promise<Mail[]> {
    const thread = z
      .object({ id: z.string(), messages: z.array(messageSchema).default([]) })
      .parse(await this.request(`${GMAIL}/threads/${idPath(threadId)}?format=full`));
    if (thread.id !== threadId || thread.messages.some((message) => message.threadId !== threadId))
      throw new Error("Google returned messages from a different thread");
    return Promise.all(thread.messages.map((message) => this.mapMessage(message)));
  }

  /**
   * All calendars, page by page. A duplicate page token (the provider looping)
   * or an 11th page ends the walk and returns what was fetched with
   * truncated set — it no longer throws the fetched calendars away.
   */
  async listCalendars(): Promise<{ calendars: CalendarListEntry[]; truncated: boolean }> {
    const entries: CalendarListEntry[] = [];
    const tokens = new Set<string>();
    let pageToken: string | undefined;
    let truncated = false;
    do {
      const params = new URLSearchParams({ maxResults: "250" });
      if (pageToken) params.set("pageToken", pageToken);
      const result = z
        .object({
          items: z
            .array(
              z.object({
                id: z.string().min(1),
                summary: z.string().default("(Untitled calendar)"),
                summaryOverride: z.string().optional(),
                // Google marks the calendar time zone as optional.
                timeZone: z.string().default("UTC"),
                accessRole: z.string(),
              }),
            )
            .default([]),
          nextPageToken: z.string().min(1).optional(),
        })
        .parse(await this.request(`${CALENDAR}/users/me/calendarList?${params}`));
      entries.push(
        ...result.items.map((calendar) => ({
          id: calendar.id,
          name: calendar.summaryOverride ?? calendar.summary,
          timeZone: calendar.timeZone,
          accessRole: calendar.accessRole,
        })),
      );
      pageToken = result.nextPageToken;
      if (pageToken) {
        if (tokens.has(pageToken) || tokens.size >= 10) {
          truncated = true;
          break;
        }
        tokens.add(pageToken);
      }
    } while (pageToken);
    return { calendars: entries, truncated };
  }

  private async readSingleEvent(
    calendarId: string,
    eventId: string,
  ): Promise<z.infer<typeof googleEventSchema>> {
    const event = googleEventSchema.parse(
      await this.request(`${calendarPath(calendarId)}/${idPath(eventId)}`),
    );
    if (event.id !== eventId) throw new Error("Google returned a different event");
    if (event.recurrence !== undefined || event.recurringEventId !== undefined)
      throw new RecurringEventError();
    return event;
  }

  async validateSingleEvent(calendarId: string, eventId: string): Promise<void> {
    await this.readSingleEvent(calendarId, eventId);
  }

  async reviewEvent(
    calendarId: string,
    eventId: string,
  ): Promise<{ event: CalendarEvent; version: string }> {
    const current = await this.readSingleEvent(calendarId, eventId);
    const version = this.eventVersion(current);
    const timeZone =
      current.start.timeZone ??
      z
        // Google marks the calendar time zone as optional.
        .object({ timeZone: z.string().min(1).default("UTC") })
        .parse(
          await this.request(`${CALENDAR}/users/me/calendarList/${encodeURIComponent(calendarId)}`),
        ).timeZone;
    return { event: mapEvent(current, calendarId, timeZone), version };
  }

  private eventVersion(event: z.infer<typeof googleEventSchema>, expectedVersion?: string): string {
    if (!event.etag?.trim()) throw new Error("Google event has no ETag; prepare a fresh review");
    const version = singleLine(event.etag, "event ETag");
    if (expectedVersion !== undefined && version !== expectedVersion)
      throw new GoogleApiError(409, "This event changed since review. Prepare a new action.");
    return version;
  }

  private async request(
    url: string,
    method = "GET",
    body?: unknown,
    conditionalHeaders: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const write = method !== "GET";
    // Credential failures happen before dispatch, so their outcome is definite.
    const token = await this.getAccessToken();
    if (!token || /[\r\n]/.test(token))
      throw new Error("Google access token is missing or invalid; reconnect Google");
    // Reads back off on quota (429) and transient 5xx responses; writes are
    // never retried, so a repeated send cannot duplicate an action.
    const attempts = write ? 1 : READ_RETRY_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...conditionalHeaders,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
            : AbortSignal.timeout(30000),
          redirect: "error",
        });
      } catch (error) {
        if (signal?.aborted) throw new Error(MAIL_LIST_TIMEOUT_MESSAGE);
        if (write) {
          // A write whose fetch throws before dispatch (DNS/connect never
          // reached Google) is a definite failure, not outcome-unknown:
          // the request provably never arrived. Anything else — a reset or
          // timeout after dispatch, a lost response — stays ambiguous.
          if (isDefiniteTransportFailure(error))
            throw new Error("Could not reach Google; check the connection and try again");
          throw new OutcomeUnknownError();
        }
        throw new Error("Could not reach Google; check the connection and try again");
      }
      if (write && (response.status >= 500 || response.status === 408)) {
        try {
          await response.body?.cancel();
        } catch {
          throw new OutcomeUnknownError();
        }
        throw new OutcomeUnknownError();
      }
      if (!response.ok) {
        if (
          !write &&
          (response.status === 429 || response.status >= 500) &&
          attempt < attempts - 1
        ) {
          try {
            await response.body?.cancel();
          } catch {
            /* A failed body drain must not mask the retry. */
          }
          await sleep(readRetryDelayMs(response, attempt));
          continue;
        }
        let detail = response.statusText || "Request failed";
        try {
          const result = z
            .object({ error: z.object({ message: z.string() }) })
            .safeParse(await readJson(response));
          if (result.success) detail = result.data.error.message.slice(0, 500);
        } catch {
          /* Preserve the definite HTTP rejection even if its body is not JSON. */
        }
        throw new GoogleApiError(response.status, detail);
      }
      if (method === "DELETE" && response.status === 204) return undefined;
      try {
        return await readJson(response);
      } catch {
        if (write) throw new OutcomeUnknownError();
        throw new Error("Google returned an invalid or oversized response");
      }
    }
    // Unreachable: every path above returns or throws.
    throw new Error("Could not reach Google; check the connection and try again");
  }

  /**
   * Best-effort row for a message whose text cannot be listed: keep its
   * real sender/subject/date from a headers-only re-fetch and carry a note
   * instead of the body, so one bad message cannot fail the list. The
   * re-fetch is mapped with the module-level mapMessage only — no
   * hydration. When stripParts is set (M9), the re-fetched part tree is
   * dropped before mapping, so the note path itself can never throw the
   * nesting error again (a metadata response carries the same deep part
   * tree that failed the list fetch). If even the headers cannot be read,
   * fall back to a bare row.
   */
  private async noteRow(
    id: string,
    signal: AbortSignal,
    note: string,
    stripParts: boolean,
  ): Promise<Mail> {
    try {
      const meta = new URLSearchParams({ format: "metadata" });
      for (const header of ["From", "Subject", "Date", "To"])
        meta.append("metadataHeaders", header);
      const parsed = messageSchema.parse(
        await this.request(`${GMAIL}/messages/${idPath(id)}?${meta}`, "GET", undefined, {}, signal),
      );
      if (stripParts && parsed.payload) parsed.payload = { ...parsed.payload, parts: [] };
      const mail = mapMessage(parsed);
      return { ...mail, body: note };
    } catch {
      return {
        id,
        threadId: "",
        from: "",
        sender: "",
        to: [],
        subject: "(No subject)",
        body: note,
        date: "",
        unread: false,
        label: "Mail",
        attachments: [],
      };
    }
  }

  /** noteRow for the headers-only path: the note goes in the snippet, never a body. */
  private async noteRowMetadata(
    id: string,
    signal: AbortSignal,
    note: string,
    stripParts: boolean,
  ): Promise<MailMetadata> {
    const row = await this.noteRow(id, signal, note, stripParts);
    return toMailMetadata(row);
  }

  /**
   * Fetch one page of message IDs, then fetch each message with bounded
   * concurrency under one overall deadline. Results keep list order. A
   * deadline expiry reports a clear timeout instead of letting the agent
   * runtime kill the call; an oversized or over-nested message is isolated
   * to a note row (M8/M9), while any other single message failure still
   * fails the list. The provider's next-page token is returned so callers
   * can page past the first 100 matches instead of silently truncating.
   */
  private async listMessages<T>(
    query: string,
    fetchOne: (id: string, signal: AbortSignal) => Promise<T>,
    makeNoteRow: (id: string, signal: AbortSignal, note: string, stripParts: boolean) => Promise<T>,
    pageToken?: string,
  ): Promise<{ messages: T[]; nextPageToken?: string; truncated: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.mailListDeadlineMs);
    try {
      const params = new URLSearchParams({ maxResults: "100", q: query });
      if (pageToken) params.set("pageToken", pageToken);
      const list = z
        .object({
          messages: z.array(z.object({ id: z.string() })).default([]),
          nextPageToken: z.string().min(1).optional(),
        })
        .parse(
          await this.request(
            `${GMAIL}/messages?${params}`,
            "GET",
            undefined,
            {},
            controller.signal,
          ),
        );
      const ids = list.messages.slice(0, 100).map(({ id }) => id);
      const results: T[] = new Array(ids.length);
      let next = 0;
      const workers = Array.from(
        { length: Math.min(this.mailListConcurrency, ids.length) },
        async () => {
          while (next < ids.length) {
            if (controller.signal.aborted) return;
            const index = next++;
            try {
              results[index] = await fetchOne(ids[index], controller.signal);
            } catch (error) {
              // One oversized or over-nested message must not fail the whole
              // list (M8/M9): keep its row with a note. Any other failure
              // still fails it.
              if (isOversizedMessageError(error)) {
                results[index] = await makeNoteRow(
                  ids[index],
                  controller.signal,
                  OVERSIZED_MESSAGE_NOTE,
                  false,
                );
              } else if (isOverNestedMessageError(error)) {
                results[index] = await makeNoteRow(
                  ids[index],
                  controller.signal,
                  OVER_NESTED_MESSAGE_NOTE,
                  true,
                );
              } else {
                throw error;
              }
            }
          }
        },
      );
      await Promise.race([
        Promise.all(workers),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error(MAIL_LIST_TIMEOUT_MESSAGE)),
            { once: true },
          ),
        ),
      ]);
      return {
        messages: results,
        nextPageToken: list.nextPageToken,
        truncated: Boolean(list.nextPageToken),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The latest 100 matching messages. Permission/read failures propagate visibly. */
  async listMail(query = "in:inbox"): Promise<Mail[]> {
    return (
      await this.listMessages(
        query,
        async (id, signal) =>
          this.mapMessage(
            messageSchema.parse(
              await this.request(
                `${GMAIL}/messages/${idPath(id)}?format=full`,
                "GET",
                undefined,
                {},
                signal,
              ),
            ),
          ),
        (id, signal, note, stripParts) => this.noteRow(id, signal, note, stripParts),
      )
    ).messages;
  }

  /**
   * The latest 100 matching messages, headers only — no body text is fetched.
   * Full bodies are slow (100 large fetches exceed the agent runtime's window)
   * and too large for one reply, so lists, counts and tables use this path
   * and full bodies come from getThread for a selected message instead.
   * Permission/read failures propagate visibly. Pass the previous page's
   * nextPageToken to read the next 100 matches. Rows are MailMetadata: the
   * snippet, never a body. truncated is true exactly when another page exists.
   */
  async listMailMetadata(
    query = "in:inbox",
    pageToken?: string,
  ): Promise<{ messages: MailMetadata[]; nextPageToken?: string; truncated: boolean }> {
    const meta = new URLSearchParams({ format: "metadata" });
    for (const header of ["From", "Subject", "Date", "To"]) meta.append("metadataHeaders", header);
    return this.listMessages(
      query,
      async (id, signal) =>
        toMailMetadata(
          await this.mapMessage(
            messageSchema.parse(
              await this.request(
                `${GMAIL}/messages/${idPath(id)}?${meta}`,
                "GET",
                undefined,
                {},
                signal,
              ),
            ),
          ),
        ),
      (id, signal, note, stripParts) => this.noteRowMetadata(id, signal, note, stripParts),
      pageToken,
    );
  }

  /** At most 100 occurrences in a bounded window, beginning at local midnight by default. */
  async listEvents(
    options: ListEventsOptions = {},
  ): Promise<{ events: CalendarEvent[]; truncated: boolean; nextPageToken?: string }> {
    return this.listEventsPage(options);
  }

  /** Retain the provider's completeness marker without fetching additional pages. */
  async listEventsPage(options: ListEventsOptions = {}) {
    const calendarId = options.calendarId ?? "primary";
    const path = calendarPath(calendarId);
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const timeMin = options.timeMin ?? midnight.toISOString();
    const timestamp = z.iso.datetime({ offset: true });
    if (!timestamp.safeParse(timeMin).success)
      throw new Error("Invalid calendar timeMin: use a date-time with an explicit offset");
    const timeMax =
      options.timeMax ?? new Date(Date.parse(timeMin) + 31 * 24 * 60 * 60 * 1000).toISOString();
    if (!timestamp.safeParse(timeMax).success)
      throw new Error("Invalid calendar timeMax: use a date-time with an explicit offset");
    calendarRangeSchema.parse({ timeMin, timeMax });
    const params = new URLSearchParams({
      maxResults: "100",
      singleEvents: "true",
      orderBy: "startTime",
      timeMin,
      timeMax,
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    const result = z
      .object({
        items: z.array(z.unknown()).default([]),
        timeZone: z.string().default("UTC"),
        nextPageToken: z.string().min(1).optional(),
      })
      .parse(await this.request(`${path}?${params}`));
    return {
      events: result.items.slice(0, 100).map((item) => mapEvent(item, calendarId, result.timeZone)),
      truncated: Boolean(result.nextPageToken) || result.items.length > 100,
      nextPageToken: result.nextPageToken,
    };
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
    const data = z
      .object({ data: z.string(), size: z.number().int().nonnegative().optional() })
      .parse(
        await this.request(
          `${GMAIL}/messages/${idPath(messageId)}/attachments/${idPath(attachmentId)}`,
        ),
      );
    if (data.size !== undefined && data.size > MAX_ATTACHMENT_BYTES)
      throw new Error("Attachment is too large (10 MiB limit)");
    const bytes = decodeBase64url(data.data);
    if (data.size !== undefined && data.size !== bytes.length)
      throw new Error("Google attachment size does not match its actual byte length");
    return new Uint8Array(bytes);
  }

  async sendEmail(
    input: EmailDraft,
    attachments: MailAttachment[],
  ): Promise<{ id: string; threadId?: string }> {
    const draft = emailDraftSchema.parse(input);
    singleLine(draft.subject, "subject");
    for (const address of [...draft.to, ...draft.cc, ...draft.bcc])
      singleLine(address, "recipient");
    validateAttachments(attachments);
    if (draft.threadId && !draft.replyToMessageId)
      throw new Error("Replies require replyToMessageId to resolve the source message headers");
    let threadId: string | undefined;
    const replyHeaders: string[] = [];
    if (draft.replyToMessageId) {
      const params = new URLSearchParams({ format: "metadata" });
      for (const name of ["Message-ID", "References", "Subject"])
        params.append("metadataHeaders", name);
      const source = messageSchema.parse(
        await this.request(`${GMAIL}/messages/${idPath(draft.replyToMessageId)}?${params}`),
      );
      if (draft.threadId && source.threadId !== draft.threadId)
        throw new Error("Reply thread does not match the source message");
      threadId = source.threadId;
      const metadata = headers(source.payload);
      const messageId = singleLine(metadata.get("message-id") ?? "", "Message-ID");
      const normalizedSubject = (subject: string) =>
        decodeHeader(subject)
          .replace(/^(?:\s*re:\s*)+/i, "")
          .trim();
      if (normalizedSubject(draft.subject) !== normalizedSubject(metadata.get("subject") ?? ""))
        throw new Error("Reply subject must match the source message subject");
      // A source message without a strictly formatted Message-ID still
      // threads: the send below carries its threadId, and Gmail groups by
      // thread plus the matching subject. In-Reply-To/References are only
      // added when the Message-ID is usable — a bad one used to reject the
      // whole reply.
      if (/^<[^<>\s]+@[^<>\s]+>$/.test(messageId)) {
        const references = singleLine(metadata.get("references") ?? "", "References").trim();
        if (references && !/^(?:<[^<>\s]+@[^<>\s]+>\s*)+$/.test(references))
          throw new Error("Source message has invalid References headers");
        const chain = [...new Set([...(references.match(/<[^<>\s]+>/g) ?? []), messageId])];
        if (chain.join(" ").length > 950)
          throw new Error("Reply References header exceeds the supported length");
        replyHeaders.push(`In-Reply-To: ${messageId}`, `References: ${chain.join(" ")}`);
      }
    }
    const profile = z
      .object({ emailAddress: z.email() })
      .parse(await this.request(`${GMAIL}/profile`));
    const mimeHeaders = [
      `From: ${singleLine(profile.emailAddress, "sender")}`,
      `To: ${draft.to.join(",\r\n ")}`,
      ...(draft.cc.length ? [`Cc: ${draft.cc.join(",\r\n ")}`] : []),
      ...(draft.bcc.length ? [`Bcc: ${draft.bcc.join(",\r\n ")}`] : []),
      `Subject: ${encodedSubject(draft.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@openmuse.invalid>`,
      ...replyHeaders,
      "MIME-Version: 1.0",
    ];
    const textPart = [
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(Buffer.from(draft.body.replace(/\r\n|\r|\n/g, "\r\n"))),
    ].join("\r\n");
    let mime: string;
    if (!attachments.length) mime = [...mimeHeaders, textPart].join("\r\n");
    else {
      const boundary = `openmuse_${randomUUID()}`;
      const parts = [
        textPart,
        ...attachments.map((attachment) => {
          const name = encodeURIComponent(wellFormed(attachment.name)).replace(
            /['()*]/g,
            (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
          );
          return [
            `Content-Type: ${attachment.mimeType}`,
            `Content-Disposition: attachment; filename*=UTF-8''${name}`,
            "Content-Transfer-Encoding: base64",
            "",
            wrapBase64(attachment.bytes),
          ].join("\r\n");
        }),
      ];
      mime = [
        ...mimeHeaders,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        ...parts.map((part) => `--${boundary}\r\n${part}`),
        `--${boundary}--`,
        "",
      ].join("\r\n");
    }
    const result = await this.request(`${GMAIL}/messages/send`, "POST", {
      raw: Buffer.from(mime).toString("base64url"),
      ...(threadId ? { threadId } : {}),
    });
    const parsed = z
      .object({ id: z.string().min(1), threadId: z.string().optional() })
      .safeParse(result);
    if (!parsed.success) throw new OutcomeUnknownError();
    return parsed.data;
  }

  async createEvent(input: EventDraft): Promise<CalendarEvent> {
    const draft = eventDraftSchema.parse(input);
    const result = await this.request(
      `${calendarPath(draft.calendarId)}?sendUpdates=all`,
      "POST",
      eventBody(draft),
    );
    try {
      return mapEvent(result, draft.calendarId, draft.timeZone);
    } catch {
      throw new OutcomeUnknownError();
    }
  }

  async updateEvent(
    eventId: string,
    input: EventDraft,
    expectedVersion?: string,
  ): Promise<CalendarEvent> {
    const draft = eventDraftSchema.parse(input);
    const current = await this.readSingleEvent(draft.calendarId, eventId);
    const result = await this.request(
      `${calendarPath(draft.calendarId)}/${idPath(eventId)}?sendUpdates=all`,
      "PATCH",
      eventBody(draft, true),
      { "If-Match": this.eventVersion(current, expectedVersion) },
    );
    try {
      return mapEvent(result, draft.calendarId, draft.timeZone);
    } catch {
      throw new OutcomeUnknownError();
    }
  }

  async deleteEvent(calendarId: string, eventId: string, expectedVersion?: string): Promise<void> {
    const current = await this.readSingleEvent(calendarId, eventId);
    await this.request(
      `${calendarPath(calendarId)}/${idPath(eventId)}?sendUpdates=all`,
      "DELETE",
      undefined,
      { "If-Match": this.eventVersion(current, expectedVersion) },
    );
  }
}
