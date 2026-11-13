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

/** Timeout for downloading a provider-supplied image URL. */
export const FOUNDRY_IMAGE_FETCH_TIMEOUT_MS = 60_000;
/** Maximum generated-image bytes written to disk: a gpt-image-2 PNG at the
 * largest offered size is a few MB, so 25 MB is generous headroom and still
 * bounds what one tool call can materialize. */
export const FOUNDRY_IMAGE_MAX_BYTES = 25 * 1024 * 1024;

/** Download a provider-supplied image URL with the guards the direct fetch
 * lacked: https-only, a timeout, and a streamed byte cap (a lying
 * Content-Length cannot smuggle a larger body past the cap). */
export async function downloadImageBytes(url: string): Promise<Buffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Image generation returned an invalid image URL.");
  }
  if (parsed.protocol !== "https:")
    throw new Error("Image generation returned a non-https image URL; refusing to fetch it.");
  const res = await fetch(url, { signal: AbortSignal.timeout(FOUNDRY_IMAGE_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}.`);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > FOUNDRY_IMAGE_MAX_BYTES)
    throw new Error(
      `Image generation returned an image over the ${FOUNDRY_IMAGE_MAX_BYTES / (1024 * 1024)} MB limit.`,
    );
  if (!res.body) throw new Error("Image download failed: no response body.");
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      if (total > FOUNDRY_IMAGE_MAX_BYTES) {
        await reader.cancel();
        throw new Error(
          `Image generation returned an image over the ${FOUNDRY_IMAGE_MAX_BYTES / (1024 * 1024)} MB limit.`,
        );
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks);
}

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
    let raw: Buffer;
    try {
      raw = item.b64_json
        ? Buffer.from(item.b64_json, "base64")
        : await downloadImageBytes(item.url as string);
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Image download failed." };
    }
    if (raw.length > FOUNDRY_IMAGE_MAX_BYTES)
      return {
        error: `Image generation returned an image over the ${FOUNDRY_IMAGE_MAX_BYTES / (1024 * 1024)} MB limit.`,
      };
    const dir = join(process.env.DATA_DIR || ".openmuse", "generated-images");
    await mkdir(dir, { recursive: true });
    const safe = (filename || `image-${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, "_");
    const path = join(dir, safe.endsWith(".png") ? safe : `${safe}.png`);
    await writeFile(path, raw);
    return { file: path, bytes: raw.length, prompt, note: "Image saved; add any text in Canva." };
  },
});
