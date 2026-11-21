/**
 * Agenda v2 (D1) — estado da agenda POR CONVERSA (`schedConversationState`): ofertas (`h1`…), contador de
 * "horário tomado" e teto de consultas por hora. Único arquivo do D1 que ESCREVE nessa tabela. Não cita nenhuma
 * tabela de agendamento (guard `schedulingPort.test.ts`: `patch` só em arquivo que não cita `schedAppointments`).
 *
 * A linha é compartilhada com a interpretação da mensagem do humano (campo `proposal`, outro PR): toda escrita
 * aqui faz PATCH só dos campos do D1; nunca `replace`.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { OffersState } from "./schedOffers";

type StateDoc = Doc<"schedConversationState">;

export async function loadConversationState(ctx: { db: QueryCtx["db"] }, conversationId: Id<"conversations">): Promise<StateDoc | null> {
  return await ctx.db
    .query("schedConversationState")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .first();
}

export function offersStateOf(doc: StateDoc | null): OffersState {
  return { offerSeq: doc?.offerSeq ?? 0, offers: doc?.offers ?? [] };
}

export type StatePatch = {
  offers?: OffersState;
  slotTakenCount?: number;
  findCalls?: { windowStart: number; count: number };
};

/** Cria a linha (organização e conversa já conferidas por quem chama) ou altera só os campos do D1. */
export async function saveConversationState(
  ctx: MutationCtx,
  args: { organizationId: Id<"organizations">; conversationId: Id<"conversations">; existing: StateDoc | null; patch: StatePatch; now: number }
): Promise<void> {
  const { existing, patch, now } = args;
  if (existing) {
    await ctx.db.patch(existing._id, {
      ...(patch.offers ? { offerSeq: patch.offers.offerSeq, offers: patch.offers.offers as StateDoc["offers"] } : {}),
      ...(patch.slotTakenCount !== undefined ? { slotTakenCount: patch.slotTakenCount } : {}),
      ...(patch.findCalls ? { findCalls: patch.findCalls } : {}),
      updatedAt: now,
    });
    return;
  }
  await ctx.db.insert("schedConversationState", {
    organizationId: args.organizationId,
    conversationId: args.conversationId,
    offerSeq: patch.offers?.offerSeq ?? 0,
    offers: (patch.offers?.offers ?? []) as StateDoc["offers"],
    ...(patch.slotTakenCount !== undefined ? { slotTakenCount: patch.slotTakenCount } : {}),
    ...(patch.findCalls ? { findCalls: patch.findCalls } : {}),
    updatedAt: now,
  });
}
