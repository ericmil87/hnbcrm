import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Plano (B7): teste vencido vira `read_only`, avisos D-7/D-3/D-1 e pausa das campanhas.
// Só age em orgs `trial`; 12:00 UTC = 09:00 BRT. Paginado (a próxima página se agenda).
crons.daily("billing trial tick", { hourUTC: 12, minuteUTC: 0 }, internal.billingCron.internalBillingTick, {});

// Lembrete de cada task é agendado por `runAfter` (create, snooze, mudança de
// prazo em updateTask/internalUpdateTask e instância nova da recorrência); o
// cron é só resgate de um agendamento perdido, por índice — 1 h basta.
crons.interval("process overdue reminders", { hours: 1 }, internal.tasks.processOverdueReminders);
crons.interval("process recurring tasks", { hours: 1 }, internal.tasks.processRecurringTasks);

// Resumo diário por e-mail (C1): de hora em hora, só age nas orgs cuja hora LOCAL é 08h
// (carimbo `lastDailyDigestDate` por data local; antes: fixo 11:00 UTC = 08:00 BRT).
crons.cron("send daily digest", "0 * * * *", internal.email.sendDailyDigest, {});

crons.interval("mark abandoned form partials", { minutes: 10 }, internal.formPartials.internalMarkAbandoned);

// Publicações programadas em grupo: rede de segurança para a que perdeu o
// agendamento (o worker normal se auto-reagenda; isto é só o resgate).
crons.interval("group posts watchdog", { hours: 1 }, internal.groupPostWorker.internalWatchdog, {});

// Digest diário por grupo (F4): o cron roda de hora em hora e só age nos
// grupos cujo `ai.dailyDigestAt` bate com a hora local da org.
crons.interval("group daily digests", { hours: 1 }, internal.groupAgent.internalRunGroupDigests, {});

// Follow-ups da IA: resgata quem perdeu o `runAt` (deploy, restore) e encerra
// o que ficou preso em `queued`. A promessa da feature é que nada vence em
// silêncio — este cron é a rede de segurança disso.
crons.interval("ai follow-ups watchdog", { hours: 1 }, internal.attendantFollowUp.internalWatchdog, {});

// Blobs de export vivem 7 dias (exportJobs.expiresAt); a limpeza roda de hora em hora.
crons.interval("cleanup expired exports", { hours: 1 }, internal.exports.internalCleanupExpired, {});

// Mídia de grupo não baixada (v0.62): o descriptor cifrado vive 14 dias — a
// CDN do WhatsApp não guarda o blob para sempre. 06:00 UTC = 03:00 BRT.
crons.daily(
  "expire deferred group media",
  { hourUTC: 6, minuteUTC: 0 },
  internal.groupMedia.internalExpireDeferredMedia,
  {}
);

// Códigos de confirmação de e-mail vencidos (vivem 10 min; a limpeza é só higiene). 07:00 UTC.
crons.daily("prune email verification codes", { hourUTC: 7, minuteUTC: 0 }, internal.emailVerification.internalPruneEmailVerificationCodes, {});

// Áudio das respostas do chat do onboarding (P4.2b): vive 7 dias; depois blob + linha de `files` somem. 07:15 UTC.
crons.daily("expire onboarding reply audio", { hourUTC: 7, minuteUTC: 15 }, internal.onboardingChat.internalExpireOnboardingAudio, {});

// Saúde dos canais bridge (T02): sonda GET /session/status de cada número e
// notifica na transição (connected → fora do ar, só se persistir entre duas
// execuções). Teto de 50 canais por execução, o resto segue por cursor.
crons.interval("channel health", { minutes: 15 }, internal.channelHealth.internalChannelHealthTick, {});

// Instagram/Messenger (Meta Messaging, D8): token de Página não expira, então não há
// refresh; em vez disso `debug_token` diário (válido? escopo de mensagens? acesso a
// dados perto de expirar?) + purga de `metaSentMids`/states/pending antigos.
// 09:30 UTC = 06:30 BRT. Paginado por cursor; ver metaMessaging.internalHealthTick.
crons.daily("meta messaging health", { hourUTC: 9, minuteUTC: 30 }, internal.metaMessaging.internalHealthTick, {});

// Onboarding v2 (P2.4): apaga janelas de rate limit vencidas (> 2 dias); se houver mais de
// um lote, a própria função se reagenda. 08:00 UTC = 05:00 BRT.
crons.daily(
  "onboarding rate limit prune",
  { hourUTC: 8, minuteUTC: 0 },
  internal.onboardingBudget.internalPruneOnboardingRateLimits,
  { dryRun: false }
);

// Retenção (perf Convex I/O, fase 4a): apaga notificações lidas, fila/runs de
// IA terminais, parciais abandonados e auditoria `low` além da janela.
// 07:30 UTC = 04:30 BRT, depois do "expire deferred group media" (06:00 UTC).
// Paginado e com teto diário — ver convex/retention.ts.
crons.daily("data retention", { hourUTC: 7, minuteUTC: 30 }, internal.retention.internalRunRetention, {});

// Telegram (F0): rede de segurança da revogação — vínculo ativo de membro
// removido vira `revoked` (o processador e `removeTeamMember` já cortam na hora).
// `fromCron` ativa a trava CRONS_DISABLED; paginado por cursor.
crons.daily(
  "telegram revoke removed members",
  { hourUTC: 7, minuteUTC: 45 },
  internal.telegram.internalRevokeForRemovedMembers,
  { dryRun: false, fromCron: true }
);

// Telegram F2 (D11): relatórios da manhã/fim do dia na hora LOCAL de cada
// org. De hora em hora no minuto 5; carimbo por data local no vínculo antes
// de agendar (idempotente). `cronsDisabled()` dentro do handler.
crons.cron("telegram reports", "5 * * * *", internal.telegramReports.internalReportsTick, {});

// Billing B6: retoma campanhas pausadas por franquia de envios (`pauseCode` plan_quota)
// quando vira o mes (UTC). Idempotente: se um dia falhar, o seguinte recupera.
crons.daily(
  "resume plan quota campaigns",
  { hourUTC: 0, minuteUTC: 10 },
  internal.campaignWorker.internalResumePlanQuotaCampaigns,
  {}
);

export default crons;
