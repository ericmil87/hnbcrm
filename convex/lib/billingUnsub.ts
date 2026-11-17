/**
 * Token do link "Desativar" dos e-mails de cobrança (`billingNotices`). PURO (sem `ctx`),
 * Web Crypto como em `lib/emailVerification.ts`.
 *
 * Formato: `v1.<payload b64url>.<assinatura b64url>`.
 *  - payload = JSON `{v:1, o:<organizationId>, m:<teamMemberId>, k:"bn"}` (sem e-mail, nome
 *    nem valor: o token sai em cabeçalho `List-Unsubscribe` e pode ficar em log de terceiros);
 *  - assinatura = HMAC-SHA256(`NOTIFICATION_UNSUB_SECRET`, `"hnbcrm-unsub-v1|" + <payload b64url>`).
 *
 * Sem expiração de propósito: o link precisa valer meses depois do envio. A revogação é por
 * rotação do segredo (`NOTIFICATION_UNSUB_SECRET_PREV` vale só na VERIFICAÇÃO durante a troca)
 * e, na mutation, pela revalidação do membro (removido = inválido).
 *
 * Verificação: tamanho e formato primeiro, depois `crypto.subtle.verify` (tempo constante),
 * e só então o JSON do payload é lido. Qualquer falha = null (o chamador responde igual para
 * todas). Segredo ausente ou com menos de 32 caracteres: `sign` lança, `verify` devolve null.
 */
import { appUrl } from "./appUrl";

export const UNSUB_TOKEN_MAX_LEN = 512;
export const UNSUB_SECRET_MIN_LEN = 32;

const TOKEN_VERSION = "v1";
const SIGNING_DOMAIN = "hnbcrm-unsub-v1|";
const KIND_BILLING_NOTICES = "bn";
/** Ids do Convex têm ~32 caracteres; o teto só barra lixo. */
const MAX_ID_LEN = 128;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export type UnsubClaims = { organizationId: string; memberId: string };
export type UnsubSecrets = { current?: string; prev?: string };

function usableSecret(secret: string | undefined): string | undefined {
  return typeof secret === "string" && secret.length >= UNSUB_SECRET_MIN_LEN ? secret : undefined;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decodificação ESTRITA: só o alfabeto url-safe, sem padding e na forma canônica (reencodar
 * devolve a mesma string). Sem isso, a mesma assinatura teria várias grafias válidas.
 */
function b64urlDecode(s: string): Uint8Array | null {
  if (!s || !B64URL_RE.test(s) || s.length % 4 === 1) return null;
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return b64urlEncode(bytes) === s ? bytes : null;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LEN;
}

/** Assina o token de um membro numa org. Lança sem segredo utilizável (nunca há chave fixa). */
export async function signUnsubToken(
  secret: string,
  p: { organizationId: string; memberId: string },
): Promise<string> {
  const key = usableSecret(secret);
  if (!key) {
    throw new Error(
      `billingUnsub: NOTIFICATION_UNSUB_SECRET ausente ou com menos de ${UNSUB_SECRET_MIN_LEN} caracteres`,
    );
  }
  if (!validId(p.organizationId) || !validId(p.memberId)) {
    throw new Error("billingUnsub: organizationId e memberId precisam ser strings não vazias");
  }
  const payload = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ v: 1, o: p.organizationId, m: p.memberId, k: KIND_BILLING_NOTICES })),
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(key, "sign"),
    new TextEncoder().encode(SIGNING_DOMAIN + payload),
  );
  return `${TOKEN_VERSION}.${payload}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verifica o token com o segredo atual e, na rotação, o anterior. Devolve os ids (strings
 * ainda NÃO normalizadas: o chamador passa por `ctx.db.normalizeId`) ou null.
 */
export async function verifyUnsubToken(token: string, secrets: UnsubSecrets): Promise<UnsubClaims | null> {
  try {
    if (typeof token !== "string" || token.length === 0 || token.length > UNSUB_TOKEN_MAX_LEN) return null;
    const keys = [usableSecret(secrets.current), usableSecret(secrets.prev)].filter(
      (k): k is string => k !== undefined,
    );
    if (keys.length === 0) return null;

    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
    const [, payloadB64, sigB64] = parts;
    const payloadBytes = b64urlDecode(payloadB64);
    const sigBytes = b64urlDecode(sigB64);
    if (!payloadBytes || !sigBytes || sigBytes.length !== 32) return null;

    const signed = new TextEncoder().encode(SIGNING_DOMAIN + payloadB64);
    let authentic = false;
    for (const key of keys) {
      if (await crypto.subtle.verify("HMAC", await hmacKey(key, "verify"), sigBytes, signed)) {
        authentic = true;
        break;
      }
    }
    if (!authentic) return null;

    // Só depois da assinatura: o JSON é nosso, mas a leitura continua defensiva.
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const claims = parsed as Record<string, unknown>;
    if (claims.v !== 1 || claims.k !== KIND_BILLING_NOTICES) return null;
    if (!validId(claims.o) || !validId(claims.m)) return null;
    return { organizationId: claims.o, memberId: claims.m };
  } catch {
    return null;
  }
}

/** Segredos do ambiente; valor com menos de 32 caracteres é descartado (= ausente). */
export function unsubSecretsFromEnv(): UnsubSecrets {
  const current = usableSecret(process.env.NOTIFICATION_UNSUB_SECRET?.trim());
  const prev = usableSecret(process.env.NOTIFICATION_UNSUB_SECRET_PREV?.trim());
  return { ...(current ? { current } : {}), ...(prev ? { prev } : {}) };
}

/** Página pública do app que mostra o estado e só age por clique (`/notificacoes/desativar`). */
export function unsubPageUrl(token: string): string {
  return `${appUrl()}/notificacoes/desativar?t=${encodeURIComponent(token)}`;
}

/**
 * Links do rodapé e do cabeçalho `List-Unsubscribe`. `CONVEX_SITE_URL` ausente LANÇA (decisão:
 * um `oneClickUrl` vazio geraria cabeçalho inválido sem ninguém perceber). O Convex define essa
 * variável em todo deployment; quem monta o e-mail captura o erro e retém o envio da classe.
 */
export function buildUnsubLinks(token: string): { pageUrl: string; oneClickUrl: string } {
  const site = process.env.CONVEX_SITE_URL?.trim().replace(/\/+$/, "");
  if (!site) throw new Error("billingUnsub: CONVEX_SITE_URL ausente neste deployment");
  return {
    pageUrl: unsubPageUrl(token),
    oneClickUrl: `${site}/notifications/unsubscribe?t=${encodeURIComponent(token)}`,
  };
}

/**
 * Chave do teto por IP em `authEmailThrottle`: `unsub ip:<16 hex>`. Nunca o IP cru: SHA-256
 * truncado (64 bits) de um prefixo de domínio + o segredo atual (sem segredo, só o prefixo;
 * nesse caso o endpoint recusa todo token mesmo). Com o segredo no meio, o hash de um IPv4
 * não se reverte por força bruta olhando só o banco. Sem IP = balde `unsub ip:unknown`.
 */
export async function unsubIpThrottleKey(ipKey: string | null | undefined, secret?: string): Promise<string> {
  if (!ipKey) return "unsub ip:unknown";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`hnbcrm-unsub-ip|${usableSecret(secret) ?? ""}|${ipKey}`),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  return `unsub ip:${hex}`;
}
