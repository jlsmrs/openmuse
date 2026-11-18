import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentService } from "../apps/server/src/engine/service.ts";
import { FILE_PULL_AUDIT_COLLECTION, type FilePullAudit } from "../apps/server/src/files.ts";
import type { Artifact } from "../packages/domain/src/index.ts";

let db: Store;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let agent: AgentService;
let config: Config;
let token: string;
let directory: string;
const headers = () => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
const fixture = (name: string): Promise<Buffer> =>
  readFile(new URL(`./fixtures/${name}`, import.meta.url));

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-xfa-search-pull-"));
  db = await createStore();
  config = {
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
  ({ app, agent } = await createApp(db, config));
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

test("W-9 imports with formKind persisted and field-less XFA stores with fields []", async () => {
  const w9 = await agent.files.import("veritas", "fw9.pdf", await fixture("fw9.pdf"), "test");
  assert.equal(w9.formKind, "xfa-static");
  assert.equal(w9.pageCount, 6);
  assert.equal(w9.fields?.length, 17);
  const fieldless = await agent.files.import(
    "veritas",
    "xfa-fieldless.pdf",
    await fixture("xfa-fieldless.pdf"),
    "test",
  );
  assert.equal(fieldless.formKind, "xfa-static");
  assert.deepEqual(fieldless.fields, []);
  assert.equal((await agent.files.get("veritas", fieldless.id)).id, fieldless.id);
  assert.deepEqual(
    new Uint8Array(await agent.files.bytes("veritas", fieldless.id)),
    new Uint8Array(await fixture("xfa-fieldless.pdf")),
  );
  const text = await agent.files.import(
    "veritas",
    "notes.txt",
    new TextEncoder().encode("Call the client back about the closing."),
    "test",
  );
  assert.equal(text.formKind, "none");
  assert.equal(text.pageCount, 0);
});

test("search matches by name, field name, and field value — owner-scoped, no snippets", async () => {
  const owner = "search-owner";
  const w9 = await agent.files.import(owner, "fw9.pdf", await fixture("fw9.pdf"), "test");
  const staticFile = await agent.files.import(
    owner,
    "xfa-static.pdf",
    await fixture("xfa-static.pdf"),
    "test",
  );
  const dynamic = await agent.files.import(
    owner,
    "xfa-dynamic.pdf",
    await fixture("xfa-dynamic.pdf"),
    "test",
  );
  // Another owner's file with the same searchable values must never match.
  await agent.files.import("other-owner", "fw9.pdf", await fixture("fw9.pdf"), "test");

  const byName = await agent.files.search(owner, { q: "fw9" });
  assert.deepEqual(
    byName.map((file) => file.id),
    [w9.id],
  );
  const byFieldName = await agent.files.search(owner, { q: "f1_01" });
  assert.deepEqual(
    byFieldName.map((file) => file.id),
    [w9.id],
  );
  const byFieldValue = await agent.files.search(owner, { q: "josh@example.com" });
  assert.deepEqual(
    byFieldValue.map((file) => file.id),
    [staticFile.id],
  );
  const byKind = await agent.files.search(owner, { formKind: "xfa-dynamic" });
  assert.deepEqual(
    byKind.map((file) => file.id),
    [dynamic.id],
  );
  const byKindAndQuery = await agent.files.search(owner, {
    q: "form",
    formKind: "xfa-static",
  });
  assert.ok(byKindAndQuery.some((file) => file.id === staticFile.id));
  assert.ok(byKindAndQuery.every((file) => file.id !== dynamic.id));
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.deepEqual(await agent.files.search(owner, { from: future }), []);
  const past = new Date(Date.now() - 86400000).toISOString();
  assert.ok((await agent.files.search(owner, { to: past })).length === 0);
  assert.ok((await agent.files.search(owner, { from: "2000-01-01" })).length >= 3);
  const all = await agent.files.search(owner, {});
  assert.ok(!("snippet" in all[0]));
  assert.ok(all.every((file) => !("snippet" in file)));
});

test("search route validates query params and stays owner-scoped", async () => {
  const response = await app.request("/api/files/search?q=fw9", { headers: headers() });
  assert.equal(response.status, 200);
  const badKind = await app.request("/api/files/search?formKind=bogus", {
    headers: headers(),
  });
  assert.equal(badKind.status, 422);
  const badDate = await app.request("/api/files/search?from=not-a-date", {
    headers: headers(),
  });
  assert.equal(badDate.status, 422);
});

test("pull copies a PDF across owners with lineage, source, and an audit entry", async () => {
  const sourceBytes = await fixture("fw9.pdf");
  const source = await agent.files.import("summerstead", "fw9.pdf", sourceBytes, "test");
  const pulled = await agent.files.pull("summerstead", source.id, "veritas");
  assert.notEqual(pulled.id, source.id);
  assert.equal(pulled.parentId, source.id);
  assert.equal(pulled.source, `Pulled from summerstead/${source.id}`);
  assert.equal(pulled.formKind, "xfa-static");
  assert.equal(pulled.fields?.length, 17);
  assert.equal(pulled.name, "fw9.pdf");
  assert.deepEqual(
    new Uint8Array(await agent.files.bytes("veritas", pulled.id)),
    new Uint8Array(sourceBytes),
  );
  // The source is untouched.
  assert.deepEqual(
    new Uint8Array(await agent.files.bytes("summerstead", source.id)),
    new Uint8Array(sourceBytes),
  );
  assert.equal((await agent.files.get("summerstead", source.id)).parentId, undefined);
  // The pulled URL is signed for the target owner.
  assert.match(pulled.url, new RegExp(`/api/files/${pulled.id}/content`));
  const audits = await db.list<FilePullAudit>("system", FILE_PULL_AUDIT_COLLECTION);
  const audit = audits.find((entry) => entry.fileId === pulled.id);
  assert.ok(audit);
  assert.equal(audit?.who, "summerstead");
  assert.equal(audit?.from, "summerstead");
  assert.equal(audit?.to, "veritas");
  assert.equal(audit?.sourceId, source.id);
  assert.equal(audit?.fileName, "fw9.pdf");
  assert.ok(audit?.when);
});

test("pull is type-agnostic: a text file and an Office doc pull exactly like a PDF", async () => {
  const textBytes = new TextEncoder().encode("Veritas intake notes — do not mingle.");
  const text = await agent.files.import("summerstead", "intake.txt", textBytes, "test");
  const pulledText = await agent.files.pull("summerstead", text.id, "veritas");
  assert.equal(pulledText.mimeType, "text/plain");
  assert.equal(pulledText.parentId, text.id);
  assert.equal(pulledText.source, `Pulled from summerstead/${text.id}`);
  assert.deepEqual(
    new TextDecoder().decode(await agent.files.bytes("veritas", pulledText.id)),
    "Veritas intake notes — do not mingle.",
  );
  const docBytes = await fixture("upload-test.doc");
  const doc = await agent.files.import("summerstead", "upload-test.doc", docBytes, "test");
  const pulledDoc = await agent.files.pull("summerstead", doc.id, "veritas");
  assert.equal(pulledDoc.mimeType, "application/msword");
  assert.equal(pulledDoc.parentId, doc.id);
  assert.deepEqual(
    new Uint8Array(await agent.files.bytes("veritas", pulledDoc.id)),
    new Uint8Array(docBytes),
  );
  const audits = await db.list<FilePullAudit>("system", FILE_PULL_AUDIT_COLLECTION);
  assert.ok(audits.some((entry) => entry.fileId === pulledText.id));
  assert.ok(audits.some((entry) => entry.fileId === pulledDoc.id));
});

test("pull copies appliedFields when present", async () => {
  const source = await agent.files.import(
    "summerstead",
    "notes.txt",
    new TextEncoder().encode("filled form notes"),
    "test",
  );
  const stored = await db.get<Artifact>("summerstead", "files", source.id);
  assert.ok(stored);
  await db.put("summerstead", "files", {
    ...stored,
    appliedFields: [{ name: "form.fullName", value: "Joshua Lewis Summers", type: "text" }],
  });
  const pulled = await agent.files.pull("summerstead", source.id, "veritas");
  assert.deepEqual(pulled.appliedFields, [
    { name: "form.fullName", value: "Joshua Lewis Summers", type: "text" },
  ]);
});

test("multi-hop lineage reconstructs A→B→C from parentId and from audit entries", async () => {
  const source = await agent.files.import("page-one", "fw9.pdf", await fixture("fw9.pdf"), "test");
  const hopB = await agent.files.pull("page-one", source.id, "veritas");
  const hopC = await agent.files.pull("veritas", hopB.id, "summerstead");
  assert.equal(hopB.parentId, source.id);
  assert.equal(hopC.parentId, hopB.id);
  const chain = await agent.files.lineage("summerstead", hopC.id);
  assert.deepEqual(
    chain.map((file) => file.id),
    [source.id, hopB.id, hopC.id],
  );
  assert.deepEqual(
    chain.map((file) => file.parentId),
    [undefined, source.id, hopB.id],
  );
  const audits = await db.list<FilePullAudit>("system", FILE_PULL_AUDIT_COLLECTION);
  const hopAudits = audits.filter((entry) => entry.fileId === hopB.id || entry.fileId === hopC.id);
  assert.equal(hopAudits.length, 2);
  const byFile = new Map(hopAudits.map((entry) => [entry.fileId, entry]));
  assert.deepEqual([byFile.get(hopB.id)?.from, byFile.get(hopB.id)?.to], ["page-one", "veritas"]);
  assert.deepEqual(
    [byFile.get(hopC.id)?.from, byFile.get(hopC.id)?.to],
    ["veritas", "summerstead"],
  );
  // A file with no pull history has a one-entry lineage: itself.
  assert.deepEqual(
    (await agent.files.lineage("page-one", source.id)).map((file) => file.id),
    [source.id],
  );
});

test("pull guards: same owner, invalid toOwner, nonexistent id, no read access", async () => {
  const source = await agent.files.import(
    "guard-owner",
    "fw9.pdf",
    await fixture("fw9.pdf"),
    "test",
  );
  await assert.rejects(
    agent.files.pull("guard-owner", source.id, "guard-owner"),
    /already in this workspace/,
  );
  for (const bad of ["", "   ", "a/b", "a\\b", "a\u0001b", "a\u007fb"]) {
    await assert.rejects(agent.files.pull("guard-owner", source.id, bad), /target workspace/i);
  }
  await assert.rejects(
    agent.files.pull("guard-owner", randomUUID(), "veritas"),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 404);
      return true;
    },
  );
  // Pulling a file the caller cannot read fails 404, not 403-with-details.
  await assert.rejects(agent.files.pull("veritas", source.id, "summerstead"), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 404);
    assert.match((error as Error).message, /not found/i);
    return true;
  });
  // A failed pull writes no audit entry.
  const before = (await db.list<FilePullAudit>("system", FILE_PULL_AUDIT_COLLECTION)).length;
  await assert.rejects(agent.files.pull("guard-owner", source.id, "guard-owner"), /already/);
  assert.equal((await db.list<FilePullAudit>("system", FILE_PULL_AUDIT_COLLECTION)).length, before);
});

test("pull route copies across owners and enforces its guards over HTTP", async () => {
  const bytes = await fixture("xfa-static.pdf");
  const source = await agent.files.import("local-user", "xfa-static.pdf", bytes, "test");
  const response = await app.request(`/api/files/${source.id}/pull`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ toOwner: "veritas" }),
  });
  assert.equal(response.status, 201);
  const pulled: Artifact = await response.json();
  assert.equal(pulled.parentId, source.id);
  assert.equal(pulled.source, `Pulled from local-user/${source.id}`);
  assert.equal(pulled.formKind, "xfa-static");
  assert.equal(pulled.fields?.length, 6);
  const sameOwner = await app.request(`/api/files/${source.id}/pull`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ toOwner: "local-user" }),
  });
  assert.equal(sameOwner.status, 422);
  const badOwner = await app.request(`/api/files/${source.id}/pull`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ toOwner: "a/b" }),
  });
  assert.equal(badOwner.status, 422);
  const missing = await app.request(`/api/files/${randomUUID()}/pull`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ toOwner: "veritas" }),
  });
  assert.equal(missing.status, 404);
});
