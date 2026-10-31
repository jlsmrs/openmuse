// Generated images live under DATA_DIR/generated-images/ (see
// engine/foundry-image.ts). They are NOT workspace files: they have no
// Files row, so they cannot be served through /api/files/:id/content.
// This module serves them the same way files are served — through a
// 15-minute owner-scoped signed URL minted by Auth.sign, verified by the
// same middleware as file content. No public unauthenticated access, and
// a signed URL is bound to one owner and one path.

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { Auth } from "./auth.ts";
import type { Config } from "./config.ts";
import { AppError } from "./errors.ts";

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export interface GeneratedImage {
  name: string;
  size: number;
  mimeType: string;
  url: string;
}

export class GeneratedImages {
  constructor(
    private readonly config: Config,
    private readonly auth: Auth,
  ) {}

  private dir() {
    return resolve(this.config.dataDir, "generated-images");
  }

  /** Resolve a stored name to a path inside generated-images/, or throw. */
  resolvePath(name: string): { path: string; mimeType: string } {
    if (basename(name) !== name || name.includes("\\"))
      throw new AppError("Generated image not found", 404);
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    const mimeType = IMAGE_MIME[ext];
    if (!mimeType) throw new AppError("Generated image not found", 404);
    const resolved = resolve(this.dir(), name);
    if (!resolved.startsWith(`${this.dir()}${sep}`))
      throw new AppError("Generated image not found", 404);
    return { path: resolved, mimeType };
  }

  async list(owner: string): Promise<GeneratedImage[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.dir(), { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const images: Array<GeneratedImage & { mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
      const mimeType = IMAGE_MIME[ext];
      if (!mimeType) continue;
      const info = await stat(join(this.dir(), entry.name));
      images.push({
        name: entry.name,
        size: info.size,
        mimeType,
        url: this.auth.sign(
          owner,
          `/api/generated-images/${encodeURIComponent(entry.name)}/content`,
        ),
        mtime: info.mtimeMs,
      });
    }
    return images.sort((a, b) => b.mtime - a.mtime).map(({ mtime: _mtime, ...rest }) => rest);
  }

  async bytes(name: string) {
    const { path, mimeType } = this.resolvePath(name);
    try {
      return { bytes: await readFile(path), mimeType };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        throw new AppError("Generated image not found", 404);
      throw error;
    }
  }

  /** True when a well-formed name actually exists on disk. Signing alone
   * does not prove existence, so the avatar endpoint checks this first
   * rather than minting a URL that would 404 when rendered. */
  async exists(name: string): Promise<boolean> {
    let path: string;
    try {
      path = this.resolvePath(name).path;
    } catch {
      return false;
    }
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  sign(owner: string, name: string): string {
    this.resolvePath(name);
    return this.auth.sign(owner, `/api/generated-images/${encodeURIComponent(name)}/content`);
  }
}
