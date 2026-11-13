import { Suspense, lazy, useRef } from "react";
import type { ComponentProps } from "react";
import type { CopilotPanel as CopilotPanelType } from "./CopilotPanel";

const CopilotPanel = lazy(() => import("./CopilotPanel").then((m) => ({ default: m.CopilotPanel })));

/**
 * Copiloto fora do bundle inicial: o chunk só é baixado na primeira vez que a gaveta abre.
 * Depois de aberto, fica montado para não perder a conversa ao fechar.
 */
export function LazyCopilotPanel(props: ComponentProps<typeof CopilotPanelType>) {
  const wasOpened = useRef(false);
  if (props.open) wasOpened.current = true;
  if (!wasOpened.current) return null;
  return (
    <Suspense fallback={null}>
      <CopilotPanel {...props} />
    </Suspense>
  );
}
