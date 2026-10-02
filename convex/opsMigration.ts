/**
 * Ops de migração/separação de deployments (docs/OPS-SEPARAR-DEV-PROD.md).
 * SÓ funções internas; todas com `dryRun` default TRUE. Nunca logam token.
 *
 *  - internalRepointBridgeWebhooks: aponta o webhook de cada instância bridge
 *    ativa para a URL do deployment novo (`POST /webhook` do wuzapi, token da
 *    própria instância) e confere com `GET /webhook`.
 *  - internalDisarmAllChannels: no deployment que vira cópia (dev), desativa
 *    TODO canal e apaga as credenciais — sem isto health check, exclusividade de
 *    número, publicação de grupo e campanha continuam falando com o gateway/Meta.
 *  - internalCancelPendingScheduled: cancela todas as funções agendadas pendentes.
 *  - internalRearmScheduledMessages: após restore (o backup não leva agendadas),
 *    re-arma as mensagens agendadas `pending`.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { decryptSecret } from "./lib/secretCrypto";
import { BRIDGE_WEBHOOK_EVENTS, buildBridgeHmacConfigRequest } from "./lib/bridgeSession";
import { computeNextRunAt, scheduleGroupPostTick, wakeAtFor } from "./lib/groupPostOps";
import { scheduleWhatsappDispatch } from "./lib/whatsappDispatch";

const trimBase = (u: string) => u.replace(/\/+$/, "");

export const internalListBridgeChannels = internalQuery({
  args: {},
  returns: v.array(
    v.object({
      configId: v.id("channelConfigs"),
      organizationId: v.id("organizations"),
      name: v.string(),
      baseUrl: v.string(),
      tokenEncrypted: v.string(),
      status: v.string(),
    })
  ),
  handler: async (ctx) => {
    const all = await ctx.db.query("channelConfigs").collect();
    return all
      .filter((c) => c.provider === "bridge" && c.status === "active" && c.bridgeBaseUrl && c.bridgeTokenEncrypted)
      .map((c) => ({
        configId: c._id,
        organizationId: c.organizationId,
        name: c.displayName,
        baseUrl: c.bridgeBaseUrl!,
        tokenEncrypted: c.bridgeTokenEncrypted!,
        status: c.status,
      }));
  },
});

export const internalRepointBridgeWebhooks = internalAction({
  args: { webhookUrl: v.string(), dryRun: v.optional(v.boolean()) },
  returns: v.array(
    v.object({ name: v.string(), ok: v.boolean(), detail: v.string() })
  ),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const url = args.webhookUrl.trim();
    if (!/^https:\/\/.+\/webhooks\/bridge$/.test(url)) {
      throw new Error("webhookUrl deve ser https://<deployment>.convex.site/webhooks/bridge");
    }
    const channels = await ctx.runQuery(internal.opsMigration.internalListBridgeChannels, {});
    const out: { name: string; ok: boolean; detail: string }[] = [];
    for (const ch of channels) {
      if (dryRun) {
        out.push({ name: ch.name, ok: true, detail: `dryRun: apontaria ${ch.baseUrl} → ${url}` });
        continue;
      }
      try {
        const token = await decryptSecret(ch.tokenEncrypted);
        const headers = { "Content-Type": "application/json", token };
        const set = await fetch(`${trimBase(ch.baseUrl)}/webhook`, {
          method: "POST",
          headers,
          // O SetWebhook do wuzapi lê `webhookurl` (o AddUser do provisionamento lê
          // `webhook`). Mandar só `webhook` aqui ZERA a URL — medido em 02/10/2026.
          body: JSON.stringify({ webhookurl: url, webhook: url, events: [...BRIDGE_WEBHOOK_EVENTS] }),
        });
        const setBody = await set.text();
        const get = await fetch(`${trimBase(ch.baseUrl)}/webhook`, { method: "GET", headers });
        const getBody: unknown = await get.json().catch(() => ({}));
        const g = getBody as { data?: { webhook?: string; webhookurl?: string }; webhook?: string };
        const current = g?.data?.webhook ?? g?.data?.webhookurl ?? g?.webhook ?? "";
        const ok = set.ok && current === url;
        out.push({
          name: ch.name,
          ok,
          detail: ok
            ? `webhook = ${current}`
            : `POST ${set.status} ${setBody.slice(0, 120)} · GET webhook = ${current || "?"}`,
        });
      } catch (e) {
        out.push({ name: ch.name, ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  },
});

export const internalDisarmAllChannels = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({ total: v.number(), changed: v.number(), dryRun: v.boolean() }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const all = await ctx.db.query("channelConfigs").collect();
    let changed = 0;
    for (const c of all) {
      const needs =
        c.status !== "disabled" || c.bridgeTokenEncrypted || c.accessTokenEncrypted || c.appSecretEncrypted;
      if (!needs) continue;
      changed++;
      if (dryRun) continue;
      await ctx.db.patch(c._id, {
        status: "disabled",
        bridgeTokenEncrypted: undefined,
        accessTokenEncrypted: undefined,
        appSecretEncrypted: undefined,
        healthDetail: "Desarmado: deployment virou cópia (ops de separação dev/prod)",
        updatedAt: Date.now(),
      });
    }
    return { total: all.length, changed, dryRun };
  },
});

export const internalCancelPendingScheduled = internalMutation({
  args: { dryRun: v.optional(v.boolean()), limit: v.optional(v.number()) },
  returns: v.object({ pending: v.number(), canceled: v.number(), byFn: v.record(v.string(), v.number()) }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const rows = await ctx.db.system.query("_scheduled_functions").take(args.limit ?? 2000);
    const pending = rows.filter((r) => r.state.kind === "pending");
    const byFn: Record<string, number> = {};
    for (const r of pending) byFn[r.name] = (byFn[r.name] ?? 0) + 1;
    let canceled = 0;
    if (!dryRun) {
      for (const r of pending) {
        await ctx.scheduler.cancel(r._id);
        canceled++;
      }
    }
    return { pending: pending.length, canceled, byFn };
  },
});

export const internalRearmScheduledMessages = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.array(v.object({ id: v.id("scheduledMessages"), when: v.number(), action: v.string() })),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const all = await ctx.db.query("scheduledMessages").collect();
    const now = Date.now();
    const out: { id: typeof all[number]["_id"]; when: number; action: string }[] = [];
    for (const m of all) {
      if (m.status !== "pending") continue;
      const when = Math.max(m.scheduledAt, now + 5_000);
      out.push({ id: m._id, when, action: dryRun ? "dryRun" : "rearmed" });
      if (dryRun) continue;
      const fnId = await ctx.scheduler.runAt(when, internal.scheduledMessages.deliver, {
        scheduledMessageId: m._id,
      });
      await ctx.db.patch(m._id, { scheduledFunctionId: fnId as string });
    }
    return out;
  },
});

/**
 * Após restore: o backup não leva agendadas, então toda publicação `active`
 * perde o tick. Re-arma pelo `nextRunAt` gravado (ou recalcula).
 */
