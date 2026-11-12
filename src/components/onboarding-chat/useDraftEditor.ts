import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import type { OnboardingDraft } from "../../../convex/lib/onboardingDraft";
import { mutationErrorMessage } from "@/lib/errors";
import { saveDraftEdit, type DraftUpdate } from "@/lib/onboardingDraftEdit";
import type { BlockContext } from "./blocks/types";

export interface DraftEditor {
  /** A sessão já chegou do servidor. */
  loaded: boolean;
  /** Rascunho gravado agora (reativo); null = sem sessão ou sem rascunho. */
  draft: OnboardingDraft | null;
  version: number;
  hash: string | null;
  appliedHash: string | null;
  saving: boolean;
  /**
   * Grava `update(rascunho atual)` com `expectedVersion = baseVersion` (a
   * versão que o formulário tinha ao abrir). `false` = não gravou (o aviso já
   * foi mostrado); os campos recarregam sozinhos com a versão nova.
   */
  save: (update: DraftUpdate, baseVersion: number) => Promise<boolean>;
}

/** Contexto do servidor reconstruído no cliente para remontar um bloco a partir do rascunho vivo (`buildBlock`). */
export function liveBlockContext(ed: DraftEditor, aiActive = false) {
  return {
    draft: ed.draft,
    draftHash: ed.hash,
    draftVersion: ed.version,
    appliedDraftHash: ed.appliedHash,
    emailVerified: true,
    aiActive,
  };
}

/**
 * Rascunho vivo da sessão + gravação por `saveDraft` com versão (P3.3).
 * Só é montado por cartões já abertos para ajuste (os hooks de Convex ficam
 * fora do caminho estático dos blocos).
 */
export function useDraftEditor(ctx: Pick<BlockContext, "organizationId" | "sessionId">): DraftEditor {
  const organizationId = ctx.organizationId as Id<"organizations"> | null;
  const session = useQuery(api.onboardingSessions.getSession, organizationId ? { organizationId } : "skip");
  const saveDraft = useMutation(api.onboardingSessions.saveDraft);
  const [saving, setSaving] = useState(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const busyRef = useRef(false);

  const save = useCallback(
    async (update: DraftUpdate, baseVersion: number) => {
      const current = sessionRef.current;
      if (busyRef.current || !organizationId || !current) return false;
      const sessionId = (ctx.sessionId ?? current._id) as Id<"onboardingSessions">;
      busyRef.current = true;
      setSaving(true);
      try {
        const outcome = await saveDraftEdit({
          current: current.draft ? { draft: current.draft, version: current.draftVersion } : null,
          baseVersion,
          update,
          mutate: (args) =>
            saveDraft({ organizationId, sessionId, draft: args.draft, expectedVersion: args.expectedVersion }),
          errorMessage: (e) => mutationErrorMessage(e, "Não foi possível salvar o ajuste."),
        });
        if (outcome.ok) {
          toast.success("Ajuste salvo");
          return true;
        }
        if (outcome.reason === "stale" || outcome.reason === "conflict") toast.warning(outcome.message);
        else toast.error(outcome.message);
        return false;
      } finally {
        busyRef.current = false;
        setSaving(false);
      }
    },
    [organizationId, ctx.sessionId, saveDraft]
  );

  return {
    loaded: session !== undefined,
    draft: session?.draft ?? null,
    version: session?.draftVersion ?? 0,
    hash: session?.draftHash ?? null,
    appliedHash: session?.appliedDraftHash ?? null,
    saving,
    save,
  };
}
