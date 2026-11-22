/**
 * Harness de SIMULAÇÃO da IA na Agenda v2 (medição com modelo real, só DEV).
 *
 * Tudo `internal*`: semeia uma org de cenário (slug `sim-agenda-*`, `demoMode` = nenhuma mensagem sai de verdade),
 * cria clientes fictícios e roda UM turno pelo pipeline REAL do atendente (`conversations.internalReceiveMessage` →
 * fila → prompt, tools, guard e commit reais), esperando a resposta. Lê o estado para a verificação feita fora.
 *
 * Travas: toda função exige `settings.demoMode === true` e slug `sim-agenda-*`; o dispatch do WhatsApp curto-circuita
 * org com demoMode (a mensagem vira `delivered` local); a configuração da agenda passa pelos cores de `schedConfigOps`
 * e os agendamentos existentes pela porta (`bookAppointmentCore`), como um dono faria. Nada aqui escreve em
 * `schedAppointments`/`schedAllocations` direto.
 */
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "./_generated/server";
import { writeAgentTexts } from "./lib/agentProfileTexts";
import { bookAppointmentCore } from "./lib/schedBookingOps";
import { setResourceDayExceptionCore } from "./lib/schedExceptionOps";
import { updateSchedSettingsCore, upsertResourceCore, upsertServiceCore } from "./lib/schedConfigOps";
import { addLocalDays, atLocalMinutes, localDateOf } from "./lib/schedTime";

export const SIM_SLUG_PREFIX = "sim-agenda-";

