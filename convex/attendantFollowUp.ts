/**
 * Follow-up que o PRÓPRIO Atendente IA executa (v0.60).
 *
 * O caso real que originou tudo: a cliente disse "já já faço o teu pix", a IA
 * criou a tarefa "Cobrar comprovante", com ela mesma como responsável, para
 * dali a 24 h. A tarefa venceu e **nada aconteceu** — nenhum cron trata
 * `type:"task"`, notificação in-app e e-mail pulam membro `type:"ai"`, e o
 * atendente nunca lê `tasks`. A tarefa era cosmética (P0.2 do gap analysis).
 *
 * A ideia central: no dia, a IA NÃO manda um texto pré-gravado — ela roda um
 * TURNO novo, lendo a conversa como ela está naquele momento. Se o comprovante
 * chegou às 9h, às 16h27 ela não cobra nada. Por isso a feature não reusa
 * `scheduledMessages` (texto congelado, zero re-checagem) e sim a fila do
 * atendente inteira: `aiReplyQueue` → claim → commit, com uma ORIGEM nova
 * (`origin: "follow_up"`).
 *
 * Este arquivo é o disparo e a superfície: `fire` (a cadeia de guardas),
 * o watchdog, a adoção de uma tarefa existente e a API que a tela usa.
 * O ciclo de vida compartilhado mora em `lib/followUpOps.ts`.
 */
