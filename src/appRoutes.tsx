import { lazy, Suspense } from "react";
import { Navigate, type RouteObject } from "react-router";
import { RouteErrorPage } from "./pages/RouteErrorPage";
import { Spinner } from "./components/ui/Spinner";

/**
 * The route table, shared by the browser router (main.tsx) and the build-time prerender
 * (src/prerender/entry-server.tsx, createStaticHandler). One definition on purpose: hydration needs
 * the client's first render to build the same tree the build rendered (same error boundaries, same
 * lazy Component), otherwise `useId` values (e.g. the BrandLogo mask) differ between the two.
 * No side effects at module load.
 */

// Convex (client, ConvexAuthProvider, convex-vendor) and the app shell (AuthLayout) load on demand
// through route `lazy` (docs/architecture/frontend.md, "Performance").

// Public pages without data: route `lazy` (the router resolves the module before rendering, so a
// prerendered page hydrates with its module already loaded, and client navigation keeps the current
// page until the next one is ready). Prerendered paths: PRERENDER_PATHS (src/lib/prerender/routes.ts).
// hydrateFallbackElement only shows when the page boots from the empty SPA shell.
const publicPage = (load: () => Promise<React.ComponentType>): Pick<RouteObject, "lazy" | "hydrateFallbackElement"> => ({
  lazy: async () => ({ Component: await load() }),
  hydrateFallbackElement: <FullScreenSpinner />,
});

// Pages under ConvexRoot keep React.lazy + LazyRoute (Suspense with the full-screen Spinner).
const AuthPage = lazy(() => import("./components/AuthPage").then(m => ({ default: m.AuthPage })));
const PublicFormPage = lazy(() => import("./pages/PublicFormPage").then(m => ({ default: m.PublicFormPage })));
const OpenLinkPage = lazy(() => import("./components/layout/OpenLinkPage").then(m => ({ default: m.OpenLinkPage })));
// Vitrine do kit de cena: só em DEV (no build de produção o ramo vira `null` e o chunk não é gerado).
const DevKitPage = import.meta.env.DEV
  ? lazy(() => import("./pages/DevKitPage").then(m => ({ default: m.DevKitPage })))
  : null;

// Lazy load authenticated routes
const DashboardOverview = lazy(() => import("./components/DashboardOverview").then(m => ({ default: m.DashboardOverview })));
const KanbanBoard = lazy(() => import("./components/KanbanBoard").then(m => ({ default: m.KanbanBoard })));
const ContactsPage = lazy(() => import("./components/ContactsPage").then(m => ({ default: m.ContactsPage })));
const Inbox = lazy(() => import("./components/Inbox").then(m => ({ default: m.Inbox })));
const HandoffQueue = lazy(() => import("./components/HandoffQueue").then(m => ({ default: m.HandoffQueue })));
const TasksPage = lazy(() => import("./components/TasksPage").then(m => ({ default: m.TasksPage })));
const CalendarPage = lazy(() => import("./components/calendar/CalendarPage").then(m => ({ default: m.CalendarPage })));
const TeamPage = lazy(() => import("./components/TeamPage").then(m => ({ default: m.TeamPage })));
const AuditLogs = lazy(() => import("./components/AuditLogs").then(m => ({ default: m.AuditLogs })));
const OnboardingWizardV2 = lazy(() => import("./components/onboarding/v2/OnboardingWizardV2").then(m => ({ default: m.OnboardingWizardV2 })));
const Settings = lazy(() => import("./components/Settings").then(m => ({ default: m.Settings })));
const FormListPage = lazy(() => import("./components/forms/FormListPage").then(m => ({ default: m.FormListPage })));
const FormBuilderPage = lazy(() => import("./components/forms/FormBuilderPage").then(m => ({ default: m.FormBuilderPage })));
const FormSubmissionsPage = lazy(() => import("./components/forms/FormSubmissionsPage").then(m => ({ default: m.FormSubmissionsPage })));
const FormAnalyticsPage = lazy(() => import("./components/forms/FormAnalyticsPage").then(m => ({ default: m.FormAnalyticsPage })));
const CampaignsPage = lazy(() => import("./components/CampaignsPage").then(m => ({ default: m.CampaignsPage })));
const GroupsPage = lazy(() => import("./components/groups/GroupsPage").then(m => ({ default: m.GroupsPage })));
const CentralPage = lazy(() => import("./components/central/CentralPage").then(m => ({ default: m.CentralPage })));
const FormExperimentPage = lazy(() => import("./components/forms/FormExperimentPage").then(m => ({ default: m.FormExperimentPage })));

function FullScreenSpinner() {
  return (
    <div className="flex h-screen supports-[height:100dvh]:h-[100dvh] items-center justify-center"><Spinner size="lg" /></div>
  );
}

