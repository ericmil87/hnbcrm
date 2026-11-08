export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = "hnbcrm:composerDraft:v1:";

interface StoredDraft {
  text: string;
  savedAt: number;
}

/** Key per organization + member + conversation: a draft never crosses tenants or accounts on a shared device. */
export function draftKey(organizationId: string, memberId: string, conversationId: string): string {
  return `${PREFIX}${organizationId}:${memberId}:${conversationId}`;
}

/** Returns true when the text is durably stored (or there is nothing to store). Empty text clears. */
export function saveDraft(organizationId: string, memberId: string, conversationId: string, text: string, now: number = Date.now()): boolean {
  const key = draftKey(organizationId, memberId, conversationId);
  try {
    if (text.trim() === "") {
      localStorage.removeItem(key);
      return true;
    }
    const value: StoredDraft = { text, savedAt: now };
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadDraft(organizationId: string, memberId: string, conversationId: string, now: number = Date.now()): string {
  const key = draftKey(organizationId, memberId, conversationId);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return "";
    const parsed = JSON.parse(raw) as Partial<StoredDraft> | null;
    if (!parsed || typeof parsed.text !== "string" || typeof parsed.savedAt !== "number") {
      localStorage.removeItem(key);
      return "";
    }
    if (now - parsed.savedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(key);
      return "";
    }
    return parsed.text;
  } catch {
    return "";
  }
}

export function clearDraft(organizationId: string, memberId: string, conversationId: string): void {
  try {
    localStorage.removeItem(draftKey(organizationId, memberId, conversationId));
  } catch {
    /* ignore */
  }
}

/** Removes expired or unreadable drafts. Returns how many were removed. */
export function purgeExpiredDrafts(now: number = Date.now()): number {
  let removed = 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) {
      let expired = true;
      try {
        const parsed = JSON.parse(localStorage.getItem(k) ?? "null") as Partial<StoredDraft> | null;
        expired = !parsed || typeof parsed.savedAt !== "number" || now - parsed.savedAt > DRAFT_TTL_MS;
      } catch {
        expired = true;
      }
      if (expired) {
        localStorage.removeItem(k);
        removed++;
      }
    }
  } catch {
    /* storage unavailable */
  }
  return removed;
}

/** Sign-out / expired session: no draft is left for the next person on the device. */
export function clearStoredDrafts(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
}
