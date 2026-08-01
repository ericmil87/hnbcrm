/**
 * Configuração de IA da organização — leitura de status + ativação.
 * A seção "IA" de Configurações (F4) consome/estende isto.
 *
 * Invariante A: tudo opt-in. Ativar exige settings/manage E o aceite LGPD
 * explícito ("minha política divulga uso de IA + transferência internacional").
 * O runtime (orgAiActive) só roda com enabled && lgpdAck.
 */
import { v } from "convex/values";
import { query, mutation, internalQuery, MutationCtx, QueryCtx } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requirePermission } from "./lib/auth";
import { buildAuditDescription } from "./lib/auditDescription";
import { DEFAULT_MODELS, OPENCODE_GO_MODELS, routeInfo } from "./lib/llm/registry";
import { personaById, personaForIndustry } from "./lib/agentPersonas";

export const getAiStatus = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
    enabled: v.boolean(),
    lgpdAckDone: v.boolean(),
    active: v.boolean(), // enabled && lgpdAck — o que o runtime de fato usa
    // Toggles por produto (P3): undefined no config = ligado.
    copilotEnabled: v.boolean(),
    attendantEnabled: v.boolean(),
    // Aceite de risco do canal bridge (P1): habilita atendente em canais não-oficiais.
    bridgeAiAckDone: v.boolean(),
    // v4.2: estado p/ o wizard de ativação em 1 fluxo.
    hasAttendant: v.boolean(),
    hasBridgeChannel: v.boolean(),
    models: v.object({
      copilot: v.string(),
      attendant: v.string(),
      classify: v.string(),
      complex: v.optional(v.string()),
    }),
    strictZdr: v.boolean(),
    monthlyConversationBudget: v.union(v.number(), v.null()),
    // Roteamento de provider (UI de Configurações → IA).
    providerMode: v.union(v.literal("platform"), v.literal("byo")),
    platformOrder: v.string(), // "auto" | "openrouter-first" | "opencode-only" | "openrouter-only"
    byo: v.union(
      v.object({
        provider: v.string(),
        baseUrl: v.union(v.string(), v.null()),
        keyLast4: v.union(v.string(), v.null()),
      }),
      v.null()
    ),
  }),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    const org = await ctx.db.get(args.organizationId);
    const aiConfig = org?.settings.aiConfig;
    const enabled = aiConfig?.enabled === true;
    const lgpdAckDone = aiConfig?.lgpdAck !== undefined;
    const aiMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) =>
        q.eq("organizationId", args.organizationId).eq("type", "ai")
      )
      .collect();
    const channelConfigs = await ctx.db
      .query("channelConfigs")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    return {
      enabled,
      lgpdAckDone,
      active: enabled && lgpdAckDone,
      copilotEnabled: aiConfig?.copilotEnabled !== false,
      attendantEnabled: aiConfig?.attendantEnabled !== false,
      bridgeAiAckDone: aiConfig?.bridgeAiAck !== undefined,
      hasAttendant: aiMembers.some(
        (m) => m.status === "active" && m.agentProfile?.kind === "attendant"
      ),
      hasBridgeChannel: channelConfigs.some(
        (c) => c.channel === "whatsapp" && c.provider === "bridge" && c.status === "active"
      ),
      models: {
        copilot: aiConfig?.providerConfig?.models.copilot ?? DEFAULT_MODELS.copilot,
        attendant: aiConfig?.providerConfig?.models.attendant ?? DEFAULT_MODELS.attendant,
        classify: aiConfig?.providerConfig?.models.classify ?? DEFAULT_MODELS.classify,
        complex: aiConfig?.providerConfig?.models.complex ?? DEFAULT_MODELS.complex,
      },
      strictZdr: aiConfig?.providerConfig?.strictZdr === true,
      monthlyConversationBudget: aiConfig?.monthlyConversationBudget ?? null,
      providerMode: aiConfig?.providerConfig?.mode ?? "platform",
      platformOrder: aiConfig?.providerConfig?.platformOrder ?? "auto",
      byo: await (async () => {
        const pc = aiConfig?.providerConfig;
        if (pc?.mode !== "byo" || !pc.byo) return null;
        const secret = await ctx.db.get(pc.byo.apiKeyRef.id);
        return {
          provider: pc.byo.provider,
          baseUrl: pc.byo.baseUrl ?? null,
          keyLast4: secret?.last4 ?? null,
        };
      })(),
    };
  },
});

