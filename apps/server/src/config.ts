import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { isValidEncryptionKey } from "../../../packages/integrations/src/vault.ts";

/** .env keys whose file value loses to a different value already set in the environment. */
export function shadowedEnvKeys(
  file: Record<string, string | undefined>,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return Object.keys(file).filter((key) => env[key] !== undefined && env[key] !== file[key]);
}

/**
 * The .env file lives at the repo root, not relative to the process working
 * directory — which depends on how the server was launched and silently
 * yields no config when it is wrong. In source this file sits at
 * apps/server/src (two levels below the root); in the built image it sits
 * at dist/apps/server/src (three). Returns undefined when no .env exists,
 * which is normal in production where config comes from the environment.
 */
export function resolveDotEnvPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(here, "..", "..", ".env"),
    resolve(here, "..", "..", "..", ".env"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const envPath = resolveDotEnvPath();
if (envPath) {
  // loadEnvFile never overrides existing variables. A stale shell or system-wide value
  // (for example OPENAI_API_KEY) would otherwise silently replace the .env setting.
  const shadowed = shadowedEnvKeys(parseEnv(readFileSync(envPath, "utf8")));
  process.loadEnvFile(envPath);
  if (shadowed.length)
    console.warn(
      `[OpenMuse] Using ${shadowed.join(", ")} from the environment instead of .env. ` +
        (shadowed.length === 1
          ? "Unset it to use the .env value."
          : "Unset them to use the .env values."),
    );
}
export interface Config {
  mode: "sample" | "live";
  port: number;
  host: string;
  publicUrl: string;
  dataDir: string;
  databaseUrl?: string;
  accessKey?: string;
  encryptionKey?: string;
  model?: string;
  jevMode?: "off" | "sample" | "live";
  typesafeApiKey?: string;
  jevModel?: string;
  agentBackend: "sample" | "model" | "agui";
  agentUrl?: string;
  agentToken?: string;
  /**
   * CopilotKit Intelligence key. Always required: readConfig throws without
   * it and every API mode needs it at startup (the runtime is built in
   * createApp), so it is typed as required rather than optional.
   */
  intelligenceApiKey: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri: string;
  workerUrl?: string;
  workerToken?: string;
  /**
   * PEM of the private CA that signed the worker certificate (G3, Render
   * only). Unused for plain-http workers, and unused for https workers
   * whose TLS is terminated by the platform (live Azure): with no CA set,
   * the API trusts the system roots, which is what verifies Azure's
   * platform certificate.
   */
  workerTlsCa?: string;
  taskWorkerEnabled?: boolean;
  webSearchEnabled?: boolean;
  computerEnabled?: boolean;
  computerImage?: string;
  computerDeploymentId?: string;
  computerProvider?: ComputerProvider;
  computerE2bTemplate?: string;
  e2bApiKey?: string;
  allowedOrigins: string[];
  trustProxy?: boolean;
}

export type ComputerProvider = "docker" | "e2b-desktop";

/** Pinned so live rankings do not shift when TypeSafe moves the `jev-latest` alias. */
export const defaultJevModel = "jev-1.13.0";

export const intelligenceKeyRequiredMessage =
  "OpenMuse requires CPK_INTELLIGENCE_API_KEY. " +
  "Run `npx copilotkit@latest login` and `npx copilotkit@latest project select`, " +
  "then set the generated server-only key. " +
  "See https://docs.copilotkit.ai/intelligence/connect-your-runtime";

export function required(name: string, message: string, value = process.env[name]): string {
  if (!value?.trim()) throw new Error(message);
  return value.trim();
}

/** Accept a full worker URL, or host:port from a platform that omits the scheme. */
export function browserWorkerUrl(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes("://")) return trimmed;
  // A bare host:port is silently upgraded to plain http below. That is fine
  // for loopback development, but a non-loopback worker would then carry its
  // token in cleartext — warn loudly so the missing scheme is a deliberate
  // choice, not a silent default. The upgrade itself is kept: internal
  // container-app workers are addressed by bare host:port in production.
  const host = trimmed.split(":")[0]?.toLowerCase() ?? "";
  if (host !== "localhost" && host !== "::1" && !host.startsWith("127."))
    console.warn(
      `[OpenMuse] BROWSER_WORKER_URL "${trimmed}" has no scheme; assuming http://${trimmed}. ` +
        `Set an explicit scheme (e.g. https://...) for a non-loopback worker.`,
    );
  return `http://${trimmed}`;
}

// Provider SDKs retry transient failures before the response starts, with
// exponential backoff: OpenAI and Anthropic retry HTTP 408, 409, 429, 5xx and
// connection errors and honor retry-after; Gemini retries 408, 429, 500, 502,
// 503 and 504. Other 4xx responses such as 400, 401 and 403 fail on the first
// attempt, and a stream that fails after it starts is not retried. External
// writes never re-fire here: they are dispatched outside the model loop through
// reviewed, idempotency-keyed actions.
export const MODEL_MAX_RETRIES = 2;

/**
 * Standing instructions over this size get a startup warning; they are
 * appended verbatim to every chat prompt, so an oversized value silently
 * taxes every reply. 10,000 stays above the ~8,700-character value live
 * today, so the warning fires only on genuinely large values.
 */
