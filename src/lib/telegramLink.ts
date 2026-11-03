/** Pure helpers for the Telegram link card. */

const pad = (n: number) => String(n).padStart(2, "0");

/** "HH:MM" in local time. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "dd/mm" in local time. */
export function formatDayMonth(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

/** Hour of day as "08:00". */
export function formatHour(hour: number): string {
  return `${pad(hour)}:00`;
}

/** Remaining time as "m:ss"; "0:00" once expired. */
export function formatCountdown(expiresAt: number, now: number): string {
  const secs = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(secs / 60)}:${pad(secs % 60)}`;
}

export function isExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}

/** "@username", else first name, else generic label. */
export function telegramDisplayName(link: { username?: string; firstName?: string }): string {
  if (link.username) return `@${link.username.replace(/^@/, "")}`;
  if (link.firstName) return link.firstName;
  return "sua conta";
}
