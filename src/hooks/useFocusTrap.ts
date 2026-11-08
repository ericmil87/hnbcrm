import { useEffect } from "react";
import type { RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Foco preso em `ref` enquanto `active`: leva o foco para dentro ao abrir e faz
 * Tab/Shift+Tab girarem entre os controles do contêiner. (O Modal ganha o seu
 * no A2; este é o equivalente local para o painel do sino.)
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  /** Para onde o foco volta ao fechar quando nada tinha foco ao abrir (ex.: o sino no Safari). */
  returnTo?: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const previous =
      document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement
        : null;
    const focusables = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!root.contains(document.activeElement)) (focusables()[0] ?? root).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Ao fechar por qualquer caminho: se o foco ficou perdido (no body, ou
      // dentro do painel que some), devolve a quem abriu.
      const current = document.activeElement;
      if (!current || current === document.body || root.contains(current)) {
        const target = previous?.isConnected ? previous : (returnTo?.current ?? null);
        target?.focus();
      }
    };
  }, [ref, active, returnTo]);
}
