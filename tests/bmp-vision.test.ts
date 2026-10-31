// BMP-to-PNG conversion for vision: a BMP is just a bitmap and should be
// viewable, so it is decoded and re-encoded as PNG before being sent to
// the model. These tests prove the conversion actually happens (pixel
// content preserved, not just a mime relabel) and that unsupported variants
// are refused plainly.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { bmpToPng } from "../apps/server/src/engine/bmp.ts";
import {
  isConvertibleImageMime,
  isVisionMime,
  visionParts,
} from "../apps/server/src/engine/vision.ts";

const fixtureBmp = readFileSync(
  fileURLToPath(new URL("./fixtures/vision-test.bmp", import.meta.url)),
);

function u16le(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}
function u32le(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}
function i32le(view: DataView, offset: number, value: number): void {
  view.setInt32(offset, value, true);
}

type RGB = [number, number, number];

/** Build a BMP in memory. Rows are given top-down; bottom-up storage is applied unless topDown. */
function buildBmp(options: {
  width: number;
  height: number;
  bpp: 24 | 32 | 8;
  rowsTopDown: RGB[][] | number[][];
  palette?: RGB[];
  compression?: number;
  topDown?: boolean;
}): Buffer {
  const { width, height, bpp, topDown } = options;
  const palette = options.palette ?? [];
  const paletteBytes = bpp === 8 ? palette.length * 4 : 0;
  const masksBytes = options.compression === 3 ? 12 : 0;
  const dataOffset = 54 + paletteBytes + masksBytes;
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const pixelBytes = stride * height;
  const buffer = Buffer.alloc(dataOffset + pixelBytes);
  buffer.write("BM", 0);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  u32le(view, 2, buffer.length);
  u32le(view, 10, dataOffset);
  u32le(view, 14, 40);
  i32le(view, 18, width);
  i32le(view, 22, topDown ? -height : height);
  u16le(view, 26, 1);
  u16le(view, 28, bpp);
  u32le(view, 30, options.compression ?? 0);
  if (bpp === 8) u32le(view, 46, palette.length);
  if (options.compression === 3) {
    u32le(view, 54, 0x00ff0000);
    u32le(view, 58, 0x0000ff00);
    u32le(view, 62, 0x000000ff);
  }
  palette.forEach(([r, g, b], i) => {
    const o = 54 + i * 4;
    buffer[o] = b;
    buffer[o + 1] = g;
    buffer[o + 2] = r;
    buffer[o + 3] = 0;
  });
  for (let y = 0; y < height; y++) {
    const storedRow = topDown ? y : height - 1 - y;
    const rowBase = dataOffset + storedRow * stride;
    const row = options.rowsTopDown[y] as RGB[] | number[];
    for (let x = 0; x < width; x++) {
      if (bpp === 24) {
        const [r, g, b] = row[x] as RGB;
        buffer[rowBase + x * 3] = b;
        buffer[rowBase + x * 3 + 1] = g;
        buffer[rowBase + x * 3 + 2] = r;
      } else if (bpp === 32) {
        const [r, g, b] = row[x] as RGB;
        buffer[rowBase + x * 4] = b;
        buffer[rowBase + x * 4 + 1] = g;
        buffer[rowBase + x * 4 + 2] = r;
        buffer[rowBase + x * 4 + 3] = 255;
      } else {
        buffer[rowBase + x] = row[x] as number;
      }
    }
  }
  return buffer;
}

/** Decode a PNG produced by the shared encoder (filter 0 only). */
function decodePng(png: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  assert.deepEqual(
    Array.from(png.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset + 8 <= png.length) {
    const length =
      (png[offset] ?? 0) * 0x1000000 +
      (png[offset + 1] ?? 0) * 0x10000 +
      (png[offset + 2] ?? 0) * 0x100 +
      (png[offset + 3] ?? 0);
    const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width =
        (data[0] ?? 0) * 0x1000000 +
        (data[1] ?? 0) * 0x10000 +
        (data[2] ?? 0) * 0x100 +
        (data[3] ?? 0);
      height =
        (data[4] ?? 0) * 0x1000000 +
        (data[5] ?? 0) * 0x10000 +
        (data[6] ?? 0) * 0x100 +
        (data[7] ?? 0);
      assert.equal(data[8], 8);
      assert.equal(data[9], 2);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const pixels = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (1 + stride)], 0);
    pixels.set(raw.subarray(y * (1 + stride) + 1, (y + 1) * (1 + stride)), y * stride);
  }
  return { width, height, pixels };
}

