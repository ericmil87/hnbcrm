import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from "react";
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

// Vitrine do kit de cena: só em DEV (no build de produção o ramo vira `null` e o chunk não é gerado).
const DevKitPage = import.meta.env.DEV
  ? lazy(() => import("./pages/DevKitPage").then(m => ({ default: m.DevKitPage })))
  : null;

type PageModule = { default: ComponentType };

/**
 * Pages of the /app shell: React.lazy + LazyRoute, so tab navigation inside the app still shows the
 * Suspense spinner at once (route `lazy` would keep the old page frozen until the chunk arrives).
 * The non-blocking route `lazy` only STARTS the download when the route matches, in parallel with
 * ConvexRoot and AuthLayout, instead of after they render (same module, so React.lazy reuses it).
 * A failed warm-up is ignored here: the real import inside React.lazy reports it to the error boundary.
 */
function appPage(load: () => Promise<PageModule>): Pick<RouteObject, "element" | "lazy"> {
  const Component = lazy(load);
  return {
    element: <LazyRoute Component={Component} />,
    lazy: async () => {
      void load().catch(() => undefined);
      return {};
    },
  };
}

function FullScreenSpinner() {
  return (
    <div className="flex h-screen supports-[height:100dvh]:h-[100dvh] items-center justify-center"><Spinner size="lg" /></div>
  );
}

// Wrapper component for Suspense boundaries
function LazyRoute({ Component }: { Component: LazyExoticComponent<ComponentType> }) {
  return (
    <Suspense fallback={<FullScreenSpinner />}>
      <Component />
    </Suspense>
  );
}

