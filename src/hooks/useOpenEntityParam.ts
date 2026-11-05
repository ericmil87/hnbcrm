import { useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { useSearchParamState } from "@/hooks/useSearchParamState";
import { stringParam } from "@/lib/searchParamState";

/**
 * Item aberto guardado num parâmetro da URL (ex.: `?log=`, `?member=`).
 *
 * - Abrir com a tela sem item = push, com a entrada marcada em `location.state`
 *   como nossa; trocar de item = replace (preserva a marca), para o "voltar"
 *   cair na lista e não em itens intermediários.
 * - Fechar: se a entrada atual é nossa, `navigate(-1)` (sem deixar entrada
 *   morta); senão (deep link, recarga) replace.
 * - Nunca rola a janela para o topo: o item abre no meio da lista.
 *
 * O estado é lido "na hora" por `liveRef`, porque `close` pode rodar depois de
 * um `await` com a closure de um render velho.
 */
export function useOpenEntityParam(key: string) {
  const param = useSearchParamState(key, stringParam, { history: "push", preventScrollReset: true });
  const navigate = useNavigate();
  const location = useLocation();
  const ownsEntry = (location.state as { openedParam?: string } | null)?.openedParam === key;

  const liveRef = useRef({ ownsEntry, raw: param.raw, key: location.key });
  liveRef.current = { ownsEntry, raw: param.raw, key: location.key };
  /** `navigate(-1)` já pedido a partir desta entrada: um segundo fechar não pode voltar 2. */
  const backPendingKey = useRef<string | null>(null);

  const { set, expectWrite } = param;

  const open = useCallback(
    (id: string) => {
      const live = liveRef.current;
      if (live.raw === id) return;
      const push = live.raw === null;
      set(id, {
        history: push ? "push" : "replace",
        ...(push || live.ownsEntry ? { state: { openedParam: key } } : {}),
      });
    },
    [set, key]
  );

  const close = useCallback(() => {
    const live = liveRef.current;
    if (live.raw === null) return;
    if (live.ownsEntry) {
      if (backPendingKey.current === live.key) return;
      backPendingKey.current = live.key;
      expectWrite(null);
      navigate(-1);
    } else {
      set(null, { history: "replace" });
    }
  }, [set, expectWrite, navigate]);

  return { id: param.value, open, close };
}
