/**
 * Ops: sonda da foto de perfil no gateway (wuzapi `POST /user/avatar`).
 *
 * Só leitura, só `npx convex run` (nunca UI). Serve para medir, na versão do
 * gateway que está no ar, o formato da resposta, o que volta para foto oculta
 * ou ausente e a validade/peso da URL devolvida pelo WhatsApp. Não grava nada
 * e nunca devolve a URL inteira (só host, nomes dos parâmetros e a validade).
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptSecret } from "./lib/secretCrypto";
import { manualAvatarFields } from "./lib/contactAvatarOps";

function describeUrl(raw: unknown): unknown {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    const oe = url.searchParams.get("oe");
    const oeSeconds = oe && /^[0-9a-f]+$/i.test(oe) ? parseInt(oe, 16) : null;
    return {
      host: url.host,
      pathLength: url.pathname.length,
      params: Array.from(url.searchParams.keys()),
      stp: url.searchParams.get("stp"),
      expiresAt: oeSeconds ? new Date(oeSeconds * 1000).toISOString() : null,
    };
  } catch {
    return { unparsable: true, length: raw.length };
  }
}

function pick(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    const value = (obj as Record<string, unknown>)[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

export const internalProbeAvatar = internalAction({
  args: {
    channelConfigId: v.id("channelConfigs"),
    /** Telefone (só dígitos) ou JID completo (`…@g.us`, `…@lid`). */
    target: v.string(),
    /** Baixa a imagem para medir tipo e peso (padrão: sim). */
    download: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const ch = await ctx.runQuery(internal.startConversation.internalProbeChannel, {
      channelConfigId: args.channelConfigId,
    });
    if (!ch) return { error: "canal sem bridge" };
    const token = await decryptSecret(ch.tokenEncrypted);
    const base = ch.baseUrl.replace(/\/+$/, "");
    const headers = { "Content-Type": "application/json", token };
    const out: Record<string, unknown> = {};
    for (const preview of [true, false]) {
      const key = preview ? "preview" : "full";
      try {
        const res = await fetch(`${base}/user/avatar`, {
          method: "POST",
          headers,
          body: JSON.stringify({ Phone: args.target, Preview: preview }),
          signal: AbortSignal.timeout(10_000),
        });
        const text = await res.text();
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* texto cru */
        }
        const data = pick(json, "data", "Data") ?? json;
        const url = pick(data, "url", "URL", "Url");
        const entry: Record<string, unknown> = {
          status: res.status,
          envelopeKeys: json && typeof json === "object" ? Object.keys(json as object) : null,
          dataKeys: data && typeof data === "object" ? Object.keys(data as object) : null,
          id: pick(data, "id", "ID", "Id") ?? null,
          type: pick(data, "type", "Type") ?? null,
          error: pick(json, "error", "Error") ?? (json === null ? text.slice(0, 200) : null),
          success: pick(json, "success", "Success") ?? null,
          url: describeUrl(url),
        };
        if (typeof url === "string" && args.download !== false) {
          try {
            const img = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            const bytes = new Uint8Array(await img.arrayBuffer());
            entry.download = {
              status: img.status,
              contentType: img.headers.get("content-type"),
              bytes: bytes.length,
              signature: Array.from(bytes.slice(0, 4))
                .map((b) => b.toString(16).padStart(2, "0"))
                .join(""),
            };
          } catch (e) {
            entry.download = { error: e instanceof Error ? e.message : String(e) };
          }
        }
        out[key] = entry;
      } catch (e) {
        out[key] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    return out;
  },
});

const REPORT_PAGE = 2000;

/**
 * Contagens da foto de perfil por status (só números). Lê até `REPORT_PAGE`
 * linhas por chamada; `truncated` avisa quando a tabela é maior (use um `organizationId`).
 * Sem backfill em lote: a foto chega por mensagem recebida ou conversa aberta.
 */
export const internalAvatarReport = internalQuery({
  args: { organizationId: v.optional(v.id("organizations")) },
  returns: v.object({
    total: v.number(),
    ok: v.number(),
    hidden: v.number(),
    none: v.number(),
    error: v.number(),
    pending: v.number(),
    pausedChannels: v.number(),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const organizationId = args.organizationId;
    const rows = organizationId
      ? await ctx.db
          .query("contactAvatars")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
          .take(REPORT_PAGE + 1)
      : await ctx.db.query("contactAvatars").take(REPORT_PAGE + 1);
    const truncated = rows.length > REPORT_PAGE;
    const counted = truncated ? rows.slice(0, REPORT_PAGE) : rows;
    const out = { total: counted.length, ok: 0, hidden: 0, none: 0, error: 0, pending: 0 };
    for (const row of counted) {
      out[row.status] += 1;
      if (row.pendingSince !== undefined) out.pending += 1;
    }
    const pacing = organizationId
      ? await ctx.db
          .query("channelAvatarPacing")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
          .take(200)
      : await ctx.db.query("channelAvatarPacing").take(200);
    // Sem relógio em query: conta canais com pausa registrada (podem já ter vencido).
    const pausedChannels = pacing.filter((p) => p.pausedUntil !== undefined).length;
    return { ...out, pausedChannels, truncated };
  },
});

const BACKFILL_PAGE = 150;

/**
 * Backfill da foto MANUAL: contatos com `photoFileId` e sem `avatarUrl` (feitos antes
 * de `avatarUrl` existir) ganham o campo. Uma escrita por contato com foto manual.
 * `dryRun` padrão true (só conta); a execução real se reagenda por cursor. Só números.
 */
export const internalBackfillManualAvatarUrl = internalMutation({
  args: {
    organizationId: v.optional(v.id("organizations")),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    withManualPhoto: v.number(),
    needed: v.number(),
    written: v.number(),
    done: v.boolean(),
    nextCursor: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const numItems = Math.min(Math.max(Math.floor(args.pageSize ?? BACKFILL_PAGE), 1), 200);
    const organizationId = args.organizationId;
    const page = organizationId
      ? await ctx.db
          .query("contacts")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
          .paginate({ numItems, cursor: args.cursor ?? null })
      : await ctx.db.query("contacts").paginate({ numItems, cursor: args.cursor ?? null });
    let withManualPhoto = 0;
    let needed = 0;
    let written = 0;
    for (const contact of page.page) {
      if (!contact.photoFileId) continue;
      withManualPhoto += 1;
      if (contact.avatarUrl) continue;
      needed += 1;
      if (dryRun) continue;
      const fields = await manualAvatarFields(ctx, {
        organizationId: contact.organizationId,
        contactId: contact._id,
        photoFileId: contact.photoFileId,
      });
      if (fields.avatarUrl !== undefined) {
        await ctx.db.patch(contact._id, { avatarUrl: fields.avatarUrl });
        written += 1;
      }
    }
    if (!dryRun && !page.isDone) {
      await ctx.scheduler.runAfter(0, internal.opsContactAvatar.internalBackfillManualAvatarUrl, {
        ...(organizationId ? { organizationId } : {}),
        dryRun: false,
        cursor: page.continueCursor,
        pageSize: numItems,
      });
    }
    return {
      dryRun,
      scanned: page.page.length,
      withManualPhoto,
      needed,
      written,
      done: page.isDone,
      nextCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
