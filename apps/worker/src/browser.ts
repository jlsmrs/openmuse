import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, BrowserContext, Download, LaunchOptions, Page, Response } from "playwright";
import {
  capturePdfDownload,
  capturePdfDownloadFromBytes,
  downloadFilenameFromResponse,
  listPublishedDownloadIds,
  MAX_DOWNLOAD_BYTES,
  type PdfDownload,
  quarantineFile,
  readDownloadFailures,
  recordDownloadFailure,
} from "./downloads.ts";
import { WorkerError } from "./errors.ts";
import { validatePublicUrl } from "./network.ts";
import { startEgressProxy } from "./proxy.ts";

export interface Session {
  id: string;
  title: string;
  url: string;
  status: "active" | "closed" | "error";
  updatedAt: string;
}
type Running = {
  context: BrowserContext;
  page: Page;
  touched: number;
  pending: Set<Promise<void>>;
  downloadError?: boolean;
  // Downloads started since this session opened. navigate() records the
  // count before goto and treats a higher count afterwards as proof the
  // navigation turned into a download — no string-matching on
  // Playwright's error text.
  downloadCount: number;
  // Set in Obscura mode: the CDP connection behind the context. Closing the
  // context alone does not drop it, so closeSession closes both.
  browser?: Browser;
  // True in Obscura mode. Drives the cookie workarounds below: Obscura
  // 0.2.6 cannot send a request to a domain once a cookie exists for it
  // (see the createSession restore note), so Obscura mode never restores
  // cookies and clears the store before every navigation.
  obscura: boolean;
};
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ObscuraConfig {
  endpoint: string;
  token: string;
  // Host header sent on the CDP connection. Defaults to the endpoint's
  // host and port; override it when the connection goes through an
  // ingress whose port differs from the CDP server's port. Azure:
  // connect to ws://obscura-browser (ingress port 80) but send Host
  // obscura-browser:9222, because the ingress IP listens on 80/443
  // only — connecting to :9222 times out, and deriving the Host from
  // the port-80 endpoint would give :80, which Obscura refuses.
  host: string;
}

const OBSCURA_CDP_URL_ENV = "OBSCURA_CDP_URL";
const OBSCURA_CDP_TOKEN_ENV = "OBSCURA_CDP_TOKEN";
const OBSCURA_CDP_HOST_ENV = "OBSCURA_CDP_HOST";

