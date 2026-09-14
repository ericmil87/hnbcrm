/**
 * Worker das campanhas — um job auto-reagendado POR campanha (`tick`), item a
 * item, reaproveitando o pipeline de envio que já existe:
 *
 *   tick → (bridge: checkNumberAndSend) → sendToRecipient
 *        → insere messages + applyOutboundMessageSideEffects (audit/activity/
 *          webhook + scheduleWhatsappDispatch → internalDispatchMessage)
 *
 * O tick decide APENAS "posso mandar o próximo agora?": janela, congelamento
 * do canal, tetos (channelPacing.campaignDaily/Hourly), kill switches, pausa
 * de lote. O delay entre destinatários vem de lib/campaignPacing.
 *
 * Idempotência: cada agendamento carrega um `tickToken`; um tick cujo token
 * não bate com o da campanha é um zumbi (pause/resume no meio) e sai.
 */
import { v } from "convex/values";
import { internalMutation, internalAction, internalQuery, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { configProvider } from "./channelConfigs";
import { decryptSecret } from "./lib/secretCrypto";
import { findOrCreateContactByPhone, ensureLeadForContact } from "./lib/inboundRouting";
import { getOrCreateConversation } from "./conversations";
import { applyOutboundMessageSideEffects } from "./lib/outboundSideEffects";
import {
  isWithinWindow,
  nextWindowOpenAt,
  capsExceeded,
  bumpCounters,
  evaluateKillSwitches,
  nextSendDelayMs,
  batchPauseMs,
} from "./lib/campaignPacing";
import {
  pickVariantIndex,
  renderText,
  renderTemplateComponents,
  renderTemplateBodyPreview,
} from "./lib/campaignRender";
import {
  transitionRecipient,
  pauseCampaignCore,
  completeCampaignCore,
  scheduleCampaignTick,
  addTimeline,
} from "./lib/campaignHooks";
import { isPhoneSuppressed } from "./lib/campaignAudience";
import { buildBridgeCheckUserRequest, parseBridgeCheckUserResponse, phoneFromJid } from "./lib/bridgeSession";
import { buildSearchText } from "./lib/searchText";

const CAMPAIGN_SOURCE_NAME = "Campanha";
const RETRY_SOON_MS = 60 * 1000;

async function tickGuard(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  tickToken: string
): Promise<Doc<"campaigns"> | null> {
  const campaign = await ctx.db.get(campaignId);
  if (!campaign) return null;
  if (campaign.status !== "running") return null;
  if (campaign.tickToken && campaign.tickToken !== tickToken) return null; // zumbi
  return campaign;
}

async function nextPendingRecipient(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  now: number
): Promise<{ recipient: Doc<"campaignRecipients"> | null; earliestScheduled: number | null }> {
  const rows = await ctx.db
    .query("campaignRecipients")
    .withIndex("by_campaign_and_status", (q) => q.eq("campaignId", campaignId).eq("status", "pending"))
    .take(50);
  let earliest: number | null = null;
  for (const r of rows) {
    if (!r.scheduledFor || r.scheduledFor <= now) return { recipient: r, earliestScheduled: null };
    earliest = earliest === null ? r.scheduledFor : Math.min(earliest, r.scheduledFor);
  }
  return { recipient: null, earliestScheduled: earliest };
}

async function pacingRow(ctx: MutationCtx, channelConfigId: Id<"channelConfigs">) {
  return await ctx.db
    .query("channelPacing")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", channelConfigId))
    .first();
}

/** Ainda há trabalho em voo (queued) ou pendente agendado para depois? */
async function hasOutstanding(ctx: MutationCtx, campaignId: Id<"campaigns">): Promise<boolean> {
  const queued = await ctx.db
    .query("campaignRecipients")
    .withIndex("by_campaign_and_status", (q) => q.eq("campaignId", campaignId).eq("status", "queued"))
    .first();
  return queued !== null;
}

export const tick = internalMutation({
  args: { campaignId: v.id("campaigns"), tickToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const guarded = await tickGuard(ctx, args.campaignId, args.tickToken);
    if (!guarded) return null;
    // Este job JÁ está rodando: solta o ponteiro para ninguém tentar cancelá-lo
    // (pause/reagendamento dentro do tick cancelariam a própria execução).
    await ctx.db.patch(guarded._id, { schedulerFnId: undefined });
    const campaign = (await ctx.db.get(guarded._id))!;

    const config = await ctx.db.get(campaign.channelConfigId);
    if (!config || config.status !== "active") {
      await pauseCampaignCore(ctx, campaign, { reason: "Canal indisponível ou desativado", automatic: true, now });
      return null;
    }
    const provider = configProvider(config);
    if (provider === "bridge" && config.bridgeSessionState && config.bridgeSessionState !== "connected") {
      await pauseCampaignCore(ctx, campaign, {
        reason: `Sessão do bridge ${config.bridgeSessionState === "banned" ? "BANIDA" : "desconectada"} — reconecte em Configurações → Canais`,
        automatic: true,
        now,
      });
      return null;
    }

    // Kill switches (avaliados antes de cada envio)
    const killReason = evaluateKillSwitches({ stats: campaign.stats, safety: campaign.safety });
    if (killReason) {
      await pauseCampaignCore(ctx, campaign, { reason: killReason, automatic: true, now });
      return null;
    }

    // Janela de envio
    if (!isWithinWindow(campaign.schedule, now)) {
      const at = nextWindowOpenAt(campaign.schedule, now);
      await scheduleCampaignTick(ctx, campaign, at, now);
      return null;
    }

    // Próximo destinatário
    const { recipient, earliestScheduled } = await nextPendingRecipient(ctx, campaign._id, now);
    if (!recipient) {
      if (earliestScheduled !== null) {
        await scheduleCampaignTick(ctx, campaign, earliestScheduled, now);
        return null;
      }
      if (await hasOutstanding(ctx, campaign._id)) {
        // mensagens ainda no dispatch — volta em 1 min para fechar
        await scheduleCampaignTick(ctx, campaign, now + RETRY_SOON_MS, now);
        return null;
      }
      await completeCampaignCore(ctx, campaign, now);
      return null;
    }

    // Supressão (pode ter entrado depois do snapshot)
    if (await isPhoneSuppressed(ctx, campaign.organizationId, recipient.phone)) {
      await transitionRecipient(ctx, recipient, "opted_out", { skipReason: "suppressed" }, { now, force: true });
      const fresh = (await ctx.db.get(campaign._id))!;
      await scheduleCampaignTick(ctx, fresh, now, now);
      return null;
    }

    // Contato novo? (sem conversa WhatsApp com inbound)
    const isNewContact = await recipientIsNewContact(ctx, campaign, recipient);

    // Tetos do canal
    const row = await pacingRow(ctx, campaign.channelConfigId);
    const caps = capsExceeded({ pacing: campaign.pacing, counters: row, now, isNewContact });
    if (!caps.ok) {
      await scheduleCampaignTick(ctx, campaign, caps.retryAt, now);
      await addTimelineOnce(ctx, campaign, "caps", caps.reason, now);
      return null;
    }

    // Pausa de lote
    const pauseMs = batchPauseMs(campaign.pacing, campaign.batchSentSinceLastPause ?? 0);
    if (pauseMs > 0) {
      await ctx.db.patch(campaign._id, { batchSentSinceLastPause: 0, updatedAt: now });
      const fresh = (await ctx.db.get(campaign._id))!;
      await scheduleCampaignTick(ctx, fresh, now + pauseMs, now);
      return null;
    }

    // Reserva o destinatário (queued) para nenhum outro tick pegá-lo
    await transitionRecipient(ctx, recipient, "queued", { isNewContact }, { now });

    if (provider === "bridge" && campaign.safety.checkNumbersFirst) {
      await ctx.scheduler.runAfter(0, internal.campaignWorker.checkNumberAndSend, {
        campaignId: campaign._id,
        recipientId: recipient._id,
        tickToken: args.tickToken,
      });
      return null;
    }
    await sendCore(ctx, {
      campaignId: campaign._id,
      recipientId: recipient._id,
      tickToken: args.tickToken,
      onWhatsapp: true,
    });
    return null;
  },
});

async function addTimelineOnce(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  kind: string,
  detail: string,
  now: number
) {
  const last = campaign.timeline?.[campaign.timeline.length - 1];
  if (last && last.kind === kind && last.detail === detail) return;
  const fresh = (await ctx.db.get(campaign._id))!;
  await addTimeline(ctx, fresh, { kind, detail }, now);
}

async function recipientIsNewContact(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  recipient: Doc<"campaignRecipients">
): Promise<boolean> {
  const contact =
    (recipient.contactId ? await ctx.db.get(recipient.contactId) : null) ??
    (await ctx.db
      .query("contacts")
      .withIndex("by_organization_and_phone", (q) =>
        q.eq("organizationId", campaign.organizationId).eq("phone", recipient.phone)
      )
      .first());
  if (!contact) return true;
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .take(20);
  for (const lead of leads) {
    if (lead.organizationId !== campaign.organizationId) continue;
    const convo = await ctx.db
      .query("conversations")
      .withIndex("by_lead_and_channel", (q) => q.eq("leadId", lead._id).eq("channel", "whatsapp"))
      .first();
    if (convo?.lastInboundAt) return false;
  }
  return true;
}

/** Bridge: POST /user/check antes de enviar. Falha de rede → envia mesmo assim. */
export const checkNumberAndSend = internalAction({
  args: { campaignId: v.id("campaigns"), recipientId: v.id("campaignRecipients"), tickToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(internal.campaignWorker.internalCheckContext, {
      campaignId: args.campaignId,
      recipientId: args.recipientId,
    });
    if (!context) return null;
    let onWhatsapp = true;
    let note: string | undefined;
    // Número canônico segundo o WhatsApp (o JID). No Brasil, números antigos
    // existem SEM o 9º dígito no WhatsApp mesmo tendo o 9 no celular — se a
    // gente gravar o contato com o número normalizado e a resposta chegar pelo
    // JID, viram dois contatos. Quem manda é o JID.
    let canonicalPhone: string | undefined;
    try {
      const token = await decryptSecret(context.bridgeTokenEncrypted);
      const req = buildBridgeCheckUserRequest({ baseUrl: context.bridgeBaseUrl, token, phones: [context.phone] });
      const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      const body = await res.json().catch(() => ({}));
      const parsed = parseBridgeCheckUserResponse(res.ok, res.status, body);
      if (parsed.ok) {
        const match = parsed.users.find((u) => u.phone === context.phone) ?? parsed.users[0];
        if (match) {
          onWhatsapp = match.onWhatsapp;
          const jidPhone = match.jid ? phoneFromJid(match.jid) : undefined;
          if (onWhatsapp && jidPhone && jidPhone !== context.phone) canonicalPhone = jidPhone;
        }
      } else {
        note = `checagem indisponível (${parsed.error}) — enviado sem confirmar`;
      }
    } catch (e) {
      note = `checagem indisponível (${e instanceof Error ? e.message : "erro de rede"}) — enviado sem confirmar`;
    }
    await ctx.runMutation(internal.campaignWorker.sendToRecipient, {
      campaignId: args.campaignId,
      recipientId: args.recipientId,
      tickToken: args.tickToken,
      onWhatsapp,
      note,
      canonicalPhone,
    });
    return null;
  },
});

export const internalCheckContext = internalQuery({
  args: { campaignId: v.id("campaigns"), recipientId: v.id("campaignRecipients") },
  returns: v.union(
    v.null(),
    v.object({ phone: v.string(), bridgeBaseUrl: v.string(), bridgeTokenEncrypted: v.string() })
  ),
  handler: async (ctx, args) => {
    const campaign = await ctx.db.get(args.campaignId);
    const recipient = await ctx.db.get(args.recipientId);
    if (!campaign || !recipient || recipient.campaignId !== campaign._id) return null;
    const config = await ctx.db.get(campaign.channelConfigId);
    if (!config?.bridgeBaseUrl || !config.bridgeTokenEncrypted) return null;
    return { phone: recipient.phone, bridgeBaseUrl: config.bridgeBaseUrl, bridgeTokenEncrypted: config.bridgeTokenEncrypted };
  },
});

async function findOrCreateCampaignSource(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  now: number
): Promise<Id<"leadSources">> {
  const sources = await ctx.db
    .query("leadSources")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .collect();
  const existing = sources.find((s) => s.type === "campaign") ?? sources.find((s) => s.name === CAMPAIGN_SOURCE_NAME);
  if (existing) return existing._id;
  return await ctx.db.insert("leadSources", {
    organizationId,
    name: CAMPAIGN_SOURCE_NAME,
    type: "campaign",
    isActive: true,
    createdAt: now,
  });
}

/**
 * Cria/resolve contato → lead → conversa, renderiza a mensagem, insere e
 * despacha. Agenda o próximo tick com o delay do pacing.
 */
export const sendToRecipient = internalMutation({
  args: {
    campaignId: v.id("campaigns"),
    recipientId: v.id("campaignRecipients"),
    tickToken: v.string(),
    onWhatsapp: v.boolean(),
    note: v.optional(v.string()),
    canonicalPhone: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await sendCore(ctx, args);
    return null;
  },
});

async function sendCore(
  ctx: MutationCtx,
  args: {
    campaignId: Id<"campaigns">;
    recipientId: Id<"campaignRecipients">;
    tickToken: string;
    onWhatsapp: boolean;
    note?: string;
    canonicalPhone?: string;
  }
): Promise<void> {
  {
    const now = Date.now();
    const campaign = await ctx.db.get(args.campaignId);
    let recipient = await ctx.db.get(args.recipientId);
    if (!campaign || !recipient || recipient.campaignId !== campaign._id) return;
    if (recipient.status !== "queued") return;
    if (args.canonicalPhone && args.canonicalPhone !== recipient.phone && /^\d{8,15}$/.test(args.canonicalPhone)) {
      // Se a campanha JÁ tem o número canônico como outro destinatário, este é
      // duplicata (mesmo WhatsApp, grafias diferentes) — pula sem enviar 2x.
      const dup = await ctx.db
        .query("campaignRecipients")
        .withIndex("by_campaign_and_phone", (q) => q.eq("campaignId", campaign._id).eq("phone", args.canonicalPhone!))
        .first();
      if (dup && dup._id !== recipient._id) {
        await transitionRecipient(ctx, recipient, "skipped", { skipReason: "duplicate_phone", lastError: `Mesmo WhatsApp que ${args.canonicalPhone}` }, { now, force: true });
        const fresh = (await ctx.db.get(campaign._id))!;
        if (fresh.status === "running") await scheduleCampaignTick(ctx, fresh, now + nextSendDelayMs(fresh.pacing), now);
        return;
      }
      await ctx.db.patch(recipient._id, { phone: args.canonicalPhone, vars: { ...(recipient.vars ?? {}), telefone_informado: recipient.phone } });
      recipient = (await ctx.db.get(recipient._id))!;
    }

    // Campanha pausada/cancelada enquanto a checagem rodava → devolve à fila
    if (campaign.status !== "running" || (campaign.tickToken && campaign.tickToken !== args.tickToken)) {
      await transitionRecipient(ctx, recipient, "pending", {}, { now, force: true });
      return;
    }

    const scheduleNext = async (extraMs = 0) => {
      const fresh = (await ctx.db.get(campaign._id))!;
      if (fresh.status !== "running") return;
      await scheduleCampaignTick(ctx, fresh, now + nextSendDelayMs(fresh.pacing) + extraMs, now);
    };

    if (!args.onWhatsapp) {
      await transitionRecipient(ctx, recipient, "skipped", { skipReason: "not_on_whatsapp" }, { now, force: true });
      await scheduleNext();
      return;
    }

    const config = await ctx.db.get(campaign.channelConfigId);
    const creator = await ctx.db.get(campaign.createdBy);
    if (!config || !creator) {
      await transitionRecipient(ctx, recipient, "failed", { lastError: "Canal ou criador da campanha não existe mais" }, { now, force: true });
      await scheduleNext();
      return;
    }

    try {
      // contato → lead → conversa (mesmos helpers do ingest)
      const nameParts = (recipient.displayName ?? "").trim().split(/\s+/).filter(Boolean);
      const contactId =
        recipient.contactId ??
        (await findOrCreateContactByPhone(ctx, {
          organizationId: campaign.organizationId,
          phone: recipient.phone,
          firstName: nameParts[0],
          lastName: nameParts.slice(1).join(" ") || undefined,
        }));
      const contact = (await ctx.db.get(contactId))!;
      // e-mail/empresa do CSV enriquecem um contato vazio
      const patch: Partial<Doc<"contacts">> = {};
      if (!contact.email && recipient.vars?.email) patch.email = recipient.vars.email;
      if (!contact.company && recipient.vars?.empresa) patch.company = recipient.vars.empresa;
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(contactId, { ...patch, searchText: buildSearchText({ ...contact, ...patch }), updatedAt: now });
      }

      let leadId = recipient.leadId ?? null;
      if (leadId) {
        const lead = await ctx.db.get(leadId);
        if (!lead || lead.organizationId !== campaign.organizationId) leadId = null;
      }
      const leadWasNew = !leadId;
      if (!leadId) {
        leadId = await ensureLeadForContact(ctx, {
          organizationId: campaign.organizationId,
          contactId,
          preferredBoardId: campaign.audience.targetBoardId,
          preferredStageId: campaign.audience.targetStageId,
        });
      }
      const lead = (await ctx.db.get(leadId))!;
      const leadPatch: Partial<Doc<"leads">> = {};
      if (leadWasNew || !lead.sourceId) {
        leadPatch.sourceId = await findOrCreateCampaignSource(ctx, campaign.organizationId, now);
      }
      const tagsToAdd = [...(campaign.audience.targetTags ?? [])];
      const merged = Array.from(new Set([...lead.tags, ...tagsToAdd]));
      if (merged.length !== lead.tags.length) leadPatch.tags = merged;
      if (Object.keys(leadPatch).length > 0) await ctx.db.patch(leadId, { ...leadPatch, updatedAt: now });

      const conversationId = await getOrCreateConversation(ctx, {
        organizationId: campaign.organizationId,
        leadId,
        channel: "whatsapp",
        channelConfigId: campaign.channelConfigId,
      });
      let conversation = (await ctx.db.get(conversationId))!;
      if (conversation.channelConfigId !== campaign.channelConfigId) {
        await ctx.db.patch(conversationId, { channelConfigId: campaign.channelConfigId, updatedAt: now });
        conversation = (await ctx.db.get(conversationId))!;
      }

      // Renderização
      const ordinal = campaign.stats.total - campaign.stats.pending - campaign.stats.queued;
      const recipientVars = { displayName: recipient.displayName, vars: recipient.vars };
      const seed = `${campaign._id}:${recipient._id}`;
      let content = "";
      let contentType: Doc<"messages">["contentType"] = "text";
      let attachments: Id<"files">[] | undefined;
      let metadata: Record<string, unknown> = {
        campaign: { campaignId: campaign._id, recipientId: recipient._id },
        scheduled: true,
      };
      let variantIndex = 0;
      if (campaign.content.kind === "template" && campaign.content.template) {
        const tpl = campaign.content.template;
        let headerLink: string | undefined;
        let headerFilename: string | undefined;
        if (tpl.headerFileId) {
          const file = await ctx.db.get(tpl.headerFileId);
          if (file) {
            headerLink = (await ctx.storage.getUrl(file.storageId as Id<"_storage">)) ?? undefined;
            headerFilename = file.name;
          }
        }
        const components = renderTemplateComponents(
          {
            name: tpl.name,
            language: tpl.language,
            headerFormat: tpl.headerFormat,
            headerLink,
            headerFilename,
            bodyParams: tpl.bodyParams,
            headerParams: tpl.headerParams,
            buttonParams: tpl.buttonParams,
          },
          recipientVars
        );
        content = renderTemplateBodyPreview(tpl.bodyText, tpl.bodyParams, recipientVars) || `[template] ${tpl.name}`;
        metadata = {
          ...metadata,
          template: { name: tpl.name, languageCode: tpl.language, ...(components.length ? { components } : {}) },
        };
      } else {
        const variants = campaign.content.variants.filter((vr) => vr.text.trim() || (vr.attachmentFileIds?.length ?? 0) > 0);
        variantIndex = pickVariantIndex(ordinal, variants.length);
        const variant = variants[variantIndex] ?? variants[0];
        content = renderText(variant.text, recipientVars, seed);
        attachments = variant.attachmentFileIds && variant.attachmentFileIds.length > 0 ? variant.attachmentFileIds : undefined;
        if (attachments) {
          const first = await ctx.db.get(attachments[0]);
          const mime = first?.mimeType ?? "";
          contentType = campaign.content.contentType ?? (mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "file");
          if (!content) content = contentType === "image" ? "[imagem]" : contentType === "audio" ? "[áudio]" : first?.name ?? "[arquivo]";
        }
      }
      if (args.note) metadata.campaignNote = args.note;

      const messageId = await ctx.db.insert("messages", {
        organizationId: campaign.organizationId,
        conversationId,
        leadId,
        direction: "outbound",
        senderId: creator._id,
        senderType: "human",
        content,
        contentType,
        attachments,
        isInternal: false,
        metadata,
        createdAt: now,
      });
      await applyOutboundMessageSideEffects(ctx, {
        conversation,
        member: creator,
        messageId,
        now,
        activityContent: `Mensagem da campanha «${campaign.name}» enviada`,
      });

      await ctx.db.patch(recipient._id, {
        contactId,
        leadId,
        conversationId,
        messageId,
        variantIndex,
        attempts: recipient.attempts + 1,
        lastError: undefined,
      });

      // Contadores do canal (enforcement) + lote
      const row = await pacingRow(ctx, campaign.channelConfigId);
      const bumped = bumpCounters(row, now, recipient.isNewContact === true);
      if (row) {
        await ctx.db.patch(row._id, bumped);
      } else {
        await ctx.db.insert("channelPacing", {
          organizationId: campaign.organizationId,
          channelConfigId: campaign.channelConfigId,
          nextDispatchAt: 0,
          ...bumped,
        });
      }
      const fresh = (await ctx.db.get(campaign._id))!;
      await ctx.db.patch(campaign._id, {
        batchSentSinceLastPause: (fresh.batchSentSinceLastPause ?? 0) + 1,
        updatedAt: now,
      });
      await scheduleNext();
    } catch (e) {
      const detail = e instanceof Error ? e.message : "Falha ao preparar o envio";
      await transitionRecipient(ctx, recipient, "failed", { lastError: detail }, { now, force: true });
      const fresh = (await ctx.db.get(campaign._id))!;
      await ctx.db.patch(campaign._id, { lastError: detail, updatedAt: now });
      if (fresh.status === "running") await scheduleNext();
    }
    return;
  }
}
