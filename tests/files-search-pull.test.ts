import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../apps/server/src/app.ts";
import type { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import type { AgentService } from "../apps/server/src/engine/service.ts";
import { FILE_PULL_AUDIT_COLLECTION, type FilePullAudit, Files } from "../apps/server/src/files.ts";
import type { Artifact } from "../packages/domain/src/index.ts";
import { createXfaPdf } from "./xfa-fixtures.ts";

let db: Store;
let app: Awaited<ReturnType<typeof createApp>>["app"];
let agent: AgentService;
let auth: Auth;
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
  ({ app, agent, auth } = await createApp(db, config));
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

/** A Store that fails every write to the pull-audit collection AND every
 * files-row removal, including writes made inside a transaction — so the
 * atomicity test can prove the copy and its audit entry commit or roll
 * back together. The pre-fix pull swallowed a failed rollback remove,
 * which left a visible, unaudited copy in exactly this double fault. */
function failingAuditStore(store: Store): Store {
  const wrap = (target: Store): Store =>
    new Proxy(target, {
      get(targetStore, property, receiver) {
        if (property === "put") {
          return async (owner: string, kind: string, value: { id: string }) => {
            if (kind === FILE_PULL_AUDIT_COLLECTION)
              throw new Error("audit write failed (forced by test)");
            return targetStore.put(owner, kind, value);
          };
        }
        if (property === "remove") {
          return async (owner: string, kind: string, id: string) => {
            if (kind === "files") throw new Error("rollback remove failed (forced by test)");
            return targetStore.remove(owner, kind, id);
          };
        }
        if (property === "transaction") {
          return async (work: (tx: Store) => Promise<unknown>) =>
            targetStore.transaction(async (tx) => work(wrap(tx)));
        }
        return Reflect.get(targetStore, property, receiver);
      },
    });
  return wrap(store);
}

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
  // Owner isolation over HTTP (M6b, round 4): a second owner's file
  // with the SAME name must not appear in the session owner's results,
  // while the session owner's own upload does. Status codes alone
  // cannot show this — the result ids are the assertion.
  const other = await agent.files.import(
    "other-owner",
    "fw9.pdf",
    await fixture("fw9.pdf"),
    "test",
  );
  const uploadForm = new FormData();
  uploadForm.append(
    "file",
    new File([new Uint8Array(await fixture("fw9.pdf"))], "fw9.pdf", {
      type: "application/pdf",
    }),
  );
  const upload = await app.request("/api/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: uploadForm,
  });
  assert.equal(upload.status, 201);
  const uploaded = (await upload.json()) as { id: string };
  const searchResponse = await app.request("/api/files/search?q=fw9", {
    headers: headers(),
  });
  assert.equal(searchResponse.status, 200);
  const results = (await searchResponse.json()) as { id: string }[];
  assert.ok(
    results.some((file) => file.id === uploaded.id),
    "session owner's own fw9 must be in its search results",
  );
  assert.ok(
    results.every((file) => file.id !== other.id),
    "a second owner's fw9 must not appear in the session owner's search results",
  );
});

test("pull is atomic: a failed audit write leaves no visible, unaudited copy", async () => {
  const source = await agent.files.import(
    "atomic-owner",
    "fw9.pdf",
    await fixture("fw9.pdf"),
    "test",
  );
  const failingFiles = new Files(failingAuditStore(db), config, {
    sign: (_owner: string, path: string) => path,
  } as unknown as Auth);
  const auditsBefore = (await db.list<FilePullAudit>("system", FILE_PULL_AUDIT_COLLECTION)).length;
  const filesBefore = await readdir(join(directory, "files"));
  await assert.rejects(
    failingFiles.pull("atomic-owner", source.id, "veritas"),
    /audit write failed/,
  );
  // No copy is visible under the target owner…
  assert.deepEqual(
    (await agent.files.list("veritas")).filter((file) => file.parentId === source.id),
    [],
  );
  // …no audit entry was written…
  assert.equal(
    (await db.list<FilePullAudit>("system", FILE_PULL_AUDIT_COLLECTION)).length,
    auditsBefore,
  );
  // …and the bytes file written before the failed transaction was removed.
  assert.deepEqual(await readdir(join(directory, "files")), filesBefore);
});

