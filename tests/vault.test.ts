import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  decryptSecret,
  encryptSecret,
  encryptSecretV2,
} from "../packages/integrations/src/vault.ts";

test("vault encrypts with a fresh nonce and authenticates the entire envelope", () => {
  const key = randomBytes(32).toString("base64");
  const secret = "synthetic refresh token / café";
  const first = encryptSecret(secret, key);
  const second = encryptSecret(secret, key);
  assert.notEqual(first, second);
  assert.equal(first.includes(secret), false);
  assert.equal(decryptSecret(first, key), secret);
  assert.throws(
    () => decryptSecret(first, randomBytes(32).toString("base64")),
    /authenticate|decrypt/i,
  );
  const parts = first.split(".");
  assert.equal(parts.length, 4);
  for (let index = 1; index < 4; index++) {
    const corrupted = [...parts];
    const bytes = Buffer.from(corrupted[index], "base64url");
    bytes[0] ^= 1;
    corrupted[index] = bytes.toString("base64url");
    assert.throws(() => decryptSecret(corrupted.join("."), key), /authenticate|decrypt/i);
  }
});

test("vault rejects malformed keys and envelopes without echoing secrets", () => {
  for (const key of [
    "",
    "password",
    randomBytes(31).toString("base64"),
    `${randomBytes(32).toString("base64")}!`,
  ]) {
    assert.throws(() => encryptSecret("secret-value", key), /32-byte base64/i);
  }
  const key = randomBytes(32).toString("base64");
  for (const envelope of ["", "plaintext-secret", "v2.a.b.c", "v1.!.a.b", "v1.a.b.c.extra"]) {
    assert.throws(() => decryptSecret(envelope, key), /invalid encrypted secret/i);
  }
  assert.equal(decryptSecret(encryptSecret("", key), key), "");
});

test("v2 envelope binds the tag to owner and record id", () => {
  const key = randomBytes(32).toString("base64");
  const secret = "synthetic refresh token / café";
  const context = { owner: "owner-1", recordId: "google" };
  const envelope = encryptSecretV2(secret, key, context);
  assert.equal(envelope.split(".")[0], "v2");
  assert.equal(decryptSecret(envelope, key, context), secret);
  // Same ciphertext under another owner, another record, or no context does
  // not authenticate — the tag is bound to the context it was sealed with.
  assert.throws(
    () => decryptSecret(envelope, key, { owner: "owner-2", recordId: "google" }),
    /authenticate|decrypt/i,
  );
  assert.throws(
    () => decryptSecret(envelope, key, { owner: "owner-1", recordId: "other" }),
    /authenticate|decrypt/i,
  );
  assert.throws(() => decryptSecret(envelope, key), /context is required/i);
  assert.throws(
    () => encryptSecretV2(secret, key, { owner: "", recordId: "google" }),
    /owner and a record id/i,
  );
});

test("v1 records still decrypt without a context", () => {
  const key = randomBytes(32).toString("base64");
  const secret = "legacy v1 token";
  const envelope = encryptSecret(secret, key);
  assert.equal(envelope.split(".")[0], "v1");
  assert.equal(decryptSecret(envelope, key), secret);
  // A v1 read ignores an (unused) context.
  assert.equal(decryptSecret(envelope, key, { owner: "owner-1", recordId: "google" }), secret);
});
