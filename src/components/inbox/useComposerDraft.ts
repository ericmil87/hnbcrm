import { useEffect, useRef, useState } from "react";
import { clearDraft, loadDraft, purgeExpiredDrafts, saveDraft } from "@/lib/pwa/composerDraft";

export const DRAFT_SAVE_DEBOUNCE_MS = 400;

interface UseComposerDraftArgs {
  organizationId: string;
  /** `null` = panel without a conversation: nothing is persisted. */
  conversationId: string | null;
  /** Current team member; the draft waits for it (the key includes the member). */
  memberId: string | null | undefined;
  text: string;
  isInternal: boolean;
  /** Called once with the stored draft when the composer is still empty. */
  onRestore: (text: string) => void;
}

/**
 * Persistent draft per organization + member + conversation. Restores once the member is known (only into an
 * empty field), saves debounced and on unmount/pagehide, clears when the text is empty (sent/scheduled) and
 * whenever "Nota interna" is on: a note must never come back as a customer-visible message.
 */
export function useComposerDraft({ organizationId, conversationId, memberId, text, isInternal, onRestore }: UseComposerDraftArgs) {
  const active = Boolean(conversationId && memberId);
  const [ready, setReady] = useState(false);
  const restoreRef = useRef(onRestore);
  restoreRef.current = onRestore;
  const latest = useRef({ text, isInternal });
  latest.current = { text, isInternal };

  // Restore once per (member, conversation). Saving waits for it, so an empty field never wipes the stored draft.
  useEffect(() => {
    if (!active) {
      setReady(false);
      return;
    }
    purgeExpiredDrafts();
    const stored = loadDraft(organizationId, memberId!, conversationId!);
    if (stored && !latest.current.isInternal) restoreRef.current(stored);
    setReady(true);
    return () => setReady(false);
  }, [active, organizationId, memberId, conversationId]);

  // Debounced save; internal note = clear.
  useEffect(() => {
    if (!active || !ready) return;
    if (isInternal) {
      clearDraft(organizationId, memberId!, conversationId!);
      return;
    }
    const id = window.setTimeout(() => saveDraft(organizationId, memberId!, conversationId!, text), DRAFT_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [active, ready, organizationId, memberId, conversationId, text, isInternal]);

  // Flush on unmount (conversation switch) and on pagehide (reload/close), so the last keystrokes survive the debounce.
  useEffect(() => {
    if (!active || !ready) return;
    const flush = () => {
      const { text: t, isInternal: internal } = latest.current;
      if (internal) clearDraft(organizationId, memberId!, conversationId!);
      else saveDraft(organizationId, memberId!, conversationId!, t);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [active, ready, organizationId, memberId, conversationId]);
}
