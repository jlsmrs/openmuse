import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Auth } from "../apps/server/src/auth.ts";
import type { Config } from "../apps/server/src/config.ts";
import { createStore } from "../apps/server/src/db.ts";
import { GeneratedImages } from "../apps/server/src/generated-images.ts";

function config(dataDir: string): Config {
  return {
    mode: "sample",
    port: 8787,
    host: "127.0.0.1",
    publicUrl: "http://localhost:8787",
    dataDir,
    agentBackend: "sample",
    intelligenceApiKey: "test-project-key-never-sent",
    allowedOrigins: [],
    googleRedirectUri: "http://localhost:8787/api/google/callback",
  };
}

// S-B4 item 17: a file deleted between readdir and stat must be skipped, not
// fail the whole listing. Best-effort race: no deterministic hook exists for
// the gap, so hammer the listing while a deleter removes files concurrently.
test("listing generated images survives concurrent deletion", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openmuse-gen-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = await createStore();
  t.after(() => db.close());
  const images = new GeneratedImages(
    config(directory),
    new Auth(db, config(directory), "test-signing-key"),
  );
  const dir = join(directory, "generated-images");
  await mkdir(dir, { recursive: true });
  for (let round = 0; round < 25; round++) {
    const names = Array.from({ length: 20 }, (_, i) => `img-${i}.png`);
    await Promise.all(names.map((name) => writeFile(join(dir, name), Buffer.from([0x89, 0x50]))));
    const deleting = (async () => {
      for (const name of names) {
        await rm(join(dir, name), { force: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    })();
    const listed = await images.list("owner");
    await deleting;
    assert.ok(Array.isArray(listed));
    assert.ok(listed.every((entry) => names.includes(entry.name)));
  }
});
