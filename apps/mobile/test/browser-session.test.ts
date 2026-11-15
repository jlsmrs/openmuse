import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserSession } from "../../../packages/domain/src/index.ts";
import { newerBrowserSession } from "../src/browser-session.ts";

function session(overrides: Partial<BrowserSession>): BrowserSession {
  return {
    id: "b-1",
    title: "Example",
    url: "https://example.com",
    status: "active",
    updatedAt: "2026-11-13T10:00:00.000Z",
    ...overrides,
  };
}

test("the newer record wins, console and preview URLs included", () => {
  const local = session({ consoleUrl: "/console/old", previewUrl: "/preview/old" });
  const latest = session({
    updatedAt: "2026-11-13T10:05:00.000Z",
    consoleUrl: "/console/new",
    previewUrl: "/preview/new",
  });
  assert.equal(newerBrowserSession(local, latest), latest);
  assert.equal(newerBrowserSession(local, latest).consoleUrl, "/console/new");
  assert.equal(newerBrowserSession(local, latest).previewUrl, "/preview/new");
});

test("an older workspace copy keeps the local record and its URLs", () => {
  const local = session({ consoleUrl: "/console/local", previewUrl: "/preview/local" });
  const latest = session({
    updatedAt: "2026-11-13T09:55:00.000Z",
    consoleUrl: "/console/stale",
    previewUrl: "/preview/stale",
  });
  assert.equal(newerBrowserSession(local, latest), local);
});

test("no workspace copy, or a tie, keeps the local record", () => {
  const local = session({ consoleUrl: "/console/local" });
  assert.equal(newerBrowserSession(local, undefined), local);
  assert.equal(newerBrowserSession(local, session({ consoleUrl: "/console/tie" })), local);
});
