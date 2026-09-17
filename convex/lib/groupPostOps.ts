/**
 * Operações compartilhadas das publicações programadas em grupo: agendamento
 * do worker, linha do tempo, pausa e encerramento.
 *
 * Vive em `lib/` pelo mesmo motivo de `lib/campaignHooks.ts`: a superfície do
 * app (`convex/groupPosts.ts`) e o worker (`convex/groupPostWorker.ts`)
 * precisam das MESMAS rotinas, e um importar o outro fecharia um ciclo de
 * módulos que degrada a inferência de tipos da API gerada.
 */
import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { appendPostTimeline } from "./groupPostCore";
import { describeSchedule, nextRun, type GroupPostSchedule } from "./groupPostSchedule";

/** A agenda gravada no doc já passou por `validateGroupPostSchedule`. */
export function scheduleOf(post: Doc<"groupPosts">): GroupPostSchedule {
  return post.schedule as GroupPostSchedule;
}

/**
 * Seed do jitter: o id da publicação. Duas publicações no mesmo horário não
 * saem no mesmo segundo, e a MESMA publicação recalcula sempre o mesmo desvio
 * para o mesmo slot (o `nextRunAt` sobrevive a um recálculo).
 */
export function jitterSeedOf(post: Doc<"groupPosts">): string {
  return post._id as unknown as string;
}

/**
 * Próximo disparo estritamente depois de `afterMs`, com a chave do slot-base
 * que o originou, ou `null` se a agenda acabou. Quem agenda grava OS DOIS
 * (`nextRunAt` + `nextSlotKey`): deduzir a chave do instante jitterado erra
 * quando dois horários estão a menos de `jitterMinutes` um do outro.
 */
export function computeNextRun(
  post: Doc<"groupPosts">,
  afterMs: number
): { at: number; slotKey: string } | null {
  return nextRun(scheduleOf(post), afterMs, { seed: jitterSeedOf(post) });
}

/** Só o instante do próximo disparo. */
export function computeNextRunAt(post: Doc<"groupPosts">, afterMs: number): number | null {
  return computeNextRun(post, afterMs)?.at ?? null;
}

/**
 * Quando o worker precisa acordar para um slot que dispara em `runAt`: na hora
 * do disparo, ou `generateMinutesBefore` antes dele quando o conteúdo é IA.
 */
export function wakeAtFor(post: Doc<"groupPosts">, runAt: number): number {
  if (post.content.kind !== "ai" || !post.content.ai) return runAt;
  const lead = Math.max(0, post.content.ai.generateMinutesBefore) * 60_000;
  return runAt - lead;
}

/**
 * Cancela o agendamento em voo e (re)agenda o tick com um token novo.
 * `at === null` desarma a publicação sem agendar nada (pausada/encerrada).
 *
 * Mesmo desenho de `scheduleCampaignTick`: o token é o anti-zumbi — um tick que
 * chegue com token velho (porque houve pausa e retomada no meio) sai sem fazer
 * nada em vez de disparar uma publicação que ninguém mais espera.
 */
