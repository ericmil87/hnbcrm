/**
 * Estado efêmero e quente da conversa (perf Convex I/O, fase 4b).
 *
 * `contactPresence`, `aiTurnLock` e `nextDispatchAt` saíram do doc
 * `conversations` para a tabela `conversationRuntime` (1 linha por conversa,
 * criada sob demanda): cada patch neles reexecutava todas as queries reativas
 * que leram a conversa (lista do inbox, thread aberto, chip da IA, repasse…),
 * sem que nenhuma delas usasse esses campos.
 *
 * Porta ÚNICA de acesso — ninguém lê/escreve a tabela fora daqui.
 *
 * OCC: `getRuntime` lê pelo índice `by_conversation` com `.first()`, o que põe
 * o range no read set da transação MESMO quando a linha ainda não existe.
 * Assim dois `upsertRuntime` concorrentes (ou dois claims do lock, que leem e
 * escrevem na mesma transação) colidem e só um commita — inclusive no 1º
 * insert, que é o caso de dois claims numa conversa ainda sem linha.
 */
import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";

export type ConversationRuntime = Doc<"conversationRuntime">;

type RuntimeField = "contactPresence" | "aiTurnLock" | "nextDispatchAt";

export type RuntimePatch = Partial<Pick<ConversationRuntime, RuntimeField>>;

export async function getRuntime(
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">
): Promise<ConversationRuntime | null> {
  return await ctx.db
    .query("conversationRuntime")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .first();
}

/**
 * Lê a linha (entra no read set) e faz `patch` ou `insert`. `undefined` num
 * campo do patch LIMPA o campo. Se a linha não existe e o patch só limpa
 * campos, não cria linha nenhuma (nada a guardar). `existing` evita uma 2ª
 * leitura quando o chamador já leu a linha NA MESMA transação.
 */
export async function upsertRuntime(
  ctx: MutationCtx,
  ref: { organizationId: Id<"organizations">; conversationId: Id<"conversations"> },
  patch: RuntimePatch,
  existing?: ConversationRuntime | null
): Promise<void> {
  let row: ConversationRuntime | null;
  if (existing !== undefined) {
    row = existing;
  } else {
    // `take(2)` em vez de `.first()`: defesa contra linha duplicada (não deve
    // acontecer — o OCC serializa o 1º insert —, mas se houver, a extra sai).
    const rows = await ctx.db
      .query("conversationRuntime")
      .withIndex("by_conversation", (q) => q.eq("conversationId", ref.conversationId))
      .take(2);
    row = rows[0] ?? null;
    if (rows[1]) await ctx.db.delete(rows[1]._id);
  }
  const now = Date.now();
  if (row) {
    await ctx.db.patch(row._id, { ...patch, updatedAt: now });
    return;
  }
  const hasValue = Object.values(patch).some((v) => v !== undefined);
  if (!hasValue) return;
  await ctx.db.insert("conversationRuntime", {
    organizationId: ref.organizationId,
    conversationId: ref.conversationId,
    ...patch,
    updatedAt: now,
  });
}

/** Limpa um campo do runtime (no-op se a linha não existe ou o campo já está vazio). */
export async function clearRuntimeField(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  field: RuntimeField
): Promise<void> {
  const row = await getRuntime(ctx, conversationId);
  if (!row || row[field] === undefined) return;
  await ctx.db.patch(row._id, { [field]: undefined, updatedAt: Date.now() });
}

/** Lock do turno de IA vigente (ou undefined). */
export async function getAiTurnLock(
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">
): Promise<ConversationRuntime["aiTurnLock"]> {
  return (await getRuntime(ctx, conversationId))?.aiTurnLock;
}

/**
 * Solta o lock SÓ se ele ainda é deste `runId` (o lease pode ter expirado e
 * outro claim ter assumido). Devolve true quando soltou.
 */
export async function releaseAiTurnLock(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  runId: string
): Promise<boolean> {
  const row = await getRuntime(ctx, conversationId);
  if (!row || row.aiTurnLock?.runId !== runId) return false;
  await ctx.db.patch(row._id, { aiTurnLock: undefined, updatedAt: Date.now() });
  return true;
}

/** Apaga a(s) linha(s) de runtime da conversa (cascata de exclusão). */
export async function deleteRuntime(
  ctx: MutationCtx,
  conversationId: Id<"conversations">
): Promise<number> {
  const rows = await ctx.db
    .query("conversationRuntime")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
    .take(10);
  for (const row of rows) await ctx.db.delete(row._id);
  return rows.length;
}

/** O lock do turno de IA da conversa é deste `runId`? */
export async function ownsAiTurnLock(
  ctx: QueryCtx | MutationCtx,
  conversationId: Id<"conversations">,
  runId: string
): Promise<boolean> {
  return (await getAiTurnLock(ctx, conversationId))?.runId === runId;
}

/** Solta o lock no fim de um commit que já validou a posse. */
export async function clearOwnedAiTurnLock(
  ctx: MutationCtx,
  conversationId: Id<"conversations">
): Promise<void> {
  await clearRuntimeField(ctx, conversationId, "aiTurnLock");
}
