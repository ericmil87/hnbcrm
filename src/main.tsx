import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { HelmetProvider } from 'react-helmet-async';
import "./index.css";
import { AuthLayout } from "./components/layout/AuthLayout";
import { TAB_ROUTES } from "./lib/routes";
import { RouteErrorPage } from "./pages/RouteErrorPage";
import { Spinner } from "./components/ui/Spinner";
import { ThemedToaster } from "./components/ui/ThemedToaster";
import { installPreloadErrorHandler } from "./lib/pwa/preloadError";

// Páginas públicas pesadas (ex.: DevelopersPage puxa o apiRegistry) ficam fora do bundle inicial.
const LandingPage = lazy(() => import("./components/LandingPage").then(m => ({ default: m.LandingPage })));
const AuthPage = lazy(() => import("./components/AuthPage").then(m => ({ default: m.AuthPage })));
const DevelopersPage = lazy(() => import("./pages/DevelopersPage").then(m => ({ default: m.DevelopersPage })));
const PlaygroundPage = lazy(() => import("./pages/PlaygroundPage").then(m => ({ default: m.PlaygroundPage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then(m => ({ default: m.NotFoundPage })));

const PublicFormPage = lazy(() => import("./pages/PublicFormPage").then(m => ({ default: m.PublicFormPage })));
const TermsPage = lazy(() => import("./pages/TermsPage").then(m => ({ default: m.TermsPage })));
const PrivacyPage = lazy(() => import("./pages/PrivacyPage").then(m => ({ default: m.PrivacyPage })));

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

// Wrapper component for Suspense boundaries
function LazyRoute({ Component }: { Component: React.LazyExoticComponent<() => React.JSX.Element> }) {
  return (
    <Suspense fallback={<div className="flex h-screen supports-[height:100dvh]:h-[100dvh] items-center justify-center"><Spinner size="lg" /></div>}>
      <Component />
    </Suspense>
  );
}

installPreloadErrorHandler();

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

const router = createBrowserRouter([
  { path: "/", element: <LazyRoute Component={LandingPage} />, errorElement: <RouteErrorPage /> },
  { path: "/developers", element: <LazyRoute Component={DevelopersPage} />, errorElement: <RouteErrorPage /> },
  { path: "/developers/playground", element: <LazyRoute Component={PlaygroundPage} />, errorElement: <RouteErrorPage /> },
  { path: "/entrar", element: <LazyRoute Component={AuthPage} />, errorElement: <RouteErrorPage /> },
  { path: "/termos", element: <LazyRoute Component={TermsPage} />, errorElement: <RouteErrorPage /> },
  { path: "/privacidade", element: <LazyRoute Component={PrivacyPage} />, errorElement: <RouteErrorPage /> },
  { path: "/f/:formSlug", element: <LazyRoute Component={PublicFormPage} />, errorElement: <RouteErrorPage /> },
  {
    path: "/app",
    element: <AuthLayout />,
    errorElement: <RouteErrorPage />,
    children: [
      { index: true, element: <Navigate to="painel" replace /> },
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
      { path: "*", element: <Navigate to={TAB_ROUTES.dashboard} replace /> },
    ],
  },
  { path: "*", element: <LazyRoute Component={NotFoundPage} />, errorElement: <RouteErrorPage /> },
]);

createRoot(document.getElementById("root")!).render(
  <HelmetProvider>
    <ConvexAuthProvider client={convex}>
      <RouterProvider router={router} />
      <ThemedToaster />
    </ConvexAuthProvider>
  </HelmetProvider>,
);
