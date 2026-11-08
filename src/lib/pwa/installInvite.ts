export const INSTALL_MIN_VISITS = 3;
export const INSTALL_DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

const VISITS_KEY = "hnbcrm:pwa:visits";
const DISMISSED_KEY = "hnbcrm:pwa:installDismissedAt";
const SESSION_KEY = "hnbcrm:pwa:visitCounted";
const SHOWN_KEY = "hnbcrm:pwa:inviteShown";
/** The banner stays at most this long (it also closes on route change). */
export const INVITE_VISIBLE_MS = 20_000;

export interface InviteInput {
  visits: number;
  standalone: boolean;
  /** The device can actually install: `beforeinstallprompt` captured, or iPhone/iPad Safari. */
  installable: boolean;
  dismissedAt: number | null;
  now: number;
}

/** Contextual invite: from the 3rd logged-in visit, never installed/standalone, quiet for 30 days after dismissal. */
export function shouldShowInstallInvite({ visits, standalone, installable, dismissedAt, now }: InviteInput): boolean {
  if (standalone || !installable) return false;
  if (visits < INSTALL_MIN_VISITS) return false;
  if (dismissedAt !== null && now - dismissedAt < INSTALL_DISMISS_MS) return false;
  return true;
}

function readNumber(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function readVisits(): number {
  return readNumber(VISITS_KEY) ?? 0;
}

export function readDismissedAt(): number | null {
  return readNumber(DISMISSED_KEY);
}

export function dismissInstallInvite(now: number = Date.now()): void {
  try {
    localStorage.setItem(DISMISSED_KEY, String(now));
  } catch {
    /* storage unavailable: the invite may come back next visit, acceptable */
  }
}

/** Counts one visit per browser session (tab/app launch). Returns the new total. */
export function registerVisit(): number {
  const current = readVisits();
  try {
    if (sessionStorage.getItem(SESSION_KEY)) return current;
    sessionStorage.setItem(SESSION_KEY, "1");
    localStorage.setItem(VISITS_KEY, String(current + 1));
    return current + 1;
  } catch {
    return current;
  }
}

/** The banner is shown at most once per browser session (it covers list ends on phones). */
export function inviteShownThisSession(): boolean {
  try {
    return sessionStorage.getItem(SHOWN_KEY) === "1";
  } catch {
    return false;
  }
}

export function markInviteShown(): void {
  try {
    sessionStorage.setItem(SHOWN_KEY, "1");
  } catch {
    /* storage unavailable */
  }
}
