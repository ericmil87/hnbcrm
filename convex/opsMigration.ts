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
import { BRIDGE_WEBHOOK_EVENTS } from "./lib/bridgeSession";

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
          body: JSON.stringify({ webhook: url, events: [...BRIDGE_WEBHOOK_EVENTS] }),
        });
        const setBody = await set.text();
        const get = await fetch(`${trimBase(ch.baseUrl)}/webhook`, { method: "GET", headers });
        const getBody: unknown = await get.json().catch(() => ({}));
        const current =
          (getBody as { data?: { webhook?: string }; webhook?: string })?.data?.webhook ??
          (getBody as { webhook?: string })?.webhook ??
          "";
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
