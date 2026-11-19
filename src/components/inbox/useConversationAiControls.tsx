import { useCallback, useRef, useState, type RefObject } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { AiInstructionPopover } from "@/components/inbox/AiDraftCard";
import { ContactRelationSheet } from "@/components/contacts/ContactRelationSheet";
import { useContactRelationChange } from "@/components/contacts/useContactRelationChange";
import { useNeedsRelationGuard } from "@/components/contacts/useNeedsRelationGuard";
import { mutationErrorMessage } from "@/lib/errors";
import type { ContactRelation } from "@/lib/contactRelationUi";

interface UseConversationAiControlsArgs {
  conversationId: Id<"conversations">;
  contactName: string;
  relation: ContactRelation | undefined;
}

export type ConversationAiControls = ReturnType<typeof useConversationAiControls>;

/**
 * Ações da IA e do tipo de contato de uma conversa, compartilhadas pelo botão
 * da IA (`AiControlMenu`) e pelo menu ⋮ (`ConversationActionsMenu`): assumir,
 * devolver à IA e pedir sugestão (com instrução opcional), "Virar lead" e a
 * folha "Quem é <Nome>?". `overlays` deve ser renderizado uma vez por quem
 * chama (popovers de instrução, folha de tipos e o diálogo `needs_relation`).
 */
export function useConversationAiControls({ conversationId, contactName, relation }: UseConversationAiControlsArgs) {
  const assume = useMutation(api.conversations.assumeConversation);
  const requestDraft = useMutation(api.attendant.requestAiDraft);
  const returnToAi = useMutation(api.attendant.returnToAi);
  const relationChange = useContactRelationChange();
  const guard = useNeedsRelationGuard();

  const fallbackAnchor = useRef<HTMLElement | null>(null);
  const [instruction, setInstruction] = useState<{ kind: "return" | "ask"; anchor: RefObject<HTMLElement | null> } | null>(
    null
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  const handleAssume = () => {
    toast.promise(assume({ conversationId }), {
      loading: "Assumindo…",
      success: "Conversa assumida. IA pausada",
      error: (e) => mutationErrorMessage(e, "Não foi possível assumir a conversa. Tente de novo."),
    });
  };

  const submitReturn = (text?: string) => {
    setInstruction(null);
    return guard.run(
      { conversationId, name: contactName, confirmLabel: "Virar lead e devolver à IA" },
      () => returnToAi({ conversationId, ...(text ? { instruction: text } : {}) }),
      {
        loading: "Devolvendo…",
        success: "Conversa devolvida à IA",
        error: "Não foi possível devolver à IA. Tente de novo.",
      }
    );
  };

  const submitAsk = (text?: string) => {
    setInstruction(null);
    void guard.run(
      { conversationId, name: contactName, confirmLabel: "Virar lead e pedir sugestão" },
      () => requestDraft({ conversationId, ...(text ? { instruction: text } : {}) }),
      {
        loading: "Pedindo à IA…",
        success: "Pedido enviado. A IA vai propor uma resposta",
        error: "Não foi possível pedir a sugestão. Tente de novo.",
      }
    );
  };

  const turnLead = () => void relationChange.turnLead({ conversationId }, contactName);
  const selectRelation = (next: ContactRelation) =>
    void relationChange.apply({ conversationId }, next, contactName, next === "customer" ? { restoreLead: true } : undefined);

  const openRelationSheet = useCallback(() => setSheetOpen(true), []);

  const overlays = (
    <>
      <AiInstructionPopover
        open={instruction?.kind === "return"}
        anchor={instruction?.anchor ?? fallbackAnchor}
        title="Devolver a conversa à IA"
        placeholder='Instrução para a IA (opcional): responda o que ela precisa — ex. "o Pix é financeiro@empresa.com e o valor é R$ 150" — ou peça uma ação: "faça follow-up amanhã"'
        submitLabel="Devolver"
        onSubmit={submitReturn}
        onClose={() => setInstruction(null)}
      />
      <AiInstructionPopover
        open={instruction?.kind === "ask"}
        anchor={instruction?.anchor ?? fallbackAnchor}
        title="Pedir uma sugestão de resposta"
        placeholder="Instrução para a IA (opcional): ex. responda a última dúvida e proponha uma call"
        submitLabel="Pedir"
        onSubmit={submitAsk}
        onClose={() => setInstruction(null)}
      />
      <ContactRelationSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        name={contactName}
        current={relation}
        onSelect={selectRelation}
      />
      {guard.dialog}
    </>
  );

  return {
    assume: handleAssume,
    /** Abre "Devolver a conversa à IA" ancorado em `anchor` (botão da IA ou ⋮). */
    openReturn: (anchor: RefObject<HTMLElement | null>) => setInstruction({ kind: "return", anchor }),
    openAsk: (anchor: RefObject<HTMLElement | null>) => setInstruction({ kind: "ask", anchor }),
    /** Devolve à IA sem instrução (ex.: "É uma pessoa — devolver para a IA"). */
    returnNow: () => submitReturn(),
    turnLead,
    openRelationSheet,
    overlays,
  };
}
