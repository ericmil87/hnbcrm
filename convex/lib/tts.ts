/**
 * PORTA ÚNICA de voz (TTS) — parte PURA (onboarding v2, P4.1; plano seção 5).
 *
 * O que mora aqui (sem `ctx`, testado direto em `lib/tts.test.ts`):
 *  - modelo e voz por env (`getTtsConfig`), com padrão decidido pelo dono:
 *    `google/gemini-3.8-flash-tts`, voz `Kore`. O onboarding lê pelo
 *    `getOnboardingTts()` (`lib/onboardingModels.ts`), o atendente por
 *    `getTtsConfig("attendant")`; as strings existem só aqui;
 *  - as REGRAS FIXAS da resposta em áudio (`planVoiceReply`): só responde em
 *    áudio quando a última mensagem do cliente foi áudio; nunca Pix, link,
 *    valor, endereço, código, e-mail, telefone ou tabela (essas partes vão em
 *    texto, ou tudo vai em texto); nunca em grupo; texto longo vai em texto;
 *  - a montagem do texto falável (`toSpeakableText`);
 *  - custo (`estimateTtsCost`), duração/waveform a partir do PCM e o cabeçalho
 *    WAV que embrulha o PCM para o conversor da VPS (`/convert`).
 *
 * Quem chama a rede é `convex/voiceReplyNode.ts` (action Node). Falha em
 * qualquer etapa = a resposta sai em TEXTO, nunca silêncio.
 *
 * Sem clonagem de voz: só as vozes de catálogo do provedor (`TTS_VOICES`).
 */
import { detectLeakedModelMarkup } from "./llmOutputGuard";

// ── Modelo e voz ────────────────────────────────────────────────────────────

/** Modelo padrão (decisão do dono, 11/11/2026, depois do spike P0.4). */
export const TTS_DEFAULT_MODEL = "google/gemini-3.8-flash-tts";
/** Voz padrão (decisão do dono). */
export const TTS_DEFAULT_VOICE = "Kore";

/**
 * Modelos aceitos, com preço (USD por 1M tokens, `GET /api/v1/models` do
 * OpenRouter em 10/11/2026). Só a família Gemini TTS: devolve PCM 24 kHz mono,
 * que é o que o resto da porta sabe medir (duração, waveform) e embrulhar em
 * WAV. Modelo de mp3 (MAI, Grok, Kokoro) ficaria sem waveform: fora da lista.
 */
export const TTS_MODELS: Record<string, { inputPerM: number; outputPerM: number }> = {
  "google/gemini-3.8-flash-tts": { inputPerM: 0.5, outputPerM: 9 },
  "google/gemini-3.8-flash-lite-tts": { inputPerM: 0.5, outputPerM: 6 },
  "google/gemini-3.1-flash-tts-preview": { inputPerM: 1, outputPerM: 20 },
};

/** Vozes de catálogo dos modelos Gemini TTS (`supported_voices`, iguais nos três). */
export const TTS_VOICES: readonly string[] = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede", "Callirrhoe", "Autonoe",
  "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina", "Erinome", "Algenib", "Rasalgethi",
  "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird",
  "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
];

export function isTtsVoice(voice: unknown): voice is string {
  return typeof voice === "string" && TTS_VOICES.includes(voice);
}

export function isTtsModel(model: unknown): model is string {
  return typeof model === "string" && Object.prototype.hasOwnProperty.call(TTS_MODELS, model);
}

export type TtsSurface = "onboarding" | "attendant";

const TTS_ENV: Record<TtsSurface, { model: string; voice: string }> = {
  onboarding: { model: "ONBOARDING_TTS_MODEL", voice: "ONBOARDING_TTS_VOICE" },
  attendant: { model: "ATTENDANT_TTS_MODEL", voice: "ATTENDANT_TTS_VOICE" },
};

type EnvLike = Record<string, string | undefined>;

export type TtsConfig = {
  model: string;
  voice: string;
  /** Env preenchida mas recusada (fora da lista): caiu no padrão. */
  rejected: boolean;
};

