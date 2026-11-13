// DRAFT — Azure Document Intelligence receipt tool for the jlsmrs/openmuse fork.
// Placement: new file apps/server/src/engine/azure-receipt.ts, imported by
// apps/server/src/engine/conversation.ts and added to its defineTool list.
//
// Engine decision (Josh, Oct 29): receipts use Azure Document Intelligence,
// NOT Mistral — at Veritas volume the F0 free tier (500 pages/month) makes
// receipts $0, and the prebuilt Receipt model returns merchant/date/total/
// tax/line-items as structured fields. Mistral document-ai stays the engine
// for Pathfinder + general document intake (separate lane, separate tool).
//
// Env (set on openmuse-api at wiring time):
//   DOCINTEL_ENDPOINT — endpoint of the openmuse-docintel resource (F0)
//   DOCINTEL_KEY      — its key, stored as a secret, never logged/returned
//
// Flow: POST the receipt image/PDF to the prebuilt-receipt model, poll the
// operation URL until done, return the extracted fields as a DRAFT expense
// record. The backup never records the expense itself — Josh confirms first.
//
// Confinement (M-B1): the file argument is a workspace artifact ID resolved
// only through the Files service — never a filesystem path. A model-supplied
// path can no longer reach files outside the workspace, and a non-workspace
// ID fails the same way a missing file does.

import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";
import type { Files } from "../files.ts";

const params = z.object({
  fileId: z.string().trim().min(1).max(500),
});

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Overall receipt-poll deadline: the loop used to run 30 polls with a
 * 60-second per-poll timeout, so its worst-case wall time was ~31 minutes
 * with no way back. Five minutes bounds one tool call; the timeout result
 * carries the operation URL so the analysis can be resumed. */
export const RECEIPT_POLL_DEADLINE_MS = 300_000;

export type ReceiptDocumentFields = {
  merchant: unknown;
  date: unknown;
  total: unknown;
  tax: unknown;
  items: Array<{ description: unknown; amount: unknown }> | undefined;
};

/** Field mapping for one analysed receipt document. */
export function receiptDocumentFields(doc: {
  fields?: Record<
    string,
    {
      value?: unknown;
      content?: unknown;
      valueArray?: Array<{ valueObject?: Record<string, { value?: unknown }> }>;
    }
  >;
}): ReceiptDocumentFields {
  const fields = doc?.fields ?? {};
  const pick = (name: string) => fields[name]?.value ?? fields[name]?.content ?? undefined;
  return {
    merchant: pick("MerchantName"),
    date: pick("TransactionDate"),
    total: pick("Total"),
    tax: pick("TotalTax"),
    items: fields.Items?.valueArray?.map(
      (it: { valueObject?: Record<string, { value?: unknown }> }) => ({
        description: it.valueObject?.Description?.value,
        amount: it.valueObject?.TotalPrice?.value,
      }),
    ),
  };
}

export type ReceiptPollResult =
  | { ok: true; documents: ReceiptDocumentFields[] }
  | { ok: false; error: string; operationUrl?: string };

/** Poll a Document Intelligence operation until it succeeds, fails, or the
 * overall deadline passes. `deadlineMs` is injectable for tests; the tool
 * always uses RECEIPT_POLL_DEADLINE_MS. */
export async function pollReceiptOperation(
  opUrl: string,
  key: string,
  deadlineMs: number = RECEIPT_POLL_DEADLINE_MS,
): Promise<ReceiptPollResult> {
  const deadline = Date.now() + deadlineMs;
  const deadlineLabel =
    deadlineMs >= 60_000 ? `${deadlineMs / 60_000} minutes` : `${deadlineMs / 1000} seconds`;
  for (;;) {
    if (Date.now() >= deadline)
      return {
        ok: false,
        error: `Receipt analysis timed out after ${deadlineLabel}.`,
        operationUrl: opUrl,
      };
    await sleep(2000);
    const poll = await fetch(opUrl, {
      headers: { "Ocp-Apim-Subscription-Key": key },
      signal: AbortSignal.timeout(60_000),
    });
    if (!poll.ok) return { ok: false, error: `Receipt poll failed: HTTP ${poll.status}.` };
    const payload = await poll.json();
    const status = payload?.status;
    if (status === "succeeded") {
      const documents = payload?.analyzeResult?.documents ?? [];
      return { ok: true, documents: documents.map(receiptDocumentFields) };
    }
    if (status === "failed") return { ok: false, error: "Receipt analysis failed." };
  }
}

export function captureReceiptTool(files: Files, owner: string) {
  return defineTool({
    name: "capture_receipt",
    description:
      "Extract a draft expense record from a receipt image or PDF already in the workspace by its artifact ID (the ID shown when the user attaches a file in chat) using Azure Document Intelligence prebuilt-receipt. Returns merchant, date, total, tax, and line items as a DRAFT only — it records nothing. Josh confirms before any expense is recorded.",
    parameters: params,
    execute: async (args) => {
      const { fileId } = params.parse(args);
      const endpoint = process.env.DOCINTEL_ENDPOINT?.replace(/\/$/, "");
      const key = process.env.DOCINTEL_KEY;
      if (!endpoint || !key) {
        return { error: "Receipt capture is not configured: DOCINTEL_ENDPOINT/KEY are missing." };
      }
      let file: { name: string };
      let raw: Buffer;
      try {
        file = await files.get(owner, fileId);
        raw = await files.bytes(owner, fileId);
      } catch {
        return { error: `Could not read workspace file: ${fileId}` };
      }
      const analyzeUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-receipt:analyze?api-version=2024-11-30`;
      const start = await fetch(analyzeUrl, {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": key, "Content-Type": "application/octet-stream" },
        body: new Uint8Array(raw),
        signal: AbortSignal.timeout(120_000),
      });
      if (!start.ok) return { error: `Receipt analysis failed to start: HTTP ${start.status}.` };
      const opUrl = start.headers.get("Operation-Location");
      if (!opUrl) return { error: "Receipt analysis started but returned no operation URL." };
      const polled = await pollReceiptOperation(opUrl, key);
      if (!polled.ok)
        return polled.operationUrl
          ? { error: polled.error, operationUrl: polled.operationUrl }
          : { error: polled.error };
      // Every analysed document is returned, not just the first: a scan
      // with several receipts is several draft expenses, and silently
      // dropping all but the first would lose the rest. The top-level
      // fields still describe the first document, as before.
      const [first, ...rest] = polled.documents;
      return {
        draft: true,
        file: file.name,
        ...(first ?? {
          merchant: undefined,
          date: undefined,
          total: undefined,
          tax: undefined,
          items: undefined,
        }),
        documents: polled.documents,
        note:
          rest.length > 0
            ? `DRAFT expense record — ${polled.documents.length} documents found; confirm before recording.`
            : "DRAFT expense record — confirm before recording.",
      };
    },
  });
}
