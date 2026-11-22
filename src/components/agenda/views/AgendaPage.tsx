import { lazy, Suspense } from "react";
import { Spinner } from "@/components/ui/Spinner";

const AgendaPageView = lazy(() => import("./AgendaPageView").then((m) => ({ default: m.AgendaPageView })));

/**
 * Página da Agenda com o módulo `scheduling` LIGADO (ver `../AgendaEntry.tsx`). É só o CASCO: o corpo
 * (`AgendaPageView`, com a grade, a lista, o mês e as filas) fica noutro chunk. Assim o `AgendaEntry`, que
 * decide entre a página de hoje e esta, carrega no mapa de pré-carregamento só os poucos módulos deste casco,
 * e não cresce para quem tem o módulo desligado. Mantenha o export `AgendaPage` (o lazy de `AgendaEntry` o importa).
 */
export function AgendaPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen supports-[height:100dvh]:h-[100dvh] items-center justify-center">
          <Spinner size="lg" />
        </div>
      }
    >
      <AgendaPageView />
    </Suspense>
  );
}
