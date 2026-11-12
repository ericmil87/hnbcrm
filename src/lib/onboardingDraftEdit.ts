/**
 * Edição do Rascunho de Operação pelos cartões do onboarding (P3.3). PURO.
 *
 * Cada função devolve um rascunho novo (sem mutar o recebido) para a tela
 * mandar em `onboardingSessions.saveDraft` com `expectedVersion`. Quem manda
 * na validação, no filtro anti-instrução e nas liberações é o servidor: aqui
 * só se monta o pedido. Texto editado perde a liberação anterior (o servidor
 * também recalcula); a liberação é sempre `release: { reason }`, sem `by`/`at`.
 */
import { DRAFT_LIMITS, type OnboardingDraft } from "../../convex/lib/onboardingDraft";

export type DraftUpdate = (draft: OnboardingDraft) => OnboardingDraft;
export type Persona = OnboardingDraft["persona"];

/** Motivo mínimo para "Usar mesmo assim" (curto, mas não vazio nem um ponto). */
export const RELEASE_REASON_MIN = 5;
export const RELEASE_REASON_MAX = DRAFT_LIMITS.releaseReason;

export type ReasonCheck = { ok: true; reason: string } | { ok: false; message: string };

export function checkReleaseReason(raw: string): ReasonCheck {
  const reason = raw.replace(/\s+/g, " ").trim();
  if (reason.length < RELEASE_REASON_MIN) {
    return { ok: false, message: `Conte em poucas palavras por que está tudo bem (mínimo ${RELEASE_REASON_MIN} letras).` };
  }
  if (reason.length > RELEASE_REASON_MAX) {
    return { ok: false, message: `O motivo pode ter até ${RELEASE_REASON_MAX} caracteres.` };
  }
  return { ok: true, reason };
}

/** A mensagem do servidor para "rascunho mais novo gravado em outro lugar". */
export function isDraftConflictMessage(message: string): boolean {
  return /foi alterado em outro lugar/i.test(message);
}

export const DRAFT_CONFLICT_NOTICE =
  "O rascunho mudou enquanto você editava. Carreguei a versão mais nova: confira e ajuste de novo.";

const replaceAt = <T,>(list: readonly T[], index: number, next: T): T[] => list.map((x, i) => (i === index ? next : x));
const removeAt = <T,>(list: readonly T[], index: number): T[] => list.filter((_, i) => i !== index);

// ── Persona, tradução e negócio ─────────────────────────────────────────────

export const setPersona =
  (patch: Partial<Pick<Persona, "attendantName" | "tone" | "addressAs">>): DraftUpdate =>
  (d) => ({ ...d, persona: { ...d.persona, ...patch } });

export const setTranslation =
  (enabled: boolean): DraftUpdate =>
  (d) => ({ ...d, features: { ...d.features, translation: enabled } });

export const setBusiness =
  (patch: { name?: string; description?: string; city?: string }): DraftUpdate =>
  (d) => {
    const { release: _release, city: _city, ...base } = d.business;
    const changed =
      (patch.name !== undefined && patch.name !== d.business.name) ||
      (patch.description !== undefined && patch.description !== d.business.description) ||
      (patch.city !== undefined && (patch.city.trim() || undefined) !== d.business.city);
    const city = patch.city !== undefined ? patch.city.trim() || undefined : d.business.city;
    const next = {
      ...base,
      ...(changed ? {} : d.business.release ? { release: d.business.release } : {}),
      name: patch.name ?? d.business.name,
      description: patch.description ?? d.business.description,
      ...(city ? { city } : {}),
    };
    return { ...d, business: next };
  };

export const releaseBusiness =
  (reason: string): DraftUpdate =>
  (d) => ({ ...d, business: { ...d.business, release: { reason } } });

export const releaseGreeting =
  (reason: string): DraftUpdate =>
  (d) => (d.greeting ? { ...d, greeting: { ...d.greeting, release: { reason } } } : d);

// ── Conhecimento ────────────────────────────────────────────────────────────

export const setKnowledgeText =
  (index: number, text: string): DraftUpdate =>
  (d) => {
    const item = d.knowledge[index];
    if (!item || item.text === text) return d;
    const { release: _release, ...rest } = item;
    return { ...d, knowledge: replaceAt(d.knowledge, index, { ...rest, text }) };
  };

export const removeKnowledge =
  (index: number): DraftUpdate =>
  (d) => ({ ...d, knowledge: removeAt(d.knowledge, index) });

export const releaseKnowledge =
  (index: number, reason: string): DraftUpdate =>
  (d) => {
    const item = d.knowledge[index];
    return item ? { ...d, knowledge: replaceAt(d.knowledge, index, { ...item, release: { reason } }) } : d;
  };

