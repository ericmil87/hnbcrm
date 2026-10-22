/**
 * Saúde da credencial Meta Messaging (F4, D8). Parte pura (decisão e texto) +
 * helpers de rede SEM ctx (a action passa o token já decifrado). O token nunca
 * é logado: erro de rede devolve só a categoria.
 */
import { graphBase } from "./metaGraph";
import type { MutationCtx } from "../_generated/server";

export type MetaChannel = "messenger" | "instagram";

/** Janela de aviso antes de `data_access_expires_at` (D8). */
export const DATA_ACCESS_WARN_MS = 14 * 24 * 60 * 60 * 1000;
/** `metaSentMids` só serve para o eco do IG: 7 dias bastam. */
export const SENT_MID_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PURGE_BATCH = 200;

export const REQUIRED_SCOPE_BY_CHANNEL: Record<MetaChannel, string> = {
  messenger: "pages_messaging",
  instagram: "instagram_manage_messages",
};

export type HealthObservation = {
  isValid: boolean;
  scopes: string[];
  /** epoch ms; ausente = a Meta não informou (ou 0 = sem expiração). */
  dataAccessExpiresAt?: number;
  expiresAt?: number;
};

export type HealthVerdict =
  | { kind: "invalid"; detail: string }
  | { kind: "missing_scope"; detail: string }
  | { kind: "ok"; expiring: boolean };

/**
 * Inválido, ou sem o escopo de mensagens dos canais da conexão → reauth.
 * Lista de escopos vazia = a Meta não informou (token de Página às vezes vem
 * sem `scopes`): não dá para concluir que falta, então não acusa.
 */
export function evaluateHealth(args: {
  observation: HealthObservation;
  channels: MetaChannel[];
  now: number;
}): HealthVerdict {
  const { observation: o, channels, now } = args;
  if (!o.isValid) {
    return { kind: "invalid", detail: "A Meta informou que a autorização desta Página não é mais válida." };
  }
  if (o.scopes.length > 0) {
    const missing = channels.filter((c) => !o.scopes.includes(REQUIRED_SCOPE_BY_CHANNEL[c]));
    if (missing.length > 0) {
      return {
        kind: "missing_scope",
        detail: "A permissão de mensagens foi removida desta conexão. Reconecte e aceite todas as permissões.",
      };
    }
  }
  const expiring = o.dataAccessExpiresAt !== undefined && o.dataAccessExpiresAt - now < DATA_ACCESS_WARN_MS;
  return { kind: "ok", expiring };
}

export type DebugTokenResult =
  | { kind: "observation"; observation: HealthObservation }
  /** Rede/5xx/credencial do app: NÃO conta como token inválido. */
  | { kind: "unavailable"; reason: string };

/** Corpo do `GET /debug_token` → observação, ou "indisponível" quando o problema é nosso. */
export function parseDebugToken(status: number, body: unknown): DebugTokenResult {
  const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : null;
  if (data && typeof data.is_valid === "boolean") {
    const scopes = Array.isArray(data.scopes) ? data.scopes.filter((s): s is string => typeof s === "string") : [];
    const da = data.data_access_expires_at;
    const ex = data.expires_at;
    return {
      kind: "observation",
      observation: {
        isValid: data.is_valid,
        scopes,
        ...(typeof da === "number" && da > 0 ? { dataAccessExpiresAt: da * 1000 } : {}),
        ...(typeof ex === "number" && ex > 0 ? { expiresAt: ex * 1000 } : {}),
      },
    };
  }
  // `error` na RAIZ (inclusive 190) fala do `access_token` da chamada (APP_ID|APP_SECRET),
  // não do token da Página: segredo rotacionado, limite de taxa, 5xx. É problema nosso e
  // NUNCA invalida a conexão. Só `data.is_valid === false` (acima) invalida.
  return { kind: "unavailable", reason: `HTTP ${status}` };
}

