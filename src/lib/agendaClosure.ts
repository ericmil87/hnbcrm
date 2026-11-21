/**
 * Agenda v2 (B3): regras PURAS da folha "Fechar hoje / Fechar um período / Reabrir" (contrato do PR #183).
 * A prévia usa o mesmo núcleo do commit: sala e equipamento são realocados sozinhos; profissional, tipo de
 * recurso e a org inteira viram conflito (profissional com até 3 sugestões); nada é cancelado. A tela manda
 * SEMPRE `expectedAffected` (a contagem vista) e, se o servidor recusar por diferença, refaz a prévia.
 */
import { ConvexError } from "convex/values";
import { fillVocab } from "./agendaCopy";
import { VIEWS_COPY } from "./agendaViewsCopy";
import { isValidLocalDate, diffLocalDays, shortDateLabel } from "./agendaZone";
import type { ResourceKind } from "./agendaTypes";

const t = VIEWS_COPY.closure;

export interface ClosureLine {
  appointmentId: string;
  resourceIds: string[];
  resourceNames: string[];
  startTime: number;
  localDate: string;
  serviceName: string;
  contactName?: string;
  partyKey?: string;
  outcome: "reallocated" | "conflict" | "skipped" | "unknown";
  toResourceName?: string;
  suggestions: readonly unknown[];
}

export interface ClosureResult {
  mode: "preview" | "commit";
  dates: string[];
  affected: number;
  reallocated: number;
  conflicts: number;
  pending: number;
  simulated: number;
  capped: boolean;
  runId?: string;
  removed: number;
  restorable: number;
  reason?: "covered_by_org_closure" | "nothing_to_reopen";
  items: ClosureLine[];
}

export interface ClosureRunLike {
  status: "running" | "done" | "failed";
  failure?: string;
  truncated?: boolean;
  total: number;
  totalIsPartial: boolean;
  processed: number;
  reallocated: number;
  conflicts: number;
  failed: number;
}

/** Só sala e equipamento são realocados sozinhos. */
export function movesAutomatically(kind: ResourceKind): boolean {
  return kind === "room" || kind === "equipment";
}

const plural = (n: number, one: string, many: string) => fillVocab(n === 1 ? one : many, { n });

export interface PreviewSummary {
  total: number;
  moved: number;
  unplaced: number;
  skipped: number;
  /** Fora da simulação (a prévia simula no máximo 40): "N a definir quando fechar". */
  unknown: number;
  /** Quem fecha não é realocado sozinho (profissional): tudo vira conflito. */
  noAutoMove: boolean;
  none: boolean;
  /** Frases da prévia, na ordem em que aparecem. */
  sentences: string[];
}

/** Resume a prévia em contagens e frases. `affected` é a contagem que vai em `expectedAffected`. */
export function summarizePreview(result: ClosureResult, o: { resourceName: string; kind: ResourceKind | null; org?: boolean }): PreviewSummary {
  const total = result.affected;
  const skipped = result.items.filter((i) => i.outcome === "skipped").length;
  const unknownLines = result.items.filter((i) => i.outcome === "unknown").length;
  const unknown = Math.max(unknownLines, Math.max(0, total - result.simulated));
  const noAutoMove = o.kind === null || !movesAutomatically(o.kind);
  const sentences: string[] = [];
  if (total > 0) {
    sentences.push(
      result.capped
        ? fillVocab(t.headlineAtLeast, { n: total, nome: o.resourceName })
        : fillVocab(total === 1 ? t.headline.one : t.headline.many, { n: total, nome: o.resourceName })
    );
    if (o.org) {
      sentences.push(fillVocab(total === 1 ? t.orgAll.one : t.orgAll.many, { n: total }));
    } else if (noAutoMove) {
      if (result.conflicts > 0) sentences.push(fillVocab(o.kind === "person" ? t.noAuto : t.noAutoGeneric, { n: result.conflicts }));
    } else {
      if (result.reallocated > 0) sentences.push(plural(result.reallocated, t.moves[o.kind === "equipment" ? "equipment" : "room"].one, t.moves[o.kind === "equipment" ? "equipment" : "room"].many));
      if (result.conflicts > 0) sentences.push(plural(result.conflicts, t.conflicts.one, t.conflicts.many));
    }
    if (skipped > 0) sentences.push(plural(skipped, t.skipped.one, t.skipped.many));
    if (unknown > 0) sentences.push(fillVocab(t.unknown, { n: unknown }));
  }
  return { total, moved: result.reallocated, unplaced: result.conflicts, skipped, unknown, noAutoMove, none: total === 0, sentences };
}

