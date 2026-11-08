/**
 * Dispatcher de canais (E1) — a "escada" de um aviso depois que o sino gravou.
 *
 * `createNotification` (`lib/notify.ts`) chama `dispatchNotificationChannels`
 * logo após o insert (ou o patch do agrupamento). Aqui cada canal externo
 * decide sozinho, sempre pela política única `shouldDeliver` (C1):
 *
 *  - Telegram: imediato, como antes do E1 (só mudou de arquivo).
 *  - Push: só agenda se o membro tem ALGUM aparelho vinculado (1 leitura
 *    indexada `pushSubscriptionMembers.by_member`, `.first()`) — sem
 *    assinatura, nenhum job. A entrega (`push.internalDeliverPush`) relê
 *    `readAt`: lido antes de sair = não envia.
 *  - E-mail: REDE DE SEGURANÇA para os tipos de `SAFETY_NET_EMAIL_CLASS`
 *    (+10 min atendimento / +30 min tarefas). O job é o mesmo
 *    `email.dispatchNotification`, com `onlyIfUnread`: se o aviso foi lido
 *    (em qualquer canal) ou resolvido até lá, não sai.
 *
 * Num PATCH de agrupamento, Telegram e push só saem quando o chamador pediu
 * (`telegramOnPatch`: a janela própria dele já agrupou — relay de 20 s,
 * rascunho novo); o e-mail nunca sai de patch (o do 1º evento já está agendado).
 *
 * Tempos da escada: SÓ aqui (decisão E1 do PLANO).
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { modulesOf } from "./orgModules";
import { hasTelegramTemplate } from "./telegramNotifications";
import { hasPushTemplate } from "./webPush";
import { shouldDeliver, type PolicyPrefs } from "./notificationPolicy";
import { orgDefaultsOf } from "./notificationPrefs";
import type { NotificationType } from "./notify";

const MINUTE = 60_000;

/** E1 — espera do e-mail de reserva por classe. */
export const EMAIL_SAFETY_NET_MS = {
  attendance: 10 * MINUTE,
  tasks: 30 * MINUTE,
} as const;
export type SafetyNetClass = keyof typeof EMAIL_SAFETY_NET_MS;

/**
 * `eventType` de e-mail que vira rede de segurança → classe. Os demais
 * (lead atribuído, canal desconectado, repasse resolvido, publicações, gasto
 * de IA, resumo diário, formulário) seguem saindo na hora, como antes.
 */
export const SAFETY_NET_EMAIL_CLASS: Readonly<Record<string, SafetyNetClass>> = {
  handoffRequested: "attendance",
  taskCommentMention: "attendance",
  taskAssigned: "tasks",
  taskDueSoon: "tasks",
  taskOverdue: "tasks",
  taskOverdueSummary: "tasks",
};

export function isSafetyNetEmail(eventType: string): boolean {
  return SAFETY_NET_EMAIL_CLASS[eventType] !== undefined;
}

/** Antecedência abaixo disto: o e-mail sai na hora (metade da janela já não ajuda ninguém). */
export const SAFETY_NET_MIN_LEAD_MS = 2 * MINUTE;

/**
 * Espera do e-mail de reserva. Com `deadlineAt` (prazo da tarefa) e
 * antecedência ≤ janela da reserva, espera METADE do que falta (lembrete
 * "vence em 15 min" sai em ~7 min, não no prazo); falta < 2 min = na hora.
 */
export function safetyNetDelayMs(eventType: string, now: number, deadlineAt?: number): number {
  const klass = SAFETY_NET_EMAIL_CLASS[eventType];
  const base = klass ? EMAIL_SAFETY_NET_MS[klass] : 0;
  if (deadlineAt === undefined) return base;
  const remaining = deadlineAt - now;
  if (remaining > base) return base;
  if (remaining < SAFETY_NET_MIN_LEAD_MS) return 0;
  return Math.min(base, Math.floor(remaining / 2));
}

export type EmailFallback = {
  eventType: string;
  templateData: Record<string, unknown>;
  /** Prazo da entidade: com pouca antecedência a espera vira metade do que falta (`safetyNetDelayMs`). */
  deadlineAt?: number;
};

/**
 * Agenda o e-mail de reserva de um ou mais avisos do mesmo membro (o resumo de
 * atrasadas cobre vários). Sem aviso gravado → sem e-mail (o membro não seria
 * destinatário de nenhum canal).
 */
