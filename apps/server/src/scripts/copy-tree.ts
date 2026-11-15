/**
 * Permission-tolerant recursive directory copy (G4.1).
 *
 * The G4 live migration died in its backup step because it used
 * the `cp` export of `node:fs/promises` with `{ recursive: true }`,
 * which preserves the source mode of every copied file by setting
 * it on the copy — and the Azure Files SMB mount backing /data
 * refuses that operation with EPERM. This helper only ever reads,
 * writes, and makes directories: it never sets a mode, never sets
 * timestamps, and never preserves ownership, so it cannot hit that
 * failure. Copied files get the process default mode (0666 & ~umask).
 *
 * It is fail-loud, never silently lossy: an entry that is neither a
 * file nor a directory (symlink, socket, fifo, ...) throws, naming
 * the path, so a backup that cannot be faithful fails instead of
 * silently dropping data. A PGlite data directory holds only files
 * and directories; if a future layout adds another entry type the
 * backup fails with a clear error instead of a quiet partial copy.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

export async function copyTreeNoPerms(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTreeNoPerms(from, to);
    } else if (entry.isFile()) {
      await pipeline(createReadStream(from), createWriteStream(to));
    } else {
      throw new Error(`copyTreeNoPerms: unsupported entry ${from} (not a file or directory)`);
    }
  }
}
