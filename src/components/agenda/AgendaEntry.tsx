import { lazy, Suspense } from "react";
import { useOutletContext } from "react-router";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { CalendarPage } from "@/components/calendar/CalendarPage";
import { Spinner } from "@/components/ui/Spinner";
import { useOrgModules } from "@/hooks/useOrgModules";
import { isSchedulingOn } from "@/lib/agendaAccess";

const AgendaPage = lazy(() => import("./views/AgendaPage").then((m) => ({ default: m.AgendaPage })));

/**
 * Elemento da rota `/app/calendario`. Módulo `scheduling` desligado (ou ainda carregando) = a página de
 * compromissos de sempre, sem nenhum código novo no caminho. Ligado = `views/AgendaPage` (carregado sob demanda).
 */
export function AgendaEntry() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { modules } = useOrgModules(organizationId);
  if (!isSchedulingOn(modules)) return <CalendarPage />;
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-16">
          <Spinner size="lg" />
        </div>
      }
    >
      <AgendaPage />
    </Suspense>
  );
}