/**
 * Modelo e voz de uma superfície. Env vazia ou fora da lista (`TTS_MODELS`,
 * `TTS_VOICES`) cai no padrão. Trocar é `npx convex env set`, sem deploy.
 */
export function getTtsConfig(surface: TtsSurface, env: EnvLike = process.env): TtsConfig {
  const names = TTS_ENV[surface];
  const rawModel = env[names.model]?.trim();
  const rawVoice = env[names.voice]?.trim();
  const modelOk = !rawModel || isTtsModel(rawModel);
  const voiceOk = !rawVoice || isTtsVoice(rawVoice);
  return {
    model: rawModel && modelOk ? rawModel : TTS_DEFAULT_MODEL,
    voice: rawVoice && voiceOk ? rawVoice : TTS_DEFAULT_VOICE,
    rejected: !modelOk || !voiceOk,
  };
}

/** Voz efetiva do atendente: a da org (se for de catálogo) > env > padrão. */
export function resolveAttendantVoice(orgVoice: string | undefined, env: EnvLike = process.env): string {
  return isTtsVoice(orgVoice) ? orgVoice : getTtsConfig("attendant", env).voice;
}

/**
 * Trava de retenção no corpo do pedido de fala do OpenRouter (endpoint de áudio).
 * Mesma política do texto (`OPENROUTER_ZDR_PROVIDER_BODY`): `data_collection:"deny"`
 * e `allow_fallbacks:true`. SEM `require_parameters`: os modelos de fala listam
 * `supported_parameters: []`, e a trava recusaria todo provedor.
 *
 * NÃO VALIDADO no endpoint de áudio (o spike chamou sem `provider`). Recusar o
 * campo seria seguro (a chamada falha e a resposta sai em texto), mas IGNORAR o
 * campo não aparece em lugar nenhum: o áudio sairia sem a trava. Por isso org
 * com `strictZdr` nem chega aqui (o runtime manda texto, `zdr_nao_validado`) até
 * o teste vivo confirmar; `zdr:true` fica pronto para quando isso mudar.
 */
export function ttsProviderBody(strictZdr: boolean): Record<string, unknown> {
  return {
    provider: {
      data_collection: "deny",
      allow_fallbacks: true,
      ...(strictZdr ? { zdr: true } : {}),
    },
  };
}

// ── Limites ─────────────────────────────────────────────────────────────────

/** Teto do texto falado (~36 s no ritmo medido do Gemini, ~16 caracteres/s). */
export const VOICE_REPLY_MAX_CHARS = 600;
/** Abaixo disto não vale um áudio (resto da fala depois de tirar os dados). */
export const VOICE_REPLY_MIN_SPOKEN_CHARS = 12;
/** Teto duro do áudio gerado: passou (modelo falou devagar), vai em texto. */
export const VOICE_REPLY_MAX_SECONDS = 45;
/** Mais do que isto de trechos com dado = a resposta é "de dados": tudo em texto. */
export const VOICE_REPLY_MAX_DATA_SEGMENTS = 4;
/** Aviso de voz sintética (opcional, configurável por org). */
export const VOICE_NOTICE_MAX_CHARS = 200;
/** Ritmo medido no spike (447 caracteres em 24–28 s no Gemini). */
export const TTS_CHARS_PER_SECOND = 16;
/** PCM do Gemini TTS: s16le, 24 kHz, mono. */
export const TTS_PCM_SAMPLE_RATE = 24_000;
export const WAVEFORM_SAMPLES = 64;
/** Tempos de rede da porta (a action do atendente roda com lease de 3 min). */
export const TTS_TIMEOUT_MS = 30_000;
export const TTS_CONVERT_TIMEOUT_MS = 20_000;

// ── Dado que nunca vai na voz ───────────────────────────────────────────────

