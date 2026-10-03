/**
 * Lead que entra por `POST /api/v1/inbound/lead` (v0.64): roteamento por tag,
 * boas-vindas automáticas pelo WhatsApp e a op de configuração.
 *
 * - `internalResolveInboundLeadTarget`: valida `sourceId`, escolhe board/estágio
 *   (regra de `settings.inboundLeadRouting` → default ativo) e o auto-assign
 *   (só ATENDENTE ativo, como em `lib/inboundRouting.ts`).
 * - `internalSendInboundLeadWelcome`: UMA mensagem por contato, com guardas
 *   (canal ativo da org, telefone normalizável, tag de consentimento, opt-out,
 *   sessão do bridge, conversa já iniciada). Chamada pela rota via
 *   `ctx.runMutation` (não agendada) para a resposta HTTP dizer `welcomeQueued`.
 *   Falha de entrega → repasse humano (`lib/inboundLeadWelcomeHooks.ts`).
 * - `internalSetInboundLeadSettings`: op sem UI (dryRun default TRUE), valida
 *   ids contra a org e faz MERGE em `settings`.
 *
 * Núcleo puro (template, escolha da mensagem, regra) em `lib/inboundLeadWelcome.ts`.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { normalizeCampaignPhone } from "./lib/phone";
import { resolveDefaultCountry } from "./lib/orgPhone";
import { isPhoneSuppressed } from "./lib/campaignAudience";
import { getOrCreateConversation } from "./conversations";
import { applyOutboundMessageSideEffects } from "./lib/outboundSideEffects";
import { configProvider } from "./channelConfigs";
import {
  pickWelcomeMessage,
  renderWelcomeTemplate,
  resolveInboundRoutingRule,
  shouldSendWelcome,
  WELCOME_SENT_TAG,
} from "./lib/inboundLeadWelcome";

// ─────────────────────────────────────────────────────────────────────────────
// Board/estágio/responsável do lead novo
// ─────────────────────────────────────────────────────────────────────────────

async function activeBoards(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">
): Promise<Doc<"boards">[]> {
  const boards = await ctx.db
    .query("boards")
    .withIndex("by_organization_and_order", (q) => q.eq("organizationId", organizationId))
    .collect();
  return boards.filter((b) => b.archivedAt === undefined && b.deletionStartedAt === undefined);
}

/** Regra válida em RUNTIME: board da org, ativo, e estágio desse board. */
async function validRoutingTarget(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  boardId: Id<"boards">,
  stageId: Id<"stages">
): Promise<string | null> {
  const board = await ctx.db.get(boardId);
  if (!board || board.organizationId !== organizationId) return "board_de_outra_org";
  if (board.archivedAt !== undefined || board.deletionStartedAt !== undefined) return "board_arquivado";
  const stage = await ctx.db.get(stageId);
  if (!stage || stage.boardId !== boardId) return "estagio_fora_do_board";
  return null;
}

