/**
 * Executive reports on Telegram (F2, §3.7/§4.7, D11). Pure: local-time helpers
 * and the two formatters. Data comes from `telegramReports.internalBuildReportData`.
 *
 * Every count is bounded upstream (`REPORT_CAP`); a capped section renders as
 * "50+". Names are allowed (the reader has inbox access); never e-mails or
 * phones. Discreet mode reuses the F1 helpers (`initials`/`redactName`).
 */
import { escapeHtml, maskDigitRuns } from "./telegramFormat";
import {
  callbackData,
  formatMoney,
  initials,
  redactName,
  stripEmails,
  type CardKeyboard,
} from "./telegramNotifications";

/** Max items counted per section; more renders as "50+". */
export const REPORT_CAP = 50;

// ---------------------------------------------------------------------------
// Local time (org timezone). DST-safe: date strings and two-pass offsets,
// never hour arithmetic on UTC.
// ---------------------------------------------------------------------------

type LocalParts = { y: number; m: number; d: number; hour: number; minute: number; weekday: number };

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(at: number, timeZone: string): LocalParts {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? "";
  return {
    y: Number(g("year")),
    m: Number(g("month")),
    d: Number(g("day")),
    hour: Number(g("hour")) % 24,
    minute: Number(g("minute")),
    weekday: WEEKDAY_INDEX[g("weekday")] ?? 0,
  };
}

/** "AAAA-MM-DD" in the org timezone (the idempotency stamp of a report). */
export function localDateKey(at: number, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

function offsetMs(at: number, timeZone: string): number {
  const p = localParts(at, timeZone);
  const seconds = new Date(at).getUTCSeconds();
  return Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, seconds) - (at - (at % 1000));
}

/** Instant of `hour`:00 on (today + `dayOffset`) in `timeZone`. */
export function atLocal(now: number, timeZone: string, dayOffset: number, hour: number): number {
  const p = localParts(now, timeZone);
  const guess = Date.UTC(p.y, p.m - 1, p.d + dayOffset, hour, 0, 0);
  let at = guess - offsetMs(guess, timeZone);
  at = guess - offsetMs(at, timeZone);
  return at;
}

export function isWeekend(at: number, timeZone: string): boolean {
  const w = localParts(at, timeZone).weekday;
  return w === 0 || w === 6;
}

