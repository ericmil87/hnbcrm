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
  bumpSourceGroupCounter,
  evaluateKillSwitches,
  nextSendDelayMs,
  batchPauseMs,
  groupMemberCaps,
  isGroupAudience,
  targetsGroupMembers,
  nextUtcDayStart,
  utcDayKey,
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

/**
 * Próximo pendente ELEGÍVEL agora.
 *
 * O teto por grupo de origem (F5) é avaliado aqui, não só no `capsExceeded`:
 * se o grupo A já mandou os 10 de hoje mas o B não, a campanha continua pelo B
 * em vez de parar até amanhã. `groupCapped` só volta true quando TODOS os
 * candidatos da janela estão barrados pelo grupo deles.
 */
async function nextPendingRecipient(
  ctx: MutationCtx,
  campaignId: Id<"campaigns">,
  now: number,
  perGroupPerDay?: number,
  byGroup?: Record<string, { sent: number; sentToday: number; sentTodayKey: string }>
): Promise<{
  recipient: Doc<"campaignRecipients"> | null;
  earliestScheduled: number | null;
  groupCapped: boolean;
}> {
  // Ordenado por `scheduledFor` (sem agendamento primeiro = pronto agora), não
  // por ordem de criação: com o espalhamento em dias, as linhas futuras do
  // primeiro grupo ocupavam a janela inteira e o segundo grupo nunca era
  // alcançado no dia 0.
  const rows = await ctx.db
    .query("campaignRecipients")
    .withIndex("by_campaign_and_status_and_scheduled", (q) =>
      q.eq("campaignId", campaignId).eq("status", "pending")
    )
    .take(50);
  const day = utcDayKey(now);
  let earliest: number | null = null;
  let capped = false;
  for (const r of rows) {
    if (r.scheduledFor && r.scheduledFor > now) {
      earliest = earliest === null ? r.scheduledFor : Math.min(earliest, r.scheduledFor);
      continue;
    }
    if (perGroupPerDay !== undefined && r.sourceGroupChatId) {
      const counter = byGroup?.[String(r.sourceGroupChatId)];
      const sentToday = counter && counter.sentTodayKey === day ? counter.sentToday : 0;
      if (sentToday >= perGroupPerDay) {
        capped = true;
        continue;
      }
    }
    return { recipient: r, earliestScheduled: null, groupCapped: false };
  }
  return { recipient: null, earliestScheduled: earliest, groupCapped: capped };
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

    // Público de grupo: teto por grupo de ORIGEM, além dos tetos do canal (F5).
    const groupAudience = isGroupAudience(campaign.audience.source);
    // Vale também para a campanha `manual` criada pelo "Disparar para
    // selecionados" do painel de membros: mesmas pessoas, mesmo risco.
    const perGroupPerDay = targetsGroupMembers(campaign.audience)
      ? groupMemberCaps({ safeMode: campaign.safeMode }).perGroupPerDay
      : undefined;

    // Próximo destinatário
    const { recipient, earliestScheduled, groupCapped } = await nextPendingRecipient(
      ctx,
      campaign._id,
      now,
      perGroupPerDay,
      campaign.stats.byGroup
    );
    if (!recipient) {
      if (earliestScheduled !== null) {
        await scheduleCampaignTick(ctx, campaign, earliestScheduled, now);
        return null;
      }
      if (groupCapped) {
        // Todo mundo que sobrou é de grupo que já bateu o teto de hoje.
        await scheduleCampaignTick(ctx, campaign, nextUtcDayStart(now), now);
        await addTimelineOnce(
          ctx,
          campaign,
          "caps",
          `Teto diário por grupo de origem atingido (${perGroupPerDay}/grupo/dia) — continua amanhã`,
          now
        );
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

    // Supressão (pode ter entrado depois do snapshot). NÃO se aplica a uma SALA:
    // o "telefone" dela é o JID, e opt-out de grupo é parar de acompanhar (D13).
    if (!recipient.groupChatId && (await isPhoneSuppressed(ctx, campaign.organizationId, recipient.phone))) {
      await transitionRecipient(ctx, recipient, "opted_out", { skipReason: "suppressed" }, { now, force: true });
      const fresh = (await ctx.db.get(campaign._id))!;
      await scheduleCampaignTick(ctx, fresh, now, now);
      return null;
    }

    // Contato novo? (sem conversa WhatsApp com inbound). Sala nunca é "contato".
    const isNewContact = recipient.groupChatId
      ? false
      : await recipientIsNewContact(ctx, campaign, recipient);

    // Tetos do canal
    const row = await pacingRow(ctx, campaign.channelConfigId);
    const caps = capsExceeded({
      pacing: campaign.pacing,
      counters: row,
      now,
      isNewContact,
      ...(perGroupPerDay !== undefined && recipient.sourceGroupChatId
        ? {
            sourceGroup: {
              counter: campaign.stats.byGroup?.[String(recipient.sourceGroupChatId)],
              perGroupPerDay,
            },
          }
        : {}),
    });
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

    // `checkNumbersFirst` não vale nos públicos de grupo: numa SALA não há
    // número para checar, e um MEMBRO está no WhatsApp por definição.
    if (provider === "bridge" && campaign.safety.checkNumbersFirst && !groupAudience) {
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

    // Destinatário = SALA: nada de contato/lead (D1/D3). A conversa do grupo já
    // existe (é ela que faz o grupo aparecer no inbox) e o dispatch resolve o
    // destino pelo `externalChatId` dela.
    if (recipient.groupChatId) {
      await sendToGroupCore(ctx, { campaign, recipient, creator, now, scheduleNext });
      return;
    }

    try {
      // contato → lead → conversa (mesmos helpers do ingest). Sem contato, o
      // PushName do membro é o único nome que temos — vira {{nome}}.
      const nameParts = (recipient.displayName ?? recipient.memberName ?? "").trim().split(/\s+/).filter(Boolean);
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
      // O lead nascido de um membro carrega de onde veio: "grupo:<slug>" é o
      // que permite achar depois "todo mundo que veio da sala X".
      if (recipient.sourceGroupChatId) {
        const sourceGroup = await ctx.db.get(recipient.sourceGroupChatId);
        if (sourceGroup) tagsToAdd.push(`grupo:${slugifyTag(sourceGroup.subject)}`);
      }
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
      const recipientVars = {
        displayName: recipient.displayName ?? recipient.memberName,
        vars: recipient.vars,
      };
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
        ...(recipient.sourceGroupChatId
          ? { stats: bumpByGroup(fresh.stats, recipient.sourceGroupChatId, now) }
          : {}),
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

// ─────────────────────────────────────────────────────────────────────────────
// Envio para SALA (público "groups", D9)
// ─────────────────────────────────────────────────────────────────────────────

/** Slug curto e estável para a tag "grupo:<...>" do lead. */
export function slugifyTag(subject: string): string {
  return String(subject ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "grupo";
}

/** Contador por grupo de origem dentro de `campaigns.stats`. */
function bumpByGroup(
  stats: Doc<"campaigns">["stats"],
  groupChatId: Id<"groupChats">,
  now: number
): Doc<"campaigns">["stats"] {
  const key = String(groupChatId);
  const byGroup = { ...(stats.byGroup ?? {}) };
  byGroup[key] = bumpSourceGroupCounter(byGroup[key], now);
  return { ...stats, byGroup };
}

/**
 * Manda a mensagem da campanha DENTRO da conversa do grupo.
 *
 * Reaproveita tudo: `applyOutboundMessageSideEffects` → pacing → dispatch, que
 * desde a F1 resolve o destino pelo `externalChatId` da conversa (`…@g.us`).
 * O que NÃO acontece aqui: contato, lead, `checkNumbers` e opt-out.
 */
async function sendToGroupCore(
  ctx: MutationCtx,
  args: {
    campaign: Doc<"campaigns">;
    recipient: Doc<"campaignRecipients">;
    creator: Doc<"teamMembers">;
    now: number;
    scheduleNext: (extraMs?: number) => Promise<void>;
  }
): Promise<void> {
  const { campaign, recipient, creator, now } = args;
  const fail = async (message: string) => {
    await transitionRecipient(ctx, recipient, "failed", { lastError: message }, { now, force: true });
    await args.scheduleNext();
  };
  try {
    const group = recipient.groupChatId ? await ctx.db.get(recipient.groupChatId) : null;
    if (!group || group.organizationId !== campaign.organizationId) {
      await fail("Grupo não existe mais nesta organização");
      return;
    }
    if (group.leftAt !== undefined || group.removedAt !== undefined) {
      await transitionRecipient(
        ctx,
        recipient,
        "skipped",
        { skipReason: "left_group", lastError: "Não estamos mais neste grupo" },
        { now, force: true }
      );
      await args.scheduleNext();
      return;
    }
    if (!group.monitored || !group.conversationId) {
      await transitionRecipient(
        ctx,
        recipient,
        "skipped",
        { skipReason: "not_monitored", lastError: "O grupo deixou de ser acompanhado" },
        { now, force: true }
      );
      await args.scheduleNext();
      return;
    }
    const conversation = await ctx.db.get(group.conversationId);
    if (!conversation || conversation.organizationId !== campaign.organizationId) {
      await fail("Conversa do grupo não encontrada");
      return;
    }

    const ordinal = campaign.stats.total - campaign.stats.pending - campaign.stats.queued;
    const seed = `${campaign._id}:${recipient._id}`;
    const variants = campaign.content.variants.filter(
      (vr) => vr.text.trim() || (vr.attachmentFileIds?.length ?? 0) > 0
    );
    if (variants.length === 0) {
      await fail("A campanha não tem conteúdo para enviar");
      return;
    }
    const variantIndex = pickVariantIndex(ordinal, variants.length);
    const variant = variants[variantIndex] ?? variants[0];
    const renderVars = {
      displayName: group.subject,
      vars: { grupo: group.subject, ...(recipient.vars ?? {}) },
    };
    let content = renderText(variant.text, renderVars, seed);
    const attachments =
      variant.attachmentFileIds && variant.attachmentFileIds.length > 0 ? variant.attachmentFileIds : undefined;
    let contentType: Doc<"messages">["contentType"] = "text";
    if (attachments) {
      const first = await ctx.db.get(attachments[0]);
      const mime = first?.mimeType ?? "";
      contentType =
        campaign.content.contentType ??
        (mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "file");
      if (!content) {
        content = contentType === "image" ? "[imagem]" : contentType === "audio" ? "[áudio]" : first?.name ?? "[arquivo]";
      }
    }

    const messageId = await ctx.db.insert("messages", {
      organizationId: campaign.organizationId,
      conversationId: conversation._id,
      direction: "outbound",
      senderId: creator._id,
      senderType: "human",
      content,
      contentType,
      attachments,
      isInternal: false,
      metadata: {
        campaign: { campaignId: campaign._id, recipientId: recipient._id, groupChatId: group._id },
        // `scheduled` liga o "digitando…" humanizado do bridge.
        scheduled: true,
      },
      createdAt: now,
    });
    await applyOutboundMessageSideEffects(ctx, {
      conversation,
      member: creator,
      messageId,
      now,
      activityContent: `Mensagem da campanha «${campaign.name}» enviada no grupo`,
    });

    await ctx.db.patch(recipient._id, {
      conversationId: conversation._id,
      messageId,
      variantIndex,
      attempts: recipient.attempts + 1,
      lastError: undefined,
    });

    const row = await ctx.db
      .query("channelPacing")
      .withIndex("by_channel_config", (q) => q.eq("channelConfigId", campaign.channelConfigId))
      .first();
    const bumped = bumpCounters(row, now, false);
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
      stats: bumpByGroup(fresh.stats, group._id, now),
      updatedAt: now,
    });
    await args.scheduleNext();
  } catch (e) {
    const detail = e instanceof Error ? e.message : "Falha ao preparar o envio no grupo";
    await transitionRecipient(ctx, recipient, "failed", { lastError: detail }, { now, force: true });
    const fresh = await ctx.db.get(campaign._id);
    if (fresh) await ctx.db.patch(campaign._id, { lastError: detail, updatedAt: now });
    await args.scheduleNext();
  }
}