const hhmm = (s: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new ConvexError(`Hora inválida: ${s}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

async function requireSimOrg(ctx: { db: QueryCtx["db"] }, organizationId: Id<"organizations">): Promise<Doc<"organizations">> {
  const org = await ctx.db.get(organizationId);
  if (!org || org.settings.demoMode !== true || !org.slug.startsWith(SIM_SLUG_PREFIX)) {
    throw new ConvexError("simAgenda: só orgs de cenário (demoMode + slug sim-agenda-*)");
  }
  return org;
}

const specValidator = v.object({
  slug: v.string(),
  name: v.string(),
  timezone: v.optional(v.string()),
  attendantModel: v.optional(v.string()),
  persona: v.string(),
  knowledge: v.optional(v.string()),
  spendCapUsd: v.optional(v.number()),
  resources: v.array(
    v.object({
      key: v.string(),
      kind: v.union(v.literal("person"), v.literal("room"), v.literal("equipment")),
      name: v.string(),
      capacity: v.number(),
      tags: v.optional(v.array(v.string())),
      weekly: v.array(v.object({ weekday: v.number(), start: v.string(), end: v.string() })),
    })
  ),
  services: v.array(
    v.object({
      name: v.string(),
      durationMin: v.number(),
      bufferBeforeMin: v.optional(v.number()),
      bufferAfterMin: v.optional(v.number()),
      requirements: v.array(
        v.object({
          role: v.string(),
          kind: v.union(v.literal("person"), v.literal("room"), v.literal("equipment")),
          resourceKeys: v.optional(v.array(v.string())),
          tag: v.optional(v.string()),
          units: v.optional(v.number()),
        })
      ),
      minNoticeMin: v.optional(v.number()),
      maxAdvanceDays: v.optional(v.number()),
      slotIntervalMin: v.optional(v.number()),
      aiBookable: v.optional(v.boolean()),
      priceCents: v.optional(v.number()),
    })
  ),
  settings: v.optional(
    v.object({
      gridMinutes: v.optional(v.number()),
      minNoticeMin: v.optional(v.number()),
      maxAdvanceDays: v.optional(v.number()),
      smartMode: v.optional(v.union(v.literal("off"), v.literal("rank"), v.literal("restrict"))),
      aiBook: v.optional(v.union(v.literal("off"), v.literal("propose"), v.literal("auto"))),
      firstVisitNeedsApproval: v.optional(v.boolean()),
    })
  ),
  exceptions: v.optional(
    v.array(
      v.object({
        resourceKey: v.optional(v.string()),
        dayOffset: v.number(),
        mode: v.union(v.literal("closed"), v.literal("custom"), v.literal("extra"), v.literal("block")),
        intervals: v.optional(v.array(v.object({ start: v.string(), end: v.string() }))),
        reasonCode: v.optional(v.union(v.literal("no_staff"), v.literal("maintenance"), v.literal("day_off"), v.literal("holiday"), v.literal("other"))),
      })
    )
  ),
  appointments: v.optional(
    v.array(
      v.object({
        service: v.string(),
        dayOffset: v.number(),
        time: v.string(),
        resourceKeys: v.optional(v.array(v.string())),
        name: v.string(),
      })
    )
  ),
});

/** Cria a org de cenário inteira. Recusa slug existente (nada é sobrescrito). */
export const internalSeedScenarioOrg = internalMutation({
  args: { spec: specValidator },
  returns: v.object({
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    adminMemberId: v.id("teamMembers"),
    channelConfigId: v.id("channelConfigs"),
    today: v.string(),
    resourceIds: v.record(v.string(), v.id("schedResources")),
    serviceIds: v.array(v.object({ name: v.string(), id: v.id("schedServices") })),
    appointmentsCreated: v.number(),
  }),
  handler: async (ctx, { spec }) => {
    if (!spec.slug.startsWith(SIM_SLUG_PREFIX)) throw new ConvexError("slug precisa começar com sim-agenda-");
    const dup = await ctx.db.query("organizations").withIndex("by_slug", (q) => q.eq("slug", spec.slug)).first();
    if (dup) throw new ConvexError("slug já existe");
    const now = Date.now();
    const tz = spec.timezone ?? "America/Sao_Paulo";
    const today = localDateOf(now, tz);
    const cap = spec.spendCapUsd ?? 0.5;
    const organizationId = await ctx.db.insert("organizations", {
      name: spec.name,
      slug: spec.slug,
      settings: {
        timezone: tz,
        currency: "BRL",
        demoMode: true,
        modules: { scheduling: true },
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 0.8,
          providerConfig: {
            mode: "platform",
            models: {
              copilot: "kimi-k2.7-code",
              attendant: spec.attendantModel ?? "deepseek-flash-latest",
              classify: "deepseek-v4-flash",
            },
            platformOrder: "openrouter-first",
            zdr: true,
          },
          // Teto de gasto do próprio sistema (`internalSpendGate`), em R$ pela cotação da org.
          spendCap: { mode: "block", monthlyBrl: Math.round(cap * 5.5 * 100) / 100, usdBrlRate: 5.5, warnPct: 80 },
        },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: `${spec.slug}@sim.invalid`, name: "Dona (sim)" });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Dona (sim)", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Assistente (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: {
        kind: "attendant",
        mode: "autopilot",
        messageDebounceSeconds: 3,
        botGuard: { enabled: false },
      },
      createdAt: now,
      updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } } },
    });
    const agent = (await ctx.db.get(agentId))!;
    await writeAgentTexts(ctx, agent, { systemPrompt: spec.persona, knowledge: spec.knowledge }, { now });
    const channelConfigId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Número sim", phoneNumberId: `sim-${spec.slug}`,
      status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });

    const admin = (await ctx.db.get(adminId))!;
    const resourceIds: Record<string, Id<"schedResources">> = {};
    let order = 0;
    for (const r of spec.resources) {
      const res = await upsertResourceCore(ctx, {
        organizationId, member: admin, now, audit: false,
        input: {
          kind: r.kind, name: r.name, capacity: r.capacity, tags: r.tags, sortOrder: order++,
          weekly: r.weekly.map((w) => ({ weekday: w.weekday, startMin: hhmm(w.start), endMin: hhmm(w.end) })),
        },
      });
      resourceIds[r.key] = res.resourceId;
    }
    const serviceIds: Record<string, Id<"schedServices">> = {};
    order = 0;
    for (const s of spec.services) {
      serviceIds[s.name] = await upsertServiceCore(ctx, {
        organizationId, member: admin, now, audit: false,
        input: {
          name: s.name, durationMin: s.durationMin, bufferBeforeMin: s.bufferBeforeMin, bufferAfterMin: s.bufferAfterMin,
          requirements: s.requirements.map((q) => ({
            role: q.role, kind: q.kind, tag: q.tag, units: q.units,
            ...(q.resourceKeys ? { resourceIds: q.resourceKeys.map((k) => resourceIds[k]) } : {}),
          })),
          minNoticeMin: s.minNoticeMin, maxAdvanceDays: s.maxAdvanceDays, slotIntervalMin: s.slotIntervalMin,
          aiBookable: s.aiBookable, priceCents: s.priceCents, sortOrder: order++,
        },
      });
    }
    const st = spec.settings;
    await updateSchedSettingsCore(ctx, {
      organizationId, member: admin, now, via: "settings",
      patch: {
        ...(st?.gridMinutes !== undefined ? { gridMinutes: st.gridMinutes } : {}),
        ...(st?.minNoticeMin !== undefined ? { minNoticeMin: st.minNoticeMin } : {}),
        ...(st?.maxAdvanceDays !== undefined ? { maxAdvanceDays: st.maxAdvanceDays } : {}),
        ...(st?.smartMode ? { smart: { mode: st.smartMode } } : {}),
        ai: {
          ...(st?.aiBook ? { book: st.aiBook } : {}),
          ...(st?.firstVisitNeedsApproval !== undefined ? { firstVisitNeedsApproval: st.firstVisitNeedsApproval } : {}),
        },
      },
    });
    for (const e of spec.exceptions ?? []) {
      const date = addLocalDays(today, e.dayOffset);
      await setResourceDayExceptionCore(ctx, {
        organizationId, actor: { type: "human", member: admin }, now, mode: "commit",
        ...(e.resourceKey ? { resourceId: resourceIds[e.resourceKey] } : {}),
        fromLocalDate: date, toLocalDate: date, kind: e.mode,
        ...(e.intervals ? { intervals: e.intervals.map((i) => ({ startMin: hhmm(i.start), endMin: hhmm(i.end) })) } : {}),
        ...(e.reasonCode ? { reasonCode: e.reasonCode } : {}),
        acceptAffected: true,
      });
    }
    let appointmentsCreated = 0;
    for (const a of spec.appointments ?? []) {
      const contactId = await ctx.db.insert("contacts", { organizationId, firstName: a.name, tags: [], createdAt: now, updatedAt: now });
      const startTime = atLocalMinutes(addLocalDays(today, a.dayOffset), hhmm(a.time), tz);
      await bookAppointmentCore(ctx, {
        organizationId, actor: { type: "human", member: admin }, origin: "staff", serviceId: serviceIds[a.service],
        startTime, contactId, initialStatus: "scheduled", now,
        ...(a.resourceKeys ? { resourceIds: a.resourceKeys.map((k) => resourceIds[k]), allowResourceFallback: false } : {}),
      });
      appointmentsCreated++;
    }
    return {
      organizationId, agentMemberId: agentId, adminMemberId: adminId, channelConfigId, today, resourceIds,
      serviceIds: Object.entries(serviceIds).map(([name, id]) => ({ name, id })), appointmentsCreated,
    };
  },
});

/** Agendamentos existentes (equipe, `scheduled`) pela porta, em lotes pequenos; recurso por NOME. */
export const internalSimAddAppointments = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    appointments: v.array(v.object({ service: v.string(), dayOffset: v.number(), time: v.string(), resourceNames: v.array(v.string()), name: v.string() })),
  },
  returns: v.object({ created: v.number(), failed: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const org = await requireSimOrg(ctx, args.organizationId);
    const tz = org.settings.timezone ?? "America/Sao_Paulo";
    const admin = await ctx.db.query("teamMembers").withIndex("by_organization_and_type", (q) => q.eq("organizationId", args.organizationId).eq("type", "human")).first();
    if (!admin) throw new ConvexError("sem admin");
    const resources = await ctx.db.query("schedResources").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).take(100);
    const services = await ctx.db.query("schedServices").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).take(100);
    const now = Date.now();
    const today = localDateOf(now, tz);
    let created = 0;
    const failed: string[] = [];
    for (const a of args.appointments) {
      const service = services.find((s) => s.name === a.service);
      const ids = a.resourceNames.map((n) => resources.find((r) => r.name === n)?._id);
      if (!service || ids.some((i) => !i)) { failed.push(`${a.service}@${a.dayOffset} ${a.time}: nome desconhecido`); continue; }
      const contactId = await ctx.db.insert("contacts", { organizationId: args.organizationId, firstName: a.name, tags: [], createdAt: now, updatedAt: now });
      try {
        await bookAppointmentCore(ctx, {
          organizationId: args.organizationId, actor: { type: "human", member: admin }, origin: "staff", serviceId: service._id,
          startTime: atLocalMinutes(addLocalDays(today, a.dayOffset), hhmm(a.time), tz), contactId, initialStatus: "scheduled", now,
          resourceIds: ids as Id<"schedResources">[], allowResourceFallback: false,
        });
        created++;
      } catch (e) {
        failed.push(`${a.service}@${a.dayOffset} ${a.time}: ${e instanceof Error ? e.message.slice(0, 80) : "erro"}`);
      }
    }
    return { created, failed };
  },
});

async function newCustomerCore(ctx: MutationCtx, org: Doc<"organizations">, name: string, phone: string) {
  const now = Date.now();
  const organizationId = org._id;
  const agent = await ctx.db.query("teamMembers").withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "ai")).first();
  const cfg = await ctx.db.query("channelConfigs").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).first();
  const board = await ctx.db.query("boards").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).first();
  const stage = board ? await ctx.db.query("stages").withIndex("by_board", (q) => q.eq("boardId", board._id)).first() : null;
  if (!agent || !cfg || !board || !stage) throw new ConvexError("org de cenário incompleta");
  const contactId = await ctx.db.insert("contacts", { organizationId, firstName: name, phone, tags: [], createdAt: now, updatedAt: now });
  const leadId = await ctx.db.insert("leads", {
    organizationId, title: `${name} WhatsApp`, contactId, boardId: board._id, stageId: stage._id, assignedTo: agent._id, value: 0, currency: "BRL",
    priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
  });
  const conversationId = await ctx.db.insert("conversations", {
    organizationId, leadId, channel: "whatsapp", channelConfigId: cfg._id, status: "active", lastInboundAt: now, messageCount: 0, createdAt: now, updatedAt: now,
  });
  return { contactId, leadId, conversationId, channelConfigId: cfg._id };
}

export const internalSimNewCustomer = internalMutation({
  args: { organizationId: v.id("organizations"), name: v.string(), phone: v.string() },
  returns: v.object({ contactId: v.id("contacts"), leadId: v.id("leads"), conversationId: v.id("conversations"), channelConfigId: v.id("channelConfigs") }),
  handler: async (ctx, args) => {
    const org = await requireSimOrg(ctx, args.organizationId);
    return await newCustomerCore(ctx, org, args.name, args.phone);
  },
});

/** Simula a passagem do tempo para as ofertas da conversa (oferta vencida): recua emissão, exibição e validade. */
export const internalSimAgeOffers = internalMutation({
  args: { organizationId: v.id("organizations"), conversationId: v.id("conversations"), minutes: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    await requireSimOrg(ctx, args.organizationId);
    const doc = await ctx.db.query("schedConversationState").withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId)).first();
    if (!doc || doc.organizationId !== args.organizationId) return 0;
    const d = args.minutes * 60_000;
    await ctx.db.patch(doc._id, {
      offers: doc.offers.map((o) => ({ ...o, issuedAt: o.issuedAt - d, expiresAt: o.expiresAt - d, ...(o.shownAt !== undefined ? { shownAt: o.shownAt - d } : {}) })),
    });
    return doc.offers.length;
  },
});

/** Muda a configuração da agenda da org de cenário pelo core de configuração (modo inteligente, IA marca sozinha…). */
export const internalSimSetSched = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    smartMode: v.optional(v.union(v.literal("off"), v.literal("rank"), v.literal("restrict"))),
    aiBook: v.optional(v.union(v.literal("off"), v.literal("propose"), v.literal("auto"))),
    firstVisitNeedsApproval: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSimOrg(ctx, args.organizationId);
    const admin = await ctx.db.query("teamMembers").withIndex("by_organization_and_type", (q) => q.eq("organizationId", args.organizationId).eq("type", "human")).first();
    if (!admin) throw new ConvexError("sem admin");
    // O aceite do "marca sozinha" exige uma conta autenticada (requireAccountWithEmail): o harness grava o aceite do
    // dono fictício direto (org de cenário, demoMode) e o resto passa pelo core de configuração.
    if (args.aiBook === "auto") {
      const doc = await ctx.db.query("schedSettings").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).first();
      if (doc && !doc.ai?.autoAck) await ctx.db.patch(doc._id, { ai: { ...(doc.ai ?? {}), autoAck: { by: admin._id, at: Date.now() } } });
    }
    await updateSchedSettingsCore(ctx, {
      organizationId: args.organizationId, member: admin, now: Date.now(), via: "settings",
      patch: {
        ...(args.smartMode ? { smart: { mode: args.smartMode } } : {}),
        ai: { ...(args.aiBook ? { book: args.aiBook } : {}), ...(args.firstVisitNeedsApproval !== undefined ? { firstVisitNeedsApproval: args.firstVisitNeedsApproval } : {}) },
      },
    });
    return null;
  },
});

/** Liga/desliga a IA da org de cenário (fim da medição: desligar). */
export const internalSimSetAiEnabled = internalMutation({
  args: { organizationId: v.id("organizations"), enabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const org = await requireSimOrg(ctx, args.organizationId);
    if (!org.settings.aiConfig) return null;
    await ctx.db.patch(org._id, { settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig, enabled: args.enabled } }, updatedAt: Date.now() });
    return null;
  },
});

/** Troca o modelo do atendente da org de cenário (segundo modelo da cadeia). */
export const internalSimSetModel = internalMutation({
  args: { organizationId: v.id("organizations"), model: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const org = await requireSimOrg(ctx, args.organizationId);
    const ai = org.settings.aiConfig;
    if (!ai?.providerConfig?.models) return null;
    await ctx.db.patch(org._id, {
      settings: { ...org.settings, aiConfig: { ...ai, providerConfig: { ...ai.providerConfig, models: { ...ai.providerConfig.models, attendant: args.model } } } },
      updatedAt: Date.now(),
    });
    return null;
  },
});

type Settled = { settled: boolean; reason: string };

/**
 * Um turno do cliente: grava as mensagens (pela entrada real), espera a fila terminar e devolve o estado.
 * `texts` com mais de uma entrada = mensagem picada (enviadas com `gapMs` entre elas, antes do fim do debounce).
 */
export const internalSimTurn = internalAction({
  args: {
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    conversationId: v.id("conversations"),
    channelConfigId: v.id("channelConfigs"),
    texts: v.array(v.string()),
    gapMs: v.optional(v.number()),
    timeoutMs: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args): Promise<unknown> => {
    const t0 = Date.now();
    let triggerId: Id<"messages"> | null = null;
    for (let i = 0; i < args.texts.length; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, args.gapMs ?? 800));
      triggerId = await ctx.runMutation(internal.conversations.internalReceiveMessage, {
        organizationId: args.organizationId, leadId: args.leadId, channel: "whatsapp", channelConfigId: args.channelConfigId, content: args.texts[i],
      });
    }
    const deadline = t0 + (args.timeoutMs ?? 170_000);
    let last: any = null;
    let verdict: Settled = { settled: false, reason: "timeout" };
    let noQueueSince = Date.now();
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      last = await ctx.runQuery(internal.simAgendaRead.internalSimState, { organizationId: args.organizationId, conversationId: args.conversationId });
      const mine = (last.queue as Array<{ status: string; triggerMessageId: string; updatedAt: number; createdAt: number }>).filter((q) => q.createdAt >= t0 - 1000);
      const active = mine.some((q) => q.status === "pending" || q.status === "processing");
      if (mine.length === 0) {
        if (Date.now() - noQueueSince > 15_000) { verdict = { settled: true, reason: "sem_fila" }; break; }
        continue;
      }
      if (active) continue;
      const aiOut = (last.messages as Array<{ direction: string; senderType: string; createdAt: number }>).some((m) => m.direction === "outbound" && m.senderType === "ai" && m.createdAt >= t0);
      const failed = mine.some((q) => q.status === "failed");
      const skipped = mine.some((q) => q.status === "skipped");
      verdict = { settled: true, reason: aiOut ? "resposta" : failed ? "falha" : skipped ? "pulado" : "sem_resposta" };
      // pequena folga para efeitos pós-commit (repasse, notificações)
      await new Promise((r) => setTimeout(r, 1200));
      last = await ctx.runQuery(internal.simAgendaRead.internalSimState, { organizationId: args.organizationId, conversationId: args.conversationId });
      break;
    }
    return { t0, triggerId, elapsedMs: Date.now() - t0, verdict, state: last };
  },
});
