/**
 * Agenda v2 (D2) — texto seguro do guard de agenda, conforme a INTENÇÃO (puro).
 *
 * Quando o guard barra a resposta duas vezes, sai um texto fixo e abre-se um repasse. Antes era uma frase só ("Vou confirmar os
 * horários com a equipe"); ela era errada para quem pediu para remarcar, tinha pedido pendente ou queria marcar em grupo, e o
 * repasse não dizia o que o cliente queria. Agora o texto é verdadeiro para o caso e o motivo do repasse traz a intenção (um rótulo;
 * nunca o texto do cliente, nenhum dado pessoal).
 *
 * Os textos só afirmam o que o sistema garante: o repasse É criado logo depois ("já avisei a equipe"), e "pedido registrado" só
 * sai quando há pedido pendente conhecido (agendamento aguardando a equipe, existente ou criado no turno).
 */
import { type ClaimViolation, SCHED_SAFE_TEXT } from "./schedClaimGuard";
import { asksPedidoStatus, type CustomerIntent, detectCustomerIntent } from "./schedIntent";

export type SafeReply = {
  text: string;
  /** `reason` do repasse (curto, sem dado do cliente). */
  reason: string;
  summary: string;
  /** Rótulo da situação, para log. */
  situation: "remarcar" | "cancelar" | "presenca" | "grupo" | "profissional" | "pedido_pendente" | "verificar" | "situacao";
  /** `false` = o texto já responde com o estado real e a equipe não precisa ser chamada (padrão: abre repasse). */
  handoff?: boolean;
};

/** O que o SERVIDOR sabe do cliente (rótulos "segunda-feira, 23/11, às 15:00"): o texto seguro de situação só diz isto. */
export type SafeFacts = { scheduled: string[]; pending: string[]; declined: string[]; expired: string[]; cancelled: string[] };

const asLabels = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} e ${xs[xs.length - 1]}`);

/**
 * Resposta de SITUAÇÃO montada só com o estado (nunca esconde o que o cliente perguntou): marcado diz o horário, pendente diz que aguarda,
 * recusado/vencido/cancelado dizem que não foi possível e que dá para consultar outros horários. `null` = nada a dizer.
 */
export function statusReplyText(f: SafeFacts): string | null {
  const parts: string[] = [];
  if (f.scheduled.length > 0) parts.push(`Seu horário está marcado para ${asLabels(f.scheduled.slice(0, 2))}.`);
  if (f.pending.length > 0) parts.push(`Seu pedido para ${asLabels(f.pending.slice(0, 2))} está registrado e aguarda a confirmação da equipe.`);
  if (parts.length === 0) {
    if (f.declined.length > 0) parts.push(`Não foi possível confirmar o horário de ${asLabels(f.declined.slice(0, 2))}: a equipe não conseguiu aprovar esse pedido. Posso consultar outros horários para você.`);
    else if (f.expired.length > 0) parts.push(`O pedido para ${asLabels(f.expired.slice(0, 2))} venceu sem resposta da equipe e não foi marcado. Posso consultar outros horários para você.`);
    else if (f.cancelled.length > 0) parts.push(`O horário de ${asLabels(f.cancelled.slice(0, 2))} foi cancelado. Se quiser, posso consultar outros horários para você.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

const TEAM_ACTION = "Conferir a agenda e responder o cliente";

