import { Agent, type Dispatcher } from "undici";

// One Agent per CA: the Agent owns the connection pool, so creating one per
// request would defeat keep-alive. The CA is fixed at config load, so a
// single cached Agent is the right shape for a long-running server.
let cached: { ca: string; dispatcher: Dispatcher } | undefined;

/**
 * Fetch init carrying the private-CA trust for the worker, when the worker
 * URL is https AND a private CA is configured (G3: on Render the worker
 * serves TLS with a certificate from a private CA — see
 * docs/RENDER-WORKER-TLS.md). Plain-http workers use the default fetch
 * unchanged, and so do https workers with no CA configured: that is the
 * live Azure shape, where the platform terminates TLS in front of the
 * worker and the certificate verifies against the system roots. The G3
 * fail-fast that threw for any https URL without a CA crashed the API at
 * startup on Azure (revision 0000058, Nov 13) — it wrongly assumed every
 * https worker needs the private CA.
 *
 * Verification stays ON everywhere: the Agent is created with the CA only,
 * never with verification disabled, and there is no silent fallback to
 * http. The fail-closed property now lives at the TLS layer, not at
 * startup: a Render deploy with the https URL but a forgotten CA boots,
 * then every worker call fails loudly at the TLS handshake (the private
 * CA is not in the system roots) with the usual "Browser worker is
 * unavailable" 503 — it can never connect unverified.
 */
export function workerFetchInit(
  workerUrl: string | undefined,
  workerTlsCa: string | undefined,
): { dispatcher?: Dispatcher } {
  if (!workerUrl?.startsWith("https://")) return {};
  const ca = workerTlsCa?.trim();
  if (!ca) return {};
  if (cached?.ca !== ca) cached = { ca, dispatcher: new Agent({ connect: { ca } }) };
  return { dispatcher: cached.dispatcher };
}