export async function scheduleSafetyNetEmail(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    memberId: Id<"teamMembers">;
    notificationIds: Id<"notifications">[];
    now: number;
  } & EmailFallback
): Promise<void> {
  if (args.notificationIds.length === 0) return;
  await ctx.scheduler.runAfter(
    safetyNetDelayMs(args.eventType, args.now, args.deadlineAt),
    internal.email.dispatchNotification,
    {
      organizationId: args.organizationId,
      recipientMemberId: args.memberId,
      eventType: args.eventType,
      templateData: args.templateData,
      onlyIfUnread: args.notificationIds.slice(0, 50),
    }
  );
}

type Target = {
  organizationId: Id<"organizations">;
  memberId: Id<"teamMembers">;
  type: NotificationType;
};

export async function dispatchNotificationChannels(
  ctx: MutationCtx,
  args: Target & {
    notificationId: Id<"notifications">;
    now: number;
    prefs: PolicyPrefs | null;
    /** true = o aviso já existia e foi atualizado pelo agrupamento. */
    isPatch: boolean;
    /** No patch, Telegram e push saem (uma vez por janela do chamador). */
    externalOnPatch?: boolean;
    email?: EmailFallback;
  }
): Promise<void> {
  if (!args.isPatch || args.externalOnPatch) {
    await maybeScheduleTelegram(ctx, args);
    await maybeSchedulePush(ctx, args);
  }
  if (!args.isPatch && args.email && isSafetyNetEmail(args.email.eventType)) {
    await scheduleSafetyNetEmail(ctx, {
      organizationId: args.organizationId,
      memberId: args.memberId,
      notificationIds: [args.notificationId],
      now: args.now,
      ...args.email,
    });
  }
}

async function maybeScheduleTelegram(
  ctx: MutationCtx,
  args: Target & { notificationId: Id<"notifications">; now: number; prefs: PolicyPrefs | null }
): Promise<void> {
  // Telegram (F1, D7): o self-skip e a preferência do sino já valeram. Uma
  // leitura indexada do vínculo ativo; envio e formatação ficam na action
  // agendada (nada de rede numa mutation).
  if (!hasTelegramTemplate(args.type)) return;
  const link = await ctx.db
    .query("telegramLinks")
    .withIndex("by_member_and_status", (q) => q.eq("teamMemberId", args.memberId).eq("status", "active"))
    .first();
  if (!link || link.organizationId !== args.organizationId) return;
  // Switch do relay: vale só para o Telegram (o sino já gravou, B2).
  if (args.type === "new_message" && !link.prefs.relayAssignedConversations) return;
  const org = await ctx.db.get(args.organizationId);
  if (!modulesOf(org).telegram) return;
  // C1: política única — preferência por canal, pausa (`pausedUntil` + `mutedUntil` legado
  // do `/pausar`) e silêncio.
  const decision = shouldDeliver({
    type: args.type,
    channel: "telegram",
    prefs: args.prefs,
    orgDefaults: orgDefaultsOf(org),
    now: args.now,
    legacyMutedUntil: link.mutedUntil,
  });
  if (decision !== "deliver") return;
  await ctx.scheduler.runAfter(0, internal.telegram.internalDeliverNotification, { notificationId: args.notificationId });
}

async function maybeSchedulePush(
  ctx: MutationCtx,
  args: Target & { notificationId: Id<"notifications">; now: number; prefs: PolicyPrefs | null }
): Promise<void> {
  if (!hasPushTemplate(args.type)) return;
  // Gate de I/O: sem aparelho vinculado nesta membership, nada é agendado.
  const link = await ctx.db
    .query("pushSubscriptionMembers")
    .withIndex("by_member", (q) => q.eq("teamMemberId", args.memberId))
    .first();
  if (!link || link.organizationId !== args.organizationId) return;
  // Padrão da org só pesa quando o membro não tem preset próprio.
  const org = args.prefs?.preset ? null : await ctx.db.get(args.organizationId);
  const decision = shouldDeliver({
    type: args.type,
    channel: "push",
    prefs: args.prefs,
    orgDefaults: orgDefaultsOf(org),
    now: args.now,
  });
  if (decision !== "deliver") return;
  await ctx.scheduler.runAfter(0, internal.push.internalDeliverPush, { notificationId: args.notificationId });
}
