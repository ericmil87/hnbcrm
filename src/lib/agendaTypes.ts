/**
 * Tipos do front para a Agenda v2 (agendamentos, recursos, serviços). Estruturais: descrevem o que as telas
 * precisam ler, NÃO dependem de `api.scheduling*` (as funções chegam em PRs paralelos). Quando uma query
 * real existir, o retorno dela deve ser atribuível a estes tipos; se não for, o contrato do backend mudou.
 * Os ids são os do `dataModel` (as tabelas `sched*` já existem), para passar direto às mutations.
 * Fonte dos enums: `convex/schema.ts` e plano da Agenda v2 §2.1.
 */
import type { Id } from "../../convex/_generated/dataModel";

export const APPOINTMENT_STATUSES = [
  "pending_approval",
  "scheduled",
  "confirmed",
  "checked_in",
  "completed",
  "no_show",
  "cancelled",
  "rescheduled",
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export const APPOINTMENT_ORIGINS = ["staff", "ai", "public", "api", "human_message", "waitlist", "import"] as const;
export type AppointmentOrigin = (typeof APPOINTMENT_ORIGINS)[number];

export const RESOURCE_KINDS = ["person", "room", "equipment"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/** "YYYY-MM-DD" no fuso da org. */
export type LocalDateKey = string;

export interface WeeklyInterval {
  /** 0 = domingo. */
  weekday: number;
  startMin: number;
  endMin: number;
}

export interface MinuteInterval {
  startMin: number;
  endMin: number;
}

export interface SchedResourceView {
  _id: Id<"schedResources">;
  kind: ResourceKind;
  name: string;
  /** Pessoa = 1; sala dupla = 2. */
  capacity: number;
  teamMemberId?: Id<"teamMembers">;
  weekly: WeeklyInterval[];
  tags?: string[];
  sortOrder: number;
  active: boolean;
}

export interface ServiceRequirementView {
  role: string;
  kind: ResourceKind;
  resourceIds?: Id<"schedResources">[];
  tag?: string;
  units?: number;
  exclusive?: boolean;
}

export interface ServiceVariantView {
  key: string;
  name: string;
  durationMin: number;
}

export interface SchedServiceView {
  _id: Id<"schedServices">;
  name: string;
  durationMin: number;
  variants?: ServiceVariantView[];
  bufferBeforeMin: number;
  bufferAfterMin: number;
  requirements: ServiceRequirementView[];
  slotIntervalMin?: number;
  aiBookable?: boolean;
  publicBookable?: boolean;
  priceCents?: number;
  sortOrder: number;
  active: boolean;
}

/** Recurso alocado a um agendamento (retrato para a grade; `allocated: false` = em conflito). */
export interface AppointmentResourceView {
  resourceId: Id<"schedResources">;
  role: string;
  name: string;
  allocated: boolean;
}

export interface SchedAppointmentView {
  _id: Id<"schedAppointments">;
  serviceId: Id<"schedServices">;
  serviceName: string;
  variantKey?: string;
  kind: "normal" | "fit_in" | "untimed";
  /** UTC ms. */
  startTime: number;
  endTime: number;
  localDate: LocalDateKey;
  status: AppointmentStatus;
  origin: AppointmentOrigin;
  contactId?: Id<"contacts">;
  leadId?: Id<"leads">;
  conversationId?: Id<"conversations">;
  contactName?: string;
  guestName?: string;
  resources: AppointmentResourceView[];
  notes?: string;
  needsAttention?: { code: string; at: number };
  /** Calculado no servidor para quem chama; ausente = pode (o servidor é a barreira). */
  canEdit?: boolean;
}
