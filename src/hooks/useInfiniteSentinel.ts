import { useCallback, useEffect, useRef, type RefObject } from "react";
import { decideSentinel, INITIAL_SENTINEL_STATE } from "@/lib/infiniteScroll";

/**
 * Sentinela de scroll infinito: devolve um callback ref para um elemento
 * vazio no fim (ou no topo) da lista; quando ele ENTRA na área visível do
 * container rolável, chama `onReach` — uma vez por entrada, nunca durante
 * `loading` e nunca na 1ª observação (regras em `lib/infiniteScroll.ts`).
 *
 * `root` deve ser o container que rola: só com ele o `rootMargin` antecipa o
 * disparo. `resetKey` (ex.: conversa aberta) zera a linha de base ao trocar.
 */
export function useInfiniteSentinel({
  enabled,
  loading,
  onReach,
  root,
  rootMargin = "200px",
  resetKey,
}: {
  enabled: boolean;
  loading: boolean;
  onReach: () => void;
  root?: RefObject<HTMLElement | null>;
  rootMargin?: string;
  resetKey?: string | null;
}) {
  // Lidos no callback do observer sem recriá-lo a cada render.
  const gateRef = useRef({ enabled, loading });
  gateRef.current = { enabled, loading };
  const onReachRef = useRef(onReach);
  onReachRef.current = onReach;

  const stateRef = useRef(INITIAL_SENTINEL_STATE);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const nodeRef = useRef<HTMLElement | null>(null);
  const observedRootRef = useRef<Element | null>(null);

  const attach = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      nodeRef.current = node;
      stateRef.current = INITIAL_SENTINEL_STATE;
      if (!node || typeof IntersectionObserver === "undefined") return;
      observedRootRef.current = root?.current ?? null;
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const r = decideSentinel(stateRef.current, entry.isIntersecting, gateRef.current);
            stateRef.current = r.state;
            if (r.fire) onReachRef.current();
          }
        },
        { root: observedRootRef.current, rootMargin }
      );
      observer.observe(node);
      observerRef.current = observer;
    },
    [root, rootMargin]
  );

  // Trocar de contexto (conversa/filtro) recomeça da linha de base: a próxima
  // observação não dispara mesmo que o sentinela esteja visível.
  const lastKeyRef = useRef(resetKey);
  useEffect(() => {
    if (lastKeyRef.current === resetKey) return;
    lastKeyRef.current = resetKey;
    if (nodeRef.current) attach(nodeRef.current);
  }, [resetKey, attach]);

  // O ref do container é preenchido DEPOIS do callback ref do sentinela quando
  // os dois montam no mesmo commit (React liga refs de filho antes do pai):
  // nesse caso o observer nasceu com a viewport como root — refaz com o certo.
  useEffect(() => {
    const current = root?.current ?? null;
    if (nodeRef.current && observerRef.current && observedRootRef.current !== current) {
      attach(nodeRef.current);
    }
  });

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return attach;
}
