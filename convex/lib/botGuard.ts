/**
 * Guardrail anti-bot do atendente IA (v0.65) — núcleo PURO (sem ctx).
 *
 * Caso real que originou tudo (org Aos Filhos da Terra, Guardião): o número
 * oficial do suporte do WhatsApp mandava "Este atendimento foi encerrado…", o
 * atendente respondia, o suporte devolvia NO MESMO MINUTO "thanks for contacting
 * WhatsApp Support. Your ticket number is …", o atendente respondia de novo — e
 * o ciclo se repetiu em 15/09, 23/09 e 01/10. Dois agentes conversando para
 * sempre é o risco geral (do outro lado pode estar outro assistente de IA).
 *
 * Regra do produto: "tudo bem umas mensagens até entender que é bot; aí vai para
 * repasse e o lead ganha uma etiqueta". Por isso a heurística SOMA sinais fracos
 * ao longo da conversa e só dispara no limiar — uma frase suspeita sozinha
 * nunca para o atendimento. Quem decide o que fazer é a camada de mutation
 * (`applyBotSuspicion` em convex/attendant.ts); aqui só se mede.
 *
 * Ligado por PADRÃO: `agentProfile.botGuard` ausente = ligado; só
 * `enabled:false` desliga (mesma semântica de `includeCurrentDateTime`).
 */

export const DEFAULT_BOT_TAG = "bot-suspeito";
/** Pontuação a partir da qual a conversa é tratada como robô do outro lado. */
export const BOT_SUSPICION_THRESHOLD = 4;
/** Quantas mensagens recentes a heurística olha (o caller carrega esse tanto). */
export const BOT_GUARD_HISTORY = 40;
/** Teto de caracteres da etiqueta (tags são separadas por vírgula na UI). */
export const BOT_TAG_MAX_CHARS = 40;

// ATENÇÃO à medida: o `createdAt` do outbound é o instante da GRAVAÇÃO, não do
// envio — o dispatch do bridge adiciona pacing por número (4–10 s) + typing
// humanizado antes de a mensagem sair do aparelho, e `messages` não guarda a
// hora real do envio. Um robô que responde em 1 s aparece aqui com 6–15 s de
// atraso, por isso a janela é de 20 s (e não 5 s), compensada pelo mínimo de
// caracteres: ler a nossa mensagem E digitar 40+ caracteres em 20 s é raro
// para um humano, e de qualquer forma o sinal vale só +1.
const INSTANT_REPLY_MS = 20_000;
const LONG_FAST_REPLY_MS = 60_000;
const LONG_FAST_MIN_CHARS = 250;
// Abaixo disto o texto repetido NÃO conta: "ok", "sim", "obrigado" se repetem
// numa conversa humana normal o tempo todo.
const REPEAT_MIN_NORMALIZED_CHARS = 12;
// Resposta instantânea só conta com algum conteúdo: um humano responde "ok" ou
// "sim, pode ser" em segundos sem problema; uma frase inteira, não.
const INSTANT_MIN_CHARS = 40;
const MAX_SIGNALS = 20;
// Teto de pontos de `frase_automatica` por avaliação: frase fraca SOZINHA nunca
// alcança o limiar (4) — numa conversa longa sobre IA/chatbot, quatro menções
// em 30 mensagens dispariam. Precisa de um sinal de COMPORTAMENTO junto
// (repetição, instantânea, longa_e_rapida ou auto-apresentação).
const MAX_PHRASE_POINTS = 2;

/**
 * Frases de sistema automático (+1 por mensagem que contenha qualquer uma).
 * Comparadas contra o texto em minúsculas e SEM acento (`normalizeForPhrases`),
 * por isso escritas assim. Sinal FRACO de propósito: um humano pode citar
 * "assistente virtual" ou "inteligência artificial" numa pergunta — só a soma
 * com outros sinais dispara.
 */
export const AUTOMATED_PHRASES: readonly string[] = [
  // Encerramento/ticket de central de atendimento (caso WhatsApp Support)
  "atendimento foi encerrado",
  "atendimento encerrado",
  "fale conosco novamente",
  "ticket number",
  "thanks for contacting",
  "thank you for contacting",
  "we'll respond as soon as possible",
  "we will respond as soon as possible",
  // Formas INEQUÍVOCAS de protocolo: "protocolo n" casava "o protocolo não
  // chegou" (cliente humano) — review de 02/10/2026.
  "numero do seu protocolo",
  "anote o protocolo",
  "protocolo de atendimento",
  // Auto-resposta declarada
  "mensagem automatica",
  "resposta automatica",
  "mensaje automatico",
  "respuesta automatica",
  "automatic reply",
  "automated message",
  "auto-reply",
  "auto reply",
  "out of office",
  "nao responda esta mensagem",
  "nao responda a esta mensagem",
  "no responda este mensaje",
  "do not reply",
  "this number is not monitored",
  "este numero nao e monitorado",
  "este e um canal automatico",
  "fora do nosso horario de atendimento",
  "obrigado por entrar em contato",
  "agradecemos o seu contato",
  "agradecemos seu contato",
  "agradecemos o contato",
  "retornaremos em breve",
  "responderemos em breve",
  // Menu de URA/chatbot respondendo ao nosso texto
  "opcao invalida",
  "opcion invalida",
  "invalid option",
  "digite o numero da opcao",
  // Assistente virtual (genérico — a auto-apresentação em 1ª pessoa pesa mais)
  "assistente virtual",
  "assistente digital",
  "inteligencia artificial",
  "virtual assistant",
  "chatbot",
  // Boletim/propaganda em massa ("resgate agora", "reaja com"): FORA de
  // propósito — o caso real (canal do Gemini) morre no parser
  // (`@newsletter`), e as duas frases são vocabulário comum de gente.
];

