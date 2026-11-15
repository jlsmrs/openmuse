import { z } from "zod";

export type WorkspaceMode = "sample" | "live";
export type Section =
  | "today"
  | "chat"
  | "mail"
  | "calendar"
  | "browser"
  | "files"
  | "activity"
  | "connections"
  | "ideas"
  | "goals"
  | "apps";
/**
 * Shared shape for a full mail row, as mapMessage produces it. The schema is
 * the single source of truth — Mail is its inferred type, so the shape and
 * its validation cannot drift apart (R2).
 */
export const mailSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  from: z.string(),
  sender: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  // A malformed Date header falls back to the raw header instead of
  // vanishing (mapMessage), so the date is a string, not necessarily ISO.
  date: z.string(),
  unread: z.boolean(),
  // Live rows use Inbox/Sent/Trash/Spam/Mail, but sample rows use arbitrary
  // labels ("School", "Sent · local"), so the label stays a plain string.
  label: z.string(),
  attachments: z.array(z.string()),
});
export type Mail = z.infer<typeof mailSchema>;
/**
 * Headers-only mail row: the list/search shape. It carries the snippet, never
 * a body — full bodies come from getThread for a selected message instead.
 * The sample path must return this same shape (S-B9 agrees on it).
 */
export const mailMetadataSchema = mailSchema.omit({ body: true }).extend({ snippet: z.string() });
export type MailMetadata = z.infer<typeof mailMetadataSchema>;
/** Strip a full mail row to its headers-only shape (body becomes the snippet). */
export function toMailMetadata(mail: Mail): MailMetadata {
  const { body, ...rest } = mail;
  return { ...rest, snippet: body };
}
/**
 * A start/end that mapEvent accepts: a date for all-day events, an ISO
 * date-time otherwise. mapEvent guarantees both parse — that is the check,
 * not an ISO shape.
 */
const parseableDate = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)), "must be a parseable date or date-time");
export const calendarEventSchema = z.object({
  id: z.string().min(1),
  calendarId: z.string().min(1),
  title: z.string(),
  start: parseableDate,
  end: parseableDate,
  allDay: z.boolean(),
  timeZone: z.string(),
  location: z.string(),
  description: z.string(),
  attendees: z.array(z.string()),
});
export type CalendarEvent = z.infer<typeof calendarEventSchema>;
export const calendarRangeSchema = z
  .object({
    timeMin: z.iso.datetime({ offset: true }),
    timeMax: z.iso.datetime({ offset: true }),
  })
  .refine(({ timeMin, timeMax }) => {
    const duration = Date.parse(timeMax) - Date.parse(timeMin);
    return duration > 0 && duration <= 366 * 86400000;
  }, "Calendar range must end after it starts and span at most 366 days");
