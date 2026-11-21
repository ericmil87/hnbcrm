/**
 * Agenda v2 (B3): regras PURAS da resolução de conflito (fila "Sem lugar"). O conflito vem de `listPending`
 * (`kind`, `resourceId?`, `suggestions?: {startTime, resourceIds}[]`); a ação vai para `resolveConflict`.
 */
import { ConvexError } from "convex/values";
import { fillVocab } from "./agendaCopy";
import { VIEWS_COPY } from "./agendaViewsCopy";
import type { ResourceKind } from "./agendaTypes";
import { zonedWhenPhrase } from "./agendaZone";

const t = VIEWS_COPY.conflict;

export type ConflictKind = "resource_closed" | "capacity" | "human_confirm" | "resource_removed";

export function conflictKindText(kind: string | undefined): string {
  return (kind && (t.kinds as Record<string, string>)[kind]) || "";
}

export interface ResourceLite {
  _id: string;
  kind: ResourceKind;
  name: string;
  active?: boolean;
}

/**
 * Recursos que podem substituir o que saiu: do MESMO tipo do recurso em conflito (sem ele, o tipo do primeiro
 * não alocado), ativos, e que o agendamento ainda não usa. O servidor decide se cabe (capacidade, horário).
 */
export function replacementCandidates(
  resources: readonly ResourceLite[],
  appointmentResources: ReadonlyArray<{ resourceId: string; allocated: boolean }>,
  conflictResourceId: string | undefined
): ResourceLite[] {
  const missingId = conflictResourceId ?? appointmentResources.find((r) => !r.allocated)?.resourceId;
  const kind = resources.find((r) => r._id === missingId)?.kind;
  if (!kind) return [];
  const used = new Set(appointmentResources.map((r) => r.resourceId));
  return resources.filter((r) => r.kind === kind && r.active !== false && !used.has(r._id) && r._id !== missingId);
}

export interface SuggestionRow {
  key: string;
  startTime: number;
  resourceIds: string[];
  label: string;
}

/** Sugestões do servidor como linhas "qua, 25/11 às 14:00 em Sala 2" (no fuso da org). */
export function suggestionRows(
  suggestions: ReadonlyArray<{ startTime: number; resourceIds: readonly string[] }> | undefined,
  resources: readonly ResourceLite[],
  tz: string
): SuggestionRow[] {
  const names = new Map(resources.map((r) => [r._id, r.name]));
  return (suggestions ?? []).map((s, i) => ({
    key: `${s.startTime}:${i}`,
    startTime: s.startTime,
    resourceIds: [...s.resourceIds],
    label: fillVocab(t.suggestionRow, {
      quando: zonedWhenPhrase(s.startTime, tz),
      onde: s.resourceIds.map((id) => names.get(id) ?? "").filter(Boolean).join(" · "),
    }).replace(/ em $/, ""),
  }));
}

export type ConflictAction =
  | { type: "resource"; resourceIds: string[] }
  | { type: "reschedule"; startTime: number; resourceIds?: string[] }
  | { type: "cancel"; reason?: string }
  | { type: "manual"; note?: string };

const clean = (s: string) => {
  const v = s.trim();
  return v.length > 0 ? v : undefined;
};

export const cancelAction = (reason: string): ConflictAction => ({ type: "cancel", reason: clean(reason) });
export const manualAction = (note: string): ConflictAction => ({ type: "manual", note: clean(note) });

/** Agendamento que o operador deixou "resolvido por fora": ativo, sem alocação, marcado `no_resource`. */
export function isManualNoPlace(a: { needsAttention?: { code: string } | undefined }): boolean {
  return a.needsAttention?.code === "no_resource";
}

/** Aprovar com recurso não alocado é recusado pelo servidor, exceto com a marca `no_resource`. */
export function mustResolveBeforeApprove(a: { resources: ReadonlyArray<{ allocated: boolean }>; needsAttention?: { code: string } | undefined }): boolean {
  return a.resources.some((r) => !r.allocated) && !isManualNoPlace(a);
}

/**
 * Mensagens das violações de um erro `sched_rules` (`ConvexError({ code, violations: [{ message }] })`), ou
 * `null` para qualquer outro erro. Leitor mínimo: importar `parseSchedRulesError` de `bookingFlow` criava um
 * chunk compartilhado que fazia o painel do Lead crescer.
 */
export function rulesErrorMessage(error: unknown): string | null {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (!data || typeof data !== "object" || (data as { code?: unknown }).code !== "sched_rules") return null;
  const list = (data as { violations?: unknown }).violations;
  if (!Array.isArray(list)) return null;
  const messages = list.map((v) => (v && typeof (v as { message?: unknown }).message === "string" ? (v as { message: string }).message : "")).filter(Boolean);
  return messages.length > 0 ? messages.join(" ") : null;
}