// ── P3: toggles separados Copiloto × Atendente (org-level, sob o mestre) ──
export const setFeatureToggles = mutation({
  args: {
    organizationId: v.id("organizations"),
    copilotEnabled: v.optional(v.boolean()),
    attendantEnabled: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org?.settings.aiConfig) throw new Error("Ative a IA primeiro");
    const current = org.settings.aiConfig;

    const now = Date.now();
    await ctx.db.patch(args.organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...current,
          ...(args.copilotEnabled !== undefined ? { copilotEnabled: args.copilotEnabled } : {}),
          ...(args.attendantEnabled !== undefined
            ? { attendantEnabled: args.attendantEnabled }
            : {}),
        },
      },
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: {
          copilotEnabled: current.copilotEnabled !== false,
          attendantEnabled: current.attendantEnabled !== false,
        },
        after: {
          copilotEnabled: args.copilotEnabled ?? current.copilotEnabled !== false,
          attendantEnabled: args.attendantEnabled ?? current.attendantEnabled !== false,
        },
      },
      metadata: { aiConfig: true },
      description: "Atualizou os toggles de Copiloto/Atendente da IA",
      severity: "medium",
      createdAt: now,
    });
    return null;
  },
});

// ── P1: aceite org-level de risco do canal bridge (API não-oficial) ──
// Aceitar exige o checkbox explícito; revogar remove o objeto do config (o
// histórico de quem aceitou/revogou fica no auditLog — severidade high).
// A revogação vale IMEDIATAMENTE até para runs em voo: "bridge_sem_aceite" é
// condição de elegibilidade re-checada no commit transacional do atendente.
export const setBridgeAiAck = mutation({
  args: {
    organizationId: v.id("organizations"),
    accept: v.boolean(),
    riskAck: v.optional(v.boolean()), // obrigatório true ao aceitar
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org?.settings.aiConfig) throw new Error("Ative a IA primeiro");
    const current = org.settings.aiConfig;

    const now = Date.now();
    if (args.accept) {
      if (args.riskAck !== true) {
        throw new Error(
          "Para ativar a IA em canais não-oficiais, confirme que aceita o risco de banimento permanente do número"
        );
      }
      if (current.bridgeAiAck !== undefined) return null; // já aceito — idempotente
      await ctx.db.patch(args.organizationId, {
        settings: {
          ...org.settings,
          aiConfig: { ...current, bridgeAiAck: { acceptedAt: now, acceptedBy: member._id } },
        },
        updatedAt: now,
      });
    } else {
      if (current.bridgeAiAck === undefined) return null;
      const { bridgeAiAck: _removed, ...rest } = current;
      await ctx.db.patch(args.organizationId, {
        settings: { ...org.settings, aiConfig: rest },
        updatedAt: now,
      });
    }

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: { bridgeAiAck: current.bridgeAiAck !== undefined },
        after: { bridgeAiAck: args.accept },
      },
      metadata: { aiConfig: true, bridgeRisk: true },
      description: args.accept
        ? "Aceitou o risco de banimento e liberou o atendente IA em canais bridge (não-oficiais)"
        : "Revogou o aceite de risco — atendente IA bloqueado em canais bridge",
      severity: "high",
      createdAt: now,
    });
    return null;
  },
});

// Liga/desliga o master switch. Na PRIMEIRA ativação exige lgpdAck:true —
// registra quem aceitou e quando. Desligar nunca apaga o ack (histórico).
export const setAiEnabled = mutation({
  args: {
    organizationId: v.id("organizations"),
    enabled: v.boolean(),
    lgpdAck: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");

    const current = org.settings.aiConfig ?? {
      enabled: false,
      autoAssign: false,
      handoffThreshold: 0.8,
    };

    const now = Date.now();
    let lgpdAck = current.lgpdAck;
    if (args.enabled && !lgpdAck) {
      if (args.lgpdAck !== true) {
        throw new Error(
          "Para ativar a IA, confirme que sua política de privacidade divulga o uso de IA e a transferência internacional de dados"
        );
      }
      lgpdAck = { acceptedAt: now, acceptedBy: member._id };
    }

    await ctx.db.patch(args.organizationId, {
      settings: {
        ...org.settings,
        aiConfig: { ...current, enabled: args.enabled, lgpdAck },
      },
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: { aiEnabled: current.enabled },
        after: { aiEnabled: args.enabled },
      },
      metadata: { aiConfig: true, lgpdAckRecorded: args.enabled && !current.lgpdAck },
      description: args.enabled ? "Ativou a IA da organização" : "Desativou a IA da organização",
      severity: "high",
      createdAt: now,
    });
    return null;
  },
});

