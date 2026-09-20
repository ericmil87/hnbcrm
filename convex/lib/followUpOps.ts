/**
 * Núcleo compartilhado do FOLLOW-UP DA IA (v0.60) — tudo que `tasks.ts`,
 * `attendant.ts`, `whatsapp.ts`, `handoffs.ts`, `conversations.ts` e a cascata
 * de lead precisam tocar no ciclo de vida de um `aiFollowUps`.
 *
 * Vive em lib/ por causa de CICLO DE MÓDULOS: `tasks.ts` chama
 * `syncFollowUpForTask` a cada escrita de prazo/estado, e `attendantFollowUp.ts`
 * (que importa `attendant.ts` e `tasks.ts`) não pode ser importado por eles.
 * Este módulo nunca importa `tasks.ts`/`attendant.ts` — só `lib/taskOps.ts` e o
 * proxy de `_generated/api` para agendar.
 *
 * Princípio inegociável da feature: **um follow-up nunca some em silêncio**.
 * Todo caminho terminal da fila do atendente passa por aqui e devolve o
 * follow-up a `scheduled` ou o escala para um humano (`needs_human`), que é o
 * que fecha o P0.2 do gap analysis ("tarefa atribuída a membro IA é cosmética").
 */
import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { applyTaskCompletion, addTaskCommentCore, taskDeepLink } from "./taskOps";
import { createNotification, inboxRepliers } from "./notify";
import { appUrl as resolveAppUrl } from "./appUrl";

/** Estados em que o follow-up ainda "pertence" à IA. */
export const ACTIVE_FOLLOW_UP_STATUSES = ["scheduled", "queued", "drafted"] as const;
/** Estados encerrados — resolver de novo é no-op (idempotência). */
const TERMINAL_STATUSES = ["done", "not_needed", "needs_human", "canceled"] as const;

/** Teto de follow-ups pendentes por conversa (4.2) — anti-enxurrada. */
export const MAX_PENDING_FOLLOW_UPS = 3;
/** Adiamentos (fila ocupada / sessão instável) antes de escalar. */
export const MAX_DEFERRALS = 3;
/** Espera quando o turno REATIVO venceu a corrida (4.6). */
export const QUEUE_BUSY_DELAY_MS = 30 * 60 * 1000;
/** Jitter em MINUTOS: 300 conversas com "te chamo às 9h" não saem no mesmo minuto. */
export const FIRE_JITTER_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type FollowUpDoc = Doc<"aiFollowUps">;

export function isTerminalFollowUp(status: FollowUpDoc["status"]): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Chave do dia UTC dos contadores por canal (mesma convenção das campanhas). */
export function utcDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function dailyFollowUpCapReached(
  counter: { day: string; sent: number } | undefined | null,
  now: number,
  cap: number
): boolean {
  if (cap <= 0) return false; // 0 = sem teto
  if (!counter || counter.day !== utcDayKey(now)) return false;
  return counter.sent >= cap;
}

export function bumpDailyFollowUpCounter(
  counter: { day: string; sent: number } | undefined | null,
  now: number
): { day: string; sent: number } {
  const day = utcDayKey(now);
  return counter && counter.day === day ? { day, sent: counter.sent + 1 } : { day, sent: 1 };
}

export function nextUtcDayStart(now: number): number {
  return now - (now % DAY_MS) + DAY_MS;
}

/**
 * Conta +1 follow-up no NÚMERO (canal) desta conversa. Contado no ENVIO, não no
 * agendamento: agendar é barato e reversível; o que satura o cursor do canal (e
 * o que a Meta/WhatsApp vê) é a mensagem saindo.
 */
export async function bumpFollowUpChannelCounter(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  now: number
): Promise<void> {
  const channelConfigId = conversation.channelConfigId;
  if (!channelConfigId) return;
  const row = await ctx.db
    .query("channelPacing")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", channelConfigId))
    .first();
  if (row) {
    await ctx.db.patch(row._id, {
      followUpDaily: bumpDailyFollowUpCounter(row.followUpDaily, now),
    });
    return;
  }
  await ctx.db.insert("channelPacing", {
    organizationId: conversation.organizationId,
    channelConfigId,
    nextDispatchAt: now,
    followUpDaily: bumpDailyFollowUpCounter(undefined, now),
  });
}

// ── Armar / desarmar o disparo ──

