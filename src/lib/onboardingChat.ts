/**
 * Regras puras da conversa do onboarding (`/comecar`): progresso (roteiro de
 * 6 etapas), texto do modelo sem marcação, a linha do tempo (histórico do
 * servidor + turno em andamento, sem duplicar) e que cartão aparece inteiro.
 */
import {
  DRAFT_CARD_KINDS,
  ROADMAP_STEPS,
  nextStepLabel,
  nextTask,
  roadmapProgress,
  taskCard,
  type RoadmapFacts,
  type RoadmapTask,
  type TaskCardKind,
} from "../../convex/lib/onboardingRoadmap";
import { safeAudioUrl, type OnboardingReplyAudio } from "./onboardingStream";

// ── Progresso (roteiro de 6 etapas, em português, nunca regride) ────────────

/** Rótulo da etapa anterior ao roteiro (sem login ou sem organização). */
export const ACCOUNT_STEP_LABEL = "Crie a sua conta";

export interface ProgressStepView {
  id: string;
  label: string;
  state: "done" | "current" | "todo";
}

export interface ProgressView {
  /** 0 = conta (antes da etapa 1); 1..6 = etapas do roteiro. */
  index: number;
  total: number;
  label: string;
  /** 0..1, para a largura da barra. */
  ratio: number;
  /** "Etapa 2 de 6: Funil". */
  valueText: string;
  complete: boolean;
  steps: ProgressStepView[];
}

function stepsView(current: number, complete: boolean): ProgressStepView[] {
  return ROADMAP_STEPS.map((s, i) => ({
    id: s.id,
    label: s.label,
    state: complete || i + 1 < current ? "done" : i + 1 === current ? "current" : "todo",
  }));
}

/** Rótulo da barra na tela de entrada de quem já tem empresa (não é "criar a conta"). */
export const ENTRY_STEP_LABEL = "Escolha o que fazer";

/** Antes do login / sem organização: o passo é criar a conta. Na tela de entrada, `ENTRY_STEP_LABEL`. */
export function accountProgress(label: string = ACCOUNT_STEP_LABEL): ProgressView {
  const total = ROADMAP_STEPS.length;
  return {
    index: 0,
    total,
    label,
    ratio: 0,
    valueText: `${label}, antes da etapa 1 de ${total}`,
    complete: false,
    steps: stepsView(0, false),
  };
}

/**
 * Progresso com a conversa aberta. Monotônico: vale o maior entre a etapa do
 * que falta agora, o `reachedStep` do servidor e o maior índice já visto na
 * tela (`seenIndex`, 1-based). Nenhum rótulo em inglês em nenhum estado.
 */
export function chatProgress(facts: RoadmapFacts, seenIndex = 0): ProgressView {
  const seen = Math.max(0, Math.floor(seenIndex) - 1);
  const reached = Math.max(Number.isInteger(facts.reachedStep) ? (facts.reachedStep as number) : 0, seen);
  const p = roadmapProgress({ ...facts, reachedStep: reached });
  return {
    index: p.index,
    total: p.total,
    label: p.label,
    ratio: p.ratio,
    valueText: p.valueText,
    complete: p.complete,
    steps: stepsView(p.index, p.complete),
  };
}

/** O que a barra do próximo passo mostra: o rótulo do servidor/roteiro e o cartão do passo. */
export interface NextStep {
  task: RoadmapTask;
  label: string;
  cardKind: TaskCardKind | null;
}

export function nextStepFor(facts: RoadmapFacts): NextStep {
  const task = nextTask(facts);
  return { task, label: nextStepLabel(task), cardKind: taskCard(task) };
}

/** "Abrir o meu CRM" (fim da conversa, cabeçalho, tela de entrada): o Painel, nunca o assistente antigo. */
export const CRM_HOME_HREF = "/app/painel";

/**
 * Linha do resumo do funil ("Funil Atendimento com 5 etapas"). Sem "Funil Funil …" quando o nome
 * já começa com a palavra (o nome é do rascunho: texto puro, aparado).
 */
export function funnelSummaryLine(rawName: string, stageCount: number): string {
  const name = plainModelText(rawName).trim();
  const stages = `${stageCount} ${stageCount === 1 ? "etapa" : "etapas"}`;
  if (!name) return `Funil com ${stages}`;
  return /^funil\b/i.test(name) ? `${name} com ${stages}` : `Funil ${name} com ${stages}`;
}

/**
 * O que a barra do próximo passo faz agora (sempre um efeito visível, nunca um botão morto):
 * - `hidden`: o cartão do passo está na tela com o botão dele à vista (dois botões verdes competindo, não);
 * - `scroll`: o cartão existe na conversa, fora da área visível: rola até ele e o destaca;
 * - `request`: o cartão não está na conversa: pede ao servidor (evento `next`) e rola quando chegar;
 * - `focus`: não há cartão (contar sobre o negócio): leva ao campo de mensagem;
 * - `open_test`: o passo é testar: abre a tela de teste;
 * - `link`: fim (abre o CRM).
 */
export type NextStepMode = "hidden" | "scroll" | "request" | "focus" | "open_test" | "link";

export function nextStepMode(input: { task: string; cardKind: string | null; cardInTimeline: boolean; cardVisible: boolean; canOpenTest?: boolean }): NextStepMode {
  if (input.task === "done") return "link";
  // O cartão do passo, com o botão dele, está na tela: a barra sai (um botão verde só).
  if (input.cardKind && input.cardInTimeline && input.cardVisible) return "hidden";
  if (input.task === "test" && input.canOpenTest) return "open_test";
  if (!input.cardKind) return "focus";
  return input.cardInTimeline ? "scroll" : "request";
}