/** Fato novo escrito pela pessoa (origem "Você contou"). */
export const addKnowledge =
  (text: string): DraftUpdate =>
  (d) => ({
    ...d,
    knowledge: [...d.knowledge, { text, origin: { kind: "usuario" as const }, suspicious: false }],
  });

// ── Respostas rápidas ───────────────────────────────────────────────────────

export const setQuickReply =
  (index: number, patch: { shortcut: string; text: string }): DraftUpdate =>
  (d) => {
    const item = d.quickReplies[index];
    if (!item || (item.shortcut === patch.shortcut && item.text === patch.text)) return d;
    const { release: _release, ...rest } = item;
    return { ...d, quickReplies: replaceAt(d.quickReplies, index, { ...rest, ...patch }) };
  };

export const removeQuickReply =
  (index: number): DraftUpdate =>
  (d) => ({ ...d, quickReplies: removeAt(d.quickReplies, index) });

export const releaseQuickReply =
  (index: number, reason: string): DraftUpdate =>
  (d) => {
    const item = d.quickReplies[index];
    return item ? { ...d, quickReplies: replaceAt(d.quickReplies, index, { ...item, release: { reason } }) } : d;
  };

// ── Funil ───────────────────────────────────────────────────────────────────

/** As etapas na ordem de exibição (`order`). */
export function orderedStages(d: OnboardingDraft): OnboardingDraft["funnel"]["stages"] {
  return d.funnel.stages
    .map((stage, at) => ({ stage, at }))
    .sort((a, b) => a.stage.order - b.stage.order || a.at - b.at)
    .map((x) => x.stage);
}

const renumber = (stages: OnboardingDraft["funnel"]["stages"]) => stages.map((s, i) => ({ ...s, order: i }));

export const setFunnelName =
  (name: string): DraftUpdate =>
  (d) => ({ ...d, funnel: { ...d.funnel, name } });

/** Renomeia a etapa na posição `position` (ordem de exibição). */
export const renameStage =
  (position: number, name: string): DraftUpdate =>
  (d) => {
    const sorted = renumber(orderedStages(d));
    if (!sorted[position]) return d;
    return { ...d, funnel: { ...d.funnel, stages: replaceAt(sorted, position, { ...sorted[position], name }) } };
  };

/** Move a etapa uma posição para cima (-1) ou para baixo (+1). A validação (1ª etapa aberta etc.) é do servidor. */
export const moveStage =
  (position: number, direction: -1 | 1): DraftUpdate =>
  (d) => {
    const sorted = renumber(orderedStages(d));
    const target = position + direction;
    if (!sorted[position] || !sorted[target]) return d;
    const next = [...sorted];
    [next[position], next[target]] = [next[target], next[position]];
    return { ...d, funnel: { ...d.funnel, stages: renumber(next) } };
  };

// ── Gravar com versão ───────────────────────────────────────────────────────

export type SaveSnapshot = { draft: OnboardingDraft; version: number };
export type SaveMutate = (args: { draft: OnboardingDraft; expectedVersion: number }) => Promise<unknown>;
export type SaveOutcome =
  | { ok: true }
  | { ok: false; reason: "no_draft" | "stale" | "conflict" | "error"; message: string };

/**
 * Grava uma edição sobre o rascunho atual. `baseVersion` é a versão que o
 * formulário tinha ao abrir: se o rascunho mudou desde então (a IA gravou na
 * conversa, outra aba) NÃO grava e avisa, para a tela recarregar os campos.
 * Conflito devolvido pelo servidor (corrida) vira o mesmo aviso.
 */
export async function saveDraftEdit(params: {
  current: SaveSnapshot | null;
  baseVersion: number;
  update: DraftUpdate;
  mutate: SaveMutate;
  errorMessage: (error: unknown) => string;
}): Promise<SaveOutcome> {
  const { current, baseVersion, update, mutate, errorMessage } = params;
  if (!current) return { ok: false, reason: "no_draft", message: "Ainda não há rascunho para ajustar." };
  if (current.version !== baseVersion) return { ok: false, reason: "stale", message: DRAFT_CONFLICT_NOTICE };
  try {
    await mutate({ draft: update(current.draft), expectedVersion: baseVersion });
    return { ok: true };
  } catch (error) {
    const message = errorMessage(error);
    if (isDraftConflictMessage(message)) return { ok: false, reason: "conflict", message: DRAFT_CONFLICT_NOTICE };
    return { ok: false, reason: "error", message };
  }
}
