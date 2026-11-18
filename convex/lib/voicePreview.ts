/**
 * Teste da resposta em áudio nas Configurações (parte PURA; o front importa daqui).
 *
 *  - "Ouvir amostra": o aviso de voz sintética (ou uma saudação padrão) dito
 *    com a voz escolhida, pela MESMA requisição de TTS do atendente
 *    (`voiceReplyNode.ts`), com as MESMAS regras do aviso (`voiceNoticeError`).
 *  - Simulador com voz: a resposta simulada passa por `planAttendantVoice` e,
 *    quando a regra manda áudio, é sintetizada pela mesma porta.
 *
 * Custo: cada síntese é uma run `agentRuns.kind:"tts"` (entra no teto em R$).
 * Para não gastar à toa: janela fixa por usuário/org (tabela de janelas do
 * onboarding, chave própria `voice_preview:`) e cache curto do mesmo texto+voz
 * (`VOICE_PREVIEW_CACHE_MS`). Nada é gravado no CRM: o WAV é uma linha de
 * `files` `fileType:"other"`, `metadata.kind:"voice_preview"`, apagada sozinha.
 */
import { v, type Infer } from "convex/values";
import type { VoiceTextReason } from "./tts";

/** `files.metadata.kind` do WAV de teste (nunca vinculado a mensagem/lead). */
export const VOICE_PREVIEW_FILE_KIND = "voice_preview";
export const VOICE_PREVIEW_FILE_NAME = "amostra-de-voz.wav";
export const VOICE_PREVIEW_FILE_MIME = "audio/wav";

/** Mesmo texto + mesma voz dentro desta janela reaproveita o áudio (sem pagar de novo). */
export const VOICE_PREVIEW_CACHE_MS = 10 * 60 * 1000;
/** O WAV some depois disto (o cache só reaproveita os mais novos que `VOICE_PREVIEW_CACHE_MS`). */
export const VOICE_PREVIEW_TTL_MS = 30 * 60 * 1000;

export type VoicePreviewRateSpec = { name: string; windowMs: number; limit: number };

/** Limites de síntese de teste (cache não conta). Usuário: 6/min e 60/dia; org: 200/dia. */
export const VOICE_PREVIEW_RATE_LIMITS: { user: VoicePreviewRateSpec[]; org: VoicePreviewRateSpec[] } = {
  user: [
    { name: "1m", windowMs: 60 * 1000, limit: 6 },
    { name: "1d", windowMs: 24 * 60 * 60 * 1000, limit: 60 },
  ],
  org: [{ name: "1d", windowMs: 24 * 60 * 60 * 1000, limit: 200 }],
};

/** Chave da janela (na tabela `onboardingRateLimits`, prefixo próprio). */
export function voicePreviewRateKey(scope: "user" | "org", id: string, windowName: string): string {
  return `voice_preview:${scope}:${id}:${windowName}`;
}

/** Saudação falada depois do aviso (ou sozinha, sem aviso): curta, sem dado. */
export const VOICE_SAMPLE_GREETING = "Oi, tudo bem? Pode me contar como eu posso te ajudar.";

/**
 * Texto da amostra: o aviso no início, como no primeiro áudio de cada conversa,
 * seguido da saudação. Recebe o aviso já aparado e aprovado.
 */
export function voiceSampleText(notice: string | null): string {
  return notice ? `${notice.replace(/[.!?…]*$/, "")}. ${VOICE_SAMPLE_GREETING}` : VOICE_SAMPLE_GREETING;
}

/**
 * Chave de cache (voz + texto exato que vai ao TTS). Dois hashes FNV-1a de 32
 * bits + tamanho: colisão só trocaria uma amostra de teste, nunca vaza dado
 * (a busca é sempre dentro da própria org).
 */
export function voicePreviewCacheKey(voice: string, text: string): string {
  const input = `${voice}\u0000${text}`;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}:${input.length}`;
}

/**
 * Por que a resposta foi em TEXTO, em PT-BR, para o simulador mostrar ("a
 * regra manda texto"). Cobre todos os motivos de `VoiceTextReason`.
 */
export const VOICE_TEXT_REASON_LABELS: Record<VoiceTextReason, string> = {
  desligado: "A resposta em áudio está desligada.",
  canal: "Só o WhatsApp por QR code responde em áudio; neste canal vai em texto.",
  grupo: "Em grupos a IA sempre responde em texto.",
  cliente_mandou_texto: "O cliente escreveu: a IA só responde em áudio quando o cliente manda áudio.",
  rascunho: "Em Sugerir respostas a sugestão fica em texto para a equipe revisar.",
  follow_up: "Mensagens de acompanhamento vão em texto.",
  imagem: "A resposta leva imagem: a legenda vai em texto.",
  dado_sensivel:
    "A resposta é quase só valores, links, Pix, endereços, telefones ou códigos: tudo vai por escrito.",
  longo: "A resposta é longa demais para um áudio: vai em texto.",
  vazio: "Não sobrou nada para falar: vai em texto.",
  marcacao: "A resposta tinha marcação técnica: vai em texto.",
  idioma: "A resposta não está em português: vai em texto.",
  zdr_nao_validado: "A privacidade rígida de dados está ligada: por enquanto a resposta vai em texto.",
  sem_tempo: "Não houve tempo para gerar o áudio: vai em texto.",
  sem_chave: "Resposta em áudio indisponível no momento: vai em texto.",
  rota_sem_openrouter: "Com a chave de IA própria da organização a resposta vai em texto.",
  sem_conversor: "Resposta em áudio indisponível no momento: vai em texto.",
  teto_de_gastos: "O limite de gasto com IA foi atingido: vai em texto.",
  orcamento_onboarding: "O limite de gasto com IA foi atingido: vai em texto.",
  falha_tts: "Não foi possível gerar o áudio agora: em produção iria em texto.",
  formato_tts: "Não foi possível gerar o áudio agora: em produção iria em texto.",
  audio_longo: "O áudio passaria de 45 segundos: vai em texto.",
  falha_conversao: "Não foi possível converter o áudio: em produção iria em texto.",
  falha_armazenamento: "Não foi possível guardar o áudio: em produção iria em texto.",
};

/** Rótulo de um motivo vindo do servidor (desconhecido = genérico, nunca o código cru). */
export function voiceTextReasonLabel(reason: string): string {
  return (VOICE_TEXT_REASON_LABELS as Record<string, string>)[reason] ?? "Esta resposta iria em texto.";
}

/** O que o simulador devolve sobre a voz (`attendant.simulateAttendant` com `voice:true`). */
export const simulatedVoiceValidator = v.union(
  v.object({
    mode: v.literal("audio"),
    url: v.string(),
    durationSec: v.number(),
    /** Texto falado (aviso + divulgação + parte sem dado), como fica no histórico. */
    spokenText: v.string(),
    /** O que segue POR ESCRITO logo depois do áudio (valores, links, Pix…), ou null. */
    textAfter: v.union(v.string(), v.null()),
    voice: v.string(),
    noticeIncluded: v.boolean(),
    /** `voiceReplyEnabled` da org: desligada, em produção iria tudo em texto. */
    enabledInOrg: v.boolean(),
    cached: v.boolean(),
  }),
  v.object({
    mode: v.literal("text"),
    /** `true` = foi a REGRA (`planAttendantVoice`) que mandou texto; `false` = o teste não conseguiu gerar o áudio. */
    rule: v.boolean(),
    reason: v.string(),
    message: v.string(),
    enabledInOrg: v.boolean(),
  })
);

export type SimulatedVoice = Infer<typeof simulatedVoiceValidator>;
