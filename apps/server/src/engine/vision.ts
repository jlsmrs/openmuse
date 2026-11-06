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
// converted images that is the converted PNG, not the source file. A
// converted image whose PNG is over 5 MB is downscaled (nearest-neighbor)
// until it fits, and the reply says so; one that cannot fit even downscaled
// is refused. TIFF dimensions are checked before decoding (50-megapixel cap)
// so a small compressed file cannot force a gigapixel allocation; BMP
// decoding is already bounded by the file size and its truncation check.
import { fromArrayBuffer } from "geotiff";
import { bmpToRgb } from "./bmp.ts";
import { encodePng } from "./png.ts";

export const VISION_MAX_BYTES = 5 * 1024 * 1024;

/** Maximum decoded pixels for a converted image: bounds the ~3-bytes-per-pixel
 * RGB allocation (50M px is at most ~150 MB before downscaling). */
export const VISION_MAX_PIXELS = 50 * 1024 * 1024;

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

/** Nearest-neighbor downscale of raw RGB to a fraction of its dimensions. */
function downscaleRgb(
  rgb: Uint8Array,
  width: number,
  height: number,
  scale: number,
): { rgb: Uint8Array; width: number; height: number } {
  const newWidth = Math.max(1, Math.floor(width * scale));
  const newHeight = Math.max(1, Math.floor(height * scale));
  const out = new Uint8Array(newWidth * newHeight * 3);
  for (let y = 0; y < newHeight; y++) {
    const srcY = Math.min(height - 1, Math.floor(y / scale));
    for (let x = 0; x < newWidth; x++) {
      const srcX = Math.min(width - 1, Math.floor(x / scale));
      const src = (srcY * width + srcX) * 3;
      const dst = (y * newWidth + x) * 3;
      out[dst] = rgb[src] ?? 0;
      out[dst + 1] = rgb[src + 1] ?? 0;
      out[dst + 2] = rgb[src + 2] ?? 0;
    }
  }
  return { rgb: out, width: newWidth, height: newHeight };
}

/** Encode decoded RGB as PNG, downscaling until the PNG fits the 5 MB
 * vision cap. Returns null only if it cannot fit even at 1x1 (practically
 * unreachable — a 1x1 PNG is ~70 bytes). */
function fitPngUnderCap(
  rgb: Uint8Array,
  width: number,
  height: number,
): { png: Uint8Array; width: number; height: number; downscaled: boolean } | null {
  let png = encodePng(width, height, rgb);
  if (png.length <= VISION_MAX_BYTES) return { png, width, height, downscaled: false };
  let current = { rgb, width, height };
  for (let attempt = 0; attempt < 8 && png.length > VISION_MAX_BYTES; attempt++) {
    // Shrink by the square root of the size ratio (PNG size tracks pixel
    // count roughly), with a 10% margin so one pass usually suffices.
    const scale = Math.sqrt(VISION_MAX_BYTES / png.length) * 0.9;
    const next = downscaleRgb(current.rgb, current.width, current.height, scale);
    if (next.width === current.width && next.height === current.height) return null;
    current = next;
    png = encodePng(current.width, current.height, current.rgb);
  }
  if (png.length > VISION_MAX_BYTES) return null;
  return { png, width: current.width, height: current.height, downscaled: true };
}

/** Append a parenthesised note to the text part of a vision result, if it has one. */
function appendTextNote(result: VisionResult, note: string): void {
  if (!("parts" in result)) return;
  const text = result.parts[0];
  if (text && text.type === "text") text.content = `${text.content} (${note})`;
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

async function tiffToRgb(
  bytes: Uint8Array,
): Promise<
  | { ok: true; rgb: Uint8Array; width: number; height: number; pages: number }
  | { ok: false; error: string }
> {
  try {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const tiff = await fromArrayBuffer(buffer);
    const imageCount = await tiff.getImageCount();
    const image = await tiff.getImage();
    const width = image.getWidth();
    const height = image.getHeight();
    // Fold of the vision.ts:101 S item: refuse on declared dimensions BEFORE
    // readRGB allocates width*height*3 bytes — a small compressed TIFF can
    // declare gigapixel dimensions.
    if (width * height > VISION_MAX_PIXELS)
      return {
        ok: false,
        error: `This TIFF image is too large to view in chat (${width} by ${height} pixels; images over 50 megapixels are not decoded). ${storedNote()}`,
      };
    const rgb = await image.readRGB({ interleave: true });
    if (rgb.BYTES_PER_ELEMENT !== 1 || rgb.length !== width * height * 3)
      return {
        ok: false,
        error: `This TIFF image could not be decoded for viewing in chat (unsupported sample depth or layout). ${storedNote()}`,
      };
    const rgbBytes =
      rgb instanceof Uint8Array ? rgb : new Uint8Array(rgb.buffer, rgb.byteOffset, rgb.byteLength);
    return { ok: true, rgb: rgbBytes, width, height, pages: imageCount };
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
    const decoded = bmpToRgb(bytes);
    if (!decoded.ok) return { error: decoded.error };
    const fitted = fitPngUnderCap(decoded.rgb, decoded.width, decoded.height);
    if (!fitted)
      return {
        error: `This image is too large to view in chat even after downscaling. ${storedNote()}`,
      };
    const result = imageParts(name, "image/png", fitted.png, "image/bmp");
    if (fitted.downscaled)
      appendTextNote(
        result,
        `Downscaled from ${decoded.width}x${decoded.height} to ${fitted.width}x${fitted.height} to fit the 5 MB limit.`,
      );
    return result;
  }
  if (mimeType === "image/tiff" || mimeType === "image/x-tiff") {
    const decoded = await tiffToRgb(bytes);
    if (!decoded.ok) return { error: decoded.error };
    const fitted = fitPngUnderCap(decoded.rgb, decoded.width, decoded.height);
    if (!fitted)
      return {
        error: `This image is too large to view in chat even after downscaling. ${storedNote()}`,
      };
    const result = imageParts(name, "image/png", fitted.png, "image/tiff");
    if (fitted.downscaled)
      appendTextNote(
        result,
        `Downscaled from ${decoded.width}x${decoded.height} to ${fitted.width}x${fitted.height} to fit the 5 MB limit.`,
      );
    if (decoded.pages > 1)
      appendTextNote(result, `This TIFF has ${decoded.pages} pages; only the first page is shown.`);
    return result;
  }
  return {
    error: `This image type (${mimeType}) cannot be viewed in chat. ${storedNote()}`,
  };
}
