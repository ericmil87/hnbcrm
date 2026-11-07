/**
 * Contribuição de uma página ao cabeçalho do AppShell no celular: botões de
 * ícone (ex.: "Nova conversa") e itens do menu ⋯. Puro: a assinatura decide
 * quando o AppShell precisa redesenhar (os `onSelect` mudam a cada render da
 * página e não entram nela; o AppShell chama sempre a versão mais recente).
 */
export interface PageHeaderEntryShape {
  id: string;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
}

export interface PageHeaderShape {
  actions?: readonly PageHeaderEntryShape[];
  menuItems?: readonly PageHeaderEntryShape[];
}

/** "" = nada a mostrar (página sem contribuição). */
export function pageHeaderSignature(contribution: PageHeaderShape | null | undefined): string {
  const actions = contribution?.actions ?? [];
  const menuItems = contribution?.menuItems ?? [];
  if (actions.length === 0 && menuItems.length === 0) return "";
  const pick = (e: PageHeaderEntryShape) => [e.id, e.label, !!e.disabled, !!e.danger, !!e.separatorBefore];
  return JSON.stringify([actions.map(pick), menuItems.map(pick)]);
}

/**
 * Itens do ⋯ do cabeçalho: os globais (ex.: "Copiloto", do AppShell) primeiro
 * e os da página depois, com separador entre os dois grupos.
 */
export function mergeHeaderMenuItems<T extends PageHeaderEntryShape>(global: readonly T[], page: readonly T[]): T[] {
  if (global.length === 0) return [...page];
  if (page.length === 0) return [...global];
  return [...global, { ...page[0], separatorBefore: true }, ...page.slice(1)];
}
