/**
 * Semente do atendente IA (compartilhada pelo 1-toque, pelo wizard de ativação
 * e pela aplicação do Rascunho de Operação do onboarding): persona por
 * indústria, conhecimento das quickReplies, modo SUGESTÃO e SEM horário (24h)
 * — em sugestão nada é enviado sozinho, então restrição de horário vira decisão
 * de quem liga o autopilot, não default que silencia a IA.
 *
 * Extraída de `aiSettings.ts` sem mudar o comportamento dos chamadores antigos:
 * os campos de `overrides` são opcionais e, ausentes, o resultado é idêntico.
 * Quem chama já autorizou o `actor`.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { personaById, personaForIndustry } from "./agentPersonas";
import { insertAgentTextsForNewMember } from "./agentProfileTexts";
import type { ConfigVia } from "./attendantConfigOps";

export type AttendantSeedOverrides = {
  /** Persona já montada (ex.: template do onboarding). Ausente = persona da indústria. */
  persona?: string;
  /** Conhecimento já montado. Ausente = FAQ a partir das quickReplies da org. */
  faq?: string;
  handoffKeywords?: string[];
  language?: string;
  pipelineConfig?: { boardId?: Id<"boards">; initialStageId?: Id<"stages"> };
  via?: ConfigVia;
};

export async function seedAttendantCore(
  ctx: MutationCtx,
  org: Doc<"organizations">,
  actor: Doc<"teamMembers">,
  opts: { personaId?: string; name?: string; overrides?: AttendantSeedOverrides }
): Promise<Id<"teamMembers">> {
  const persona = opts.personaId
    ? personaById(opts.personaId)
    : personaForIndustry(org.onboardingMeta?.industry);
  const overrides = opts.overrides ?? {};

  let faq = overrides.faq;
  if (faq === undefined) {
    const quickReplies = await ctx.db
      .query("quickReplies")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(50);
    faq =
      quickReplies.length > 0
        ? "Perguntas e respostas frequentes do time:\n" +
          quickReplies.map((r) => `- ${r.shortcut}: ${r.content}`).join("\n")
        : undefined;
  }

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
      // Texto (persona + FAQ) nasce em `agentProfileTexts`, não no doc.
      textsMigratedAt: now,
      language: overrides.language ?? "pt-BR",
      handoffKeywords: overrides.handoffKeywords ?? persona.handoffKeywords,
      // P4: regra de avanço default coerente com a persona (editável em
      // Opções avançadas). Board e estágio só quando quem chama informa
      // (onboarding); senão ficam no default da org até o admin configurar.
      pipelineConfig: { ...(overrides.pipelineConfig ?? {}), advanceRules: persona.advanceRules },
    },
    createdAt: now,
    updatedAt: now,
  });
  await insertAgentTextsForNewMember(
    ctx,
    { _id: attendantId, organizationId: org._id },
    { systemPrompt: overrides.persona ?? persona.systemPrompt, knowledge: faq },
    now
  );

  await ctx.db.insert("auditLogs", {
    organizationId: org._id,
    entityType: "teamMember",
    entityId: attendantId,
    action: "create",
    actorId: actor._id,
    actorType: "human",
    metadata: {
      type: "ai",
      kind: "attendant",
      persona: persona.id,
      ...(overrides.via ? { via: overrides.via } : {}),
    },
    description: `Criou o atendente IA (persona ${persona.label}, modo sugestão)`,
    severity: "high",
    createdAt: now,
  });

  return attendantId;
}
