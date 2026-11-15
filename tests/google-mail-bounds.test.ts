// M-B7 / audit M7: mail listing must bound concurrency, enforce an overall
// deadline, and back off on quota — instead of firing up to 100 Gmail
// requests in parallel with no limit or deadline.
import assert from "node:assert/strict";
import test from "node:test";
import { emailDraftSchema } from "../packages/domain/src/index.ts";
import { GoogleApiError, GoogleClient } from "../packages/integrations/src/google.ts";

function clientWith(
  handler: (request: Request) => Response | Promise<Response>,
  options: { mailListDeadlineMs?: number } = {},
) {
  return new GoogleClient({
    getAccessToken: async () => "synthetic-access-token",
    fetch: async (input, init) => handler(new Request(input, init)),
    ...options,
  });
}
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(data, { status, headers });
const message = (id: string) => ({
  id,
  threadId: "thread1",
  payload: {
    headers: [
      { name: "From", value: "sender@example.com" },
      { name: "Subject", value: `Subject ${id}` },
      { name: "Date", value: "Mon, 10 Nov 2026 10:00:00 -0600" },
    ],
  },
});
const listResponse = (ids: string[]) => ({ messages: ids.map((id) => ({ id })) });
const isMessageFetch = (request: Request) => /\/messages\/[^/?]+\?/.test(request.url);
const email = () =>
  emailDraftSchema.parse({
    to: ["reader@example.com"],
    subject: "Your visit résumé",
    body: "Hello <reader>,\nHere is your form.\nThank you.",
  });

test("mail list fetches run at most 10 at a time and keep list order", async () => {
  const ids = Array.from({ length: 20 }, (_, i) => `msg${i + 1}`);
  let inFlight = 0;
  let maxInFlight = 0;
  const started = Date.now();
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) return json(listResponse(ids));
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return json(message(new URL(request.url).pathname.split("/").pop() ?? ""));
    } finally {
      inFlight--;
    }
  });
  const mail = await client.listMail();
  const elapsed = Date.now() - started;
  // 10 in flight — must match MAIL_LIST_CONCURRENCY in google.ts. The bound
  // is asserted as a literal so this test still loads (and fails) on code
  // without the fix.
  assert.equal(maxInFlight, 10);
  assert.deepEqual(
    mail.map((m) => m.id),
    ids,
  );
  // 20 fetches at 10 in flight take ~2 rounds; serial would take ~800ms.
  assert.ok(elapsed < 400, `list took ${elapsed}ms, expected under 400ms`);
});

test("a slow mail list fails with a clear timeout instead of hanging", async () => {
  const client = clientWith(
    async (request) => {
      if (!isMessageFetch(request)) return json(listResponse(["msg1", "msg2", "msg3"]));
      await new Promise((resolve) => setTimeout(resolve, 300));
      return json(message("msg1"));
    },
    { mailListDeadlineMs: 50 },
  );
  await assert.rejects(client.listMail(), /timed out/);
});

test("a quota response with Retry-After backs off and the read succeeds", async () => {
  let attempts = 0;
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) return json(listResponse(["msg1"]));
    attempts++;
    if (attempts <= 2)
      return json({ error: { message: "Quota exceeded" } }, 429, { "Retry-After": "0" });
    return json(message("msg1"));
  });
  const [mail] = await client.listMail();
  assert.equal(attempts, 3);
  assert.equal(mail.id, "msg1");
});

test("a quota response without Retry-After backs off exponentially and the read succeeds", async () => {
  let attempts = 0;
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) return json(listResponse(["msg1"]));
    attempts++;
    if (attempts <= 2) return json({ error: { message: "Quota exceeded" } }, 429);
    return json(message("msg1"));
  });
  const [mail] = await client.listMail();
  assert.equal(attempts, 3);
  assert.equal(mail.id, "msg1");
});

test("a write is never retried on quota", async () => {
  let sendCalls = 0;
  const client = clientWith(async (request) => {
    if (request.url.endsWith("/profile")) return json({ emailAddress: "sender@example.com" });
    sendCalls++;
    return json({ error: { message: "Quota exceeded" } }, 429);
  });
  await assert.rejects(
    client.sendEmail(email(), []),
    (error: unknown) => error instanceof GoogleApiError && error.status === 429,
  );
  assert.equal(sendCalls, 1);
});

test("mail metadata pages past the first 100 with the provider token", async () => {
  const firstIds = Array.from({ length: 100 }, (_, i) => `page1-${i + 1}`);
  const secondIds = ["page2-1", "page2-2"];
  const listRequests: string[] = [];
  const client = clientWith(async (request) => {
    if (!isMessageFetch(request)) {
      listRequests.push(request.url);
      const token = new URL(request.url).searchParams.get("pageToken");
      return token === "token-2"
        ? json({ messages: secondIds.map((id) => ({ id })) })
        : json({ messages: firstIds.map((id) => ({ id })), nextPageToken: "token-2" });
    }
    return json(message(new URL(request.url).pathname.split("/").pop() ?? ""));
  });
  const first = await client.listMailMetadata();
  assert.equal(first.messages.length, 100);
  assert.equal(first.messages[0].id, "page1-1");
  assert.equal(first.nextPageToken, "token-2");
  assert.equal(first.truncated, true);
  const second = await client.listMailMetadata("in:inbox", first.nextPageToken);
  assert.deepEqual(
    second.messages.map((m) => m.id),
    secondIds,
  );
  assert.equal(second.nextPageToken, undefined);
  assert.equal(second.truncated, false);
  assert.equal(listRequests.length, 2);
  assert.equal(new URL(listRequests[1]).searchParams.get("pageToken"), "token-2");
  // listMail keeps its plain-array shape: only the metadata path pages.
  const plain = await client.listMail();
  assert.equal(plain.length, 100);
});
