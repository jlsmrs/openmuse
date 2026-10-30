// Foundry image-generation tool for OpenMuse (jlsmrs/openmuse fork).
// Placement: apps/server/src/engine/foundry-image.ts, imported by
// apps/server/src/engine/conversation.ts and added to its defineTool list
// (alongside read_calendar, search_mail, etc.).
//
// Env (set on the openmuse-api container app at wiring time):
//   FOUNDRY_IMAGES_ENDPOINT — e.g. https://veritas-webops-resource.services.ai.azure.com/openai/v1/images/generations
//   FOUNDRY_IMAGES_KEY     — Foundry key for the veritas-webops resource (transient handoff, never committed)
//   (falls back to OPENAI_API_KEY / OPENAI_BASE_URL + /images/generations if the dedicated vars are absent)
//
// Design notes (verified against the repo):
// - Tools are defineTool entries from @copilotkit/runtime/v2; execute runs server-side.
// - Tool results replay as TEXT in stored threads (textOnlyToolResult strips image
//   parts), so this tool returns a text summary + saved file path, NOT raw bytes.
// - The PNG is saved under DATA_DIR/generated-images/ so it survives restarts
//   (Azure Files) and can be moved through the app's existing file transfer.
// - Veritas rule carried into the description: prompts for business graphics stay
//   person-free unless the user explicitly asks for people; text is composited
//   in Canva afterwards because image models mangle lettering.
// - Foundry rate limit observed: 2 requests/minute — the tool returns a clear
//   "rate limited, retry shortly" error instead of hanging.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool } from "@copilotkit/runtime/v2";
import { z } from "zod";

const imageParams = z.object({
  prompt: z.string().trim().min(1).max(2000),
  size: z.enum(["1024x1024", "1024x1536", "1536x1024"]).optional(),
  filename: z.string().trim().max(100).optional(),
});

export const generateImageTool = defineTool({
  name: "generate_image",
  description:
    "Generate an image with the owner's Foundry gpt-image-2 deployment and save it as a PNG under generated-images/. Use for backgrounds, motifs, and artwork. Keep prompts person-free unless the user explicitly asks for people. Do not ask it to render text — headlines and captions are added in Canva afterwards. Rate limit is about 2 images per minute.",
  parameters: imageParams,
  execute: async (args) => {
    const { prompt, size = "1024x1024", filename } = imageParams.parse(args);
    const endpoint =
      process.env.FOUNDRY_IMAGES_ENDPOINT ||
      (process.env.OPENAI_BASE_URL
        ? `${process.env.OPENAI_BASE_URL.replace(/\/$/, "")}/images/generations`
        : undefined);
    const key = process.env.FOUNDRY_IMAGES_KEY || process.env.OPENAI_API_KEY;
    if (!endpoint || !key) {
      return {
        error: "Image generation is not configured: FOUNDRY_IMAGES_ENDPOINT/KEY are missing.",
      };
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-2", prompt, size, n: 1 }),
      signal: AbortSignal.timeout(180_000),
    });
    if (res.status === 429) {
      return { error: "Image generation is rate limited (about 2 per minute). Retry shortly." };
    }
    if (!res.ok) {
      return { error: `Image generation failed: HTTP ${res.status}.` };
    }
    const payload = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }> };
    const item = payload.data?.[0];
    if (!item) return { error: "Image generation returned no image." };
    if (!item.b64_json && !item.url) return { error: "Image generation returned no image data." };
    const raw = item.b64_json
      ? Buffer.from(item.b64_json, "base64")
      : Buffer.from(await (await fetch(item.url as string)).arrayBuffer());
    const dir = join(process.env.DATA_DIR || ".openmuse", "generated-images");
    await mkdir(dir, { recursive: true });
    const safe = (filename || `image-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, "_");
    const path = join(dir, safe.endsWith(".png") ? safe : `${safe}.png`);
    await writeFile(path, raw);
    return { file: path, bytes: raw.length, prompt, note: "Image saved; add any text in Canva." };
  },
});
