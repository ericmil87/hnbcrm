/**
 * Núcleo compartilhado das campanhas — transições de destinatário, contadores,
 * timeline, pausa (humana ou por kill switch) e os GANCHOS que o resto do
 * sistema chama (dispatch, webhooks de status, ingest inbound, sessão bridge).
 *
 * Vive em lib/ para não criar ciclo: whatsapp.ts / conversations.ts / bridge.ts
 * importam daqui; campaigns.ts e campaignWorker.ts também.
 */
import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { createNotification } from "./notify";

const DAY_MS = 24 * 60 * 60 * 1000;
export const CAMPAIGN_REPLY_WINDOW_MS = 7 * DAY_MS;
export const RETRY_131049_DELAY_MS = DAY_MS;
export const MAX_ATTEMPTS_131049 = 2;
export const CHANNEL_QUALITY_FREEZE_MS = 30 * 60 * 1000;
export const TIMELINE_CAP = 100;

export const DEFAULT_OPT_OUT_KEYWORDS = ["SAIR", "PARAR", "STOP", "CANCELAR"];

type RecipientStatus = Doc<"campaignRecipients">["status"];
type StatsKey = keyof Omit<Doc<"campaigns">["stats"], "consecutiveFailures" | "total" | "estimatedCostUsd">;

const STATUS_TO_STAT: Record<RecipientStatus, StatsKey> = {
  pending: "pending",
  queued: "queued",
  sent: "sent",
  delivered: "delivered",
  read: "read",
  replied: "replied",
  failed: "failed",
  skipped: "skipped",
  opted_out: "optedOut",
};

/** Ordem de "progresso" — um status nunca regride (ex.: read não vira delivered). */
const PROGRESS: Record<RecipientStatus, number> = {
  pending: 0,
  queued: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  replied: 5,
  failed: 9,
  skipped: 9,
  opted_out: 9,
};

export function isTerminalRecipient(status: RecipientStatus): boolean {
  return status === "failed" || status === "skipped" || status === "opted_out" || status === "replied";
}

export async function addTimeline(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  entry: { kind: string; detail?: string; actorId?: Id<"teamMembers"> },
  now: number
): Promise<void> {
  const timeline = [...(campaign.timeline ?? []), { at: now, ...entry }];
  await ctx.db.patch(campaign._id, {
    timeline: timeline.slice(-TIMELINE_CAP),
    updatedAt: now,
  });
}

/**
 * Move um destinatário para outro status atualizando os contadores da
 * campanha na mesma transação. `force` permite regressão (retry 131049:
 * failed→pending). Devolve false quando a transição foi ignorada.
 */
export async function transitionRecipient(
  ctx: MutationCtx,
  recipient: Doc<"campaignRecipients">,
  next: RecipientStatus,
  patch: Partial<Doc<"campaignRecipients">> = {},
  opts: { force?: boolean; now?: number } = {}
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  if (recipient.status === next) {
    if (Object.keys(patch).length > 0) await ctx.db.patch(recipient._id, patch);
    return false;
  }
  if (!opts.force && PROGRESS[next] < PROGRESS[recipient.status] && !isTerminalRecipient(next)) {
    return false;
  }
  if (!opts.force && isTerminalRecipient(recipient.status) && recipient.status !== "replied") {
    return false; // failed/skipped/opted_out são finais
  }
  await ctx.db.patch(recipient._id, { status: next, ...patch });

  const campaign = await ctx.db.get(recipient.campaignId);
  if (!campaign) return true;
  const stats = { ...campaign.stats };
  const fromKey = STATUS_TO_STAT[recipient.status];
  const toKey = STATUS_TO_STAT[next];
  stats[fromKey] = Math.max(0, stats[fromKey] - 1);
  stats[toKey] = stats[toKey] + 1;
  if (next === "failed") stats.consecutiveFailures = campaign.stats.consecutiveFailures + 1;
  if (next === "sent" || next === "delivered" || next === "read" || next === "replied") {
    stats.consecutiveFailures = 0;
  }
  await ctx.db.patch(campaign._id, { stats, updatedAt: now });
  return true;
}

