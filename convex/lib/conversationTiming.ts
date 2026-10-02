/**
 * Carimbos de tempo de primeira resposta (MVP "Central").
 *
 * Puros de propósito: devolvem campos para ENTRAR no patch que o chamador já
 * faz na conversa — nenhuma escrita extra, nenhum comportamento novo. Valem
 * para toda org (são só dados), e o painel lê `firstResponseAt - firstInboundAt`.
 *
 *  - `firstInboundAt`: primeira mensagem do contato (só se ausente).
 *  - `firstResponseAt`/`firstResponderType`: primeira saída DEPOIS de um
 *    inbound (só se ausente). Mensagem antes de qualquer inbound (campanha,
 *    abordagem ativa) não é "resposta" e não carimba nada.
 */
import { Doc } from "../_generated/dataModel";

type Timing = Pick<Doc<"conversations">, "firstInboundAt" | "firstResponseAt">;

export function firstInboundPatch(
  conversation: Timing,
  now: number
): { firstInboundAt?: number } {
  return conversation.firstInboundAt === undefined ? { firstInboundAt: now } : {};
}

export function firstResponsePatch(
  conversation: Timing,
  responderType: "ai" | "human",
  now: number
): { firstResponseAt?: number; firstResponderType?: "ai" | "human" } {
  if (conversation.firstInboundAt === undefined) return {};
  if (conversation.firstResponseAt !== undefined) return {};
  // Histórico importado do aparelho pode ser anterior ao primeiro inbound.
  if (now < conversation.firstInboundAt) return {};
  return { firstResponseAt: now, firstResponderType: responderType };
}
