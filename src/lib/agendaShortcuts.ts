/**
 * Agenda v2 (densa): quando o atalho de teclado da página (T, D, S, M, L, setas) NÃO deve agir. Quem digita, quem está
 * num controle que usa as setas (seletor de visão, abas, listas, menus, diálogos) ou uma camada aberta tem prioridade.
 */

const OWN_KEYS = '[role="dialog"],[role="menu"],[role="radiogroup"],[role="listbox"],[role="tablist"]';

export function isTypingTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n || !n.tagName) return false;
  return n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName) || n.closest(OWN_KEYS) !== null;
}

/** `true` = a página ignora a tecla. `layerOpen`: painel, folha, modal ou diálogo da Agenda aberto. */
export function shortcutBlocked(e: Pick<KeyboardEvent, "defaultPrevented" | "ctrlKey" | "metaKey" | "altKey" | "target">, layerOpen: boolean): boolean {
  return e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || layerOpen || isTypingTarget(e.target);
}