async function notifyCampaignWatchers(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  args: { type: "campaign_completed" | "campaign_paused"; title: string; body?: string }
): Promise<void> {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization", (q) => q.eq("organizationId", campaign.organizationId))
    .collect();
  const targets = new Set<Id<"teamMembers">>([campaign.createdBy]);
  for (const m of members) {
    if (m.type === "human" && m.status === "active" && m.role === "admin") targets.add(m._id);
  }
  for (const memberId of targets) {
    await createNotification(ctx, {
      organizationId: campaign.organizationId,
      memberId,
      type: args.type,
      title: args.title,
      body: args.body,
      campaignId: campaign._id,
    });
  }
}

/**
 * Pausa a campanha (humana ou automática). Cancela o tick agendado, grava o
 * motivo, notifica (criador + admins), audita e dispara webhook.
 */
export async function pauseCampaignCore(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  args: { reason: string; actorId?: Id<"teamMembers">; automatic: boolean; now?: number }
): Promise<void> {
  if (campaign.status !== "running" && campaign.status !== "scheduled") return;
  const now = args.now ?? Date.now();
  if (campaign.schedulerFnId) {
    try {
      await ctx.scheduler.cancel(campaign.schedulerFnId as Id<"_scheduled_functions">);
    } catch {
      // já executou/cancelado — o tickToken protege contra o tick zumbi
    }
  }
  await ctx.db.patch(campaign._id, {
    status: "paused",
    pausedReason: args.reason,
    pausedBy: args.actorId,
    schedulerFnId: undefined,
    nextTickAt: undefined,
    updatedAt: now,
  });
  await addTimeline(
    ctx,
    { ...campaign, status: "paused" },
    { kind: args.automatic ? "paused_auto" : "paused", detail: args.reason, actorId: args.actorId },
    now
  );
  await ctx.db.insert("auditLogs", {
    organizationId: campaign.organizationId,
    entityType: "campaign",
    entityId: campaign._id,
    action: "update",
    actorId: args.actorId,
    actorType: args.actorId ? "human" : "system",
    changes: { before: { status: campaign.status }, after: { status: "paused", reason: args.reason } },
    metadata: { campaign: true, automatic: args.automatic },
    description: args.automatic
      ? `Campanha «${campaign.name}» pausada automaticamente: ${args.reason}`
      : `Campanha «${campaign.name}» pausada`,
    severity: args.automatic ? "high" : "medium",
    createdAt: now,
  });
  if (args.automatic) {
    await notifyCampaignWatchers(ctx, campaign, {
      type: "campaign_paused",
      title: `Campanha «${campaign.name}» pausada por segurança`,
      body: args.reason,
    });
  }
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: campaign.organizationId,
    event: "campaign.paused",
    payload: { campaignId: campaign._id, name: campaign.name, reason: args.reason, automatic: args.automatic },
  });
}

export async function completeCampaignCore(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  now: number
): Promise<void> {
  await ctx.db.patch(campaign._id, {
    status: "completed",
    completedAt: now,
    schedulerFnId: undefined,
    nextTickAt: undefined,
    updatedAt: now,
  });
  await addTimeline(ctx, { ...campaign, status: "completed" }, { kind: "completed" }, now);
  await ctx.db.insert("auditLogs", {
    organizationId: campaign.organizationId,
    entityType: "campaign",
    entityId: campaign._id,
    action: "update",
    actorType: "system",
    changes: { before: { status: campaign.status }, after: { status: "completed", stats: campaign.stats } },
    metadata: { campaign: true },
    description: `Campanha «${campaign.name}» concluída`,
    severity: "medium",
    createdAt: now,
  });
  await notifyCampaignWatchers(ctx, campaign, {
    type: "campaign_completed",
    title: `Campanha «${campaign.name}» concluída`,
    body: `${campaign.stats.sent + campaign.stats.delivered + campaign.stats.read + campaign.stats.replied} enviadas · ${campaign.stats.failed} falhas · ${campaign.stats.replied} respostas`,
  });
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: campaign.organizationId,
    event: "campaign.completed",
    payload: { campaignId: campaign._id, name: campaign.name, stats: campaign.stats },
  });
}

