import { createRoot } from "react-dom/client";
import { lazy, Suspense } from "react";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { Toaster } from "sonner";
import { HelmetProvider } from 'react-helmet-async';
import "./index.css";
import { LandingPage } from "./components/LandingPage";
import { AuthPage } from "./components/AuthPage";
import { AuthLayout } from "./components/layout/AuthLayout";
import { DevelopersPage } from "./pages/DevelopersPage";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { Spinner } from "./components/ui/Spinner";

const PublicFormPage = lazy(() => import("./pages/PublicFormPage").then(m => ({ default: m.PublicFormPage })));

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
const Settings = lazy(() => import("./components/Settings").then(m => ({ default: m.Settings })));
const FormListPage = lazy(() => import("./components/forms/FormListPage").then(m => ({ default: m.FormListPage })));
const FormBuilderPage = lazy(() => import("./components/forms/FormBuilderPage").then(m => ({ default: m.FormBuilderPage })));

// Wrapper component for Suspense boundaries
function LazyRoute({ Component }: { Component: React.LazyExoticComponent<() => JSX.Element> }) {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center"><Spinner size="lg" /></div>}>
      <Component />
    </Suspense>
  );
}

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

const router = createBrowserRouter([
  { path: "/", element: <LandingPage /> },
  { path: "/developers", element: <DevelopersPage /> },
  { path: "/developers/playground", element: <PlaygroundPage /> },
  { path: "/entrar", element: <AuthPage /> },
  { path: "/f/:formSlug", element: <LazyRoute Component={PublicFormPage} /> },
  {
    path: "/app",
    element: <AuthLayout />,
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
      { path: "configuracoes", element: <LazyRoute Component={Settings} /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <HelmetProvider>
    <ConvexAuthProvider client={convex}>
      <RouterProvider router={router} />
      <Toaster theme="dark" />
    </ConvexAuthProvider>
  </HelmetProvider>,
);