export type VoiceDataKind =
  | "pix"
  | "link"
  | "valor"
  | "endereco"
  | "codigo"
  | "email"
  | "telefone"
  | "tabela"
  /** Qualquer outro dígito fora de um horário ("50", "150", "1000", "18/10"). */
  | "numero";

/**
 * Horários continuam falados: "15h", "10h30", "14:30". Todo OUTRO dígito torna o
 * trecho "de dado" (revisão do P4.1: preço sem "R$" — "o corte sai por 50" —,
 * número de endereço, total numa linha solta e valores em outra língua vazavam).
 */
const TIME_TOKEN = /\b\d{1,2}(?::\d{2}|h\d{2}|h)\b/gi;

function hasNonTimeDigit(segment: string): boolean {
  return /\d/.test(segment.replace(TIME_TOKEN, " "));
}

const DATA_PATTERNS: Array<{ kind: VoiceDataKind; re: RegExp }> = [
  { kind: "pix", re: /\b(pix|boleto|chave\s+(aleat[óo]ria|pix)|copia\s+e\s+cola|qr\s*code)\b/i },
  {
    kind: "link",
    re: /(https?:\/\/|www\.|\blink\b|\b[a-z0-9-]+\.(com|net|org|io|app|br|me|ly|site|store|shop|link)(\.[a-z]{2})?\b|@\w+|\bponto\s+(com|br|net|org)\b)/i,
  },
  {
    kind: "valor",
    re: /(R\$|US\$|\$|€|\breais\b|\bcentavos\b|\bd[óo]lar(es)?\b|\bdollars?\b|\beuros?\b|\bpesos\b|\bvalor(es)?\b|\bpre[çc]os?\b|\bprecio\b|\bprice\b|\bcusta(m)?\b|\bcusto\b|\bcuesta\b|\bcosts?\b|\btotal\b|\bmensalidade\b|\bparcel\w*|\bpor\s+m[eê]s\b|\bper\s+month\b|\b[àa]\s+vista\b|\bd[ée]bito\b|\bcr[ée]dito\b)/i,
  },
  {
    kind: "endereco",
    re: /(\b(rua|avenida|av|alameda|travessa|rodovia|estrada|pra[çc]a|bairro|cep|endere[çc]o)\b|\br\.\s|\bn[º°]\s*\d|\bn[úu]mero\s+\d|\b\d{5}-\d{3}\b)/i,
  },
  { kind: "email", re: /[^\s@]+@[^\s@]+\.[^\s@]+|\be-?mail\b|\barroba\b/i },
  // 8+ dígitos (com separadores de telefone) = telefone; vem antes do código.
  { kind: "telefone", re: /\+?\d(?:[\s().-]{0,2}\d){7,}/ },
  // 5+ dígitos seguidos (com . - /), código alfanumérico em caixa alta, crase.
  {
    kind: "codigo",
    re: /(\d(?:[./-]?\d){4,}|\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,}\b|`)/,
  },
  { kind: "tabela", re: /\|.*\||\t/ },
];

/** Tipos de dado que tornam um trecho impróprio para a voz. */
export function voiceDataKinds(segment: string): VoiceDataKind[] {
  const kinds: VoiceDataKind[] = [];
  for (const { kind, re } of DATA_PATTERNS) {
    if (re.test(segment)) kinds.push(kind);
  }
  // "código" em caixa baixa também conta (o regex acima é sensível a caixa).
  if (!kinds.includes("codigo") && /\b(c[óo]digo|cupom|protocolo|senha|cpf|cnpj)\b/i.test(segment)) {
    kinds.push("codigo");
  }
  if (kinds.length === 0 && hasNonTimeDigit(segment)) kinds.push("numero");
  return kinds;
}

// ── Texto falável ───────────────────────────────────────────────────────────

const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

/**
 * O que o TTS recebe: sem marcação de WhatsApp/markdown (`*`, `_`, `~`, `#`,
 * crase), sem emoji, sem marcadores de lista; quebra de linha vira pausa.
 */
export function toSpeakableText(text: string): string {
  const lines = text
    .replace(EMOJI_RE, "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*(?:[-*•▪◦]|\d+[.)])\s+/, "")
        .replace(/^\s*#+\s*/, "")
        .replace(/[*_~`]+/g, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((line) => line.length > 0);
  return lines
    .map((line) => (/[.!?…:;,]$/.test(line) ? line : `${line}.`))
    .join(" ")
    .trim();
}

/** Linhas → frases (o corte que separa "fala" de "dado"). */
function splitSegments(text: string): Array<{ text: string; lineEnd: boolean }> {
  const out: Array<{ text: string; lineEnd: boolean }> = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (line.trim().length === 0) {
      out.push({ text: "", lineEnd: true });
      continue;
    }
    // Não corta dentro de link/e-mail/valor: só depois de pontuação seguida de espaço.
    const sentences = line.split(/(?<=[.!?…])\s+(?=\S)/);
    sentences.forEach((s, i) => out.push({ text: s, lineEnd: i === sentences.length - 1 }));
  }
  return out;
}

function joinSegments(segments: Array<{ text: string; lineEnd: boolean }>): string {
  let out = "";
  for (const seg of segments) {
    if (seg.text.length === 0) {
      if (out.length > 0 && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
      continue;
    }
    if (out.length > 0 && !out.endsWith("\n")) out += " ";
    out += seg.text;
    if (seg.lineEnd) out += "\n";
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// ── Regras fixas ────────────────────────────────────────────────────────────

/** Por que a resposta saiu em texto (gravado em `metadata.voiceReply.reason`). */
export type VoiceTextReason =
  | "desligado"
  | "canal"
  | "grupo"
  | "cliente_mandou_texto"
  | "rascunho"
  | "follow_up"
  | "imagem"
  | "dado_sensivel"
  | "longo"
  | "vazio"
  | "marcacao"
  | "idioma"
  // Antes da síntese, no runtime: org com strictZdr (trava não validada no endpoint
  // de áudio) e turno sem folga no lease do lock.
  | "zdr_nao_validado"
  | "sem_tempo"
  // Da action (depois da decisão): rede/provedor/conversor/teto.
  | "sem_chave"
  | "rota_sem_openrouter"
  | "sem_conversor"
  | "teto_de_gastos"
  // Chat do onboarding (P4.2b): a reserva do orçamento do onboarding recusou.
  | "orcamento_onboarding"
  | "falha_tts"
  | "formato_tts"
  | "audio_longo"
  | "falha_conversao"
  | "falha_armazenamento";

export const VOICE_TEXT_REASONS: readonly VoiceTextReason[] = [
  "desligado", "canal", "grupo", "cliente_mandou_texto", "rascunho", "follow_up", "imagem",
  "dado_sensivel", "longo", "vazio", "marcacao", "idioma", "zdr_nao_validado", "sem_tempo", "sem_chave",
  "rota_sem_openrouter", "sem_conversor", "teto_de_gastos", "orcamento_onboarding", "falha_tts", "formato_tts", "audio_longo",
  "falha_conversao", "falha_armazenamento",
];

export type VoiceReplyInput = {
  /** `aiConfig.voiceReplyEnabled === true` (ausente = desligado). */
  enabled: boolean;
  /** Transporte da conversa: só WhatsApp (Cloud API ou bridge) tem voice note. */
  transport: string | null | undefined;
  isGroup: boolean;
  /** A ÚLTIMA mensagem do cliente (inbound, não interna) foi áudio. */
  lastInboundWasAudio: boolean;
  /** O turno vira rascunho (modo sugestão, coach, teto em `block`…). */
  draft: boolean;
  /** Turno proativo (follow-up): o cliente não acabou de mandar áudio. */
  followUp: boolean;
  /** A resposta leva imagem (flyer): legenda é texto. */
  hasImage: boolean;
  /** Texto final da resposta (já passou pelo output guard e pela formatação). */
  text: string;
  /** Aviso de voz sintética a falar ANTES (primeiro áudio da conversa), ou null. */
  notice: string | null;
  /**
   * Idioma em que a resposta sai (perfil do atendente; com `"auto"`, o idioma
   * detectado da conversa). Ausente/null = pt-BR. Fora do português = texto: os
   * padrões de dado são em português e a voz não foi ouvida em outra língua.
   */
  language?: string | null;
};

export type VoiceReplyPlan =
  | { kind: "text"; reason: VoiceTextReason }
  | {
      kind: "voice";
      /** Parte falada, como fica no histórico (texto da mensagem de áudio). */
      spokenText: string;
      /** O que vai ao TTS (`toSpeakableText` + aviso). */
      speakable: string;
      /** Dados que vão em TEXTO logo depois do áudio (Pix, link, valor…), ou null. */
      textPart: string | null;
      noticeIncluded: boolean;
    };

/**
 * Só o bridge por enquanto: é onde o voice note (PTT + duração + waveform) foi
 * montado e será validado no aparelho. A Cloud API (Meta) entrega o ogg como
 * áudio, mas ninguém conferiu ao vivo se aparece como mensagem de voz: até lá,
 * texto.
 */
export function voiceTransportSupported(transport: string | null | undefined): boolean {
  return transport === "bridge";
}

/** pt, pt-BR, pt-PT… (ausente = pt-BR, o padrão do atendente). */
export function isPortugueseLanguage(language: string | null | undefined): boolean {
  if (!language || language === "auto") return true;
  return /^pt(\b|[-_])/i.test(language);
}

/** Aviso configurado → texto pronto (aparado, teto), ou null. */
export function normalizeVoiceNotice(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, VOICE_NOTICE_MAX_CHARS);
}

/**
 * Decide se a resposta do atendente sai em áudio. Regras fixas, nesta ordem:
 * desligado → canal sem voice note (só bridge) → grupo → cliente não mandou
 * áudio → rascunho → follow-up → imagem → idioma fora do português → texto
 * vazio → marcação técnica (defesa em profundidade: o guard já rodou) → dados
 * (separa ou tudo em texto) → longo.
 */
export function planVoiceReply(input: VoiceReplyInput): VoiceReplyPlan {
  if (!input.enabled) return { kind: "text", reason: "desligado" };
  if (!voiceTransportSupported(input.transport)) return { kind: "text", reason: "canal" };
  if (input.isGroup) return { kind: "text", reason: "grupo" };
  if (!input.lastInboundWasAudio) return { kind: "text", reason: "cliente_mandou_texto" };
  if (input.draft) return { kind: "text", reason: "rascunho" };
  if (input.followUp) return { kind: "text", reason: "follow_up" };
  if (input.hasImage) return { kind: "text", reason: "imagem" };
  if (!isPortugueseLanguage(input.language)) return { kind: "text", reason: "idioma" };
  return planSpokenPart(input.text, input.notice);
}

/**
 * Parte comum das regras de dado e tamanho (atendente e chat do onboarding):
 * texto vazio → marcação técnica (defesa em profundidade: o guard já rodou) →
 * dados (separa por frase ou tudo em texto) → longo. Uma implementação só:
 * `voiceDataKinds` decide o que nunca vai na voz nas duas superfícies.
 */
export function planSpokenPart(rawText: string, rawNotice: string | null): VoiceReplyPlan {
  const text = rawText.trim();
  if (text.length === 0) return { kind: "text", reason: "vazio" };
  if (detectLeakedModelMarkup(text)) return { kind: "text", reason: "marcacao" };

  const segments = splitSegments(text);
  const spoken: typeof segments = [];
  const data: typeof segments = [];
  for (const seg of segments) {
    if (seg.text.length === 0) {
      spoken.push(seg);
      data.push(seg);
      continue;
    }
    (voiceDataKinds(seg.text).length > 0 ? data : spoken).push(seg);
  }
  const dataCount = data.filter((s) => s.text.length > 0).length;
  const spokenText = joinSegments(spoken);
  const textPart = dataCount > 0 ? joinSegments(data) : null;
  if (dataCount > 0) {
    // Separar só quando sobra fala de verdade e os dados são poucos.
    if (
      dataCount > VOICE_REPLY_MAX_DATA_SEGMENTS ||
      toSpeakableText(spokenText).length < VOICE_REPLY_MIN_SPOKEN_CHARS
    ) {
      return { kind: "text", reason: "dado_sensivel" };
    }
  }

  const notice = rawNotice ? normalizeVoiceNotice(rawNotice) : null;
  const speakableBody = toSpeakableText(spokenText);
  if (speakableBody.length === 0) return { kind: "text", reason: "vazio" };
  const speakable = notice ? `${toSpeakableText(notice)} ${speakableBody}` : speakableBody;
  if (speakable.length > VOICE_REPLY_MAX_CHARS) return { kind: "text", reason: "longo" };
  return {
    kind: "voice",
    spokenText: notice ? `${notice}\n\n${spokenText}` : spokenText,
    speakable,
    textPart,
    noticeIncluded: notice !== null,
  };
}

/**
 * Chat do onboarding (P4.2b; plano seção 5: "o Copiloto responde em áudio quando
 * o usuário manda áudio — o navegador toca direto"). Regras, nesta ordem: o
 * usuário NÃO mandou áudio neste turno (`cliente_mandou_texto`) → idioma fora do
 * português → as mesmas regras de dado/tamanho do atendente (`planSpokenPart`).
 * O texto inteiro já aparece na tela; o áudio fala só a parte sem dado
 * (`speakable`), e o dado fica na bolha de texto. Sem canal, grupo, rascunho,
 * follow-up nem imagem: não existem no chat do onboarding. Sem aviso de voz
 * falado: a tela já é do próprio Copiloto da plataforma.
 */
export function planOnboardingVoiceReply(input: {
  /** O turno teve áudio do usuário TRANSCRITO (`attachment.kind === "audio"`). */
  userSentAudio: boolean;
  /** Resposta final, já aprovada pelo guard (`parseInterviewerOutput`). */
  text: string;
  /** Idioma detectado da resposta (ausente/null = pt-BR). */
  language?: string | null;
}): VoiceReplyPlan {
  if (!input.userSentAudio) return { kind: "text", reason: "cliente_mandou_texto" };
  if (!isPortugueseLanguage(input.language)) return { kind: "text", reason: "idioma" };
  return planSpokenPart(input.text, null);
}

// ── Custo ───────────────────────────────────────────────────────────────────

/** Tokens de saída de áudio do Gemini por segundo (medido: 600–696 tok em 24–28 s). */
export const TTS_AUDIO_TOKENS_PER_SECOND = 25;
/** Caracteres por token de entrada (medido: 447 caracteres = 112 tokens). */
export const TTS_CHARS_PER_INPUT_TOKEN = 4;

export type TtsCost = {
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  /** Modelo fora da tabela: preço mais alto da tabela (superestima de propósito). */
  estimated: boolean;
};

/**
 * Custo de uma síntese. O Gemini cobra por token de entrada (texto) e de saída
 * (áudio, ~25 tokens/s). Conferido contra o custo real do spike: 27,84 s +
 * 447 caracteres = US$ 0,00632 (medido US$ 0,00632).
 */
export function estimateTtsCost(model: string, input: { chars: number; seconds: number }): TtsCost {
  const known = isTtsModel(model) ? TTS_MODELS[model] : null;
  const price = known ?? {
    inputPerM: Math.max(...Object.values(TTS_MODELS).map((p) => p.inputPerM)),
    outputPerM: Math.max(...Object.values(TTS_MODELS).map((p) => p.outputPerM)),
  };
  const chars = Number.isFinite(input.chars) && input.chars > 0 ? input.chars : 0;
  const seconds = Number.isFinite(input.seconds) && input.seconds > 0 ? input.seconds : 0;
  const promptTokens = Math.ceil(chars / TTS_CHARS_PER_INPUT_TOKEN);
  const completionTokens = Math.ceil(seconds * TTS_AUDIO_TOKENS_PER_SECOND);
  const costUsd = (promptTokens * price.inputPerM + completionTokens * price.outputPerM) / 1_000_000;
  return { costUsd, promptTokens, completionTokens, estimated: known === null };
}

// ── PCM: formato, duração, waveform, WAV ────────────────────────────────────

/**
 * `audio/pcm;rate=24000;channels=1` (o que o Gemini devolve) → taxa e canais.
 * `null` para qualquer outra coisa (mp3, json de erro): a porta não sabe medir.
 */
export function parsePcmContentType(contentType: string | null | undefined): { sampleRate: number; channels: number } | null {
  if (!contentType) return null;
  const parts = contentType.split(";").map((p) => p.trim().toLowerCase());
  if (parts[0] !== "audio/pcm" && parts[0] !== "audio/l16") return null;
  let sampleRate = TTS_PCM_SAMPLE_RATE;
  let channels = 1;
  for (const p of parts.slice(1)) {
    const [k, val] = p.split("=");
    const n = Number(val);
    if (!Number.isInteger(n) || n <= 0) continue;
    if (k === "rate") sampleRate = n;
    if (k === "channels") channels = n;
  }
  if (sampleRate < 8_000 || sampleRate > 48_000 || channels !== 1) return null;
  return { sampleRate, channels };
}

/** Duração em segundos de PCM s16le mono. */
export function pcmDurationSeconds(byteLength: number, sampleRate: number = TTS_PCM_SAMPLE_RATE): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0 || sampleRate <= 0) return 0;
  return Math.floor(byteLength / 2) / sampleRate;
}

/** Segundos inteiros para o WhatsApp (`Seconds`): arredonda, mínimo 1. */
export function voiceNoteSeconds(durationSeconds: number): number {
  return Math.max(1, Math.round(durationSeconds));
}

/**
 * Waveform de 64 valores 0–100: pico absoluto por janela, normalizado pelo
 * maior pico (mesma lógica do `scripts/converter.mjs` do spike e da escala que
 * o WhatsApp usa). Silêncio total = 64 zeros.
 */
export function pcmWaveform(pcm: Uint8Array, samples: number = WAVEFORM_SAMPLES): number[] {
  const n = Math.floor(pcm.byteLength / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  const peaks: number[] = [];
  for (let i = 0; i < samples; i++) {
    const a = Math.floor((i * n) / samples);
    const b = Math.floor(((i + 1) * n) / samples);
    let max = 0;
    for (let j = a; j < b; j++) {
      const v = Math.abs(view.getInt16(j * 2, true));
      if (v > max) max = v;
    }
    peaks.push(max);
  }
  const top = Math.max(0, ...peaks);
  if (top === 0) return peaks.map(() => 0);
  return peaks.map((p) => Math.round((p / top) * 100));
}

/** Waveform válida para o bridge: 64 inteiros 0–100. */
export function isValidWaveform(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === WAVEFORM_SAMPLES &&
    value.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 100)
  );
}

/** `[]byte` do wuzapi em JSON = string base64 dos bytes. */
export function waveformToBase64(waveform: number[]): string {
  let bin = "";
  for (const x of waveform) bin += String.fromCharCode(Math.max(0, Math.min(255, Math.round(x))));
  return btoa(bin);
}

/** Cabeçalho RIFF/WAVE (PCM s16le) de 44 bytes + os dados. */
export function wrapPcmAsWav(pcm: Uint8Array, sampleRate: number = TTS_PCM_SAMPLE_RATE, channels = 1): Uint8Array {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataLength = pcm.byteLength - (pcm.byteLength % 2);
  const out = new Uint8Array(44 + dataLength);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // tamanho do bloco fmt
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  view.setUint32(40, dataLength, true);
  out.set(pcm.subarray(0, dataLength), 44);
  return out;
}
