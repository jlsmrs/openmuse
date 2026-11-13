/**
 * G4 — bulk re-encryption of stored credentials from the v1 envelope to v2.
 *
 * The API server must be STOPPED before this runs. The credential store is
 * an embedded PGlite database, and PGlite does NOT enforce Postgres's
 * postmaster lock: a second backend opens the same data directory without
 * error (verified by probe, Nov 13 2026 — same-process and cross-process
 * double-opens both succeeded), so running this while the server is up
 * would put two backends writing the same files and risk corruption.
 * The --api-health-url check below is the in-script guard for that: it
 * refuses to proceed while the API answers healthy. The real guard is
 * the operator stopping the API first (see live run).
 *
 * What it does, in order: checks the API is down (when --api-health-url
 * is given), copies the whole postgres data directory to a timestamped
 * backup under the same data dir, opens the store, migrates every v1
 * credential record to v2 (verifying each new envelope decrypts to the
 * same plaintext before writing), and prints counts only — record ids
 * and reasons, never secret values or plaintext. Exit 0 when nothing
 * failed, 1 when any record failed. --dry-run reports what would
 * migrate and writes nothing (no backup either).
 *
 * Rollback: while the API is stopped, delete the postgres directory
 * and move the backup back in its place. The v1 read path stays intact
 * in the server, so a partial migration never locks anyone out — old
 * records keep decrypting until they are migrated.
 *
 * Live run (API image already contains this script at
 * /app/dist/apps/server/src/scripts/migrate-vault-v2.js — it is
 * compiled by `pnpm build:server`):
 *
 *   1. Stop the API (scale to 0 replicas) and confirm no replica is
 *      running: `az containerapp replica list --name openmuse-api
 *      --resource-group openmuse-rg` must be empty.
 *   2. Run this as a one-off Manual Container Apps job from the same
 *      API image, with the openmuse-data Azure Files volume mounted
 *      at /data and env DATA_DIR=/data/openmuse plus
 *      TOKEN_ENCRYPTION_KEY passed as a secret reference (never
 *      printed). Create the job in the portal or with
 *      `az containerapp job create --help` for the exact
 *      volume-mount flags, then start it. Dry-run first:
 *
 *      node /app/dist/apps/server/src/scripts/migrate-vault-v2.js \
 *        --data-dir /data/openmuse \
 *        --api-health-url https://openmuse-api.nicedesert-46502a1f.southcentralus.azurecontainerapps.io/api/health \
 *        --dry-run
 *
 *      then the same command without --dry-run.
 *   3. Confirm the job report (migrated count, zero failed), scale
 *      the API back, and check /api/health plus a Google token read
 *      (which decrypts the migrated v2 records with context).
 */
import { randomBytes } from "node:crypto";
import { cp, stat } from "node:fs/promises";
import { join } from "node:path";
import { isValidEncryptionKey } from "../../../../packages/integrations/src/vault.ts";
import { createStore } from "../db.ts";
import { migrateCredentials } from "../vault-migration.ts";

function fail(message: string): never {
  console.error(`migrate-vault-v2: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): {
  dataDir: string;
  dryRun: boolean;
  apiHealthUrl: string | undefined;
} {
  let dataDir: string | undefined;
  let dryRun = false;
  let apiHealthUrl: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--data-dir") {
      dataDir = argv[++index];
    } else if (arg === "--api-health-url") {
      apiHealthUrl = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: migrate-vault-v2 --data-dir <dir> [--dry-run] [--api-health-url <url>]\n" +
          "  --data-dir       DATA_DIR holding the postgres store (required)\n" +
          "  --dry-run        report what would migrate; write nothing\n" +
          "  --api-health-url refuse to run while this URL answers healthy\n" +
          "Requires TOKEN_ENCRYPTION_KEY in the environment. The API server\n" +
          "must be stopped first: PGlite does not lock the data directory\n" +
          "against a second backend.",
      );
      process.exit(0);
    } else {
      fail(`unknown argument: ${arg} (see --help)`);
    }
  }
  if (!dataDir) fail("--data-dir is required (see --help)");
  return { dataDir: dataDir as string, dryRun, apiHealthUrl };
}

async function apiIsUp(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

function backupName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `postgres-backup-${stamp}-${randomBytes(4).toString("hex")}`;
}

async function main(): Promise<number> {
  const { dataDir, dryRun, apiHealthUrl } = parseArgs(process.argv.slice(2));
  const key = process.env.TOKEN_ENCRYPTION_KEY;
  if (!key || !isValidEncryptionKey(key)) {
    fail("TOKEN_ENCRYPTION_KEY is not set or is not a 32-byte base64 key");
  }
  if (apiHealthUrl) {
    if (await apiIsUp(apiHealthUrl)) {
      fail(
        `API is still up (${apiHealthUrl} answers healthy). Stop the API first: ` +
          "a second PGlite backend on the same data directory risks corruption.",
      );
    }
  } else {
    console.warn(
      "warning: no --api-health-url given, so the API-down check was skipped. " +
        "Run this only with the API server stopped.",
    );
  }
  const postgresDir = join(dataDir, "postgres");
  try {
    await stat(postgresDir);
  } catch {
    fail(`no postgres store at ${postgresDir}; is --data-dir right?`);
  }
  let backupDir: string | undefined;
  if (!dryRun) {
    backupDir = join(dataDir, backupName());
    await cp(postgresDir, backupDir, { recursive: true });
    console.log(`backup: ${postgresDir} -> ${backupDir}`);
  }
  const store = await createStore({ dataDir: postgresDir });
  try {
    const report = await migrateCredentials(store, key as string, {
      dryRun,
      onRecord: (owner, recordId, status) => {
        console.log(`  ${status} ${owner} ${recordId}`);
      },
    });
    console.log(
      `${dryRun ? "[dry-run] " : ""}examined=${report.examined} ` +
        `migrated=${report.migrated} already-v2=${report.alreadyV2} ` +
        `empty=${report.empty} failed=${report.failed}`,
    );
    for (const failure of report.failures) {
      console.log(`  FAILED ${failure.owner} ${failure.recordId}: ${failure.reason}`);
    }
    if (backupDir) console.log(`backup kept at ${backupDir}`);
    return report.failed === 0 ? 0 : 1;
  } finally {
    await store.close();
  }
}

process.exitCode = await main();
