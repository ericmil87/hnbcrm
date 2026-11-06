import { useCallback } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { mutationErrorMessage } from "@/lib/errors";
import { useShowOriginalPref } from "@/lib/translationPrefs";
import type { LanguageChoice } from "./ConversationLanguageChip";

/**
 * Escrita do idioma da conversa (uma por ação do usuário) + a preferência
 * local "mostrar original junto". Usado pelo chip do composer, pela pílula do
 * cabeçalho, pelo menu ⋮ e pelo aviso da conversa.
 */
export function useConversationLanguage(conversationId: string | null | undefined) {
  const setLanguage = useMutation(api.translation.setConversationLanguage);
  const [showBoth, setShowBoth] = useShowOriginalPref();

  const choose = useCallback(
    async (choice: LanguageChoice, opts?: { silent?: boolean }) => {
      if (!conversationId) return;
      try {
        await setLanguage({
          conversationId: conversationId as Id<"conversations">,
          mode: choice.mode,
          ...(choice.mode === "manual" ? { lang: choice.lang } : {}),
          ...(choice.mode === "manual" && choice.applyToContact ? { applyToContact: true } : {}),
        });
        if (opts?.silent) return;
        toast.success(
          choice.mode === "off" ? "Tradução desligada. Mostrando só o original" : "Tradução ligada para esta conversa"
        );
      } catch (e) {
        toast.error(mutationErrorMessage(e, "Não foi possível trocar o idioma da conversa."));
      }
    },
    [conversationId, setLanguage]
  );

  /** "Não traduzir este contato": desliga aqui e grava o idioma da equipe no contato. */
  const neverForContact = useCallback(
    async (teamLanguage: string) => {
      if (!conversationId) return;
      try {
        await setLanguage({
          conversationId: conversationId as Id<"conversations">,
          mode: "off",
          lang: teamLanguage,
          applyToContact: true,
        });
        toast.success("Contato marcado para não traduzir");
      } catch (e) {
        toast.error(mutationErrorMessage(e, "Não foi possível atualizar o contato."));
      }
    },
    [conversationId, setLanguage]
  );

  return { choose, neverForContact, showBoth, setShowBoth };
}
