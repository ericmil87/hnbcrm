/**
 * Item da `aiReplyQueue` que descreve o estado da IA numa conversa (chip
 * "IA em espera" do inbox). Fonte única de `attendant.getConversationAiState`
 * e do backfill `opsAttendant.internalBackfillAiResumedAt`, para os dois não
 * divergirem.
 */
import { GenericDatabaseReader } from "convex/server";
import { Doc, Id, DataModel } from "../_generated/dataModel";

const STATUSES = ["pending", "processing", "done", "skipped", "failed"] as const;

/**
 * Último item NÃO follow-up da conversa (maior `updatedAt` entre os status).
 * Itens de FOLLOW-UP ficam de fora: o chip fala sobre a última mensagem do
 * cliente ("IA em espera: teto"), e um turno proativo que acabou de ser pulado
 * diria isso sobre uma conversa em que ninguém escreveu nada. take generoso:
 * uma conversa pode acumular vários itens `follow_up` pulados (cada adiamento
 * deixa rastro), e com uma janela curta o chip ficaria cego para o último
 * turno REATIVO, que é o que ele descreve.
 */
export async function latestReactiveQueueItem(
  db: GenericDatabaseReader<DataModel>,
  conversationId: Id<"conversations">
): Promise<Doc<"aiReplyQueue"> | null> {
  let latest: Doc<"aiReplyQueue"> | null = null;
  for (const status of STATUSES) {
    const items = await db
      .query("aiReplyQueue")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversationId).eq("status", status)
      )
      .order("desc")
      .take(100);
    const item = items.find((i) => i.origin !== "follow_up");
    if (item && (!latest || item.updatedAt > latest.updatedAt)) latest = item;
  }
  return latest;
}

/**
 * Um humano devolveu a conversa à IA depois deste item pulado/falho (ex.:
 * `handoff_pendente` gravado com o repasse aberto): ele não descreve mais o
 * estado. pending/processing/done seguem valendo.
 */
export function isSupersededByResume(
  item: Doc<"aiReplyQueue">,
  aiResumedAt: number | undefined
): boolean {
  return (
    (item.status === "skipped" || item.status === "failed") &&
    item.updatedAt < (aiResumedAt ?? 0)
  );
}
