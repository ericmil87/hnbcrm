import { useEffect, useState } from "react";
import { roundNow, type NowUnit } from "@/lib/roundNow";

/**
 * Relógio arredondado para argumentos de query (`findSlots`: minuto; `listFor*`: hora). Só muda quando o
 * valor arredondado muda, então a assinatura não é refeita a cada render. `Date.now()` fica aqui, nunca nos args.
 */
export function useRoundedNow(unit: NowUnit, active = true): number {
  const [now, setNow] = useState(() => roundNow(Date.now(), unit));
  useEffect(() => {
    if (!active) return;
    setNow(roundNow(Date.now(), unit));
    const id = setInterval(() => setNow(roundNow(Date.now(), unit)), 30_000);
    return () => clearInterval(id);
  }, [unit, active]);
  return now;
}