// B1 fix round 6 (panel re-review #5, chunk B, Nov 19, 2026) ----------------
// Probe B1 shape: a Store whose transaction commits the callback's work
// and THEN throws, simulating a lost COMMIT acknowledgement. The copy
// row and its audit entry stay committed, so the bytes file must NOT
// be deleted — deleting it would leave a committed artifact pointing
// at missing bytes. Only a failure inside the work callback
// establishes a rollback (see the atomicity test above, where the
// bytes ARE removed).
test("pull retains the bytes when the transaction outcome is indeterminate (B-1, round 6)", async () => {
  const source = await agent.files.import(
    "indeterminate-owner",
    "fw9.pdf",
    await fixture("fw9.pdf"),
    "test",
  );
  const wrapped: Store = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async (work: (tx: Store) => Promise<unknown>) => {
          await target.transaction(work);
          throw new Error("COMMIT acknowledgement lost (simulated)");
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const wrappedFiles = new Files(wrapped, config, {
    sign: (_owner: string, path: string) => path,
  } as unknown as Auth);
  await assert.rejects(
    wrappedFiles.pull("indeterminate-owner", source.id, "bob"),
    /COMMIT acknowledgement lost/,
  );
  // The copy is committed under the target owner…
  const copies = (await agent.files.list("bob")).filter((file) => file.parentId === source.id);
  assert.equal(copies.length, 1);
  const copy = copies[0];
  assert.ok(copy);
  // …its audit entry is committed…
  assert.equal(
    (await db.list<FilePullAudit>("system", FILE_PULL_AUDIT_COLLECTION)).filter(
      (audit) => audit.fileId === copy.id,
    ).length,
    1,
  );
  // …and the copy's bytes are still readable, byte-identical to the source.
  const bytes = await new Files(db, config, auth).bytes("bob", copy.id);
  assert.deepEqual(Buffer.from(bytes), await fixture("fw9.pdf"));
});

test("lineage returns provenance-only rows: no field values cross owners", async () => {
  const source = await agent.files.import(
    "lineage-a",
    "xfa-static.pdf",
    await fixture("xfa-static.pdf"),
    "test",
  );
  const hopB = await agent.files.pull("lineage-a", source.id, "lineage-b");
  const hopC = await agent.files.pull("lineage-b", hopB.id, "lineage-c");
  const chain = await agent.files.lineage("lineage-c", hopC.id);
  assert.deepEqual(
    chain.map((file) => file.id),
    [source.id, hopB.id, hopC.id],
  );
  const allowed = new Set([
    "id",
    "name",
    "mimeType",
    "size",
    "pageCount",
    "formKind",
    "source",
    "parentId",
    "createdAt",
  ]);
  for (const row of chain) {
    for (const key of Object.keys(row)) assert.ok(allowed.has(key), `lineage row leaks ${key}`);
  }
  // The static fixture's field values must not appear anywhere in the chain.
  assert.ok(!JSON.stringify(chain).includes("Joshua Lewis Summers"));
  assert.ok(!JSON.stringify(chain).includes("josh@example.com"));
});

test("search rejects from after to and treats to as inclusive of the whole day", async () => {
  const owner = "date-owner";
  const file = await agent.files.import(
    owner,
    "xfa-static.pdf",
    await fixture("xfa-static.pdf"),
    "test",
  );
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  assert.ok((await agent.files.search(owner, { to: today })).some((row) => row.id === file.id));
  assert.deepEqual(await agent.files.search(owner, { to: yesterday }), []);
  await assert.rejects(
    agent.files.search(owner, { from: today, to: yesterday }),
    /from.*on or before.*to/i,
  );
  const badRange = await app.request(`/api/files/search?from=${today}&to=${yesterday}`, {
    headers: headers(),
  });
  assert.equal(badRange.status, 422);
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
  // The signature itself binds the TARGET owner, not just the URL path:
  // verify() returns the signing owner, and the same URL with the owner
  // swapped to the source fails verification.
  assert.equal(auth.verify(new URL(pulled.url)), "veritas");
  const tampered = new URL(pulled.url);
  tampered.searchParams.set("owner", "summerstead");
  assert.throws(() => auth.verify(tampered), /Invalid access link/);
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

// --- B1 fix round 2 (panel re-review R-9 + test adequacy, Nov 18, 2026) ---

test("R-9: legacy rows without formKind report formKind none in list and search", async () => {
  const legacy = {
    id: randomUUID(),
    name: "old-form.pdf",
    mimeType: "application/pdf",
    size: 1234,
    pageCount: 2,
    fields: [],
    url: "",
    createdAt: "2026-11-01T10:00:00.000Z",
    source: "test",
  } satisfies Artifact;
  await db.put("legacy-owner", "files", legacy);
  const listed = await agent.files.list("legacy-owner");
  assert.equal(listed.find((file) => file.id === legacy.id)?.formKind, "none");
  const found = await agent.files.search("legacy-owner", { formKind: "none" });
  assert.ok(found.some((file) => file.id === legacy.id));
  assert.equal(found.find((file) => file.id === legacy.id)?.formKind, "none");
  // The fallback is a projection, not a backfill: the stored row itself
  // still has no formKind on it.
  const stored = await db.get<Artifact>("legacy-owner", "files", legacy.id);
  assert.equal(stored?.formKind, undefined);
});

test("field-less XFA is searchable by name and pulls like any other file", async () => {
  const owner = "fieldless-owner";
  const fieldless = await agent.files.import(
    owner,
    "xfa-fieldless.pdf",
    await fixture("xfa-fieldless.pdf"),
    "test",
  );
  assert.deepEqual(
    (await agent.files.search(owner, { q: "xfa-fieldless" })).map((file) => file.id),
    [fieldless.id],
  );
  assert.deepEqual(
    (await agent.files.search(owner, { formKind: "xfa-static" })).map((file) => file.id),
    [fieldless.id],
  );
  const pulled = await agent.files.pull(owner, fieldless.id, "veritas");
  assert.equal(pulled.formKind, "xfa-static");
  assert.deepEqual(pulled.fields, []);
  assert.equal(pulled.parentId, fieldless.id);
  assert.equal(pulled.source, `Pulled from ${owner}/${fieldless.id}`);
  assert.deepEqual(
    new Uint8Array(await agent.files.bytes("veritas", pulled.id)),
    new Uint8Array(await fixture("xfa-fieldless.pdf")),
  );
  const audits = await db.list<FilePullAudit>("system", FILE_PULL_AUDIT_COLLECTION);
  assert.ok(audits.some((entry) => entry.fileId === pulled.id));
});

test("pull is type-agnostic: image, audio, video, and unrecognized types pull directly", async () => {
  const owner = "media-owner";
  const sources: { name: string; bytes: Uint8Array; mimeType: string }[] = [
    {
      name: "photo.png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      mimeType: "image/png",
    },
    {
      name: "song.mp3",
      bytes: new Uint8Array([...new TextEncoder().encode("ID3"), 0, 0, 0, 0]),
      mimeType: "audio/mpeg",
    },
    {
      name: "clip.mp4",
      bytes: new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]),
      mimeType: "video/mp4",
    },
    {
      name: "blob.xyz",
      bytes: new Uint8Array([1, 2, 3, 4, 5]),
      mimeType: "application/octet-stream",
    },
  ];
  const imported: { artifact: Artifact; bytes: Uint8Array }[] = [];
  for (const source of sources) {
    const artifact = await agent.files.import(owner, source.name, source.bytes, "test");
    assert.equal(artifact.mimeType, source.mimeType, source.name);
    imported.push({ artifact, bytes: source.bytes });
  }
  const auditsBefore = await db.list<FilePullAudit>("system", FILE_PULL_AUDIT_COLLECTION);
  const pulledIds: string[] = [];
  for (const { artifact, bytes } of imported) {
    const pulled = await agent.files.pull(owner, artifact.id, "veritas");
    assert.equal(pulled.mimeType, artifact.mimeType);
    assert.equal(pulled.parentId, artifact.id);
    assert.deepEqual(new Uint8Array(await agent.files.bytes("veritas", pulled.id)), bytes);
    pulledIds.push(pulled.id);
  }
  const auditsAfter = await db.list<FilePullAudit>("system", FILE_PULL_AUDIT_COLLECTION);
  assert.equal(auditsAfter.length, auditsBefore.length + imported.length);
  for (const pulledId of pulledIds) {
    assert.ok(auditsAfter.some((entry) => entry.fileId === pulledId));
  }
});

test("search date filters use fixed boundary instants, not the current day", async () => {
  const owner = "fixed-date-owner";
  const rows: { id: string; createdAt: string }[] = [
    { id: randomUUID(), createdAt: "2026-11-18T00:00:00.000Z" },
    { id: randomUUID(), createdAt: "2026-11-18T23:59:59.999Z" },
    { id: randomUUID(), createdAt: "2026-11-19T00:00:00.000Z" },
    { id: randomUUID(), createdAt: "2026-11-17T23:59:59.999Z" },
  ];
  for (const [index, row] of rows.entries()) {
    await db.put(owner, "files", {
      id: row.id,
      name: `fixed-${index}.txt`,
      mimeType: "text/plain",
      size: 1,
      pageCount: 0,
      fields: [],
      formKind: "none",
      url: "",
      createdAt: row.createdAt,
      source: "test",
    } satisfies Artifact);
  }
  const [idA, idB, idC, idD] = rows.map((row) => row.id);
  const ids = (files: Artifact[]) => files.map((file) => file.id).sort();
  const sorted = (...idsToSort: string[]) => [...idsToSort].sort();
  // A bare `to` date is inclusive of the whole day: A and B match, C
  // (the next midnight) does not, D (before) does.
  assert.deepEqual(
    ids(await agent.files.search(owner, { to: "2026-11-18" })),
    sorted(idA, idB, idD),
  );
  // A bare `from` date means the start of that day: D drops out.
  assert.deepEqual(
    ids(await agent.files.search(owner, { from: "2026-11-18" })),
    sorted(idA, idB, idC),
  );
  assert.deepEqual(
    ids(await agent.files.search(owner, { from: "2026-11-18", to: "2026-11-18" })),
    sorted(idA, idB),
  );
  // A full-timestamp `to` is inclusive of the instant only: B (23:59)
  // is past noon, so only A and D match.
  assert.deepEqual(
    ids(await agent.files.search(owner, { to: "2026-11-18T12:00:00.000Z" })),
    sorted(idA, idD),
  );
  assert.deepEqual(
    ids(await agent.files.search(owner, { from: "2026-11-18T23:59:59.999Z" })),
    sorted(idB, idC),
  );
});

test("lineage ends at a missing ancestor and cannot loop on a cycle", async () => {
  const owner = "lineage-edge-owner";
  const orphan = {
    id: randomUUID(),
    name: "orphan.txt",
    mimeType: "text/plain",
    size: 1,
    pageCount: 0,
    fields: [],
    formKind: "none",
    url: "",
    createdAt: "2026-11-18T00:00:00.000Z",
    source: "test",
    parentId: randomUUID(),
  } satisfies Artifact;
  await db.put(owner, "files", orphan);
  // The parent id names no stored row: the chain is just the file itself.
  assert.deepEqual(
    (await agent.files.lineage(owner, orphan.id)).map((file) => file.id),
    [orphan.id],
  );
  const xId = randomUUID();
  const yId = randomUUID();
  const base: Omit<Artifact, "id" | "name" | "parentId"> = {
    mimeType: "text/plain",
    size: 1,
    pageCount: 0,
    fields: [],
    formKind: "none",
    url: "",
    createdAt: "2026-11-18T00:00:00.000Z",
    source: "test",
  };
  await db.put(owner, "files", {
    ...base,
    id: xId,
    name: "x.txt",
    parentId: yId,
  } satisfies Artifact);
  await db.put(owner, "files", {
    ...base,
    id: yId,
    name: "y.txt",
    parentId: xId,
  } satisfies Artifact);
  // X's parent is Y and Y's parent is X: the walk must terminate.
  const chain = await agent.files.lineage(owner, xId);
  assert.deepEqual(
    chain.map((file) => file.id),
    [yId, xId],
  );
});

// --- B1 fix round 3 (panel re-review #2, S-minor + test adequacy) --------

test("search rejects impossible calendar dates, service-level and over HTTP", async () => {
  const owner = "strict-date-owner";
  await agent.files.import(owner, "xfa-static.pdf", await fixture("xfa-static.pdf"), "test");
  // 2026 is not a leap year: Feb 30 does not exist. Date.parse would
  // normalize it to March 2; strict validation must reject it.
  for (const bad of [
    "2026-02-30",
    "2023-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-04-31",
    "2026-11-18T25:00:00.000Z",
    "2026-11-18T12:60:00.000Z",
    "2026-02-30T00:00:00.000Z",
  ]) {
    await assert.rejects(
      agent.files.search(owner, { from: bad }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 422);
        assert.match(
          (error as Error).message,
          /not a (valid ISO date|real calendar date|valid time)/,
        );
        return true;
      },
      `from=${bad}`,
    );
    await assert.rejects(
      agent.files.search(owner, { to: bad }),
      /not a (valid ISO date|real calendar date|valid time)/,
      `to=${bad}`,
    );
  }
  // The same rejections over HTTP, where the route's zod refine uses
  // the same strict check.
  for (const bad of ["2026-02-30", "2023-02-29"]) {
    const response = await app.request(`/api/files/search?from=${bad}`, {
      headers: headers(),
    });
    assert.equal(response.status, 422, `from=${bad}`);
  }
  // Leap day exists in a leap year, and valid dates still filter.
  assert.ok((await agent.files.search(owner, { from: "2024-02-29" })).length >= 1);
  // A `to` bound after the import admits the file: a real assertion on
  // the `to` filter (M6a, round 4 — the old `.length >= 0` could never
  // fail, so it proved nothing about the `to` bound).
  assert.ok((await agent.files.search(owner, { to: "2999-01-01" })).length >= 1);
  // Year 0–99 leap handling (M3, round 4): the old days-in-month check
  // used Date.UTC, which remaps years 0–99 to 1900–1999 and wrongly
  // rejected the valid leap date 0000-02-29. Arithmetic leap years:
  // year 0 is divisible by 400, so 0000-02-29 exists; 0100 is a
  // century not divisible by 400, so 0100-02-29 does not.
  assert.ok((await agent.files.search(owner, { from: "0000-02-29" })).length >= 1);
  assert.ok((await agent.files.search(owner, { from: "0004-02-29" })).length >= 1);
  assert.ok((await agent.files.search(owner, { from: "2000-02-29" })).length >= 1);
  await assert.rejects(
    agent.files.search(owner, { from: "0100-02-29" }),
    /not a real calendar date/,
  );
});

