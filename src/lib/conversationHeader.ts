// Regras puras do cabeçalho da conversa (estilo WhatsApp): o subtítulo único
// e a preferência de "detalhes" recolhidos no celular. Testadas em
// `conversationHeader.test.ts`.

export type HeaderSubtitleTone = "typing" | "attention" | "ai" | "muted";

export interface HeaderSubtitle {
  text: string;
  tone: HeaderSubtitleTone;
}

export interface HeaderSubtitleInput {
  typing: boolean;
  isGroup: boolean;
  participantsCount: number;
  /** Repasse aberto: a IA pediu ajuda. */
  handoffPending: boolean;
  /** Suspeita de robô ativa (só 1 a 1). */
  botSuspected: boolean;
  /** A IA está preparando uma resposta agora. */
  aiProcessing: boolean;
  /** A IA está ativa mas pulou a última mensagem (limite, horário…). */
  aiWaiting?: boolean;
  funnel: { board?: string; stage?: string } | null;
}

/**
 * Uma única linha sob o nome. Prioridade: digitando > repasse/robô/IA
 * preparando > participantes (sala) > "Funil → Etapa".
 */
export function headerSubtitle(input: HeaderSubtitleInput): HeaderSubtitle | null {
  if (input.typing) {
    return { text: input.isGroup ? "alguém está digitando…" : "digitando…", tone: "typing" };
  }
  if (input.handoffPending) return { text: "A IA pediu ajuda", tone: "attention" };
  if (input.botSuspected && !input.isGroup) return { text: "Parece um robô", tone: "attention" };
  if (input.aiProcessing && !input.isGroup) return { text: "IA preparando resposta…", tone: "ai" };
  if (input.aiWaiting && !input.isGroup) return { text: "IA em espera", tone: "attention" };
  if (input.isGroup) {
    const n = input.participantsCount;
    return { text: n === 1 ? "1 participante" : `${n} participantes`, tone: "muted" };
  }
  const { board, stage } = input.funnel ?? {};
  if (board && stage) return { text: `${board} → ${stage}`, tone: "muted" };
  if (stage) return { text: stage, tone: "muted" };
  return null;
}

export const HEADER_DETAILS_KEY = "hnbcrm.inbox.headerDetails";

/** Preferência do visualizador: faixa de detalhes aberta no celular (padrão: recolhida). */
export function readHeaderDetailsOpen(
  storage: Pick<Storage, "getItem"> | null = typeof window === "undefined" ? null : window.localStorage
): boolean {
  try {
    return storage?.getItem(HEADER_DETAILS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeHeaderDetailsOpen(
  open: boolean,
  storage: Pick<Storage, "setItem"> | null = typeof window === "undefined" ? null : window.localStorage
): void {
  try {
    storage?.setItem(HEADER_DETAILS_KEY, open ? "1" : "0");
  } catch {
    /* localStorage bloqueado: a preferência vale só nesta sessão */
  }
}
