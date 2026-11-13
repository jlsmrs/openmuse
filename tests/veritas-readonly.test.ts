// Veritas read-only CRM tools: provider failures come back as the tool's
// normal {error} shape — never as result text, and never as a throw out of
// the tool when the CRM answers with empty or non-JSON content.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  getJobTool,
  searchJobsTool,
  todaysSigningsTool,
} from "../apps/server/src/engine/veritas-readonly.ts";

function stubFetch(t: TestContext, handler: (url: string) => Promise<Response>): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string) => handler(url)) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function setEnv(t: TestContext): void {
  const previous = {
    VERITAS_CRM_BOT_TOKEN: process.env.VERITAS_CRM_BOT_TOKEN,
    VERITAS_CRM_BASE_URL: process.env.VERITAS_CRM_BASE_URL,
  };
  process.env.VERITAS_CRM_BOT_TOKEN = "test-token";
  process.env.VERITAS_CRM_BASE_URL = "https://crm.example.invalid";
  t.after(() => {
    if (previous.VERITAS_CRM_BOT_TOKEN === undefined) delete process.env.VERITAS_CRM_BOT_TOKEN;
    else process.env.VERITAS_CRM_BOT_TOKEN = previous.VERITAS_CRM_BOT_TOKEN;
    if (previous.VERITAS_CRM_BASE_URL === undefined) delete process.env.VERITAS_CRM_BASE_URL;
    else process.env.VERITAS_CRM_BASE_URL = previous.VERITAS_CRM_BASE_URL;
  });
}

type CrmResult = { result?: string; error?: string };

test("a CRM error object is returned as {error}, not wrapped as result text", async (t) => {
  setEnv(t);
  stubFetch(t, async () => Response.json({ jobs: [] }, { status: 401 }));
  assert.ok(todaysSigningsTool.execute);
  const result = (await todaysSigningsTool.execute({})) as CrmResult;
  assert.match(result.error ?? "", /token rejected/);
  assert.equal(result.result, undefined);
});

test("an empty or non-JSON CRM response returns the normal error object", async (t) => {
  setEnv(t);
  let calls = 0;
  stubFetch(t, async () => {
    calls++;
    return calls === 1
      ? new Response("", { status: 200 })
      : new Response("<html>proxy page</html>", { status: 200 });
  });
  assert.ok(searchJobsTool.execute);
  const empty = (await searchJobsTool.execute({ status: "scheduled" })) as CrmResult;
  assert.match(empty.error ?? "", /non-JSON/);
  assert.equal(empty.result, undefined);
  const html = (await searchJobsTool.execute({ status: "scheduled" })) as CrmResult;
  assert.match(html.error ?? "", /non-JSON/);
});

test("the date is encoded in the CRM request URL", async (t) => {
  setEnv(t);
  let seenUrl = "";
  stubFetch(t, async (url) => {
    seenUrl = url;
    return Response.json({ jobs: [] }, { status: 200 });
  });
  assert.ok(todaysSigningsTool.execute);
  await todaysSigningsTool.execute({ date: "2026-11-13 10:00" });
  assert.match(seenUrl, /\/api\/jobs\/today\?date=2026-11-13%2010%3A00/);
});

test("a successful CRM reply still comes back as truncated result text", async (t) => {
  setEnv(t);
  stubFetch(t, async () => Response.json({ id: "job-1", status: "scheduled" }, { status: 200 }));
  assert.ok(getJobTool.execute);
  const result = (await getJobTool.execute({ id: "job-1" })) as CrmResult;
  assert.equal(result.error, undefined);
  assert.match(result.result ?? "", /"id":"job-1"/);
});
