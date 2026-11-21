/**
 * Agenda v2 (A3b): efeitos colaterais dos atos de marcação — `auditLogs`, `activities`, webhook
 * (`scheduleWebhookEvent`) e etapa do funil (`moveLeadToStageCore`). Irmão de `schedBookingOps.ts`.
 *
 * Este arquivo NÃO escreve em `schedAppointments` nem em `schedAllocations` (só a porta
 * `schedBookingOps.ts` escreve; guard `schedulingPort.test.ts`). Quem chama decide o que gravar no
 * agendamento a partir do que estas funções devolvem (ex.: etapa que falhou = `needsAttention`).
 *
 * Notificações: NENHUM tipo de notificação existe ainda para a agenda (o guard
 * `notificationTypesParity` exige as 5 pontas juntas). Os pontos de chamada ficam marcados no
 * `schedBookingOps.ts` com `NOTIFY:` para os PRs A3c/A4/D1.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { moveLeadToStageCore, type StageMoveActor } from "./leadStageMove";
import { formatSlotLabel, localDateOf, minutesOfDay } from "./schedTime";
import { scheduleWebhookEvent } from "./webhookDispatch";
import type { ActorClass } from "./schedStatus";

export type SchedActor =
  | { type: "human"; member: Doc<"teamMembers">; via?: "app" | "copilot" | "telegram" | "rest" | "mcp" }
  | { type: "ai"; member: Doc<"teamMembers">; conversationId: Id<"conversations"> }
  | { type: "system"; via: "human_message" | "public_link" | "job" };

/** Classe do ator para a máquina de estados (`schedStatus`). */
export function actorClassOf(actor: SchedActor): ActorClass {
  return actor.type === "human" ? "staff" : actor.type === "ai" ? "ai" : "system";
}

export function actorMemberId(actor: SchedActor): Id<"teamMembers"> | undefined {
  return actor.type === "system" ? undefined : actor.member._id;
}

/** `actorType` de `auditLogs`/`activities` (REST/MCP = "api"). */
export function recordActorTypeOf(actor: SchedActor): "human" | "ai" | "system" | "api" {
  if (actor.type === "ai") return "ai";
  if (actor.type === "system") return "system";
  return actor.via === "rest" || actor.via === "mcp" ? "api" : "human";
}

export function actorVia(actor: SchedActor): string {
  if (actor.type === "system") return actor.via;
  if (actor.type === "ai") return "attendant";
  return actor.via ?? "app";
}

function stageActorOf(actor: SchedActor): StageMoveActor {
  if (actor.type === "human") return { type: actor.via === "rest" || actor.via === "mcp" ? "api" : "human", memberId: actor.member._id };
  if (actor.type === "ai") return { type: "ai", memberId: actor.member._id };
  return { type: "automation" };
}

/** Retrato achatado para a auditoria (`_id` vira `id`; sem notas, sem nome de contato, sem texto de mensagem). */
export function appointmentSnapshot(a: Doc<"schedAppointments">): Record<string, unknown> {
  return {
    id: a._id,
    serviceId: a.serviceId,
    serviceName: a.serviceName,
    status: a.status,
    kind: a.kind,
    origin: a.origin,
    startTime: a.startTime,
    endTime: a.endTime,
    blockStart: a.blockStart,
    blockEnd: a.blockEnd,
    localDate: a.localDate,
    contactId: a.contactId,
    leadId: a.leadId,
    resources: a.resources.map((r) => ({ resourceId: r.resourceId, role: r.role, allocated: r.allocated })),
  };
}

export async function recordAppointmentAudit(
  ctx: MutationCtx,
  args: {
    appointment: Doc<"schedAppointments">;
    action: "create" | "update";
    actor: SchedActor;
    severity: "low" | "medium" | "high";
    description: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    now: number;
  }
): Promise<void> {
  const memberId = actorMemberId(args.actor);
  await ctx.db.insert("auditLogs", {
    organizationId: args.appointment.organizationId,
    entityType: "schedAppointment",
    entityId: args.appointment._id,
    action: args.action,
    ...(memberId ? { actorId: memberId } : {}),
    actorType: recordActorTypeOf(args.actor),
    ...(args.before || args.after ? { changes: { ...(args.before ? { before: args.before } : {}), ...(args.after ? { after: args.after } : {}) } } : {}),
    metadata: { via: actorVia(args.actor), origin: args.appointment.origin, ...(args.metadata ?? {}) },
    description: args.description,
    severity: args.severity,
    createdAt: args.now,
  });
}

