// BMP decoding to PNG, pure JS (no dependency, no native code). BMP is the
// one common raster format the vision models do not accept, so it is
// converted here instead of refused: decode the bitmap, re-encode it as PNG
// with the shared encoder, and hand the PNG to the model.
//
// Supported: BITMAPINFOHEADER family (40/108/124 bytes), uncompressed
// (BI_RGB) 24-bit and 32-bit, 8-bit paletted, and 32-bit BI_BITFIELDS with the
// standard channel masks. Top-down (negative height) and bottom-up rows both
// work. Anything else — OS/2 core headers, RLE compression, 1/4/16-bit,
// non-standard bitfield masks, truncated data — is refused with a plain
// reason, never decoded into a guess.

import { encodePng } from "./png.ts";

export type BmpConversion =
  | { ok: true; png: Uint8Array; width: number; height: number }
  | { ok: false; error: string };

function byteAt(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) | (byteAt(bytes, offset + 1) << 8);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (byteAt(bytes, offset) |
      (byteAt(bytes, offset + 1) << 8) |
      (byteAt(bytes, offset + 2) << 16) |
      (byteAt(bytes, offset + 3) << 24)) >>>
    0
  );
}

function i32le(bytes: Uint8Array, offset: number): number {
  return (
    byteAt(bytes, offset) |
    (byteAt(bytes, offset + 1) << 8) |
    (byteAt(bytes, offset + 2) << 16) |
    (byteAt(bytes, offset + 3) << 24)
  );
}

export function bmpToPng(bytes: Uint8Array): BmpConversion {
  const fail = (reason: string): BmpConversion => ({
    ok: false,
    error: `This BMP image could not be converted for viewing in chat (${reason}). It is stored and can be opened, downloaded, or shared.`,
  });
  if (bytes.length < 54) return fail("file is too short to be a BMP image");
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) return fail("not a BMP file");
  const dataOffset = u32le(bytes, 10);
  const dibSize = u32le(bytes, 14);
  if (dibSize < 40) return fail("very old OS/2-style BMP header is not supported for viewing");
  if (dataOffset < 14 + dibSize || dataOffset > bytes.length)
    return fail("pixel data offset is outside the file");
  const width = i32le(bytes, 18);
  const rawHeight = i32le(bytes, 22);
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const planes = u16le(bytes, 26);
  const bitsPerPixel = u16le(bytes, 28);
  const compression = u32le(bytes, 30);
  if (width <= 0 || height <= 0) return fail("image dimensions are not positive");
  if (planes !== 1) return fail("unsupported plane count");
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32 && bitsPerPixel !== 8)
    return fail(`${bitsPerPixel}-bit BMP images are not supported for viewing`);
  if (compression !== 0 && compression !== 3)
    return fail("compressed BMP images are not supported for viewing");
  if (compression === 3 && bitsPerPixel !== 32)
    return fail("bitfield-compressed BMP images are only supported at 32 bits");

  // 32-bit BI_BITFIELDS is only supported with the standard channel masks,
  // which are stored in the 12 bytes after a 40-byte header.
  let redShift = 16;
  let greenShift = 8;
  let blueShift = 0;
  if (compression === 3) {
    if (dataOffset < 66) return fail("bitfield masks are missing");
    const redMask = u32le(bytes, 54);
    const greenMask = u32le(bytes, 58);
    const blueMask = u32le(bytes, 62);
    if (redMask !== 0x00ff0000 || greenMask !== 0x0000ff00 || blueMask !== 0x000000ff)
      return fail("non-standard channel masks are not supported for viewing");
    redShift = 16;
    greenShift = 8;
    blueShift = 0;
  }

  // 8-bit palette: 4-byte BGRA entries starting right after the header.
  let palette: Uint8Array | null = null;
  if (bitsPerPixel === 8) {
    const colorsUsed = u32le(bytes, 46) || 256;
    const paletteStart = 14 + dibSize;
    const paletteEnd = paletteStart + colorsUsed * 4;
    if (paletteEnd > dataOffset) return fail("palette extends past the pixel data");
    palette = bytes.subarray(paletteStart, paletteEnd);
  }

  const stride = Math.floor((bitsPerPixel * width + 31) / 32) * 4;
  const needed = stride * height;
  if (dataOffset + needed > bytes.length) return fail("pixel data is truncated");

  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const srcRow = topDown ? y : height - 1 - y;
    const srcBase = dataOffset + srcRow * stride;
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 3;
      if (bitsPerPixel === 24) {
        const src = srcBase + x * 3;
        rgb[dst] = byteAt(bytes, src + 2); // R
        rgb[dst + 1] = byteAt(bytes, src + 1); // G
        rgb[dst + 2] = byteAt(bytes, src); // B
      } else if (bitsPerPixel === 32) {
        const src = srcBase + x * 4;
        // BGRA layout; the alpha byte is dropped (PNG is opaque RGB).
        // With standard masks the channels sit at these shifts.
        const value = u32le(bytes, src);
        rgb[dst] = (value >>> redShift) & 0xff;
        rgb[dst + 1] = (value >>> greenShift) & 0xff;
        rgb[dst + 2] = (value >>> blueShift) & 0xff;
      } else {
        const index = byteAt(bytes, srcBase + x);
        if (!palette || index * 4 + 3 >= palette.length)
          return fail("palette index is outside the palette");
        const entry = palette.subarray(index * 4, index * 4 + 4);
        rgb[dst] = byteAt(entry, 2); // R
        rgb[dst + 1] = byteAt(entry, 1); // G
        rgb[dst + 2] = byteAt(entry, 0); // B
      }
    }
  }
  return { ok: true, png: encodePng(width, height, rgb), width, height };
}