import { v } from "convex/values";
import { internalMutation, mutation, query, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { orgAiActive } from "./lib/agentSecurity";
import { resolveConversationChannelConfig, providerOf } from "./lib/channelResolve";
import { evaluateEligibility, findAttendantForConversation } from "./attendant";
import { getLeadRef } from "./lib/leadRef";
import { normalizeCampaignPhone } from "./lib/phone";
import {
  followUpWindow,
  isWithinSchedule,
  nextOpening,
  formatLocalShort,
} from "./lib/agentSchedule";
import { resolveAgentTimezone } from "./lib/promptDateTime";
import { resolveFollowUpSettings } from "./lib/followUpSettings";
import { sanitizeFollowUpNote } from "./lib/followUpNote";
import {
  MAX_DEFERRALS,
  QUEUE_BUSY_DELAY_MS,
  armFollowUp,
  cancelArmedFollowUp,
  computeChainIndex,
  dailyFollowUpCapReached,
  describeFollowUpReason,
  followUpForTask,
  isTerminalFollowUp,
  nextUtcDayStart,
  pendingFollowUpsForConversation,
  resolveFollowUpOutcome,
} from "./lib/followUpOps";

/** Backoff da sessão bridge instável (mesmo molde do `groupPostWorker`). */
const BRIDGE_BACKOFF_MS = [2 * 60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
/** Watchdog: prazo estourado há mais que isto = agendamento perdido. */
const WATCHDOG_LATE_MS = 15 * 60 * 1000;
/** Watchdog: item parado em `queued` além disto = turno morreu no caminho. */
const WATCHDOG_STUCK_MS = 30 * 60 * 1000;
/**
 * Prazo MUITO maior para quem já tem `resultMessageId`: a mensagem foi
 * comprometida e só falta o provider confirmar. O dispatch pode demorar de
 * verdade (cursor do canal, congelamento de 30 min por qualidade, retry com
 * backoff) — escalar em 30 min chamaria um humano para um envio que está
 * simplesmente na fila.
 */
const WATCHDOG_COMMITTED_MS = 6 * 60 * 60 * 1000;
/** Tolerância do guard de disparo antecipado (jitter de relógio/agendador). */
const EARLY_FIRE_TOLERANCE_MS = 60 * 1000;

type FireResult = { ok: boolean; reason: string | null };

const fireResultValidator = v.object({
  ok: v.boolean(),
  reason: v.union(v.string(), v.null()),
});

/**
 * A CADEIA DE GUARDAS do follow-up, na ordem do plano (4.3). Toda saída daqui
 * ou re-arma o disparo ou encerra o follow-up com um desfecho — nunca o deixa
 * pendurado.
 *
 * `manual: true` = "Executar agora", clicado por uma pessoa: pula a janela de
 * silêncio (é decisão do operador) e mantém TODAS as outras guardas. Não é um
 * atalho para o envio.
 */
async function fireCore(
  ctx: MutationCtx,
  followUpId: Id<"aiFollowUps">,
  opts?: { manual?: boolean }
): Promise<FireResult> {
  const followUp = await ctx.db.get(followUpId);
  if (!followUp) return { ok: false, reason: "follow_up_inexistente" };

  // PASSO 1 — guard de idempotência. Não basta comparar o prazo esperado (dois
  // armamentos com o MESMO prazo mandariam duas mensagens): a transição
  // `scheduled → queued` acontece na mesma transação do insert na fila, e o OCC
  // do Convex faz o segundo `fire` reexecutar e ver `queued`.
  if (followUp.status !== "scheduled") return { ok: false, reason: "nao_agendado" };

  const now = Date.now();

  // PASSO 2 — relê a TAREFA (rede de segurança de 4.1): mesmo que um escritor
  // de `tasks` esqueça de chamar `syncFollowUpForTask`, nada sai indevido.
  const task = await ctx.db.get(followUp.taskId);
  if (!task) {
    await resolveFollowUpOutcome(ctx, followUp._id, { kind: "canceled", reason: "tarefa_excluida" });
    return { ok: false, reason: "tarefa_excluida" };
  }
  if (task.status !== "pending" && task.status !== "in_progress") {
    await resolveFollowUpOutcome(ctx, followUp._id, {
      kind: "canceled",
      reason: task.status === "completed" ? "tarefa_concluida" : "tarefa_cancelada",
    });
    return { ok: false, reason: "tarefa_nao_pendente" };
  }
  if (task.assignedTo !== followUp.agentMemberId) {
    await resolveFollowUpOutcome(ctx, followUp._id, { kind: "canceled", reason: "tarefa_de_outro" });
    return { ok: false, reason: "tarefa_de_outro" };
  }
  if (task.dueDate === undefined) {
    await resolveFollowUpOutcome(ctx, followUp._id, {
      kind: "canceled",
      reason: "tarefa_sem_prazo",
    });
    return { ok: false, reason: "tarefa_sem_prazo" };
  }
  // Adiada por um humano ("lembrar depois"): o `snoozeTask` não mexe em
  // `dueDate` (ele só reagenda lembrete de `type:"reminder"`), então sem esta
  // guarda a IA mandaria a mensagem no prazo antigo, contra a decisão de quem
  // adiou. Re-arma para o fim do soneca.
  if (task.snoozedUntil !== undefined && task.snoozedUntil > now && !opts?.manual) {
    await armFollowUp(ctx, followUp, task.snoozedUntil, now);
    return { ok: false, reason: "adiada_pela_equipe" };
  }
  if (task.dueDate !== followUp.dueAt && !opts?.manual) {
    // Remarcada enquanto o job dormia: re-arma no prazo NOVO.
    await ctx.db.patch(followUp._id, { dueAt: task.dueDate, updatedAt: now });
    await armFollowUp(ctx, (await ctx.db.get(followUp._id))!, task.dueDate, now);
    return { ok: false, reason: "remarcado" };
  }

  // JOB ZUMBI: acordou ANTES do instante para o qual o follow-up está armado
  // hoje. Acontece quando alguém usou "Executar agora" (que consome o
  // follow-up fora da hora) e o turno depois abortou e remarcou — o `runAt` do
  // prazo original continuava vivo e mandaria a mensagem dias antes. A
  // comparação é com `nextFireAt`, não com `dueAt`: os re-armes por adiamento
  // (fila ocupada, janela, teto diário, soneca) NÃO movem o prazo da tarefa.
  if (
    !opts?.manual &&
    followUp.nextFireAt !== undefined &&
    now < followUp.nextFireAt - EARLY_FIRE_TOLERANCE_MS
  ) {
    // Sem job vivo (o campo foi zerado por um caminho antigo), re-arma; com
    // job vivo, some em silêncio — quem vai disparar é ele.
    if (!followUp.schedulerFnId) {
      await armFollowUp(ctx, followUp, followUp.nextFireAt, now, { withJitter: false });
    }
    return { ok: false, reason: "disparo_antecipado" };
  }

  const conversation = await ctx.db.get(followUp.conversationId);
  if (!conversation || conversation.organizationId !== followUp.organizationId) {
    await resolveFollowUpOutcome(ctx, followUp._id, {
      kind: "canceled",
      reason: "conversa_removida",
    });
    return { ok: false, reason: "conversa_removida" };
  }
  // PASSO 5 — guardas que a elegibilidade NÃO tem. Conversa arquivada: alguém
  // fechou aquele atendimento; reabri-lo com uma cobrança seria ruído.
  if (conversation.archivedAt !== undefined) {
    await resolveFollowUpOutcome(ctx, followUp._id, {
      kind: "canceled",
      reason: "conversa_arquivada",
    });
    return { ok: false, reason: "conversa_arquivada" };
  }

  const org = await ctx.db.get(followUp.organizationId);
  const lead = await getLeadRef(ctx.db, conversation.leadId);
  // Lead ARQUIVADO: a equipe tirou este negócio do funil. Arquivar lead NÃO
  // arquiva a conversa (`bulkArchiveLeads` só mexe no lead), então a guarda de
  // conversa arquivada, sozinha, deixava a IA cobrar um cliente de um lead que
  // ninguém mais acompanha.
  if (lead?.archivedAt !== undefined) {
    await resolveFollowUpOutcome(ctx, followUp._id, {
      kind: "canceled",
      reason: "lead_arquivado",
    });
    return { ok: false, reason: "lead_arquivado" };
  }
  const contact = lead?.contactId ? await ctx.db.get(lead.contactId) : null;
  const channelConfig = await resolveConversationChannelConfig(ctx, conversation);
  const provider = providerOf(channelConfig);

  // PASSO 4 — `findAttendantForConversation` ANTES da elegibilidade: só a
  // segunda deixaria passar canal fora do escopo do perfil ou lead em board
  // que o atendente não cobre.
  const agent = await findAttendantForConversation(ctx, org, conversation, lead, channelConfig);
  if (!agent || agent._id !== followUp.agentMemberId) {
    await resolveFollowUpOutcome(ctx, followUp._id, { kind: "needs_human", reason: "sem_atendente" });
    return { ok: false, reason: "sem_atendente" };
  }

  const profile = agent.agentProfile!;
  const settings = resolveFollowUpSettings(profile, provider);
  const timezone = resolveAgentTimezone(profile.schedule?.timezone, org?.settings.timezone);

  // PASSO 3 — modo desligado: a tarefa vira de gente em vez de vencer calada.
  if (settings.mode === "off") {
    await resolveFollowUpOutcome(ctx, followUp._id, { kind: "needs_human", reason: "modo_desligado" });
    return { ok: false, reason: "modo_desligado" };
  }

  // PASSO 5 — opt-out por TELEFONE. Follow-up é mensagem ATIVA: quem escreveu
  // "SAIR" pediu exatamente para não receber isto. O atendente só olhava
  // `contact.aiOptOut`, que é outra coisa (e não cobre quem digitou a palavra
  // no meio de uma campanha).
  const phone = contact?.phone ? normalizeCampaignPhone(contact.phone) : null;
  if (phone?.ok) {
    const optOut = await ctx.db
      .query("optOuts")
      .withIndex("by_organization_and_phone", (q) =>
        q.eq("organizationId", followUp.organizationId).eq("phone", phone.phone)
      )
      .first();
    if (optOut) {
      await resolveFollowUpOutcome(ctx, followUp._id, { kind: "canceled", reason: "opt_out" });
      return { ok: false, reason: "opt_out" };
    }
  }

  // PASSO 5 — sessão bridge caída: ADIA com backoff antes de desistir (o
  // número costuma voltar sozinho).
  if (
    provider === "bridge" &&
    (channelConfig?.bridgeSessionState === "banned" ||
      channelConfig?.bridgeSessionState === "disconnected")
  ) {
    return await deferOrEscalate(ctx, followUp, now, {
      delayMs: BRIDGE_BACKOFF_MS[Math.min(followUp.deferrals, BRIDGE_BACKOFF_MS.length - 1)],
      reason: "bridge_offline",
    });
  }

  // PASSO 6 — JANELA DE FOLLOW-UP = horário de atendimento ∩ silêncio (default
  // 8–20 h). Vale SEMPRE, não só quando falta horário configurado: o atendente
  // real do Eric é 24 h, e sem a interseção um "te chamo amanhã" viraria uma
  // cobrança de Pix às 3h da manhã.
  const window = followUpWindow(
    profile.schedule,
    timezone,
    settings.quietStartHour,
    settings.quietEndHour
  );
  if (!opts?.manual && !isWithinSchedule(window, now)) {
    const at = nextOpening(window, now);
    await armFollowUp(ctx, followUp, at, now);
    return { ok: false, reason: "fora_da_janela" };
  }

  // PASSO 7 — o turno REATIVO vence: o cliente acabou de escrever e há item na
  // fila. Adia; normalmente o próprio turno normal resolve o follow-up (ele o
  // vê no prompt).
  for (const status of ["pending", "processing"] as const) {
    const inFlight = await ctx.db
      .query("aiReplyQueue")
      .withIndex("by_conversation_and_status", (q) =>
        q.eq("conversationId", conversation._id).eq("status", status)
      )
      .first();
    if (inFlight) {
      return await deferOrEscalate(ctx, followUp, now, {
        delayMs: QUEUE_BUSY_DELAY_MS,
        reason: "fila_ocupada",
      });
    }
  }

  // PASSO 8 — ANTI-INSISTÊNCIA. Recalculado agora (e não no agendamento):
  // se o cliente falou no meio do caminho, a cadeia zera.
  const chainIndex = await computeChainIndex(
    ctx,
    conversation._id,
    conversation.lastInboundAt
  );
  if (chainIndex !== followUp.chainIndex) {
    await ctx.db.patch(followUp._id, { chainIndex, updatedAt: now });
  }
  if (chainIndex >= settings.maxChain) {
    await resolveFollowUpOutcome(ctx, followUp._id, { kind: "needs_human", reason: "cadeia_maxima" });
    return { ok: false, reason: "cadeia_maxima" };
  }

  // PASSO 9 — teto diário POR NÚMERO, COM enforcement (diferente do
  // `dailyCount`, que é só métrica). Re-arma para a próxima abertura de amanhã.
  const pacing = conversation.channelConfigId
    ? await ctx.db
        .query("channelPacing")
        .withIndex("by_channel_config", (q) =>
          q.eq("channelConfigId", conversation.channelConfigId!)
        )
        .first()
    : null;
  if (dailyFollowUpCapReached(pacing?.followUpDaily, now, settings.dailyCap)) {
    const at = nextOpening(window, nextUtcDayStart(now));
    await armFollowUp(ctx, followUp, at, now);
    return { ok: false, reason: "teto_diario" };
  }

  // PASSO 10 — elegibilidade do atendente. Duas exceções DELIBERADAS, ambas
  // testadas: `janela_24h` no Meta segue para o caminho RASCUNHO (o texto fica
  // pronto para quando a janela reabrir — 4.7) e `fora_do_horario` já foi
  // decidido pela janela de follow-up, acima.
  const counts = await countAiRepliesForFollowUp(ctx, conversation._id, now);
  const eligibility = evaluateEligibility({
    org,
    agent,
    conversation,
    lead,
    contact,
    channelProvider: provider,
    aiReplyCountConversation: counts.total,
    aiReplyCountLastHour: counts.lastHour,
    now,
  });
  if (!eligibility.ok) {
    let reason = eligibility.reason;
    let tolerated = reason === "janela_24h" || reason === "fora_do_horario";
    if (tolerated) {
      // A elegibilidade CURTO-CIRCUITA no primeiro motivo, e horário (nº 8) vem
      // antes de tetos (9), aceite do bridge (10) e janela (11). Sem re-avaliar
      // a cadeia inteira com os dois motivos tolerados neutralizados, um teto
      // estourado ou um bridge sem aceite passariam escondidos atrás do
      // "fora_do_horario" — e a run só morreria no commit, já paga.
      const recheck = evaluateEligibility({
        org,
        agent: { ...agent, agentProfile: { ...profile, schedule: undefined } },
        conversation: { ...conversation, lastInboundAt: now },
        lead,
        contact,
        channelProvider: provider,
        aiReplyCountConversation: counts.total,
        aiReplyCountLastHour: counts.lastHour,
        now,
      });
      if (!recheck.ok) {
        tolerated = false;
        reason = recheck.reason;
      }
    }
    if (!tolerated) {
      if (reason === "opt_out") {
        await resolveFollowUpOutcome(ctx, followUp._id, { kind: "canceled", reason: "opt_out" });
      } else {
        await resolveFollowUpOutcome(ctx, followUp._id, { kind: "needs_human", reason });
      }
      return { ok: false, reason };
    }
  }

  // PASSO 11 — enfileira o turno. `triggerMessageId` é a última mensagem da
  // conversa: o turno lê o histórico inteiro, este campo é só o ponteiro.
  const lastMessage = await ctx.db
    .query("messages")
    .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversation._id))
    .order("desc")
    .first();
  if (!lastMessage) {
    await resolveFollowUpOutcome(ctx, followUp._id, {
      kind: "needs_human",
      reason: "conversa_sem_mensagens",
    });
    return { ok: false, reason: "conversa_sem_mensagens" };
  }

  const queueItemId = await ctx.db.insert("aiReplyQueue", {
    organizationId: followUp.organizationId,
    conversationId: conversation._id,
    triggerMessageId: lastMessage._id,
    agentMemberId: agent._id,
    status: "pending",
    attempts: 0,
    nextAttemptAt: now, // follow-up não tem rajada para agrupar
    origin: "follow_up",
    followUpId: followUp._id,
    createdAt: now,
    updatedAt: now,
  });
  // Cancela o `runAt` ainda pendente ANTES de esquecer o handle: é o caso do
  // "Executar agora", que consome o follow-up muito antes do prazo original —
  // sem isto sobrava um job órfão capaz de disparar sozinho lá na frente.
  await cancelArmedFollowUp(ctx, followUp);
  await ctx.db.patch(followUp._id, {
    status: "queued",
    firedAt: now,
    queueItemId,
    deferrals: 0,
    schedulerFnId: undefined,
    nextFireAt: undefined,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.attendant.internalProcessQueueItem, { queueItemId });
  return { ok: true, reason: null };
}

/** Adia com teto: estourado, a tarefa vira de gente (nunca silêncio). */
async function deferOrEscalate(
  ctx: MutationCtx,
  followUp: Doc<"aiFollowUps">,
  now: number,
  opts: { delayMs: number; reason: string }
): Promise<FireResult> {
  if (followUp.deferrals >= MAX_DEFERRALS) {
    await resolveFollowUpOutcome(ctx, followUp._id, { kind: "needs_human", reason: opts.reason });
    return { ok: false, reason: opts.reason };
  }
  await ctx.db.patch(followUp._id, { deferrals: followUp.deferrals + 1, updatedAt: now });
  await armFollowUp(ctx, (await ctx.db.get(followUp._id))!, now + opts.delayMs, now, {
    withJitter: false,
  });
  return { ok: false, reason: `adiado_${opts.reason}` };
}

/** Mesma contagem do atendente (outbound da IA, sem notas internas). */
async function countAiRepliesForFollowUp(
  ctx: MutationCtx,
  conversationId: Id<"conversations">,
  now: number
): Promise<{ total: number; lastHour: number }> {
  const recent = await ctx.db
    .query("messages")
    .withIndex("by_conversation_and_created", (q) => q.eq("conversationId", conversationId))
    .order("desc")
    .take(200);
  const aiOutbound = recent.filter(
    (m) => m.direction === "outbound" && m.senderType === "ai" && !m.isInternal
  );
  return {
    total: aiOutbound.length,
    lastHour: aiOutbound.filter((m) => m.createdAt > now - 60 * 60 * 1000).length,
  };
}

export const fire = internalMutation({
  args: { followUpId: v.id("aiFollowUps") },
  returns: fireResultValidator,
  handler: async (ctx, args) => await fireCore(ctx, args.followUpId),
});

/**
 * Turno de follow-up que terminou SEM mensagem. Chamado pela action quando o
 * modelo não produziu `replyToCustomer` — que num follow-up pode ser SUCESSO
 * ("já resolveu, não vou cobrar") e não pode virar 4 retries + repasse.
 */
export const internalFinishSilentTurn = internalMutation({
  args: {
    queueItemId: v.id("aiReplyQueue"),
    conversationId: v.id("conversations"),
    runId: v.string(),
    followUpId: v.id("aiFollowUps"),
    resolved: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const item = await ctx.db.get(args.queueItemId);
    if (item && item.status === "processing") {
      await ctx.db.patch(item._id, {
        status: args.resolved ? "done" : "skipped",
        error: args.resolved ? undefined : "modelo_sem_resposta",
        updatedAt: now,
      });
    }
    const conversation = await ctx.db.get(args.conversationId);
    if (conversation?.aiTurnLock?.runId === args.runId) {
      await ctx.db.patch(conversation._id, { aiTurnLock: undefined });
    }
    // `resolved` = a IA chamou `resolveFollowUp` (o desfecho já foi gravado por
    // aquela tool). Sem isso, ela não decidiu nada — e "nada" não pode ser o
    // fim da linha de uma tarefa que alguém está esperando.
    if (!args.resolved) {
      await resolveFollowUpOutcome(ctx, args.followUpId, {
        kind: "needs_human",
        reason: "modelo_sem_resposta",
      });
    }
    return null;
  },
});

/**
 * Rede de segurança horária (molde do `groupPostWorker.internalWatchdog`):
 *  - `scheduled` com prazo vencido há mais de 15 min = `runAt` perdido (deploy,
 *    restore, job cancelado) → re-dispara;
 *  - `queued` parado há mais de 30 min = o turno morreu no caminho → vira
 *    `needs_human`, que é o ponto da feature: nada fica pendurado.
 */
export const internalWatchdog = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();

    const late = await ctx.db
      .query("aiFollowUps")
      .withIndex("by_status_and_due", (q) =>
        q.eq("status", "scheduled").lt("dueAt", now - WATCHDOG_LATE_MS)
      )
      .take(50);
    for (const followUp of late) {
      await fireCore(ctx, followUp._id);
    }

    const stuck = await ctx.db
      .query("aiFollowUps")
      .withIndex("by_status_and_due", (q) => q.eq("status", "queued"))
      .take(50);
    for (const followUp of stuck) {
      // Com `resultMessageId` a mensagem JÁ foi comprometida e só falta a
      // confirmação do provider — o dispatch tem pacing por número, retry com
      // backoff e congelamento de 30 min por qualidade. Escalar em 30 min
      // chamaria um humano para um envio que está apenas na fila; e se a
      // entrega chegar depois, o gancho conclui a tarefa mesmo assim (o
      // `force` de `applyFollowUpDeliveryUpdate`).
      const committed = followUp.resultMessageId !== undefined;
      const limit = committed ? WATCHDOG_COMMITTED_MS : WATCHDOG_STUCK_MS;
      if (now - followUp.updatedAt < limit) continue;
      await resolveFollowUpOutcome(ctx, followUp._id, {
        kind: "needs_human",
        reason: committed ? "envio_sem_confirmacao" : "modelo_sem_resposta",
      });
    }
    return null;
  },
});