// Obscura mode is env-gated and default-off: both variables must be set.
// A half-configured state falls back to the local Chromium path exactly as
// today. A malformed endpoint fails loudly at startup instead of silently
// launching Chromium when the operator clearly intended Obscura mode.
// The token is read from the environment only and is never logged.
export function resolveObscuraConfig(env: NodeJS.ProcessEnv = process.env): ObscuraConfig | null {
  const endpoint = env[OBSCURA_CDP_URL_ENV]?.trim();
  const token = env[OBSCURA_CDP_TOKEN_ENV]?.trim();
  if (!endpoint || !token) return null;
  // Reject backslashes, control characters, and fragments before WHATWG
  // parsing normalizes them: for ws:/wss: URLs a backslash is a path
  // separator, so "ws://\\host/path" would acquire a phantom host, and a
  // WebSocket endpoint must not carry a fragment at all. (Biome forbids
  // control-character escapes in regexes, so the C0/DEL check below is a
  // code-point test; \s already covers the whitespace controls.)
  if (
    /[\s\\#]/.test(endpoint) ||
    [...endpoint].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
  )
    throw new WorkerError(
      "INVALID_OBSCURA_CONFIG",
      "OBSCURA_CDP_URL must not contain whitespace, backslashes, control characters, or a fragment.",
      500,
    );
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new WorkerError(
      "INVALID_OBSCURA_CONFIG",
      "OBSCURA_CDP_URL must be a valid WebSocket URL.",
      500,
    );
  }
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    // WHATWG parsing accepts "ws:///path" with a phantom host, so require
    // an explicit authority section in the configured string itself.
    // The scheme is case-insensitive: new URL() normalizes it, so "WS://"
    // is a valid endpoint and must not be rejected here.
    !/^wss?:\/\/[^/\s]+/i.test(endpoint) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw new WorkerError(
      "INVALID_OBSCURA_CONFIG",
      "OBSCURA_CDP_URL must be a ws:// or wss:// URL with a host and no username or password.",
      500,
    );
  const hostOverride = env[OBSCURA_CDP_HOST_ENV]?.trim();
  let host: string;
  if (hostOverride) {
    // An explicit Host override is a bare host:port value — no scheme,
    // path, userinfo, or fragment. The port is required: the whole point
    // of the override is a Host port that differs from the connection
    // port, so a portless value cannot express it.
    if (/[\s\\/#@]/.test(hostOverride) || hostOverride.includes("://"))
      throw new WorkerError(
        "INVALID_OBSCURA_CONFIG",
        "OBSCURA_CDP_HOST must be a host:port value.",
        500,
      );
    let hostUrl: URL;
    try {
      hostUrl = new URL(`ws://${hostOverride}`);
    } catch {
      throw new WorkerError(
        "INVALID_OBSCURA_CONFIG",
        "OBSCURA_CDP_HOST must be a host:port value.",
        500,
      );
    }
    if (
      !hostUrl.hostname ||
      !hostUrl.port ||
      hostUrl.username ||
      hostUrl.password ||
      hostUrl.pathname !== "/"
    )
      throw new WorkerError(
        "INVALID_OBSCURA_CONFIG",
        "OBSCURA_CDP_HOST must be a host:port value.",
        500,
      );
    host = `${hostUrl.hostname}:${hostUrl.port}`;
  } else {
    host = deriveObscuraHost(url.href);
  }
  return { endpoint: url.href, token, host };
}

// Obscura's CDP server refuses control requests unless the Host header's
// port equals the server's own port (crates/obscura-cdp/src/server.rs,
// host_matches_bind). A direct connection must therefore send
// Host: <endpoint host>:<endpoint port> itself; the public gateway absorbs
// this quirk, but the worker connects directly and must not rely on it.
// An endpoint without an explicit port falls back to the scheme default
// (ws: 80, wss: 443); in practice the URL always carries the Obscura port.
// The endpoint is expected to have passed resolveObscuraConfig already;
// the protocol check here keeps this exported helper self-defending.
export function deriveObscuraHost(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new WorkerError(
      "INVALID_OBSCURA_CONFIG",
      "OBSCURA_CDP_URL must be a ws:// or wss:// URL.",
      500,
    );
  const port = url.port || (url.protocol === "wss:" ? "443" : "80");
  return `${url.hostname}:${port}`;
}

export function validateSessionId(id: unknown): string {
  if (typeof id !== "string" || !SESSION_ID.test(id))
    throw new WorkerError("INVALID_SESSION", "A valid UUID session ID is required.");
  return id.toLowerCase();
}

export type BrowserEngine = "obscura" | "chromium";

/**
 * Resolve the engine for a new session. Absent means the env-configured
 * mode (Obscura if configured, else Chromium). An unknown value is a 400;
 * "obscura" without Obscura config is a 503 — never a silent fall back
 * to the other engine.
 */
export function resolveSessionEngine(engine: unknown, obscuraConfigured: boolean): BrowserEngine {
  if (engine === undefined) return obscuraConfigured ? "obscura" : "chromium";
  if (engine !== "obscura" && engine !== "chromium")
    throw new WorkerError("INVALID_ENGINE", 'engine must be "obscura" or "chromium".', 400);
  if (engine === "obscura" && !obscuraConfigured)
    throw new WorkerError(
      "BROWSER_UNAVAILABLE",
      "Obscura is not configured on this worker, so an Obscura session cannot be created.",
      503,
    );
  return engine;
}

/** Default Chromium launcher for the Obscura-mode download fallback. */
async function defaultChromiumLauncher(options: LaunchOptions): Promise<Browser> {
  const { chromium } = await import("playwright");
  return chromium.launch(options);
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
  return lower;
}

/**
 * Whether a navigation Response is a download in Obscura mode: a
 * content-disposition carrying `attachment`, or a PDF content-type
 * (parameters after `;` ignored). Non-PDF content-types with no
 * attachment disposition are not downloads for this worker (the store
 * only accepts PDFs). Header names are matched case-insensitively;
 * Playwright already lowercases them.
 */
export function isDownloadResponse(headers: Record<string, string>): boolean {
  const lower = lowercaseHeaders(headers);
  // Parse the disposition TYPE (before the first semicolon): matching
  // the bare word "attachment" anywhere would also match an inline
  // response whose filename merely contains it, e.g.
  // `inline; filename="attachment-guide.html"`.
  const disposition = lower["content-disposition"]?.split(";")[0]?.trim().toLowerCase();
  if (disposition === "attachment") return true;
  const contentType = lower["content-type"]?.split(";")[0]?.trim().toLowerCase();
  return contentType === "application/pdf";
}

function parseContentLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  // Strict decimal syntax only: Number() would accept "0x10" (16),
  // "1e3" (1000), and "" (0), none of which is a valid Content-Length.
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return parsed;
}

export interface ObscuraDownloadContext {
  directory: string;
  tempDirectory: string;
  dataDir: string;
  quotaBytes?: number;
  limitReached: boolean;
  ensureProxy: () => Promise<{ url: string; close: () => Promise<void> }>;
  chromiumLauncher: (options: LaunchOptions) => Promise<Browser>;
  /** How long the fallback waits for the download event (default 20 s). */
  downloadWaitMs?: number;
  /** How long the fallback waits for the capture to finish (default 20 s). */
  captureWaitMs?: number;
}

const DOWNLOAD_INTERRUPTED_MESSAGE =
  "The download was interrupted or could not be retrieved. Try downloading it again.";

// Launch arguments shared by the per-session Chromium path and the
// Obscura-mode download fallback (one copy so they cannot drift):
// QUIC off, WebRTC non-proxied UDP disabled, no extensions, /dev/shm
// crash guard, and the host-resolver rules that force every destination
// through the proxy.
const CHROMIUM_LAUNCH_ARGS = [
  "--disable-quic",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--disable-extensions",
  "--disable-dev-shm-usage",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
];

/**
 * The environment a launched Chromium inherits: HOME, PATH, and LANG
 * only. The worker's own environment (WORKER_TOKEN, OBSCURA_CDP_*)
 * must never reach the browser process — the per-session Chromium
 * path has always allowlisted it, and the download fallback must
 * match. Built per launch so a changed process environment is picked
 * up, exactly as the per-session path did inline.
 */
function chromiumLaunchEnv(): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME ?? "/tmp",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
}

