/**
 * Encryption at rest for channel secrets (AES-256-GCM via Web Crypto).
 *
 * Values are stored as `v1:<base64 iv>:<base64 ciphertext>` — the version
 * prefix allows future key/algorithm rotation. The master key comes from the
 * deployment env var CHANNEL_ENCRYPTION_KEY (32 bytes, base64-encoded).
 *
 * Only call encrypt/decrypt from actions (never expose decrypted values to
 * clients; never log them, never put them in audit or webhook payloads).
 */

const VERSION_PREFIX = "v1";
const IV_BYTES = 12; // AES-GCM standard nonce size

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getMasterKey(): Promise<CryptoKey> {
  const raw = process.env.CHANNEL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CHANNEL_ENCRYPTION_KEY env var is not set. Generate one with: openssl rand -base64 32"
    );
  }
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64Decode(raw.trim());
  } catch {
    throw new Error("CHANNEL_ENCRYPTION_KEY is not valid base64");
  }
  if (keyBytes.length !== 32) {
    throw new Error(
      `CHANNEL_ENCRYPTION_KEY must decode to 32 bytes (got ${keyBytes.length}). Generate one with: openssl rand -base64 32`
    );
  }
  return await crypto.subtle.importKey("raw", keyBytes as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptSecret(plaintext: string): Promise<string> {
  const key = await getMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext)
  );
  return `${VERSION_PREFIX}:${base64Encode(iv)}:${base64Encode(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(encrypted: string): Promise<string> {
  const [version, ivB64, cipherB64] = encrypted.split(":");
  if (version !== VERSION_PREFIX || !ivB64 || !cipherB64) {
    throw new Error("Unrecognized encrypted secret format");
  }
  const key = await getMasterKey();
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64Decode(ivB64) as BufferSource },
    key,
    base64Decode(cipherB64) as BufferSource
  );
  return new TextDecoder().decode(plaintext);
}

/** Last 4 characters of a secret, for masked display ("…abcd"). */
export function secretLast4(secret: string): string {
  return secret.slice(-4);
}