function pixel(pixels: Uint8Array, width: number, x: number, y: number): [number, number, number] {
  const o = (y * width + x) * 3;
  return [pixels[o] ?? 0, pixels[o + 1] ?? 0, pixels[o + 2] ?? 0];
}

test("green BMP fixture converts to a PNG with the same green pixels", () => {
  const converted = bmpToPng(new Uint8Array(fixtureBmp));
  assert.ok(converted.ok);
  assert.equal(converted.width, 100);
  assert.equal(converted.height, 100);
  const decoded = decodePng(converted.png);
  assert.equal(decoded.width, 100);
  assert.equal(decoded.height, 100);
  assert.deepEqual(pixel(decoded.pixels, 100, 0, 0), [0, 255, 0]);
  assert.deepEqual(pixel(decoded.pixels, 100, 99, 99), [0, 255, 0]);
});

test("visionParts sends a BMP as a PNG image part", async () => {
  assert.equal(isVisionMime("image/bmp"), false);
  assert.equal(isConvertibleImageMime("image/bmp"), true);
  const result = await visionParts("vision-test.bmp", "image/bmp", new Uint8Array(fixtureBmp));
  assert.ok(!("error" in result));
  const [text, image] = result.parts;
  assert.equal(text.type, "text");
  if (text.type === "text") assert.match(text.content, /converted to PNG/);
  assert.equal(image.type, "image");
  if (image.type === "image") {
    assert.equal(image.source.mimeType, "image/png");
    if (image.source.type === "data") {
      const decoded = decodePng(Buffer.from(image.source.value, "base64"));
      assert.deepEqual(pixel(decoded.pixels, 100, 50, 50), [0, 255, 0]);
    }
  }
});

test("24-bit pixels survive bottom-up ordering", () => {
  const red: RGB = [255, 0, 0];
  const green: RGB = [0, 255, 0];
  const blue: RGB = [0, 0, 255];
  const white: RGB = [255, 255, 255];
  const bmp = buildBmp({
    width: 2,
    height: 2,
    bpp: 24,
    rowsTopDown: [
      [red, green],
      [blue, white],
    ],
  });
  const converted = bmpToPng(new Uint8Array(bmp));
  assert.ok(converted.ok);
  const decoded = decodePng(converted.png);
  assert.deepEqual(pixel(decoded.pixels, 2, 0, 0), red);
  assert.deepEqual(pixel(decoded.pixels, 2, 1, 0), green);
  assert.deepEqual(pixel(decoded.pixels, 2, 0, 1), blue);
  assert.deepEqual(pixel(decoded.pixels, 2, 1, 1), white);
});

test("32-bit BGRA and 8-bit paletted BMPs convert", () => {
  const bmp32 = buildBmp({
    width: 2,
    height: 1,
    bpp: 32,
    rowsTopDown: [
      [
        [255, 0, 0],
        [0, 0, 255],
      ],
    ],
  });
  const converted32 = bmpToPng(new Uint8Array(bmp32));
  assert.ok(converted32.ok);
  const decoded32 = decodePng(converted32.png);
  assert.deepEqual(pixel(decoded32.pixels, 2, 0, 0), [255, 0, 0]);
  assert.deepEqual(pixel(decoded32.pixels, 2, 1, 0), [0, 0, 255]);

  const bmp8 = buildBmp({
    width: 2,
    height: 1,
    bpp: 8,
    palette: [
      [255, 0, 0],
      [0, 255, 0],
    ],
    rowsTopDown: [[0, 1]],
  });
  const converted8 = bmpToPng(new Uint8Array(bmp8));
  assert.ok(converted8.ok);
  const decoded8 = decodePng(converted8.png);
  assert.deepEqual(pixel(decoded8.pixels, 2, 0, 0), [255, 0, 0]);
  assert.deepEqual(pixel(decoded8.pixels, 2, 1, 0), [0, 255, 0]);
});

