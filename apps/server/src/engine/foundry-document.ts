// DRAFT — Foundry document-intake tool for the jlsmrs/openmuse fork.
// Placement: new file apps/server/src/engine/foundry-document.ts, imported by
// apps/server/src/engine/conversation.ts and added to its defineTool list,
// same pattern as foundry-image.ts.
//
// Env (set on the openmuse-api container app at wiring time):
//   FOUNDRY_DOCAI_ENDPOINT — exact endpoint for the mistral-document-ai-2512
//     serverless deployment in the veritas-webops project. VERIFY from the
//     deployment's page in Foundry before wiring — do not guess the path.
//   FOUNDRY_DOCAI_KEY      — Foundry key for the veritas-webops resource
//     (falls back to FOUNDRY_IMAGES_KEY / OPENAI_API_KEY if unset)
//
// What it does: takes a document already in the workspace (PDF or image),
// sends it to the document-ai deployment, and returns extracted text plus
// any structured fields the deployment returns. Prep only — it never files,
// sends, or notarizes anything. The agent drafts replies/forms from the
// output; Josh approves before anything goes out.
// Notarial acts (oath, seal, witnessing, journal completion) are human-only
// and are never performed by this tool.

import { defineTool } from "@copilotkit/runtime/v2";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const docParams = z.object({
  file: z.string().trim().min(1).max(500),
  prompt: z.string().trim().max(1000).optional(),
});

export const analyzeDocumentTool = defineTool({
  name: "analyze_document",
  description:
    "Extract text and structured fields from a PDF or image already in the workspace using the owner's Foundry document-ai deployment. Returns extracted text and fields only — it files, sends, and notarizes nothing. Human approval is required before any reply, form, or filing goes out.",
  parameters: docParams,
  execute: async (args) => {
    const { file, prompt } = docParams.parse(args);
    const endpoint = process.env.FOUNDRY_DOCAI_ENDPOINT;
    const key =
      process.env.FOUNDRY_DOCAI_KEY ||
      process.env.FOUNDRY_IMAGES_KEY ||
      process.env.OPENAI_API_KEY;
    if (!endpoint || !key) {
      return { error: "Document intake is not configured: FOUNDRY_DOCAI_ENDPOINT/KEY are missing." };
    }
    let raw: Buffer;
    try {
      raw = await readFile(file);
    } catch {
      return { error: `Could not read workspace file: ${file}` };
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      // Payload shape follows the deployment's documented request format;
      // confirm against the Foundry deployment page at wiring time.
      body: JSON.stringify({
        model: "mistral-document-ai-2512",
        document: { base64: raw.toString("base64") },
        ...(prompt ? { prompt } : {}),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.status === 429) {
      return { error: "Document intake is rate limited. Retry shortly." };
    }
    if (!res.ok) {
      return { error: `Document intake failed: HTTP ${res.status}.` };
    }
    const payload = await res.json();
    return { file, extracted: payload };
  },
});