/**
 * (Re)agenda o `fire`, cancelando o agendamento em voo. Mesmo desenho de
 * `scheduleGroupPostTick`: sem o cancelamento, remarcar a tarefa cinco vezes
 * deixaria cinco jobs vivos — e ainda que o guard `scheduled → queued` impeça o
 * envio duplo, cada um deles re-armaria o seguinte.
 *
 * O jitter é em MINUTOS de propósito (envio frio em lote satura o cursor do
 * canal); `withJitter: false` no "Executar agora", que é pedido de gente.
 */
export async function armFollowUp(
  ctx: MutationCtx,
  followUp: FollowUpDoc,
  at: number,
  now: number,
  opts?: { withJitter?: boolean }
): Promise<void> {
  if (followUp.schedulerFnId) {
    try {
      await ctx.scheduler.cancel(followUp.schedulerFnId as Id<"_scheduled_functions">);
    } catch {
      // já rodou / já foi cancelado
    }
  }
  const jitter =
    opts?.withJitter === false ? 0 : Math.floor(Math.random() * FIRE_JITTER_MS);
  const runAt = Math.max(at + jitter, now);
  const fnId = await ctx.scheduler.runAt(runAt, internal.attendantFollowUp.fire, {
    followUpId: followUp._id,
  });
  await ctx.db.patch(followUp._id, {
    schedulerFnId: fnId as unknown as string,
    // O instante para o qual ele está armado AGORA — é contra ISTO que o
    // `fire` detecta um job zumbi acordando antes da hora (ver o schema).
    nextFireAt: runAt,
    updatedAt: now,
  });
}

/**
 * Cancela o `runAt` em voo e ESQUECE o agendamento. Sempre que
 * `schedulerFnId` for zerado, tem de ser por aqui: zerar o campo sem cancelar
 * deixa um job órfão que acorda sozinho mais tarde (foi assim que o
 * "Executar agora" conseguia disparar a mensagem dias antes do combinado).
 */
export async function cancelArmedFollowUp(
  ctx: MutationCtx,
  followUp: FollowUpDoc
): Promise<void> {
  if (!followUp.schedulerFnId) return;
  try {
    await ctx.scheduler.cancel(followUp.schedulerFnId as Id<"_scheduled_functions">);
  } catch {
    // já rodou / já foi cancelado
  }
}

const cancelArmed = cancelArmedFollowUp;

// ── Leitura ──

export async function activeFollowUpForTask(
  ctx: { db: QueryCtx["db"] },
  taskId: Id<"tasks">
): Promise<FollowUpDoc | null> {
  const rows = await ctx.db
    .query("aiFollowUps")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
  return rows.find((f) => !isTerminalFollowUp(f.status)) ?? null;
}

export async function followUpForTask(
  ctx: { db: QueryCtx["db"] },
  taskId: Id<"tasks">
): Promise<FollowUpDoc | null> {
  const rows = await ctx.db
    .query("aiFollowUps")
    .withIndex("by_task", (q) => q.eq("taskId", taskId))
    .collect();
  if (rows.length === 0) return null;
  // O ativo manda; senão o mais recente (para a tarefa mostrar o desfecho).
  return (
    rows.find((f) => !isTerminalFollowUp(f.status)) ??
    rows.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  );
}

/** Follow-ups ainda "da IA" nesta conversa, do mais antigo para o mais novo. */
export async function pendingFollowUpsForConversation(
  ctx: { db: QueryCtx["db"] },
  conversationId: Id<"conversations">
): Promise<FollowUpDoc[]> {
  const out: FollowUpDoc[] = [];
  for (const status of ACTIVE_FOLLOW_UP_STATUSES) {
    const rows = await ctx.db
      .query("aiFollowUps")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversationId).eq("status", status)
      )
      .take(20);
    out.push(...rows);
  }
  return out.sort((a, b) => a.dueAt - b.dueAt);
}

/**
 * Anti-insistência: quantos follow-ups SEGUIDOS já saíram sem o cliente dizer
 * nada. Zera assim que existe inbound depois do último disparo.
 */
export async function computeChainIndex(
  ctx: { db: QueryCtx["db"] },
  conversationId: Id<"conversations">,
  lastInboundAt: number | undefined
): Promise<number> {
  const statuses = [
    ...ACTIVE_FOLLOW_UP_STATUSES,
    ...TERMINAL_STATUSES,
  ] as readonly FollowUpDoc["status"][];
  let latest: FollowUpDoc | null = null;
  for (const status of statuses) {
    const row = await ctx.db
      .query("aiFollowUps")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversationId).eq("status", status)
      )
      .order("desc")
      .first();
    if (row?.firedAt && (!latest || row.firedAt > (latest.firedAt ?? 0))) latest = row;
  }
  if (!latest?.firedAt) return 0;
  // O cliente falou depois do último disparo → a cadeia recomeça.
  if ((lastInboundAt ?? 0) > latest.firedAt) return 0;
  return latest.chainIndex + 1;
}