/** O cartão do tipo está na conversa (a ocorrência mais recente nunca é recolhida). */
export function timelineHasCard(timeline: readonly Pick<TimelineItem, "role" | "blocks">[], kind: string | null): boolean {
  if (!kind) return false;
  return timeline.some((t) => t.role === "assistant" && t.blocks.some((b) => blockKindOf(b) === kind));
}

/** O texto digitado é só o código de 6 dígitos do e-mail (com o e-mail ainda por confirmar, vale como o código). */
export function isBareEmailCode(text: string): boolean {
  return /^\d{6}$/.test(text.trim());
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
export const AI_PROCESSING_NOTICE_CORE = "A conversa é processada por IA de provedores parceiros, inclusive fora do Brasil.";
export const AI_PROCESSING_NOTICE = `${AI_PROCESSING_NOTICE_CORE} Não envie dados de clientes.`;

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

// ── Cartões sem repetição ───────────────────────────────────────────────────

/** Cartões que, repetidos na conversa, só aparecem inteiros na ocorrência mais recente. */
export const SUPERSEDABLE_KINDS: readonly string[] = [...DRAFT_CARD_KINDS, "ativarIa", "operacaoPronta", "cartaoConta"];

/** Cartões do fluxo antigo (histórico): fora da mensagem mais recente, aparecem recolhidos. */
export const LEGACY_ACTION_KINDS: readonly string[] = ["aplicarOperacao", "cartaoAceite"];

/** Chave estável de um bloco dentro da linha do tempo. */
export function blockKey(itemKey: string, index: number): string {
  return `${itemKey}:block:${index}`;
}

export function blockKindOf(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = (raw as { kind?: unknown }).kind;
  return typeof kind === "string" ? kind : null;
}

/**
 * Chaves (`blockKey`) dos blocos que NÃO devem aparecer inteiros: o mesmo tipo
 * de cartão aparece de novo mais abaixo (vale a ocorrência mais recente; o
 * histórico antigo de produção tem o funil várias vezes), ou é um cartão de
 * ação do fluxo antigo numa mensagem que não é a mais recente. Quem renderiza
 * troca estes blocos por uma linha recolhida, sem botões.
 */
export function supersededBlockKeys(timeline: readonly Pick<TimelineItem, "key" | "role" | "blocks">[]): Set<string> {
  const out = new Set<string>();
  const seen = new Set<string>();
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.role !== "assistant") continue;
    for (let b = item.blocks.length - 1; b >= 0; b--) {
      const kind = blockKindOf(item.blocks[b]);
      if (!kind) continue;
      if (SUPERSEDABLE_KINDS.includes(kind)) {
        if (seen.has(kind)) out.add(blockKey(item.key, b));
        else seen.add(kind);
      } else if (LEGACY_ACTION_KINDS.includes(kind) && i !== timeline.length - 1) {
        out.add(blockKey(item.key, b));
      }
    }
  }
  return out;
}

/** Nome do cartão na linha recolhida ("Funil de vendas · atualizado mais abaixo"). */
export const COLLAPSED_BLOCK_TITLE: Record<string, string> = {
  resumoNegocio: "Resumo do negócio",
  funilPreview: "Funil de vendas",
  personaCard: "Jeito de atender",
  conhecimentoLista: "O que a IA sabe",
  respostasRapidas: "Respostas rápidas",
  traducaoCartao: "Tradução automática",
  ativarIa: "Ativar a sua IA",
  operacaoPronta: "Operação pronta",
  cartaoConta: "Confirmação do e-mail",
  aplicarOperacao: "Montar a operação",
  cartaoAceite: "Ativar a IA",
};

export function collapsedBlockLine(kind: string): string {
  const title = COLLAPSED_BLOCK_TITLE[kind] ?? "Cartão";
  return LEGACY_ACTION_KINDS.includes(kind) ? `${title} · agora é feito no cartão mais recente` : `${title} · atualizado mais abaixo`;
}

/** O cartão do passo atual está na última mensagem da conversa (rolar até ele basta; senão pede de novo). */
export function cardIsLatest(timeline: readonly Pick<TimelineItem, "role" | "blocks">[], kind: string | null): boolean {
  if (!kind) return false;
  const last = timeline[timeline.length - 1];
  return !!last && last.role === "assistant" && last.blocks.some((b) => blockKindOf(b) === kind);
}

/** Hora de enviar o próximo arquivo guardado na fila (e-mail confirmado, ciência dada, conversa ociosa). */
export function pendingFileDrain(input: {
  emailVerified: boolean;
  noticeOk: boolean;
  idle: boolean;
  queued: number;
}): boolean {
  return input.emailVerified && input.noticeOk && input.idle && input.queued > 0;
}

/**
 * Decide se manda `process_pending` agora. `lastAttempt` = quantos materiais
 * pendentes havia na última tentativa (null = nenhuma): só tenta de novo se o
 * número CAIU desde então (sem laço infinito quando o servidor não consegue ler).
 */
export function shouldProcessPending(input: {
  emailVerified: boolean;
  noticeOk: boolean;
  idle: boolean;
  queued: number;
  pending: number;
  lastAttempt: number | null;
}): boolean {
  if (!input.emailVerified || !input.noticeOk || !input.idle || input.queued > 0) return false;
  if (input.pending <= 0) return false;
  return input.lastAttempt === null || input.pending < input.lastAttempt;
}
