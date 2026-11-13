// Upload-anything: any file type can be imported, stored under its real
// extension, and round-tripped. PDFs keep their existing inspection; text
// formats are flagged readable; everything else is stored and flagged as
// not text-readable, never rejected for its type.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import {
  extensionOf,
  Files,
  isTextReadableMime,
  mimeTypeForFile,
  readabilityNote,
  sniffMimeType,
} from "../apps/server/src/files.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";

let db: Store;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let files: Files;
let directory: string;
let token: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-upload-"));
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
  ({ app } = await createApp(db, config));
  files = new Files(db, config, new Auth(db, config, "sample-signing-key"));
  const response = await app.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  token = (await response.json()).token;
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

test("mime types resolve from extension; a provided type is a claim, not evidence", () => {
  assert.equal(mimeTypeForFile("notes.txt"), "text/plain");
  assert.equal(mimeTypeForFile("notes.MD"), "text/markdown");
  assert.equal(mimeTypeForFile("data.csv"), "text/csv");
  assert.equal(mimeTypeForFile("data.json"), "application/json");
  assert.equal(
    mimeTypeForFile("report.docx"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  assert.equal(
    mimeTypeForFile("book.xlsx"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.equal(mimeTypeForFile("photo.png"), "image/png");
  assert.equal(mimeTypeForFile("archive.zip"), "application/zip");
  assert.equal(mimeTypeForFile("mystery.xyz"), "application/octet-stream");
  assert.equal(mimeTypeForFile("noextension"), "application/octet-stream");
  // A provided type that agrees with the extension is accepted; one that
  // disagrees is not — the stored type follows the filename, never the claim.
  assert.equal(mimeTypeForFile("notes.txt", "text/plain"), "text/plain");
  assert.equal(mimeTypeForFile("notes.txt", "text/csv"), "text/plain");
  assert.equal(mimeTypeForFile("notes.txt", "application/pdf"), "text/plain");
  assert.equal(mimeTypeForFile("notes.txt", "application/octet-stream"), "text/plain");
  // With no extension to contradict it, a recognised provided type is used.
  assert.equal(mimeTypeForFile("noextension", "text/csv"), "text/csv");
  assert.equal(
    mimeTypeForFile("noextension", "application/x-unknown-type"),
    "application/octet-stream",
  );
  assert.equal(extensionOf("a/b/c.DOCX"), "docx");
  assert.equal(extensionOf("noextension"), "");
  assert.equal(extensionOf("trailing."), "");
});

test("sniffed bytes beat the filename and the claimed type", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  assert.equal(sniffMimeType(png), "image/png");
  assert.equal(sniffMimeType(new TextEncoder().encode("%PDF-1.7 rest")), "application/pdf");
  assert.equal(
    sniffMimeType(new TextEncoder().encode("<!DOCTYPE html><html><body>hi")),
    "text/html",
  );
  assert.equal(sniffMimeType(new TextEncoder().encode("  <html><body>hi")), "text/html");
  assert.equal(
    sniffMimeType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">')),
    "image/svg+xml",
  );
  assert.equal(sniffMimeType(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])), "application/zip");
  assert.equal(sniffMimeType(new TextEncoder().encode("plain text, no signature")), undefined);
  assert.equal(sniffMimeType(new Uint8Array(0)), undefined);
});

test("readability flags: text readable, PDF via intake, the rest plainly flagged", () => {
  assert.equal(isTextReadableMime("text/plain"), true);
  assert.equal(isTextReadableMime("text/markdown"), true);
  assert.equal(isTextReadableMime("application/json"), true);
  assert.equal(isTextReadableMime("application/pdf"), false);
  assert.equal(isTextReadableMime("image/png"), false);
  assert.equal(isTextReadableMime("application/octet-stream"), false);
  assert.match(readabilityNote("text/plain"), /readable as text/);
  // Vision + extraction batch: PNGs are shown to the model and office docs
  // are extracted, so these no longer read as unreadable.
  assert.match(readabilityNote("image/png"), /shown to the model/);
  assert.match(readabilityNote("application/octet-stream"), /not readable as text/);
  assert.match(
    readabilityNote("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    /text is extracted/,
  );
});

test("any file type imports, stores under its real extension, and round-trips", async () => {
  const owner = "upload-anything";
  const text = await files.import(
    owner,
    "notes.txt",
    new TextEncoder().encode("hello world"),
    "test",
  );
  assert.equal(text.mimeType, "text/plain");
  assert.equal(text.pageCount, 0);
  assert.equal(text.fields, undefined);
  assert.equal(new TextDecoder().decode(await files.bytes(owner, text.id)), "hello world");

  const image = await files.import(
    owner,
    "photo.png",
    new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    "test",
  );
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(Array.from(await files.bytes(owner, image.id)), [0x89, 0x50, 0x4e, 0x47]);

  const doc = await files.import(
    owner,
    "report.docx",
    new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    "test",
  );
  assert.equal(
    doc.mimeType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );

  const mystery = await files.import(owner, "blob.xyz", new Uint8Array([1, 2, 3]), "test");
  assert.equal(mystery.mimeType, "application/octet-stream");
  assert.deepEqual(Array.from(await files.bytes(owner, mystery.id)), [1, 2, 3]);
});

test("PDFs keep their existing inspection after the change", async () => {
  const owner = "upload-pdf";
  const bytes = await createSamplePdf();
  const pdf = await files.import(owner, "sample.pdf", bytes, "test");
  assert.equal(pdf.mimeType, "application/pdf");
  assert.equal(pdf.pageCount, 2);
  assert.ok(Buffer.from(await files.bytes(owner, pdf.id)).equals(Buffer.from(bytes)));
});

test("oversize files are rejected and non-PDFs cannot be filled", async () => {
  const owner = "upload-limits";
  await assert.rejects(
    files.import(owner, "big.bin", new Uint8Array(10 * 1024 * 1024 + 1), "test"),
    /10 MB or smaller/,
  );
  const text = await files.import(owner, "notes.txt", new TextEncoder().encode("x"), "test");
  await assert.rejects(files.fill(owner, text.id, {}), /Only PDF forms can be filled/);
});

test("upload route accepts a text file and serves it with its real type", async () => {
  const form = new FormData();
  form.append("file", new File(["hello route"], "route-notes.txt", { type: "text/plain" }));
  const uploaded = await app.request("/api/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(uploaded.status, 201);
  const artifact = await uploaded.json();
  assert.equal(artifact.mimeType, "text/plain");
  const content = await app.request(`/api/files/${artifact.id}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(content.status, 200);
  assert.equal(content.headers.get("content-type"), "text/plain");
  // Stored bytes are served from the API origin: sandboxed, never sniffed.
  assert.equal(content.headers.get("content-security-policy"), "sandbox");
  assert.equal(content.headers.get("x-content-type-options"), "nosniff");
  assert.equal(await content.text(), "hello route");
});

test("an HTML file claimed as plain text is stored and served as HTML, sandboxed", async () => {
  const html = "<!DOCTYPE html><html><body><script>alert(1)</script></body></html>";
  const form = new FormData();
  form.append("file", new File([html], "notes.txt", { type: "text/plain" }));
  const uploaded = await app.request("/api/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(uploaded.status, 201);
  const artifact = await uploaded.json();
  assert.equal(artifact.mimeType, "text/html");
  const content = await app.request(`/api/files/${artifact.id}/content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(content.status, 200);
  assert.equal(content.headers.get("content-type"), "text/html");
  assert.equal(content.headers.get("content-security-policy"), "sandbox");
});

test("a ZIP-sniffed office file keeps its office type; a real ZIP stays a ZIP", async () => {
  const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  const docx = await files.import("upload-anything", "report.docx", zipBytes, "test");
  assert.equal(
    docx.mimeType,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
  const zip = await files.import("upload-anything", "archive.zip", zipBytes, "test");
  assert.equal(zip.mimeType, "application/zip");
});

test("a keyed import re-imports when the stored bytes are gone", async () => {
  const owner = "upload-anything";
  const key = JSON.stringify(["sb3-keyed-missing-bytes", "v1"]);
  const first = await files.import(
    owner,
    "keyed.txt",
    new TextEncoder().encode("first"),
    "test",
    undefined,
    key,
  );
  assert.equal(new TextDecoder().decode(await files.bytes(owner, first.id)), "first");
  await rm(join(directory, "files", `${first.id}.txt`));
  await assert.rejects(files.bytes(owner, first.id), /ENOENT/);
  const second = await files.import(
    owner,
    "keyed.txt",
    new TextEncoder().encode("second"),
    "test",
    undefined,
    key,
  );
  assert.equal(second.id, first.id, "the same operation key resolves to the same file");
  assert.equal(new TextDecoder().decode(await files.bytes(owner, second.id)), "second");
});