// ── Desfechos (ponto ÚNICO, 4.5) ──

export type FollowUpOutcome =
  /**
   * Mensagem ENTREGUE ao provider (ou rascunho aceito): conclui a tarefa.
   * `force` atravessa o guard de estado terminal — é o gancho de entrega
   * chegando DEPOIS de o watchdog ter escalado por demora: a mensagem saiu de
   * verdade, então a tarefa conclui mesmo assim.
   */
  | { kind: "done"; messageId?: Id<"messages">; detail?: string; force?: boolean }
  /** A IA releu a conversa e concluiu que não precisa mandar nada. */
  | { kind: "not_needed"; reason?: string }
  /** A IA (ou o cliente) remarcou. */
  | { kind: "reschedule"; dueAt: number; reason?: string }
  /** Rascunho no inbox aguardando um humano. */
  | { kind: "drafted"; draftMessageId: Id<"messages"> }
  /**
   * Não deu — a tarefa volta a ser de gente, com aviso no sino.
   * `actorId` é quem PROVOCOU a escalada (o humano que assumiu a conversa):
   * ele não recebe a notificação, porque acabou de agir.
   */
  | { kind: "needs_human"; reason: string; actorId?: Id<"teamMembers"> }
  /** Opt-out, conversa arquivada, tarefa cancelada, rascunho descartado. */
  | { kind: "canceled"; reason: string; reassignTo?: Id<"teamMembers"> };

/**
 * TODO caminho terminal do follow-up passa por aqui. Idempotente: follow-up já
 * encerrado não é reaberto (o gancho de entrega e o `acceptAiDraft` podem
 * resolver o mesmo follow-up, nessa ordem).
 */