/**
 * Auto-apresentação de assistente em 1ª PESSOA (+2). Separada da lista acima
 * porque "sou um assistente virtual" é o outro lado DIZENDO que é robô — já
 * "você é um chatbot?" é um humano perguntando, e não pode pesar o mesmo.
 */
export const BOT_SELF_INTRO_PHRASES: readonly string[] = [
  "sou um assistente virtual",
  "sou uma assistente virtual",
  "sou o assistente virtual",
  "sou a assistente virtual",
  "sou um assistente digital",
  "sou uma assistente digital",
  "sou uma ia",
  "sou uma inteligencia artificial",
  "sou um robo",
  "sou um chatbot",
  "soy un asistente virtual",
  "soy una asistente virtual",
  "i'm an ai",
  "i am an ai",
  "i'm a virtual assistant",
  "i am a virtual assistant",
  "i'm a chatbot",
  "i am a chatbot",
];

export type BotGuardSettings = { enabled: boolean; tag: string };

/** Fonte ÚNICA da config efetiva (backend e UI). Ausente = ligado. */
export function resolveBotGuardSettings(
  profile: { botGuard?: { enabled?: boolean; tag?: string } } | null | undefined
): BotGuardSettings {
  const guard = profile?.botGuard;
  const tag = guard?.tag?.trim();
  return {
    enabled: guard?.enabled !== false,
    tag: tag && tag.length > 0 ? tag : DEFAULT_BOT_TAG,
  };
}

/** Valida a etiqueta vinda da UI/ops: trim, 1–40 caracteres, sem vírgula. */
export function validateBotGuardTag(raw: string): { ok: true; tag: string } | { ok: false; error: string } {
  const tag = raw.trim();
  if (tag.length === 0) return { ok: false, error: "A etiqueta não pode ficar vazia" };
  if (tag.length > BOT_TAG_MAX_CHARS) {
    return { ok: false, error: `A etiqueta tem no máximo ${BOT_TAG_MAX_CHARS} caracteres` };
  }
  if (tag.includes(",")) return { ok: false, error: "A etiqueta não pode conter vírgula" };
  return { ok: true, tag };
}

function stripAccents(text: string): string {
  // NFKD também decompõe "nº" → "no" e o "ﬁ" de fontes estranhas.
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/** Minúsculas, sem acento, apóstrofo tipográfico unificado — para casar frases. */
export function normalizeForPhrases(text: string): string {
  return stripAccents(text.toLowerCase())
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, " ");
}

/**
 * Forma canônica para detectar texto REPETIDO: minúsculas, sem acento, sem
 * dígitos (o número do ticket muda a cada rodada), sem emoji/pontuação, espaços
 * colapsados.
 */
