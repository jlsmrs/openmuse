// S-B2: the agui backend must throw a clear "agent URL not configured" error
// instead of silently pointing at a dead local port.
import assert from "node:assert/strict";
import { test } from "node:test";
import { agentConfigured, aguiAgentUrl } from "../apps/server/src/agent.ts";
import type { Config } from "../apps/server/src/config.ts";

const base: Config = {
  mode: "sample",
  port: 8787,
  host: "127.0.0.1",
  publicUrl: "http://localhost:8787",
  dataDir: ".openmuse",
  agentBackend: "agui",
  intelligenceApiKey: "test-project-key-never-sent",
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

// S-B3: the agent gate needs the key for the configured model's provider, not
// just any provider key — a model/key mismatch fails the gate.
test("agentConfigured checks the key for the model's provider", (t) => {
  const previous = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const modelConfig = (model?: string): Config => ({ ...base, agentBackend: "model", model });
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  assert.equal(agentConfigured(modelConfig("openai/gpt-5")), false);
  process.env.ANTHROPIC_API_KEY = "anthropic-key";
  assert.equal(
    agentConfigured(modelConfig("openai/gpt-5")),
    false,
    "an Anthropic key does not configure an OpenAI model",
  );
  process.env.OPENAI_API_KEY = "openai-key";
  assert.equal(agentConfigured(modelConfig("openai/gpt-5")), true);
  assert.equal(agentConfigured(modelConfig("anthropic/claude-sonnet-4.5")), true);
  assert.equal(agentConfigured(modelConfig("google/gemini-2.5-pro")), false, "no Google key yet");
  process.env.GOOGLE_API_KEY = "google-key";
  assert.equal(agentConfigured(modelConfig("google/gemini-2.5-pro")), true);
  assert.equal(agentConfigured(modelConfig("gemini/gemini-2.5-pro")), true);
  assert.equal(agentConfigured(modelConfig(undefined)), false);
  assert.equal(agentConfigured(modelConfig("unknown/model")), false);
  assert.equal(agentConfigured(modelConfig("gpt-5")), false);
  assert.equal(agentConfigured({ ...base, agentBackend: "sample" }), true);
  assert.equal(agentConfigured({ ...base, agentBackend: "agui", agentUrl: undefined }), false);
  assert.equal(
    agentConfigured({ ...base, agentBackend: "agui", agentUrl: "https://agent.example" }),
    true,
  );
});
