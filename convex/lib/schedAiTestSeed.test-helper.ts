/**
 * Semente de teste do Agenda v2 D1 (tools do Atendente): uma org com IA ligada (LGPD aceita), módulo `scheduling`,
 * um atendente IA em autopilot, canal, contato/lead/conversa 1:1 e uma agenda pequena (1 profissional, 1 sala,
 * serviços "Consulta", "Sessão" e "Massagem casal" (sala dupla, capacidade 2); segunda a sexta, 08:00–18:00). Relógio dos testes: sexta 2026-06-12 09:00 em São Paulo.
 */
import type { TestConvex } from "convex-test";
import type { Doc, Id } from "../_generated/dataModel";
import type schema from "../schema";

export const AI_NOW = new Date("2026-06-12T12:00:00Z").getTime(); // sexta, 09:00 em São Paulo
/** Instante de `h:m` (São Paulo, UTC-3) do dia `day` de junho/2026 (15 = segunda-feira, 12 = sexta). */
export const aiAt = (h: number, m = 0, day = 15) => Date.UTC(2026, 5, day, h + 3, m);

const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 480, endMin: 1080 }));

export type AiSeedOpts = {
  scheduling?: boolean;
  aiEnabled?: boolean;
  /** Patch de `schedSettings.ai`; `null` = sem doc de configuração (padrões). */
  ai?: NonNullable<Doc<"schedSettings">["ai"]> | null;
  mode?: "suggest" | "autopilot";
  noService?: boolean;
  noResource?: boolean;
  relation?: "personal";
};

export async function seedAiAgenda(t: TestConvex<typeof schema>, opts: AiSeedOpts = {}) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Clínica IA",
      slug: `clinica-ia-${Math.random().toString(36).slice(2, 8)}`,
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        modules: { scheduling: opts.scheduling ?? true },
        aiConfig: { enabled: opts.aiEnabled ?? true, autoAssign: false, handoffThreshold: 0.8 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: "admin@teste.dev", name: "Admin" });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId: adminUserId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const agentId = await ctx.db.insert("teamMembers", {
      organizationId, name: "Guia (IA)", role: "ai", type: "ai", status: "active",
      agentProfile: { kind: "attendant", mode: opts.mode ?? "autopilot", disclosureMode: "on_demand" },
      createdAt: now, updatedAt: now,
    });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, {
      settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: adminId } } },
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Número principal", phoneNumberId: "555000111",
      status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const mkConversation = async (name: string, phone: string) => {
      const contactId = await ctx.db.insert("contacts", {
        organizationId, firstName: name, phone, tags: [], ...(opts.relation ? { relation: opts.relation } : {}), createdAt: now, updatedAt: now,
      });
      const leadId = await ctx.db.insert("leads", {
        organizationId, title: `${name} WhatsApp`, contactId, boardId, stageId, assignedTo: agentId, value: 0, currency: "BRL",
        priority: "medium", temperature: "warm", tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now,
        createdAt: now, updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId, leadId, channel: "whatsapp", channelConfigId: configId, status: "active", lastInboundAt: now,
        messageCount: 0, ...(opts.relation ? { contactRelation: opts.relation } : {}), createdAt: now, updatedAt: now,
      });
      return { contactId, leadId, conversationId };
    };
    const ana = await mkConversation("Ana", "5511988887777");
    const bia = await mkConversation("Bia", "5511977776666");

    let p1: Id<"schedResources"> | undefined;
    let sala1: Id<"schedResources"> | undefined;
    let dupla: Id<"schedResources"> | undefined;
    if (!opts.noResource) {
      p1 = await ctx.db.insert("schedResources", {
        organizationId, kind: "person", name: "Dra. Helena", capacity: 1, weekly: WEEKDAYS, tags: [], sortOrder: 0, active: true, createdAt: now, updatedAt: now,
      });
      sala1 = await ctx.db.insert("schedResources", {
        organizationId, kind: "room", name: "Sala Rosa", capacity: 1, weekly: WEEKDAYS, tags: [], sortOrder: 1, active: true, createdAt: now, updatedAt: now,
      });
      dupla = await ctx.db.insert("schedResources", {
        organizationId, kind: "room", name: "Sala Dupla", capacity: 2, weekly: WEEKDAYS, tags: [], sortOrder: 2, active: true, createdAt: now, updatedAt: now,
      });
    }
    const services: Record<string, Id<"schedServices">> = {};
    if (!opts.noService) {
      const mk = (name: string, requirements: Doc<"schedServices">["requirements"], extra: Partial<Doc<"schedServices">> = {}) =>
        ctx.db.insert("schedServices", {
          organizationId, name, durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, requirements, sortOrder: 0, active: true,
          createdAt: now, updatedAt: now, ...extra,
        });
      services.consulta = await mk("Consulta", [{ role: "Profissional", kind: "person" }], { priceCents: 15000 });
      services.sessao = await mk("Sessão", [{ role: "Sala", kind: "room" }], { sortOrder: 1, durationMin: 45 });
      services.casal = await mk("Massagem casal", dupla ? [{ role: "Sala", kind: "room", resourceIds: [dupla] }] : [{ role: "Sala", kind: "room" }], { sortOrder: 3, durationMin: 60 });
      services.interno = await mk("Procedimento interno", [{ role: "Profissional", kind: "person" }], { sortOrder: 2, aiBookable: false });
    }
    if (opts.ai !== null) {
      await ctx.db.insert("schedSettings", {
        organizationId,
        ...(opts.ai ? { ai: opts.ai } : {}),
        updatedAt: now,
      });
    }
    return { organizationId, adminId, adminUserId, agentId, configId, boardId, stageId, ana, bia, p1, sala1, dupla, services };
  });
}

export type AiSeed = Awaited<ReturnType<typeof seedAiAgenda>>;

/** Marca a última mensagem do cliente em `at` (a oferta só vale se emitida ANTES dela). */
export async function customerSpoke(t: TestConvex<typeof schema>, conversationId: Id<"conversations">, at: number) {
  await t.run((ctx) => ctx.db.patch(conversationId, { lastInboundAt: at }));
}
