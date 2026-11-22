import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import {
  bookOfferedTimeCore,
  findAvailableTimesCore,
  loadSchedAiAccess,
  runFindSearch,
  schedContextCore,
  schedContextValidator,
  professionalNoteValidator,
  schedToolOutcomeValidator,
  toolTextValidator,
} from "./lib/schedAiOps";
import { parseFindArgs } from "./lib/schedAttendantTools";

/**
 * Agenda v2 (D1): funções internas das tools de agenda do Atendente. Finas: a regra mora em `lib/schedAiOps.ts`.
 *
 * - Só `internal*`: chamadas pela action do atendente (`attendant.ts`) com os ids do CLAIM; o modelo nunca fornece
 *   organização, conversa nem agente. Cada função reconfere módulo, IA, política e contato (`loadSchedAiAccess`).
 * - `internalContextBlock` (query): serviços + próximos horários do contato para o prompt. Sem `Date.now()`: o
 *   relógio entra por `now`. É também o gate de REGISTRO das tools (`null` = as tools não entram na run).
 * - `internalFindAvailableTimes` e `internalBookOfferedTime` (mutations): uma por chamada de tool; a reserva NÃO é
 *   atômica com a resposta ao cliente (idempotência + dedupe de negócio da porta cobrem a repetição do turno).
 * - `internalSimulateFind` (query): leitura da busca para o simulador (sem conversa, sem gravar ofertas).
 */

export const internalContextBlock = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    /** Ausente = simulador (sem conversa nem contato). */
    conversationId: v.optional(v.id("conversations")),
    now: v.number(),
  },
  returns: schedContextValidator,
  handler: async (ctx, args) => schedContextCore(ctx, args),
});

export const internalFindAvailableTimes = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    conversationId: v.id("conversations"),
    argsJson: v.string(),
  },
  returns: schedToolOutcomeValidator,
  handler: async (ctx, args) => findAvailableTimesCore(ctx, args),
});

export const internalBookOfferedTime = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    conversationId: v.id("conversations"),
    argsJson: v.string(),
    /** `preview` = rascunho do modo sugestão com a política `auto`: valida e não grava. */
    mode: v.optional(v.union(v.literal("commit"), v.literal("preview"))),
    agentRunId: v.optional(v.string()),
  },
  returns: schedToolOutcomeValidator,
  handler: async (ctx, args) => bookOfferedTimeCore(ctx, { ...args, mode: args.mode ?? "commit" }),
});

/** Busca do simulador: devolve só os instantes (a action emite os códigos em memória e formata). */
export const internalSimulateFind = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    agentMemberId: v.id("teamMembers"),
    argsJson: v.string(),
    now: v.number(),
  },
  returns: v.object({
    result: v.optional(toolTextValidator),
    found: v.optional(
      v.object({
        serviceId: v.id("schedServices"),
        echo: v.string(),
        timezone: v.string(),
        hasMore: v.boolean(),
        period: v.optional(v.string()),
        people: v.number(),
        startTimes: v.array(v.number()),
        total: v.number(),
        wanted: v.optional(v.object({ timeMin: v.number(), available: v.boolean() })),
        professional: v.optional(professionalNoteValidator),
        named: v.optional(v.string()),
      })
    ),
  }),
  handler: async (ctx, args) => {
    const access = await loadSchedAiAccess(ctx, { organizationId: args.organizationId, agentMemberId: args.agentMemberId, need: "consult" });
    if (!access.ok) {
      return { result: { status: "erro", error: "agenda_desligada", proximo_passo: "A agenda não está disponível para a IA neste negócio." } };
    }
    const parsed = parseFindArgs(args.argsJson);
    if (!parsed.ok) return { result: { status: "erro", error: parsed.error, proximo_passo: parsed.proximo_passo } };
    const searched = await runFindSearch(ctx, access, parsed.args, args.now);
    if (searched.kind !== "slots") return { result: searched.result };
    return {
      found: {
        serviceId: searched.service._id,
        echo: searched.echo,
        timezone: searched.tz,
        hasMore: searched.hasMore,
        ...(parsed.args.period ? { period: parsed.args.period } : {}),
        people: parsed.args.people,
        startTimes: searched.slots.map((s) => s.startTime),
        total: searched.total,
        ...(searched.wanted ? { wanted: searched.wanted } : {}),
        ...(searched.professional ? { professional: searched.professional } : {}),
        ...(searched.named ? { named: searched.named } : {}),
      },
    };
  },
});
