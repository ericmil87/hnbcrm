// Copy e regras puras da falha de entrega de uma mensagem de saída ("Tentar
// novamente"), do aceite de envio a número sem WhatsApp e do marcador do contato.
// O backend manda `deliveryRetry` + `metadata.deliveryErrorKind/numberCheck`
// (convex/lib/messageRetry.ts); aqui só se decide o que mostrar.

import { phoneLookupCandidates } from "../../convex/lib/phone";

/** Espelho de `NOT_ON_WHATSAPP_SEND_PREFIX` (convex/lib/whatsappCheck.ts; o teste confere). */
export const NOT_ON_WHATSAPP_SEND_PREFIX = "NOT_ON_WHATSAPP:";

export function isNotOnWhatsappError(message: string | null | undefined): boolean {
  return !!message && message.includes(NOT_ON_WHATSAPP_SEND_PREFIX);
}

/**
 * O envio foi entregue a um diálogo de confirmação: quem chamou não deve limpar
 * nem avisar erro (ex.: gravador de voz mantém a gravação na prévia).
 */
export class SendDeferredError extends Error {
  constructor() {
    super("send deferred");
    this.name = "SendDeferredError";
  }
}

export interface DeliveryRetryState {
  canRetry: boolean;
  requiresCheck?: boolean;
  requiresDeliveredAck?: boolean;
  numberChecks?: number;
  maxNumberChecks?: number;
  /** ms epoch da próxima tentativa automática (só com `autoRetrying`). */
  autoRetryNextAt?: number;
  /** ms epoch: antes disso uma nova checagem do número é recusada. */
  retryAfter?: number;
  manualRetries: number;
  maxManualRetries: number;
  errorKind?: string;
  autoRetrying: boolean;
}

export interface DeliveryFailureInput {
  deliveryRetry?: DeliveryRetryState | null;
  metadata?: Record<string, any> | null;
}

export interface DeliveryFailureView {
  /** Frase em PT-BR para a bolha. */
  text: string;
  /** Orientação curta (segunda linha), quando há. */
  hint?: string;
  /** Texto técnico original, mostrado só em "Detalhes". */
  raw?: string;
  /** Reenvio automático em curso: sem botão. */
  autoRetrying: boolean;
  /** Mostra "Tentar novamente". */
  showRetry: boolean;
  /** O número é o problema: o botão fica discreto e a orientação é conferir o número. */
  numberProblem: boolean;
  /** Teto de reenvios manuais atingido. */
  exhausted: boolean;
  /** Teto de consultas ao número atingido: sem botão. */
  checksExhausted: boolean;
  /** Em espera: o botão fica desabilitado até este instante (ms epoch). */
  waitUntil?: number;
  /** A mensagem pode já ter chegado: reenviar pede confirmação. */
  requiresDeliveredAck: boolean;
  /** Linha extra (ex.: mensagem de campanha reenvia pela campanha). */
  note?: string;
  /** Instante (ms epoch) em que a leitura muda sozinha (fim da espera ou reenvio automático vencido). */
  nextChangeAt?: number;
}

/** Folga do servidor para o reenvio automático: passou disso, não foi concluído. */
export const AUTO_RETRY_GRACE_MS = 30 * 60 * 1000;

const ACK_HINT = "Confira com o contato ou no aparelho antes de reenviar, para não duplicar.";
const CAMPAIGN_NOTE = "Mensagem de campanha: o reenvio é feito na tela da campanha.";

const checks = new Set(["unavailable", "inconclusive"]);

const KIND_COPY: Record<string, { text: string; hint?: string }> = {
  transient: {
    text: "Instabilidade na conexão com o WhatsApp. A mensagem não foi entregue.",
    hint: "Tente novamente em instantes.",
  },
  rate_limited: {
    text: "Muitos envios em pouco tempo. A mensagem não foi entregue.",
    hint: "Aguarde um pouco e tente novamente.",
  },
  session: {
    text: "O WhatsApp deste canal está desconectado.",
    hint: "Reconecte o canal em Configurações → Canais e tente novamente.",
  },
  permanent: { text: "O WhatsApp não aceitou esta mensagem." },
  ambiguous: {
    text: "Não sabemos se esta mensagem chegou ao cliente.",
    hint: "Confira com o contato ou no aparelho antes de reenviar, para não duplicar.",
  },
};