export interface Artifact {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  pageCount: number;
  url: string;
  createdAt: string;
  source: string;
  parentId?: string;
  fields?: { name: string; value: string; type: "text" | "checkbox" | "unsupported" }[];
}
export interface BrowserSession {
  id: string;
  title: string;
  url: string;
  status: "idle" | "active" | "closed" | "error";
  updatedAt: string;
  previewUrl?: string;
  consoleUrl?: string;
}
// Invisible characters that reorder or hide text without showing on the review card. Joiners
// (ZWJ/ZWNJ) and directional marks (LRM/RLM) stay because emoji sequences, Persian and Arabic
// text depend on them; directional embeddings, overrides, and isolates are stripped — they
// reorder text, which is what this filter exists to prevent.
const hiddenText = /[\u200B\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
const visibleText = () => z.string().overwrite((text) => text.replace(hiddenText, ""));
export const emailDraftSchema = z.object({
  to: z.array(z.email()).min(1).max(50),
  cc: z.array(z.email()).max(50).default([]),
  bcc: z.array(z.email()).max(50).default([]),
  subject: visibleText()
    .trim()
    .min(1)
    .max(998)
    .refine((s) => !/[\r\n]/.test(s), "Subject must be a single line"),
  body: visibleText().min(1).max(100000),
  attachmentIds: z.array(z.string()).max(10).default([]),
  threadId: z.string().optional(),
  replyToMessageId: z.string().optional(),
});
export const eventDraftSchema = z
  .object({
    calendarId: z.string().default("primary"),
    title: visibleText().trim().min(1).max(500),
    start: z.string().min(1),
    end: z.string().min(1),
    allDay: z.boolean().default(false),
    // Required: there is no user-configured time zone anywhere in the app,
    // so silently defaulting to America/Los_Angeles put events in the wrong
    // zone. Callers must supply the IANA name (the model is told to ask when
    // it does not know it). Breaking change, flagged in the S-B7 review.
    timeZone: z.string().min(1),
    location: visibleText().max(2000).default(""),
    description: visibleText().max(10000).default(""),
    attendees: z.array(z.email()).max(50).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      !Number.isFinite(Date.parse(value.start)) ||
      !Number.isFinite(Date.parse(value.end)) ||
      Date.parse(value.end) <= Date.parse(value.start)
    ) {
      ctx.addIssue({ code: "custom", message: "End must be after a valid start", path: ["end"] });
    }
    const dateOnly = z.iso.date();
    const timed = z.union([
      z.iso.datetime({ offset: true }),
      z.iso.datetime({ offset: true, precision: -1 }),
    ]);
    // Keep minute precision while validating the clock time as well as the date.
    const validTimestamp = (timestamp: string) =>
      value.allDay ? dateOnly.safeParse(timestamp).success : timed.safeParse(timestamp).success;
    if (!validTimestamp(value.start) || !validTimestamp(value.end)) {
      ctx.addIssue({
        code: "custom",
        message: value.allDay
          ? "All-day events need valid date-only values"
          : "Timed events need valid date-times with an explicit offset",
        path: ["start"],
      });
    }
    try {
      new Intl.DateTimeFormat("en", { timeZone: value.timeZone });
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid time zone", path: ["timeZone"] });
    }
  });
export const proposalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email.send"), data: emailDraftSchema }),
  z.object({ kind: z.literal("calendar.create"), data: eventDraftSchema }),
  z.object({
    kind: z.literal("calendar.update"),
    data: eventDraftSchema.and(z.object({ eventId: z.string().min(1) })),
  }),
  z.object({
    kind: z.literal("calendar.delete"),
    data: z.object({
      calendarId: z.string().min(1),
      eventId: z.string().min(1),
      title: z.string().min(1),
    }),
  }),
]);
export type EmailDraft = z.infer<typeof emailDraftSchema>;
export type EventDraft = z.infer<typeof eventDraftSchema>;
export type ProposalInput = z.infer<typeof proposalSchema>;
export type ActionProposal = {
  target?: CalendarEvent;
  targetVersion?: string;
  taskId?: string;
  account?: string;
  connectionId?: string;
  id: string;
  title: string;
  status:
    | "awaiting_review"
    | "executing"
    | "succeeded"
    | "failed"
    | "outcome_unknown"
    | "denied"
    | "cancelled"
    | "expired";
  hash: string;
  createdAt: string;
  expiresAt: string;
  result?: string;
  error?: string;
} & ProposalInput;
export interface ActivityEntry {
  id: string;
  title: string;
  detail: string;
  date: string;
  status: string;
  actionId?: string;
}
export interface Connection {
  id: string;
  name: string;
  status: "connected" | "disconnected" | "sample" | "unconfigured" | "unavailable";
  account?: string;
  capabilities: string[];
}
export interface Workspace {
  mode: WorkspaceMode;
  profile: { name: string; email: string };
  mail: Mail[];
  events: CalendarEvent[];
  files: Artifact[];
  browsers: BrowserSession[];
  actions: ActionProposal[];
  activity: ActivityEntry[];
  connections: Connection[];
  runtime: {
    provider: "sample" | "model" | "openbot";
    configured: boolean;
    openbotConfigured: boolean;
    richThreads?: boolean;
  };
}

/** Provider-independent boundary: OpenBot/AG-UI runs never dictate presentation. */
export interface ExecutionBackend {
  readonly kind: "standalone" | "openbot";
  readonly capabilities: readonly string[];
  health(): Promise<{ available: boolean; detail: string }>;
}

export type { ComputerCommand, ComputerDirectory, ComputerSnapshot } from "./computer.ts";
