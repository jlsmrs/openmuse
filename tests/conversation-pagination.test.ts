// S-B1: chat reads must page instead of silently truncating — search_mail
// past 100 matches, read_mail_thread past the newest 20, and Jev evidence
// noted only for the page actually returned.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { EventType, type RunAgentInput } from "@ag-ui/core";
import { lastValueFrom, toArray } from "rxjs";
import { createApp } from "../apps/server/src/app.ts";
import { ConversationAgent } from "../apps/server/src/engine/conversation.ts";
import type { Mail } from "../packages/domain/src/index.ts";
import { browserFixture } from "./helpers/browser.ts";
import { modelFixture } from "./helpers/model.ts";

function runInput(threadId = "pagination-chat"): RunAgentInput {
  return {
    threadId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: "user", content: "Check the mail" }],
    tools: [],
    context: [],
    state: {},
  };
}

async function fixture(
  t: TestContext,
  calls: Array<{ name: string; arguments: object } | undefined>,
  jevMode: "sample" | "off" = "off",
) {
  await modelFixture(t, (index) => calls[index]);
  const browser = await browserFixture(t, () => {
    throw new Error("Pagination reads must not use the browser");
  });
  const config = {
    ...browser.config,
    agentBackend: "model" as const,
    model: "openai/fixture",
    jevMode,
  };
  const server = await createApp(browser.db, config);
  t.after(() => server.agent.stop());
  return {
    ...browser,
    ...server,
    conversation: new ConversationAgent(config, server.agent, "local-user"),
  };
}

async function toolResult(f: Awaited<ReturnType<typeof fixture>>, input: RunAgentInput) {
  const events = await lastValueFrom(f.conversation.run(input).pipe(toArray()));
  const result = events.find((event) => event.type === EventType.TOOL_CALL_RESULT);
  assert.ok(result && result.type === EventType.TOOL_CALL_RESULT);
  return JSON.parse(String(result.content));
}

async function seedMail(
  f: Awaited<ReturnType<typeof fixture>>,
  rows: Array<Partial<Mail> & { id: string }>,
) {
  for (const row of rows) {
    await f.db.put("local-user", "mail", {
      threadId: row.threadId ?? "pagination-thread",
      sender: "Pagination Probe",
      from: "probe@example.com",
      to: ["alex@example.com"],
      subject: "Pagination probe",
      body: "pagination",
      date: "2026-11-01T10:00:00Z",
      unread: false,
      label: "Test",
      attachments: [],
      ...row,
    });
  }
}

test("search_mail returns the first 100 matches with a page token for the rest", async (t) => {
  const f = await fixture(t, [{ name: "search_mail", arguments: { query: "pagination" } }]);
  await f.workspace.ensureSample("local-user", f.actions);
  await seedMail(
    f,
    Array.from({ length: 150 }, (_, i) => ({
      id: `page-mail-${i + 1}`,
      subject: `Pagination probe ${i + 1}`,
      date: `2026-11-01T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
    })),
  );
  const page = await toolResult(f, runInput());
  assert.equal(page.matches.length, 100);
  assert.equal(page.truncated, true);
  assert.equal(page.nextPageToken, "100");
});

test("search_mail with the page token returns the remaining matches", async (t) => {
  const f = await fixture(t, [
    { name: "search_mail", arguments: { query: "pagination", pageToken: "100" } },
  ]);
  await f.workspace.ensureSample("local-user", f.actions);
  await seedMail(
    f,
    Array.from({ length: 150 }, (_, i) => ({
      id: `page-mail-${i + 1}`,
      subject: `Pagination probe ${i + 1}`,
    })),
  );
  const page = await toolResult(f, runInput());
  assert.equal(page.matches.length, 50);
  assert.equal(page.truncated, false);
  assert.equal(page.nextPageToken, undefined);
});

test("read_mail_thread offset returns older messages with the total", async (t) => {
  const f = await fixture(t, [
    { name: "read_mail_thread", arguments: { threadId: "long-thread" } },
    undefined,
    { name: "read_mail_thread", arguments: { threadId: "long-thread", offset: 20 } },
    undefined,
  ]);
  await f.workspace.ensureSample("local-user", f.actions);
  await seedMail(
    f,
    Array.from({ length: 25 }, (_, i) => ({
      id: `long-${String(i + 1).padStart(2, "0")}`,
      threadId: "long-thread",
      subject: `Long thread ${i + 1}`,
      body: `Message ${i + 1}`,
      date: `2026-11-01T${String(i).padStart(2, "0")}:00:00Z`,
    })),
  );
  const newest = await toolResult(f, runInput());
  assert.equal(newest.messages.length, 20);
  assert.equal(newest.messages[0].id, "long-06");
  assert.equal(newest.messages.at(-1)?.id, "long-25");
  assert.equal(newest.total, 25);
  assert.equal(newest.offset, 0);
  assert.equal(newest.truncated, true);
  const older = await toolResult(f, runInput());
  assert.equal(older.messages.length, 5);
  assert.equal(older.messages[0].id, "long-01");
  assert.equal(older.messages.at(-1)?.id, "long-05");
  assert.equal(older.offset, 20);
  assert.equal(older.truncated, false);
});

test("jev evidence is noted for the returned page and not for an empty page", async (t) => {
  const f = await fixture(
    t,
    [
      { name: "read_mail_thread", arguments: { threadId: "long-thread" } },
      undefined,
      { name: "read_mail_thread", arguments: { threadId: "long-thread", offset: 100 } },
      undefined,
    ],
    "sample",
  );
  await f.workspace.ensureSample("local-user", f.actions);
  await seedMail(
    f,
    Array.from({ length: 25 }, (_, i) => ({
      id: `long-${String(i + 1).padStart(2, "0")}`,
      threadId: "long-thread",
      subject: `Long thread ${i + 1}`,
      body: `Message ${i + 1}`,
      date: `2026-11-01T${String(i).padStart(2, "0")}:00:00Z`,
    })),
  );
  const first = runInput("jev-page-chat");
  const firstRunId = first.runId;
  const page = await toolResult(f, first);
  assert.equal(page.messages.length, 20);
  assert.ok(await f.db.get("local-user", "jev_mail_evidence", `jev-page-chat:${firstRunId}`));
  const second = runInput("jev-page-chat");
  const secondRunId = second.runId;
  const empty = await toolResult(f, second);
  assert.equal(empty.messages.length, 0);
  assert.equal(
    await f.db.get("local-user", "jev_mail_evidence", `jev-page-chat:${secondRunId}`),
    null,
  );
});

test("client tools other than open_workspace are logged instead of dropped silently", async (t) => {
  const warned = t.mock.method(console, "warn", () => {});
  const f = await fixture(t, [undefined]);
  await f.workspace.ensureSample("local-user", f.actions);
  const input = runInput();
  input.tools = [
    {
      name: "custom_tool",
      description: "A client tool the chat agent does not receive",
      parameters: { type: "object", properties: {} },
    } as never,
  ];
  const events = await lastValueFrom(f.conversation.run(input).pipe(toArray()));
  assert.equal(events.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(warned.mock.callCount(), 1);
  const [entry] = warned.mock.calls[0].arguments as [Record<string, unknown>];
  assert.deepEqual((entry.context as { droppedTools: string[] }).droppedTools, ["custom_tool"]);
});
