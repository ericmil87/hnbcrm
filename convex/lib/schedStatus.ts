/**
 * Agenda v2 — máquina de estados do agendamento (puro; §2.4 do plano).
 *
 * Ativos (têm linha em `schedAllocations`): pending_approval, scheduled,
 * confirmed, checked_in, completed. Terminais: cancelled, no_show, rescheduled.
 *
 * `canTransition` cobre as transições "para a frente". O DESFAZER (volta ao
 * estado anterior, só equipe) é `canUndo`: o destino é o estado anterior lido
 * da auditoria, por isso a validação é por par (de, para). `rescheduled` não
 * tem desfazer.
 *
 * Onde o plano diz "cliente", a IA falando em nome do cliente também passa
 * (`ai`): a política (`handoff`/`auto`) é regra de `schedRules`, não da
 * máquina. `system` cobre a mensagem do humano (aprovar/confirmar) e jobs.
 */

export type SchedStatus =
  | "pending_approval"
  | "scheduled"
  | "confirmed"
  | "checked_in"
  | "completed"
  | "no_show"
  | "cancelled"
  | "rescheduled";
export type ActorClass = "staff" | "client" | "ai" | "system";

export const ALL_STATUSES: readonly SchedStatus[] = [
  "pending_approval",
  "scheduled",
  "confirmed",
  "checked_in",
  "completed",
  "no_show",
  "cancelled",
  "rescheduled",
];
export const ACTIVE_STATUSES: readonly SchedStatus[] = [
  "pending_approval",
  "scheduled",
  "confirmed",
  "checked_in",
  "completed",
];
/** Estados em que o atendimento já devia ter acontecido e falta o desfecho (job "sem desfecho", A4). */
export const AWAITING_OUTCOME_STATUSES = ["scheduled", "confirmed", "checked_in"] as const satisfies readonly SchedStatus[];
export const TERMINAL_STATUSES: readonly SchedStatus[] = ["cancelled", "no_show", "rescheduled"];
/** Estados com os quais um agendamento nasce. */
export const INITIAL_STATUSES: readonly SchedStatus[] = ["pending_approval", "scheduled"];

export function isActiveStatus(s: SchedStatus): boolean {
  return ACTIVE_STATUSES.includes(s);
}
export function isTerminalStatus(s: SchedStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

type Rule = { from: SchedStatus[]; to: SchedStatus; actors: ActorClass[]; needsStarted?: boolean };

const ALL_ACTORS: ActorClass[] = ["staff", "client", "ai", "system"];

const FORWARD: Rule[] = [
  { from: ["pending_approval"], to: "scheduled", actors: ["staff", "system"] },
  { from: ["pending_approval"], to: "cancelled", actors: ["staff", "client", "ai"] },
  { from: ["scheduled"], to: "confirmed", actors: ["staff", "client", "ai", "system"] },
  { from: ["scheduled", "confirmed"], to: "checked_in", actors: ["staff"] },
  { from: ["scheduled", "confirmed", "checked_in"], to: "completed", actors: ["staff"] },
  { from: ["scheduled", "confirmed"], to: "no_show", actors: ["staff"], needsStarted: true },
  { from: ["scheduled", "confirmed"], to: "cancelled", actors: ["staff", "client", "ai"] },
  { from: ["scheduled", "confirmed", "pending_approval"], to: "rescheduled", actors: ALL_ACTORS },
];

export type TransitionCheck = { ok: true } | { ok: false; reason: "not_allowed" | "actor_not_allowed" | "no_show_before_start" };

/** Diagnóstico da transição (a mensagem PT-BR fica com quem chama). */
export function checkTransition(
  from: SchedStatus,
  to: SchedStatus,
  actor: ActorClass,
  now: number,
  startTime: number
): TransitionCheck {
  const rules = FORWARD.filter((r) => r.to === to && r.from.includes(from));
  if (rules.length === 0) return { ok: false, reason: "not_allowed" };
  const rule = rules.find((r) => r.actors.includes(actor));
  if (!rule) return { ok: false, reason: "actor_not_allowed" };
  if (rule.needsStarted && now < startTime) return { ok: false, reason: "no_show_before_start" };
  return { ok: true };
}

export function canTransition(from: SchedStatus, to: SchedStatus, actor: ActorClass, now: number, startTime: number): boolean {
  return checkTransition(from, to, actor, now, startTime).ok;
}

/** Destinos válidos do desfazer, por estado atual. `scheduled` e `rescheduled` não têm desfazer. */
export const UNDO_TARGETS: Partial<Record<SchedStatus, SchedStatus[]>> = {
  confirmed: ["scheduled"],
  checked_in: ["scheduled", "confirmed"],
  completed: ["scheduled", "confirmed", "checked_in"],
  no_show: ["scheduled", "confirmed"],
  cancelled: ["pending_approval", "scheduled", "confirmed"],
};

/** Desfazer: só equipe (`agenda:edit`), de um estado com desfazer para um estado anterior plausível. */
export function canUndo(from: SchedStatus, to: SchedStatus, actor: ActorClass): boolean {
  return actor === "staff" && (UNDO_TARGETS[from] ?? []).includes(to);
}

/** O que acontece com `schedAllocations` ao ir de `from` para `to`. */
export function allocationEffect(from: SchedStatus | null, to: SchedStatus): "create" | "keep" | "delete" | "recreate" | "none" {
  const fromActive = from !== null && isActiveStatus(from);
  const toActive = isActiveStatus(to);
  if (from === null) return toActive ? "create" : "none";
  if (fromActive && toActive) return "keep";
  if (fromActive && !toActive) return "delete";
  if (!fromActive && toActive) return "recreate"; // desfazer de no_show/cancelled
  return "none";
}
