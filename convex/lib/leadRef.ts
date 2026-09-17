/**
 * Leitura do lead de uma conversa/mensagem quando o vínculo é OPCIONAL.
 *
 * `conversations.leadId` e `messages.leadId` viraram opcionais na v0.57 para
 * caber a conversa de GRUPO, que é uma sala e não um lead. `ctx.db.get()` com
 * um id possivelmente `undefined` não tipa (e, pior, o TypeScript passa a
 * inferir a união de TODAS as tabelas como retorno), então todo ponto que antes
 * fazia `ctx.db.get(conversation.leadId)` passa por aqui.
 *
 * Semântica deliberada: id ausente = `null`, igual a lead apagado. Quem depende
 * do lead já tratava `null`; quem não depende segue sem ramo novo.
 */
import { GenericDatabaseReader } from "convex/server";
import { Doc, Id, DataModel } from "../_generated/dataModel";

export async function getLeadRef(
  db: GenericDatabaseReader<DataModel>,
  leadId: Id<"leads"> | undefined | null
): Promise<Doc<"leads"> | null> {
  if (!leadId) return null;
  return await db.get(leadId);
}
