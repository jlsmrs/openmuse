// Jev present_choices tool boundary: options alongside a refinement panel
// are rejected (the service silently ignored them); comparison grounding is
// exact excerpts, and a label must appear in every source its option cites,
// not just any one of them.
import assert from "node:assert/strict";
import test from "node:test";
import { presentChoicesParameters, presentChoicesTool } from "../apps/server/src/jev/tools.ts";
import type { JevToolResult } from "../packages/domain/src/jev.ts";

const base = {
  message: "Compare",
  context: "Read exhibit pages",
  title: "Exhibits",
  control: "comparison" as const,
};

const option = (overrides: Record<string, unknown> = {}) => ({
  id: "a",
  label: "Rocky Shore",
  details: ["Touch sea stars"],
  sources: [{ title: "Rocky Shore", url: "https://example.org/rocky" }],
  ...overrides,
});

test("options supplied alongside a refinement panel are rejected", () => {
  assert.throws(
    () =>
      presentChoicesParameters.parse({
        ...base,
        options: [option()],
        refinementPanelId: "previous",
      }),
    /reuses the original options/,
  );
  assert.doesNotThrow(() =>
    presentChoicesParameters.parse({ ...base, options: [], refinementPanelId: "previous" }),
  );
});

function stubJev(texts: Record<string, string | null>) {
  return {
    hasEvidence: async () => true,
    evidenceText: async (
      _owner: string,
      _threadId: string,
      _turnId: string,
      _kind: string,
      url: string,
    ) => texts[url] ?? null,
    candidateSources: async () => [],
    createPanel: async () => ({ panel: { id: "panel-1" } }),
  } as never;
}

function liveTool(texts: Record<string, string | null>) {
  const tool = presentChoicesTool(
    stubJev(texts),
    "owner",
    "thread",
    "turn",
    new AbortController().signal,
    "live",
  );
  assert.ok(tool.execute);
  const execute = tool.execute;
  return {
    execute: async (
      input: Parameters<NonNullable<typeof tool.execute>>[0],
    ): Promise<JevToolResult> => (await execute(input)) as JevToolResult,
  };
}

test("a detail that only matches after normalisation is rejected", async () => {
  // The page says "Touch sea stars" with a capital T; the detail says
  // "touch sea stars". The old normalised check accepted this; the tool
  // description promises exact excerpts, so the exact check must reject it.
  const tool = liveTool({
    "https://example.org/rocky": "Rocky Shore lets visitors Touch sea stars.",
  });
  const result = await tool.execute({
    ...base,
    options: [option({ details: ["touch sea stars"] })],
  });
  assert.equal(result.panel, null);
  assert.match(result.error ?? "", /detail.*source text/);
});

test("a label present in only one of its sources is rejected", async () => {
  const tool = liveTool({
    "https://example.org/rocky": "Rocky Shore lets visitors Touch sea stars.",
    "https://example.org/kelp": "Kelp Forest with sardines and Touch sea stars.",
  });
  const result = await tool.execute({
    ...base,
    options: [
      option({
        sources: [
          { title: "Rocky Shore", url: "https://example.org/rocky" },
          { title: "Kelp Forest", url: "https://example.org/kelp" },
        ],
      }),
    ],
  });
  assert.equal(result.panel, null);
  assert.match(result.error ?? "", /label.*source text/);
});

test("a label present in every cited source passes grounding", async () => {
  const tool = liveTool({
    "https://example.org/rocky": "Rocky Shore lets visitors Touch sea stars.",
    "https://example.org/kelp": "Kelp Forest and Rocky Shore share Touch sea stars.",
  });
  const result = await tool.execute({
    ...base,
    options: [
      option({
        sources: [
          { title: "Rocky Shore", url: "https://example.org/rocky" },
          { title: "Kelp Forest", url: "https://example.org/kelp" },
        ],
      }),
    ],
  });
  assert.equal(result.error, undefined);
  assert.equal(result.panel?.id, "panel-1");
});
