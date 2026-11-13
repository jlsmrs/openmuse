import { Agent, type Dispatcher } from "undici";

// One Agent per CA: the Agent owns the connection pool, so creating one per
// request would defeat keep-alive. The CA is fixed at config load, so a
// single cached Agent is the right shape for a long-running server.
let cached: { ca: string; dispatcher: Dispatcher } | undefined;

/**
 * Fetch init carrying the private-CA trust for the worker, when the worker
 * URL is https (G3: the worker serves TLS with a certificate from a
 * private CA — see docs/RENDER-WORKER-TLS.md). Plain-http workers use the
 * default fetch unchanged.
 *
 * Fail-closed: an https worker URL without a CA throws instead of
 * connecting unverified — and there is no silent fallback to http.
 * Verification stays on: the Agent is created with the CA only, never
 * with verification disabled.
 */
export function workerFetchInit(
  workerUrl: string | undefined,
  workerTlsCa: string | undefined,
): { dispatcher?: Dispatcher } {
  if (!workerUrl?.startsWith("https://")) return {};
  const ca = workerTlsCa?.trim();
  if (!ca)
    throw new Error(
      "BROWSER_WORKER_URL is https but WORKER_TLS_CA is not set. Set WORKER_TLS_CA to the PEM " +
        "of the private CA that signed the worker certificate (see docs/RENDER-WORKER-TLS.md).",
    );
  if (cached?.ca !== ca) cached = { ca, dispatcher: new Agent({ connect: { ca } }) };
  return { dispatcher: cached.dispatcher };
}
