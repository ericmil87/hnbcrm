import { useRef, useState } from "react";
import type { FutureAccept } from "@/lib/agendaFutureAccept";
import { FutureAcceptDialog } from "./FutureAcceptDialog";

/** `ask` devolve uma promessa resolvida pelo diálogo (aceitar = true); `dialog` precisa ser renderizado. */
export function useFutureAsk() {
  const [info, setInfo] = useState<FutureAccept | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const ask = (next: FutureAccept) =>
    new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setInfo(next);
    });
  const settle = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setInfo(null);
  };
  const dialog = <FutureAcceptDialog info={info} onAccept={() => settle(true)} onCancel={() => settle(false)} />;
  return { ask, dialog };
}
