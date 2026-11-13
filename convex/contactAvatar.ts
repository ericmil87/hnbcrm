/**
 * Foto de perfil do contato do WhatsApp (bridge, só 1 a 1): busca no gateway,
 * guarda o ARQUIVO no storage do Convex e desnormaliza `contacts.avatarUrl`.
 *
 * Agendamento só por `maybeScheduleContactAvatar` (lib/contactAvatarOps.ts);
 * ritmo por canal em `channelAvatarPacing` (separado do cursor de ENVIO).
 * A action nunca lança por problema de gateway e nunca loga telefone nem URL.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { decryptSecret } from "./lib/secretCrypto";
import {
  AVATAR_FETCH_TIMEOUT_MS,
  MAX_AVATAR_BYTES,
  buildAvatarRequestBody,
  isAllowedAvatarUrl,
  parseAvatarResponse,
  readBodyCapped,
  validateAvatarBytes,
} from "./lib/bridgeAvatar";
import {
  AVATAR_ABSENT_RENEW_MS,
  AVATAR_CONFIG_SKIP_BACKOFF_MS,
  AVATAR_REFUSED_BACKOFF_MS,
  avatarPauseMs,
  pacingAfterAvatarError,
  avatarPhoneFor,
  computeNextCheckAt,
  whatsappAvatarContactPatch,
} from "./lib/contactAvatar";
import {
  classifyAvatarChannel,
  expireWhatsappAvatar,
  scheduleContactAvatarFetch,
  removeWhatsappAvatar,
  removeWhatsappAvatarNow,
} from "./lib/contactAvatarOps";
import { findContactsByPhoneCandidates } from "./lib/inboundRouting";
import { deleteBlobIfUnreferenced } from "./lib/fileRefs";
import { checkAvatarQuota } from "./lib/fileQuotas";
import { deleteFileRow, insertFileRow } from "./lib/storageUsage";
import type { MutationCtx } from "./_generated/server";

const keyArgs = {
  organizationId: v.id("organizations"),
  contactId: v.id("contacts"),
  channelConfigId: v.id("channelConfigs"),
};

/** Primeira resposta boa do gateway: zera a pausa/strikes do canal. */
async function noteGatewaySuccess(ctx: MutationCtx, channelConfigId: Id<"channelConfigs">): Promise<void> {
  const pacing = await ctx.db
    .query("channelAvatarPacing")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", channelConfigId))
    .first();
  if (
    pacing &&
    (pacing.strikes !== undefined || pacing.pausedUntil !== undefined || pacing.errorStreak !== undefined)
  ) {
    await ctx.db.patch(pacing._id, { strikes: undefined, pausedUntil: undefined, errorStreak: undefined });
  }
}

/**
 * Agendamento de fato (o gatilho do ingest/abrir conversa só agenda ESTA mutation):
 * revalida tudo, reserva o horário no cursor do canal e agenda a action. Fica fora
 * da transação do ingest para o doc único do canal nunca virar disputa de OCC.
 */
export const internalMaybeSchedule = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    contactId: v.id("contacts"),
    conversationId: v.id("conversations"),
    channelConfigId: v.optional(v.id("channelConfigs")),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    return await scheduleContactAvatarFetch(ctx, args);
  },
});

/**
 * Plano da busca, relido na hora de executar: contato e canal da MESMA org,
 * canal bridge ativo e conectado, canal não pausado por 429, linha ainda
 * pendente. `null` = não busca (a action carimba "skipped").
 */