/** Pausa TODAS as campanhas em curso de um canal (sessão bridge caída, 131048…). */
export async function pauseCampaignsForChannel(
  ctx: MutationCtx,
  channelConfigId: Id<"channelConfigs">,
  reason: string,
  now: number
): Promise<number> {
  const rows = await ctx.db
    .query("campaigns")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", channelConfigId))
    .collect();
  let count = 0;
  for (const campaign of rows) {
    if (campaign.status === "running" || campaign.status === "scheduled") {
      await pauseCampaignCore(ctx, campaign, { reason, automatic: true, now });
      count++;
    }
  }
  return count;
}

export async function freezeChannelForCampaigns(
  ctx: MutationCtx,
  channelConfigId: Id<"channelConfigs">,
  organizationId: Id<"organizations">,
  until: number
): Promise<void> {
  const row = await ctx.db
    .query("channelPacing")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", channelConfigId))
    .first();
  if (row) {
    await ctx.db.patch(row._id, { campaignFrozenUntil: Math.max(row.campaignFrozenUntil ?? 0, until) });
  } else {
    await ctx.db.insert("channelPacing", {
      organizationId,
      channelConfigId,
      nextDispatchAt: 0,
      campaignFrozenUntil: until,
    });
  }
}

async function recipientForMessage(
  ctx: MutationCtx,
  messageId: Id<"messages">
): Promise<Doc<"campaignRecipients"> | null> {
  return await ctx.db
    .query("campaignRecipients")
    .withIndex("by_message", (q) => q.eq("messageId", messageId))
    .first();
}

async function upsertOptOut(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    phone: string;
    source: Doc<"optOuts">["source"];
    campaignId?: Id<"campaigns">;
    contactId?: Id<"contacts">;
    reason?: string;
    now: number;
  }
): Promise<boolean> {
  const existing = await ctx.db
    .query("optOuts")
    .withIndex("by_organization_and_phone", (q) =>
      q.eq("organizationId", args.organizationId).eq("phone", args.phone)
    )
    .first();
  if (existing) return false;
  await ctx.db.insert("optOuts", {
    organizationId: args.organizationId,
    phone: args.phone,
    source: args.source,
    campaignId: args.campaignId,
    contactId: args.contactId,
    reason: args.reason,
    createdAt: args.now,
  });
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: args.organizationId,
    event: "contact.opted_out",
    payload: {
      phone: args.phone,
      source: args.source,
      campaignId: args.campaignId,
      contactId: args.contactId,
    },
  });
  return true;
}

/**
 * Gancho de ENTREGA — chamado pelo dispatch (sent/failed com código) e pelos
 * webhooks de status (Meta statuses, bridge ReadReceipt). No-op quando a
 * mensagem não pertence a uma campanha.
 */