export const internalResolveInboundLeadTarget = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    tags: v.array(v.string()),
    // String crua do corpo da requisição — validada aqui (pode nem ser um id).
    sourceId: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), status: v.number(), error: v.string() }),
    v.object({
      ok: v.literal(true),
      boardId: v.id("boards"),
      stageId: v.id("stages"),
      sourceId: v.optional(v.id("leadSources")),
      assignedTo: v.optional(v.id("teamMembers")),
      routedByTag: v.optional(v.string()),
    })
  ),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    if (!org) return { ok: false as const, status: 404, error: "Organization not found" };

    // sourceId: precisa ser um leadSource DESTA org (antes ia cru para o lead).
    let sourceId: Id<"leadSources"> | undefined;
    if (args.sourceId !== undefined && args.sourceId !== "") {
      const id = ctx.db.normalizeId("leadSources", args.sourceId);
      const source = id ? await ctx.db.get(id) : null;
      if (!source || source.organizationId !== args.organizationId) {
        return { ok: false as const, status: 400, error: "Invalid sourceId" };
      }
      sourceId = source._id;
    }

    let boardId: Id<"boards"> | undefined;
    let stageId: Id<"stages"> | undefined;
    let routedByTag: string | undefined;

    const rule = resolveInboundRoutingRule(org.settings.inboundLeadRouting, args.tags);
    if (rule) {
      const invalid = await validRoutingTarget(ctx, args.organizationId, rule.boardId, rule.stageId);
      if (invalid) {
        // Config velha (board arquivado/excluído) nunca derruba a captura.
        console.warn(
          `[inbound/lead] regra da tag "${rule.tag}" inválida (${invalid}) — usando o board padrão`
        );
      } else {
        boardId = rule.boardId;
        stageId = rule.stageId;
        routedByTag = rule.tag;
      }
    }

    if (!boardId) {
      const boards = await activeBoards(ctx, args.organizationId);
      const board = boards.find((b) => b.isDefault) ?? boards[0];
      if (!board) return { ok: false as const, status: 500, error: "No boards configured" };
      const firstStage = await ctx.db
        .query("stages")
        .withIndex("by_board_and_order", (q) => q.eq("boardId", board._id))
        .first();
      if (!firstStage) return { ok: false as const, status: 500, error: "No stages configured" };
      boardId = board._id;
      stageId = firstStage._id;
    }

    // Auto-assign: só o ATENDENTE (o copiloto como dono travaria a
    // elegibilidade da IA — mesma regra de `lib/inboundRouting.ts`).
    let assignedTo: Id<"teamMembers"> | undefined;
    if (org.settings.aiConfig?.autoAssign) {
      const aiMembers = await ctx.db
        .query("teamMembers")
        .withIndex("by_organization_and_type", (q) =>
          q.eq("organizationId", args.organizationId).eq("type", "ai")
        )
        .collect();
      assignedTo = aiMembers.find(
        (m) => m.status === "active" && m.removedAt === undefined && m.agentProfile?.kind === "attendant"
      )?._id;
    }

    return {
      ok: true as const,
      boardId,
      stageId: stageId!,
      ...(sourceId ? { sourceId } : {}),
      ...(assignedTo ? { assignedTo } : {}),
      ...(routedByTag ? { routedByTag } : {}),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Boas-vindas
// ─────────────────────────────────────────────────────────────────────────────

/** Leve: só a decisão "esta captura dispara boas-vindas?" (usada pela rota). */
export const internalWelcomeAppliesTo = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    /** Telefone CRU do formulário — normalizado aqui com o DDI padrão da org. */
    phone: v.optional(v.string()),
    tags: v.array(v.string()),
  },
  returns: v.union(v.null(), v.object({ channelConfigId: v.id("channelConfigs") })),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    const welcome = org?.settings.inboundLeadWelcome;
    const hasPhone = args.phone ? normalizeCampaignPhone(args.phone, resolveDefaultCountry(org?.settings)).ok : false;
    if (!welcome || !shouldSendWelcome(welcome, { hasPhone, tags: args.tags })) {
      return null;
    }
    return { channelConfigId: welcome.channelConfigId };
  },
});

/**
 * A pessoa já conversa com a gente pelo WhatsApp (qualquer lead do contato com
 * mensagem não-interna numa conversa de WhatsApp)? Cobre "UMA por lead" e
 * também o segundo lead do mesmo contato — boas-vindas enlatada no meio de uma
 * conversa real é pior que nenhuma.
 */
async function contactAlreadyOnWhatsapp(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  contactId: Id<"contacts">
): Promise<boolean> {
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .order("desc")
    .take(20);
  for (const lead of leads) {
    if (lead.organizationId !== organizationId) continue;
    if (lead.tags.includes(WELCOME_SENT_TAG)) return true;
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_lead_and_channel", (q) => q.eq("leadId", lead._id).eq("channel", "whatsapp"))
      .take(5);
    for (const conv of conversations) {
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conv._id))
        .order("desc")
        .take(20);
      if (recent.some((m) => !m.isInternal)) return true;
    }
  }
  return false;
}

async function noteOnLead(
  ctx: MutationCtx,
  lead: Doc<"leads">,
  content: string,
  metadata?: Record<string, unknown>
) {
  await ctx.db.insert("activities", {
    organizationId: lead.organizationId,
    leadId: lead._id,
    type: "note",
    actorType: "system",
    content,
    ...(metadata ? { metadata } : {}),
    createdAt: Date.now(),
  });
}

type WelcomeResult = {
  sent: boolean;
  reason?: string;
  messageId?: Id<"messages">;
  conversationId?: Id<"conversations">;
};

