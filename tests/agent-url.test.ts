// S-B2: the agui backend must throw a clear "agent URL not configured" error
// instead of silently pointing at a dead local port.
import assert from "node:assert/strict";
import { test } from "node:test";
import { aguiAgentUrl } from "../apps/server/src/agent.ts";
import type { Config } from "../apps/server/src/config.ts";

const base: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".openmuse",
  agentBackend: "agui",
  googleRedirectUri: "http://localhost:8787/api/google/callback",
  allowedOrigins: ["http://localhost:8081"],
};

test("an unconfigured agui backend throws a clear error instead of using a dead local port", () => {
  assert.throws(() => aguiAgentUrl({ ...base, agentUrl: undefined }), {
    message: "agent URL not configured: set AGENT_URL to use the agui backend",
  });
  assert.throws(() => aguiAgentUrl({ ...base, agentUrl: "   " }), /agent URL not configured/);
  assert.equal(
    aguiAgentUrl({ ...base, agentUrl: "https://agent.example" }),
    "https://agent.example",
  );
});
