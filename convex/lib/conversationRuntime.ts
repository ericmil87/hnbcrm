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

// ---------------------------------------------------------------------------
// TRANSITÓRIO (fase 4b) — remover no PR que tira os campos legados de
// `conversations` (contactPresence/aiTurnLock/nextDispatchAt) do schema.
//
// Janela de deploy: uma action do atendente que começou com o código ANTIGO
// gravou o lock em `conversations.aiTurnLock`; o deploy acontece durante a
// inferência e o commit do código NOVO não acharia lock no runtime → turno
// PERDIDO (`lock_perdido`, cliente sem resposta). Por isso o commit aceita o
// lock legado quando NÃO há lock no runtime, e o claim respeita um lock legado
// vivo (no máximo 1 defer, até o lease expirar).
// ---------------------------------------------------------------------------

type LegacyLockHolder = Pick<Doc<"conversations">, "_id" | "aiTurnLock">;

/** Lock vigente: o do runtime; sem ele, o legado do doc da conversa (TRANSITÓRIO). */
export function effectiveAiTurnLock(
  runtime: ConversationRuntime | null,
  conversation: LegacyLockHolder
): ConversationRuntime["aiTurnLock"] {
  return runtime?.aiTurnLock ?? conversation.aiTurnLock;
}

/**
 * O lock da conversa é deste `runId`? Runtime primeiro; o campo legado só vale
 * quando o runtime NÃO tem lock (TRANSITÓRIO — ver acima).
 */
export async function ownsAiTurnLock(
  ctx: QueryCtx | MutationCtx,
  conversation: LegacyLockHolder,
  runId: string
): Promise<boolean> {
  const runtimeLock = await getAiTurnLock(ctx, conversation._id);
  return (
    runtimeLock?.runId === runId ||
    (!runtimeLock && conversation.aiTurnLock?.runId === runId)
  );
}

/**
 * Solta o lock no fim de um commit que já validou a posse: limpa o runtime e,
 * se o lock legado do doc for deste `runId`, limpa-o também (senão o próximo
 * claim deferiria até o lease expirar). O ramo legado é TRANSITÓRIO.
 */
export async function clearOwnedAiTurnLock(
  ctx: MutationCtx,
  conversation: LegacyLockHolder,
  runId: string
): Promise<void> {
  await clearRuntimeField(ctx, conversation._id, "aiTurnLock");
  if (conversation.aiTurnLock?.runId === runId) {
    await ctx.db.patch(conversation._id, { aiTurnLock: undefined });
  }
}
