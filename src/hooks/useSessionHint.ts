import { useEffect, useState } from "react";
import { readSessionHint } from "@/lib/sessionHint";

/**
 * "Há sessão neste navegador?" para páginas públicas, SEM Convex. Começa `false`
 * (igual ao HTML pré-renderizado, então a hidratação não diverge) e lê a marca
 * local depois de montar.
 */
export function useSessionHint(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    setSignedIn(readSessionHint());
  }, []);
  return signedIn;
}