// Modo estrito de ZDR: o backend RECUSA rotas não-ZDR (toggle avançado por org).
export const setStrictZdr = mutation({
  args: { organizationId: v.id("organizations"), strictZdr: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");
    const current = org.settings.aiConfig;
    if (!current) throw new Error("Ative a IA primeiro");

    const providerConfig = current.providerConfig ?? {
      mode: "platform" as const,
      zdr: true,
      models: { ...DEFAULT_MODELS },
    };

    const now = Date.now();
    await ctx.db.patch(args.organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...current,
          providerConfig: { ...providerConfig, strictZdr: args.strictZdr },
        },
      },
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: { strictZdr: current.providerConfig?.strictZdr ?? false },
        after: { strictZdr: args.strictZdr },
      },
      description: buildAuditDescription({
        action: "update",
        entityType: "organization",
        metadata: { name: org.name },
      }),
      severity: "medium",
      createdAt: now,
    });
    return null;
  },
});

// ── Gestão do atendente (ativação em 1 toque + personalizar) ──

const agentProfilePatchValidator = v.object({
  mode: v.optional(v.union(v.literal("suggest"), v.literal("autopilot"))),
  systemPrompt: v.optional(v.string()),
  knowledge: v.optional(v.string()),
  language: v.optional(v.string()),
  channelConfigIds: v.optional(v.array(v.id("channelConfigs"))),
  boardIds: v.optional(v.array(v.id("boards"))),
  schedule: v.optional(
    v.union(
      v.null(),
      v.object({
        timezone: v.string(),
        startHour: v.number(),
        endHour: v.number(),
        days: v.optional(v.array(v.number())),
      })
    )
  ),
  handoffKeywords: v.optional(v.array(v.string())),
  maxRepliesPerConversation: v.optional(v.number()),
  maxRepliesPerHour: v.optional(v.number()),
  messageDebounceSeconds: v.optional(v.number()),
  model: v.optional(v.string()),
  temperature: v.optional(v.number()),
  disclosure: v.optional(v.string()),
  // P4: regras de pipeline. v.null() limpa a config inteira (volta ao default).
  pipelineConfig: v.optional(
    v.union(
      v.null(),
      v.object({
        boardId: v.optional(v.id("boards")),
        initialStageId: v.optional(v.id("stages")),
        advanceRules: v.optional(v.string()),
        qualifiedStageId: v.optional(v.id("stages")),
        qualifyThreshold: v.optional(v.number()),
        allowMoveStages: v.optional(v.boolean()),
        captureFields: v.optional(v.array(v.string())),
      })
    )
  ),
});

export const listAttendants = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const aiMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) =>
        q.eq("organizationId", args.organizationId).eq("type", "ai")
      )
      .collect();
    return aiMembers
      .filter((m) => m.agentProfile?.kind === "attendant")
      .map((m) => ({
        _id: m._id,
        name: m.name,
        status: m.status,
        agentProfile: m.agentProfile,
      }));
  },
});

// Semente do atendente (compartilhada pelo 1-toque e pelo wizard de ativação):
// persona por indústria, conhecimento das quickReplies, modo SUGESTÃO e SEM
// horário (24h) — em sugestão nada é enviado sozinho, então restrição de
// horário vira decisão de quem liga o autopilot, não default que silencia a IA.
async function seedAttendant(
  ctx: MutationCtx,
  org: Doc<"organizations">,
  actor: Doc<"teamMembers">,
  opts: { personaId?: string; name?: string }
): Promise<Id<"teamMembers">> {
  const persona = opts.personaId
    ? personaById(opts.personaId)
    : personaForIndustry(org.onboardingMeta?.industry);

  const quickReplies = await ctx.db
    .query("quickReplies")
    .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
    .take(50);
  const knowledge =
    quickReplies.length > 0
      ? "Perguntas e respostas frequentes do time:\n" +
        quickReplies.map((r) => `- ${r.shortcut}: ${r.content}`).join("\n")
      : undefined;

  const now = Date.now();
  const attendantId = await ctx.db.insert("teamMembers", {
    organizationId: org._id,
    name: opts.name?.trim() || "Atendente IA",
    role: "ai",
    type: "ai",
    status: "active",
    agentProfile: {
      kind: "attendant",
      mode: "suggest", // atendente começa SEMPRE em sugestão
      systemPrompt: persona.systemPrompt,
      knowledge,
      language: "pt-BR",
      handoffKeywords: persona.handoffKeywords,
      // P4: regra de avanço default coerente com a persona (editável em
      // Opções avançadas). Só a instrução em linguagem natural — board e
      // estágios ficam no default da org até o admin configurar.
      pipelineConfig: { advanceRules: persona.advanceRules },
    },
    createdAt: now,
    updatedAt: now,
  });

  await ctx.db.insert("auditLogs", {
    organizationId: org._id,
    entityType: "teamMember",
    entityId: attendantId,
    action: "create",
    actorId: actor._id,
    actorType: "human",
    metadata: { type: "ai", kind: "attendant", persona: persona.id },
    description: `Criou o atendente IA (persona ${persona.label}, modo sugestão)`,
    severity: "high",
    createdAt: now,
  });

  return attendantId;
}

