import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  browserWorkerUrl,
  MAX_STANDING_INSTRUCTIONS_CHARS,
  readConfig,
  shadowedEnvKeys,
} from "../apps/server/src/config.ts";

const missingKeyMessage =
  "OpenMuse requires CPK_INTELLIGENCE_API_KEY. " +
  "Run `npx copilotkit@latest login` and `npx copilotkit@latest project select`, " +
  "then set the generated server-only key. " +
  "See https://docs.copilotkit.ai/intelligence/connect-your-runtime";

// S-B3: the Intelligence key is always required — readConfig enforces it in
// every mode, and the Config type says so (the old deferred assertion is
// gone; the requirement lives in one place now).
test("every mode rejects a missing or blank Intelligence key at startup", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.AGENT_BACKEND = "sample";
  process.env.HOST = "127.0.0.1";
  for (const key of [undefined, "", " \t\n"]) {
    if (key === undefined) delete process.env.CPK_INTELLIGENCE_API_KEY;
    else process.env.CPK_INTELLIGENCE_API_KEY = key;
    assert.throws(() => readConfig(), { name: "Error", message: missingKeyMessage });
  }
});

test("every mode accepts a non-empty Intelligence key at startup", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  for (const mode of ["sample", "live"]) {
    process.env.WORKSPACE_MODE = mode;
    process.env.AGENT_BACKEND = mode === "live" ? "model" : "sample";
    process.env.HOST = "127.0.0.1";
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    if (mode === "live") {
      process.env.OPENMUSE_ACCESS_KEY = "test-access-key-24-chars!!";
      process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
    }
    assert.equal(readConfig().intelligenceApiKey, "test-project-key-never-sent");
  }
});

test("web search is enabled by default with an explicit opt-out", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.AGENT_BACKEND = "model";
  process.env.HOST = "127.0.0.1";
  process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
  delete process.env.WEB_SEARCH_ENABLED;
  assert.equal(readConfig().webSearchEnabled, true);
  for (const value of ["true", "", "1", "TRUE"]) {
    process.env.WEB_SEARCH_ENABLED = value;
    assert.equal(readConfig().webSearchEnabled, true);
  }
  process.env.WEB_SEARCH_ENABLED = "false";
  assert.equal(readConfig().webSearchEnabled, false);
});

test("Jev mode is off by default and validates explicit modes", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const old = {
    JEV_MODE: process.env.JEV_MODE,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    CPK_INTELLIGENCE_API_KEY: process.env.CPK_INTELLIGENCE_API_KEY,
  };
  try {
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    delete process.env.JEV_MODE;
    assert.equal(readConfig().jevMode, "off");
    process.env.JEV_MODE = "sample";
    assert.equal(readConfig().jevMode, "sample");
    process.env.JEV_MODE = "live";
    delete process.env.TYPESAFE_API_KEY;
    assert.throws(() => readConfig(), /TYPESAFE_API_KEY/);
    process.env.TYPESAFE_API_KEY = "fixture-key";
    assert.equal(readConfig().typesafeApiKey, "fixture-key");
    process.env.JEV_MODE = "invalid";
    assert.throws(() => readConfig(), /JEV_MODE/);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("browser worker URL keeps an existing scheme and adds http to host:port", (t) => {
  assert.equal(browserWorkerUrl(undefined), undefined);
  assert.equal(browserWorkerUrl("  "), undefined);
  assert.equal(browserWorkerUrl("http://127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(browserWorkerUrl("https://browser.internal:8790"), "https://browser.internal:8790");
  // A bare non-loopback host:port still upgrades to http (internal workers
  // are addressed that way), but it must warn loudly instead of silently.
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  assert.equal(browserWorkerUrl("openmuse-browser-h4fx:8790"), "http://openmuse-browser-h4fx:8790");
  assert.equal(warnings.length, 1);
  assert.match(
    String(warnings[0][0]),
    /BROWSER_WORKER_URL "openmuse-browser-h4fx:8790" has no scheme/,
  );
  warnings.length = 0;
  assert.equal(browserWorkerUrl("127.0.0.1:8790"), "http://127.0.0.1:8790");
  assert.equal(warnings.length, 0, "loopback upgrades stay quiet");
});

test("environment variables that override a different .env value are reported by name", () => {
  const file = { OPENAI_API_KEY: "sk-or-file", MODEL: "openai/gpt-5", PORT: "8787", EMPTY: "" };
  const env = { OPENAI_API_KEY: "sk-proj-system", MODEL: "openai/gpt-5", EMPTY: "set" };
  assert.deepEqual(shadowedEnvKeys(file, env), ["OPENAI_API_KEY", "EMPTY"]);
  assert.deepEqual(shadowedEnvKeys(file, {}), []);
});

test("computer provider defaults to Docker and e2b-desktop requires a server-side key", async () => {
  const { readConfig } = await import("../apps/server/src/config.ts");
  const keys = [
    "COMPUTER_PROVIDER",
    "COMPUTER_ENABLED",
    "E2B_API_KEY",
    "COMPUTER_E2B_TEMPLATE",
    "COMPUTER_DEPLOYMENT_ID",
    "CPK_INTELLIGENCE_API_KEY",
  ];
  const old = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
    for (const key of keys.slice(0, 5)) delete process.env[key];
    assert.equal(readConfig().computerProvider, "docker");
    process.env.COMPUTER_DEPLOYMENT_ID = " ";
    assert.equal(readConfig().computerDeploymentId, undefined);
    delete process.env.COMPUTER_DEPLOYMENT_ID;
    process.env.COMPUTER_PROVIDER = "k8s";
    assert.throws(() => readConfig(), /COMPUTER_PROVIDER/);
    process.env.COMPUTER_PROVIDER = "e2b-desktop";
    process.env.COMPUTER_ENABLED = "true";
    process.env.E2B_API_KEY = " ";
    assert.throws(() => readConfig(), /E2B_API_KEY/);
    process.env.E2B_API_KEY = "fixture-key";
    // A team-wide sandbox namespace needs an explicit, unique deployment id.
    assert.throws(() => readConfig(), /COMPUTER_DEPLOYMENT_ID/);
    process.env.COMPUTER_DEPLOYMENT_ID = "fixture-deployment";
    const config = readConfig();
    assert.equal(config.computerProvider, "e2b-desktop");
    assert.equal(config.computerE2bTemplate, "desktop");
    assert.equal(config.e2bApiKey, "fixture-key");
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

// S-B2: standing instructions are appended verbatim to every chat prompt, so
// an oversized value gets a startup warning instead of silently taxing
// every reply.
test("oversized standing instructions warn at startup; a sane size stays quiet", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.AGENT_BACKEND = "sample";
  process.env.HOST = "127.0.0.1";
  process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args);
  });
  process.env.OPENMUSE_INSTRUCTIONS = "x".repeat(MAX_STANDING_INSTRUCTIONS_CHARS + 1);
  readConfig();
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /OPENMUSE_INSTRUCTIONS is 10001 characters/);
  assert.match(String(warnings[0][0]), /appended verbatim to every chat prompt/);
  warnings.length = 0;
  process.env.OPENMUSE_INSTRUCTIONS = "x".repeat(MAX_STANDING_INSTRUCTIONS_CHARS);
  readConfig();
  assert.equal(warnings.length, 0);
  delete process.env.OPENMUSE_INSTRUCTIONS;
  readConfig();
  assert.equal(warnings.length, 0);
});

// S-B4 item 11: PORT is validated and fails fast instead of silently
// producing NaN or an out-of-range port.
test("PORT must be a valid integer port", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.AGENT_BACKEND = "sample";
  process.env.HOST = "127.0.0.1";
  process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
  for (const bad of ["0", "65536", "abc", "1.5", "-1", ""]) {
    process.env.PORT = bad;
    assert.throws(() => readConfig(), { message: /PORT must be an integer between 1 and 65535/ });
  }
  process.env.PORT = "8080";
  assert.equal(readConfig().port, 8080);
  delete process.env.PORT;
  assert.equal(readConfig().port, 8787);
});