export const internalRearmGroupPosts = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.array(v.object({ id: v.id("groupPosts"), nextRunAt: v.union(v.number(), v.null()), action: v.string() })),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const now = Date.now();
    const posts = await ctx.db.query("groupPosts").collect();
    const out: { id: typeof posts[number]["_id"]; nextRunAt: number | null; action: string }[] = [];
    for (const p of posts) {
      if (p.status !== "active") continue;
      const nextRunAt = p.nextRunAt ?? computeNextRunAt(p, now);
      if (nextRunAt === null) {
        out.push({ id: p._id, nextRunAt: null, action: "sem próximo slot" });
        continue;
      }
      out.push({ id: p._id, nextRunAt, action: dryRun ? "dryRun" : "rearmed" });
      if (dryRun) continue;
      if (p.nextRunAt === undefined) await ctx.db.patch(p._id, { nextRunAt });
      const fresh = (await ctx.db.get(p._id))!;
      await scheduleGroupPostTick(ctx, fresh, wakeAtFor(fresh, nextRunAt), now);
    }
    return out;
  },
});

/**
 * Após restore: mensagem outbound cujo dispatch estava agendado (sem
 * `externalId` nem `deliveryStatus`) perdeu o job. Reagenda o dispatch pelo
 * MESMO caminho do envio normal (pacing, typing, guarda de demoMode).
 */
