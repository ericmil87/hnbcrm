import { ACTIVE_STATUSES, ALL_STATUSES, TERMINAL_STATUSES } from "../../convex/lib/schedStatus";
import { VOCAB } from "./vocab";
import { APPOINTMENT_ORIGINS, APPOINTMENT_STATUSES, type AppointmentOrigin, type AppointmentStatus } from "./agendaTypes";

/** Variante do `Badge` (tokens semânticos dos 4 temas). */
export type StatusTone = "default" | "brand" | "success" | "warning" | "error" | "info";

/** Parte de apresentação; `active` e `terminal` vêm do servidor (`convex/lib/schedStatus.ts`). */
type StatusPresentation = Omit<StatusMeta, "active" | "terminal">;

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** Ocupa horário (tem alocação no servidor). */
  active: boolean;
  /** Terminal no servidor (`TERMINAL_STATUSES`): cancelado, faltou, remarcado. Não ocupa mais o horário. */
  terminal: boolean;
  /** Fim de fluxo só para a tela: não há próxima etapa a oferecer (inclui Atendido, que ainda ocupa o horário). */
  final: boolean;
  /** Tracejado no bloco da grade (ainda não é certo). */
  dashed: boolean;
  /** Classes de token para o bloco da grade e a linha da lista: fundo suave + borda lateral. */
  blockClassName: string;
}

const block = (color: string, extra = "") => `border-l-4 ${extra} ${color}`.replace(/\s+/g, " ").trim();

const PRESENTATION: Record<AppointmentStatus, StatusPresentation> = {
  pending_approval: {
    label: VOCAB.scheduling.status.pending_approval, tone: "warning", final: false, dashed: true,
    blockClassName: block("border-semantic-warning bg-semantic-warning/10", "border-dashed"),
  },
  scheduled: {
    label: VOCAB.scheduling.status.scheduled, tone: "info", final: false, dashed: false,
    blockClassName: block("border-semantic-info bg-semantic-info/10"),
  },
  confirmed: {
    label: VOCAB.scheduling.status.confirmed, tone: "success", final: false, dashed: false,
    blockClassName: block("border-semantic-success bg-semantic-success/10"),
  },
  checked_in: {
    label: VOCAB.scheduling.status.checked_in, tone: "brand", final: false, dashed: false,
    blockClassName: block("border-brand-500 bg-brand-500/10"),
  },
  completed: {
    label: VOCAB.scheduling.status.completed, tone: "default", final: true, dashed: false,
    blockClassName: block("border-border-strong bg-surface-overlay"),
  },
  no_show: {
    label: VOCAB.scheduling.status.no_show, tone: "error", final: true, dashed: false,
    blockClassName: block("border-semantic-error bg-semantic-error/10"),
  },
  cancelled: {
    label: VOCAB.scheduling.status.cancelled, tone: "default", final: true, dashed: false,
    blockClassName: block("border-border-strong bg-surface-overlay opacity-70"),
  },
  rescheduled: {
    label: VOCAB.scheduling.status.rescheduled, tone: "default", final: true, dashed: false,
    blockClassName: block("border-border-strong bg-surface-overlay opacity-70"),
  },
};

export const APPOINTMENT_STATUS_META = Object.fromEntries(
  ALL_STATUSES.map((status) => [
    status,
    { ...PRESENTATION[status], active: ACTIVE_STATUSES.includes(status), terminal: TERMINAL_STATUSES.includes(status) },
  ])
) as Record<AppointmentStatus, StatusMeta>;

/** Status desconhecido (backend mais novo que o front) cai no `scheduled` em vez de quebrar a tela. */
export function statusMeta(status: string): StatusMeta {
  return (APPOINTMENT_STATUS_META as Record<string, StatusMeta | undefined>)[status] ?? APPOINTMENT_STATUS_META.scheduled;
}

/** `needsAttention.code` que o job diário grava na proposta que venceu sem decisão. */
export const PROPOSAL_EXPIRED_CODE = "proposal_expired";

/**
 * Proposta (aguardando aprovação) vencida: o horário já passou OU o servidor a marcou `proposal_expired`
 * (o job é diário, então a hora vale antes da marca). Vencida não se aprova: recusa-se ou marca-se de novo.
 */
export function isExpiredProposal(
  a: { status: string; startTime: number; needsAttention?: { code: string } | undefined },
  now: number
): boolean {
  return a.status === "pending_approval" && (a.needsAttention?.code === PROPOSAL_EXPIRED_CODE || a.startTime <= now);
}

/** Rótulo mostrado no lugar do status: "Vencida" para proposta vencida, senão o do status. */
export function statusLabelOf(a: { status: string; startTime: number; needsAttention?: { code: string } | undefined }, now: number): string {
  return isExpiredProposal(a, now) ? VOCAB.scheduling.proposalExpired : statusMeta(a.status).label;
}

export function isKnownStatus(status: string): status is AppointmentStatus {
  return (APPOINTMENT_STATUSES as readonly string[]).includes(status);
}

/** Agendamento que ainda ocupa horário. */
export function isActiveStatus(status: string): boolean {
  return statusMeta(status).active;
}

export type OriginBadgeKind = "ai" | "staff" | "link";

/** Selo de origem: `ai`/`waitlist` -> IA; `public` -> Link; o resto (equipe, API, mensagem do humano, importação) -> Equipe. */
export function originBadgeKind(origin: string): OriginBadgeKind {
  if (origin === "ai" || origin === "waitlist") return "ai";
  if (origin === "public") return "link";
  return "staff";
}

export function originLabel(origin: string): string {
  return VOCAB.scheduling.origin[originBadgeKind(origin)];
}

export function originHint(origin: string): string {
  return VOCAB.scheduling.originHint[originBadgeKind(origin)];
}

export function isKnownOrigin(origin: string): origin is AppointmentOrigin {
  return (APPOINTMENT_ORIGINS as readonly string[]).includes(origin);
}

export interface Vacancy {
  used: number;
  capacity: number;
  full: boolean;
  /** Mais alocações que a capacidade (conflito de dados): mostrado como erro. */
  over: boolean;
  /** "1/2". */
  label: string;
  /** "1 de 2 vagas ocupadas". */
  a11y: string;
}

/**
 * Vagas de um recurso num horário: "1/2". Capacidade inválida vira 1. O uso NÃO é limitado à capacidade:
 * sala de capacidade 1 com 2 alocações mostra "2/1" (acima da capacidade), nunca "1/1".
 */
export function vacancyOf(used: number, capacity: number): Vacancy {
  const cap = Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : 1;
  const u = Math.max(0, Number.isFinite(used) ? Math.floor(used) : 0);
  const over = u > cap;
  return {
    used: u,
    capacity: cap,
    full: u >= cap,
    over,
    label: `${u}/${cap}`,
    a11y: over
      ? `${u} de ${cap} ${cap === 1 ? "vaga" : "vagas"}: acima da capacidade`
      : `${u} de ${cap} ${cap === 1 ? "vaga ocupada" : "vagas ocupadas"}`,
  };
}
