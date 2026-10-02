/**
 * Guardrail anti-bot (v0.65) — operações com ctx que precisam morar FORA de
 * `attendant.ts`: `handoffs.ts` também limpa a suspeita (rejeitar o repasse =
 * "é pessoa, devolve pra IA"), e `attendant.ts` já importa `handoffs.ts` —
 * importar de volta fecharia um ciclo de módulos. A APLICAÇÃO da suspeita
 * (`applyBotSuspicion`) fica em `attendant.ts`, porque abre repasse via
 * `createHandoffCore`.
 */
import type { MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { resolveBotGuardSettings } from "./botGuard";

/** Suspeita ATIVA = marcada e ainda não limpa por um humano. */
export function hasActiveBotSuspicion(conversation: Pick<Doc<"conversations">, "botSuspicion">): boolean {
  return conversation.botSuspicion !== undefined && conversation.botSuspicion.clearedAt === undefined;
}

/**
 * Etiqueta a remover: a do atendente quando ele é conhecido (pode ter sido
 * customizada), senão a padrão. Se a org trocou a etiqueta entre marcar e
 * limpar, a antiga fica no lead — aceito (o humano remove na mão; o schema não
 * guarda a etiqueta aplicada).
 */
export function botTagFor(agent: Doc<"teamMembers"> | null | undefined): string {
  return resolveBotGuardSettings(agent?.agentProfile).tag;
}

/**
 * Limpa a suspeita: grava `clearedAt`/`clearedBy` (os contadores da heurística
 * passam a contar a partir daqui — sem isso a mesma rodada re-dispararia na
 * hora), remove a etiqueta do lead e deixa rastro (activity + audit + webhook).
 * No-op quando não há suspeita ativa. Devolve se limpou.
 */
export async function clearBotSuspicion(
  ctx: MutationCtx,
  args: {
    /** Só o `_id` é usado — o doc é relido aqui dentro. */
    conversation: Pick<Doc<"conversations">, "_id">;
    lead: Doc<"leads"> | null;
    member: Doc<"teamMembers">;
    tag: string;
    now: number;
    via: "return_to_ai" | "handoff_rejected";
  }
): Promise<boolean> {
  const { lead, member, tag, now } = args;
  // Relê a conversa: o caller costuma ter um doc ANTERIOR a outro patch da
  // mesma transação (ex.: `returnToAi` despausa antes de limpar).
  const conversation = await ctx.db.get(args.conversation._id);
  if (!conversation || !hasActiveBotSuspicion(conversation)) return false;
  const suspicion = conversation.botSuspicion!;

  await ctx.db.patch(conversation._id, {
    botSuspicion: { ...suspicion, clearedAt: now, clearedBy: member._id },
    updatedAt: now,
  });

  // Relê o lead: o caller pode ter um doc anterior a outro patch da transação.
  const freshLead = lead ? await ctx.db.get(lead._id) : null;
  if (freshLead && freshLead.tags.includes(tag)) {
    await ctx.db.patch(freshLead._id, {
      tags: freshLead.tags.filter((t) => t !== tag),
      updatedAt: now,
    });
  }

  const actorType = member.type === "ai" ? ("ai" as const) : ("human" as const);
  if (freshLead) {
    await ctx.db.insert("activities", {
      organizationId: conversation.organizationId,
      leadId: freshLead._id,
      type: "note",
      actorId: member._id,
      actorType,
      content: `${member.name} confirmou que não é robô — a IA volta a atender`,
      metadata: { conversationId: conversation._id, botSuspicionCleared: true, via: args.via },
      createdAt: now,
    });
  }
  await ctx.db.insert("auditLogs", {
    organizationId: conversation.organizationId,
    entityType: "conversation",
    entityId: conversation._id,
    action: "update",
    actorId: member._id,
    actorType,
    changes: {
      before: { botSuspicion: "ativa" },
      after: { botSuspicion: "limpa", clearedBy: member._id },
    },
    metadata: { leadId: freshLead?._id, tag, via: args.via, source: suspicion.source },
    description: `Suspeita de robô limpa por ${member.name}${freshLead ? ` no lead '${freshLead.title}'` : ""}`,
    severity: "medium",
    createdAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: conversation.organizationId,
    event: "conversation.bot_cleared",
    payload: {
      conversationId: conversation._id,
      leadId: freshLead?._id ?? null,
      clearedBy: member._id,
      via: args.via,
      tag,
    },
  });
  return true;
}
