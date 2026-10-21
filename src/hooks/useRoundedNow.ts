import { useEffect, useState } from "react";
import { DEFAULT_ROUNDED_NOW_STEP_MS, msUntilNextBoundary, roundNow } from "@/lib/roundedNow";

/**
 * `Date.now()` arredondado para baixo em `stepMs` (default 15 min), atualizado
 * UMA vez por fronteira com um único `setTimeout` re-agendado — para usar em
 * args de `useQuery` sem criar uma assinatura nova por minuto. Componentes com o
 * mesmo passo chegam ao mesmo valor (o cliente do Convex deduplica a assinatura).
 * Para relógio ou "há X min" na tela, use um `now` local separado.
 */
export function useRoundedNow(stepMs: number = DEFAULT_ROUNDED_NOW_STEP_MS): number {
  const [now, setNow] = useState(() => roundNow(Date.now(), stepMs));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const current = Date.now();
      setNow(roundNow(current, stepMs)); // igual ao anterior = React não re-renderiza
      // +50 ms de folga: o timer pode disparar um tico antes da fronteira.
      timer = setTimeout(tick, msUntilNextBoundary(current, stepMs) + 50);
    };
    tick();
    return () => clearTimeout(timer);
  }, [stepMs]);

  return now;
}
