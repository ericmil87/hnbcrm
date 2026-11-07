/**
 * Preferência "Botão flutuante do Copiloto" — por aparelho (localStorage), desligada
 * por padrão: o Copiloto abre pelo ⋯ do celular, pela barra lateral e por Ctrl/Cmd+K.
 */
export const COPILOT_FAB_ENABLED_KEY = "hnbcrm.copilotFab.enabled";

/** Só "1" liga; ausente, vazio ou qualquer outro valor = desligado. */
export function parseCopilotFabEnabled(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim() === "1";
}

export function readCopilotFabEnabled(): boolean {
  try {
    return parseCopilotFabEnabled(localStorage.getItem(COPILOT_FAB_ENABLED_KEY));
  } catch {
    return sessionValue ?? false;
  }
}

/** Valor da sessão: vale quando o localStorage falha (modo privado), para o Switch ainda alternar. */
let sessionValue: boolean | null = null;

const listeners = new Set<() => void>();

export function writeCopilotFabEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(COPILOT_FAB_ENABLED_KEY, "1");
    else localStorage.removeItem(COPILOT_FAB_ENABLED_KEY);
  } catch {
    // Armazenamento indisponível: a escolha vale só nesta sessão (sessionValue).
    sessionValue = enabled;
  }
  listeners.forEach((l) => l());
}

/** Para `useSyncExternalStore`: avisa mudanças feitas aqui e em outras abas. */
export function subscribeCopilotFabEnabled(onChange: () => void): () => void {
  listeners.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === COPILOT_FAB_ENABLED_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}
