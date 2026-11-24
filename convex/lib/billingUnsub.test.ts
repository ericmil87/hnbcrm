import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UNSUB_TOKEN_MAX_LEN,
  buildUnsubLinks,
  signUnsubToken,
  unsubIpThrottleKey,
  unsubSecretsFromEnv,
  verifyUnsubToken,
} from "./billingUnsub";

// Fixtures curtas e obviamente falsas (secretScan).
const SECRET = "fake-unsub-secret-0123456789abcdef0123456789abcdef";
const OTHER_SECRET = "fake-unsub-secret-rotated-0123456789abcdef01234567";
const SHORT_SECRET = "fake-unsub-short";
const CLAIMS = { organizationId: "org_fake_1", memberId: "member_fake_1" };

function b64urlJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Monta um token com payload arbitrário e assinatura VÁLIDA (para testar as regras do payload). */
async function signRaw(secret: string, payload: unknown): Promise<string> {
  const p = b64urlJson(payload);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("hnbcrm-unsub-v1|" + p)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return `v1.${p}.${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("signUnsubToken / verifyUnsubToken", () => {
  it("round-trip devolve os ids e o formato é v1.<payload>.<sig>", async () => {
    const token = await signUnsubToken(SECRET, CLAIMS);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThanOrEqual(UNSUB_TOKEN_MAX_LEN);
    expect(await verifyUnsubToken(token, { current: SECRET })).toEqual(CLAIMS);
  });

  it("o token não carrega e-mail nem nada além de v/o/m/k", async () => {
    const token = await signUnsubToken(SECRET, CLAIMS);
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    expect(payload).toEqual({ v: 1, o: CLAIMS.organizationId, m: CLAIMS.memberId, k: "bn" });
  });

  it("payload adulterado não verifica", async () => {
    const token = await signUnsubToken(SECRET, CLAIMS);
    const [, , sig] = token.split(".");
    const forged = `v1.${b64urlJson({ v: 1, o: CLAIMS.organizationId, m: "member_fake_2", k: "bn" })}.${sig}`;
    expect(await verifyUnsubToken(forged, { current: SECRET })).toBeNull();
  });

  it("assinatura adulterada não verifica", async () => {
    const token = await signUnsubToken(SECRET, CLAIMS);
    const [ver, payload, sig] = token.split(".");
    const flipped = sig.slice(0, 5) + (sig[5] === "A" ? "B" : "A") + sig.slice(6);
    expect(await verifyUnsubToken(`${ver}.${payload}.${flipped}`, { current: SECRET })).toBeNull();
    expect(await verifyUnsubToken(`${ver}.${payload}.`, { current: SECRET })).toBeNull();
    expect(await verifyUnsubToken(`${ver}.${payload}.${sig.slice(0, -2)}`, { current: SECRET })).toBeNull();
  });

  it("versão desconhecida (prefixo ou `v` do payload) não verifica", async () => {
    const token = await signUnsubToken(SECRET, CLAIMS);
    expect(await verifyUnsubToken("v2" + token.slice(2), { current: SECRET })).toBeNull();
    const v2 = await signRaw(SECRET, { v: 2, o: CLAIMS.organizationId, m: CLAIMS.memberId, k: "bn" });
    expect(await verifyUnsubToken(v2, { current: SECRET })).toBeNull();
    const vStr = await signRaw(SECRET, { v: "1", o: CLAIMS.organizationId, m: CLAIMS.memberId, k: "bn" });
    expect(await verifyUnsubToken(vStr, { current: SECRET })).toBeNull();
  });

  it("`k` errado não verifica", async () => {
    const wrong = await signRaw(SECRET, { v: 1, o: CLAIMS.organizationId, m: CLAIMS.memberId, k: "bc" });
    expect(await verifyUnsubToken(wrong, { current: SECRET })).toBeNull();
    const missing = await signRaw(SECRET, { v: 1, o: CLAIMS.organizationId, m: CLAIMS.memberId });
    expect(await verifyUnsubToken(missing, { current: SECRET })).toBeNull();
  });

  it("campos não-string ou vazios não verificam, mesmo assinados", async () => {
    for (const payload of [
      { v: 1, o: "", m: CLAIMS.memberId, k: "bn" },
      { v: 1, o: CLAIMS.organizationId, m: 42, k: "bn" },
      { v: 1, o: null, m: CLAIMS.memberId, k: "bn" },
      [1, "a", "b", "bn"],
      "texto",
    ]) {
      expect(await verifyUnsubToken(await signRaw(SECRET, payload), { current: SECRET })).toBeNull();
    }
  });

  it("formato inválido, base64url inválido e JSON inválido não verificam", async () => {
    const token = await signUnsubToken(SECRET, CLAIMS);
    const [, payload, sig] = token.split(".");
    for (const bad of [
      "",
      "v1",
      "v1.",
      `v1.${payload}`,
      `v1.${payload}.${sig}.extra`,
      `v1.${payload}=.${sig}`,
      `v1.${payload.replace(/./, "+")}.${sig}`,
      `v1.***.${sig}`,
    ]) {
      expect(await verifyUnsubToken(bad, { current: SECRET })).toBeNull();
    }
    // JSON quebrado com assinatura válida sobre ele.
    const notJson = btoa("{nao-json").replace(/=+$/, "");
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const raw = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("hnbcrm-unsub-v1|" + notJson)));
    let bin = "";
    for (const b of raw) bin += String.fromCharCode(b);
    const sigB64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyUnsubToken(`v1.${notJson}.${sigB64}`, { current: SECRET })).toBeNull();
  });

  it("token acima de 512 caracteres é recusado antes de qualquer cripto", async () => {
    const huge = await signRaw(SECRET, { v: 1, o: "o".repeat(120), m: "m".repeat(120), k: "bn", pad: "x".repeat(400) });
    expect(huge.length).toBeGreaterThan(UNSUB_TOKEN_MAX_LEN);
    expect(await verifyUnsubToken(huge, { current: SECRET })).toBeNull();
    expect(await verifyUnsubToken("v1." + "A".repeat(600), { current: SECRET })).toBeNull();
  });

  it("sem segredo: sign lança e verify devolve null", async () => {
    await expect(signUnsubToken("", CLAIMS)).rejects.toThrow(/NOTIFICATION_UNSUB_SECRET/);
    const token = await signUnsubToken(SECRET, CLAIMS);
    expect(await verifyUnsubToken(token, {})).toBeNull();
    expect(await verifyUnsubToken(token, { current: "", prev: "" })).toBeNull();
  });

  it("segredo curto (< 32): sign lança e verify ignora o segredo", async () => {
    await expect(signUnsubToken(SHORT_SECRET, CLAIMS)).rejects.toThrow(/32 caracteres/);
    const token = await signUnsubToken(SECRET, CLAIMS);
    expect(await verifyUnsubToken(token, { current: SHORT_SECRET })).toBeNull();
  });

  it("rotação: token do segredo antigo verifica com `prev`; o `prev` sozinho não assina para o atual", async () => {
    const oldToken = await signUnsubToken(OTHER_SECRET, CLAIMS);
    expect(await verifyUnsubToken(oldToken, { current: SECRET })).toBeNull();
    expect(await verifyUnsubToken(oldToken, { current: SECRET, prev: OTHER_SECRET })).toEqual(CLAIMS);
    // Assinado com o que agora é `prev`, sem `prev` configurado: inválido.
    expect(await verifyUnsubToken(oldToken, { current: SECRET, prev: undefined })).toBeNull();
    // Token novo continua valendo durante a rotação.
    const newToken = await signUnsubToken(SECRET, CLAIMS);
    expect(await verifyUnsubToken(newToken, { current: SECRET, prev: OTHER_SECRET })).toEqual(CLAIMS);
  });

  it("membros diferentes (e orgs diferentes) geram tokens diferentes", async () => {
    const a = await signUnsubToken(SECRET, CLAIMS);
    const b = await signUnsubToken(SECRET, { ...CLAIMS, memberId: "member_fake_2" });
    const c = await signUnsubToken(SECRET, { ...CLAIMS, organizationId: "org_fake_2" });
    expect(new Set([a, b, c]).size).toBe(3);
    // Determinístico: o mesmo membro gera o mesmo token.
    expect(await signUnsubToken(SECRET, CLAIMS)).toBe(a);
  });
});

describe("unsubSecretsFromEnv", () => {
  it("lê atual e anterior e descarta valores curtos", () => {
    vi.stubEnv("NOTIFICATION_UNSUB_SECRET", SECRET);
    vi.stubEnv("NOTIFICATION_UNSUB_SECRET_PREV", SHORT_SECRET);
    expect(unsubSecretsFromEnv()).toEqual({ current: SECRET });
    vi.stubEnv("NOTIFICATION_UNSUB_SECRET_PREV", OTHER_SECRET);
    expect(unsubSecretsFromEnv()).toEqual({ current: SECRET, prev: OTHER_SECRET });
    vi.stubEnv("NOTIFICATION_UNSUB_SECRET", "");
    expect(unsubSecretsFromEnv()).toEqual({ prev: OTHER_SECRET });
  });
});

describe("buildUnsubLinks", () => {
  it("página no app e one-click no site do Convex", async () => {
    vi.stubEnv("APP_URL", "https://app.example.test/");
    vi.stubEnv("CONVEX_SITE_URL", "https://fake-site.example.test/");
    const token = await signUnsubToken(SECRET, CLAIMS);
    expect(buildUnsubLinks(token)).toEqual({
      pageUrl: `https://app.example.test/notificacoes/desativar?t=${token}`,
      oneClickUrl: `https://fake-site.example.test/notifications/unsubscribe?t=${token}`,
    });
  });

  it("sem CONVEX_SITE_URL lança (o chamador retém o envio)", () => {
    vi.stubEnv("CONVEX_SITE_URL", "");
    expect(() => buildUnsubLinks("v1.a.b")).toThrow(/CONVEX_SITE_URL/);
  });
});

describe("unsubIpThrottleKey", () => {
  it("nunca contém o IP cru; sem IP vira o balde unknown", async () => {
    const key = await unsubIpThrottleKey("203.0.113.7", SECRET);
    expect(key).toMatch(/^unsub ip:[0-9a-f]{16}$/);
    expect(key).not.toContain("203.0.113.7");
    expect(await unsubIpThrottleKey("203.0.113.8", SECRET)).not.toBe(key);
    expect(await unsubIpThrottleKey("203.0.113.7", SECRET)).toBe(key);
    expect(await unsubIpThrottleKey(null, SECRET)).toBe("unsub ip:unknown");
  });
});
