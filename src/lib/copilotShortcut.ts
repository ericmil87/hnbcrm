/** Atalho global que abre o Copiloto no computador: Cmd+K no Mac, Ctrl+K nos demais (Ctrl+K no Mac apaga até o fim da linha nos campos de texto). */
export interface ShortcutKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}

/** `platform` vem de `navigator.userAgentData?.platform ?? navigator.platform`. */
export function isMacPlatform(platform: string | undefined | null): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "");
}

/** Lido uma vez (AppShell/Sidebar); fora do navegador, não é Mac. */
export function detectIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return isMacPlatform(nav.userAgentData?.platform ?? nav.platform);
}

/** Valor de `aria-keyshortcuts` para o atalho da plataforma. */
export function copilotAriaShortcut(isMac: boolean): string {
  return isMac ? "Meta+K" : "Control+K";
}

export function isCopilotShortcut(e: ShortcutKeyEvent, isMac: boolean): boolean {
  const modifier = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return e.key.toLowerCase() === "k" && modifier && !e.altKey && !e.shiftKey;
}

/** Abre só se for o atalho, nenhuma janela (Modal/SlideOver) estiver aberta e ninguém já tratou a tecla. */
export function shouldOpenCopilotFromKey(
  e: ShortcutKeyEvent,
  ctx: { modalOpen: boolean; enabled: boolean; isMac: boolean }
): boolean {
  return ctx.enabled && !ctx.modalOpen && !e.repeat && !e.defaultPrevented && isCopilotShortcut(e, ctx.isMac);
}
