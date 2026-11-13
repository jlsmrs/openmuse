// M-B9 / audit M9: one deeply-nested email must not fail the whole mail list —
// the over-nested message is isolated to a note row (with its real
// sender/subject/date) and the rest of the list comes through.
import assert from "node:assert/strict";
import test from "node:test";
import { GoogleClient } from "../packages/integrations/src/google.ts";

function clientWith(handler: (request: Request) => Response | Promise<Response>) {
  return new GoogleClient({
    getAccessToken: async () => "synthetic-access-token",
    fetch: async (input, init) => handler(new Request(input, init)),
  });
}
const json = (data: unknown, status = 200) => Response.json(data, { status });
const listResponse = (ids: string[]) => ({ messages: ids.map((id) => ({ id })) });
const isMessageFetch = (request: Request) => /\/messages\/[^/?]+\?/.test(request.url);

const headersFor = (id: string) => [
  { name: "From", value: `sender-${id}@example.com` },
  { name: "Subject", value: `Subject ${id}` },
  { name: "Date", value: "Mon, 10 Nov 2026 10:00:00 -0600" },
];
const textPart = (text: string) => ({
  mimeType: "text/plain",
  body: { data: Buffer.from(text).toString("base64url") },
});
// A chain of `levels` nested multipart containers ending in a text part.
// As the payload's child, level 1 sits at depth 1, so nestedPart(31) puts
// a container at depth 31 and throws (>30), while nestedPart(29) tops out
// at depth 30 and maps normally — the boundary of the unchanged limit.
const nestedPart = (levels: number): unknown =>
  levels === 0
    ? textPart("Hello nested")
    : { mimeType: "multipart/mixed", parts: [nestedPart(levels - 1)] };
const fullMessage = (id: string, parts: unknown[]) => ({
  id,
  threadId: "thread1",
  snippet: `Snippet ${id}`,
  labelIds: ["INBOX"],
  payload: { mimeType: "multipart/mixed", headers: headersFor(id), parts },
});

test("a list with one over-nested message returns the rest with a note row", async () => {
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) return json(listResponse(["ok1", "deep1", "ok2"]));
    const id = new URL(request.url).pathname.split("/").pop() ?? "";
    // The note re-fetch is a metadata fetch for the same id and returns the
    // same deep tree; the note path strips the parts to keep the headers.
    if (id === "deep1") return json(fullMessage(id, [nestedPart(31)]));
    return json(fullMessage(id, [textPart(`Hello ${id}`)]));
  });
  const mail = await client.listMail();
  assert.deepEqual(
    mail.map((m) => m.id),
    ["ok1", "deep1", "ok2"],
  );
  assert.equal(mail[0].body, "Hello ok1");
  assert.equal(mail[2].body, "Hello ok2");
  // The over-nested row keeps its real headers and carries a note, not a body.
  assert.equal(mail[1].subject, "Subject deep1");
  assert.equal(mail[1].sender, "sender-deep1@example.com");
  assert.match(mail[1].body, /nested too deeply/);
});

test("a metadata list isolates an over-nested message the same way", async () => {
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) return json(listResponse(["ok1", "deep2"]));
    const id = new URL(request.url).pathname.split("/").pop() ?? "";
    if (id === "deep2") return json(fullMessage(id, [nestedPart(31)]));
    return json(fullMessage(id, [textPart(`Hello ${id}`)]));
  });
  const { messages: mail } = await client.listMailMetadata();
  assert.deepEqual(
    mail.map((m) => m.id),
    ["ok1", "deep2"],
  );
  assert.equal(mail[0].snippet, "Hello ok1");
  assert.equal(mail[1].subject, "Subject deep2");
  assert.match(mail[1].snippet, /nested too deeply/);
});

test("a message nested exactly to the depth limit still maps normally", async () => {
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) return json(listResponse(["ok1", "edge1", "ok2"]));
    const id = new URL(request.url).pathname.split("/").pop() ?? "";
    if (id === "edge1") return json(fullMessage(id, [nestedPart(29)]));
    return json(fullMessage(id, [textPart(`Hello ${id}`)]));
  });
  const mail = await client.listMail();
  assert.deepEqual(
    mail.map((m) => m.id),
    ["ok1", "edge1", "ok2"],
  );
  assert.equal(mail[0].body, "Hello ok1");
  assert.equal(mail[1].body, "Hello nested");
  assert.equal(mail[2].body, "Hello ok2");
});

test("a non-nesting message failure still fails the whole list", async () => {
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) return json(listResponse(["ok1", "bad1"]));
    const id = new URL(request.url).pathname.split("/").pop() ?? "";
    if (id === "bad1") return json({ error: { message: "Internal error" } }, 500);
    return json(fullMessage(id, [textPart(`Hello ${id}`)]));
  });
  // Isolation is specific to over-nested messages — anything else propagates.
  await assert.rejects(client.listMail(), (error: unknown) => error instanceof Error);
});
