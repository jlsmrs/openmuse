/** Background errors are visible without logging provider payloads or credential-bearing URLs. */
export function backgroundFailure(phase: string, error: unknown) {
  const rawCode =
    error instanceof Error && "code" in error
      ? (error as Error & { code?: unknown }).code
      : undefined;
  const code =
    typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode) ? rawCode : undefined;
  console.error({
    timestamp: new Date().toISOString(),
    context: { phase },
    error: error instanceof Error ? error.name : "Background operation failed",
    ...(code ? { code } : {}),
  });
}

/**
 * Non-throwing background-failure report (B-1, round 9): the shared
 * wrapper for every cleanup path that must never let logging replace
 * the error already being handled. A throwing logger (a broken
 * console, a throwing transport) is unreportable by definition, so
 * the failure is swallowed here — the caller's original error, and
 * its control flow, always stand. Used by the pg transaction runner
 * (`db.ts`, replacing its local `reportCleanupFailure`) and by the
 * pull-level cleanup in `files.ts`.
 */
export function reportBackgroundFailure(phase: string, error: unknown): void {
  try {
    backgroundFailure(phase, error);
  } catch {
    // Logging must never mask the operation error either; a logging
    // failure is unreportable by definition.
  }
}

/** Provider failures keep status and request ID for support, never bodies or credentials. */
export function providerFailure(phase: string, error: unknown) {
  const detail = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  console.error({
    timestamp: new Date().toISOString(),
    context: {
      phase,
      ...(typeof detail.status === "number" ? { status: detail.status } : {}),
      ...(typeof detail.requestId === "string" ? { requestId: detail.requestId } : {}),
    },
    error: error instanceof Error ? error.name : "Provider request failed",
  });
}

/** Client tools the agent never receives are logged by name, never by arguments. */
export function clientToolsDropped(phase: string, toolNames: string[]) {
  const names = toolNames.filter((name) => /^[A-Za-z0-9_.-]{1,128}$/.test(name));
  console.warn({
    timestamp: new Date().toISOString(),
    context: { phase, droppedTools: names },
    error: "Client tools dropped",
  });
}