/** Rótulo do botão de confirmar: com afetados o aceite é explícito. */
export function confirmLabel(s: Pick<PreviewSummary, "total" | "moved" | "unplaced">, period?: string): string {
  const base = s.total === 0 ? t.confirm.plain : s.moved > 0 && s.unplaced === 0 ? fillVocab(t.confirm.move, { n: s.moved }) : t.confirm.anyway;
  return period ? `${base} em ${period}` : base;
}

/** "qui, 26/11" ou "qui, 26/11 a sex, 27/11"; com `today` o dia de hoje leva "(hoje)". */
export function periodText(from: string, to: string, today?: string): string {
  const one = (d: string) => (today === d ? fillVocab(t.todayMark, { data: shortDateLabel(d) }) : shortDateLabel(d));
  return from === to ? one(from) : `${one(from)} a ${one(to)}`;
}

/** O que acontece com um afetado, em texto (a cor nunca é o único sinal). */
export function lineOutcomeText(line: Pick<ClosureLine, "outcome" | "toResourceName" | "suggestions">): string {
  switch (line.outcome) {
    case "reallocated":
      return fillVocab(t.line.reallocated, { destino: line.toResourceName ?? "" }).trim();
    case "conflict":
      return line.suggestions.length > 0 ? plural(line.suggestions.length, t.line.conflictSuggestions.one, t.line.conflictSuggestions.many) : t.line.conflict;
    case "skipped":
      return t.line.skipped;
    default:
      return t.line.unknown;
  }
}

/** O servidor recusou porque a contagem mudou desde a prévia. */
export function isSituationChanged(error: unknown): boolean {
  if (!(error instanceof ConvexError)) return false;
  return typeof error.data === "string" && error.data.startsWith("A situação mudou");
}

/** Erro de período antes de pedir a prévia; `null` = válido. `today` é a data de hoje na org. */
export function validatePeriod(from: string, to: string, today: string): string | null {
  if (!isValidLocalDate(from) || !isValidLocalDate(to)) return t.errors.dates;
  if (diffLocalDays(from, to) < 0) return t.errors.order;
  if (diffLocalDays(today, from) < 0) return t.errors.past;
  return null;
}

export interface RunView {
  state: "running" | "done" | "incomplete";
  /** Texto de andamento ou resultado. */
  text: string;
  /** 0..1, ou `null` quando o total ainda é parcial. */
  progress: number | null;
}

/** Andamento e resultado de um fechamento em lotes (`getClosureRun`). `failed` e `truncated` = não terminou por inteiro. */
export function runView(run: ClosureRunLike): RunView {
  if (run.status === "failed" || run.truncated) return { state: "incomplete", text: t.run.incomplete, progress: null };
  if (run.status === "running") {
    const text = run.totalIsPartial
      ? fillVocab(t.run.runningPartial, { done: run.processed })
      : fillVocab(t.run.running, { done: run.processed, total: run.total });
    return { state: "running", text, progress: run.totalIsPartial || run.total === 0 ? null : Math.min(1, run.processed / run.total) };
  }
  const text =
    run.total === 0 && run.processed === 0
      ? t.run.doneNone
      : fillVocab(t.run.done, { moved: run.reallocated, conflicts: run.conflicts + run.failed });
  return { state: "done", text, progress: 1 };
}

/** Texto da tela de reabrir a partir do `reason` do servidor; `null` = há o que reabrir. */
export function reopenNotice(reason: ClosureResult["reason"]): string | null {
  if (reason === "covered_by_org_closure") return t.reopen.covered;
  if (reason === "nothing_to_reopen") return t.reopen.nothing;
  return null;
}

export const CLOSURE_REASONS = ["no_staff", "maintenance", "day_off", "holiday", "other"] as const;
export type ClosureReasonCode = (typeof CLOSURE_REASONS)[number];
