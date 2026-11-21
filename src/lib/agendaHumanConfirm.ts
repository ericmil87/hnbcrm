/**
 * Agenda v2 (C1): textos e regras PURAS das sugestões que o sistema faz a partir de uma confirmação de horário escrita
 * pelo humano no WhatsApp (fila de pendências) e do "Desfazer" do que foi marcado/aprovado por ela. O servidor é a
 * barreira (permissão, janela, regras); aqui só se decide o que mostrar.
 */
import { UNDO_HUMAN_CONFIRM_WINDOW_MIN } from "../../convex/lib/schedConstants";
import { formatLocalDateLabel } from "../../convex/lib/schedTime";

export interface SuggestionLike {
  act: string;
  reason?: string;
  parsed: { localDate?: string; timeMin?: number };
  appointmentId?: string;
}

/** "qui, 27/11 às 10:00" (dia e/ou hora que existirem; vazio = não se sabe). */
export function parsedWhenLabel(parsed: { localDate?: string; timeMin?: number }): string {
  const day = parsed.localDate && /^\d{4}-\d{2}-\d{2}$/.test(parsed.localDate) ? formatLocalDateLabel(parsed.localDate).slice(0, -5) : "";
  const time =
    parsed.timeMin !== undefined && Number.isInteger(parsed.timeMin)
      ? `${String(Math.floor(parsed.timeMin / 60)).padStart(2, "0")}:${String(parsed.timeMin % 60).padStart(2, "0")}`
      : "";
  if (day && time) return `${day} às ${time}`;
  return day || (time ? `às ${time}` : "");
}

export type SuggestionKind = "marcar" | "remarcar" | "cancelar" | "aprovar" | "substituir" | "corrigir";

export function suggestionKind(s: SuggestionLike): SuggestionKind {
  if (s.reason === "aprovar_pendente") return "aprovar";
  if (s.reason === "substituir_pendente") return "substituir";
  if (s.reason === "correcao") return "corrigir";
  if (s.act === "remarcou") return "remarcar";
  if (s.act === "cancelou") return "cancelar";
  return "marcar";
}

export const SUGGESTION_COPY = {
  headline: {
    marcar: "Parece uma confirmação de horário",
    remarcar: "Parece que você remarcou um horário",
    cancelar: "Parece que você cancelou um horário",
    aprovar: "Parece que você confirmou o pedido",
    substituir: "O cliente já tem um pedido: substituir?",
    corrigir: "Parece que você corrigiu o horário",
  } satisfies Record<SuggestionKind, string>,
  accept: {
    marcar: "Marcar",
    remarcar: "Remarcar",
    cancelar: "Cancelar horário",
    aprovar: "Aprovar",
    substituir: "Substituir",
    corrigir: "Remarcar",
  } satisfies Record<SuggestionKind, string>,
  dismiss: "Dispensar",
  needsWhen: "Faltam dia ou hora: abra a conversa e marque pela Agenda.",
  toast: { accepted: "Feito", dismissed: "Sugestão dispensada", failed: "Não foi possível aplicar a sugestão." },
  /** Por que o sistema não marcou sozinho (código curto do servidor). */
  reasons: {
    modo_sugerir: "O sistema só sugere (padrão da agenda).",
    sem_ia: "A IA está desligada, então o sistema só sugere.",
    resposta_curta: "Resposta curta: o horário vem da proposta do cliente.",
    sem_dia_ou_hora: "A mensagem não tem dia e hora completos.",
    leitura_incompleta: "A mensagem tem mais do que uma confirmação simples.",
    sem_proposta: "Não achei o cliente pedindo esse horário.",
    sem_proposta_coincidente: "O cliente tinha pedido outro dia ou hora.",
    proposta_sem_intencao: "Não ficou claro que o cliente pediu esse horário para ele.",
    servico_nao_definido: "Escolha o serviço.",
    servico_ambiguo: "Mais de um serviço citado: escolha o serviço.",
    data_distante: "Data muito distante.",
    horario_passado: "O horário já passou.",
    ato_nao_automatico: "Remarcar e cancelar nunca são automáticos.",
    aprovar_pendente: "Há um pedido do cliente aguardando aprovação.",
    substituir_pendente: "O cliente já tinha pedido outro horário.",
    correcao: "Você corrigiu o que tinha confirmado há pouco.",
    ia_indisponivel: "A leitura da IA falhou.",
    ia_resposta_invalida: "A leitura da IA não foi confiável.",
    ia_evidencia_invalida: "A leitura da IA não foi confiável.",
    ia_divergente: "A IA leu outro dia ou hora.",
    erro_ao_marcar: "Não foi possível marcar sozinho.",
    nao_foi_possivel_aprovar: "Não foi possível aprovar sozinho.",
  } as Record<string, string>,
  regra: "O horário tem um aviso de regra: confira antes de marcar.",
};

export function suggestionReasonText(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  if (reason.startsWith("regra:")) return SUGGESTION_COPY.regra;
  return SUGGESTION_COPY.reasons[reason];
}

/** Marcar/aprovar/substituir precisam de dia e hora; cancelar não. */
export function suggestionCanAccept(s: SuggestionLike): boolean {
  const kind = suggestionKind(s);
  if (kind === "cancelar") return true;
  return s.parsed.localDate !== undefined && s.parsed.timeMin !== undefined;
}

export interface UndoCandidate {
  origin: string;
  status: string;
  createdAt: number;
  approvedAt?: number;
  clientConfirmedAt?: number;
  statusActors?: ReadonlyArray<{ status: string; at: number; actorName?: string; undo?: boolean }>;
}

/**
 * "Desfazer" do que o sistema fez a partir da confirmação: `created` (origem `human_message`, ainda `scheduled` e sem mudança)
 * ou `approved` (pedido da IA/link aprovado pelo sistema: `scheduled` sem membro na auditoria). Janela de 24 h. O servidor decide.
 */
export function humanConfirmUndoKind(a: UndoCandidate, now: number): "created" | "approved" | null {
  const windowMs = UNDO_HUMAN_CONFIRM_WINDOW_MIN * 60_000;
  if (a.status !== "scheduled" || a.clientConfirmedAt !== undefined) return null;
  if (a.origin === "human_message") {
    return a.approvedAt === undefined && now - a.createdAt <= windowMs ? "created" : null;
  }
  if (a.approvedAt === undefined || now - a.approvedAt > windowMs) return null;
  const approval = a.statusActors?.filter((x) => x.status === "scheduled" && !x.undo).at(-1);
  return approval && approval.actorName === undefined ? "approved" : null;
}

export const HUMAN_UNDO_COPY = {
  created: { button: "Desfazer (veio de uma confirmação no WhatsApp)", hint: "O sistema marcou este horário a partir de uma confirmação no WhatsApp. Se não era isso, desfaça: nada é enviado ao cliente." },
  approved: { button: "Desfazer a aprovação", hint: "O sistema aprovou este pedido a partir de uma confirmação no WhatsApp. Se não era isso, desfaça: ele volta a aguardar aprovação." },
  toastDone: "Desfeito",
  toastFailed: "Não foi possível desfazer.",
};
