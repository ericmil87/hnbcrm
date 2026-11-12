/**
 * Regras puras da conversa do onboarding (`/comecar`): etapas da barra de
 * progresso, texto do modelo sem marcação e a linha do tempo (histórico do
 * servidor + turno em andamento, sem duplicar).
 */
import { safeAudioUrl, type OnboardingReplyAudio } from "./onboardingStream";

// ── Etapas ──────────────────────────────────────────────────────────────────

/** Etapas visíveis (plano 4.1). `account` é a etapa 1 (antes do login / sem org). */
export const ONBOARDING_STEPS = [
  { id: "account", label: "Conta" },
  { id: "interview", label: "Entrevista" },
  { id: "materials", label: "Materiais" },
  { id: "draft", label: "Rascunho" },
  { id: "applied", label: "Aplicar" },
  { id: "test", label: "Teste" },
  { id: "next_steps", label: "Próximos passos" },
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]["id"];

export interface StageProgress {
  /** 1-based. */
  index: number;
  total: number;
  label: string;
  /** 0..1, para a largura da barra. */
  ratio: number;
  /** "Etapa 2 de 7: Entrevista". */
  valueText: string;
}

/** Etapa do servidor (`onboardingSessions.stage`) → progresso; desconhecida ou nula = entrevista. */
export function stageProgress(stage: string | null | undefined): StageProgress {
  const total = ONBOARDING_STEPS.length;
  let i = ONBOARDING_STEPS.findIndex((s) => s.id === stage);
  if (i === -1) i = 1;
  const step = ONBOARDING_STEPS[i];
  return {
    index: i + 1,
    total,
    label: step.label,
    ratio: (i + 1) / total,
    valueText: `Etapa ${i + 1} de ${total}: ${step.label}`,
  };
}

// ── Texto do modelo ─────────────────────────────────────────────────────────

const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/**
 * Texto do Copiloto para a tela, SEM marcação: o backend já limpa, mas a tela
 * não confia. Tira tags HTML, troca imagem markdown pelo texto alternativo e
 * link markdown pelo rótulo, substitui URL solta por "[link removido]" e remove
 * caracteres invisíveis. O resultado é renderizado como texto puro (React
 * escapa; quebras de linha com `whitespace-pre-wrap`), nunca como HTML.
 */
/** Aviso de LGPD da conversa (informação, não aceite: não grava nada). Texto único: conversa e hero. */
export const AI_PROCESSING_NOTICE =
  "A conversa é processada por IA de provedores parceiros, inclusive fora do Brasil. Não envie dados de clientes.";

export function plainModelText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(INVISIBLE_RE, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\b(?:https?|ftp|javascript|data|file):\/*[^\s<>"']*/gi, "[link removido]")
    .replace(/\bwww\.[^\s<>"')]+/gi, "[link removido]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Linha do tempo ──────────────────────────────────────────────────────────

/** Mensagem do histórico (`onboardingChat.listMessages`), só o que a tela usa. */
export interface HistoryMessage {
  _id: string;
  role: "user" | "assistant";
  text: string;
  blocks: readonly unknown[];
  chips: readonly string[];
  attachment: { kind: string; label: string } | null;
  audio?: OnboardingReplyAudio;
  createdAt: number;
}

/** Turno em andamento (stream). */
export interface PendingTurn {
  /** Texto que a pessoa enviou (vazio quando foi só anexo). */
  userText: string;
  attachmentLabel?: string;
  /** Id da mensagem mais nova do histórico quando o turno começou (null = histórico vazio). */
  baselineId: string | null;
  startedAt: number;
  replyText: string;
  blocks: readonly unknown[];
  chips: readonly string[];
  status: string | null;
  audio?: OnboardingReplyAudio;
  /** Ainda recebendo texto/blocos (antes do `done`). */
  streaming: boolean;
}

export interface TimelineItem {
  key: string;
  role: "user" | "assistant";
  text: string;
  blocks: readonly unknown[];
  chips: readonly string[];
  attachmentLabel?: string;
  audio?: OnboardingReplyAudio;
  createdAt?: number;
  /** Bolha do turno em andamento (ainda não está no histórico). */
  pending?: boolean;
}

/** Áudio só com URL segura (`https:` no storage do Convex); senão, sem player. */
function safeAudio(audio: OnboardingReplyAudio | undefined): OnboardingReplyAudio | undefined {
  if (!audio) return undefined;
  const url = safeAudioUrl(audio.url);
  return url ? { ...audio, url } : undefined;
}

function fromHistory(m: HistoryMessage): TimelineItem {
  const audio = safeAudio(m.audio);
  return {
    key: m._id,
    role: m.role,
    text: m.text,
    blocks: m.blocks,
    chips: m.chips,
    ...(m.attachment ? { attachmentLabel: m.attachment.label } : {}),
    ...(audio ? { audio } : {}),
    createdAt: m.createdAt,
  };
}

/**
 * Junta o histórico (mais NOVO primeiro, como vem do servidor) com o turno em
 * andamento, em ordem cronológica. O servidor grava as duas mensagens ANTES de
 * mandar o texto, então a assinatura pode trazê-las durante o stream: o que já
 * chegou ao histórico (mensagens mais novas que `baselineId`) substitui a bolha
 * pendente correspondente. O áudio do stream completa a resposta do histórico
 * enquanto a assinatura ainda não tem a URL.
 */
export function buildTimeline(historyNewestFirst: readonly HistoryMessage[], pending: PendingTurn | null): TimelineItem[] {
  const items = [...historyNewestFirst].reverse().map(fromHistory);
  if (!pending) return items;

  const baselineIdx = pending.baselineId ? historyNewestFirst.findIndex((m) => m._id === pending.baselineId) : -1;
  // Baseline fora da página carregada (não deveria acontecer: a 1ª página é a mais nova) = nada é novo.
  const fresh =
    pending.baselineId === null
      ? historyNewestFirst
      : baselineIdx === -1
        ? []
        : historyNewestFirst.slice(0, baselineIdx);
  const hasUser = fresh.some((m) => m.role === "user");
  const freshAssistant = fresh.find((m) => m.role === "assistant");

  const pendingAudio = safeAudio(pending.audio);
  if (freshAssistant) {
    if (pendingAudio && !items.find((it) => it.key === freshAssistant._id)?.audio) {
      return items.map((it) => (it.key === freshAssistant._id ? { ...it, audio: pendingAudio } : it));
    }
    return items;
  }

  const out = items.slice();
  if (!hasUser && (pending.userText || pending.attachmentLabel)) {
    out.push({
      key: "pending:user",
      role: "user",
      text: pending.userText,
      blocks: [],
      chips: [],
      ...(pending.attachmentLabel ? { attachmentLabel: pending.attachmentLabel } : {}),
      createdAt: pending.startedAt,
      pending: true,
    });
  }
  if (pending.replyText || pending.blocks.length > 0 || pendingAudio) {
    out.push({
      key: "pending:assistant",
      role: "assistant",
      text: pending.replyText,
      blocks: pending.blocks,
      chips: pending.chips,
      ...(pendingAudio ? { audio: pendingAudio } : {}),
      pending: true,
    });
  }
  return out;
}

/** Chips sugeridos para o rodapé: os da última resposta do Copiloto (stream > histórico > estado). */
export function currentChips(timeline: readonly TimelineItem[], fallback: readonly string[] = []): string[] {
  const last = timeline[timeline.length - 1];
  if (!last) return [...fallback];
  if (last.role !== "assistant") return [];
  return last.chips.length > 0 ? [...last.chips] : [...fallback];
}
