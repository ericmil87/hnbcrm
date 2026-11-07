/** Atalho global que abre o Copiloto no computador: Ctrl+K (Windows/Linux) ou Cmd+K (Mac). */
export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}

export function isCopilotShortcut(e: ShortcutKeyEvent): boolean {
  return e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
}

/** Abre só se for o atalho, nenhuma janela (Modal/SlideOver) estiver aberta e ninguém já tratou a tecla. */
export function shouldOpenCopilotFromKey(e: ShortcutKeyEvent, ctx: { modalOpen: boolean; enabled: boolean }): boolean {
  return ctx.enabled && !ctx.modalOpen && !e.repeat && !e.defaultPrevented && isCopilotShortcut(e);
}
