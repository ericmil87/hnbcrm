/**
 * Follow-up que o próprio Atendente IA executa (v0.60) — textos e helpers
 * compartilhados pelas telas que tocam `aiFollowUps`: editor do atendente
 * (Configurações → IA), detalhe da tarefa, inbox e notificações.
 *
 * A maior parte do que o backend devolve em `followUp.reason`
 * (`api.attendantFollowUp.getForTask`/`listForConversation`) e no retorno de
 * `adoptTask` já chega como uma FRASE pronta em PT-BR — o servidor monta o
 * texto antes de gravar (ver `convex/lib/followUpOps.ts` → `resolveFollowUpOutcome`,
 * que sempre recebe um `reason` literal ou já passado por
 * `describeFollowUpReason`). Mas `runNow` devolve o CÓDIGO BRUTO da cadeia de
 * guardas (`convex/attendantFollowUp.ts` → `fireCore`/`FireResult`) sempre que
 * ele não é um dos poucos reconhecidos por `describeFollowUpReason` — a função
 * do servidor tem `default: return reason` para código desconhecido (ex.
 * "opt_out", "fora_da_janela", "remarcado"), então esses escapam crus.
 *
 * `humanizeFollowUpReason` cobre os dois casos: traduz o código quando
 * reconhece, e devolve o texto como veio quando já é humano (nenhuma entrada
 * do mapa bate com uma frase cheia de espaço/maiúscula).
 */

export type FollowUpStatus =
  | "scheduled"
  | "queued"
  | "drafted"
  | "done"
  | "not_needed"
  | "needs_human"
  | "canceled";

export const FOLLOW_UP_STATUS_LABELS: Record<FollowUpStatus, string> = {
  scheduled: "Agendado",
  queued: "Na fila",
  drafted: "Rascunho pronto",
  done: "Executado",
  not_needed: "Não foi necessário",
  needs_human: "Precisa de você",
  canceled: "Cancelado",
};

/**
 * Todo código bruto que já foi visto saindo da cadeia de guardas do
 * follow-up — levantado em `convex/attendant.ts` (`evaluateEligibility`,
 * `internalProcessQueueItem`), `convex/attendantFollowUp.ts` (`fireCore`,
 * `deferOrEscalate`, `adoptTaskCore`) e `convex/lib/followUpOps.ts`
 * (`describeFollowUpReason`, `RESCHEDULE_REASONS`, `CANCEL_REASONS`).
 */
export const FOLLOW_UP_REASON_LABELS: Record<string, string> = {
  // Elegibilidade do atendente (evaluateEligibility)
  conversa_de_grupo: "a conversa é de um grupo",
  ia_desativada: "a IA está desativada",
  atendente_desativado: "o atendente está desativado",
  sem_atendente: "não há atendente IA ativo para este canal",
  ia_pausada: "a conversa está com um humano",
  handoff_pendente: "há um repasse em aberto",
  lead_de_humano: "o lead passou a ser de um humano",
  opt_out: "o contato pediu para não receber mensagens",
  fora_do_horario: "fora do horário de atendimento",
  teto_conversa: "o teto de respostas desta conversa foi atingido",
  teto_hora: "o teto de respostas por hora foi atingido",
  bridge_sem_aceite: "o canal não tem o aceite de risco do WhatsApp não oficial",
  janela_24h: "a janela de 24h do WhatsApp está fechada",

  // Fila / turno do atendente
  nao_pendente: "o item já não estava mais pendente",
  conversa_removida: "a conversa não existe mais",
  follow_up_resolvido: "o follow-up já tinha sido resolvido",
  rascunho_ja_revisado: "o rascunho já tinha sido revisado",
  aguardando_transcricao: "aguardando a transcrição de um áudio",
  budget_mensal: "o limite mensal de conversas foi atingido",
  lock_perdido: "outro turno assumiu a conversa",
  humano_respondeu: "um humano respondeu na conversa",
  cliente_falou: "o cliente escreveu antes da hora do follow-up",
  falha_tecnica: "falha técnica na geração da resposta",
  falha_envio: "o WhatsApp recusou o envio",

  // Cadeia de guardas específica do follow-up (fireCore)
  teto_diario: "o teto diário de follow-ups deste número foi atingido",
  cadeia_maxima: "o cliente não respondeu aos follow-ups anteriores",
  bridge_offline: "o número do WhatsApp está desconectado",
  fila_ocupada: "a conversa ficou ocupada com o atendimento normal",
  fora_da_janela: "fora da janela de envio configurada",
  modo_desligado: "a execução automática de follow-ups está desligada",
  modelo_sem_resposta: "a IA não produziu nem mensagem nem decisão",
  remarcado: "o prazo foi alterado enquanto o follow-up esperava",
  adiada_pela_equipe: "a tarefa foi adiada pela equipe (lembrete)",
  nao_agendado: "o follow-up não está mais agendado",
  tarefa_excluida: "a tarefa foi excluída",
  tarefa_concluida: "a tarefa já estava concluída",
  tarefa_cancelada: "a tarefa foi cancelada",
  tarefa_nao_pendente: "a tarefa não está mais pendente",
  tarefa_de_outro: "a tarefa passou a ser de outro responsável",
  tarefa_sem_prazo: "a tarefa ficou sem prazo",
  conversa_arquivada: "a conversa foi arquivada",
  conversa_sem_mensagens: "a conversa ainda não tem mensagens",
  lead_arquivado: "o lead foi arquivado",
  lead_excluido: "o lead foi excluído",
  humano_assumiu: "alguém do time assumiu a conversa",
  disparo_antecipado: "ainda não chegou a hora marcada",
  envio_sem_confirmacao: "a mensagem saiu, mas o WhatsApp não confirmou a entrega",
  follow_up_ja_enviado: "este follow-up já tinha sido enviado",
  follow_up_inexistente: "follow-up não encontrado",
};