export async function applyCampaignDeliveryUpdate(
  ctx: MutationCtx,
  args: {
    messageId: Id<"messages">;
    status: "sent" | "delivered" | "read" | "failed";
    errorCode?: number;
    errorDetail?: string;
    now?: number;
  }
): Promise<void> {
  const recipient = await recipientForMessage(ctx, args.messageId);
  if (!recipient) return;
  const now = args.now ?? Date.now();
  const campaign = await ctx.db.get(recipient.campaignId);
  if (!campaign) return;

  if (args.status === "sent") {
    await transitionRecipient(ctx, recipient, "sent", { sentAt: recipient.sentAt ?? now }, { now });
    return;
  }
  if (args.status === "delivered") {
    await transitionRecipient(ctx, recipient, "delivered", { deliveredAt: recipient.deliveredAt ?? now }, { now });
    return;
  }
  if (args.status === "read") {
    await transitionRecipient(
      ctx,
      recipient,
      "read",
      { readAt: recipient.readAt ?? now, deliveredAt: recipient.deliveredAt ?? now },
      { now }
    );
    return;
  }

  // failed — mapa de erros da Meta (bridge só manda detail)
  const code = args.errorCode;
  const detail = args.errorDetail ?? (code ? `erro ${code}` : "falha de envio");
  if (code === 131050) {
    await upsertOptOut(ctx, {
      organizationId: campaign.organizationId,
      phone: recipient.phone,
      source: "meta_131050",
      campaignId: campaign._id,
      contactId: recipient.contactId,
      reason: "Destinatário optou por não receber marketing (Meta 131050)",
      now,
    });
    await transitionRecipient(
      ctx,
      recipient,
      "opted_out",
      { errorCode: code, lastError: detail, skipReason: "meta_131050" },
      { now, force: true }
    );
    return;
  }
  if (code === 131049) {
    const attempts = recipient.attempts + 1;
    if (attempts < MAX_ATTEMPTS_131049) {
      // volta para a fila com 24h de espera (a Meta bloqueia retry precoce)
      await transitionRecipient(
        ctx,
        recipient,
        "pending",
        {
          attempts,
          errorCode: code,
          lastError: "Limite de marketing por usuário (131049) — nova tentativa em 24h",
          scheduledFor: now + RETRY_131049_DELAY_MS,
          messageId: undefined,
        },
        { now, force: true }
      );
      return;
    }
    await transitionRecipient(
      ctx,
      recipient,
      "failed",
      { attempts, errorCode: code, lastError: "Limite de marketing por usuário (131049) — tentativas esgotadas" },
      { now, force: true }
    );
    return;
  }
  if (code === 131026) {
    await transitionRecipient(
      ctx,
      recipient,
      "failed",
      { errorCode: code, lastError: "Número sem WhatsApp ou fora dos termos (131026)", skipReason: "not_on_whatsapp" },
      { now, force: true }
    );
    return;
  }
  if (code === 131048) {
    await transitionRecipient(ctx, recipient, "failed", { errorCode: code, lastError: detail }, { now, force: true });
    await freezeChannelForCampaigns(ctx, campaign.channelConfigId, campaign.organizationId, now + CHANNEL_QUALITY_FREEZE_MS);
    const fresh = await ctx.db.get(campaign._id);
    if (fresh) {
      await pauseCampaignCore(ctx, fresh, {
        reason: "A Meta restringiu o número por qualidade (131048) — mensagens bloqueadas/denunciadas como spam",
        automatic: true,
        now,
      });
    }
    return;
  }
  if (code === 132015) {
    await transitionRecipient(ctx, recipient, "failed", { errorCode: code, lastError: detail }, { now, force: true });
    const fresh = await ctx.db.get(campaign._id);
    if (fresh) {
      await pauseCampaignCore(ctx, fresh, {
        reason: "Template pausado pela Meta por baixa qualidade (132015) — corrija e despause no WhatsApp Manager",
        automatic: true,
        now,
      });
    }
    return;
  }
  await transitionRecipient(
    ctx,
    recipient,
    "failed",
    { ...(code ? { errorCode: code } : {}), lastError: detail },
    { now, force: true }
  );
}