// Wrapper component for Suspense boundaries
function LazyRoute({ Component }: { Component: React.LazyExoticComponent<() => React.JSX.Element> }) {
  return (
    <Suspense fallback={<FullScreenSpinner />}>
      <Component />
    </Suspense>
  );
}

export const ROUTES: RouteObject[] = [
  // Public, no Convex. "/", "/precos", "/developers", "/termos", "/privacidade" are also prerendered.
  { path: "/", ...publicPage(() => import("./components/LandingPage").then(m => m.LandingPage)), errorElement: <RouteErrorPage /> },
  { path: "/precos", ...publicPage(() => import("./pages/PricingPage").then(m => m.PricingPage)), errorElement: <RouteErrorPage /> },
  { path: "/developers", ...publicPage(() => import("./pages/DevelopersPage").then(m => m.DevelopersPage)), errorElement: <RouteErrorPage /> },
  { path: "/developers/playground", ...publicPage(() => import("./pages/PlaygroundPage").then(m => m.PlaygroundPage)), errorElement: <RouteErrorPage /> },
  { path: "/termos", ...publicPage(() => import("./pages/TermsPage").then(m => m.TermsPage)), errorElement: <RouteErrorPage /> },
  { path: "/privacidade", ...publicPage(() => import("./pages/PrivacyPage").then(m => m.PrivacyPage)), errorElement: <RouteErrorPage /> },
  ...(DevKitPage ? [{ path: "/dev/kit", element: <LazyRoute Component={DevKitPage} />, errorElement: <RouteErrorPage /> }] : []),
  // Convex on demand: everything below shares one lazily created client (ConvexRoot).
  // The onboarding route (/comecar) belongs here too.
  {
    lazy: async () => ({ Component: (await import("./components/layout/ConvexRoot")).ConvexRoot }),
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullScreenSpinner />,
    children: [
      { path: "/entrar", element: <LazyRoute Component={AuthPage} />, errorElement: <RouteErrorPage /> },
      { path: "/f/:formSlug", element: <LazyRoute Component={PublicFormPage} />, errorElement: <RouteErrorPage /> },
      {
        path: "/app",
        lazy: async () => ({ Component: (await import("./components/layout/AuthLayout")).AuthLayout }),
        errorElement: <RouteErrorPage />,
        hydrateFallbackElement: <FullScreenSpinner />,
        children: [
          { index: true, element: <Navigate to="painel" replace /> },
          { path: "abrir", element: <LazyRoute Component={OpenLinkPage} /> },
          { path: "painel", element: <LazyRoute Component={DashboardOverview} /> },
          { path: "pipeline", element: <LazyRoute Component={KanbanBoard} /> },
          { path: "contatos", element: <LazyRoute Component={ContactsPage} /> },
          { path: "entrada", element: <LazyRoute Component={Inbox} /> },
          { path: "tarefas", element: <LazyRoute Component={TasksPage} /> },
          { path: "calendario", element: <LazyRoute Component={CalendarPage} /> },
          { path: "repasses", element: <LazyRoute Component={HandoffQueue} /> },
          { path: "equipe", element: <LazyRoute Component={TeamPage} /> },
          { path: "auditoria", element: <LazyRoute Component={AuditLogs} /> },
          { path: "formularios", element: <LazyRoute Component={FormListPage} /> },
          { path: "formularios/:formId", element: <LazyRoute Component={FormBuilderPage} /> },
          { path: "formularios/:formId/submissoes", element: <LazyRoute Component={FormSubmissionsPage} /> },
          { path: "formularios/:formId/analytics", element: <LazyRoute Component={FormAnalyticsPage} /> },
          { path: "formularios/:formId/experimento/:experimentId", element: <LazyRoute Component={FormExperimentPage} /> },
          { path: "campanhas", element: <LazyRoute Component={CampaignsPage} /> },
          { path: "grupos", element: <LazyRoute Component={GroupsPage} /> },
          { path: "central", element: <LazyRoute Component={CentralPage} /> },
          { path: "configuracao-inicial", element: <LazyRoute Component={OnboardingWizardV2} /> },
          { path: "configuracoes", element: <LazyRoute Component={Settings} /> },
          // Literal on purpose (= TAB_ROUTES.dashboard, checked in lib/prerender/routes.test.ts): lib/routes
          // pulls nav.ts (VOCAB + every nav icon) into the entry chunk.
          { path: "*", element: <Navigate to="/app/painel" replace /> },
        ],
      },
    ],
  },
  { path: "*", ...publicPage(() => import("./pages/NotFoundPage").then(m => m.NotFoundPage)), errorElement: <RouteErrorPage /> },
];
