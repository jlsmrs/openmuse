import { decryptSecret, migrateSecretToV2 } from "../../../packages/integrations/src/vault.ts";
import type { Store } from "./db.ts";

/**
 * The stored shape of one credential row (kind "credentials"). Today the
 * only record id is "google" (see google-auth.ts); the migration keys the
 * v2 envelope off the row's own id so a future record type migrates the
 * same way without a code change.
 */
export interface CredentialRecord {
  id: string;
  generation?: string;
  connectionId: string | null;
  secret: string | null;
}

export interface MigrationFailure {
  owner: string;
  recordId: string;
  reason: string;
}

/** Counts only — no secret value or plaintext ever leaves this module. */
export interface MigrationReport {
  examined: number;
  migrated: number;
  alreadyV2: number;
  empty: number;
  failed: number;
  failures: MigrationFailure[];
}

/**
 * Bulk-migrate every stored credential to the v2 envelope (G4).
 *
 * For each row in kind "credentials": a null secret is an empty
 * (disconnected) placeholder and is skipped; a v2 record that
 * decrypts under its context is left unchanged; a v1 record is
 * re-encrypted under v2 and written back only after the new envelope
 * is verified to decrypt to the same plaintext the v1 record held.
 * A record that cannot be authenticated is reported as failed and
 * left untouched — the v1 read path keeps serving it.
 *
 * The write is a compare-and-swap against the full row read before
 * editing, so a concurrent change refuses the overwrite instead of
 * silently discarding it. In dry-run mode nothing is written.
 */
export async function migrateCredentials(
  store: Store,
  key: string,
  options: {
    dryRun?: boolean;
    onRecord?: (owner: string, recordId: string, status: string) => void;
  } = {},
): Promise<MigrationReport> {
  const report: MigrationReport = {
    examined: 0,
    migrated: 0,
    alreadyV2: 0,
    empty: 0,
    failed: 0,
    failures: [],
  };
  const rows = await store.scan<CredentialRecord>("credentials");
  report.examined = rows.length;
  for (const { owner, value } of rows) {
    const recordId = typeof value?.id === "string" ? value.id : "";
    if (!recordId) {
      report.failed++;
      report.failures.push({ owner, recordId: "", reason: "malformed credential row" });
      options.onRecord?.(owner, "", "failed");
      continue;
    }
    if (!value.secret) {
      report.empty++;
      options.onRecord?.(owner, recordId, "empty");
      continue;
    }
    const context = { owner, recordId };
    const result = migrateSecretToV2(value.secret, key, context);
    if (result.status === "already-v2") {
      report.alreadyV2++;
      options.onRecord?.(owner, recordId, "already-v2");
      continue;
    }
    if (result.status === "failed") {
      report.failed++;
      report.failures.push({ owner, recordId, reason: result.reason });
      options.onRecord?.(owner, recordId, "failed");
      continue;
    }
    // Verify the new envelope decrypts to the same plaintext the v1
    // record held before anything is written.
    let original: string;
    let roundTripped: string;
    try {
      original = decryptSecret(value.secret, key);
      roundTripped = decryptSecret(result.ciphertext, key, context);
    } catch {
      report.failed++;
      report.failures.push({ owner, recordId, reason: "migrated record failed verification" });
      options.onRecord?.(owner, recordId, "failed");
      continue;
    }
    if (roundTripped !== original) {
      report.failed++;
      report.failures.push({ owner, recordId, reason: "migrated record failed verification" });
      options.onRecord?.(owner, recordId, "failed");
      continue;
    }
    if (options.dryRun) {
      report.migrated++;
      options.onRecord?.(owner, recordId, "would-migrate");
      continue;
    }
    const updated = await store.compareAndSwap<CredentialRecord>(
      owner,
      "credentials",
      recordId,
      { ...value },
      { secret: result.ciphertext },
    );
    if (!updated) {
      report.failed++;
      report.failures.push({
        owner,
        recordId,
        reason: "record changed during migration; left untouched",
      });
      options.onRecord?.(owner, recordId, "failed");
      continue;
    }
    report.migrated++;
    options.onRecord?.(owner, recordId, "migrated");
  }
  return report;
}