export async function resolveFollowUpOutcome(
  ctx: MutationCtx,
  followUpId: Id<"aiFollowUps">,
  outcome: FollowUpOutcome
): Promise<void> {
  const followUp = await ctx.db.get(followUpId);
  if (!followUp) return;
  const lateDelivery = outcome.kind === "done" && outcome.force === true;
  if (isTerminalFollowUp(followUp.status) && !lateDelivery) return;
  // Entrega tardia só reabre o que o watchdog escalou por DEMORA, e só para a
  // mensagem que este follow-up de fato comprometeu.
  if (lateDelivery && isTerminalFollowUp(followUp.status)) {
    if (followUp.status !== "needs_human") return;
    if (outcome.kind === "done" && outcome.messageId && followUp.resultMessageId !== outcome.messageId) {
      return;
    }
  }

  const now = Date.now();
  const task = await ctx.db.get(followUp.taskId);
  const agent = await ctx.db.get(followUp.agentMemberId);
  // Motivo: código estável (a UI tem o mapa) + frase pronta para quem lê o doc
  // cru — comentário na tarefa, REST, notificação.
  const rawReason =
    outcome.kind === "needs_human" || outcome.kind === "canceled"
      ? outcome.reason
      : outcome.kind === "not_needed" || outcome.kind === "reschedule"
        ? outcome.reason
        : outcome.kind === "done"
          ? outcome.detail
          : undefined;
  const reasonCode = rawReason && isFollowUpReasonCode(rawReason) ? rawReason : undefined;
  const reasonText = rawReason
    ? reasonCode
      ? describeFollowUpReason(reasonCode)
      : rawReason
    : undefined;

  if (outcome.kind === "reschedule") {
    await ctx.db.patch(followUp._id, {
      status: "scheduled",
      dueAt: outcome.dueAt,
      queueItemId: undefined,
      reason: reasonText,
      reasonCode,
      updatedAt: now,
    });
    // A tarefa é a vitrine do "quando": sem isto a IA mandaria numa hora e a
    // equipe leria outra no /app/tarefas.
    if (task && task.dueDate !== outcome.dueAt) {
      await ctx.db.patch(task._id, {
        dueDate: outcome.dueAt,
        preDueReminderSentAt: undefined,
        updatedAt: now,
      });
    }
    await armFollowUp(ctx, (await ctx.db.get(followUp._id))!, outcome.dueAt, now);
    return;
  }

  if (outcome.kind === "drafted") {
    await ctx.db.patch(followUp._id, {
      status: "drafted",
      draftMessageId: outcome.draftMessageId,
      updatedAt: now,
    });
    return;
  }

  await cancelArmed(ctx, followUp);

  if (outcome.kind === "done" || outcome.kind === "not_needed") {
    await ctx.db.patch(followUp._id, {
      status: outcome.kind,
      ...(outcome.kind === "done" && outcome.messageId
        ? { resultMessageId: outcome.messageId }
        : {}),
      reason: reasonText,
      reasonCode,
      schedulerFnId: undefined,
      nextFireAt: undefined,
      updatedAt: now,
    });

    if (task && agent && task.status !== "completed" && task.status !== "cancelled") {
      // Exceção DECLARADA ao princípio "agente nunca marca completed sozinho"
      // (VIKUNJA-GAP-ANALYSIS.md): esta tarefa foi criada PELA IA para si
      // mesma, e concluí-la é o registro do que ela fez.
      await applyTaskCompletion(ctx, task, agent, now);
      const link =
        outcome.kind === "done"
          ? ` — ver a conversa: ${resolveAppUrl()}/app/entrada?conversation=${followUp.conversationId}`
          : "";
      await addTaskCommentCore(ctx, {
        task,
        author: agent,
        content:
          outcome.kind === "done"
            ? `Follow-up executado pela IA${reasonText ? `: ${reasonText}` : ""}${link}`
            : `A IA reavaliou a conversa e não foi preciso mandar mensagem${
                reasonText ? `: ${reasonText}` : ""
              }`,
      });
    }

    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: followUp.organizationId,
      event: "task.followup_executed",
      payload: {
        followUpId: followUp._id,
        taskId: followUp.taskId,
        conversationId: followUp.conversationId,
        leadId: followUp.leadId,
        outcome: outcome.kind,
        messageId: outcome.kind === "done" ? outcome.messageId : undefined,
      },
    });
    return;
  }

  if (outcome.kind === "canceled") {
    await ctx.db.patch(followUp._id, {
      status: "canceled",
      reason: reasonText,
      reasonCode,
      schedulerFnId: undefined,
      nextFireAt: undefined,
      queueItemId: undefined,
      updatedAt: now,
    });
    if (task && outcome.reassignTo) {
      const target = await ctx.db.get(outcome.reassignTo);
      if (target && target.organizationId === followUp.organizationId) {
        await ctx.db.patch(task._id, {
          assignedTo: target._id,
          assigneeIds: [target._id],
          updatedAt: now,
        });
      }
    }
    return;
  }

  // needs_human — a tarefa deixa de ser da IA e alguém é avisado.
  await ctx.db.patch(followUp._id, {
    status: "needs_human",
    reason: reasonText,
    reasonCode,
    schedulerFnId: undefined,
    nextFireAt: undefined,
    queueItemId: undefined,
    updatedAt: now,
  });

  const lead = await ctx.db.get(followUp.leadId);
  const owner = lead?.assignedTo ? await ctx.db.get(lead.assignedTo) : null;
  const humanOwner = owner && owner.type === "human" ? owner : null;

  if (task && task.status !== "completed" && task.status !== "cancelled") {
    await ctx.db.patch(task._id, {
      // Sem dono humano a tarefa fica SEM responsável de propósito: continuar
      // atribuída ao membro IA é exatamente a tarefa-zumbi que a feature veio
      // matar. Quem vê é o sino (broadcast abaixo) e a lista de tarefas sem
      // responsável.
      assignedTo: humanOwner?._id,
      assigneeIds: humanOwner ? [humanOwner._id] : [],
      updatedAt: now,
    });
    if (agent) {
      await addTaskCommentCore(ctx, {
        task,
        author: agent,
        content: `A IA não conseguiu fazer este follow-up: ${reasonText ?? describeFollowUpReason("")}. A tarefa voltou para a equipe.`,
      });
    }
  }

  const notification = {
    organizationId: followUp.organizationId,
    type: "ai_followup_needs_human" as const,
    title: "A IA não conseguiu fazer o follow-up",
    body: `${task?.title ?? "Follow-up"} — ${reasonText ?? describeFollowUpReason("")}`,
    taskId: followUp.taskId,
    conversationId: followUp.conversationId,
    // Quem PROVOCOU a escalada: com `actorId` igual ao destinatário,
    // `createNotification` vira no-op — quem acabou de assumir a conversa não
    // precisa de um aviso sobre a própria ação.
    actorId: outcome.kind === "needs_human" && outcome.actorId
      ? outcome.actorId
      : followUp.agentMemberId,
  };
  if (humanOwner) {
    await createNotification(ctx, { ...notification, memberId: humanOwner._id });
  } else {
    // Mesmo destinatário de `createHandoffCore` sem `toMemberId`.
    for (const replier of await inboxRepliers(ctx, followUp.organizationId)) {
      await createNotification(ctx, { ...notification, memberId: replier._id });
    }
  }

  await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
    organizationId: followUp.organizationId,
    event: "task.followup_needs_human",
    payload: {
      followUpId: followUp._id,
      taskId: followUp.taskId,
      conversationId: followUp.conversationId,
      leadId: followUp.leadId,
      reason: reasonText,
      reasonCode,
      assignedTo: humanOwner?._id,
    },
  });
}