test("a malformed XFA import fails over HTTP and persists no row and no bytes", async () => {
  const owner = "malformed-http-owner";
  const filesBefore = await readdir(join(directory, "files"));
  // Service-level first: the import rejects, and the owner's list stays empty.
  await assert.rejects(
    agent.files.import(
      owner,
      "xfa-malformed-mismatch.pdf",
      await fixture("xfa-malformed-mismatch.pdf"),
      "test",
    ),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 422);
      assert.match((error as Error).message, /mismatch.*ghostField/);
      return true;
    },
  );
  assert.deepEqual(await agent.files.list(owner), []);
  assert.deepEqual(await readdir(join(directory, "files")), filesBefore);
  // Over HTTP: a multipart upload of the same malformed PDF is a 422,
  // and neither the session owner's file list nor the bytes on disk
  // gains anything from the attempt.
  const listBefore: { id: string }[] = await (
    await app.request("/api/files", { headers: headers() })
  ).json();
  const form = new FormData();
  form.append(
    "file",
    new File(
      [new Uint8Array(await fixture("xfa-malformed-unclosed.pdf"))],
      "xfa-malformed-unclosed.pdf",
      {
        type: "application/pdf",
      },
    ),
  );
  const response = await app.request("/api/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(response.status, 422);
  const listAfter: { id: string }[] = await (
    await app.request("/api/files", { headers: headers() })
  ).json();
  // Compare ids only: each list() re-signs the content URLs with a fresh
  // expiry, so the full rows differ run to run even when nothing changed.
  assert.deepEqual(
    listAfter.map((file) => file.id),
    listBefore.map((file) => file.id),
  );
  assert.deepEqual(await readdir(join(directory, "files")), filesBefore);
});

