import { VOCAB } from "./vocab";
import { APPOINTMENT_ORIGINS, APPOINTMENT_STATUSES, type AppointmentOrigin, type AppointmentStatus } from "./agendaTypes";

/** Variante do `Badge` (tokens semânticos dos 4 temas). */
export type StatusTone = "default" | "brand" | "success" | "warning" | "error" | "info";

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  /** Ocupa horário (tem alocação no servidor). */
  active: boolean;
  /** Terminal: não muda mais pelo fluxo normal. */
  terminal: boolean;
  /** Tracejado no bloco da grade (ainda não é certo). */
  dashed: boolean;
  /** Classes de token para o bloco da grade e a linha da lista: fundo suave + borda lateral. */
  blockClassName: string;
}

const block = (color: string, extra = "") => `border-l-4 ${extra} ${color}`.replace(/\s+/g, " ").trim();

export const APPOINTMENT_STATUS_META: Record<AppointmentStatus, StatusMeta> = {
  pending_approval: {
    label: VOCAB.scheduling.status.pending_approval, tone: "warning", active: true, terminal: false, dashed: true,
    blockClassName: block("border-semantic-warning bg-semantic-warning/10", "border-dashed"),
  },
  scheduled: {
    label: VOCAB.scheduling.status.scheduled, tone: "info", active: true, terminal: false, dashed: false,
    blockClassName: block("border-semantic-info bg-semantic-info/10"),
  },
  confirmed: {
    label: VOCAB.scheduling.status.confirmed, tone: "success", active: true, terminal: false, dashed: false,
    blockClassName: block("border-semantic-success bg-semantic-success/10"),
  },
  checked_in: {
    label: VOCAB.scheduling.status.checked_in, tone: "brand", active: true, terminal: false, dashed: false,
    blockClassName: block("border-brand-500 bg-brand-500/10"),
  },
  completed: {
    label: VOCAB.scheduling.status.completed, tone: "default", active: true, terminal: true, dashed: false,
    blockClassName: block("border-border-strong bg-surface-overlay"),
  },
  no_show: {
    label: VOCAB.scheduling.status.no_show, tone: "error", active: false, terminal: true, dashed: false,
    blockClassName: block("border-semantic-error bg-semantic-error/10"),
  },
  cancelled: {
    label: VOCAB.scheduling.status.cancelled, tone: "default", active: false, terminal: true, dashed: false,
    blockClassName: block("border-border-strong bg-surface-overlay opacity-70"),
  },
  rescheduled: {
    label: VOCAB.scheduling.status.rescheduled, tone: "default", active: false, terminal: true, dashed: false,
    blockClassName: block("border-border-strong bg-surface-overlay opacity-70"),
  },
};

/** Status desconhecido (backend mais novo que o front) cai no `scheduled` em vez de quebrar a tela. */
export function statusMeta(status: string): StatusMeta {
  return (APPOINTMENT_STATUS_META as Record<string, StatusMeta | undefined>)[status] ?? APPOINTMENT_STATUS_META.scheduled;
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
  /** "1/2". */
  label: string;
  /** "1 de 2 vagas ocupadas". */
  a11y: string;
}

/** Vagas de um recurso num horário: "1/2". Capacidade inválida vira 1; uso é limitado a 0..capacidade. */
export function vacancyOf(used: number, capacity: number): Vacancy {
  const cap = Number.isFinite(capacity) && capacity >= 1 ? Math.floor(capacity) : 1;
  const u = Math.max(0, Math.min(cap, Number.isFinite(used) ? Math.floor(used) : 0));
  return {
    used: u,
    capacity: cap,
    full: u >= cap,
    label: `${u}/${cap}`,
    a11y: `${u} de ${cap} ${cap === 1 ? "vaga ocupada" : "vagas ocupadas"}`,
  };
}
