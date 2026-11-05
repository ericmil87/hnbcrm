import { useEffect } from "react";

export const APP_NAME = "HNBCRM";

/** Título da aba do navegador para uma página. */
export function pageDocumentTitle(title: string): string {
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