// ── Adoção de uma tarefa existente (seção 9 da aprovação) ──

async function adoptTaskCore(
  ctx: MutationCtx,
  args: { taskId: Id<"tasks">; dueAt?: number; note?: string }
): Promise<{ ok: true; followUpId: Id<"aiFollowUps"> } | { ok: false; reason: string }> {
  const task = await ctx.db.get(args.taskId);
  if (!task) return { ok: false, reason: "Tarefa não encontrada" };
  if (task.status !== "pending" && task.status !== "in_progress") {
    return { ok: false, reason: "A tarefa já está concluída ou cancelada" };
  }
  const existing = await followUpForTask(ctx, task._id);
  if (existing && !isTerminalFollowUp(existing.status)) {
    return { ok: false, reason: "Esta tarefa já é executada pela IA" };
  }
  if (task.recurrence) {
    return { ok: false, reason: "Tarefa recorrente ainda não pode ser executada pela IA" };
  }
  if (!task.leadId) {
    return { ok: false, reason: "A tarefa precisa estar ligada a um lead" };
  }
  const lead = await ctx.db.get(task.leadId);
  if (!lead || lead.organizationId !== task.organizationId) {
    return { ok: false, reason: "Lead da tarefa não encontrado" };
  }
  if (!task.assignedTo) return { ok: false, reason: "A tarefa não tem responsável" };
  const agent = await ctx.db.get(task.assignedTo);
  if (
    !agent ||
    agent.type !== "ai" ||
    agent.status !== "active" ||
    agent.agentProfile?.kind !== "attendant" ||
    agent.organizationId !== task.organizationId
  ) {
    return { ok: false, reason: "A tarefa precisa estar atribuída a um atendente IA ativo" };
  }

  // Conversa mais recente NÃO arquivada do lead — a mesma regra de
  // `createHandoffCore`: mandar o follow-up para um arquivo antigo não serve.
  const conversations = await ctx.db
    .query("conversations")
    .withIndex("by_lead", (q) => q.eq("leadId", task.leadId!))
    .collect();
  const candidate = [...conversations]
    .filter((c) => c.archivedAt === undefined && c.kind !== "group")
    .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt))[0];
  if (!candidate) return { ok: false, reason: "O lead não tem conversa ativa" };

  const now = Date.now();
  const dueAt = args.dueAt ?? task.dueDate;
  if (dueAt === undefined) return { ok: false, reason: "A tarefa precisa ter um prazo" };
  if (dueAt <= now) {
    return { ok: false, reason: "O prazo da tarefa precisa estar no futuro (remarque antes)" };
  }

  const org = await ctx.db.get(task.organizationId);
  const channelConfig = await resolveConversationChannelConfig(ctx, candidate);
  const settings = resolveFollowUpSettings(agent.agentProfile, providerOf(channelConfig));
  const timezone = resolveAgentTimezone(
    agent.agentProfile?.schedule?.timezone,
    org?.settings.timezone
  );
  const window = followUpWindow(
    agent.agentProfile?.schedule,
    timezone,
    settings.quietStartHour,
    settings.quietEndHour
  );
  const effectiveDueAt = nextOpening(window, dueAt);

  const note = sanitizeFollowUpNote(args.note ?? task.description);
  const chainIndex = await computeChainIndex(ctx, candidate._id, candidate.lastInboundAt);

  const followUpId = await ctx.db.insert("aiFollowUps", {
    organizationId: task.organizationId,
    taskId: task._id,
    conversationId: candidate._id,
    leadId: lead._id,
    contactId: lead.contactId,
    agentMemberId: agent._id,
    status: "scheduled",
    dueAt: effectiveDueAt,
    ...(note ? { note } : {}),
    chainIndex,
    deferrals: 0,
    createdAt: now,
    updatedAt: now,
  });
  if (task.dueDate !== effectiveDueAt) {
    await ctx.db.patch(task._id, {
      dueDate: effectiveDueAt,
      preDueReminderSentAt: undefined,
      updatedAt: now,
    });
  }
  await armFollowUp(ctx, (await ctx.db.get(followUpId))!, effectiveDueAt, now);

  await ctx.db.insert("auditLogs", {
    organizationId: task.organizationId,
    entityType: "task",
    entityId: task._id,
    action: "update",
    actorId: agent._id,
    actorType: "ai",
    metadata: {
      title: task.title,
      followUpId,
      dueAt: effectiveDueAt,
      via: "adopt_task",
    },
    description: `Tarefa '${task.title}' passou a ser executada pelo atendente IA em ${formatLocalShort(effectiveDueAt, timezone)}`,
    severity: "medium",
    createdAt: now,
  });

  return { ok: true, followUpId };
}

