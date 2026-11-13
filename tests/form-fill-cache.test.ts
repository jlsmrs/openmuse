// M-B5 / audit M11: a second form fill with different values must produce a
// new file, not return the first fill's bytes. The keyed-import key used by
// files.fill must distinguish value sets, while the same fill repeated with
// the same values stays idempotent under the same operation key.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { PDFDocument } from "pdf-lib";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore, type Store } from "../apps/server/src/db.ts";
import { Files } from "../apps/server/src/files.ts";
import { createSamplePdf } from "../packages/integrations/src/pdf.ts";

let db: Store;
let files: Files;
let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "openmuse-form-fill-"));
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
  files = new Files(db, config, new Auth(db, config, "sample-signing-key"));
});

after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

async function participantName(owner: string, id: string): Promise<string> {
  const bytes = await files.bytes(owner, id);
  const doc = await PDFDocument.load(bytes);
  return doc.getForm().getTextField("participant_name").getText() ?? "";
}

test("a second fill with different values produces a distinct file with the new values", async () => {
  const owner = "owner";
  const source = await files.import(owner, "form.pdf", await createSamplePdf(), "test");
  const operationKey = "model:task1:fill_pdf";
  const first = await files.fill(owner, source.id, { participant_name: "Alice" }, operationKey);
  const second = await files.fill(owner, source.id, { participant_name: "Bob" }, operationKey);
  assert.notEqual(second.id, first.id);
  assert.equal(await participantName(owner, first.id), "Alice");
  assert.equal(await participantName(owner, second.id), "Bob");
});

test("the same fill repeated with the same values stays idempotent under one operation key", async () => {
  const owner = "owner";
  const source = await files.import(owner, "form.pdf", await createSamplePdf(), "test");
  const operationKey = "model:task2:fill_pdf";
  const first = await files.fill(owner, source.id, { participant_name: "Alice" }, operationKey);
  const second = await files.fill(owner, source.id, { participant_name: "Alice" }, operationKey);
  assert.equal(second.id, first.id);
  assert.equal(await participantName(owner, second.id), "Alice");
});
