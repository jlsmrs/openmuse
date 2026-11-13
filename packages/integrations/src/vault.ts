import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** True when the key is a canonical 32-byte base64 string, as decodeKey requires. */
export function isValidEncryptionKey(key: string): boolean {
  const bytes = Buffer.from(key, "base64");
  return bytes.length === 32 && bytes.toString("base64") === key;
}

function decodeKey(key: string): Buffer {
  if (!isValidEncryptionKey(key)) {
    throw new Error("Credential encryption requires a 32-byte base64 key");
  }
  return Buffer.from(key, "base64");
}

/** Context bound into a v2 envelope's authentication tag: owner + record id. */
export interface CredentialContext {
  owner: string;
  recordId: string;
}

function aadFor(version: "v1" | "v2", context?: CredentialContext): Buffer {
  if (version === "v1") return Buffer.from("openmuse:credential:v1");
  return Buffer.from(`openmuse:credential:v2:${context?.owner ?? ""}:${context?.recordId ?? ""}`);
}

/** Versioned AES-256-GCM envelope: version.nonce.tag.ciphertext. */
export function encryptSecret(plaintext: string, key: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(key), nonce);
  cipher.setAAD(aadFor("v1"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * v2 envelope for NEW records: the authentication tag is bound to the owner
 * and record id, so a ciphertext copied to another owner or record cannot
 * decrypt. Bulk re-encryption of existing v1 records is a separate gated
 * step (G4), not this change.
 */
export function encryptSecretV2(
  plaintext: string,
  key: string,
  context: CredentialContext,
): string {
  if (!context.owner || !context.recordId)
    throw new Error("Credential context requires an owner and a record id");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(key), nonce);
  cipher.setAAD(aadFor("v2", context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v2",
    nonce.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(encrypted: string, key: string, context?: CredentialContext): string {
  const keyBytes = decodeKey(key);
  const [version, nonceString, tagString, ciphertextString, extra] = encrypted.split(".");
  if (
    (version !== "v1" && version !== "v2") ||
    nonceString === undefined ||
    tagString === undefined ||
    ciphertextString === undefined ||
    extra !== undefined
  ) {
    throw new Error("Invalid encrypted secret");
  }
  const encoded = [nonceString, tagString, ciphertextString];
  const [nonce, tag, ciphertext] = encoded.map((value) => Buffer.from(value, "base64url"));
  if (
    nonce.length !== 12 ||
    tag.length !== 16 ||
    encoded.some(
      (value, index) => Buffer.from(value, "base64url").toString("base64url") !== encoded[index],
    )
  ) {
    throw new Error("Invalid encrypted secret");
  }
  if (version === "v2" && (!context?.owner || !context?.recordId))
    throw new Error("Credential context is required to decrypt this record");
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes, nonce);
    decipher.setAAD(aadFor(version, context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Unable to authenticate or decrypt credential");
  }
}