export function normalizeKeyword(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isOptOutText(text: string, keywords: string[]): boolean {
  const norm = normalizeKeyword(text);
  if (!norm) return false;
  return keywords.some((k) => normalizeKeyword(k) === norm);
}

/**
 * Gancho de INBOUND — chamado pelo ingest depois de gravar a mensagem do
 * contato. Marca `replied` na campanha mais recente daquela conversa e trata
 * palavra-chave de opt-out (supressão org-wide). Nunca lança.
 */
export async function applyCampaignInboundHooks(
  ctx: MutationCtx,
  args: { conversation: Doc<"conversations">; text: string; now: number }
): Promise<void> {
  const { conversation, now } = args;
  const rows = await ctx.db
    .query("campaignRecipients")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversation._id))
    .order("desc")
    .take(10);

  const org = await ctx.db.get(conversation.organizationId);
  const keywords = org?.settings.optOutKeywords ?? DEFAULT_OPT_OUT_KEYWORDS;
  const optOut = isOptOutText(args.text, keywords);

  let phone: string | undefined = rows[0]?.phone;
  let contactId: Id<"contacts"> | undefined = rows[0]?.contactId;
  if (!phone) {
    const lead = await ctx.db.get(conversation.leadId);
    const contact = lead?.contactId ? await ctx.db.get(lead.contactId) : null;
    phone = contact?.whatsappNumber ?? contact?.phone ?? undefined;
    contactId = contact?._id;
  }

  if (optOut && phone) {
    const inserted = await upsertOptOut(ctx, {
      organizationId: conversation.organizationId,
      phone,
      source: "keyword",
      campaignId: rows[0]?.campaignId,
      contactId,
      reason: `Palavra-chave de descadastro: "${args.text.trim().slice(0, 40)}"`,
      now,
    });
    if (inserted) {
      await ctx.db.insert("activities", {
        organizationId: conversation.organizationId,
        leadId: conversation.leadId,
        type: "note",
        actorType: "system",
        content: `Contato pediu para não receber mais mensagens ("${args.text.trim().slice(0, 40)}") — adicionado à lista de supressão`,
        metadata: { conversationId: conversation._id, optOut: true },
        createdAt: now,
      });
    }
    for (const r of rows) {
      if (r.status === "sent" || r.status === "delivered" || r.status === "read" || r.status === "queued" || r.status === "replied") {
        await transitionRecipient(ctx, r, "opted_out", { repliedAt: r.repliedAt ?? now, skipReason: "keyword" }, { now, force: true });
      } else if (r.status === "pending") {
        await transitionRecipient(ctx, r, "opted_out", { skipReason: "keyword" }, { now, force: true });
      }
    }
    return;
  }

  // Resposta a campanha: o recipient mais recente enviado nos últimos 7 dias
  const recent = rows.find(
    (r) =>
      (r.status === "sent" || r.status === "delivered" || r.status === "read") &&
      (r.sentAt ?? r.createdAt) + CAMPAIGN_REPLY_WINDOW_MS > now
  );
  if (!recent) return;
  const moved = await transitionRecipient(ctx, recent, "replied", { repliedAt: now }, { now });
  if (!moved) return;
  const campaign = await ctx.db.get(recent.campaignId);
  await ctx.db.insert("activities", {
    organizationId: conversation.organizationId,
    leadId: conversation.leadId,
    type: "note",
    actorType: "system",
    content: `Respondeu à campanha «${campaign?.name ?? "?"}»`,
    metadata: { conversationId: conversation._id, campaignId: recent.campaignId, campaignReply: true },
    createdAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: conversation.organizationId,
    event: "campaign.recipient_replied",
    payload: {
      campaignId: recent.campaignId,
      recipientId: recent._id,
      phone: recent.phone,
      leadId: conversation.leadId,
      conversationId: conversation._id,
    },
  });
}

/** Gera um token novo e agenda o próximo tick do worker em `at`. */
export async function scheduleCampaignTick(
  ctx: MutationCtx,
  campaign: Doc<"campaigns">,
  at: number,
  now: number
): Promise<void> {
  if (campaign.schedulerFnId) {
    try {
      await ctx.scheduler.cancel(campaign.schedulerFnId as Id<"_scheduled_functions">);
    } catch {
      // já rodou
    }
  }
  const tickToken = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const fnId = await ctx.scheduler.runAt(Math.max(at, now), internal.campaignWorker.tick, {
    campaignId: campaign._id,
    tickToken,
  });
  await ctx.db.patch(campaign._id, {
    schedulerFnId: fnId as string,
    nextTickAt: Math.max(at, now),
    tickToken,
    updatedAt: now,
  });
}
