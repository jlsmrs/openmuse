import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.ts";
import type { Store } from "./db.ts";
import { AppError } from "./errors.ts";

const digest = (value: string) => createHash("sha256").update(value).digest();
export class Auth {
  /**
   * Per-owner signed-URL generation, bumped on sign-out (see revoke). A
   * signed URL carries the generation it was minted under, and verify
   * rejects any generation that is not current — so links minted before a
   * sign-out die with the session instead of surviving their 15-minute
   * window. The map is hydrated from the store at startup (createAuth) and
   * is the in-memory view of the durable counter; there is one Auth
   * instance per API process, so the map cannot go stale in production.
   */
  private generations = new Map<string, number>();
  constructor(
    private readonly db: Store,
    private readonly config: Config,
    private readonly signingKey: string,
  ) {}
  /** Load the durable per-owner generations; best-effort so a store without the table still boots. */
  async loadGenerations(): Promise<void> {
    try {
      if (typeof this.db.scan !== "function") return;
      for (const { value } of await this.db.scan<{ id: string; generation: number }>(
        "signing-generations",
      )) {
        if (typeof value?.generation === "number") this.generations.set(value.id, value.generation);
      }
    } catch {
      // A missing table or failed read leaves every generation at 0, which
      // is the pre-sign-out state; signing out again bumps it durably.
    }
  }
  private generation(owner: string): number {
    return this.generations.get(owner) ?? 0;
  }
  private async bumpGeneration(owner: string): Promise<void> {
    const generation = this.generation(owner) + 1;
    this.generations.set(owner, generation);
    try {
      if (typeof this.db.put === "function")
        await this.db.put("system", "signing-generations", { id: owner, generation });
    } catch {
      // The in-memory bump already invalidates this process's links; a
      // failed durable write only matters across a restart.
    }
  }
  async session(accessKey?: string) {
    if (
      this.config.mode === "live" &&
      (!accessKey ||
        !this.config.accessKey ||
        !timingSafeEqual(digest(accessKey), digest(this.config.accessKey)))
    )
      throw new AppError("Access key is incorrect", 401);
    const token = randomBytes(32).toString("base64url");
    await this.db.put("system", "sessions", {
      id: digest(token).toString("hex"),
      owner: "local-user",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });
    return { token, mode: this.config.mode };
  }
  async owner(authorization?: string) {
    if (!authorization?.startsWith("Bearer ")) throw new AppError("Sign in to OpenMuse", 401);
    const id = digest(authorization.slice(7)).toString("hex");
    const session = await this.db.get<{ owner: string; expiresAt: number }>(
      "system",
      "sessions",
      id,
    );
    if (!session || session.expiresAt < Date.now()) {
      // Expired sessions can never be valid again, so drop the row instead of keeping it forever.
      // Best-effort: a failed cleanup must not turn the rejection into a 5xx.
      if (session) await this.db.remove("system", "sessions", id).catch(() => {});
      throw new AppError("Session expired. Sign in again.", 401);
    }
    return session.owner;
  }
  async revoke(authorization?: string) {
    if (!authorization?.startsWith("Bearer ")) return;
    const id = digest(authorization.slice(7)).toString("hex");
    const session = await this.db
      .get<{ owner: string; expiresAt: number }>("system", "sessions", id)
      .catch(() => null);
    await this.db.remove("system", "sessions", id);
    // Sign-out invalidates the owner's signed URLs too: bump their
    // generation so links minted before this sign-out no longer verify.
    if (session) await this.bumpGeneration(session.owner);
  }
  sign(owner: string, path: string) {
    const generation = this.generation(owner);
    const expires = String(Date.now() + 15 * 60 * 1000);
    const signature = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${path}\n${expires}\n${generation}`)
      .digest("hex");
    return `${this.config.publicUrl}${path}?owner=${encodeURIComponent(owner)}&expires=${expires}&generation=${generation}&signature=${signature}`;
  }
  verify(url: URL) {
    const owner = url.searchParams.get("owner") ?? "";
    const expires = url.searchParams.get("expires") ?? "";
    const signature = url.searchParams.get("signature") ?? "";
    const generation = Number(url.searchParams.get("generation") ?? "0");
    if (
      !owner ||
      !/^\d+$/.test(expires) ||
      Number(expires) < Date.now() ||
      !/^\w{64}$/.test(signature) ||
      !Number.isInteger(generation) ||
      generation < 0
    )
      throw new AppError("Document link expired; refresh the workspace", 401);
    const expected = createHmac("sha256", this.signingKey)
      .update(`${owner}\n${url.pathname}\n${expires}\n${generation}`)
      .digest("hex");
    if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
      throw new AppError("Invalid access link", 403);
    // The signature is authentic, but the link may predate a sign-out: the
    // generation it was minted under must still be the owner's current one.
    if (generation !== this.generation(owner))
      throw new AppError("Document link expired; refresh the workspace", 401);
    return owner;
  }
}
export async function createAuth(db: Store, config: Config) {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const key = await readOrCreate(join(config.dataDir, "session-signing-key"), () =>
    randomBytes(32).toString("base64"),
  );
  const auth = new Auth(db, config, key);
  await auth.loadGenerations();
  return auth;
}
/** Reads a private file, or creates it without replacing another process's value. */
export async function readOrCreate(path: string, create: () => string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let value = create();
  const temporary = `${path}.${randomBytes(16).toString("hex")}.tmp`;
  await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
  try {
    // Publish only complete bytes, without replacing another process's value.
    await link(temporary, path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      value = await readFile(path, "utf8");
    } else if (error instanceof Error && "code" in error && error.code === "ENOTSUP") {
      // Azure Files (SMB) does not support hard links: exclusive-create the
      // file instead of renaming over it, so a concurrent process's value is
      // never overwritten — a rename here would replace a key another
      // process just published.
      try {
        await writeFile(path, value, { mode: 0o600, flag: "wx" });
      } catch (writeError) {
        if (!(writeError instanceof Error && "code" in writeError && writeError.code === "EEXIST"))
          throw writeError;
        value = await readFile(path, "utf8");
      }
    } else throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return value;
}