/**
 * Traduz um motivo cru vindo do backend, quando ele bate com um código
 * conhecido. Quando não bate — porque já é uma frase pronta em PT-BR, ou é um
 * código novo que este mapa ainda não conhece — devolve o texto como veio, em
 * vez de esconder a informação.
 */
export function humanizeFollowUpReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;
  const trimmed = reason.trim();
  if (!trimmed) return null;
  return FOLLOW_UP_REASON_LABELS[trimmed] ?? trimmed;
}

/** Tom do `Badge` (`src/components/ui/Badge.tsx`) para o selo compacto do status. */
export type FollowUpBadgeTone = "default" | "brand" | "success" | "error" | "warning" | "info";

export function followUpBadgeTone(status: FollowUpStatus): FollowUpBadgeTone {
  switch (status) {
    case "scheduled":
    case "queued":
      return "brand";
    case "drafted":
      return "info";
    case "done":
      return "success";
    case "needs_human":
      return "warning";
    case "not_needed":
    case "canceled":
    default:
      return "default";
  }
}

const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * "amanhã 09:00" / "sáb 20/09 09:00" / "hoje 16:27" — hora local do
 * navegador (é o fuso de quem está lendo a tela, não o do atendente; o
 * backend já resolve o fuso certo ao decidir QUANDO disparar).
 */
export function formatFollowUpDueAt(epochMs: number, now: number = Date.now()): string {
  const target = new Date(epochMs);
  const today = new Date(now);
  const time = target.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  if (sameLocalDay(target, today)) return `hoje ${time}`;

  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  if (sameLocalDay(target, tomorrow)) return `amanhã ${time}`;

  const weekday = WEEKDAY_SHORT[target.getDay()];
  const dd = String(target.getDate()).padStart(2, "0");
  const mm = String(target.getMonth() + 1).padStart(2, "0");
  return `${weekday} ${dd}/${mm} ${time}`;
}

/**
 * Manchete de 1 linha para o card "Follow-up da IA" no detalhe da tarefa e
 * para o chip do inbox. Só texto — o motivo (`needs_human`) e a nota da IA
 * entram à parte, porque a tela decide se quebra linha, link, cor etc.
 */
export function followUpHeadline(
  status: FollowUpStatus,
  dueAt: number,
  now: number = Date.now()
): string {
  switch (status) {
    case "scheduled":
      return `A IA executa em ${formatFollowUpDueAt(dueAt, now)}`;
    case "queued":
      return "Na fila agora";
    case "drafted":
      return "Rascunho aguardando sua revisão";
    case "done":
      return "Executado pela IA";
    case "not_needed":
      return "Não foi necessário";
    case "needs_human":
      return "Precisa de você";
    case "canceled":
      return "Execução automática cancelada";
    default:
      return "Follow-up da IA";
  }
}