// Ativação em 1 toque: cria o teamMember IA já semeado — modo SUGESTÃO, 24h.
export const createAttendantOneClick = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.optional(v.string()),
    personaId: v.optional(v.string()),
  },
  returns: v.id("teamMembers"),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");
    const aiConfig = org.settings.aiConfig;
    if (!aiConfig?.enabled || !aiConfig.lgpdAck) {
      throw new Error("Ative a IA (com o aceite LGPD) antes de criar o atendente");
    }
    return await seedAttendant(ctx, org, member, args);
  },
});

// ── v4.2: ativação em UM fluxo — liga a IA, registra os aceites e cria o
// atendente numa única mutation transacional. MESMOS aceites e auditoria do
// caminho em passos; só a UX muda. Bridge sem aceite → ativa mesmo assim,
// apenas com o bridge de fora (o card continua disponível depois).
export const activateOneFlow = mutation({
  args: {
    organizationId: v.id("organizations"),
    lgpdAck: v.boolean(),
    bridgeRiskAck: v.optional(v.boolean()),
    personaId: v.optional(v.string()),
    attendantName: v.optional(v.string()),
  },
  returns: v.object({
    attendantId: v.id("teamMembers"),
    bridgeEnabled: v.boolean(),
    createdAttendant: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");
    const current = org.settings.aiConfig ?? {
      enabled: false,
      autoAssign: false,
      handoffThreshold: 0.8,
    };
    const now = Date.now();

    let lgpdAck = current.lgpdAck;
    if (!lgpdAck) {
      if (args.lgpdAck !== true) {
        throw new Error(
          "Para ativar a IA, confirme que sua política de privacidade divulga o uso de IA e a transferência internacional de dados"
        );
      }
      lgpdAck = { acceptedAt: now, acceptedBy: member._id };
    }

    const channels = await ctx.db
      .query("channelConfigs")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    const hasBridge = channels.some(
      (c) => c.channel === "whatsapp" && c.provider === "bridge" && c.status === "active"
    );
    let bridgeAiAck = current.bridgeAiAck;
    if (hasBridge && args.bridgeRiskAck === true && !bridgeAiAck) {
      bridgeAiAck = { acceptedAt: now, acceptedBy: member._id };
    }

    await ctx.db.patch(args.organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...current,
          enabled: true,
          lgpdAck,
          attendantEnabled: true,
          ...(bridgeAiAck ? { bridgeAiAck } : {}),
        },
      },
      updatedAt: now,
    });

    // Reusa atendente existente (não duplica em re-ativação).
    const aiMembers = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) =>
        q.eq("organizationId", args.organizationId).eq("type", "ai")
      )
      .collect();
    const existing = aiMembers.find((m) => m.agentProfile?.kind === "attendant");
    let attendantId: Id<"teamMembers">;
    let createdAttendant = false;
    if (existing) {
      attendantId = existing._id;
      if (existing.status !== "active") {
        await ctx.db.patch(existing._id, { status: "active", updatedAt: now });
      }
    } else {
      const orgFresh = (await ctx.db.get(args.organizationId))!;
      attendantId = await seedAttendant(ctx, orgFresh, member, {
        personaId: args.personaId,
        name: args.attendantName,
      });
      createdAttendant = true;
    }

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: { aiEnabled: current.enabled },
        after: { aiEnabled: true },
      },
      metadata: {
        aiConfig: true,
        oneFlow: true,
        lgpdAckRecorded: !current.lgpdAck,
        bridgeAckRecorded: hasBridge && args.bridgeRiskAck === true && !current.bridgeAiAck,
        attendantCreated: createdAttendant,
      },
      description:
        "Ativou a IA em fluxo único (atendente em modo sugestão" +
        (bridgeAiAck && !current.bridgeAiAck ? ", com aceite de risco do bridge" : "") +
        ")",
      severity: "high",
      createdAt: now,
    });

    return { attendantId, bridgeEnabled: hasBridge && bridgeAiAck !== undefined, createdAttendant };
  },
});

