import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { copyTreeNoPerms } from "../apps/server/src/scripts/copy-tree.ts";

const scriptPath = fileURLToPath(
  new URL("../apps/server/src/scripts/migrate-vault-v2.ts", import.meta.url),
);
const helperPath = fileURLToPath(
  new URL("../apps/server/src/scripts/copy-tree.ts", import.meta.url),
);

test("copyTreeNoPerms copies a nested tree with identical contents", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-copy-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "target");
  await mkdir(join(source, "nested", "deep"), { recursive: true });
  await mkdir(join(source, "empty"), { recursive: true });
  await writeFile(join(source, "a.txt"), "alpha");
  await writeFile(join(source, "nested", "b.txt"), "beta");
  await writeFile(join(source, "nested", "deep", "c.bin"), Buffer.from([0, 1, 2, 255]));
  await copyTreeNoPerms(source, target);
  assert.equal(await readFile(join(target, "a.txt"), "utf8"), "alpha");
  assert.equal(await readFile(join(target, "nested", "b.txt"), "utf8"), "beta");
  assert.deepEqual([...(await readFile(join(target, "nested", "deep", "c.bin")))], [0, 1, 2, 255]);
  assert.deepEqual(await readdir(join(target, "empty")), []);
});

test("copyTreeNoPerms copies files with restrictive modes without preserving them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-copy-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "target");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "locked.txt"), "secret-contents");
  await chmod(join(source, "locked.txt"), 0o400);
  await writeFile(join(source, "owner-only.txt"), "owner-only-contents");
  await chmod(join(source, "owner-only.txt"), 0o600);
  await copyTreeNoPerms(source, target);
  assert.equal(await readFile(join(target, "locked.txt"), "utf8"), "secret-contents");
  assert.equal(await readFile(join(target, "owner-only.txt"), "utf8"), "owner-only-contents");
  // The target files do NOT inherit the restrictive modes: they are
  // created with the process default mode, so they stay owner-writable.
  for (const name of ["locked.txt", "owner-only.txt"]) {
    const mode = (await stat(join(target, name))).mode & 0o777;
    assert.notEqual(mode, 0o400);
    assert.ok((mode & 0o200) !== 0, `${name} should be owner-writable, got ${mode.toString(8)}`);
  }
});

test("copyTreeNoPerms throws on a non-file entry instead of silently dropping it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openmuse-copy-tree-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "target");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "kept.txt"), "kept");
  await symlink(join(source, "missing"), join(source, "dangling"));
  await assert.rejects(copyTreeNoPerms(source, target), /unsupported entry.*dangling/);
});

test("the migration script and its copy helper never call cp or chmod", async () => {
  // The G4 live run died because the recursive copy set modes on the
  // copied files and the Azure Files mount refuses that with EPERM —
  // a failure invisible on a local filesystem, where the old copy
  // worked fine. The guard is structural by necessity: if the
  // mode-setting copy ever comes back, this fails.
  for (const path of [scriptPath, helperPath]) {
    const source = await readFile(path, "utf8");
    assert.doesNotMatch(source, /\bchmod\s*\(/);
    assert.doesNotMatch(source, /import\s*\{[^}]*\bcp\b[^}]*\}\s*from\s*"node:fs\/promises"/);
    assert.doesNotMatch(source, /\bfs\.cp\s*\(/);
  }
});