async function recordObscuraDownloadFailure(
  directory: string,
  url: string,
  contentDisposition: string | undefined,
  code: string,
  message: string,
): Promise<void> {
  await recordDownloadFailure(directory, {
    id: randomUUID(),
    name: downloadFilenameFromResponse(url, contentDisposition),
    code,
    message,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Chromium fallback for an Obscura-mode download the native path cannot
 * serve (absent content-length, a non-identity content-encoding, or
 * body() threw). Lazily starts the egress proxy, launches a short-lived
 * Chromium (transient: it does not count toward maxSessions), and
 * captures through the existing capturePdfDownload path. On no download
 * event or capture failure a DOWNLOAD_INTERRUPTED failure is recorded
 * and the session stays usable. The fallback navigates by GET only, in
 * a fresh context with no cookies.
 *
 * The capture has its own deadline (captureWaitMs, default 20 s):
 * without one a stalled transfer would block the session's navigation
 * queue indefinitely, since this fallback — unlike the Chromium event
 * handler — is awaited inside navigate(). On deadline the download is
 * cancelled and the failure is recorded.
 */
export async function captureViaChromiumFallback(
  deps: ObscuraDownloadContext,
  url: string,
): Promise<boolean> {
  let fallbackBrowser: Browser | null = null;
  let before: Set<string> | null = null;
  try {
    const egress = await deps.ensureProxy();
    // The temp dir is never created for Obscura sessions; the fallback
    // needs it as the Chromium downloads path. downloadsPath is a LAUNCH
    // option, not a newContext option (BrowserContextOptions has no such
    // field in Playwright 1.62) — with it set, accepted downloads land in
    // the temp dir and the diffing below works like the Chromium path.
    await mkdir(deps.tempDirectory, { recursive: true, mode: 0o700 });
    fallbackBrowser = await deps.chromiumLauncher({
      headless: true,
      // Same allowlisted environment as the per-session Chromium path:
      // the worker's own environment (WORKER_TOKEN, OBSCURA_CDP_*)
      // must never reach the browser process.
      env: chromiumLaunchEnv(),
      proxy: { server: egress.url },
      downloadsPath: deps.tempDirectory,
      args: CHROMIUM_LAUNCH_ARGS,
    });
    const context = await fallbackBrowser.newContext({
      acceptDownloads: true,
    });
    try {
      const page = await context.newPage();
      // Temp-dir diffing like createSession's download handler: the
      // files belonging to this capture are the .crdownload files that
      // appear after this point. (The snapshot here is taken after page
      // creation rather than at event time, but it is still before goto,
      // so the same exclusion holds.)
      const knownTempFiles = new Set(await readdir(deps.tempDirectory).catch(() => []));
      let resolveDownload: (download: Download) => void = () => {};
      const downloadPromise = new Promise<Download>((resolve) => {
        resolveDownload = resolve;
      });
      const onDownload = (download: Download) => resolveDownload(download);
      page.on("download", onDownload);
      let eventTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => {
        eventTimer = setTimeout(() => resolve(null), deps.downloadWaitMs ?? 20_000);
      });
      try {
        // A successful attachment intentionally aborts page navigation in
        // Chromium, so a goto rejection here is not a failure: the download
        // event is the signal.
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
        const download = await Promise.race([downloadPromise, timeout]);
        if (!download) {
          await recordObscuraDownloadFailure(
            deps.directory,
            url,
            undefined,
            "DOWNLOAD_INTERRUPTED",
            DOWNLOAD_INTERRUPTED_MESSAGE,
          );
          return false;
        }
        const fresh = await readdir(deps.tempDirectory).catch(() => []);
        const captureFiles = fresh.filter(
          (name) => name.endsWith(".crdownload") && !knownTempFiles.has(name),
        );
        before = await listPublishedDownloadIds(deps.directory);
        const failuresBefore = await readDownloadFailures(deps.directory).catch(() => []);
        const capture = capturePdfDownload({
          directory: deps.directory,
          tempDirectory: deps.tempDirectory,
          tempFiles: captureFiles,
          download,
          limitReached: deps.limitReached,
          dataDir: deps.dataDir,
          quotaBytes: deps.quotaBytes,
        });
        let captureTimer: ReturnType<typeof setTimeout> | undefined;
        const captureTimeout = new Promise<never>((_, reject) => {
          captureTimer = setTimeout(() => {
            void download.cancel().catch(() => {});
            reject(new Error("Download capture timed out"));
          }, deps.captureWaitMs ?? 20_000);
        });
        try {
          await Promise.race([capture, captureTimeout]);
        } catch (error) {
          // The capture may still settle later (the download was
          // cancelled, not awaited): observe it so its rejection is not
          // unhandled, then give it a short grace period to record its
          // own failure. A cancelled capture records
          // DOWNLOAD_INTERRUPTED in its own catch; recording a second
          // one here would show the same failure twice for one download.
          void capture.catch(() => {});
          await Promise.race([
            capture.then(
              () => undefined,
              () => undefined,
            ),
            new Promise((resolve) => setTimeout(resolve, 1000)),
          ]);
          const after = await listPublishedDownloadIds(deps.directory);
          for (const id of after) if (!before.has(id)) return true;
          const failuresAfter = await readDownloadFailures(deps.directory).catch(() => []);
          if (failuresAfter.length > failuresBefore.length) return false;
          throw error; // the capture never recorded: let the outer catch do it
        } finally {
          clearTimeout(captureTimer);
        }
        const after = await listPublishedDownloadIds(deps.directory);
        for (const id of after) if (!before.has(id)) return true;
        return false;
      } finally {
        clearTimeout(eventTimer);
        page.off("download", onDownload);
      }
    } finally {
      await context.close().catch(() => {});
    }
  } catch {
    // A capture that published and then failed its journal cleanup throws
    // from capturePdfDownload: the PDF is in the store, so report success
    // rather than recording a spurious failure.
    if (before) {
      const after = await listPublishedDownloadIds(deps.directory).catch(() => new Set<string>());
      for (const id of after) if (!before.has(id)) return true;
    }
    // Launch, context, or goto failure: the download could not be
    // retrieved. Record it instead of failing the navigation — the
    // session stays usable and the failure is visible in GET /downloads.
    // If recording itself fails the store is broken: let that throw so
    // the caller marks the download store failed instead of reporting
    // a navigation that produced neither a PDF nor a recorded failure.
    await recordObscuraDownloadFailure(
      deps.directory,
      url,
      undefined,
      "DOWNLOAD_INTERRUPTED",
      DOWNLOAD_INTERRUPTED_MESSAGE,
    );
    return false;
  } finally {
    await fallbackBrowser?.close().catch(() => {});
  }
}

/**
 * Obscura-native download capture for a navigation Response that
 * isDownloadResponse flagged. Reads the bytes from the navigation
 * Response itself — no second server-side fetch. Returns true when the
 * download was published as a PDF.
 */
export async function handleObscuraDownloadResponse(
  deps: ObscuraDownloadContext,
  response: Pick<Response, "headers" | "body">,
  url: string,
): Promise<boolean> {
  const headers = lowercaseHeaders(response.headers());
  const contentLength = parseContentLength(headers["content-length"]);
  // A non-identity content-encoding means the length (when present)
  // describes the encoded representation while body() returns the
  // decoded body, so the length cannot bound the buffer. Belt and
  // braces: Obscura 0.2.6 strips content-encoding and content-length
  // when it decodes a body (verified by probe, Nov 15, 2026), so an
  // encoded response normally arrives with no length and takes the
  // fallback below anyway — but if an encoding ever survives to this
  // point, route it to the bounded fallback rather than trusting the
  // length against a decoded body.
  const encoding = headers["content-encoding"]?.split(",")[0]?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
    return captureViaChromiumFallback(deps, url);
  }
  if (contentLength !== undefined && contentLength > MAX_DOWNLOAD_BYTES) {
    // Honest oversized length: record the failure without calling body(),
    // so the huge file is never buffered.
    await recordObscuraDownloadFailure(
      deps.directory,
      url,
      headers["content-disposition"],
      "DOWNLOAD_TOO_LARGE",
      "The download exceeds 10 MiB. Choose a smaller PDF.",
    );
    return false;
  }
  if (contentLength === undefined) {
    // No length means unbounded buffering for body(); the fallback
    // streams with the existing byte cap instead.
    return captureViaChromiumFallback(deps, url);
  }
  let bytes: Buffer;
  try {
    bytes = await response.body();
  } catch {
    return captureViaChromiumFallback(deps, url);
  }
  // A content-length that lies small still buffers the whole body once
  // before the cap in capturePdfDownloadFromBytes rejects it; the worker
  // only navigates to operator-requested URLs, so this needs a hostile
  // server the operator chose to visit.
  return capturePdfDownloadFromBytes({
    directory: deps.directory,
    tempDirectory: deps.tempDirectory,
    limitReached: deps.limitReached,
    dataDir: deps.dataDir,
    quotaBytes: deps.quotaBytes,
    url,
    contentDisposition: headers["content-disposition"],
    bytes,
  });
}

/**
 * A stored session.json is only trusted when it has the Session shape.
 * A bare cast lets a malformed file into list() and into later close
 * results; malformed files are quarantined by the caller instead.
 */
function parseStoredSession(value: unknown): Omit<Session, "id"> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { title, url, status, updatedAt } = value as Partial<Session>;
  if (typeof title !== "string" || typeof url !== "string" || typeof updatedAt !== "string")
    return null;
  if (status !== "active" && status !== "closed" && status !== "error") return null;
  return { title, url, status, updatedAt };
}