test("top-down BMPs are not flipped", () => {
  const bmp = buildBmp({
    width: 1,
    height: 2,
    bpp: 24,
    topDown: true,
    rowsTopDown: [[[255, 0, 0]], [[0, 0, 255]]],
  });
  const converted = bmpToPng(new Uint8Array(bmp));
  assert.ok(converted.ok);
  const decoded = decodePng(converted.png);
  assert.deepEqual(pixel(decoded.pixels, 1, 0, 0), [255, 0, 0]);
  assert.deepEqual(pixel(decoded.pixels, 1, 0, 1), [0, 0, 255]);
});

test("unsupported BMP variants are refused plainly", () => {
  const base = buildBmp({
    width: 2,
    height: 2,
    bpp: 24,
    rowsTopDown: [
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
      [
        [7, 8, 9],
        [10, 11, 12],
      ],
    ],
  });
  const mutate = (offset: number, value: number): Buffer => {
    const copy = Buffer.from(base);
    copy[offset] = value;
    return copy;
  };
  const cases: Array<[string, Buffer, RegExp]> = [
    [
      "RLE compression",
      (() => {
        const c = Buffer.from(base);
        c.writeUInt32LE(1, 30);
        return c;
      })(),
      /compressed/,
    ],
    [
      "16-bit",
      (() => {
        const c = Buffer.from(base);
        c.writeUInt16LE(16, 28);
        return c;
      })(),
      /16-bit/,
    ],
    ["truncated", base.subarray(0, 60), /truncated/],
    ["bad magic", mutate(0, 0x5a), /not a BMP/],
    [
      "core header",
      (() => {
        const c = Buffer.from(base);
        c.writeUInt32LE(12, 14);
        return c;
      })(),
      /OS\/2/,
    ],
  ];
  for (const [label, bytes, pattern] of cases) {
    const converted = bmpToPng(new Uint8Array(bytes));
    assert.ok(!converted.ok, label);
    assert.match(converted.error, /could not be converted/);
    assert.match(converted.error, pattern);
  }
});

test("vision cap is measured on the converted PNG, not the source BMP", async () => {
  // A large but solid-color BMP compresses to a tiny PNG, so it passes even
  // though the source is over 5 MB.
  const solidRow = Buffer.alloc(2000 * 3);
  for (let x = 0; x < 2000; x++) {
    solidRow[x * 3] = 0;
    solidRow[x * 3 + 1] = 255;
    solidRow[x * 3 + 2] = 0;
  }
  const solidPixels = Buffer.concat(Array.from({ length: 2000 }, () => solidRow));
  const solidBmp = buildBmpFromRows(2000, 2000, 24, solidPixels);
  assert.ok(solidBmp.length > 5 * 1024 * 1024);
  const solid = await visionParts("solid.bmp", "image/bmp", new Uint8Array(solidBmp));
  assert.ok(!("error" in solid), "solid BMP should pass the cap");

  // A noisy BMP of similar source size converts to a PNG over 5 MB, so it
  // is refused on the converted size.
  const noise = randomBytes(1500 * 1500 * 3);
  const noisyBmp = buildBmpFromRows(1500, 1500, 24, noise);
  const noisy = await visionParts("noise.bmp", "image/bmp", new Uint8Array(noisyBmp));
  assert.ok("error" in noisy);
  assert.match(noisy.error, /too large to view in chat/);
});

/** Build a 24-bit bottom-up BMP from raw top-down BGR row bytes (stride already padded). */
function buildBmpFromRows(width: number, height: number, bpp: 24, rowsTopDownBgr: Buffer): Buffer {
  const stride = Math.floor((bpp * width + 31) / 32) * 4;
  const dataOffset = 54;
  const buffer = Buffer.alloc(dataOffset + stride * height);
  buffer.write("BM", 0);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  view.setUint32(2, buffer.length, true);
  view.setUint32(10, dataOffset, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, bpp, true);
  view.setUint32(30, 0, true);
  for (let y = 0; y < height; y++) {
    const storedRow = height - 1 - y;
    rowsTopDownBgr.copy(buffer, dataOffset + storedRow * stride, y * stride, (y + 1) * stride);
  }
  return buffer;
}