// ── Sincronia tarefa → follow-up (4.1) ──

/**
 * A TAREFA é a fonte do "quando" e do "de quem". Chamado em UMA linha por todo
 * escritor de `tasks` (update, snooze, cancel, delete, complete, assign, bulk).
 *
 * Regras: prazo mudou → re-arma; concluída/cancelada/excluída por gente →
 * `canceled`; responsável deixou de ser o atendente → `canceled` (virou tarefa
 * humana normal); prazo apagado → `canceled`.
 *
 * REDE DE SEGURANÇA: o `fire` relê a tarefa e aplica as MESMAS regras, então um
 * escritor esquecido aqui nunca causa envio indevido — só atraso.
 */
export async function syncFollowUpForTask(
  ctx: MutationCtx,
  taskId: Id<"tasks">
): Promise<void> {
  const followUp = await activeFollowUpForTask(ctx, taskId);
  if (!followUp) return;

  const task = await ctx.db.get(taskId);
  if (!task) {
    await resolveFollowUpOutcome(ctx, followUp._id, { kind: "canceled", reason: "tarefa_excluida" });
    return;
  }
  if (task.status === "completed" || task.status === "cancelled") {
    await resolveFollowUpOutcome(ctx, followUp._id, {
      kind: "canceled",
      reason: task.status === "completed" ? "tarefa_concluida" : "tarefa_cancelada",
    });
    return;
  }
  if (task.assignedTo !== followUp.agentMemberId) {
    await resolveFollowUpOutcome(ctx, followUp._id, { kind: "canceled", reason: "tarefa_de_outro" });
    return;
  }
  if (task.dueDate === undefined) {
    await resolveFollowUpOutcome(ctx, followUp._id, {
      kind: "canceled",
      reason: "tarefa_sem_prazo",
    });
    return;
  }
  if (task.dueDate !== followUp.dueAt) {
    const now = Date.now();
    // Só re-arma o que ainda está esperando: um follow-up já na fila (`queued`)
    // ou com rascunho no inbox (`drafted`) tem um turno vivo do outro lado.
    await ctx.db.patch(followUp._id, { dueAt: task.dueDate, updatedAt: now });
    if (followUp.status === "scheduled") {
      await armFollowUp(ctx, (await ctx.db.get(followUp._id))!, task.dueDate, now);
    }
  }
}

/**
 * Tarefa prestes a ser EXCLUÍDA: cancela o follow-up ANTES do delete. Depois
 * não haveria doc para cancelar o `runAt` em voo, e o `fire` acordaria para uma
 * tarefa inexistente (o guard dele resolveria, mas com um job zumbi por dia).
 */
export async function resolveFollowUpForDeletedTask(
  ctx: MutationCtx,
  taskId: Id<"tasks">
): Promise<void> {
  const followUp = await activeFollowUpForTask(ctx, taskId);
  if (!followUp) return;
  await resolveFollowUpOutcome(ctx, followUp._id, { kind: "canceled", reason: "tarefa_excluida" });
}

/** Tarefa com follow-up ativo não aceita recorrência (v1). */
export async function assertNoActiveFollowUpForRecurrence(
  ctx: { db: QueryCtx["db"] },
  taskId: Id<"tasks">
): Promise<void> {
  const followUp = await activeFollowUpForTask(ctx, taskId);
  if (followUp) {
    throw new Error(
      "Esta tarefa é um follow-up que a IA vai executar — remova a execução automática antes de torná-la recorrente"
    );
  }
}

// ── Ganchos da FILA do atendente (4.6) ──

/**
 * Motivos de saída da fila que NÃO são culpa de ninguém: o follow-up volta a
 * esperar. Qualquer outro motivo escala (`needs_human`) — é o que garante que
 * nada some em silêncio.
 */
