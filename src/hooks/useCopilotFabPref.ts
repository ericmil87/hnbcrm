import { useSyncExternalStore } from "react";
import { readCopilotFabEnabled, subscribeCopilotFabEnabled } from "@/lib/copilotFabPref";

/** Botão flutuante do Copiloto ligado neste aparelho? Atualiza ao vivo (AppShell e Aparência). */
export function useCopilotFabPref(): boolean {
  return useSyncExternalStore(subscribeCopilotFabEnabled, readCopilotFabEnabled, () => false);
}