export const ROUTES: RouteObject[] = [
  // Public, no Convex. "/", "/precos", "/funcionalidades", "/manifesto", "/developers", "/termos", "/privacidade" are also prerendered.
  { path: "/", ...publicPage(() => import("./components/LandingPage").then(m => m.LandingPage)), errorElement: <RouteErrorPage /> },
  { path: "/precos", ...publicPage(() => import("./pages/PricingPage").then(m => m.PricingPage)), errorElement: <RouteErrorPage /> },
  { path: "/funcionalidades", ...publicPage(() => import("./pages/FeaturesPage").then(m => m.FeaturesPage)), errorElement: <RouteErrorPage /> },
  { path: "/manifesto", ...publicPage(() => import("./pages/ManifestoPage").then(m => m.ManifestoPage)), errorElement: <RouteErrorPage /> },
  { path: "/developers", ...publicPage(() => import("./pages/DevelopersPage").then(m => m.DevelopersPage)), errorElement: <RouteErrorPage /> },
  { path: "/developers/playground", ...publicPage(() => import("./pages/PlaygroundPage").then(m => m.PlaygroundPage)), errorElement: <RouteErrorPage /> },
  { path: "/termos", ...publicPage(() => import("./pages/TermsPage").then(m => m.TermsPage)), errorElement: <RouteErrorPage /> },
  { path: "/privacidade", ...publicPage(() => import("./pages/PrivacyPage").then(m => m.PrivacyPage)), errorElement: <RouteErrorPage /> },
  ...(DevKitPage ? [{ path: "/dev/kit", element: <LazyRoute Component={DevKitPage} />, errorElement: <RouteErrorPage /> }] : []),
  // Convex on demand: everything below shares one lazily created client (ConvexRoot). Any new route
  // that uses Convex goes in these children (routes.test.ts checks /entrar, /comecar and /app are here).
  {
    lazy: async () => ({ Component: (await import("./components/layout/ConvexRoot")).ConvexRoot }),
    errorElement: <RouteErrorPage />,
    hydrateFallbackElement: <FullScreenSpinner />,
    children: [
      // Route `lazy` (not React.lazy): the router resolves it together with ConvexRoot, so the page and
      // convex-vendor download in parallel. /f/* does not use convex/react today (it fetches the HTTP
      // API) but stays here on purpose (one place for everything that may talk to the backend).
      { path: "/entrar", ...publicPage(() => import("./components/AuthPage").then(m => m.AuthPage)), errorElement: <RouteErrorPage /> },
      // Conversa do onboarding v2: pública na URL, exige conta para conversar (usa Convex).
      { path: "/comecar", ...publicPage(() => import("./components/onboarding-chat/OnboardingChatPage").then(m => m.OnboardingChatPage)), errorElement: <RouteErrorPage /> },
      { path: "/f/:formSlug", ...publicPage(() => import("./pages/PublicFormPage").then(m => m.PublicFormPage)), errorElement: <RouteErrorPage /> },
      {
        path: "/app",
        lazy: async () => ({ Component: (await import("./components/layout/AuthLayout")).AuthLayout }),
        errorElement: <RouteErrorPage />,
        hydrateFallbackElement: <FullScreenSpinner />,
        children: [
          { index: true, element: <Navigate to="painel" replace /> },
          { path: "abrir", ...appPage(() => import("./components/layout/OpenLinkPage").then(m => ({ default: m.OpenLinkPage }))) },
          { path: "painel", ...appPage(() => import("./components/DashboardOverview").then(m => ({ default: m.DashboardOverview }))) },
          { path: "pipeline", ...appPage(() => import("./components/KanbanBoard").then(m => ({ default: m.KanbanBoard }))) },
          { path: "contatos", ...appPage(() => import("./components/ContactsPage").then(m => ({ default: m.ContactsPage }))) },
          { path: "entrada", ...appPage(() => import("./components/Inbox").then(m => ({ default: m.Inbox }))) },
          { path: "tarefas", ...appPage(() => import("./components/TasksPage").then(m => ({ default: m.TasksPage }))) },
          { path: "calendario", ...appPage(() => import("./components/calendar/CalendarPage").then(m => ({ default: m.CalendarPage }))) },
          { path: "repasses", ...appPage(() => import("./components/HandoffQueue").then(m => ({ default: m.HandoffQueue }))) },
          { path: "equipe", ...appPage(() => import("./components/TeamPage").then(m => ({ default: m.TeamPage }))) },
          { path: "auditoria", ...appPage(() => import("./components/AuditLogs").then(m => ({ default: m.AuditLogs }))) },
          { path: "formularios", ...appPage(() => import("./components/forms/FormListPage").then(m => ({ default: m.FormListPage }))) },
          { path: "formularios/:formId", ...appPage(() => import("./components/forms/FormBuilderPage").then(m => ({ default: m.FormBuilderPage }))) },
          { path: "formularios/:formId/submissoes", ...appPage(() => import("./components/forms/FormSubmissionsPage").then(m => ({ default: m.FormSubmissionsPage }))) },
          { path: "formularios/:formId/analytics", ...appPage(() => import("./components/forms/FormAnalyticsPage").then(m => ({ default: m.FormAnalyticsPage }))) },
          { path: "formularios/:formId/experimento/:experimentId", ...appPage(() => import("./components/forms/FormExperimentPage").then(m => ({ default: m.FormExperimentPage }))) },
          { path: "campanhas", ...appPage(() => import("./components/CampaignsPage").then(m => ({ default: m.CampaignsPage }))) },
          { path: "grupos", ...appPage(() => import("./components/groups/GroupsPage").then(m => ({ default: m.GroupsPage }))) },
          { path: "central", ...appPage(() => import("./components/central/CentralPage").then(m => ({ default: m.CentralPage }))) },
          { path: "configuracao-inicial", ...appPage(() => import("./components/onboarding/v2/OnboardingWizardV2").then(m => ({ default: m.OnboardingWizardV2 }))) },
          { path: "configuracoes", ...appPage(() => import("./components/Settings").then(m => ({ default: m.Settings }))) },
          // Literal on purpose (= TAB_ROUTES.dashboard, checked in lib/prerender/routes.test.ts): lib/routes
          // pulls nav.ts (VOCAB + every nav icon) into the entry chunk.
          { path: "*", element: <Navigate to="/app/painel" replace /> },
        ],
      },
    ],
  },
  { path: "*", ...publicPage(() => import("./pages/NotFoundPage").then(m => m.NotFoundPage)), errorElement: <RouteErrorPage /> },
];