const RESCHEDULE_REASONS = new Set([
  "cliente_falou",
  "lock_perdido",
  "nao_pendente",
  "rascunho_ja_revisado",
  "aguardando_transcricao",
]);
const CANCEL_REASONS = new Set(["opt_out", "conversa_removida"]);

/**
 * Motivo técnico → frase que a equipe entende no sino, na tarefa e na tela.
 *
 * TODO código que pode chegar aqui precisa estar neste mapa: o `default` é uma
 * frase genérica, e um token cru ("teto_conversa") numa notificação é lixo na
 * cara de quem abriu o sino. A lista é EXPORTADA porque o frontend mantém o
 * mapa dele (`src/lib/followUp.ts`) sobre os mesmos códigos.
 */
const FOLLOW_UP_REASONS: Record<string, string> = {
  // ── Elegibilidade do atendente (convex/attendant.ts) ──
  conversa_de_grupo: "a conversa virou uma sala de grupo",
  ia_desativada: "a IA da organização foi desligada",
  atendente_desativado: "o atendente IA foi desligado",
  sem_atendente: "não há atendente IA ativo para este canal",
  ia_pausada: "a conversa está com um humano",
  handoff_pendente: "há um repasse em aberto",
  lead_de_humano: "o lead passou a ser de um humano",
  opt_out: "o contato pediu para não receber mensagens",
  fora_do_horario: "está fora do horário de atendimento",
  teto_conversa: "o teto de respostas desta conversa foi atingido",
  teto_hora: "o teto de respostas por hora foi atingido",
  bridge_sem_aceite: "o canal não tem o aceite de risco do WhatsApp não oficial",
  janela_24h: "a janela de 24h do WhatsApp está fechada",
  // ── Fila do atendente ──
  budget_mensal: "o teto mensal de conversas com IA foi atingido",
  conversa_removida: "a conversa não existe mais",
  nao_pendente: "o turno da IA já havia sido processado",
  lock_perdido: "outro turno da IA assumiu a conversa",
  rascunho_ja_revisado: "o rascunho de origem já havia sido revisado",
  humano_respondeu: "um humano respondeu na conversa",
  cliente_falou: "o cliente escreveu antes da hora do follow-up",
  aguardando_transcricao: "a IA ainda estava lendo uma mídia da conversa",
  follow_up_resolvido: "o follow-up já havia sido resolvido",
  follow_up_ja_enviado: "a mensagem deste follow-up já havia sido enviada",
  // ── Cadeia de guardas do disparo ──
  modo_desligado: "a execução automática de follow-ups está desligada",
  lead_arquivado: "o lead foi arquivado",
  conversa_arquivada: "a conversa foi arquivada",
  tarefa_excluida: "a tarefa foi excluída",
  tarefa_concluida: "a tarefa já estava concluída",
  tarefa_cancelada: "a tarefa foi cancelada",
  tarefa_de_outro: "a tarefa passou a ser de outro responsável",
  tarefa_sem_prazo: "a tarefa ficou sem prazo",
  conversa_sem_mensagens: "a conversa não tem mensagens",
  bridge_offline: "o número do WhatsApp está desconectado",
  fila_ocupada: "a conversa ficou ocupada com o atendimento normal",
  cadeia_maxima: "o cliente não respondeu aos follow-ups anteriores",
  teto_diario: "o teto diário de follow-ups deste número foi atingido",
  disparo_antecipado: "o disparo acordou antes da hora remarcada",
  adiada_pela_equipe: "a equipe adiou a tarefa",
  // ── Turno e entrega ──
  modelo_sem_resposta: "a IA não produziu nem mensagem nem decisão",
  falha_tecnica: "falha técnica na geração da resposta",
  falha_envio: "o WhatsApp recusou o envio",
  envio_sem_confirmacao: "a mensagem foi enviada, mas não houve confirmação de entrega",
  // ── Guardas de estado ──
  humano_assumiu: "um humano assumiu a conversa",
  lead_excluido: "o lead foi excluído",
  // ── Resultados não-terminais do disparo (aparecem no "Executar agora") ──
  nao_agendado: "este follow-up já está sendo processado",
  remarcado: "o prazo da tarefa mudou e o disparo foi reagendado",
  tarefa_nao_pendente: "a tarefa não está mais pendente",
  follow_up_inexistente: "o follow-up não existe mais",
  fora_da_janela: "está fora da janela de horário do follow-up",
};

/** Códigos estáveis de motivo — o frontend mapeia os mesmos. */
export const FOLLOW_UP_REASON_CODES = Object.keys(FOLLOW_UP_REASONS);