export const internalSendInboundLeadWelcome = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    contactId: v.id("contacts"),
    actorMemberId: v.id("teamMembers"),
  },
  returns: v.object({
    sent: v.boolean(),
    reason: v.optional(v.string()),
    messageId: v.optional(v.id("messages")),
    conversationId: v.optional(v.id("conversations")),
  }),
  handler: async (ctx, args): Promise<WelcomeResult> => {
    const skip = (reason: string): WelcomeResult => ({ sent: false, reason });

    const org = await ctx.db.get(args.organizationId);
    const welcome = org?.settings.inboundLeadWelcome;
    if (!org || !welcome || welcome.enabled !== true) return skip("desligado");

    const lead = await ctx.db.get(args.leadId);
    const contact = await ctx.db.get(args.contactId);
    const actor = await ctx.db.get(args.actorMemberId);
    if (
      !lead ||
      lead.organizationId !== args.organizationId ||
      !contact ||
      contact.organizationId !== args.organizationId ||
      lead.contactId !== contact._id ||
      !actor ||
      actor.organizationId !== args.organizationId
    ) {
      return skip("referencia_invalida");
    }

    // Canal: da org, WhatsApp, ativo.
    const config = await ctx.db.get(welcome.channelConfigId);
    if (!config || config.organizationId !== args.organizationId || config.channel !== "whatsapp") {
      return skip("canal_invalido");
    }
    if (config.status !== "active") return skip("canal_inativo");

    const rawPhone = contact.whatsappNumber ?? contact.phone;
    const phone = rawPhone ? normalizeCampaignPhone(rawPhone, resolveDefaultCountry(org.settings)) : null;
    if (!phone?.ok) return skip("sem_telefone");

    if (!shouldSendWelcome(welcome, { hasPhone: true, tags: lead.tags })) {
      return skip("sem_tag_exigida");
    }

    if (await isPhoneSuppressed(ctx, args.organizationId, phone.phone)) {
      await noteOnLead(ctx, lead, "Boas-vindas automáticas puladas: opt-out (o número pediu para não ser contatado).");
      return skip("opt_out");
    }

    if (
      configProvider(config) === "bridge" &&
      (config.bridgeSessionState === "banned" || config.bridgeSessionState === "disconnected")
    ) {
      await noteOnLead(ctx, lead, "Boas-vindas automáticas não enviadas: o número de WhatsApp está desconectado.");
      return skip("canal_desconectado");
    }

    if (await contactAlreadyOnWhatsapp(ctx, args.organizationId, contact._id)) {
      return skip("ja_contatado");
    }

    const template = pickWelcomeMessage(welcome, lead.tags);
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
    const content = template
      ? renderWelcomeTemplate(template, {
          firstName: contact.firstName,
          name,
          title: lead.title,
          tags: lead.tags,
        })
      : "";
    if (!content) return skip("mensagem_vazia");

    const conversationId = await getOrCreateConversation(ctx, {
      organizationId: args.organizationId,
      leadId: lead._id,
      channel: "whatsapp",
      channelConfigId: config._id,
    });
    let conversation = (await ctx.db.get(conversationId))!;
    // Conversa pré-existente (ex.: nota do formulário) sem número carimbado.
    if (!conversation.channelConfigId) {
      await ctx.db.patch(conversationId, { channelConfigId: config._id });
      conversation = (await ctx.db.get(conversationId))!;
    }

    // O contato precisa do número normalizado para o dispatch e para a
    // resposta da pessoa cair neste mesmo contato.
    if (contact.whatsappNumber !== phone.phone) {
      await ctx.db.patch(contact._id, { whatsappNumber: phone.phone, updatedAt: Date.now() });
    }

    const now = Date.now();
    const messageId = await ctx.db.insert("messages", {
      organizationId: args.organizationId,
      conversationId,
      leadId: lead._id,
      direction: "outbound",
      senderId: actor._id,
      senderType: "human",
      content,
      contentType: "text",
      isInternal: false,
      // `scheduled: true` = typing humanizado no bridge (mesmo dos agendados).
      metadata: { inboundWelcome: { leadId: lead._id }, scheduled: true },
      createdAt: now,
    });
    await applyOutboundMessageSideEffects(ctx, {
      conversation,
      member: actor,
      messageId,
      now,
      activityContent: "Boas-vindas automáticas enviadas pelo WhatsApp",
    });

    const fresh = (await ctx.db.get(lead._id))!;
    if (!fresh.tags.includes(WELCOME_SENT_TAG)) {
      await ctx.db.patch(lead._id, { tags: [...fresh.tags, WELCOME_SENT_TAG], updatedAt: now });
    }

    return { sent: true, messageId, conversationId };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Op de configuração (sem UI nesta rodada)
// ─────────────────────────────────────────────────────────────────────────────

const routingValidator = v.object({
  rules: v.array(v.object({ tag: v.string(), boardId: v.id("boards"), stageId: v.id("stages") })),
});
const welcomeValidator = v.object({
  enabled: v.boolean(),
  channelConfigId: v.id("channelConfigs"),
  requireAnyTag: v.array(v.string()),
  messages: v.array(v.object({ matchTag: v.string(), text: v.string() })),
});

/**
 * `routing`/`welcome`: ausente = não mexe; `null` = remove a configuração.
 * dryRun (default TRUE) valida e devolve o que gravaria, sem gravar.
 */
export const internalSetInboundLeadSettings = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    routing: v.optional(v.union(v.null(), routingValidator)),
    welcome: v.optional(v.union(v.null(), welcomeValidator)),
    dryRun: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");
    const warnings: string[] = [];

    if (args.routing) {
      for (const rule of args.routing.rules) {
        if (!rule.tag.trim()) throw new Error("Regra de roteamento sem tag");
        const invalid = await validRoutingTarget(ctx, args.organizationId, rule.boardId, rule.stageId);
        if (invalid) throw new Error(`Regra da tag "${rule.tag}" inválida: ${invalid}`);
      }
    }

    if (args.welcome) {
      const config = await ctx.db.get(args.welcome.channelConfigId);
      if (!config || config.organizationId !== args.organizationId || config.channel !== "whatsapp") {
        throw new Error("channelConfigId não é um canal de WhatsApp desta organização");
      }
      if (config.status !== "active") warnings.push("O canal está inativo — nada sai até ele voltar.");
      if (configProvider(config) === "meta") {
        warnings.push(
          "Canal Meta: texto livre fora da janela de 24h é recusado pela Meta — a falha abre repasse humano."
        );
      }
      if (args.welcome.enabled && args.welcome.requireAnyTag.filter((t) => t.trim()).length === 0) {
        throw new Error("requireAnyTag vazio: sem tag de consentimento nenhuma boas-vindas sai");
      }
      if (args.welcome.enabled && !pickWelcomeMessage(args.welcome, ["*"])) {
        const anyText = args.welcome.messages.some((m) => m.text.trim());
        if (!anyText) throw new Error("Nenhuma mensagem com texto");
        warnings.push('Sem mensagem padrão ("*"): lead sem tag casando com matchTag não recebe nada.');
      }
    }

    const before = {
      inboundLeadRouting: org.settings.inboundLeadRouting ?? null,
      inboundLeadWelcome: org.settings.inboundLeadWelcome ?? null,
    };
    // MERGE em settings — nunca substituir o objeto inteiro.
    const nextSettings = { ...org.settings };
    if (args.routing !== undefined) {
      if (args.routing === null) delete nextSettings.inboundLeadRouting;
      else nextSettings.inboundLeadRouting = args.routing;
    }
    if (args.welcome !== undefined) {
      if (args.welcome === null) delete nextSettings.inboundLeadWelcome;
      else nextSettings.inboundLeadWelcome = args.welcome;
    }
    const after = {
      inboundLeadRouting: nextSettings.inboundLeadRouting ?? null,
      inboundLeadWelcome: nextSettings.inboundLeadWelcome ?? null,
    };

    if (dryRun) return { dryRun: true, before, after, warnings };

    const now = Date.now();
    await ctx.db.patch(args.organizationId, { settings: nextSettings, updatedAt: now });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorType: "system",
      changes: { before, after },
      metadata: { op: "inboundLeadWelcome:internalSetInboundLeadSettings" },
      description: "Roteamento e boas-vindas do lead inbound atualizados (op)",
      severity: "medium",
      createdAt: now,
    });
    return { dryRun: false, before, after, warnings };
  },
});
