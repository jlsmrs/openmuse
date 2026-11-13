// M-B8 / audit M8: one oversized email must not fail the whole mail list —
// the oversized message is isolated to a note row (with its real
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
const isMetadataFetch = (request: Request) => request.url.includes("format=metadata");

const headersFor = (id: string) => [
  { name: "From", value: `sender-${id}@example.com` },
  { name: "Subject", value: `Subject ${id}` },
  { name: "Date", value: "Mon, 10 Nov 2026 10:00:00 -0600" },
];
const textPart = (text: string) => ({
  mimeType: "text/plain",
  body: { data: Buffer.from(text).toString("base64url") },
});
const fullMessage = (id: string, parts: unknown[]) => ({
  id,
  threadId: "thread1",
  snippet: `Snippet ${id}`,
  labelIds: ["INBOX"],
  payload: { mimeType: "multipart/mixed", headers: headersFor(id), parts },
});
const metadataMessage = (id: string, parts: unknown[] = []) => ({
  id,
  threadId: "thread1",
  snippet: `Snippet ${id}`,
  labelIds: ["INBOX"],
  payload: { mimeType: "multipart/mixed", headers: headersFor(id), parts },
});

test("a list with one oversized message returns the rest with a note row", async () => {
  const bigText = "x".repeat(1024 * 1024 + 1);
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) return json(listResponse(["ok1", "big1", "ok2"]));
    const id = new URL(request.url).pathname.split("/").pop() ?? "";
    if (isMetadataFetch(request)) return json(metadataMessage(id));
    if (id === "big1") return json(fullMessage(id, [textPart(bigText)]));
    return json(fullMessage(id, [textPart(`Hello ${id}`)]));
  });
  const mail = await client.listMail();
  assert.deepEqual(
    mail.map((m) => m.id),
    ["ok1", "big1", "ok2"],
  );
  assert.equal(mail[0].body, "Hello ok1");
  assert.equal(mail[2].body, "Hello ok2");
  // The oversized row keeps its real headers and carries a note, not a body.
  assert.equal(mail[1].subject, "Subject big1");
  assert.equal(mail[1].sender, "sender-big1@example.com");
  assert.match(mail[1].body, /exceeds the 1 MiB limit/);
});

test("a message whose parts add up past 1 MiB is isolated the same way", async () => {
  const chunk = "y".repeat(600 * 1024);
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) return json(listResponse(["ok1", "big2"]));
    const id = new URL(request.url).pathname.split("/").pop() ?? "";
    if (isMetadataFetch(request)) return json(metadataMessage(id));
    if (id === "big2") return json(fullMessage(id, [textPart(chunk), textPart(chunk)]));
    return json(fullMessage(id, [textPart(`Hello ${id}`)]));
  });
  const mail = await client.listMail();
  assert.deepEqual(
    mail.map((m) => m.id),
    ["ok1", "big2"],
  );
  assert.equal(mail[0].body, "Hello ok1");
  assert.equal(mail[1].subject, "Subject big2");
  assert.match(mail[1].body, /exceeds the 1 MiB limit/);
});

test("a metadata list isolates an oversized remote text part the same way", async () => {
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) return json(listResponse(["ok1", "big3"]));
    const id = new URL(request.url).pathname.split("/").pop() ?? "";
    if (id === "big3")
      return json(
        metadataMessage(id, [
          {
            mimeType: "text/plain",
            body: { size: 2 * 1024 * 1024, attachmentId: "att1" },
          },
        ]),
      );
    return json(metadataMessage(id));
  });
  const mail = await client.listMailMetadata();
  assert.deepEqual(
    mail.map((m) => m.id),
    ["ok1", "big3"],
  );
  assert.equal(mail[1].subject, "Subject big3");
  assert.match(mail[1].body, /exceeds the 1 MiB limit/);
});

test("a non-oversized message failure still fails the whole list", async () => {
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) return json(listResponse(["ok1", "bad1"]));
    const id = new URL(request.url).pathname.split("/").pop() ?? "";
    if (id === "bad1") return json({ error: { message: "Internal error" } }, 500);
    return json(fullMessage(id, [textPart(`Hello ${id}`)]));
  });
  // Isolation is specific to oversized messages — anything else propagates.
  await assert.rejects(client.listMail(), (error: unknown) => error instanceof Error);
});
