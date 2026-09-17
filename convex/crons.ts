import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("process overdue reminders", { minutes: 5 }, internal.tasks.processOverdueReminders);
crons.interval("process recurring tasks", { hours: 1 }, internal.tasks.processRecurringTasks);

// Daily digest email — 11:00 UTC = 08:00 BRT (Brasilia Time)
crons.daily("send daily digest", { hourUTC: 11, minuteUTC: 0 }, internal.email.sendDailyDigest);

crons.interval("mark abandoned form partials", { minutes: 10 }, internal.formPartials.internalMarkAbandoned);

// Publicações programadas em grupo: rede de segurança para a que perdeu o
// agendamento (o worker normal se auto-reagenda; isto é só o resgate).
crons.interval("group posts watchdog", { hours: 1 }, internal.groupPostWorker.internalWatchdog, {});

// Digest diário por grupo (F4): o cron roda de hora em hora e só age nos
// grupos cujo `ai.dailyDigestAt` bate com a hora local da org.
crons.interval("group daily digests", { hours: 1 }, internal.groupAgent.internalRunGroupDigests, {});

// Blobs de export vivem 7 dias (exportJobs.expiresAt); a limpeza roda de hora em hora.
crons.interval("cleanup expired exports", { hours: 1 }, internal.exports.internalCleanupExpired, {});

export default crons;