// Personalização do perfil. Trocar para AUTOPILOT tem gate de métricas: só após
// >=10 sugestões revisadas com >=60% de aceitação (enforçado AQUI, no servidor).
export const updateAgentProfile = mutation({
  args: {
    agentMemberId: v.id("teamMembers"),
    patch: agentProfilePatchValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentMemberId);
    if (!agent || agent.type !== "ai" || !agent.agentProfile) {
      throw new Error("Agente IA não encontrado");
    }
    const member = await requirePermission(ctx, agent.organizationId, "settings", "manage");

    if (args.patch.mode === "autopilot" && agent.agentProfile.mode !== "autopilot") {
      const metrics = await computeAcceptanceMetrics(ctx, agent.organizationId, agent._id);
      const enough = metrics.reviewed >= 10 && metrics.acceptanceRate >= 0.6;
      if (!enough) {
        throw new Error(
          `Autopilot exige pelo menos 10 sugestões revisadas com 60% de aceitação ` +
            `(hoje: ${metrics.reviewed} revisadas, ${Math.round(metrics.acceptanceRate * 100)}% aceitas)`
        );
      }
    }

    // Tetos de resposta: inteiro >= 0, com 0 = sem limite (ver a condição 9 de
    // evaluateEligibility). Fracionário/negativo viraria um teto silencioso.
    for (const [label, value] of [
      ["Máx. respostas por conversa", args.patch.maxRepliesPerConversation],
      ["Máx. respostas por hora", args.patch.maxRepliesPerHour],
    ] as const) {
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${label}: use um número inteiro maior ou igual a zero (0 = sem limite)`);
      }
    }

    // Agrupamento de mensagens: 1s a 120s. Zero não faz sentido (responderia no
    // meio da digitação) e o teto evita conversa que nunca recebe resposta.
    const debounce = args.patch.messageDebounceSeconds;
    if (debounce !== undefined && (!Number.isInteger(debounce) || debounce < 1 || debounce > 120)) {
      throw new Error("Agrupar mensagens por: use um número inteiro de segundos entre 1 e 120");
    }

    // P4: integridade do pipelineConfig — board da org; estágios do board certo.
    const pipelineConfig = args.patch.pipelineConfig;
    if (pipelineConfig !== undefined && pipelineConfig !== null) {
      if (pipelineConfig.boardId) {
        const board = await ctx.db.get(pipelineConfig.boardId);
        if (!board || board.organizationId !== agent.organizationId) {
          throw new Error("Funil não encontrado nesta organização");
        }
      }
      for (const [field, stageId] of [
        ["estágio inicial", pipelineConfig.initialStageId],
        ["estágio pós-qualificação", pipelineConfig.qualifiedStageId],
      ] as const) {
        if (!stageId) continue;
        const stage = await ctx.db.get(stageId);
        if (!stage || stage.organizationId !== agent.organizationId) {
          throw new Error(`Estágio (${field}) não encontrado nesta organização`);
        }
        // O estágio inicial precisa pertencer ao board configurado; o de
        // qualificação é validado de novo em runtime contra o board ATUAL do lead.
        if (
          field === "estágio inicial" &&
          pipelineConfig.boardId &&
          stage.boardId !== pipelineConfig.boardId
        ) {
          throw new Error("O estágio inicial não pertence ao funil escolhido");
        }
      }
      if (
        pipelineConfig.qualifyThreshold !== undefined &&
        (pipelineConfig.qualifyThreshold < 1 || pipelineConfig.qualifyThreshold > 4)
      ) {
        throw new Error("O limiar de qualificação deve ficar entre 1 e 4 (BANT)");
      }
    }

    const { schedule, pipelineConfig: _pc, ...rest } = args.patch;
    const clean = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value !== undefined)
    );
    const next = {
      ...agent.agentProfile,
      ...clean,
      ...(schedule !== undefined ? { schedule: schedule ?? undefined } : {}),
      ...(pipelineConfig !== undefined
        ? { pipelineConfig: pipelineConfig ?? undefined }
        : {}),
    };
    const now = Date.now();
    await ctx.db.patch(agent._id, { agentProfile: next, updatedAt: now });

    await ctx.db.insert("auditLogs", {
      organizationId: agent.organizationId,
      entityType: "teamMember",
      entityId: agent._id,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: { agentProfile: agent.agentProfile as unknown as Record<string, unknown> },
        after: { agentProfile: next as unknown as Record<string, unknown> },
      },
      metadata: { name: agent.name, agentConfig: true },
      description:
        args.patch.mode === "autopilot"
          ? `Ativou o AUTOPILOT do atendente '${agent.name}'`
          : `Atualizou o perfil do agente IA '${agent.name}'`,
      severity: args.patch.mode === "autopilot" ? "high" : "medium",
      createdAt: now,
    });
    return null;
  },
});

// ── Métricas de aceitação (modo sugestão) + uso/custo ──

async function computeAcceptanceMetrics(
  ctx: { db: QueryCtx["db"] },
  organizationId: Id<"organizations">,
  agentMemberId?: Id<"teamMembers">
) {
  const runs = await ctx.db
    .query("agentRuns")
    .withIndex("by_organization_and_kind_and_started", (q) =>
      q.eq("organizationId", organizationId).eq("kind", "attendant")
    )
    .order("desc")
    .take(300);
  const relevant = agentMemberId ? runs.filter((r) => r.memberId === agentMemberId) : runs;

  let pending = 0;
  let sent = 0;
  let sentEdited = 0;
  let discarded = 0;
  for (const run of relevant) {
    if (!run.resultMessageId) continue;
    const message = await ctx.db.get(run.resultMessageId);
    const draft = message?.metadata?.aiDraft as { status?: string } | undefined;
    if (!draft) continue;
    if (draft.status === "pending") pending++;
    else if (draft.status === "sent") sent++;
    else if (draft.status === "sent_edited") sentEdited++;
    else if (draft.status === "discarded") discarded++;
  }
  const reviewed = sent + sentEdited + discarded;
  return {
    pending,
    sent,
    sentEdited,
    discarded,
    reviewed,
    acceptanceRate: reviewed > 0 ? (sent + sentEdited) / reviewed : 0,
  };
}

export const getAttendantMetrics = query({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.optional(v.id("teamMembers")),
  },
  returns: v.object({
    pending: v.number(),
    sent: v.number(),
    sentEdited: v.number(),
    discarded: v.number(),
    reviewed: v.number(),
    acceptanceRate: v.number(),
    autopilotUnlocked: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const metrics = await computeAcceptanceMetrics(
      ctx,
      args.organizationId,
      args.agentMemberId
    );
    return {
      ...metrics,
      autopilotUnlocked: metrics.reviewed >= 10 && metrics.acceptanceRate >= 0.6,
    };
  },
});

// Medidor amigável: conversas atendidas no mês + custo estimado. O cliente passa
// o início do mês (query sem Date.now() — regra de reatividade do Convex).
export const getAiUsage = query({
  args: { organizationId: v.id("organizations"), monthStart: v.number() },
  returns: v.object({
    conversationsThisMonth: v.number(),
    runsThisMonth: v.number(),
    costUsdEstimate: v.number(),
    promptTokens: v.number(),
    completionTokens: v.number(),
    cachedPromptTokens: v.number(),
    budget: v.union(v.number(), v.null()),
  }),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    const org = await ctx.db.get(args.organizationId);
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_organization_and_started", (q) =>
        q.eq("organizationId", args.organizationId).gte("startedAt", args.monthStart)
      )
      .collect();

    const conversations = new Set(
      runs.filter((r) => r.kind === "attendant" && r.conversationId).map((r) => r.conversationId)
    );
    let costUsdEstimate = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedPromptTokens = 0;
    for (const run of runs) {
      costUsdEstimate += run.costUsdEstimate ?? 0;
      promptTokens += run.promptTokens ?? 0;
      completionTokens += run.completionTokens ?? 0;
      cachedPromptTokens += run.cachedPromptTokens ?? 0;
    }
    return {
      conversationsThisMonth: conversations.size,
      runsThisMonth: runs.length,
      costUsdEstimate,
      promptTokens,
      completionTokens,
      cachedPromptTokens,
      budget: org?.settings.aiConfig?.monthlyConversationBudget ?? null,
    };
  },
});

export const setMonthlyBudget = mutation({
  args: {
    organizationId: v.id("organizations"),
    budget: v.union(v.number(), v.null()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org?.settings.aiConfig) throw new Error("Ative a IA primeiro");
    if (args.budget !== null && (args.budget < 1 || args.budget > 1_000_000)) {
      throw new Error("Budget inválido");
    }
    await ctx.db.patch(args.organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...org.settings.aiConfig,
          monthlyConversationBudget: args.budget ?? undefined,
        },
      },
      updatedAt: Date.now(),
    });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: { monthlyConversationBudget: org.settings.aiConfig.monthlyConversationBudget },
        after: { monthlyConversationBudget: args.budget },
      },
      description: "Atualizou o budget mensal de conversas da IA",
      severity: "medium",
      createdAt: Date.now(),
    });
    return null;
  },
});

// Seletor de modelo com selo de residência/ZDR — expõe o registry ao admin.
export const getModelOptions = query({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "settings", "view");
    return OPENCODE_GO_MODELS.map((id) => ({
      id,
      route: routeInfo("opencode-go", id),
    }));
  },
});

export const setModels = mutation({
  args: {
    organizationId: v.id("organizations"),
    models: v.object({
      copilot: v.string(),
      attendant: v.string(),
      classify: v.string(),
      complex: v.optional(v.string()),
    }),
    // Exigido quando alguma rota escolhida não é ZDR (aviso → aceite; v3 §3).
    nonZdrAck: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org?.settings.aiConfig) throw new Error("Ative a IA primeiro");
    const current = org.settings.aiConfig;

    const chosen = [
      args.models.copilot,
      args.models.attendant,
      args.models.classify,
      ...(args.models.complex ? [args.models.complex] : []),
    ];
    const nonZdrRoutes = chosen.filter((m) => !routeInfo("opencode-go", m).zdrCapable);
    const zdrOn = current.providerConfig?.zdr !== false;
    let nonZdrAck = current.providerConfig?.nonZdrAck;
    if (zdrOn && nonZdrRoutes.length > 0) {
      if (current.providerConfig?.strictZdr) {
        // Modo estrito: recusa no backend (o aviso vira bloqueio de verdade).
        throw new Error(
          `Modo ZDR estrito ativo — as rotas ${nonZdrRoutes.join(", ")} retêm dados e foram recusadas`
        );
      }
      if (args.nonZdrAck !== true) {
        throw new Error(
          `As rotas ${nonZdrRoutes.join(", ")} não são zero-retention — confirme o aceite para continuar`
        );
      }
      nonZdrAck = {
        acceptedAt: Date.now(),
        acceptedBy: member._id,
        route: nonZdrRoutes.join(","),
      };
    }

    const providerConfig = {
      mode: current.providerConfig?.mode ?? ("platform" as const),
      byo: current.providerConfig?.byo,
      zdr: zdrOn,
      strictZdr: current.providerConfig?.strictZdr,
      platformOrder: current.providerConfig?.platformOrder,
      nonZdrAck,
      models: args.models,
    };
    await ctx.db.patch(args.organizationId, {
      settings: {
        ...org.settings,
        aiConfig: { ...current, providerConfig },
      },
      updatedAt: Date.now(),
    });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: { models: current.providerConfig?.models },
        after: { models: args.models },
      },
      description: "Atualizou os modelos de IA da organização",
      severity: "medium",
      createdAt: Date.now(),
    });
    return null;
  },
});

// ── Modo de provider: platform (default) ou BYO (key própria da org) ──

export const setProviderMode = mutation({
  args: {
    organizationId: v.id("organizations"),
    mode: v.union(v.literal("platform"), v.literal("byo")),
    byo: v.optional(
      v.object({
        provider: v.union(
          v.literal("opencode-go"),
          v.literal("openrouter"),
          v.literal("openai"),
          v.literal("anthropic"),
          v.literal("custom")
        ),
        baseUrl: v.optional(v.string()),
        orgSecretId: v.id("orgSecrets"),
      })
    ),
    // Aviso ZDR → aceite quando o provider BYO não é zero-retention.
    nonZdrAck: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org?.settings.aiConfig) throw new Error("Ative a IA primeiro");
    const current = org.settings.aiConfig;

    let byo: NonNullable<typeof current.providerConfig>["byo"];
    let nonZdrAck = current.providerConfig?.nonZdrAck;
    if (args.mode === "byo") {
      if (!args.byo) throw new Error("Informe provider e chave para o modo BYO");
      const secret = await ctx.db.get(args.byo.orgSecretId);
      if (!secret || secret.organizationId !== args.organizationId) {
        throw new Error("Chave de API não encontrada");
      }
      if (args.byo.provider === "custom" && !args.byo.baseUrl) {
        throw new Error("Base URL é obrigatória para provider custom");
      }
      // ZDR: aviso, não bloqueio — mas sob modo estrito, recusa (v3 §3).
      const modelForCheck =
        current.providerConfig?.models.attendant ?? DEFAULT_MODELS.attendant;
      const route = routeInfo(args.byo.provider, modelForCheck);
      const zdrOn = current.providerConfig?.zdr !== false;
      if (zdrOn && !route.zdrCapable && args.byo.provider !== "opencode-go") {
        if (current.providerConfig?.strictZdr) {
          throw new Error(
            `Modo ZDR estrito ativo — o provider ${args.byo.provider} não garante zero-retention e foi recusado`
          );
        }
        if (args.nonZdrAck !== true) {
          throw new Error(
            `O provider ${args.byo.provider} pode reter dados (${route.retention}, residência ${route.dataResidency}) — confirme o aceite para continuar`
          );
        }
        nonZdrAck = {
          acceptedAt: Date.now(),
          acceptedBy: member._id,
          route: `byo:${args.byo.provider}`,
        };
      }
      byo = {
        provider: args.byo.provider,
        baseUrl: args.byo.baseUrl,
        apiKeyRef: { kind: "orgSecret" as const, id: args.byo.orgSecretId },
      };
    }

    const providerConfig = {
      mode: args.mode,
      byo: args.mode === "byo" ? byo : undefined,
      zdr: current.providerConfig?.zdr ?? true,
      strictZdr: current.providerConfig?.strictZdr,
      platformOrder: current.providerConfig?.platformOrder,
      nonZdrAck,
      models: current.providerConfig?.models ?? { ...DEFAULT_MODELS },
    };
    await ctx.db.patch(args.organizationId, {
      settings: { ...org.settings, aiConfig: { ...current, providerConfig } },
      updatedAt: Date.now(),
    });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: { providerMode: current.providerConfig?.mode ?? "platform" },
        after: { providerMode: args.mode },
      },
      metadata: args.mode === "byo" ? { byoProvider: args.byo!.provider } : {},
      description:
        args.mode === "byo"
          ? `Trocou o provider de IA para BYO (${args.byo!.provider})`
          : "Voltou o provider de IA para o padrão da plataforma",
      severity: "high",
      createdAt: Date.now(),
    });
    return null;
  },
});

// ── Roteamento da cadeia da plataforma (primário/fallback) ──
// Só afeta mode "platform" — em BYO a org usa uma rota única com a própria key.
export const setPlatformOrder = mutation({
  args: {
    organizationId: v.id("organizations"),
    platformOrder: v.union(
      v.literal("auto"),
      v.literal("openrouter-first"),
      v.literal("opencode-only"),
      v.literal("openrouter-only")
    ),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "settings", "manage");
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");
    const current = org.settings.aiConfig;
    if (!current) throw new Error("Ative a IA primeiro");

    const providerConfig = current.providerConfig ?? {
      mode: "platform" as const,
      zdr: true,
      models: { ...DEFAULT_MODELS },
    };

    const now = Date.now();
    await ctx.db.patch(args.organizationId, {
      settings: {
        ...org.settings,
        aiConfig: {
          ...current,
          providerConfig: { ...providerConfig, platformOrder: args.platformOrder },
        },
      },
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "organization",
      entityId: args.organizationId,
      action: "update",
      actorId: member._id,
      actorType: "human",
      changes: {
        before: { platformOrder: current.providerConfig?.platformOrder ?? "auto" },
        after: { platformOrder: args.platformOrder },
      },
      description: "Atualizou o roteamento de provider da IA",
      severity: "medium",
      createdAt: now,
    });
    return null;
  },
});

// Internal: providerConfig cru para actions (diagnóstico de conexão).
export const internalGetProviderConfig = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const org = await ctx.db.get(args.organizationId);
    return org?.settings.aiConfig?.providerConfig ?? null;
  },
});
