// S-B9: sample-mode mail search matches the live path — an empty query means
// the inbox, `in:inbox` is an operator rather than a literal word, and the
// snapshot filter covers the same fields as searchMail.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { browserFixture } from "./helpers/browser.ts";

async function fixture(t: TestContext) {
  const browser = await browserFixture(t, () => ({ data: {} }));
  const server = await createApp(browser.db, browser.config);
  t.after(() => server.agent.stop());
  await server.workspace.ensureSample("local-user", server.actions);
  return { ...browser, ...server };
}

test("sample searchMail treats in:inbox as the inbox, not a literal word", async (t) => {
  const f = await fixture(t);
  const inbox = await f.workspace.searchMail("local-user", "in:inbox");
  assert.equal(inbox.length, 4);
  assert.deepEqual(inbox.map((mail) => mail.id).sort(), [
    "mail-design",
    "mail-fieldtrip",
    "mail-stay",
    "mail-studio",
  ]);
  assert.equal((await f.workspace.searchMail("local-user", "")).length, 4);
  assert.deepEqual(
    (await f.workspace.searchMail("local-user", "in:inbox aquarium")).map((mail) => mail.id),
    ["mail-fieldtrip"],
  );
});

test("sample searchMailMetadata returns inbox rows with no body", async (t) => {
  const f = await fixture(t);
  const page = await f.workspace.searchMailMetadata("local-user", "in:inbox");
  assert.equal(page.messages.length, 4);
  assert.ok(page.messages.every((row) => !("body" in row)));
  const aquarium = await f.workspace.searchMailMetadata("local-user", "in:inbox aquarium");
  assert.deepEqual(
    aquarium.messages.map((row) => row.threadId),
    ["trip-thread"],
  );
  assert.equal(aquarium.truncated, false);
});

test("sample searchMail keeps Sent mail out of the inbox", async (t) => {
  const f = await fixture(t);
  await f.db.put("local-user", "mail", {
    id: "mail-sent",
    threadId: "sent-thread",
    sender: "You",
    from: "alex@example.com",
    to: ["jamie@example.com"],
    subject: "Re: Coffee and a catch-up?",
    body: "See you Thursday.",
    date: new Date().toISOString(),
    unread: false,
    label: "Sent · local",
    attachments: [],
  });
  assert.equal((await f.workspace.searchMail("local-user", "in:inbox")).length, 4);
  assert.equal((await f.workspace.searchMail("local-user", "")).length, 4);
});

test("sample snapshot filtering matches on the from field too", async (t) => {
  const f = await fixture(t);
  const byFrom = await f.workspace.snapshot("local-user", "office@lincoln.example");
  assert.deepEqual(
    byFrom.mail.map((mail) => mail.id),
    ["mail-fieldtrip"],
  );
  const bySender = await f.workspace.snapshot("local-user", "Jamie Chen");
  assert.deepEqual(
    bySender.mail.map((mail) => mail.id),
    ["mail-design"],
  );
});
