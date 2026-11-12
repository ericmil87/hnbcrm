import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { useAuthToken } from "@convex-dev/auth/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { usePermissions } from "@/hooks/usePermissions";
import { mutationErrorMessage } from "@/lib/errors";
import type { HistoryMessage } from "@/lib/onboardingChat";
import type { OnboardingIntent } from "@/lib/onboardingIntent";
import { writeSelectedOrgId } from "@/lib/selectedOrg";
import {
  HISTORY_PAGE,
  OnboardingConversationController,
  type ConversationAccess,
} from "./OnboardingConversationController";

export { GREETING_CHIPS, WIZARD_HREF } from "./OnboardingConversationController";

export interface OnboardingConversationProps {
  organizationId: Id<"organizations">;
  intent: OnboardingIntent | null;
  onIntentConsumed?: () => void;
  orgPicker?: ReactNode;
}

/**
 * Container da conversa com org: permissão, `getOrCreateSession` (uma vez por
 * org), histórico paginado (`listMessages`), `getChatState`, `getSession`
 * (etapa + rascunho) e o JWT. A lógica da conversa vive no
 * `OnboardingConversationController` (sem Convex, testado).
 */
export function OnboardingConversation({ organizationId, intent, onIntentConsumed, orgPicker }: OnboardingConversationProps) {
  const { can, isLoading: permsLoading } = usePermissions(organizationId);
  const canManage = can("settings", "manage");
  const getOrCreateSession = useMutation(api.onboardingSessions.getOrCreateSession);
  const token = useAuthToken();
  const [sessionId, setSessionId] = useState<Id<"onboardingSessions"> | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const openedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (permsLoading || !canManage || openedForRef.current === organizationId) return;
    openedForRef.current = organizationId;
    getOrCreateSession({ organizationId })
      .then((s) => setSessionId(s._id))
      .catch((err) => setSessionError(mutationErrorMessage(err, "Não foi possível abrir a conversa. Recarregue a página.")));
  }, [organizationId, permsLoading, canManage, getOrCreateSession]);

  const ready = sessionId !== null;
  const chatState = useQuery(api.onboardingChat.getChatState, ready ? { organizationId } : "skip");
  const session = useQuery(api.onboardingSessions.getSession, ready ? { organizationId } : "skip");
  const history = usePaginatedQuery(
    api.onboardingChat.listMessages,
    sessionId ? { organizationId, sessionId } : "skip",
    { initialNumItems: HISTORY_PAGE }
  );

  const access: ConversationAccess = sessionError
    ? { kind: "error", message: sessionError }
    : permsLoading
      ? { kind: "loading" }
      : !canManage
        ? { kind: "forbidden" }
        : ready
          ? { kind: "ready" }
          : { kind: "loading" };

  const onSession = useCallback((id: string) => setSessionId(id as Id<"onboardingSessions">), []);
  const onPreferForm = useCallback(() => writeSelectedOrgId(organizationId), [organizationId]);

  return (
    <OnboardingConversationController
      organizationId={organizationId}
      access={access}
      sessionId={sessionId}
      history={{ results: history.results as readonly HistoryMessage[], status: history.status, loadMore: history.loadMore }}
      sessionStage={session?.stage ?? null}
      chatState={chatState ? { stage: chatState.stage, lastChips: chatState.lastChips } : null}
      draft={session?.draft ?? null}
      token={token ?? null}
      intent={intent}
      onIntentConsumed={onIntentConsumed}
      onSession={onSession}
      onPreferForm={onPreferForm}
      orgPicker={orgPicker}
    />
  );
}