/** `activities` só existe com lead (o campo é obrigatório na tabela). */
export async function recordAppointmentActivity(
  ctx: MutationCtx,
  args: {
    appointment: Doc<"schedAppointments">;
    type: "appointment_booked" | "appointment_changed" | "appointment_completed";
    content: string;
    actor: SchedActor;
    now: number;
  }
): Promise<void> {
  const leadId = args.appointment.leadId;
  if (!leadId) return;
  const memberId = actorMemberId(args.actor);
  await ctx.db.insert("activities", {
    organizationId: args.appointment.organizationId,
    leadId,
    type: args.type,
    ...(memberId ? { actorId: memberId } : {}),
    actorType: recordActorTypeOf(args.actor),
    content: args.content,
    metadata: { appointmentId: args.appointment._id, status: args.appointment.status },
    createdAt: args.now,
  });
}

/** "2026-11-27T14:30:00-03:00": ISO com o offset do fuso da org (início sempre em minuto inteiro). */
export function isoWithOffset(ms: number, tz: string): string {
  const date = localDateOf(ms, tz);
  const min = minutesOfDay(ms, tz);
  const [y, m, d] = date.split("-").map(Number);
  const minuteStart = Math.floor(ms / 60_000) * 60_000;
  const offsetMin = Math.round((Date.UTC(y, m - 1, d, 0, min) - minuteStart) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export type AppointmentWebhookEvent =
  | "appointment.created"
  | "appointment.approved"
  | "appointment.confirmed"
  | "appointment.rescheduled"
  | "appointment.cancelled"
  | "appointment.completed"
  | "appointment.no_show"
  | "appointment.needs_attention";

/** Payload do §3.8: sem telefone, e-mail nem notas. */
export async function emitAppointmentWebhook(
  ctx: MutationCtx,
  args: { event: AppointmentWebhookEvent; appointment: Doc<"schedAppointments">; tz: string; previousAppointmentId?: Id<"schedAppointments"> }
): Promise<void> {
  const a = args.appointment;
  const iso = isoWithOffset(a.startTime, args.tz);
  await scheduleWebhookEvent(ctx, {
    organizationId: a.organizationId,
    event: args.event,
    payload: {
      appointmentId: a._id,
      status: a.status,
      origin: a.origin,
      serviceName: a.serviceName,
      startsAt: iso,
      startsAtLocal: iso.slice(0, 16),
      timezone: args.tz,
      resources: a.resources.map((r) => ({ name: r.name, role: r.role })),
      ...(a.leadId ? { leadId: a.leadId } : {}),
      ...(a.contactId ? { contactId: a.contactId } : {}),
      ...(args.previousAppointmentId ? { previousAppointmentId: args.previousAppointmentId } : {}),
    },
  });
}

/** Texto curto "qui, 27/11/2026 às 14:30 (Sessão)" para `activities`/auditoria. */
export function appointmentLabel(a: Pick<Doc<"schedAppointments">, "startTime" | "serviceName">, tz: string): string {
  return `${formatSlotLabel(a.startTime, 0, tz)} (${a.serviceName})`;
}

export type FunnelOutcome = "moved" | "skipped" | "failed";

/**
 * §3.9: move o lead para a etapa configurada pela porta única de etapa. Etapa inválida, arquivada,
 * de outro funil, de perda, ou lead arquivado/fechado = `skipped`/`failed`, NUNCA derruba a marcação
 * (quem chama grava `needsAttention: stage_move_failed` quando `failed`).
 */
export async function moveFunnelStage(
  ctx: MutationCtx,
  args: { appointment: Doc<"schedAppointments">; stageId: Id<"stages"> | undefined; actor: SchedActor; now: number }
): Promise<FunnelOutcome> {
  const { appointment, stageId } = args;
  if (!stageId || !appointment.leadId) return "skipped";
  try {
    const [lead, stage] = await Promise.all([ctx.db.get(appointment.leadId), ctx.db.get(stageId)]);
    if (!lead || lead.organizationId !== appointment.organizationId) return "skipped";
    if (lead.archivedAt !== undefined || lead.closedType !== undefined) return "skipped";
    if (lead.stageId === stageId) return "skipped";
    if (!stage || stage.organizationId !== appointment.organizationId || stage.boardId !== lead.boardId) return "failed";
    if (stage.isClosedLost) return "failed"; // perda exige motivo: nunca automática
    await moveLeadToStageCore(ctx, {
      lead,
      newStageId: stageId,
      newStage: stage,
      actor: stageActorOf(args.actor),
      metadata: { via: "scheduling", appointmentId: appointment._id },
      now: args.now,
    });
    return "moved";
  } catch {
    // PREMISSA (travada por teste em schedBooking.test.ts, "etapa inválida não deixa escrita parcial"):
    // `moveLeadToStageCore` valida etapa/funil/org ANTES de qualquer escrita, então uma exceção aqui
    // não deixa patch, auditoria, atividade nem webhook pela metade. Se o núcleo passar a escrever
    // antes de validar, o teste falha e este catch precisa virar savepoint ou pré-validação.
    return "failed";
  }
}
