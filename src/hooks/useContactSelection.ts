import { useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import { stringParam } from "@/lib/searchParamState";

/** Marca a entrada de histórico criada por um push nosso ao abrir um contato. */
const OWN_ENTRY = { contactPushed: true };

/**
 * Contato aberto em `?contact=` na página Contatos. Abrir empilha uma entrada
 * (o "voltar" fecha) e marca-a em `location.state`; fechar volta uma entrada se
 * a entrada é nossa, senão faz `replace`. `close` lê o estado VIVO (ref):
 * chamado depois de um `await` (excluir), com a closure de um render velho,
 * não pode fazer `navigate(-1)` se a pessoa já voltou pelo navegador.
 */
export function useContactSelection() {
  const navigate = useNavigate();
  const location = useLocation();
  const contactParam = useSearchParamState("contact", stringParam, { history: "push" });

  const ownsEntry = (location.state as { contactPushed?: boolean } | null)?.contactPushed === true;
  const live = useRef({ ownsEntry, raw: contactParam.raw, key: location.key });
  live.current = { ownsEntry, raw: contactParam.raw, key: location.key };
  // `navigate(-1)` já pedido a partir desta entrada: um segundo fechar não pode voltar 2.
  const backPendingKey = useRef<string | null>(null);

  /** Abre (ou troca) o contato; limpa a aba do anterior na mesma escrita. */
  const open = useCallback(
    (contactId: string) => {
      const push = live.current.raw === null;
      contactParam.set(contactId, {
        also: { contactTab: null },
        history: push ? "push" : "replace",
        ...(push || live.current.ownsEntry ? { state: OWN_ENTRY } : {}),
      });
    },
    [contactParam]
  );

  const close = useCallback(() => {
    const current = live.current;
    if (current.raw === null) return;
    if (current.ownsEntry) {
      if (backPendingKey.current === current.key) return;
      backPendingKey.current = current.key;
      contactParam.expectWrite(null);
      navigate(-1);
    } else {
      contactParam.set(null, { history: "replace", also: { contactTab: null } });
    }
  }, [contactParam, navigate]);

  /** `?contact=` inválido (id que não existe): some com o param sem criar entrada. */
  const clearInvalid = useCallback(() => {
    if (live.current.raw === null) return;
    contactParam.set(null, { history: "replace", also: { contactTab: null } });
  }, [contactParam]);

  return { contactId: contactParam.value, open, close, clearInvalid };
}
