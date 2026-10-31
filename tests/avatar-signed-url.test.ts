// Custom avatars: generated images are served only through short-lived
// owner-scoped signed URLs, and the stored custom avatar resolves to a
// fresh signed URL (or null). Expiry, tampering, cross-path reuse, and
// path traversal are rejected; stock avatars are untouched.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { GeneratedImages } from "../apps/server/src/generated-images.ts";

// 1x1 red PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let db: Store;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let auth: Auth;
let files: Files;
let directory: string;
let token: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-avatar-"));
  db = await createStore();
  const config: Config = {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir: directory,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    googleRedirectUri: "http://localhost:8787/api/google/callback",
    allowedOrigins: ["http://localhost:8081"],
  };
  ({ app, auth } = await createApp(db, config));
  files = new Files(db, config, auth);
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  token = (await response.json()).token;
  await mkdir(join(directory, "generated-images"), { recursive: true });
  await writeFile(join(directory, "generated-images", "test-avatar.png"), PNG);
  await writeFile(join(directory, "generated-images", "other.png"), PNG);
  await writeFile(join(directory, "generated-images", "notes.txt"), "not an image");
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

const authed = (path: string, init?: RequestInit) =>
  app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
  });

const json = async (path: string, body: unknown) =>
  authed(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("generated images list only image files and carry signed urls", async () => {
  const response = await authed("/api/generated-images");
  assert.equal(response.status, 200);
  const list = (await response.json()) as Array<{
    name: string;
    mimeType: string;
    url: string;
  }>;
  const names = list.map((item) => item.name).sort();
  assert.deepEqual(names, ["other.png", "test-avatar.png"]);
  const item = list.find((entry) => entry.name === "test-avatar.png");
  assert.ok(item);
  assert.equal(item.mimeType, "image/png");
  assert.match(item.url, /\/api\/generated-images\/test-avatar\.png\/content\?/);
  assert.match(item.url, /owner=/);
  assert.match(item.url, /expires=/);
  assert.match(item.url, /signature=[0-9a-f]{64}/);
});

test("a signed content url serves bytes with no bearer token", async () => {
  const list = (await (await authed("/api/generated-images")).json()) as Array<{
    name: string;
    url: string;
  }>;
  const url = list.find((item) => item.name === "test-avatar.png")?.url;
  assert.ok(url);
  const response = await app.request(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
});

test("no signature and no bearer is rejected", async () => {
  const response = await app.request("/api/generated-images/test-avatar.png/content");
  assert.equal(response.status, 401);
});

test("a tampered signature is rejected", async () => {
  const list = (await (await authed("/api/generated-images")).json()) as Array<{
    name: string;
    url: string;
  }>;
  const url = list.find((item) => item.name === "test-avatar.png")?.url;
  assert.ok(url);
  const tampered = url.replace(
    /signature=([0-9a-f])/,
    (_m, c) => `signature=${c === "a" ? "b" : "a"}`,
  );
  assert.notEqual(tampered, url);
  assert.equal((await app.request(tampered)).status, 403);
});

test("a signature for one path does not open another path", async () => {
  const list = (await (await authed("/api/generated-images")).json()) as Array<{
    name: string;
    url: string;
  }>;
  const url = list.find((item) => item.name === "test-avatar.png")?.url;
  assert.ok(url);
  const reused = url.replace("test-avatar.png", "other.png");
  assert.equal((await app.request(reused)).status, 403);
});

test("an expired signature is rejected", async () => {
  const key = await readFile(join(directory, "session-signing-key"), "utf8");
  const path = "/api/generated-images/test-avatar.png/content";
  const expires = String(Date.now() - 1000);
  const signature = createHmac("sha256", key)
    .update(`local-user\n${path}\n${expires}`)
    .digest("hex");
  const url = `http://localhost:8787${path}?owner=local-user&expires=${expires}&signature=${signature}`;
  assert.equal((await app.request(url)).status, 401);
});

test("path traversal is rejected at resolve time and over http", async () => {
  const generated = new GeneratedImages({ dataDir: directory } as Config, auth);
  assert.throws(() => generated.resolvePath("../secret.png"), /not found/);
  assert.throws(() => generated.resolvePath("a/b.png"), /not found/);
  assert.throws(() => generated.resolvePath("notes.txt"), /not found/);
  assert.throws(() => generated.resolvePath("..\\secret.png"), /not found/);
  assert.equal(generated.resolvePath("test-avatar.png").mimeType, "image/png");
  const traversal = await app.request("/api/generated-images/..%2F..%2Fsecret/content");
  assert.notEqual(traversal.status, 200);
});

test("identity avatar endpoint resolves a custom generated avatar", async () => {
  const saved = await json("/api/agent/identity", {
    name: "Charlie",
    tone: "warm",
    avatar: "custom",
    customAvatar: { source: "generated", id: "test-avatar.png" },
  });
  assert.equal(saved.status, 200);
  const avatar = await authed("/api/identity/avatar");
  assert.equal(avatar.status, 200);
  const { url } = (await avatar.json()) as { url: string | null };
  assert.ok(url);
  assert.match(url, /\/api\/generated-images\/test-avatar\.png\/content\?/);
  const content = await app.request(url);
  assert.equal(content.status, 200);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), PNG);
});

test("identity avatar endpoint resolves a custom file avatar", async () => {
  const uploaded = await files.import("local-user", "avatar.png", new Uint8Array(PNG), "test");
  const saved = await json("/api/agent/identity", {
    name: "Charlie",
    tone: "warm",
    avatar: "custom",
    customAvatar: { source: "file", id: uploaded.id },
  });
  assert.equal(saved.status, 200);
  const avatar = await authed("/api/identity/avatar");
  const { url } = (await avatar.json()) as { url: string | null };
  assert.ok(url);
  assert.match(url, new RegExp(`/api/files/${uploaded.id}/content\\?`));
  assert.equal((await app.request(url)).status, 200);
});

test("identity avatar endpoint returns null for stock avatars and stale references", async () => {
  await json("/api/agent/identity", { name: "Charlie", tone: "warm", avatar: "sky" });
  assert.deepEqual(await (await authed("/api/identity/avatar")).json(), { url: null });
  await json("/api/agent/identity", {
    name: "Charlie",
    tone: "warm",
    avatar: "custom",
    customAvatar: { source: "generated", id: "missing.png" },
  });
  assert.deepEqual(await (await authed("/api/identity/avatar")).json(), { url: null });
  await json("/api/agent/identity", {
    name: "Charlie",
    tone: "warm",
    avatar: "custom",
    customAvatar: { source: "file", id: "00000000-0000-4000-8000-000000000000" },
  });
  assert.deepEqual(await (await authed("/api/identity/avatar")).json(), { url: null });
});

test("identity validation rejects bad avatar values", async () => {
  const badAvatar = await json("/api/agent/identity", {
    name: "Charlie",
    tone: "warm",
    avatar: "rainbow",
  });
  assert.equal(badAvatar.status, 422);
  const badSource = await json("/api/agent/identity", {
    name: "Charlie",
    tone: "warm",
    avatar: "custom",
    customAvatar: { source: "bogus", id: "x.png" },
  });
  assert.equal(badSource.status, 422);
});
