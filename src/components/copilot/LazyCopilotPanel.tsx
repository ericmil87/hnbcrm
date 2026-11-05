import { Suspense, lazy, useRef } from "react";
import type { ComponentProps } from "react";
import { Spinner } from "@/components/ui/Spinner";
import type { CopilotPanel as CopilotPanelType } from "./CopilotPanel";

const CopilotPanel = lazy(() => import("./CopilotPanel").then((m) => ({ default: m.CopilotPanel })));

/**
 * Copiloto fora do bundle inicial: o chunk só é baixado na primeira vez que a gaveta abre
 * (ou na hora, na variante embutida do assistente de configuração). Depois de aberto, fica
 * montado para não perder a conversa ao fechar.
 */
export function LazyCopilotPanel(props: ComponentProps<typeof CopilotPanelType>) {
  const wasOpened = useRef(false);
  if (props.variant === "embedded" || props.open) wasOpened.current = true;
  if (!wasOpened.current) return null;
  return (
    <Suspense
      fallback={
        props.variant === "embedded" ? (
          <div className="flex h-full items-center justify-center p-6">
            <Spinner size="lg" />
          </div>
        ) : null
      }
    >
      <CopilotPanel {...props} />
    </Suspense>
  );
}
