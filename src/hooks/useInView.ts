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
 *
 * Limite: só observa o elemento presente em `ref.current` na primeira execução
 * do efeito (e de novo apenas quando `once`/`root`/`rootMargin`/`threshold`
 * mudam). Prenda `ref` num elemento que monta junto com o componente e não é
 * trocado depois; se ele só aparecer mais tarde (render condicional) ou for
 * substituído, o novo elemento não é observado.
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
      (entries) => {
        // Um lote pode trazer várias mudanças (sai e volta entre dois quadros: giro de tela,
        // redimensionar). Vale a mais recente; ler só a primeira deixava a cena parada para sempre.
        const latest = entries[entries.length - 1];
        if (!latest) return;
        if (once) {
          if (entries.some((entry) => entry.isIntersecting)) {
            setIsInView(true);
            observer.disconnect();
          }
          return;
        }
        setIsInView(latest.isIntersecting);
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
