import { formatRelative } from "./format";

/**
 * Regras puras da lista "Requer atenção" no celular (uma linha de duas linhas
 * por pedido de ajuda, estilo Conversas). O componente só desenha.
 */

export interface AttentionListSource {
  reason: string;
  summary?: string | null;
  createdAt: number;
  title?: string | null;
  isGroup?: boolean;
  lead?: { title?: string } | null;
  contact?: { firstName?: string; lastName?: string; company?: string } | null;
}

/** A partir de quanto tempo de espera o pedido fica em destaque de atraso. */
export const ATTENTION_LATE_AFTER_MS = 60 * 60_000;

export type AttentionUrgency = "waiting" | "late";

function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function contactName(h: AttentionListSource): string {
  return clean([h.contact?.firstName, h.contact?.lastName].filter(Boolean).join(" "));
}

/** Linha 1: título pronto do servidor (lead ou sala), senão o contato. */
export function attentionItemTitle(h: AttentionListSource): string {
  return clean(h.title) || clean(h.lead?.title) || contactName(h) || "Conversa";
}

/**
 * Complemento da linha 2, depois do motivo: o resumo da IA; sem resumo, o
 * contato/empresa (quando não repete o título) ou "Grupo de WhatsApp". Vazio
 * quando não há nada novo a dizer. A linha trunca: o que não couber some.
 */
export function attentionItemDetail(h: AttentionListSource): string {
  const summary = clean(h.summary);
  if (summary) return summary;
  if (h.isGroup) return "Grupo de WhatsApp";
  const title = attentionItemTitle(h);
  const parts = [contactName(h), clean(h.contact?.company)].filter((p) => p && p !== title);
  return parts.join(" • ");
}

/** Motivo da linha 2; motivo vazio (pedido sem texto) vira "Pedido de ajuda". */
export function attentionItemReason(h: Pick<AttentionListSource, "reason">): string {
  return clean(h.reason) || "Pedido de ajuda";
}

/** Espera de uma hora ou mais vira atraso (ponto e hora em vermelho). */
export function attentionUrgency(createdAt: number, now: number): AttentionUrgency {
  return now - createdAt >= ATTENTION_LATE_AFTER_MS ? "late" : "waiting";
}

export function pendingCountLabel(count: number): string {
  return `${count} ${count === 1 ? "pendente" : "pendentes"}`;
}

/** "52 pendentes · o mais antigo há 3h" (o complemento só com 2 ou mais). */
export function attentionSummaryLine(items: { createdAt: number }[], now: number): string {
  const label = pendingCountLabel(items.length);
  if (items.length < 2) return label;
  const oldest = Math.min(...items.map((i) => i.createdAt));
  const rel = formatRelative(oldest, now);
  // Depois de 7 dias o formatador devolve a data ("07 de nov. de 2026").
  const when = rel === "agora" || rel.startsWith("há ") ? rel : `de ${rel}`;
  return `${label} · o mais antigo ${when}`;
}
