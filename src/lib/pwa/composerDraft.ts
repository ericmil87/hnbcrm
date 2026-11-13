export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIX = "hnbcrm:composerDraft:v1:";

interface StoredDraft {
  text: string;
  savedAt: number;
}

type DraftListener = (conversationId: string | null) => void;
const listeners = new Set<DraftListener>();

/** Notifies readers (the conversation list) that a stored draft changed; `null` = several/unknown. */
function emitDraftChange(conversationId: string | null): void {
  for (const l of listeners) l(conversationId);
}

/** Reactive read of drafts: called after every write in this tab and on `storage` events from other tabs. */
export function subscribeDrafts(listener: DraftListener): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(PREFIX)) listener(null);
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Non-empty, unexpired drafts of one member in one organization, by conversation id. One storage scan. */
export function listDrafts(organizationId: string, memberId: string, now: number = Date.now()): Map<string, string> {
  const out = new Map<string, string>();
  const prefix = `${PREFIX}${organizationId}:${memberId}:`;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(k) ?? "null") as Partial<StoredDraft> | null;
        if (!parsed || typeof parsed.text !== "string" || typeof parsed.savedAt !== "number") continue;
        if (now - parsed.savedAt > DRAFT_TTL_MS || parsed.text.trim() === "") continue;
        out.set(k.slice(prefix.length), parsed.text);
      } catch {
        /* unreadable entry: ignore */
      }
    }
  } catch {
    /* storage unavailable */
  }
  return out;
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
      emitDraftChange(conversationId);
      return true;
    }
    const value: StoredDraft = { text, savedAt: now };
    localStorage.setItem(key, JSON.stringify(value));
    emitDraftChange(conversationId);
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
    emitDraftChange(conversationId);
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
    if (removed > 0) emitDraftChange(null);
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
    if (keys.length > 0) emitDraftChange(null);
  } catch {
    /* storage unavailable */
  }
}
