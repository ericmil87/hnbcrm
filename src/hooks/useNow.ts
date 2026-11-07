import { useEffect, useState } from "react";

/**
 * "Agora" que avança a cada `intervalMs` (padrão 1 min) enquanto `enabled`:
 * horas relativas ("14:30" → "Ontem") viram sozinhas, sem esperar outro render.
 */
export function useNow(enabled = true, intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}