export const internalRedispatchStuckOutbound = internalMutation({
  args: { sinceMs: v.number(), dryRun: v.optional(v.boolean()) },
  returns: v.array(v.object({ messageId: v.id("messages"), createdAt: v.number(), action: v.string() })),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const from = Date.now() - args.sinceMs;
    const recent = await ctx.db.query("messages").order("desc").take(500);
    const out: { messageId: typeof recent[number]["_id"]; createdAt: number; action: string }[] = [];
    for (const m of recent) {
      if (m.createdAt < from) break;
      if (m.direction !== "outbound" || m.isInternal || m.externalId || m.deliveryStatus) continue;
      const conversation = await ctx.db.get(m.conversationId);
      if (!conversation) continue;
      out.push({ messageId: m._id, createdAt: m.createdAt, action: dryRun ? "dryRun" : "redispatched" });
      if (dryRun) continue;
      await scheduleWhatsappDispatch(ctx, conversation, m._id);
    }
    return out;
  },
});

/**
 * Reaplica a chave HMAC (WA_BRIDGE_HMAC_SECRET) no cache vivo de cada instância
 * bridge ativa (`POST /session/hmac/config`). Idempotente para quem já assina
 * certo; conserta instância cujo gateway perdeu/trocou a chave (webhook 401).
 */
export const internalReapplyBridgeHmac = internalAction({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.array(v.object({ name: v.string(), ok: v.boolean(), detail: v.string() })),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const hmacKey = process.env.WA_BRIDGE_HMAC_SECRET;
    if (!hmacKey || hmacKey.length < 32) throw new Error("WA_BRIDGE_HMAC_SECRET ausente/curto neste deployment");
    const channels = await ctx.runQuery(internal.opsMigration.internalListBridgeChannels, {});
    const out: { name: string; ok: boolean; detail: string }[] = [];
    for (const ch of channels) {
      if (dryRun) {
        out.push({ name: `${ch.name} (${ch.configId})`, ok: true, detail: "dryRun" });
        continue;
      }
      try {
        const token = await decryptSecret(ch.tokenEncrypted);
        const req = buildBridgeHmacConfigRequest({ baseUrl: ch.baseUrl, token, hmacKey });
        const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
        const body = await res.text();
        out.push({ name: `${ch.name} (${ch.configId})`, ok: res.ok, detail: `HTTP ${res.status} ${body.slice(0, 100)}` });
      } catch (e) {
        out.push({ name: `${ch.name} (${ch.configId})`, ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
    }
    return out;
  },
});

/**
 * No deployment que virou cópia (dev): desativa TODAS as API keys para que uma
 * integração antiga que ainda chame a URL velha falhe com 401 em vez de operar
 * em silêncio sobre dados congelados. Reversível (`isActive`).
 */
export const internalDeactivateAllApiKeys = internalMutation({
  args: { dryRun: v.optional(v.boolean()) },
  returns: v.object({
    total: v.number(),
    deactivated: v.number(),
    keys: v.array(v.object({ organizationId: v.id("organizations"), name: v.string(), lastUsed: v.union(v.number(), v.null()) })),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const all = await ctx.db.query("apiKeys").collect();
    const active = all.filter((k) => k.isActive);
    if (!dryRun) {
      for (const k of active) await ctx.db.patch(k._id, { isActive: false });
    }
    return {
      total: all.length,
      deactivated: dryRun ? 0 : active.length,
      keys: active.map((k) => ({ organizationId: k.organizationId, name: k.name, lastUsed: k.lastUsed ?? null })),
    };
  },
});