export function isFollowUpReasonCode(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(FOLLOW_UP_REASONS, value);
}

export function describeFollowUpReason(reason: string): string {
  return FOLLOW_UP_REASONS[reason] ?? "a IA não conseguiu concluir este follow-up";
}

/**
 * Chamado por TODAS as saídas terminais da fila (skip no claim,
 * `internalMarkItemSkipped`, falha final, descarte de rascunho). Sem isto a
 * tarefa fica órfã em `queued` para sempre — era um dos cinco furos que a
 * revisão adversarial encontrou.
 */
export async function releaseFollowUpFromQueue(
  ctx: MutationCtx,
  item: Doc<"aiReplyQueue"> | null | undefined,
  reason: string
): Promise<void> {
  if (!item?.followUpId) return;
  const followUp = await ctx.db.get(item.followUpId);
  if (!followUp || isTerminalFollowUp(followUp.status)) return;

  if (CANCEL_REASONS.has(reason)) {
    await resolveFollowUpOutcome(ctx, followUp._id, { kind: "canceled", reason });
    return;
  }
  if (RESCHEDULE_REASONS.has(reason)) {
    await resolveFollowUpOutcome(ctx, followUp._id, {
      kind: "reschedule",
      dueAt: Date.now() + QUEUE_BUSY_DELAY_MS,
      reason,
    });
    return;
  }
  await resolveFollowUpOutcome(ctx, followUp._id, { kind: "needs_human", reason });
}

/**
 * Coalescing (4.6): um turno REATIVO (inbound do cliente) ou INSTRUÍDO (humano)
 * sequestraria o item `follow_up` pendente e rodaria com o prompt errado — e
 * concluiria a tarefa sem ter feito o follow-up. Aqui o item volta a ser um
 * turno normal e o follow-up volta para a fila de espera, NA MESMA TRANSAÇÃO.
 */
export async function yieldFollowUpItemToReactiveTurn(
  ctx: MutationCtx,
  item: Doc<"aiReplyQueue">,
  now: number
): Promise<void> {
  if (item.origin !== "follow_up") return;
  const followUpId = item.followUpId;
  await ctx.db.patch(item._id, {
    origin: undefined,
    followUpId: undefined,
    updatedAt: now,
  });
  if (!followUpId) return;
  const followUp = await ctx.db.get(followUpId);
  if (!followUp || isTerminalFollowUp(followUp.status)) return;
  await resolveFollowUpOutcome(ctx, followUpId, {
    kind: "reschedule",
    dueAt: now + QUEUE_BUSY_DELAY_MS,
    reason: "cliente_falou",
  });
}

// ── Gancho de ENTREGA (4.5) ──

/**
 * Commit ≠ entregue: `internalCommitAiReply` só AGENDA o dispatch. A tarefa só
 * conclui quando o provider aceitou a mensagem — e falha de envio (número caiu,
 * 131026) tem de virar `needs_human`, não uma tarefa concluída sem mensagem.
 */
export async function applyFollowUpDeliveryUpdate(
  ctx: MutationCtx,
  args: { messageId: Id<"messages">; ok: boolean; detail?: string }
): Promise<void> {
  const message = await ctx.db.get(args.messageId);
  const marker = message?.metadata?.followUp as { followUpId?: string } | undefined;
  if (!marker?.followUpId) return;
  const followUpId = marker.followUpId as Id<"aiFollowUps">;
  const followUp = await ctx.db.get(followUpId);
  if (!followUp) return;
  // Estado terminal: só a ENTREGA CONFIRMADA da própria mensagem reabre — e só
  // a partir de `needs_human`, que é onde o watchdog coloca quem demorou.
  if (isTerminalFollowUp(followUp.status)) {
    const lateOk =
      args.ok &&
      followUp.status === "needs_human" &&
      followUp.resultMessageId === args.messageId;
    if (!lateOk) return;
  }

  if (args.ok) {
    await resolveFollowUpOutcome(ctx, followUpId, {
      kind: "done",
      messageId: args.messageId,
      // `force`: a entrega pode chegar DEPOIS de o watchdog ter escalado por
      // demora (cursor do canal, congelamento por qualidade). A mensagem saiu
      // de verdade — a tarefa conclui mesmo assim.
      force: true,
    });
    return;
  }
  await resolveFollowUpOutcome(ctx, followUpId, {
    kind: "needs_human",
    reason: args.detail ? `${describeFollowUpReason("falha_envio")} (${args.detail})` : "falha_envio",
  });
}