export const MAX_STANDING_INSTRUCTIONS_CHARS = 10000;
export function readConfig(): Config {
  const mode = process.env.WORKSPACE_MODE ?? "sample";
  if (mode !== "sample" && mode !== "live")
    throw new Error("WORKSPACE_MODE must be sample or live");
  const backend = process.env.AGENT_BACKEND ?? (mode === "sample" ? "sample" : "model");
  if (backend !== "sample" && backend !== "model" && backend !== "agui")
    throw new Error("AGENT_BACKEND must be sample, model or agui");
  if (mode === "live" && backend === "sample")
    throw new Error("Live workspaces cannot use the sample agent");
  const jevMode = process.env.JEV_MODE ?? "off";
  if (jevMode !== "off" && jevMode !== "sample" && jevMode !== "live")
    throw new Error("JEV_MODE must be off, sample or live");
  const typesafeApiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (jevMode === "live" && !typesafeApiKey)
    throw new Error("JEV_MODE=live requires a nonblank TYPESAFE_API_KEY");
  const computerProvider = process.env.COMPUTER_PROVIDER?.trim() || "docker";
  if (computerProvider !== "docker" && computerProvider !== "e2b-desktop")
    throw new Error("COMPUTER_PROVIDER must be docker or e2b-desktop");
  const e2bApiKey = process.env.E2B_API_KEY?.trim();
  if (process.env.COMPUTER_ENABLED === "true" && computerProvider === "e2b-desktop") {
    if (!e2bApiKey)
      throw new Error("COMPUTER_PROVIDER=e2b-desktop requires a nonblank E2B_API_KEY");
    // Sandboxes are matched by metadata across the whole E2B team, and every default
    // install would otherwise derive the same deployment label from localhost:8787.
    if (!process.env.COMPUTER_DEPLOYMENT_ID?.trim())
      throw new Error(
        "COMPUTER_PROVIDER=e2b-desktop requires a unique COMPUTER_DEPLOYMENT_ID, e.g. from `openssl rand -hex 12`",
      );
  }
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535");
  const publicUrl = process.env.PUBLIC_API_URL ?? `http://localhost:${port}`;
  const config: Config = {
    mode,
    port,
    host: process.env.HOST ?? "127.0.0.1",
    publicUrl,
    dataDir: resolve(process.env.DATA_DIR ?? ".openmuse"),
    databaseUrl: process.env.DATABASE_URL,
    accessKey: process.env.OPENMUSE_ACCESS_KEY,
    encryptionKey: process.env.TOKEN_ENCRYPTION_KEY,
    model: process.env.MODEL,
    jevMode,
    typesafeApiKey,
    jevModel: process.env.JEV_MODEL?.trim() || defaultJevModel,
    agentBackend: backend,
    agentUrl: process.env.AGENT_URL,
    agentToken: process.env.AGENT_TOKEN,
    intelligenceApiKey: required("CPK_INTELLIGENCE_API_KEY", intelligenceKeyRequiredMessage),
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: `${publicUrl.replace(/\/+$/, "")}/api/google/callback`,
    workerUrl: browserWorkerUrl(process.env.BROWSER_WORKER_URL),
    workerToken: process.env.WORKER_TOKEN,
    workerTlsCa: process.env.WORKER_TLS_CA?.trim() || undefined,
    taskWorkerEnabled: process.env.TASK_WORKER_ENABLED !== "false",
    webSearchEnabled: process.env.WEB_SEARCH_ENABLED !== "false",
    computerEnabled: process.env.COMPUTER_ENABLED === "true",
    computerImage: process.env.COMPUTER_IMAGE ?? "openmuse-computer:local",
    // A blank line from .env is unset; otherwise every such install would share one name.
    computerDeploymentId: process.env.COMPUTER_DEPLOYMENT_ID?.trim() || undefined,
    computerProvider,
    computerE2bTemplate: process.env.COMPUTER_E2B_TEMPLATE?.trim() || "desktop",
    e2bApiKey,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:8081,http://127.0.0.1:8081")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Only trust X-Forwarded-For/X-Real-IP when the deployment is known to sit
    // behind a proxy that sets them; otherwise a direct caller can spoof them.
    trustProxy: process.env.TRUST_PROXY === "true",
  };
  // G3.1: no startup throw for a missing WORKER_TLS_CA. An https worker
  // URL without a CA is the live Azure shape (platform TLS, verified
  // against the system roots) — the G3 fail-fast that threw here crashed
  // the API at startup on Azure (revision 0000058, Nov 13). A Render
  // deploy that forgets the CA boots, then fails loudly at the TLS
  // handshake on every worker call instead.
  if (
    mode === "live" &&
    (!config.accessKey ||
      config.accessKey.length < 24 ||
      !config.encryptionKey ||
      !isValidEncryptionKey(config.encryptionKey))
  )
    throw new Error(
      "Live mode requires OPENMUSE_ACCESS_KEY (24+ characters) and TOKEN_ENCRYPTION_KEY (32-byte base64)",
    );
  if (mode === "sample" && !["127.0.0.1", "localhost", "::1"].includes(config.host))
    throw new Error("Sample workspace is local-only. HOST must be a loopback address.");
  const standingInstructions = process.env.OPENMUSE_INSTRUCTIONS;
  if (standingInstructions && standingInstructions.length > MAX_STANDING_INSTRUCTIONS_CHARS)
    console.warn(
      `[OpenMuse] OPENMUSE_INSTRUCTIONS is ${standingInstructions.length} characters, ` +
        `over the ${MAX_STANDING_INSTRUCTIONS_CHARS}-character sane size; it is appended verbatim ` +
        `to every chat prompt. Shorten it to keep replies fast and within context.`,
    );
  return config;
}
