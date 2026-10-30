// Vision: image content parts for read_workspace_file, so Charlie can look at
// an attached image and describe what it shows.
//
// Mechanism (no new model wiring): the tool returns a TanStack content-part
// array, which the chat loop passes through to the configured model adapter
// as multimodal input (see normalizeToolResult in @tanstack/ai and the
// adapter image conversions). Stored thread history keeps only the text parts
// (see textOnlyToolResult in tanstack-agent.ts), so no image bytes are saved
// into the thread. Vision therefore works with whatever model is configured
// in MODEL — provided that model accepts image input. A text-only model
// rejects the image parts with a provider error, which surfaces as a run
// error, never as an invented description.
//
// Limits are plain and cross-provider: Anthropic caps an image at 5 MB, the
// strictest of the three supported providers, so 5 MB is the cap for all.
export const VISION_MAX_BYTES = 5 * 1024 * 1024;

const VISION_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isVisionMime(mime: string): boolean {
  return VISION_MIME_TYPES.has(mime);
}

export type VisionPart =
  | { type: "text"; content: string }
  | {
      type: "image";
      source: { type: "data"; value: string; mimeType: string };
    };

export type VisionResult = { parts: VisionPart[] } | { error: string };

function toBase64(bytes: Uint8Array): string {
  return Buffer.isBuffer(bytes) ? bytes.toString("base64") : Buffer.from(bytes).toString("base64");
}

export function visionParts(name: string, mimeType: string, bytes: Uint8Array): VisionResult {
  if (!isVisionMime(mimeType))
    return {
      error: `This image type (${mimeType}) cannot be viewed in chat. It is stored and can be opened, downloaded, or shared.`,
    };
  if (bytes.length > VISION_MAX_BYTES)
    return {
      error: `This image is too large to view in chat (${(bytes.length / (1024 * 1024)).toFixed(1)} MB; images over 5 MB are not sent to the model). It is stored and can be opened, downloaded, or shared.`,
    };
  return {
    parts: [
      {
        type: "text",
        content: `Attached image "${name}" (${mimeType}). The image itself follows as the next part. Answer the user's question about it from what is visible in the image, and say plainly if something asked about is not visible — never invent details.`,
      },
      {
        type: "image",
        source: { type: "data", value: toBase64(bytes), mimeType },
      },
    ],
  };
}
