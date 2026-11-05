import { useEffect } from "react";

export const APP_NAME = "HNBCRM";

/** Título da aba do navegador para uma página. */
export function pageDocumentTitle(title: string): string {
  // Sem título de página, a aba mostra só o nome do app (sem "HNBCRM · HNBCRM").
  if (!title || title === APP_NAME) return APP_NAME;
  return `${title} · ${APP_NAME}`;
}

/** Define `document.title = "{título} · HNBCRM"` e restaura o anterior ao desmontar. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    const previous = document.title;
    document.title = pageDocumentTitle(title);
    return () => {
      document.title = previous;
    };
  }, [title]);
}