/** `null` quando não há nada a mostrar (mensagem sem falha nem reenvio automático). */
export function deliveryFailureView(
  input: DeliveryFailureInput,
  failed: boolean,
  now: number = Date.now()
): DeliveryFailureView | null {
  const retry = input.deliveryRetry ?? null;
  const meta = input.metadata ?? {};
  const raw = typeof meta.deliveryError === "string" && meta.deliveryError ? meta.deliveryError : undefined;

  if (retry?.autoRetrying) {
    const staleAt = typeof retry.autoRetryNextAt === "number" ? retry.autoRetryNextAt + AUTO_RETRY_GRACE_MS : undefined;
    const stale = staleAt !== undefined && staleAt <= now;
    const rawAuto = typeof meta.bridgeRetry?.lastError === "string" ? meta.bridgeRetry.lastError : raw;
    return {
      text: stale ? "O reenvio automático não foi concluído." : "Reenviando automaticamente…",
      hint: stale
        ? "Confira com o contato ou no aparelho se a mensagem chegou antes de enviar de novo."
        : "Houve uma instabilidade; o sistema tenta de novo sozinho.",
      raw: rawAuto,
      autoRetrying: !stale,
      showRetry: false,
      numberProblem: false,
      exhausted: false,
      checksExhausted: false,
      requiresDeliveredAck: false,
      ...(staleAt !== undefined && !stale ? { nextChangeAt: staleAt } : {}),
    };
  }
  if (!failed) return null;

  const exhausted = !!retry && !retry.canRetry && retry.manualRetries >= retry.maxManualRetries;
  const kind = (meta.deliveryErrorKind as string | undefined) ?? retry?.errorKind;
  const check = meta.numberCheck as string | undefined;

  let copy: { text: string; hint?: string } | null = null;
  let numberProblem = false;
  let noRetry = false;
  if (check === "opt_out") {
    noRetry = true;
    copy = { text: "Este contato pediu para não receber mensagens.", hint: "Não é possível reenviar." };
  } else if (check === "not_on_whatsapp") {
    numberProblem = true;
    copy = { text: "Este número não está no WhatsApp.", hint: "Confira o número do contato antes de tentar de novo." };
  } else if (check === "inconclusive") {
    // Não afirma que o número não tem WhatsApp: a consulta não provou nada.
    copy = {
      text: "Não foi possível confirmar o número agora.",
      hint: "Isso não quer dizer que ele não tenha WhatsApp. Tente novamente mais tarde.",
    };
  } else if (kind === "recipient_not_found") {
    numberProblem = true;
    copy = {
      text: "O WhatsApp não encontrou este número.",
      hint: "Confira o número do contato. Ao tentar de novo, confirmamos o número antes de reenviar.",
    };
  } else if (check === "unavailable") {
    copy = { text: "Não foi possível confirmar o número agora.", hint: "Tente novamente em instantes." };
  } else if (kind && KIND_COPY[kind]) {
    copy = KIND_COPY[kind];
  }

  const checksExhausted =
    !!retry?.requiresCheck && (retry.numberChecks ?? 0) >= (retry.maxNumberChecks ?? Infinity);
  // Espera entre consultas do número: vale para qualquer falha enquanto `retryAfter` é futuro.
  const waitUntil =
    retry?.canRetry && typeof retry.retryAfter === "number" && retry.retryAfter > now ? retry.retryAfter : undefined;
  const requiresAck = !!retry?.requiresDeliveredAck || kind === "ambiguous";
  const numberRelated =
    numberProblem || checks.has(check ?? "") || kind === "recipient_not_found";
  const fromCampaign = !!meta.campaign;

  const text = copy?.text ?? raw ?? "";
  let hint = copy?.hint;
  if (fromCampaign) {
    // O conselho "tente novamente" não vale aqui: quem reenvia é a campanha (ver `note`).
    hint = undefined;
  } else if (exhausted) {
    hint = numberRelated
      ? "Limite de reenvios atingido. Confira o número do contato ou escreva uma nova mensagem."
      : kind === "session"
        ? "Limite de reenvios atingido. Reconecte o canal em Configurações → Canais e escreva uma nova mensagem."
        : "Limite de reenvios atingido. Escreva uma nova mensagem.";
  } else if (checksExhausted) {
    hint = "Já conferimos este número várias vezes. Confira o número do contato ou escreva uma nova mensagem.";
  } else if (!hint && requiresAck && !noRetry) {
    // Falha sem classe conhecida: o texto cru não diz se chegou; o aviso combina com o diálogo do reenvio.
    hint = ACK_HINT;
  }
  if (!text) return null;
  return {
    text,
    hint,
    // Sem tradução do erro, o texto cru já é a frase: não repete em "Detalhes".
    raw: copy && raw ? raw : undefined,
    autoRetrying: false,
    showRetry: !!retry?.canRetry && !noRetry,
    numberProblem,
    exhausted,
    checksExhausted,
    ...(waitUntil !== undefined ? { waitUntil } : {}),
    requiresDeliveredAck: requiresAck,
    ...(fromCampaign ? { note: CAMPAIGN_NOTE } : {}),
    ...(waitUntil !== undefined ? { nextChangeAt: waitUntil } : {}),
  };
}

export interface ContactWhatsappMarker {
  phone?: string | null;
  whatsappNumber?: string | null;
  whatsappCheck?: { phone: string; status: string } | null;
  whatsappFails?: { phone: string; count: number } | null;
}

/** Falhas "número não encontrado" seguidas a partir das quais o servidor trata como aviso (espelho de `NOT_FOUND_FAILS_BLOCK`). */
export const NOT_FOUND_FAILS_BLOCK = 2;
/** Texto do servidor após o prefixo no caso "não encontrado" (espelho de `NOT_FOUND_SEND_ERROR`; o teste confere). */
export const NOT_FOUND_SEND_ERROR =
  "As últimas mensagens para este número falharam porque o WhatsApp não o encontrou. A mensagem provavelmente não será entregue. Confirme que quer enviar mesmo assim.";

