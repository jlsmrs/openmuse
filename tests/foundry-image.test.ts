// Foundry image-generation tool: a provider-supplied image URL is fetched
// https-only, with a timeout and a streamed byte cap, and no generated
// image over the byte cap is written to disk — from either the b64 or the
// URL path.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  FOUNDRY_IMAGE_MAX_BYTES,
  generateImageTool,
} from "../apps/server/src/engine/foundry-image.ts";

function stubFetch(t: TestContext, handler: (url: string) => Promise<Response>): void {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string) => handler(url)) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
}

async function tempDataDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "openmuse-foundry-image-"));
  const previous = {
    DATA_DIR: process.env.DATA_DIR,
    FOUNDRY_IMAGES_ENDPOINT: process.env.FOUNDRY_IMAGES_ENDPOINT,
    FOUNDRY_IMAGES_KEY: process.env.FOUNDRY_IMAGES_KEY,
  };
  process.env.DATA_DIR = dir;
  process.env.FOUNDRY_IMAGES_ENDPOINT = "https://example.invalid/images";
  process.env.FOUNDRY_IMAGES_KEY = "test-key";
  t.after(async () => {
    if (previous.DATA_DIR === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previous.DATA_DIR;
    if (previous.FOUNDRY_IMAGES_ENDPOINT === undefined) delete process.env.FOUNDRY_IMAGES_ENDPOINT;
    else process.env.FOUNDRY_IMAGES_ENDPOINT = previous.FOUNDRY_IMAGES_ENDPOINT;
    if (previous.FOUNDRY_IMAGES_KEY === undefined) delete process.env.FOUNDRY_IMAGES_KEY;
    else process.env.FOUNDRY_IMAGES_KEY = previous.FOUNDRY_IMAGES_KEY;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

type ImageResult = { file?: string; bytes?: number; error?: string };

async function executeImage(args: { prompt: string; filename?: string }): Promise<ImageResult> {
  assert.ok(generateImageTool.execute);
  return (await generateImageTool.execute(args)) as ImageResult;
}

async function generatedFiles(dir: string): Promise<string[]> {
  return readdir(join(dir, "generated-images")).catch(() => []);
}

test("a provider URL over http is refused and nothing is written", async (t) => {
  const dir = await tempDataDir(t);
  stubFetch(t, async (url) =>
    url === "https://example.invalid/images"
      ? Response.json({ data: [{ url: "http://example.invalid/img.png" }] }, { status: 200 })
      : new Response("unexpected fetch", { status: 500 }),
  );
  const result = await executeImage({ prompt: "a hill" });
  assert.match(result.error ?? "", /non-https/);
  assert.deepEqual(await generatedFiles(dir), []);
});

test("a provider URL whose declared size is over the cap is refused before reading", async (t) => {
  const dir = await tempDataDir(t);
  stubFetch(t, async (url) =>
    url === "https://example.invalid/images"
      ? Response.json({ data: [{ url: "https://example.invalid/img.png" }] }, { status: 200 })
      : new Response("x".repeat(10), {
          status: 200,
          headers: { "content-length": String(FOUNDRY_IMAGE_MAX_BYTES + 1) },
        }),
  );
  const result = await executeImage({ prompt: "a hill" });
  assert.match(result.error ?? "", /over the 25 MB limit/);
  assert.deepEqual(await generatedFiles(dir), []);
});

test("a provider URL that streams past the cap is cut off and nothing is written", async (t) => {
  const dir = await tempDataDir(t);
  const overCap = new ReadableStream({
    start(controller) {
      const chunk = new Uint8Array(1024 * 1024);
      for (let i = 0; i < FOUNDRY_IMAGE_MAX_BYTES / (1024 * 1024) + 1; i++)
        controller.enqueue(chunk);
      controller.close();
    },
  });
  stubFetch(t, async (url) =>
    url === "https://example.invalid/images"
      ? Response.json({ data: [{ url: "https://example.invalid/img.png" }] }, { status: 200 })
      : new Response(overCap, { status: 200 }),
  );
  const result = await executeImage({ prompt: "a hill" });
  assert.match(result.error ?? "", /over the 25 MB limit/);
  assert.deepEqual(await generatedFiles(dir), []);
});

test("a small provider URL image is downloaded and written", async (t) => {
  await tempDataDir(t);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  stubFetch(t, async (url) =>
    url === "https://example.invalid/images"
      ? Response.json({ data: [{ url: "https://example.invalid/img.png" }] }, { status: 200 })
      : new Response(png, { status: 200 }),
  );
  const result = await executeImage({ prompt: "a hill", filename: "hill" });
  assert.equal(result.error, undefined);
  assert.equal(result.bytes, png.length);
  assert.ok(result.file);
  assert.deepEqual(await readFile(result.file), png);
});

test("b64 image bytes over the cap are refused and nothing is written", async (t) => {
  const dir = await tempDataDir(t);
  const big = Buffer.alloc(FOUNDRY_IMAGE_MAX_BYTES + 1);
  stubFetch(t, async () =>
    Response.json({ data: [{ b64_json: big.toString("base64") }] }, { status: 200 }),
  );
  const result = await executeImage({ prompt: "a hill" });
  assert.match(result.error ?? "", /over the 25 MB limit/);
  assert.deepEqual(await generatedFiles(dir), []);
});

test("small b64 image bytes are still written", async (t) => {
  await tempDataDir(t);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  stubFetch(t, async () =>
    Response.json({ data: [{ b64_json: png.toString("base64") }] }, { status: 200 }),
  );
  const result = await executeImage({ prompt: "a hill", filename: "hill-b64" });
  assert.equal(result.error, undefined);
  assert.equal(result.bytes, png.length);
  assert.ok(result.file);
  assert.deepEqual(await readFile(result.file), png);
});