export async function scheduleGroupPostTick(
  ctx: MutationCtx,
  post: Doc<"groupPosts">,
  at: number | null,
  now: number
): Promise<void> {
  if (post.schedulerFnId) {
    try {
      await ctx.scheduler.cancel(post.schedulerFnId as Id<"_scheduled_functions">);
    } catch {
      // já rodou
    }
  }
  if (at === null) {
    await ctx.db.patch(post._id, {
      schedulerFnId: undefined,
      tickToken: undefined,
      nextRunAt: undefined,
      nextSlotKey: undefined,
      updatedAt: now,
    });
    return;
  }
  const runAt = Math.max(at, now);
  const tickToken = `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const fnId = await ctx.scheduler.runAt(runAt, internal.groupPostWorker.tick, {
    groupPostId: post._id,
    tickToken,
  });
  await ctx.db.patch(post._id, {
    schedulerFnId: fnId as string,
    tickToken,
    updatedAt: now,
  });
}

export interface PostTimelineInput {
  at: number;
  kind: string;
  detail?: string;
  actorId?: Id<"teamMembers">;
  slotKey?: string;
  sends?: Array<{
    groupChatId: Id<"groupChats">;
    conversationId?: Id<"conversations">;
    messageId?: Id<"messages">;
    error?: string;
  }>;
}

/** Anexa uma entrada à linha do tempo da publicação (cap 100, FIFO). */
export async function addPostTimeline(
  ctx: MutationCtx,
  post: Doc<"groupPosts">,
  entry: PostTimelineInput
): Promise<void> {
  await ctx.db.patch(post._id, {
    timeline: appendPostTimeline(post.timeline, entry),
    updatedAt: entry.at,
  });
}

export async function postWebhook(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId,
    event,
    payload,
  });
}

/** Núcleo da pausa — usado pela UI e pelo worker (canal caído, grupo perdido). */
export async function pausePostCore(
  ctx: MutationCtx,
  post: Doc<"groupPosts">,
  args: { now: number; reason: string; actorId?: Id<"teamMembers">; automatic: boolean }
): Promise<void> {
  if (post.status === "ended") return;
  await scheduleGroupPostTick(ctx, post, null, args.now);
  await ctx.db.patch(post._id, {
    status: "paused",
    pausedReason: args.reason,
    pausedBy: args.actorId,
    updatedAt: args.now,
  });
  await addPostTimeline(ctx, (await ctx.db.get(post._id))!, {
    at: args.now,
    kind: "paused",
    detail: args.reason,
    actorId: args.actorId,
  });
  await ctx.db.insert("auditLogs", {
    organizationId: post.organizationId,
    entityType: "groupPost",
    entityId: post._id,
    action: "update",
    actorId: args.actorId,
    actorType: args.automatic ? "system" : "human",
    changes: { before: { status: post.status }, after: { status: "paused" } },
    metadata: { name: post.name, reason: args.reason, automatic: args.automatic },
    description: `Publicação programada '${post.name}' pausada — ${args.reason}`,
    severity: "medium",
    createdAt: args.now,
  });
  await postWebhook(ctx, post.organizationId, "group.post.paused", {
    groupPostId: post._id,
    name: post.name,
    reason: args.reason,
    automatic: args.automatic,
  });
}

/** Núcleo do encerramento (fim da agenda, ou decisão humana). */
export async function endPostCore(
  ctx: MutationCtx,
  post: Doc<"groupPosts">,
  args: { now: number; actorId?: Id<"teamMembers">; reason?: string }
): Promise<void> {
  if (post.status === "ended") return;
  await scheduleGroupPostTick(ctx, post, null, args.now);
  await ctx.db.patch(post._id, {
    status: "ended",
    endedAt: args.now,
    pending: undefined,
    updatedAt: args.now,
  });
  await addPostTimeline(ctx, (await ctx.db.get(post._id))!, {
    at: args.now,
    kind: "ended",
    detail: args.reason,
    actorId: args.actorId,
  });
  await ctx.db.insert("auditLogs", {
    organizationId: post.organizationId,
    entityType: "groupPost",
    entityId: post._id,
    action: "update",
    actorId: args.actorId,
    actorType: args.actorId ? "human" : "system",
    changes: { before: { status: post.status }, after: { status: "ended" } },
    metadata: { name: post.name, reason: args.reason },
    description: `Publicação programada '${post.name}' encerrada`,
    severity: "medium",
    createdAt: args.now,
  });
  await postWebhook(ctx, post.organizationId, "group.post.ended", {
    groupPostId: post._id,
    name: post.name,
    reason: args.reason,
    stats: post.stats,
  });
}

/** Descrição PT-BR da agenda (reexport para quem já importa este módulo). */
export { describeSchedule };