export function schedSafeReply(input: {
  kind: ClaimViolation["kind"] | string;
  /** O que o cliente escreveu neste turno (só para detectar a intenção; não vai ao repasse). */
  customerText: string;
  /** Há pedido aguardando a equipe (existente ou registrado neste turno). */
  pendingRequest: boolean;
  /** O contato tem agendamento ativo (existente ou criado no turno). Remarcar, cancelar e presença só fazem sentido com ele. */
  hasUpcoming: boolean;
  /** Estado do cliente conhecido pelo servidor (marcado, pendente, recusado, vencido, cancelado). */
  facts?: SafeFacts;
}): SafeReply {
  const detected: CustomerIntent | null = detectCustomerIntent(input.customerText);
  // Sem agendamento não há o que remarcar/cancelar/confirmar: o cliente quer marcar (texto padrão), não "cancelamento fica com a equipe".
  const intent: CustomerIntent | null = !input.hasUpcoming && (detected === "remarcar" || detected === "cancelar" || detected === "presenca") ? "marcar" : detected;
  if (intent === "remarcar") {
    return {
      text: "Remarcar fica com a nossa equipe: já avisei eles e te respondem por aqui.",
      reason: "Cliente quer remarcar um horário (resposta da IA barrada pelo guard)",
      summary: "O cliente pediu para remarcar um horário. A IA tentou responder de um jeito que afirmava a mudança, e enviei um aviso padrão de que a equipe cuida. A equipe precisa remarcar e responder.",
      situation: "remarcar",
    };
  }
  if (intent === "cancelar") {
    return {
      text: "O cancelamento fica com a nossa equipe: já avisei eles e te respondem por aqui.",
      reason: "Cliente quer cancelar um horário (resposta da IA barrada pelo guard)",
      summary: "O cliente pediu para cancelar ou avisou que não vai comparecer. A IA tentou responder de um jeito que afirmava o cancelamento, e enviei um aviso padrão de que a equipe cuida. A equipe precisa tratar o horário e responder.",
      situation: "cancelar",
    };
  }
  if (intent === "presenca") {
    return {
      text: "Recebi a sua mensagem e já avisei a equipe, que confirma por aqui.",
      reason: "Cliente confirmou presença (resposta da IA barrada pelo guard)",
      summary: "O cliente confirmou presença. A IA não registra presença e tentou afirmar que anotou; enviei um aviso padrão. A equipe precisa registrar a confirmação e responder.",
      situation: "presenca",
    };
  }
  if (intent === "grupo") {
    return {
      text: "Para mais de uma pessoa a equipe confirma o horário com você: já avisei eles e te respondem por aqui.",
      reason: "Cliente quer marcar para mais de uma pessoa (resposta da IA barrada pelo guard)",
      summary: "O cliente quer um horário para mais de uma pessoa. A IA tentou afirmar um registro que não existe, e enviei um aviso padrão. A equipe precisa marcar o grupo.",
      situation: "grupo",
    };
  }
  if (input.kind === "resource_not_offered") {
    return {
      text: "Quem atende a equipe confirma com você: já avisei eles e te respondem por aqui.",
      reason: "Cliente quer um profissional específico (resposta da IA barrada pelo guard)",
      summary: "O cliente pediu um profissional. A IA tentou prometer o horário com ele sem que o sistema confirmasse, e enviei um aviso padrão. A equipe precisa confirmar quem atende.",
      situation: "profissional",
    };
  }
  // "E aí, confirmou?" / "Que dia é o meu horário?": o texto seguro diz a situação REAL (nunca esconde a informação pedida). Vem DEPOIS de remarcar,
  // cancelar, presença, grupo e profissional (a equipe cuida desses) e só dispensa o repasse quando a pergunta era de fato sobre a situação.
  const asked = !!input.facts && asksPedidoStatus(input.customerText);
  if (input.facts && (asked || input.kind === "stale_pending")) {
    const text = statusReplyText(input.facts);
    if (text) {
      return {
        text,
        reason: asked ? "Cliente perguntou da situação do pedido (resposta da IA barrada pelo guard)" : "Resposta da IA dizia que o pedido aguardava, mas a situação já mudou (barrada pelo guard)",
        summary: asked
          ? "O cliente perguntou como ficou o pedido de horário. A resposta da IA foi barrada pelo guard e enviei a situação real que o sistema tem. Nenhuma ação é necessária."
          : "A IA tentou dizer que o pedido ainda aguardava a equipe, mas a situação já tinha mudado. Enviei a situação real; a equipe pode conferir a conversa.",
        situation: "situacao",
        ...(asked ? { handoff: false } : {}),
      };
    }
  }
  if (input.pendingRequest) {
    return {
      text: "Seu pedido já está registrado e aguarda a confirmação da equipe, que te responde por aqui.",
      reason: "Cliente com pedido aguardando a equipe (resposta da IA barrada pelo guard)",
      summary: "O cliente tem um pedido de horário aguardando a equipe. A IA tentou responder de um jeito que afirmava mais do que o sistema registrou, e enviei um aviso padrão. A equipe precisa conferir o pedido e responder.",
      situation: "pedido_pendente",
    };
  }
  return {
    text: SCHED_SAFE_TEXT,
    reason: "Cliente quer marcar horário (resposta da IA barrada pelo guard de agenda)",
    summary: `O cliente quer marcar um horário. A IA tentou afirmar ou citar um horário sem reserva correspondente; enviei um aviso padrão. ${TEAM_ACTION} sobre o horário.`,
    situation: "verificar",
  };
}