export const internalGetAvatarPlan = internalQuery({
  args: keyArgs,
  returns: v.union(
    v.null(),
    v.object({
      baseUrl: v.string(),
      tokenEncrypted: v.string(),
      phone: v.string(),
      pictureId: v.union(v.string(), v.null()),
      hasBlob: v.boolean(),
      /** Pausa do canal por 429 (a action compara com o relógio). */
      pausedUntil: v.union(v.number(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.organizationId !== args.organizationId) return null;
    const config = await ctx.db.get(args.channelConfigId);
    if (classifyAvatarChannel(config, args.organizationId) !== "ok") return null;
    if (!config || !config.bridgeBaseUrl || !config.bridgeTokenEncrypted) return null;
    const row = await ctx.db
      .query("contactAvatars")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .first();
    if (!row || row.organizationId !== args.organizationId || row.pendingSince === undefined) return null;
    const pacing = await ctx.db
      .query("channelAvatarPacing")
      .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId))
      .first();
    const phone = avatarPhoneFor(contact);
    if (!phone) return null;
    return {
      baseUrl: config.bridgeBaseUrl,
      tokenEncrypted: config.bridgeTokenEncrypted,
      phone,
      pictureId: row.pictureId ?? null,
      hasBlob: !!row.fileId,
      pausedUntil: pacing?.pausedUntil ?? null,
    };
  },
});

export const internalFetchContactAvatar = internalAction({
  args: keyArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const record = async (
      outcome: "same" | "hidden" | "none" | "error" | "rate_limited" | "skipped" | "paused" | "refused"
    ) => {
      try {
        await ctx.runMutation(internal.contactAvatar.internalRecordAvatarCheck, { ...args, outcome });
      } catch {
        /* a linha vence sozinha em 10 min (pendingSince) */
      }
    };
    let storedId: Id<"_storage"> | null = null;
    try {
      const plan = await ctx.runQuery(internal.contactAvatar.internalGetAvatarPlan, args);
      if (!plan) {
        await record("skipped");
        return null;
      }
      if (plan.pausedUntil !== null && plan.pausedUntil > Date.now()) {
        await record("paused");
        return null;
      }
      const token = await decryptSecret(plan.tokenEncrypted);
      const res = await fetch(`${plan.baseUrl.replace(/\/+$/, "")}/user/avatar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", token },
        body: buildAvatarRequestBody(plan.phone),
        signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
      });
      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* texto cru */
      }
      const parsed = parseAvatarResponse(res.status, body);
      if (parsed.kind !== "ok") {
        await record(parsed.kind);
        return null;
      }
      if (!isAllowedAvatarUrl(parsed.url)) {
        await record("error");
        return null;
      }
      if (plan.hasBlob && plan.pictureId && parsed.pictureId === plan.pictureId) {
        await record("same");
        return null;
      }
      // Sem seguir redirecionamento (o CDN medido responde 200 direto): um 3xx/opaco é erro.
      const img = await fetch(parsed.url, {
        redirect: "manual",
        signal: AbortSignal.timeout(AVATAR_FETCH_TIMEOUT_MS),
      });
      const declared = Number(img.headers.get("content-length") ?? "0");
      if (
        img.status < 200 ||
        img.status >= 300 ||
        declared > MAX_AVATAR_BYTES ||
        (img.url && !isAllowedAvatarUrl(img.url))
      ) {
        await img.body?.cancel().catch(() => undefined);
        await record("error");
        return null;
      }
      const bytes = await readBodyCapped(img, MAX_AVATAR_BYTES);
      const checked = bytes ? validateAvatarBytes(bytes) : null;
      if (!bytes || !checked) {
        await record("error");
        return null;
      }
      storedId = await ctx.storage.store(new Blob([bytes], { type: checked.mime }));
      await ctx.runMutation(internal.contactAvatar.internalApplyContactAvatar, {
        ...args,
        storageId: storedId,
        mimeType: checked.mime,
        size: checked.size,
        ...(parsed.pictureId ? { pictureId: parsed.pictureId } : {}),
      });
      storedId = null; // a mutation assumiu o blob (guarda ou apaga)
    } catch (e) {
      console.warn(`contact avatar: falha (${e instanceof Error ? e.name : "erro"})`);
      if (storedId) await ctx.storage.delete(storedId).catch(() => undefined);
      await record("error");
    }
    return null;
  },
});

/**
 * Grava o resultado de uma busca que baixou uma foto NOVA. Uma transação:
 * `files` (porta de cota), apaga a foto anterior (porta de exclusão), linha
 * lateral e, só se o valor exibido muda, `contacts.avatarUrl`. Cota recusada ou
 * contato sumido: apaga o blob recém-guardado, sem lançar.
 */
export const internalApplyContactAvatar = internalMutation({
  args: {
    ...keyArgs,
    storageId: v.id("_storage"),
    mimeType: v.string(),
    size: v.number(),
    pictureId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const discard = async () => {
      await ctx.storage.delete(args.storageId).catch(() => undefined);
      return false;
    };
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.organizationId !== args.organizationId) return await discard();
    const row = await ctx.db
      .query("contactAvatars")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .first();
    if (!row || row.organizationId !== args.organizationId) return await discard();
    const config = await ctx.db.get(args.channelConfigId);
    const now = Date.now();
    if (!config || config.organizationId !== args.organizationId) {
      await ctx.db.patch(row._id, { pendingSince: undefined });
      return await discard();
    }
    const quota = await checkAvatarQuota(ctx, { organizationId: args.organizationId, fileSize: args.size });
    const url = quota.ok ? await ctx.storage.getUrl(args.storageId) : null;
    if (!quota.ok || !url) {
      const failures = Math.min((row.failures ?? 0) + 1, 10);
      await ctx.db.patch(row._id, {
        status: "error",
        failures,
        checkedAt: now,
        nextCheckAt: now + AVATAR_REFUSED_BACKOFF_MS,
        pendingSince: undefined,
      });
      return await discard();
    }

    const oldFile = row.fileId ? await ctx.db.get(row.fileId) : null;
    const fileId = await insertFileRow(ctx, {
      organizationId: args.organizationId,
      storageId: args.storageId,
      name: "whatsapp-avatar",
      mimeType: args.mimeType,
      size: args.size,
      // `files.fileType` não tem literal próprio (schema só aditivo): "other" +
      // metadata.kind. `contactId` só na metadata: o campo `files.contactId`
      // listaria a foto como arquivo do contato.
      fileType: "other",
      metadata: { kind: "contact_avatar", contactId: args.contactId },
      // `createdAt: 0` de propósito: o teto diário de uploads (`countUploadsLast24h`)
      // lê o índice `by_organization_and_created` com `createdAt > agora-24h`, então a
      // foto automática fica FORA da contagem sem custo de leitura. O horário real
      // está em `_creationTime` e em `contactAvatars.checkedAt`.
      createdAt: 0,
    });
    await ctx.db.patch(row._id, {
      channelConfigId: args.channelConfigId,
      status: "ok",
      pictureId: args.pictureId,
      fileId,
      storageId: args.storageId,
      url,
      checkedAt: now,
      nextCheckAt: computeNextCheckAt("ok", 0, now),
      failures: undefined,
      pendingSince: undefined,
    });
    if (oldFile && oldFile.organizationId === args.organizationId) {
      await deleteBlobIfUnreferenced(ctx, oldFile);
      await deleteFileRow(ctx, oldFile);
    }
    const effect = whatsappAvatarContactPatch({
      hasManualPhoto: !!contact.photoFileId,
      currentAvatarUrl: contact.avatarUrl,
      newWhatsappUrl: url,
    });
    if (effect.write) await ctx.db.patch(contact._id, { avatarUrl: effect.avatarUrl });
    await noteGatewaySuccess(ctx, args.channelConfigId);
    return true;
  },
});

/** Resultado de uma busca que NÃO trouxe foto nova. Só mexe na linha lateral (e no contato se a foto saiu). */
export const internalRecordAvatarCheck = internalMutation({
  args: {
    ...keyArgs,
    outcome: v.union(
      v.literal("same"),
      v.literal("hidden"),
      v.literal("none"),
      v.literal("error"),
      v.literal("rate_limited"),
      v.literal("skipped"),
      v.literal("paused"),
      v.literal("refused")
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("contactAvatars")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .first();
    if (!row || row.organizationId !== args.organizationId) return null;
    const now = Date.now();
    switch (args.outcome) {
      case "skipped":
        // Falta persistente de configuração (canal sem URL/token, inativo, sessão caída):
        // só reconfere em 1 h, para não reagendar a cada mensagem. Linha já fora de
        // pendência (outra busca terminou) não é tocada.
        if (row.pendingSince !== undefined) {
          await ctx.db.patch(row._id, {
            pendingSince: undefined,
            nextCheckAt: Math.max(row.nextCheckAt, now + AVATAR_CONFIG_SKIP_BACKOFF_MS),
          });
        }
        return null;
      case "paused":
        // Pausa do canal (429/disjuntor): só libera a trava; o agendamento já recusa
        // enquanto a pausa durar (sem escrita por mensagem).
        if (row.pendingSince !== undefined) await ctx.db.patch(row._id, { pendingSince: undefined });
        return null;
      case "same":
        await ctx.db.patch(row._id, {
          status: "ok",
          checkedAt: now,
          nextCheckAt: computeNextCheckAt("ok", 0, now),
          failures: undefined,
          pendingSince: undefined,
        });
        await noteGatewaySuccess(ctx, args.channelConfigId);
        return null;
      case "hidden":
      case "none": {
        const contact = await ctx.db.get(args.contactId);
        await removeWhatsappAvatar(ctx, row, contact && contact.organizationId === args.organizationId ? contact : null, {
          status: args.outcome,
          checkedAt: now,
          nextCheckAt: now + AVATAR_ABSENT_RENEW_MS,
        });
        await noteGatewaySuccess(ctx, args.channelConfigId);
        return null;
      }
      case "rate_limited": {
        const pacing = await ctx.db
          .query("channelAvatarPacing")
          .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId))
          .first();
        const strikes = (pacing?.strikes ?? 0) + 1;
        const pausedUntil = now + avatarPauseMs(strikes);
        if (pacing) {
          await ctx.db.patch(pacing._id, { strikes, pausedUntil });
        } else {
          await ctx.db.insert("channelAvatarPacing", {
            organizationId: args.organizationId,
            channelConfigId: args.channelConfigId,
            nextFetchAt: now,
            strikes,
            pausedUntil,
          });
        }
        await ctx.db.patch(row._id, { pendingSince: undefined, nextCheckAt: Math.max(row.nextCheckAt, pausedUntil) });
        return null;
      }
      case "refused":
      case "error": {
        if (args.outcome === "error") {
          // Disjuntor: 5 `error` seguidos no canal o pausam como o 429.
          const pacing = await ctx.db
            .query("channelAvatarPacing")
            .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId))
            .first();
          if (pacing) await ctx.db.patch(pacing._id, pacingAfterAvatarError(pacing, now));
        }
        const failures = Math.min((row.failures ?? 0) + 1, 10);
        await ctx.db.patch(row._id, {
          status: "error",
          failures,
          checkedAt: now,
          nextCheckAt:
            args.outcome === "refused"
              ? now + AVATAR_REFUSED_BACKOFF_MS
              : computeNextCheckAt("error", failures, now),
          pendingSince: undefined,
        });
        return null;
      }
    }
  },
});

/**
 * Evento `Picture` do bridge (1 a 1). Remove → apaga já a foto do WhatsApp e
 * marca `none`; senão só marca como vencida (a busca vem no próximo gatilho,
 * nunca no evento). Contato desconhecido ou de outra org: ignora sem escrever.
 */
export const internalApplyPictureEvent = internalMutation({
  args: {
    channelConfigId: v.id("channelConfigs"),
    phone: v.string(),
    remove: v.boolean(),
  },
  returns: v.union(v.literal("expired"), v.literal("removed"), v.literal("ignored")),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.channelConfigId);
    if (!config || config.channel !== "whatsapp" || config.provider !== "bridge") return "ignored";
    const contacts = await findContactsByPhoneCandidates(ctx, config.organizationId, args.phone);
    let result: "expired" | "removed" | "ignored" = "ignored";
    const now = Date.now();
    for (const contact of contacts.slice(0, 3)) {
      if (contact.organizationId !== config.organizationId) continue;
      if (args.remove) {
        if ((await removeWhatsappAvatarNow(ctx, config.organizationId, contact, now, now + AVATAR_ABSENT_RENEW_MS)) === "removed") {
          result = "removed";
        }
      } else if ((await expireWhatsappAvatar(ctx, config.organizationId, contact._id)) === "expired") {
        if (result === "ignored") result = "expired";
      }
    }
    return result;
  },
});
