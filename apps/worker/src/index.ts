import { parseDownloadQuotaBytes } from "./downloads.ts";
import { createWorkerServer } from "./server.ts";

const token = process.env.WORKER_TOKEN ?? "";
// TLS material (G3): both must be set together. A lone cert or key is a
// misconfiguration, so fail fast instead of silently serving plain HTTP.
const tlsCert = process.env.WORKER_TLS_CERT;
const tlsKey = process.env.WORKER_TLS_KEY;
if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey))
  throw new Error(
    "WORKER_TLS_CERT and WORKER_TLS_KEY must be set together (see docs/RENDER-WORKER-TLS.md).",
  );
const worker = await createWorkerServer({
  token,
  dataDir: process.env.WORKER_DATA_DIR ?? ".openmuse/browser-profiles",
  maxSessions: 3,
  idleTimeoutMs: 30 * 60_000,
  downloadQuotaBytes: parseDownloadQuotaBytes(process.env.WORKER_DOWNLOAD_QUOTA_BYTES),
  tls: tlsCert && tlsKey ? { cert: tlsCert, key: tlsKey } : undefined,
});
worker.server.listen(8790, process.env.WORKER_HOST ?? "127.0.0.1", () => {
  console.log(`OpenMuse browser worker listening on port 8790 (${tlsCert ? "https" : "http"})`);
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 30_000);
  deadline.unref();
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
