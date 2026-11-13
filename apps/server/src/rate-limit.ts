import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import { AppError } from "./errors.ts";

interface RateLimitEntry {
  count: number;
  expiresAt: number;
}

export interface RateLimitStoreOptions {
  windowMs?: number;
  maxRequests?: number;
  maxEntries?: number;
}

export function createRateLimitStore(options: RateLimitStoreOptions = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const maxRequests = options.maxRequests ?? 120;
  const maxEntries = options.maxEntries ?? 10_000;
  const entries = new Map<string, RateLimitEntry>();

  function cleanupExpired(now: number) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  function take(key: string, now: number): boolean {
    let entry = entries.get(key);
    if (entry && entry.expiresAt <= now) entry = undefined;
    if (!entry) {
      if (entries.size >= maxEntries) {
        cleanupExpired(now);
        if (entries.size >= maxEntries) {
          // At capacity with no expired entries: evict the least-recently-used
          // bucket (earliest window end) instead of refusing the new key, so
          // minting many distinct keys cannot lock legitimate new clients out
          // until entries expire. Only the stalest bucket is ever dropped.
          let oldestKey: string | undefined;
          let oldestExpiresAt = Number.POSITIVE_INFINITY;
          for (const [candidate, candidateEntry] of entries) {
            if (candidateEntry.expiresAt < oldestExpiresAt) {
              oldestExpiresAt = candidateEntry.expiresAt;
              oldestKey = candidate;
            }
          }
          if (oldestKey !== undefined) entries.delete(oldestKey);
        }
      }
      entry = { count: 0, expiresAt: now + windowMs };
      entries.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= maxRequests;
  }

  return { take, size: () => entries.size };
}

// This limiter runs before authentication, so the key must never be derived from
// caller-supplied credentials (e.g. Authorization): any string would mint a new bucket.
// That is also why an unknown address falls back to one shared `conn:unknown`
// bucket: with no address there is nothing safe to distinguish clients by.
// Clients behind one proxy address share the same way when TRUST_PROXY is off,
// so a deployment behind a proxy needs TRUST_PROXY enabled for per-client
// buckets; authenticated traffic is distinguished per owner by the post-auth
// limiter (see app.ts), which is the real fix for the sharing concern.
export function resolveClientKey(input: {
  trustProxy: boolean;
  forwardedFor?: string;
  realIp?: string;
  connectionAddress?: string;
}): string {
  if (input.trustProxy) {
    const forwarded = input.forwardedFor?.split(",")[0]?.trim();
    if (forwarded) return `proxy:${forwarded}`;
    if (input.realIp) return `proxy:${input.realIp}`;
  }
  return `conn:${input.connectionAddress ?? "unknown"}`;
}

// getConnInfo reads the raw Node socket, which only exists behind a real
// @hono/node-server listener; in-memory `app.request()` calls (as used in
// tests) have no socket, so this must degrade rather than throw.
export function connectionAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * Sign-in throttle with two independent buckets, so one bad actor cannot
 * lock every sign-in out (the old single global counter did exactly that):
 * one bucket per client address and one per account (hashed access key).
 * Both buckets share the same window and limit; an attempt counts against
 * both. The account key is a hash, never the raw key.
 */
export function createLoginThrottle(options: { windowMs?: number; maxAttempts?: number } = {}) {
  const windowMs = options.windowMs ?? 60_000;
  const maxAttempts = options.maxAttempts ?? 30;
  const ipLimits = createRateLimitStore({ windowMs, maxRequests: maxAttempts });
  const accountLimits = createRateLimitStore({ windowMs, maxRequests: maxAttempts });
  return {
    check(ipKey: string, accountKey: string, now = Date.now()): boolean {
      return ipLimits.take(ipKey, now) && accountLimits.take(accountKey, now);
    },
  };
}

export function rateLimit(
  trustProxy: boolean,
  options: RateLimitStoreOptions & {
    getAddress?: (c: Context) => string | undefined;
    // Optional per-request key. When given, it replaces the connection-derived
    // key entirely — used for the post-auth per-owner bucket, where the key is
    // the verified owner (see app.ts). Never derive it from caller-supplied
    // credentials: any string would mint a new bucket.
    keyResolver?: (c: Context) => string;
  } = {},
) {
  const store = createRateLimitStore(options);
  const getAddress = options.getAddress ?? connectionAddress;
  const keyResolver = options.keyResolver;
  return async (c: Context, next: () => Promise<void>) => {
    const key = keyResolver
      ? keyResolver(c)
      : resolveClientKey({
          trustProxy,
          forwardedFor: c.req.header("x-forwarded-for"),
          realIp: c.req.header("x-real-ip"),
          connectionAddress: getAddress(c),
        });
    if (!store.take(key, Date.now()))
      throw new AppError("Too many requests. Try again in a minute.", 429);
    await next();
  };
}