const WEEKDAY_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "ter 03/11" */
export function shortDatePt(at: number, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${WEEKDAY_PT[p.weekday]} ${String(p.d).padStart(2, "0")}/${String(p.m).padStart(2, "0")}`;
}

function hhmm(at: number, timeZone: string): string {
  const p = localParts(at, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** "10h" for whole hours, "10:30" otherwise. */
function shortHour(at: number, timeZone: string): string {
  const p = localParts(at, timeZone);
  return p.minute === 0 ? `${p.hour}h` : hhmm(at, timeZone);
}

/** "40 min", "3h", "2 dias". */
export function ageLabel(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 dia" : `${d} dias`;
}

// ---------------------------------------------------------------------------
// Data shape (built by `telegramReports.internalBuildReportData`)
// ---------------------------------------------------------------------------

export type Counted = { count: number; capped: boolean };

export type ReportHandoff = { id: string; leadName: string; reason?: string; createdAt: number };
export type ReportTask = { id: string; title: string; dueDate?: number; leadName?: string };

export type MorningData = {
  handoffs: Counted & { oldestAt?: number; items: ReportHandoff[] };
  /** null = not in this member's scope (agents). */
  followUps: (Counted & { items: { leadName: string; dueAt: number }[] }) | null;
  tasksToday: Counted & { items: ReportTask[] };
  tasksOverdue: Counted & { items: ReportTask[] };
  /** `sinceLabel`: "ontem 18h", or "sexta 18h" on Mondays with weekends off. */
  newLeads: Counted & { mine: number; sinceLabel: string; items: { title: string; source?: string }[] };
  unread: Counted;
  channels: { total: number; down: string[] };
};

export type EveningData = {
  newLeads: Counted;
  won: Counted & { value: number };
  lost: Counted;
  tasksCompleted: Counted;
  tasksPending: Counted;
  ownerlessHandoffs: Counted & { items: ReportHandoff[] };
  /** null = not in this member's scope (agents). `runsToday` has its own cap (500 runs). */
  ai: { runsToday: Counted; costTodayUsd: number; costMonthUsd: number } | null;
  tomorrowTasks: Counted & { items: ReportTask[] };
};

export type ReportData = {
  scope: "org" | "own";
  /** The reader may act on handoffs (`inbox:reply`): gates "Pegar <nome>". */
  canReply: boolean;
  morning?: MorningData;
  evening?: EveningData;
};

export type ReportOptions = {
  memberName: string;
  /** Telegram first name of the link — fallback when the member name is an e-mail. */
  firstName?: string;
  orgName: string;
  timezone: string;
  currency: string;
  now: number;
  discreet: boolean;
  appBaseUrl: string;
  /** Org USD→BRL rate for AI cost (`resolveSpendCap(...).usdBrlRate`). */
  usdBrlRate: number;
};

export type ReportOutput = { text: string; keyboard: CardKeyboard };

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/** "7", "50+" (more than the cap) or "3+" (an index read hit its limit: maybe more). */
function n(c: Counted): string {
  return c.capped ? `${c.count}+` : String(c.count);
}

function plural(c: Counted, one: string, many: string): string {
  return `${n(c)} ${c.count === 1 && !c.capped ? one : many}`;
}

/** A customer/lead name for the report: initials in discreet mode (e-mails only hidden there). */
function personName(name: string, discreet: boolean): string {
  const clean = (discreet ? stripEmails(name) : name).trim() || "Contato";
  return escapeHtml(discreet ? maskDigitRuns(initials(clean)) : clean);
}

/** Labels (channel names, sources): digit runs masked in discreet mode. */
function labelText(text: string, discreet: boolean): string {
  return escapeHtml(discreet ? maskDigitRuns(stripEmails(text)) : text);
}

/** Free text that may carry a lead name (task titles, reasons). */
function freeText(text: string, leadName: string | undefined, discreet: boolean, max = 60): string {
  let t = (discreet ? stripEmails(text) : text).replace(/\s+/g, " ").trim();
  if (discreet && leadName) t = redactName({ discreet: true, lead: { id: "", title: leadName } }, t);
  if (t.length > max) t = `${t.slice(0, max).trimEnd()}…`;
  // Discreet: phones/documents in task titles and reasons (review F2 #1).
  if (discreet) t = maskDigitRuns(t);
  return escapeHtml(t);
}

// AI cost is always shown in BRL (not the org currency): the spend cap and its rate are in BRL.
function brl(usd: number, rate: number): string {
  return `R$ ${(usd * rate).toFixed(2).replace(".", ",")}`;
}

const crmButton = (o: ReportOptions) => ({ text: "🔗 Abrir CRM", url: `${o.appBaseUrl}/app/painel` });

/**
 * ", Eric" or "" — never "[e-mail]": members created from an invite often have
 * the e-mail as `name`; then the Telegram first name is used, else no name.
 */
export function greetingName(o: Pick<ReportOptions, "memberName" | "firstName">): string {
  const raw = o.memberName.trim();
  const candidate = raw.includes("@") ? (o.firstName ?? "").trim() : raw;
  const first = candidate.split(/\s+/)[0] ?? "";
  if (!first || first.includes("@")) return "";
  return `, ${escapeHtml(first)}`;
}

export function formatMorningReport(data: ReportData, o: ReportOptions): ReportOutput {
  const m = data.morning!;
  const tz = o.timezone;
  const lines: string[] = [
    `☀️ Bom dia${greetingName(o)} · ${escapeHtml(o.orgName)} · ${shortDatePt(o.now, tz)}`,
  ];

  if (m.handoffs.count === 0) lines.push("🔁 Nenhum repasse esperando");
  else {
    const oldest = m.handoffs.items[0];
    const tail =
      m.handoffs.oldestAt !== undefined && oldest
        ? ` (mais antigo: ${ageLabel(o.now - m.handoffs.oldestAt)}, ${personName(oldest.leadName, o.discreet)})`
        : "";
    lines.push(`🔁 ${plural(m.handoffs, "repasse esperando", "repasses esperando")}${tail}`);
  }

  if (m.followUps) {
    if (m.followUps.count === 0) lines.push("⏰ Nenhum follow-up da IA hoje");
    else {
      const who = m.followUps.items
        .slice(0, 3)
        .map((f) => `${personName(f.leadName, o.discreet)} ${shortHour(f.dueAt, tz)}`)
        .join(", ");
      lines.push(`⏰ ${plural(m.followUps, "follow-up da IA hoje", "follow-ups da IA hoje")}${who ? ` (${who})` : ""}`);
    }
  }

  const overdue = m.tasksOverdue.count;
  const firstOverdue = m.tasksOverdue.items[0];
  const overdueLabel =
    overdue === 0 && !m.tasksOverdue.capped
      ? ""
      : ` · ${plural(m.tasksOverdue, "atrasada", "atrasadas")}${
          firstOverdue?.leadName ? ` (${personName(firstOverdue.leadName, o.discreet)})` : ""
        }`;
  lines.push(`✅ Suas tarefas: ${n(m.tasksToday)} hoje${overdueLabel}`);

  const mine = data.scope === "org" && m.newLeads.count > 0 ? ` (${m.newLeads.mine} seus)` : "";
  const leadsLabel =
    data.scope === "org"
      ? `🆕 ${plural(m.newLeads, `lead desde ${m.newLeads.sinceLabel}`, `leads desde ${m.newLeads.sinceLabel}`)}${mine}`
      : `🆕 ${plural(m.newLeads, `lead seu desde ${m.newLeads.sinceLabel}`, `leads seus desde ${m.newLeads.sinceLabel}`)}`;
  lines.push(`${leadsLabel} · 💬 ${plural(m.unread, "conversa não lida", "conversas não lidas")}`);

  if (m.channels.total > 0) {
    lines.push(
      m.channels.down.length === 0
        ? "🟢 Canais conectados"
        : `🔴 Fora do ar: ${m.channels.down.map((c) => labelText(c, o.discreet)).join(", ")}`,
    );
  }

  const details: string[] = [];
  if (m.handoffs.items.length > 0) {
    details.push(
      `Repasses: ${m.handoffs.items
        .map((h) => `${personName(h.leadName, o.discreet)}${h.reason ? ` (${freeText(h.reason, h.leadName, o.discreet, 30)})` : ""}`)
        .join(", ")}`,
    );
  }
  if (m.newLeads.items.length > 0) {
    const label = data.scope === "org" ? "Leads novos" : "Leads novos seus";
    details.push(
      `${label}: ${m.newLeads.items
        .map((l) => `${personName(l.title, o.discreet)}${l.source ? ` (${labelText(l.source, o.discreet)})` : ""}`)
        .join(", ")}`,
    );
  }
  if (m.tasksToday.items.length > 0) {
    details.push(
      `Tarefas hoje: ${m.tasksToday.items
        .map((t) => `${t.dueDate !== undefined ? `${hhmm(t.dueDate, tz)} ` : ""}${freeText(t.title, t.leadName, o.discreet)}`)
        .join(" · ")}`,
    );
  }
  // `expandableQuote` escapes its input; these pieces are already HTML, so the
  // quote is built by hand.
  if (details.length > 0) lines.push(`<blockquote expandable>Detalhes\n${details.join("\n")}</blockquote>`);

  return {
    text: lines.join("\n"),
    keyboard: [
      [
        { text: "🔁 Ver repasses", callback_data: "cmd:repasses" },
        { text: "✅ Ver tarefas", callback_data: "cmd:tarefas" },
      ],
      [crmButton(o)],
    ],
  };
}

export function formatEveningReport(data: ReportData, o: ReportOptions): ReportOutput {
  const e = data.evening!;
  const tz = o.timezone;
  const lines: string[] = [`🌙 Fechamento · ${shortDatePt(o.now, tz)} · ${escapeHtml(o.orgName)}`];

  const wonValue = e.won.count > 0 && e.won.value > 0 ? ` (${escapeHtml(formatMoney(e.won.value, o.currency))})` : "";
  lines.push(
    `🆕 ${plural(e.newLeads, "lead criado", "leads criados")} · 🏆 ${plural(e.won, "ganho", "ganhos")}${wonValue} · ❌ ${plural(e.lost, "perdido", "perdidos")}`,
  );
  lines.push(
    `✅ ${plural(e.tasksCompleted, "tarefa concluída", "tarefas concluídas")} · ${plural(e.tasksPending, "ficou para amanhã", "ficaram para amanhã")}`,
  );

  if (e.ownerlessHandoffs.count === 0) lines.push("🔁 Nenhum repasse sem dono");
  else if (e.ownerlessHandoffs.count === 1 && !e.ownerlessHandoffs.capped && e.ownerlessHandoffs.items[0]) {
    const h = e.ownerlessHandoffs.items[0];
    const reason = h.reason ? `${freeText(h.reason, h.leadName, o.discreet, 30)}, ` : "";
    lines.push(`🔁 1 repasse ainda sem dono: ${personName(h.leadName, o.discreet)} (${reason}${ageLabel(o.now - h.createdAt)} esperando) ⚠️`);
  } else {
    lines.push(`🔁 ${plural(e.ownerlessHandoffs, "repasse", "repasses")} ainda sem dono ⚠️`);
  }

  if (e.ai) {
    lines.push(
      `🤖 IA: ${e.ai.runsToday.count}${e.ai.runsToday.capped ? "+" : ""} ${e.ai.runsToday.count === 1 ? "execução" : "execuções"} · custo ${brl(e.ai.costTodayUsd, o.usdBrlRate)} hoje · ${brl(e.ai.costMonthUsd, o.usdBrlRate)} no mês`,
    );
  }

  if (e.tomorrowTasks.items.length > 0) {
    const items = e.tomorrowTasks.items
      .map((t) => `${t.dueDate !== undefined ? `${hhmm(t.dueDate, tz)} ` : ""}${freeText(t.title, t.leadName, o.discreet)}`)
      .join(" · ");
    const more = e.tomorrowTasks.count > e.tomorrowTasks.items.length || e.tomorrowTasks.capped ? " · …" : "";
    lines.push(`<blockquote expandable>Amanhã\n${items}${more}</blockquote>`);
  }

  const keyboard: CardKeyboard = [];
  const only = e.ownerlessHandoffs.count === 1 && !e.ownerlessHandoffs.capped ? e.ownerlessHandoffs.items[0] : undefined;
  if (only && data.canReply) {
    const name = o.discreet ? initials(stripEmails(only.leadName)) : only.leadName.split(/\s+/).slice(0, 2).join(" ");
    keyboard.push([{ text: `🔁 Pegar ${name}`, callback_data: callbackData("ah", only.id) }]);
  }
  keyboard.push([crmButton(o)]);
  return { text: lines.join("\n"), keyboard };
}
