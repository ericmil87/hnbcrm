import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { listDrafts, subscribeDrafts } from "@/lib/pwa/composerDraft";
import { CONTACT_TYPING_TTL_MS } from "@/lib/threadPaging";
import { resolveListPreview, type ListPreview } from "@/lib/listPreview";

/**
 * How long one `since` cut stays before a new one re-subscribes. Kept short on purpose: every write to a
 * `conversationRuntime` row inside the range (presence, AI lock, dispatch pacing) re-runs the query for every
 * member with the list open, so the range must hold only the last minute of rows, not the last five.
 */
const SINCE_REFRESH_MS = 60_000;

/**
 * Drafts stored on this device for this member: one storage scan per change, reactive (no reload).
 * Changes to the OPEN conversation's draft are ignored (its row never shows "Rascunho:"), so typing in the
 * composer does not re-render the list every 400 ms.
 */
function useDraftTexts(organizationId: string, memberId: string | null | undefined, openId: string | null) {
  const [version, setVersion] = useState(0);
  const openRef = useRef(openId);
  openRef.current = openId;
  useEffect(() => {
    if (!memberId) return;
    return subscribeDrafts((id) => {
      if (id !== null && id === openRef.current) return;
      setVersion((v) => v + 1);
    });
  }, [memberId]);
  // `openId` is a dependency: leaving a conversation re-reads the draft it just flushed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (memberId ? listDrafts(organizationId, memberId) : new Map<string, string>()), [organizationId, memberId, openId, version]);
}

/** Org-wide "contact is typing" for the list: ONE light subscription (see `getTypingConversations`). */
function useTypingIds(organizationId: Id<"organizations"> | undefined, enabled: boolean): ReadonlySet<string> {
  const [sinceBase, setSinceBase] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setSinceBase(Date.now()), SINCE_REFRESH_MS);
    return () => clearInterval(id);
  }, []);
  const since = sinceBase - CONTACT_TYPING_TTL_MS;
  const live = useQuery(api.conversations.getTypingConversations, enabled && organizationId ? { organizationId, since } : "skip");
  // A new `since` re-subscribes and the result is briefly undefined: keep the last rows so "digitando…" does not blink.
  const lastRows = useRef(live);
  if (live !== undefined) lastRows.current = live;
  const rows = enabled ? live ?? lastRows.current : undefined;
  const [now, setNow] = useState(() => Date.now());
  const hasRows = (rows?.length ?? 0) > 0;
  useEffect(() => {
    if (!hasRows) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 4000);
    return () => clearInterval(id);
  }, [hasRows, rows]);
  return useMemo(() => {
    const ids = new Set<string>();
    for (const r of rows ?? []) if (now - r.at < CONTACT_TYPING_TTL_MS) ids.add(r.conversationId);
    return ids;
  }, [rows, now]);
}

/** What each list row shows after the last-message preview: typing > draft > message. */
export function useListPreviews(args: {
  organizationId: Id<"organizations">;
  memberId: string | null | undefined;
  openId: string | null;
}): (conversationId: string) => ListPreview {
  const { organizationId, memberId, openId } = args;
  const drafts = useDraftTexts(organizationId, memberId, openId);
  const typing = useTypingIds(organizationId, Boolean(memberId));
  return (conversationId) =>
    resolveListPreview({
      contactTyping: typing.has(conversationId),
      draft: drafts.get(conversationId),
      isOpen: openId === conversationId,
    });
}