// S-B4 item 12: a trailing slash on the public URL does not double the
// Google redirect path.
test("a trailing slash on the public URL does not double the redirect path", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.AGENT_BACKEND = "sample";
  process.env.HOST = "127.0.0.1";
  process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
  process.env.PUBLIC_API_URL = "https://example.com/";
  assert.equal(readConfig().googleRedirectUri, "https://example.com/api/google/callback");
  process.env.PUBLIC_API_URL = "https://example.com///";
  assert.equal(readConfig().googleRedirectUri, "https://example.com/api/google/callback");
});

// S-B4 item 13: ALLOWED_ORIGINS entries are trimmed and empty entries dropped.
test("ALLOWED_ORIGINS entries are trimmed and empty entries dropped", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "sample";
  process.env.AGENT_BACKEND = "sample";
  process.env.HOST = "127.0.0.1";
  process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
  process.env.ALLOWED_ORIGINS = " https://a.example , ,https://b.example ";
  assert.deepEqual(readConfig().allowedOrigins, ["https://a.example", "https://b.example"]);
});

// S-B4 item 14: live mode enforces the 32-byte base64 encryption key its
// error message claims, instead of only checking presence.
test("live mode rejects an encryption key that is not 32-byte base64", (t) => {
  const previous = { ...process.env };
  t.after(() => {
    process.env = previous;
  });
  process.env.WORKSPACE_MODE = "live";
  process.env.AGENT_BACKEND = "model";
  process.env.HOST = "127.0.0.1";
  process.env.CPK_INTELLIGENCE_API_KEY = "test-project-key-never-sent";
  process.env.OPENMUSE_ACCESS_KEY = "test-access-key-24-chars!!";
  for (const bad of ["short", Buffer.alloc(16).toString("base64"), "not-base64!!!"]) {
    process.env.TOKEN_ENCRYPTION_KEY = bad;
    assert.throws(() => readConfig(), { message: /32-byte base64/ });
  }
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32).toString("base64");
  assert.equal(readConfig().mode, "live");
});

// S-B4 item 10: the .env path is resolved from the server file, not the
// process working directory — a .env in the CWD must not be picked up.
test("the .env path is resolved from the server file, not the working directory", async (t) => {
  const { resolveDotEnvPath } = await import("../apps/server/src/config.ts");
  const directory = await mkdtemp(join(tmpdir(), "openmuse-dotenv-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, ".env"), "CPK_INTELLIGENCE_API_KEY=from-cwd\n");
  const previousCwd = process.cwd();
  process.chdir(directory);
  t.after(() => process.chdir(previousCwd));
  assert.equal(resolveDotEnvPath(), undefined);
});