/**
 * Op interna: adota uma tarefa que JÁ existe (a da Rejane, por exemplo) como
 * follow-up da IA. Não há backfill automático (D6) — dispararia tudo de uma
 * vez —, então a adoção é sempre um ato deliberado.
 */
export const internalAdoptTask = internalMutation({
  args: {
    taskId: v.id("tasks"),
    dueAt: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  returns: v.union(
    v.object({ ok: v.literal(true), followUpId: v.id("aiFollowUps") }),
    v.object({ ok: v.literal(false), reason: v.string() })
  ),
  handler: async (ctx, args) => await adoptTaskCore(ctx, args),
});

// ── API pública (a tela consome só isto) ──

const followUpSummaryValidator = v.object({
  _id: v.id("aiFollowUps"),
  status: v.string(),
  dueAt: v.number(),
  note: v.union(v.string(), v.null()),
  /** Frase pronta (PT-BR) do desfecho. */
  reason: v.union(v.string(), v.null()),
  /** Código estável do motivo (`FOLLOW_UP_REASON_CODES`) para a UI mapear. */
  reasonCode: v.union(v.string(), v.null()),
  chainIndex: v.number(),
  resultMessageId: v.union(v.id("messages"), v.null()),
  draftMessageId: v.union(v.id("messages"), v.null()),
  conversationId: v.id("conversations"),
  agentName: v.union(v.string(), v.null()),
  /** Modo EFETIVO do atendente desta conversa ("off" | "draft" | "send"). */
  effectiveMode: v.string(),
});

async function summarizeFollowUp(
  ctx: { db: MutationCtx["db"] },
  followUp: Doc<"aiFollowUps">
) {
  const agent = await ctx.db.get(followUp.agentMemberId);
  const conversation = await ctx.db.get(followUp.conversationId);
  const channelConfig = conversation
    ? await resolveConversationChannelConfig(
        ctx as unknown as Parameters<typeof resolveConversationChannelConfig>[0],
        conversation
      )
    : null;
  const settings = resolveFollowUpSettings(agent?.agentProfile, providerOf(channelConfig));
  return {
    _id: followUp._id,
    status: followUp.status,
    dueAt: followUp.dueAt,
    note: followUp.note ?? null,
    reason: followUp.reason ?? null,
    reasonCode: followUp.reasonCode ?? null,
    chainIndex: followUp.chainIndex,
    resultMessageId: followUp.resultMessageId ?? null,
    draftMessageId: followUp.draftMessageId ?? null,
    conversationId: followUp.conversationId,
    agentName: agent?.name ?? null,
    effectiveMode: settings.mode,
  };
}

/** Selo "IA executa em …" no detalhe da tarefa. */
export const getForTask = query({
  args: { taskId: v.id("tasks") },
  returns: v.union(v.null(), followUpSummaryValidator),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    await requirePermission(ctx, task.organizationId, "tasks", "view_own");
    const followUp = await followUpForTask(ctx, args.taskId);
    if (!followUp) return null;
    // Multi-tenant estrito: o follow-up tem de ser da MESMA org da tarefa.
    if (followUp.organizationId !== task.organizationId) return null;
    return await summarizeFollowUp(ctx as never, followUp);
  },
});