export function normalizeForRepeat(text: string): string {
  return stripAccents(text.toLowerCase())
    .replace(/[0-9]/g, " ")
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsAutomatedPhrase(text: string): boolean {
  const n = normalizeForPhrases(text);
  return AUTOMATED_PHRASES.some((p) => n.includes(p));
}

export function containsBotSelfIntro(text: string): boolean {
  const n = normalizeForPhrases(text);
  return BOT_SELF_INTRO_PHRASES.some((p) => n.includes(p));
}

export type BotGuardMessage = {
  direction: "inbound" | "outbound" | "internal" | string;
  senderType?: string;
  content: string;
  createdAt: number;
  isInternal?: boolean;
};

export type BotSignal =
  | "frase_automatica"
  | "texto_repetido"
  | "resposta_instantanea"
  | "longa_e_rapida"
  | "auto_apresentacao_de_bot";

const SIGNAL_POINTS: Record<BotSignal, number> = {
  frase_automatica: 1,
  texto_repetido: 2,
  resposta_instantanea: 1,
  longa_e_rapida: 2,
  auto_apresentacao_de_bot: 2,
};

/**
 * Soma os sinais de robô do outro lado no histórico recente.
 *
 * `messages` em ordem CRONOLÓGICA. Ignora notas internas e tudo antes de
 * `sinceAt` (= `botSuspicion.clearedAt`: quando um humano diz "é pessoa", os
 * contadores zeram ali — senão a mesma rodada re-dispararia na hora).
 *
 * FRONTEIRA DE EPISÓDIO: só conta o que vem DEPOIS do último outbound HUMANO
 * (não interno). Um humano da equipe falando na conversa abre um episódio
 * novo — o que veio antes era outra fase do atendimento.
 *
 * `signals` sai com uma entrada por OCORRÊNCIA (cap 20), na ordem em que
 * apareceram — `describeBotSignals` agrupa para exibir.
 */
export function evaluateBotSignals(input: {
  messages: BotGuardMessage[];
  sinceAt: number;
}): { score: number; signals: BotSignal[]; triggered: boolean } {
  let score = 0;
  let phrasePoints = 0;
  const signals: BotSignal[] = [];
  const add = (signal: BotSignal) => {
    if (signal === "frase_automatica") {
      if (phrasePoints >= MAX_PHRASE_POINTS) return;
      phrasePoints += SIGNAL_POINTS[signal];
    }
    score += SIGNAL_POINTS[signal];
    if (signals.length < MAX_SIGNALS) signals.push(signal);
  };

  // Último outbound humano (não interno) dentro da janela = início do episódio.
  let episodeStartIndex = 0;
  input.messages.forEach((m, i) => {
    if (
      m.direction === "outbound" &&
      m.senderType === "human" &&
      !m.isInternal &&
      m.createdAt >= input.sinceAt
    ) {
      episodeStartIndex = i + 1;
    }
  });

  let outboundCount = 0;
  let lastOutboundAt: number | null = null;
  // Só o PRIMEIRO inbound depois de um outbound nosso mede tempo de resposta:
  // um humano que digita fragmentado ("oi" / "tudo bem?") não pode somar um
  // ponto por fragmento.
  let awaitingFirstReply = false;
  // texto normalizado → nº de outbounds nossos até a última vez que apareceu
  const seen = new Map<string, number>();

  for (const m of input.messages.slice(episodeStartIndex)) {
    if (m.isInternal || m.direction === "internal") continue;
    if (m.createdAt < input.sinceAt) continue;

    if (m.direction === "outbound") {
      outboundCount += 1;
      lastOutboundAt = m.createdAt;
      awaitingFirstReply = true;
      continue;
    }
    if (m.direction !== "inbound" || (m.senderType !== undefined && m.senderType !== "contact")) {
      continue;
    }

    const content = m.content ?? "";
    if (containsAutomatedPhrase(content)) add("frase_automatica");
    if (containsBotSelfIntro(content)) add("auto_apresentacao_de_bot");

    const norm = normalizeForRepeat(content);
    if (norm.length >= REPEAT_MIN_NORMALIZED_CHARS) {
      const previous = seen.get(norm);
      // Repetição só conta com ao menos uma resposta NOSSA no meio: é o
      // ping-pong (robô → IA → mesmo texto de novo), não a pessoa que mandou
      // duas vezes porque achou que não tinha ido.
      if (previous !== undefined && outboundCount > previous) add("texto_repetido");
      seen.set(norm, outboundCount);
    }

    if (awaitingFirstReply && lastOutboundAt !== null) {
      const delta = m.createdAt - lastOutboundAt;
      if (delta >= 0 && delta <= INSTANT_REPLY_MS && content.trim().length >= INSTANT_MIN_CHARS) {
        add("resposta_instantanea");
      }
      if (delta >= 0 && delta <= LONG_FAST_REPLY_MS && content.length >= LONG_FAST_MIN_CHARS) {
        add("longa_e_rapida");
      }
    }
    awaitingFirstReply = false;
  }

  return { score, signals, triggered: score >= BOT_SUSPICION_THRESHOLD };
}

const SIGNAL_LABELS: Record<string, string> = {
  frase_automatica: "frase de sistema automático",
  texto_repetido: "texto repetido",
  resposta_instantanea: "resposta instantânea",
  longa_e_rapida: "mensagem longa respondida em segundos",
  auto_apresentacao_de_bot: "se apresentou como assistente virtual",
};

/**
 * Frase PT-BR curta para o motivo do repasse/etiqueta.
 * Ex.: "texto repetido 2×, resposta instantânea, frase de sistema automático".
 */
export function describeBotSignals(signals: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const s of signals) counts.set(s, (counts.get(s) ?? 0) + 1);
  if (counts.size === 0) return "sinais de mensagem automática";
  // Mais forte primeiro (pontos × ocorrências), empate pela ordem de aparição.
  const ordered = [...counts.entries()].sort(
    (a, b) =>
      (SIGNAL_POINTS[b[0] as BotSignal] ?? 0) * b[1] - (SIGNAL_POINTS[a[0] as BotSignal] ?? 0) * a[1]
  );
  return ordered
    .map(([s, n]) => `${SIGNAL_LABELS[s] ?? s.replace(/_/g, " ")}${n > 1 ? ` ${n}×` : ""}`)
    .join(", ");
}
