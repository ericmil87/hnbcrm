import { useEffect, useRef, useState } from "react";

export interface UseInViewOptions extends IntersectionObserverInit {
  /**
   * `true` (padrão): vira `true` na primeira vez que o elemento aparece e para
   * de observar (entradas de seção). `false`: acompanha entrar e sair da tela
   * (cenas em loop pausam quando saem da tela).
   */
  once?: boolean;
}

/**
 * Observa se o elemento de `ref` está visível. Sem `IntersectionObserver`
 * (ambiente antigo, prerender, testes) considera visível, para nada ficar
 * escondido nem parado à espera de um evento que não vem.
 */
export function useInView<T extends Element = HTMLDivElement>(options: UseInViewOptions = {}) {
  const { once = true, root, rootMargin, threshold } = options;
  const [isInView, setIsInView] = useState(false);
  const ref = useRef<T>(null);
  const thresholdKey = Array.isArray(threshold) ? threshold.join(",") : threshold;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setIsInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) {
          setIsInView(true);
          if (once) observer.disconnect();
        } else if (!once) {
          setIsInView(false);
        }
      },
      { root, rootMargin, threshold }
    );
    observer.observe(el);
    return () => observer.disconnect();
    // `threshold` entra pela chave estável (um array novo a cada render não recria o observer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [once, root, rootMargin, thresholdKey]);

  return { ref, isInView };
}
