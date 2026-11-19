import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import type { Id } from "../../../convex/_generated/dataModel";
import { NeedsRelationDialog } from "@/components/contacts/ContactRelationSheet";
import { useContactRelationChange } from "@/components/contacts/useContactRelationChange";
import { mutationErrorMessage } from "@/lib/errors";
import { needsRelationFrom, type ContactRelation } from "@/lib/contactRelationUi";

export interface NeedsRelationContext {
  conversationId: Id<"conversations">;
  name: string | null | undefined;
  /** Rótulo do botão principal ("Virar lead e devolver à IA"). */
  confirmLabel?: string;
}

export interface GuardedMessages {
  loading: string;
  success: string;
  error: string;
}

interface Pending extends NeedsRelationContext {
  relation: ContactRelation;
  retry: () => unknown;
}

const DEFAULT_CONFIRM = "Virar lead e devolver à IA";

/**
 * Ações da IA (devolver, rejeitar repasse, pedir sugestão) num contato que não
 * é cliente: o servidor responde `needs_relation` (retorno ou `ConvexError`).
 * O guarda abre "<Nome> está como Pessoal… [Virar lead e devolver à IA]
 * [Cancelar]"; confirmar vira lead pela conversa e repete a ação original.
 * Sem `contacts:edit` (`canEditContact`) o diálogo só explica, sem "Virar lead".
 */
export function useNeedsRelationGuard(canEditContact: boolean) {
  const { turnLead } = useContactRelationChange();
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  // Evita laço: na repetição depois de virar lead, um novo `needs_relation` vira erro comum.
  const retryingRef = useRef(false);

  /** Abre o diálogo se `value` (retorno ou erro) pede o tipo; `true` = interceptado. */
  const intercept = useCallback((value: unknown, ctx: NeedsRelationContext, retry: () => unknown): boolean => {
    const relation = needsRelationFrom(value);
    if (!relation) return false;
    if (retryingRef.current) {
      toast.error("A IA ainda não pode responder este contato. Tente de novo.");
      return true;
    }
    setPending({ ...ctx, relation, retry });
    return true;
  }, []);

  /** Executa a ação com toast de carregando/sucesso/erro, interceptando o pedido de tipo. */
  const run = useCallback(
    async (ctx: NeedsRelationContext, action: () => Promise<unknown>, messages: GuardedMessages): Promise<boolean> => {
      const id = toast.loading(messages.loading);
      const again = () => run(ctx, action, messages);
      try {
        const result = await action();
        if (intercept(result, ctx, again)) {
          toast.dismiss(id);
          return false;
        }
        toast.success(messages.success, { id });
        return true;
      } catch (error) {
        if (intercept(error, ctx, again)) {
          toast.dismiss(id);
          return false;
        }
        toast.error(mutationErrorMessage(error, messages.error), { id });
        return false;
      }
    },
    [intercept]
  );

  const confirm = async () => {
    if (!pending || busy || !canEditContact) return;
    setBusy(true);
    try {
      // Vem de um tipo fora do comercial: `turnLead` restaura o lead arquivado pela marcação.
      const result = await turnLead({ conversationId: pending.conversationId }, pending.name, pending.relation);
      if (!result) return;
      const retry = pending.retry;
      setPending(null);
      retryingRef.current = true;
      try {
        await retry();
      } finally {
        retryingRef.current = false;
      }
    } finally {
      setBusy(false);
    }
  };

  const dialog = pending ? (
    <NeedsRelationDialog
      open
      onClose={() => !busy && setPending(null)}
      name={pending.name}
      relation={pending.relation}
      confirmLabel={pending.confirmLabel ?? DEFAULT_CONFIRM}
      onConfirm={() => void confirm()}
      busy={busy}
      canEdit={canEditContact}
    />
  ) : null;

  return { run, intercept, dialog };
}
