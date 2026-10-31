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
// Formats the models accept directly (PNG, JPEG, GIF, WebP) are sent as-is.
// BMP and TIFF are converted to PNG first (BMP by the pure-JS decoder in
// bmp.ts, TIFF by geotiff), because the models do not accept those formats.
// Anything else, or anything that fails conversion, is refused plainly.
//
// Limits are plain and cross-provider: Anthropic caps an image at 5 MB, the
// strictest of the three supported providers, so 5 MB is the cap for all.
// The cap is measured on the payload actually sent to the model — for
// converted images that is the converted PNG, not the source file. A large
// but highly compressible BMP can therefore pass while a noisy image of the
// same source size is refused; both outcomes are reported honestly.
import { fromArrayBuffer } from "geotiff";
import { bmpToPng } from "./bmp.ts";
import { encodePng } from "./png.ts";

export const VISION_MAX_BYTES = 5 * 1024 * 1024;

const VISION_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Image types the models accept directly, with no conversion. */
export function isVisionMime(mime: string): boolean {
  return VISION_MIME_TYPES.has(mime);
}

/** Image types that are converted to PNG before being sent to the model. */
export function isConvertibleImageMime(mime: string): boolean {
  return mime === "image/bmp" || mime === "image/tiff" || mime === "image/x-tiff";
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

function storedNote(): string {
  return "It is stored and can be opened, downloaded, or shared.";
}

function tooLargeError(megabytes: number): VisionResult {
  return {
    error: `This image is too large to view in chat (${megabytes.toFixed(1)} MB; images over 5 MB are not sent to the model). ${storedNote()}`,
  };
}

function imageParts(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  convertedFrom?: string,
): VisionResult {
  if (bytes.length > VISION_MAX_BYTES) return tooLargeError(bytes.length / (1024 * 1024));
  const note = convertedFrom
    ? `Attached image "${name}" (${convertedFrom}, converted to PNG for viewing).`
    : `Attached image "${name}" (${mimeType}).`;
  return {
    parts: [
      {
        type: "text",
        content: `${note} The image itself follows as the next part. Answer the user's question about it from what is visible in the image, and say plainly if something asked about is not visible — never invent details.`,
      },
      {
        type: "image",
        source: { type: "data", value: toBase64(bytes), mimeType },
      },
    ],
  };
}

async function tiffToPng(
  bytes: Uint8Array,
): Promise<{ ok: true; png: Uint8Array; pages: number } | { ok: false; error: string }> {
  try {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const tiff = await fromArrayBuffer(buffer);
    const imageCount = await tiff.getImageCount();
    const image = await tiff.getImage();
    const rgb = await image.readRGB({ interleave: true });
    const width = image.getWidth();
    const height = image.getHeight();
    if (rgb.BYTES_PER_ELEMENT !== 1 || rgb.length !== width * height * 3)
      return {
        ok: false,
        error: `This TIFF image could not be decoded for viewing in chat (unsupported sample depth or layout). ${storedNote()}`,
      };
    const rgbBytes =
      rgb instanceof Uint8Array ? rgb : new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength);
    return { ok: true, png: encodePng(width, height, rgbBytes), pages: imageCount };
  } catch {
    return {
      ok: false,
      error: `This TIFF image could not be decoded for viewing in chat. ${storedNote()}`,
    };
  }
}

export async function visionParts(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<VisionResult> {
  if (isVisionMime(mimeType)) return imageParts(name, mimeType, bytes);
  if (mimeType === "image/bmp") {
    const converted = bmpToPng(bytes);
    if (!converted.ok) return { error: converted.error };
    return imageParts(name, "image/png", converted.png, "image/bmp");
  }
  if (mimeType === "image/tiff" || mimeType === "image/x-tiff") {
    const converted = await tiffToPng(bytes);
    if (!converted.ok) return { error: converted.error };
    const result = imageParts(name, "image/png", converted.png, "image/tiff");
    if ("parts" in result && converted.pages > 1) {
      const text = result.parts[0];
      if (text && text.type === "text")
        text.content = `${text.content} (This TIFF has ${converted.pages} pages; only the first page is shown.)`;
    }
    return result;
  }
  return {
    error: `This image type (${mimeType}) cannot be viewed in chat. ${storedNote()}`,
  };
}
