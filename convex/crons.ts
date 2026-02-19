import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("process overdue reminders", { minutes: 5 }, internal.tasks.processOverdueReminders);
crons.interval("process recurring tasks", { hours: 1 }, internal.tasks.processRecurringTasks);

// Daily digest email — 11:00 UTC = 08:00 BRT (Brasilia Time)
crons.daily("send daily digest", { hourUTC: 11, minuteUTC: 0 }, internal.email.sendDailyDigest);

export default crons;
