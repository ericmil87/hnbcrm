import { lazy, Suspense } from "react";
import { useOutletContext } from "react-router";
import type { AppOutletContext } from "@/components/layout/AuthLayout";
import { CalendarPage } from "@/components/calendar/CalendarPage";
import { Spinner } from "@/components/ui/Spinner";
import { useOrgModules } from "@/hooks/useOrgModules";
import { isSchedulingOn } from "@/lib/agendaAccess";

const AgendaPage = lazy(() => import("./views/AgendaPage").then((m) => ({ default: m.AgendaPage })));

/** Mesmo fallback de página do app (`LazyRoute` em `appRoutes.tsx`). */
function PageSpinner() {
  return (
    <div className="flex h-screen supports-[height:100dvh]:h-[100dvh] items-center justify-center">
      <Spinner size="lg" />
    </div>
  );
}

/**
 * Elemento da rota `/app/calendario`. Enquanto os módulos carregam: spinner de página (nunca a página antiga
 * para depois trocar). Módulo `scheduling` desligado = a página de compromissos de sempre, sem código novo no
 * caminho. Ligado = `views/AgendaPage` (carregado sob demanda).
 */
export function AgendaEntry() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { modules, isLoading } = useOrgModules(organizationId);
  if (isLoading) return <PageSpinner />;
  if (!isSchedulingOn(modules)) return <CalendarPage />;
  return (
    <Suspense fallback={<PageSpinner />}>
      <AgendaPage />
    </Suspense>
  );
}