// ── Guardas de estado (4.6) ──

/**
 * Humano assumiu a conversa (aceitar repasse / "Assumir conversa") ou ela foi
 * arquivada: os follow-ups da IA daquela conversa viram tarefa de gente.
 * Cap de 10 por transação — mais do que isso é patologia, não uso.
 */
export async function escalateFollowUpsOfConversation(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  reason: string,
  opts?: { assignTo?: Id<"teamMembers"> }
): Promise<number> {
  const pending = (await pendingFollowUpsForConversation(ctx, conversationId)).slice(0, 10);
  for (const followUp of pending) {
    await resolveFollowUpOutcome(ctx, followUp._id, {
      kind: "needs_human",
      reason,
      // Quem assumiu a conversa não recebe aviso sobre a própria ação: a
      // tarefa é reatribuída a ele em silêncio (outros destinatários, se
      // houver broadcast, continuam sendo avisados).
      ...(opts?.assignTo ? { actorId: opts.assignTo } : {}),
    });
    if (opts?.assignTo) {
      const task = await ctx.db.get(followUp.taskId);
      const target = await ctx.db.get(opts.assignTo);
      if (
        task &&
        target &&
        target.organizationId === followUp.organizationId &&
        task.status !== "completed" &&
        task.status !== "cancelled"
      ) {
        await ctx.db.patch(task._id, {
          assignedTo: target._id,
          assigneeIds: [target._id],
          updatedAt: Date.now(),
        });
      }
    }
  }
  return pending.length;
}

/**
 * Lead ARQUIVADO: a conversa dele não é arquivada junto (`bulkArchiveLeads` só
 * mexe no lead), então sem isto a IA continuaria cobrando o cliente de um lead
 * que a equipe tirou do funil. Cap por lead para proteger a transação no bulk.
 */
export async function cancelFollowUpsOfLead(
  ctx: MutationCtx,
  leadId: Id<"leads">,
  reason: string,
  cap: number = 10
): Promise<number> {
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_lead", (q) => q.eq("leadId", leadId))
    .take(10);
  let canceled = 0;
  for (const conversation of conversations) {
    if (canceled >= cap) break;
    const pending = await pendingFollowUpsForConversation(ctx, conversation._id);
    for (const followUp of pending) {
      if (canceled >= cap) break;
      await resolveFollowUpOutcome(ctx, followUp._id, { kind: "canceled", reason });
      canceled += 1;
    }
  }
  return canceled;
}

/**
 * Cascata de exclusão (lead ou canal): a conversa vai sumir, então o follow-up
 * morre junto. Cancelar ANTES de apagar é o que mata o `runAt` em voo — sem
 * isso o `fire` acordaria amanhã, não acharia nada e ficaria zumbi no log.
 *
 * Consome o mesmo orçamento de escritas da cascata e devolve `false` quando
 * acabou o orçamento (o chamador re-agenda; a varredura é idempotente).
 */
export async function purgeFollowUpsOfConversation(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  budget: { left: number }
): Promise<boolean> {
  const statuses = [
    ...ACTIVE_FOLLOW_UP_STATUSES,
    ...TERMINAL_STATUSES,
  ] as readonly FollowUpDoc["status"][];
  for (const status of statuses) {
    while (budget.left > 0) {
      const rows = await ctx.db
        .query("aiFollowUps")
        .withIndex("by_conversation_and_status", (q) =>
          q.eq("conversationId", conversationId).eq("status", status)
        )
        .take(Math.min(budget.left, 50));
      if (rows.length === 0) break;
      for (const row of rows) {
        await cancelArmed(ctx, row);
        // A TAREFA sobrevive à cascata (ela só perde o `leadId`). Sem isto,
        // sobra uma tarefa pendente atribuída ao membro IA, sem lead e sem
        // conversa — exatamente a tarefa-zumbi que esta versão veio matar.
        const task = await ctx.db.get(row.taskId);
        if (task && task.status !== "completed" && task.status !== "cancelled") {
          await ctx.db.patch(task._id, { status: "cancelled", updatedAt: Date.now() });
          budget.left -= 1;
          const agent = await ctx.db.get(row.agentMemberId);
          if (agent) {
            await addTaskCommentCore(ctx, {
              task,
              author: agent,
              content: `Follow-up cancelado: ${describeFollowUpReason("lead_excluido")}.`,
            });
            budget.left -= 1;
          }
        }
        await ctx.db.delete(row._id);
        budget.left -= 1;
      }
    }
    if (budget.left <= 0) return false;
  }
  return true;
}