/** Chip "Follow-up da IA: amanhã 09:00" no header da conversa. */
export const listForConversation = query({
  args: { conversationId: v.id("conversations") },
  returns: v.array(
    v.object({
      _id: v.id("aiFollowUps"),
      taskId: v.id("tasks"),
      title: v.string(),
      dueAt: v.number(),
      status: v.string(),
      note: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return [];
    await requirePermission(ctx, conversation.organizationId, "inbox", "view_own");
    const pending = await pendingFollowUpsForConversation(ctx, args.conversationId);
    const out: {
      _id: Id<"aiFollowUps">;
      taskId: Id<"tasks">;
      title: string;
      dueAt: number;
      status: string;
      note: string | null;
    }[] = [];
    for (const followUp of pending) {
      if (followUp.organizationId !== conversation.organizationId) continue;
      const task = await ctx.db.get(followUp.taskId);
      out.push({
        _id: followUp._id,
        taskId: followUp.taskId,
        title: task?.title ?? "Follow-up",
        dueAt: followUp.dueAt,
        status: followUp.status,
        note: followUp.note ?? null,
      });
    }
    return out;
  },
});

/**
 * "Executar agora". NÃO é atalho: passa pela MESMA cadeia de guardas do `fire`
 * (canal, opt-out, tetos, elegibilidade). A única coisa que ele pula é a janela
 * de silêncio — quem clicou é uma pessoa, e a decisão é dela.
 */
export const runNow = mutation({
  args: { followUpId: v.id("aiFollowUps") },
  returns: v.object({ ok: v.boolean(), reason: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const followUp = await ctx.db.get(args.followUpId);
    if (!followUp) return { ok: false, reason: "Follow-up não encontrado" };
    // Dois gates: mexer na tarefa E poder falar com o cliente — "Executar
    // agora" dispara uma mensagem no WhatsApp, não é só editar uma tarefa.
    await requirePermission(ctx, followUp.organizationId, "tasks", "edit_own");
    await requirePermission(ctx, followUp.organizationId, "inbox", "reply");
    const org = await ctx.db.get(followUp.organizationId);
    if (!orgAiActive(org)) return { ok: false, reason: "A IA da organização não está ativa" };
    if (isTerminalFollowUp(followUp.status)) {
      return { ok: false, reason: "Este follow-up já foi encerrado" };
    }
    if (followUp.status !== "scheduled") {
      return { ok: false, reason: "A IA já está processando este follow-up" };
    }
    const result = await fireCore(ctx, args.followUpId, { manual: true });
    return {
      ok: result.ok,
      // "adiado_fila_ocupada" → "a conversa ficou ocupada…": o prefixo é
      // controle interno e não pode vazar para a tela.
      reason: result.reason
        ? describeFollowUpReason(result.reason.replace(/^adiad[oa]_/, ""))
        : null,
    };
  },
});

/** "Não executar automaticamente": vira tarefa comum, sem selo de IA. */
export const cancelAuto = mutation({
  args: { followUpId: v.id("aiFollowUps") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const followUp = await ctx.db.get(args.followUpId);
    if (!followUp) return null;
    const member = await requirePermission(ctx, followUp.organizationId, "tasks", "edit_own");
    if (isTerminalFollowUp(followUp.status)) return null;
    await resolveFollowUpOutcome(ctx, followUp._id, {
      kind: "canceled",
      reason: `execução automática desligada por ${member.name}`,
      reassignTo: member._id,
    });
    return null;
  },
});

/** Botão "IA executa" numa tarefa atribuída ao atendente. */
export const adoptTask = mutation({
  args: { taskId: v.id("tasks") },
  returns: v.union(
    v.object({ ok: v.literal(true), followUpId: v.id("aiFollowUps") }),
    v.object({ ok: v.literal(false), reason: v.string() })
  ),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return { ok: false as const, reason: "Tarefa não encontrada" };
    // Adotar ARMA um envio automático ao cliente — mesmo par de gates do runNow.
    await requirePermission(ctx, task.organizationId, "tasks", "edit_own");
    await requirePermission(ctx, task.organizationId, "inbox", "reply");
    const org = await ctx.db.get(task.organizationId);
    if (!orgAiActive(org)) {
      return { ok: false as const, reason: "A IA da organização não está ativa" };
    }
    return await adoptTaskCore(ctx, { taskId: args.taskId });
  },
});