export async function createBrowserManager(
  options: {
    dataDir: string;
    maxSessions?: number;
    idleTimeoutMs?: number;
    /**
     * Total-download quota in bytes, enforced by evicting the oldest
     * PDFs first after each publish (G2). Undefined means no total
     * quota is enforced.
     */
    downloadQuotaBytes?: number;
    /**
     * Chromium launcher for the Obscura-mode download fallback.
     * Injected for tests; defaults to the real chromium.launch.
     * (The per-session Chromium engine path still uses
     * launchPersistentContext directly.)
     */
    chromiumLauncher?: (options: LaunchOptions) => Promise<Browser>;
  },
  createProxy = startEgressProxy,
) {
  const {
    dataDir,
    maxSessions = 3,
    idleTimeoutMs = 30 * 60_000,
    downloadQuotaBytes,
    chromiumLauncher = defaultChromiumLauncher,
  } = options;
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const sessions = new Map<string, Session>();
  const running = new Map<string, Running>();
  const queues = new Map<string, Promise<unknown>>();
  const obscura = resolveObscuraConfig();
  // In Obscura mode the remote browser egresses from Azure directly, so the
  // worker's loopback egress proxy is unreachable from it and is not
  // started. Remote-side SSRF enforcement is Obscura's own guard (see the
  // note at the CDP attach site); the worker-side URL-validation layer
  // still guards every navigation and subrequest on top of it. A Chromium
  // session or a download fallback inside an Obscura-configured worker
  // still needs the proxy (the Chromium launch passes proxy.url), so in
  // Obscura mode it starts LAZILY on first Chromium use and is cached;
  // in Chromium mode it starts eagerly, exactly as before.
  const eagerProxy = obscura ? null : await createProxy();
  let lazyProxy: Promise<{ url: string; close: () => Promise<void> }> | null = null;
  async function ensureProxy() {
    if (eagerProxy) return eagerProxy;
    if (!lazyProxy) {
      const starting = createProxy();
      lazyProxy = starting;
      // A failed startup must not poison later use: clear the cache so
      // the next caller retries, while concurrent callers still share
      // this one attempt.
      starting.catch(() => {
        if (lazyProxy === starting) lazyProxy = null;
      });
    }
    return lazyProxy;
  }
  const directory = (id: string) => join(dataDir, validateSessionId(id));
  // The per-session temp download dir. Published downloads live under the
  // session dir; this holds only in-flight Chromium files.
  const tempDirectoryFor = (id: string) =>
    join("/tmp", `openmuse-downloads-${validateSessionId(id)}`);
  for (const id of await readdir(dataDir)) {
    if (!SESSION_ID.test(id)) continue;
    const sessionPath = join(dataDir, id, "session.json");
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(sessionPath, "utf8"));
    } catch {
      /* An incomplete first launch has no session metadata to restore. */
      continue;
    }
    const valid = parseStoredSession(stored);
    if (!valid) {
      // Never serve a malformed stored session: move it aside for the
      // operator and treat the profile as unrestored.
      await quarantineFile(sessionPath).catch(() => {});
      continue;
    }
    sessions.set(id, { ...valid, id, status: "closed" });
    try {
      await readDownloadFailures(join(dataDir, id), true);
    } catch {
      // Startup recovery must not kill the worker: a corrupt outcome is
      // already quarantined by readDownloadFailures, and the failures
      // list is rebuilt on the next downloads call.
    }
  }
  // Sweep temp dirs left behind by crashed runs. Only sessions this
  // worker owns (restored from its own dataDir) are swept — another
  // worker sharing /tmp may own other ids, and its live temp dirs must
  // not be touched.
  for (const id of sessions.keys()) {
    await rm(tempDirectoryFor(id), { recursive: true, force: true }).catch(() => {});
  }
  async function persist(session: Session) {
    const path = join(directory(session.id), "session.json");
    await writeFile(`${path}.tmp`, JSON.stringify(session), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  async function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    queues.set(id, next);
    try {
      return await next;
    } finally {
      if (queues.get(id) === next) queues.delete(id);
    }
  }
  function active(id: string) {
    const value = running.get(id);
    if (!value || value.page.isClosed())
      throw new WorkerError(
        "SESSION_CLOSED",
        "Open this browser session before using its console.",
        409,
      );
    value.touched = Date.now();
    return value;
  }
  async function refresh(id: string) {
    const instance = active(id);
    if (instance.page.url() !== "about:blank") await validatePublicUrl(instance.page.url());
    const session: Session = {
      id,
      title: (await instance.page.title()).slice(0, 300),
      url: instance.page.url(),
      status: "active",
      updatedAt: new Date().toISOString(),
    };
    sessions.set(id, session);
    await persist(session);
    return session;
  }
  async function downloads(id: string): Promise<PdfDownload[]> {
    if (!sessions.has(id))
      throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    const folder = join(directory(id), "downloads");
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const list: PdfDownload[] = [];
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".json")) continue;
      const path = join(folder, name);
      try {
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        if (typeof value !== "object" || value === null || Array.isArray(value))
          throw new Error("Invalid download metadata");
        const { id: itemId, name: itemName, size, mimeType } = value as Partial<PdfDownload>;
        if (
          typeof itemId !== "string" ||
          typeof itemName !== "string" ||
          typeof size !== "number" ||
          mimeType !== "application/pdf"
        )
          throw new Error("Invalid download metadata");
        list.push(value as PdfDownload);
      } catch {
        // One corrupt metadata file must not fail the whole list (the
        // same per-file quarantine M-B3 gave the outcome files): move it
        // aside and keep the healthy downloads.
        await quarantineFile(path).catch(() => {});
      }
    }
    return list;
  }
  async function navigate(id: string, url: string) {
    const target = await validatePublicUrl(url);
    const instance = active(id);
    const { page } = instance;
    const downloadsBefore = instance.downloadCount;
    let response: Response | null = null;
    try {
      // Obscura 0.2.6 cookie bug (verified by local probes, Nov 13, 2026):
      // once a cookie exists for a domain, every later request to that
      // domain hangs past Obscura's internal 30s deadline — whether the
      // cookie came from context.addCookies or a server Set-Cookie header,
      // and even when the cookie was set on an earlier navigation of the
      // same context. Other domains keep working. Clearing the store
      // before each navigation keeps repeat same-domain navigation working.
      // The price is that cookie-based state cannot survive a navigation
      // in Obscura mode at all: logins, OAuth redirects, and CSRF-token
      // flows that depend on a cookie set by an earlier page do not work
      // there. That is the engine's limitation, not the clearing — without
      // clearing, the next request to the cookie's domain hangs instead
      // of succeeding without the cookie. Clearing the whole store (rather
      // than just the target domain) also protects redirect targets: a
      // redirect to any domain with a stored cookie would hang the same
      // way. The one case this cannot rescue is a cookie set
      // mid-navigation followed by a same-domain redirect.
      if (instance.obscura) await instance.context.clearCookies();
      response = await page.goto(target.url.href, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      // Chromium can follow redirects outside Playwright's initial route hook.
      // The proxy blocks those sockets, but its 403 is still an HTTP response:
      // validate the final location so the API does not report it as success.
      await validatePublicUrl(page.url());
    } catch (error) {
      if (error instanceof WorkerError && error.code === "BLOCKED_URL") {
        await page.goto("about:blank", { timeout: 5000 });
        // A redirect to a blocked destination keeps the distinct code so
        // the API/UI can tell it apart from an unreachable page.
        throw error;
      }
      // A successful attachment intentionally aborts page navigation. The
      // download event — not Playwright's error text — is the signal: a
      // download that started during this navigation means the navigation
      // "failed" only because the attachment took over. The goto rejection
      // can win the race with the event (both land in the same millisecond),
      // so give the event a brief grace period before calling it a failure.
      if (instance.downloadCount <= downloadsBefore) {
        for (let waited = 0; waited < 500; waited += 25) {
          await new Promise((resolve) => setTimeout(resolve, 25));
          if (instance.downloadCount > downloadsBefore) break;
        }
      }
      if (instance.downloadCount <= downloadsBefore) {
        throw new WorkerError(
          "NAVIGATION_FAILED",
          "The page could not be loaded. It may be unreachable.",
          502,
        );
      }
    }
    // Obscura 0.2.6 emits no download event, but page.goto() to an
    // attachment returns a Response whose body() returns the bytes
    // (verified by local probe, Nov 15, 2026). Detect downloads from the
    // navigation response and capture them natively; Chromium mode keeps
    // its event path and never reaches this branch.
    if (instance.obscura && response && isDownloadResponse(response.headers())) {
      let published = false;
      try {
        published = await handleObscuraDownloadResponse(
          {
            directory: directory(id),
            tempDirectory: tempDirectoryFor(id),
            dataDir,
            quotaBytes: downloadQuotaBytes,
            // The current capture is NOT in instance.pending here (unlike
            // the Chromium event handler, which adds it before its async
            // check runs), so the boundary is >= 20: with 20 saved PDFs
            // the next capture is the 21st and must be refused.
            limitReached: (await downloads(id)).length + instance.pending.size >= 20,
            ensureProxy,
            chromiumLauncher,
          },
          response,
          target.url.href,
        );
        // The store answered (published, or a failure recorded): a
        // transient store failure is cleared, mirroring the Chromium
        // event handler's success path.
        instance.downloadError = false;
      } catch {
        // Mirror the Chromium event handler: a rejected capture marks the
        // download store failed instead of failing the navigation.
        instance.downloadError = true;
      }
      if (published) instance.downloadCount++;
    }
    return refresh(id);
  }
  async function closeSession(id: string) {
    const instance = running.get(id);
    const stored = sessions.get(id);
    if (!stored) throw new WorkerError("SESSION_NOT_FOUND", "Browser session not found.", 404);
    if (instance) {
      try {
        const statePath = join(directory(id), "storage.json");
        await instance.context.storageState({ path: statePath });
        // Playwright writes the cookie jar with the process umask; pin it
        // to owner-only like session.json and download files.
        await chmod(statePath, 0o600);
      } catch {
        // Cookie persistence is best-effort during teardown. A crashed or
        // unreachable browser must still release its context and session slot.
      }
      await instance.context.close().catch(() => {});
      await instance.browser?.close().catch(() => {});
      await Promise.allSettled(instance.pending);
      running.delete(id);
    }
    // The temp dir holds only in-flight Chromium files; published
    // downloads live under the session dir, so it is safe to remove once
    // the context is closed and pending captures have settled.
    await rm(tempDirectoryFor(id), { recursive: true, force: true }).catch(() => {});
    const result: Session = { ...stored, status: "closed", updatedAt: new Date().toISOString() };
    sessions.set(id, result);
    await persist(result);
    return result;
  }
  async function createSession(id: string, url: string, engine?: unknown) {
    await validatePublicUrl(url);
    if (running.has(id)) return navigate(id, url);
    // Engine applies at session creation only: create() on an
    // already-running id navigated above and ignores the argument.
    const useObscura = resolveSessionEngine(engine, obscura !== null) === "obscura";
    if (running.size >= maxSessions)
      throw new WorkerError(
        "SESSION_LIMIT",
        `Close an active session before opening another (limit ${maxSessions}).`,
        409,
      );
    if (!sessions.has(id) && sessions.size >= 20)
      throw new WorkerError(
        "PROFILE_LIMIT",
        "The worker has reached its 20 saved-profile limit.",
        409,
      );
    const previous = sessions.get(id);
    const profileDir = join(directory(id), "profile");
    const tempDirectory = tempDirectoryFor(id);
    // Obscura is zero-state: no profile directory is created. The session
    // directory itself is still needed for session.json and storage.json.
    // The temp directory holds only in-flight Chromium files — the
    // download handler diffs it for .crdownload files and the
    // oversized-download monitor watches them. In Obscura mode the
    // remote browser downloads elsewhere, so nothing ever lands there
    // and the directory is not created at all.
    await mkdir(useObscura ? directory(id) : profileDir, { recursive: true, mode: 0o700 });
    if (!useObscura) await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
    // Files already in the temp dir predate this session (stale leftovers
    // the startup sweep missed); they belong to no capture here. In
    // Obscura mode the temp dir is never created (the remote browser
    // downloads elsewhere), so there is nothing to snapshot.
    const knownTempFiles = useObscura
      ? new Set<string>()
      : new Set<string>(await readdir(tempDirectory));
    let context: BrowserContext;
    let remoteBrowser: Browser | null = null;
    try {
      const { chromium } = await import("playwright");
      if (useObscura) {
        // resolveSessionEngine already guarantees config exists when
        // useObscura is true; this guard is for the type checker.
        if (!obscura)
          throw new WorkerError(
            "BROWSER_UNAVAILABLE",
            "Obscura is not configured on this worker.",
            503,
          );
        // Direct CDP attach. No profile directory, no launch args, and no
        // proxy option: the worker's egress proxy is unreachable from the
        // remote browser, so traffic egresses from Azure directly. The
        // remote-side SSRF enforcement is Obscura's own guard, verified
        // in the 0.2.6 source: its fetch layer validates every URL
        // (validate_url on the initial URL and on each redirect target,
        // crates/obscura-net/src/wreq_client.rs) and resolves every
        // request through SsrfGuardResolver, which refuses any hostname
        // resolving to a forbidden address (loopback, RFC1918,
        // link-local incl. 169.254.169.254, CGNAT, and IPv4-in-IPv6
        // forms; crates/obscura-ssrf/src/lib.rs). The guard is active
        // in Azure because the deployment sets neither
        // --allow-private-network nor OBSCURA_ALLOW_PRIVATE_NETWORK.
        // The worker-side URL validation (validatePublicUrl plus the
        // route hook below) is a second layer on top of it, and the
        // post-navigation check catches a redirect that lands on a
        // blocked destination — it cannot prevent the contact, the
        // SSRF guard is what prevents it.
        const browser = await chromium.connectOverCDP(obscura.endpoint, {
          headers: {
            Host: obscura.host,
            Authorization: `Bearer ${obscura.token}`,
          },
          timeout: 25_000,
        });
        remoteBrowser = browser;
        // A shared CDP server must support isolated context creation: the
        // fallback to the server's default context is not used, because
        // every session would share that one context — a later session
        // would close the earlier session's pages, share its cookies, and
        // share its route hooks. Obscura 0.2.6 supports newContext, so a
        // failure here is a hard BROWSER_UNAVAILABLE, not a shared
        // context.
        context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          serviceWorkers: "block",
          acceptDownloads: true,
          // No downloadsPath: it is a launchPersistentContext-only
          // option, not a BrowserContext option. The remote browser
          // keeps its default download location, so an oversized file
          // is written in full to the remote container's disk before
          // the worker-side stream cap (10 MiB in capturePdfDownload)
          // stops the worker's own copy — the cap bounds what the
          // worker writes, not what the remote browser writes. The
          // temp-directory oversized monitor (the backstop for a
          // stalled stream) has no temp files to watch in Obscura
          // mode, so it cannot cancel the remote transfer either.
          // The remote file is deleted after the transfer
          // (download.delete), so the exposure is transient
          // disk use on the Obscura container, not worker disk use.
        });
      } else {
        // The egress proxy is required here: without it the launch gets
        // an empty proxy server. In Chromium mode it started eagerly at
        // manager creation; in Obscura mode with a Chromium-engine
        // session it starts lazily on this first use.
        const egress = await ensureProxy();
        context = await chromium.launchPersistentContext(profileDir, {
          // Chromium does not need the worker API credential in its environment.
          env: chromiumLaunchEnv(),
          headless: true,
          viewport: { width: 1280, height: 800 },
          // No loopback bypass: loopback destinations are routed through the
          // egress proxy like everything else, so the proxy's pinned-IP
          // validation — not just the Playwright route hook — enforces the
          // public-only rule. A direct loopback connection could otherwise
          // reach the worker's own API port or other local services.
          proxy: { server: egress.url },
          serviceWorkers: "block",
          acceptDownloads: true,
          downloadsPath: tempDirectory,
          timeout: 25_000,
          // Shared with the download fallback (CHROMIUM_LAUNCH_ARGS).
          // /dev/shm is 64 MB by default on Render and Azure Container Apps
          // with no size control; without --disable-dev-shm-usage heavy
          // pages crash tabs.
          args: CHROMIUM_LAUNCH_ARGS,
        });
      }
    } catch {
      await remoteBrowser?.close().catch(() => {});
      if (!previous) await rm(directory(id), { recursive: true, force: true });
      await rm(tempDirectory, { recursive: true, force: true });
      throw new WorkerError(
        "BROWSER_UNAVAILABLE",
        useObscura
          ? "The remote browser could not be reached. Check the Obscura endpoint and token configuration."
          : "Chromium could not start. Rebuild the browser-worker image and check its resource limits.",
        503,
      );
    }
    try {
      const statePath = join(directory(id), "storage.json");
      try {
        const state = JSON.parse(await readFile(statePath, "utf8")) as Awaited<
          ReturnType<BrowserContext["storageState"]>
        >;
        // Cookie restore is skipped in Obscura mode: Obscura 0.2.6 hangs
        // every later request to a domain once a cookie exists for it
        // (verified by local probes, Nov 13, 2026), so restoring cookies
        // would break the session's first navigation to its own domain.
        // storage.json is still written on close for a future fixed engine.
        if (!useObscura) await context.addCookies(state.cookies);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      await context.route("**/*", async (route) => {
        try {
          await validatePublicUrl(route.request().url());
          await route.continue();
        } catch {
          await route.abort("blockedbyclient").catch(() => {});
        }
      });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      for (const old of context.pages()) await old.close();
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const instance: Running = {
        context,
        page,
        touched: Date.now(),
        pending: new Set(),
        downloadCount: 0,
        browser: remoteBrowser ?? undefined,
        obscura: useObscura,
      };
      running.set(id, instance);
      context.on("page", (popup) => {
        void popup.close();
      });
      page.on("dialog", (dialog) => {
        void dialog.dismiss();
      });
      page.on("download", (download) => {
        instance.downloadCount++;
        // Chromium names an in-flight download <uuid>.crdownload, and that
        // UUID is not exposed by the Download object — so the files
        // belonging to this capture are established by diffing the temp dir
        // synchronously when the event fires (the file already exists at
        // that point). Anything seen before belongs to a stale leftover or
        // an earlier concurrent download and is never monitored.
        let captureFiles: string[] = [];
        try {
          const fresh = readdirSync(tempDirectory);
          captureFiles = fresh.filter(
            (name) => name.endsWith(".crdownload") && !knownTempFiles.has(name),
          );
          for (const name of fresh) knownTempFiles.add(name);
        } catch {
          // A missing temp dir means there is nothing to monitor; the
          // pipeline byte counter still enforces the cap.
        }
        const pending = downloads(id).then((saved) =>
          capturePdfDownload({
            directory: directory(id),
            dataDir,
            quotaBytes: downloadQuotaBytes,
            tempDirectory,
            tempFiles: captureFiles,
            download,
            limitReached: saved.length + instance.pending.size > 20,
          }),
        );
        instance.pending.add(pending);
        void pending.then(
          () => {
            // The store answered again: a later success clears a sticky
            // download-store failure instead of failing every list until
            // the session is closed. The failure itself stays recorded in
            // the download-outcomes list.
            instance.downloadError = false;
            instance.pending.delete(pending);
          },
          () => {
            instance.downloadError = true;
            instance.pending.delete(pending);
          },
        );
      });
      const initial: Session = {
        id,
        title: previous?.title ?? "New session",
        url,
        status: "active",
        updatedAt: new Date().toISOString(),
      };
      sessions.set(id, initial);
      await persist(initial);
      return await navigate(id, url);
    } catch (error) {
      await context.close().catch(() => {});
      await remoteBrowser?.close().catch(() => {});
      await Promise.allSettled(running.get(id)?.pending ?? []);
      running.delete(id);
      if (previous) {
        const failed: Session = {
          ...previous,
          url,
          status: "error",
          updatedAt: new Date().toISOString(),
        };
        sessions.set(id, failed);
        await persist(failed);
      } else {
        sessions.delete(id);
        await rm(directory(id), { recursive: true, force: true });
      }
      await rm(tempDirectory, { recursive: true, force: true });
      throw error;
    }
  }
  const sweeper = setInterval(() => {
    for (const [id, instance] of running)
      if (Date.now() - instance.touched > idleTimeoutMs) {
        void serial(id, () => closeSession(id)).catch(() => {});
      }
  }, 60_000);
  sweeper.unref();
  return {
    list: () => [...sessions.values()],
    create: (id: string, url: string, engine?: unknown) =>
      serial("create", () => serial(id, () => createSession(id, url, engine))),
    navigate: (id: string, url: string) => serial(id, () => navigate(id, url)),
    closeSession: (id: string) => serial(id, () => closeSession(id)),
    screenshot: (id: string) =>
      serial(id, () => active(id).page.screenshot({ type: "png", timeout: 10_000 })),
    read: (id: string) =>
      serial(id, async () => {
        const { page } = active(id);
        await validatePublicUrl(page.url());
        // Evaluation is fixed by the worker; callers cannot inject JavaScript.
        const result = await page.evaluate(() => {
          const text = document.body?.innerText ?? "";
          return {
            url: location.href,
            title: document.title.slice(0, 300),
            text: text.slice(0, 100_000),
            truncated: text.length > 100_000,
          };
        });
        await validatePublicUrl(result.url);
        const session: Session = {
          id,
          url: result.url,
          title: result.title,
          status: "active",
          updatedAt: new Date().toISOString(),
        };
        sessions.set(id, session);
        await persist(session);
        return result;
      }),
    input: (id: string, input: Record<string, unknown>) =>
      serial(id, async () => {
        const { page } = active(id);
        const { type, x, y, key, text, deltaY } = input;
        if (
          type === "click" &&
          typeof x === "number" &&
          typeof y === "number" &&
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= 0 &&
          x < 1280 &&
          y >= 0 &&
          y < 800
        )
          await page.mouse.click(x, y);
        else if (type === "text" && typeof text === "string" && text.length <= 10_000)
          await page.keyboard.insertText(text);
        else if (
          type === "key" &&
          typeof key === "string" &&
          /^(Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Control\+a|Meta\+a|Shift\+Tab)$/.test(
            key,
          )
        )
          await page.keyboard.press(key);
        else if (
          type === "scroll" &&
          typeof deltaY === "number" &&
          Number.isFinite(deltaY) &&
          Math.abs(deltaY) <= 5000
        )
          await page.mouse.wheel(0, deltaY);
        else throw new WorkerError("INVALID_INPUT", "Unsupported browser input or coordinates.");
        return refresh(id);
      }),
    downloads: async (id: string) => {
      const saved = await downloads(id);
      if (running.get(id)?.downloadError)
        throw new WorkerError(
          "DOWNLOAD_STORE_FAILED",
          "A download outcome could not be saved. Check worker storage and try again.",
          500,
        );
      return { downloads: saved, failures: await readDownloadFailures(directory(id)) };
    },
    download: async (id: string, downloadId: string) => {
      validateSessionId(downloadId);
      const metadata = (await downloads(id)).find((item) => item.id === downloadId);
      if (!metadata) throw new WorkerError("DOWNLOAD_NOT_FOUND", "PDF download not found.", 404);
      const path = join(directory(id), "downloads", `${downloadId}.pdf`);
      const info = await stat(path);
      if (info.size > MAX_DOWNLOAD_BYTES)
        throw new WorkerError("DOWNLOAD_TOO_LARGE", "The PDF exceeds 10 MiB.", 413);
      return { metadata, bytes: await readFile(path) };
    },
    close: async () => {
      clearInterval(sweeper);
      await Promise.allSettled([...queues.values()]);
      await Promise.allSettled([...running.keys()].map(closeSession));
      await eagerProxy?.close();
      if (lazyProxy) await lazyProxy.then((started) => started.close()).catch(() => {});
    },
  };
}
