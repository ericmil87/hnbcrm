import { useCallback, useSyncExternalStore } from "react";

function mediaQuery(query: string): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query) : null;
}

/** Server/hydration snapshot: the prerendered public pages are rendered at build time without a viewport. */
const serverSnapshot = () => false;

/**
 * Acompanha uma media query (ex.: `"(max-width: 767px)"`). Durante a hidratação de uma página
 * pré-renderizada devolve `false` (o mesmo valor do render de build) e passa ao valor real logo em
 * seguida; em render só no cliente lê o valor real desde o início.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = mediaQuery(query);
      if (!mql) return () => {};
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => mediaQuery(query)?.matches ?? false, [query]);
  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}
