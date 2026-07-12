import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { encryptSecret, decryptSecret, secretLast4 } from "./lib/secretCrypto";

// base64 of 32 bytes — deterministic test key, not a real secret
const TEST_KEY = btoa("A".repeat(32));

beforeEach(() => {
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("secretCrypto", () => {
  test("round-trips a secret", async () => {
    const plaintext = "EAAFakeAccessToken1234567890";
    const encrypted = await encryptSecret(plaintext);

    expect(encrypted).not.toContain(plaintext);
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(await decryptSecret(encrypted)).toBe(plaintext);
  });

  test("uses a random IV per value", async () => {
    const a = await encryptSecret("same-secret");
    const b = await encryptSecret("same-secret");
    expect(a).not.toEqual(b);
    expect(await decryptSecret(a)).toBe("same-secret");
    expect(await decryptSecret(b)).toBe("same-secret");
  });

  test("fails clearly when the env var is missing", async () => {
    vi.stubEnv("CHANNEL_ENCRYPTION_KEY", "");
    await expect(encryptSecret("x")).rejects.toThrow(/CHANNEL_ENCRYPTION_KEY/);
  });

  test("fails clearly when the key has the wrong length", async () => {
    vi.stubEnv("CHANNEL_ENCRYPTION_KEY", btoa("short"));
    await expect(encryptSecret("x")).rejects.toThrow(/32 bytes/);
  });

  test("rejects tampered ciphertext", async () => {
    const encrypted = await encryptSecret("secret-value");
    const [version, iv, cipher] = encrypted.split(":");
    const tamperedBytes = atob(cipher)
      .split("")
      .map((c, i) => (i === 0 ? String.fromCharCode(c.charCodeAt(0) ^ 0xff) : c))
      .join("");
    const tampered = `${version}:${iv}:${btoa(tamperedBytes)}`;
    await expect(decryptSecret(tampered)).rejects.toThrow();
  });

  test("rejects unknown format", async () => {
    await expect(decryptSecret("v9:abc:def")).rejects.toThrow(/format/);
    await expect(decryptSecret("garbage")).rejects.toThrow(/format/);
  });

  test("secretLast4 returns the last 4 characters", () => {
    expect(secretLast4("EAAFakeToken9876")).toBe("9876");
  });
});
