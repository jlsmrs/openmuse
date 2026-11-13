import type { BrowserSession } from "../../../packages/domain/src";

/** The record to show: whichever copy — the freshly fetched one or the
 * workspace list's — was updated most recently, console/preview URLs
 * included. Forcing one copy's URLs over the other overwrote a newer
 * session's URLs with stale ones. */
export function newerBrowserSession(
  local: BrowserSession,
  latest?: BrowserSession,
): BrowserSession {
  return latest && latest.updatedAt > local.updatedAt ? latest : local;
}