test("a failed XFA import logs no field value (captured-log assertion, round 5)", async () => {
  // The only log sites on the import/PdfError path are app.ts onError
  // (cause name + numeric offset only — never the message text, never
  // file bytes) and log.ts backgroundFailure (error name + code only,
  // used by pull cleanup, not import). A template/datasets mismatch
  // whose datasets carry a distinctive secret value must therefore
  // leave no trace of that value in the server log — nor in the 422
  // response body, which names the field, not its value.
  const secret = "SECRET-VALUE-7F3A9-DO-NOT-LOG";
  const bytes = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/"><subform name="form" layout="tb">' +
      '<field name="code"><ui><textEdit/></ui><bind match="default"/></field>' +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      `<form><other>${secret}</other></form>` +
      "</xfa:data></xfa:datasets>",
  });
  const captured: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    captured.push(
      args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
    );
  };
  try {
    const form = new FormData();
    form.append(
      "file",
      new File([new Uint8Array(bytes)], "xfa-secret-value.pdf", {
        type: "application/pdf",
      }),
    );
    const response = await app.request("/api/files", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.equal(response.status, 422);
    const body = await response.text();
    assert.doesNotMatch(body, new RegExp(secret));
    assert.match(body, /has no data node/);
  } finally {
    console.error = originalError;
  }
  // Non-vacuous: the PdfError log line itself must have been captured
  // (the error path really ran through onError), while the secret
  // appears nowhere in what was captured. The exact prefix is
  // asserted here too (round 6, test adequacy): the line must start
  // with `[OpenMuse] PdfError:` — the round-5 assertion matched only
  // /PdfError/ anywhere in the log.
  const logged = captured.join("\n");
  const pdfLines = logged.split("\n").filter((line) => line.includes("PdfError"));
  assert.equal(pdfLines.length, 1);
  assert.match(pdfLines[0], /^\[OpenMuse\] PdfError: [\w.]{1,40}( offset=\d+)?$/);
  assert.doesNotMatch(logged, new RegExp(secret));
});