const currentDigits = (c: ContactWhatsappMarker) => (c.whatsappNumber ?? c.phone ?? "").replace(/\D+/g, "");

/** O marcador "sem WhatsApp" vale para QUALQUER grafia BR (9º dígito) do número atual, como no servidor. */
export function isMarkedNotOnWhatsapp(contact: ContactWhatsappMarker | null | undefined): boolean {
  const check = contact?.whatsappCheck;
  if (!contact || !check || check.status !== "not_on_whatsapp") return false;
  const current = currentDigits(contact);
  return current !== "" && phoneLookupCandidates(current).includes(check.phone);
}

/** Falhas "não encontrado" seguidas do número atual (dígitos EXATOS, como no servidor: um `no LID` é daquele JID), 0 se o contador é de outro número. */
export function notFoundFailCount(contact: ContactWhatsappMarker | null | undefined): number {
  const f = contact?.whatsappFails;
  if (!contact || !f) return 0;
  const current = currentDigits(contact);
  return current !== "" && current === f.phone ? f.count : 0;
}

/**
 * Aviso de número no contato: `not_on_whatsapp` (o WhatsApp disse que não há conta)
 * ou `not_found` (as últimas tentativas não o encontraram; não afirma que não há conta).
 */
export function numberWarningOf(contact: ContactWhatsappMarker | null | undefined): "not_on_whatsapp" | "not_found" | null {
  if (isMarkedNotOnWhatsapp(contact)) return "not_on_whatsapp";
  return notFoundFailCount(contact) >= NOT_FOUND_FAILS_BLOCK ? "not_found" : null;
}

export const NOT_ON_WHATSAPP_ACK = {
  title: "Este número não tem WhatsApp",
  description:
    "O WhatsApp informou que este número não tem conta. Insistir em enviar pode prejudicar a reputação do número que envia. Envie só se tiver certeza de que o número está certo.",
  confirmLabel: "Enviar mesmo assim",
  cancelLabel: "Cancelar",
};

/** Corpo do diálogo escolhido pelo texto que o servidor manda após o prefixo `NOT_ON_WHATSAPP:`. */
export function notOnWhatsappAckCopy(serverError: string | null | undefined) {
  const at = serverError?.indexOf(NOT_ON_WHATSAPP_SEND_PREFIX) ?? -1;
  const after = at >= 0 ? serverError!.slice(at + NOT_ON_WHATSAPP_SEND_PREFIX.length).trim() : "";
  if (after === NOT_FOUND_SEND_ERROR) {
    return {
      ...NOT_ON_WHATSAPP_ACK,
      title: "O WhatsApp não encontrou este número",
      description:
        "As últimas mensagens para este número falharam porque o WhatsApp não o encontrou. Insistir em enviar pode prejudicar a reputação do número que envia. Envie só se tiver certeza de que o número está certo.",
    };
  }
  return NOT_ON_WHATSAPP_ACK;
}

/**
 * O aviso de número só vale para WhatsApp pelo bridge (como `conversationIsBridge`
 * no servidor: canal whatsapp e transporte exatamente "bridge"; transporte ausente
 * não conta). Meta, Instagram e Messenger do mesmo contato não são afetados.
 */
export function isBridgeWhatsapp(channel: string | null | undefined, transport: string | null | undefined): boolean {
  return channel === "whatsapp" && transport === "bridge";
}

export const NOT_FOUND_BADGE = {
  label: "Número não encontrado",
  explanation:
    "O WhatsApp não encontrou este número nas últimas tentativas de envio pelo número de WhatsApp conectado. O aviso some quando o número é corrigido, quando uma mensagem é entregue ou quando o contato escreve para você.",
};

export const NOT_ON_WHATSAPP_BADGE = {
  label: "Sem WhatsApp",
  explanation:
    "O WhatsApp informou que este número não tem conta (vale para envios pelo número de WhatsApp conectado). O aviso some quando o número é corrigido ou quando o contato escreve para você.",
};

export const MAYBE_DELIVERED_ACK = {
  title: "Esta mensagem pode já ter sido entregue",
  description:
    "O envio falhou sem confirmação do WhatsApp, então a mensagem pode ter chegado ao cliente. Reenviar pode duplicá-la. Confira com o contato ou no aparelho antes de reenviar.",
  confirmLabel: "Reenviar mesmo assim",
  cancelLabel: "Cancelar",
};

/** Texto "pode tentar de novo às HH:MM" do botão em espera. */
export function retryWaitText(clock: string): string {
  return `Conferimos o número há pouco. Você poderá tentar de novo às ${clock}.`;
}

/** Texto do toast de sucesso do reenvio manual. */
export function retrySuccessText(correctedNumber: boolean): string {
  return correctedNumber ? "Número corrigido e mensagem reenviada" : "Mensagem reenviada";
}