/** `GET /debug_token` com o token do app. Nunca lança; nunca loga URL. */
export async function fetchDebugToken(args: {
  pageToken: string;
  appId: string;
  appSecret: string;
  timeoutMs?: number;
}): Promise<DebugTokenResult> {
  try {
    const url =
      `${graphBase("facebook_login")}/debug_token?input_token=${encodeURIComponent(args.pageToken)}` +
      `&access_token=${encodeURIComponent(`${args.appId}|${args.appSecret}`)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(args.timeoutMs ?? 8000) });
    const body: unknown = await res.json().catch(() => ({}));
    return parseDebugToken(res.status, body);
  } catch (e) {
    return { kind: "unavailable", reason: e instanceof Error ? e.name : "erro" };
  }
}

export type GraphGetResult = { ok: boolean; status: number; body: Record<string, unknown> };

/** `GET /{path}` com o token da conexão no header. `null` = erro de rede. */
export async function graphGetJson(path: string, token: string, timeoutMs = 8000): Promise<GraphGetResult | null> {
  try {
    const res = await fetch(`${graphBase("facebook_login")}/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed: unknown = await res.json().catch(() => ({}));
    const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return { ok: res.ok, status: res.status, body };
  } catch {
    return null;
  }
}

export function isGraphAuthError(res: { body: Record<string, unknown> } | null): boolean {
  const err = res?.body.error;
  return !!err && typeof err === "object" && (err as Record<string, unknown>).code === 190;
}

// ── Avatar da conta (só do negócio) ─────────────────────────────────────────

export const AVATAR_MAX_BYTES = 1024 * 1024;

/** Baixa uma imagem (≤ 1 MB, image/*, 8 s). `null` em qualquer falha: segue sem avatar. */
export async function downloadAvatar(url: string): Promise<Blob | null> {
  try {
    if (!/^https:\/\//i.test(url)) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("image/")) return null;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > AVATAR_MAX_BYTES) return null;
    // Lê em pedaços e aborta acima do teto (o content-length pode mentir ou faltar).
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AVATAR_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
    if (size === 0) return null;
    return new Blob(chunks as BlobPart[], { type: mime });
  } catch {
    return null;
  }
}

export type AvatarBlobs = { messenger?: Blob; instagram?: Blob };

/** Foto da Página e do perfil IG. Qualquer falha = sem a foto (nunca lança). */
export async function fetchAccountAvatars(args: {
  pageToken: string;
  pageId: string;
  igAccountId?: string;
}): Promise<AvatarBlobs> {
  const out: AvatarBlobs = {};
  const page = await graphGetJson(
    `${encodeURIComponent(args.pageId)}?fields=${encodeURIComponent("picture{url}")}`,
    args.pageToken
  );
  const picture = page?.ok ? (page.body.picture as { data?: { url?: unknown } } | undefined) : undefined;
  const pageUrl = picture?.data?.url;
  if (typeof pageUrl === "string") {
    const blob = await downloadAvatar(pageUrl);
    if (blob) out.messenger = blob;
  }
  if (args.igAccountId) {
    const ig = await graphGetJson(`${encodeURIComponent(args.igAccountId)}?fields=profile_picture_url`, args.pageToken);
    const igUrl = ig?.ok ? ig.body.profile_picture_url : undefined;
    if (typeof igUrl === "string") {
      const blob = await downloadAvatar(igUrl);
      if (blob) out.instagram = blob;
    }
  }
  return out;
}

// ── Purga (cron + ops) ──────────────────────────────────────────────────────

export type PurgeCounts = { sentMids: number; oauthStates: number; oauthPending: number };

/**
 * Remove (ou, em `dryRun`, só conta) até `limit` linhas de cada tabela de apoio:
 * `metaSentMids` com mais de 7 dias, `oauthStates` e `metaOAuthPending` vencidos.
 * `more` = algum teto foi atingido (há mais para a próxima execução).
 */
export async function purgeMetaTemp(
  ctx: MutationCtx,
  args: { now: number; dryRun: boolean; limit?: number }
): Promise<PurgeCounts & { more: boolean }> {
  const limit = args.limit ?? PURGE_BATCH;
  const mids = await ctx.db
    .query("metaSentMids")
    .withIndex("by_created", (q) => q.lt("createdAt", args.now - SENT_MID_TTL_MS))
    .take(limit);
  const states = await ctx.db
    .query("oauthStates")
    .withIndex("by_expires", (q) => q.lt("expiresAt", args.now))
    .take(limit);
  const pending = await ctx.db
    .query("metaOAuthPending")
    .withIndex("by_expires", (q) => q.lt("expiresAt", args.now))
    .take(limit);
  if (!args.dryRun) {
    for (const r of mids) await ctx.db.delete(r._id);
    for (const r of states) await ctx.db.delete(r._id);
    for (const r of pending) await ctx.db.delete(r._id);
  }
  return {
    sentMids: mids.length,
    oauthStates: states.length,
    oauthPending: pending.length,
    more: mids.length === limit || states.length === limit || pending.length === limit,
  };
}