test("an output-limit import fails over HTTP and persists no row and no bytes", async () => {
  // M6c, round 4: round 3 added the malformed-XML HTTP test only; the
  // 1 MiB output-byte bound had no HTTP coverage. One field whose
  // value alone serializes past the bound must 422 at import time,
  // service-level and over HTTP, leaving no row and no bytes behind.
  const owner = "output-limit-http-owner";
  const filesBefore = await readdir(join(directory, "files"));
  const huge = await createXfaPdf({
    templateXml:
      '<template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">' +
      '<subform name="form" layout="tb">' +
      '<field name="a"><ui><textEdit/></ui><bind match="default"/></field>' +
      "</subform></template>",
    datasetsXml:
      '<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data>' +
      `<form><a>${"V".repeat(2 * 1024 * 1024)}</a></form>` +
      "</xfa:data></xfa:datasets>",
  });
  // Service-level first: the import rejects, and the owner's list stays empty.
  await assert.rejects(
    agent.files.import(owner, "xfa-huge-value.pdf", huge, "test"),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 422);
      assert.match((error as Error).message, /more than 1048576 bytes of resolved fields/);
      return true;
    },
  );
  assert.deepEqual(await agent.files.list(owner), []);
  assert.deepEqual(await readdir(join(directory, "files")), filesBefore);
  // Over HTTP: a multipart upload of the same PDF is a 422, and
  // neither the session owner's file list nor the bytes on disk gains
  // anything from the attempt.
  const listBefore: { id: string }[] = await (
    await app.request("/api/files", { headers: headers() })
  ).json();
  const form = new FormData();
  form.append(
    "file",
    new File([new Uint8Array(huge)], "xfa-huge-value.pdf", { type: "application/pdf" }),
  );
  const response = await app.request("/api/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(response.status, 422);
  const listAfter: { id: string }[] = await (
    await app.request("/api/files", { headers: headers() })
  ).json();
  // Compare ids only: each list() re-signs the content URLs with a fresh
  // expiry, so the full rows differ run to run even when nothing changed.
  assert.deepEqual(
    listAfter.map((file) => file.id),
    listBefore.map((file) => file.id),
  );
  assert.deepEqual(await readdir(join(directory, "files")), filesBefore);
});
