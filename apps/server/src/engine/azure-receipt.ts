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

import { defineTool } from "@copilotkit/runtime/v2";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const params = z.object({
  file: z.string().trim().min(1).max(500),
});

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const captureReceiptTool = defineTool({
  name: "capture_receipt",
  description:
    "Extract a draft expense record from a receipt image or PDF already in the workspace using Azure Document Intelligence prebuilt-receipt. Returns merchant, date, total, tax, and line items as a DRAFT only — it records nothing. Josh confirms before any expense is recorded.",
  parameters: params,
  execute: async (args) => {
    const { file } = params.parse(args);
    const endpoint = process.env.DOCINTEL_ENDPOINT?.replace(/\/$/, "");
    const key = process.env.DOCINTEL_KEY;
    if (!endpoint || !key) {
      return { error: "Receipt capture is not configured: DOCINTEL_ENDPOINT/KEY are missing." };
    }
    let raw: Buffer;
    try {
      raw = await readFile(file);
    } catch {
      return { error: `Could not read workspace file: ${file}` };
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
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const poll = await fetch(opUrl, {
        headers: { "Ocp-Apim-Subscription-Key": key },
        signal: AbortSignal.timeout(60_000),
      });
      if (!poll.ok) return { error: `Receipt poll failed: HTTP ${poll.status}.` };
      const payload = await poll.json();
      const status = payload?.status;
      if (status === "succeeded") {
        const doc = payload?.analyzeResult?.documents?.[0];
        const fields = doc?.fields ?? {};
        const pick = (name: string) => fields[name]?.value ?? fields[name]?.content ?? undefined;
        return {
          draft: true,
          file,
          merchant: pick("MerchantName"),
          date: pick("TransactionDate"),
          total: pick("Total"),
          tax: pick("TotalTax"),
          items: fields["Items"]?.valueArray?.map((it: { valueObject?: Record<string, { value?: unknown }> }) => ({
            description: it.valueObject?.["Description"]?.value,
            amount: it.valueObject?.["TotalPrice"]?.value,
          })),
          note: "DRAFT expense record — confirm before recording.",
        };
      }
      if (status === "failed") return { error: "Receipt analysis failed." };
    }
    return { error: "Receipt analysis timed out." };
  },
});
