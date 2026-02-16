import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import { Toaster } from "sonner";
import "./index.css";
import { LandingPage } from "./components/LandingPage";
import { AuthPage } from "./components/AuthPage";
import { AuthLayout } from "./components/layout/AuthLayout";
import { DashboardOverview } from "./components/DashboardOverview";
import { KanbanBoard } from "./components/KanbanBoard";
import { ContactsPage } from "./components/ContactsPage";
import { Inbox } from "./components/Inbox";
import { HandoffQueue } from "./components/HandoffQueue";
import { TeamPage } from "./components/TeamPage";
import { AuditLogs } from "./components/AuditLogs";
import { Settings } from "./components/Settings";
import { DevelopersPage } from "./pages/DevelopersPage";
import { PlaygroundPage } from "./pages/PlaygroundPage";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

const router = createBrowserRouter([
  { path: "/", element: <LandingPage /> },
  { path: "/developers", element: <DevelopersPage /> },
  { path: "/developers/playground", element: <PlaygroundPage /> },
  { path: "/entrar", element: <AuthPage /> },
  {
    path: "/app",
    element: <AuthLayout />,
    children: [
      { index: true, element: <Navigate to="painel" replace /> },
      { path: "painel", element: <DashboardOverview /> },
      { path: "pipeline", element: <KanbanBoard /> },
      { path: "contatos", element: <ContactsPage /> },
      { path: "entrada", element: <Inbox /> },
      { path: "repasses", element: <HandoffQueue /> },
      { path: "equipe", element: <TeamPage /> },
      { path: "auditoria", element: <AuditLogs /> },
      { path: "configuracoes", element: <Settings /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <ConvexAuthProvider client={convex}>
    <RouterProvider router={router} />
    <Toaster theme="dark" />
  </ConvexAuthProvider>,
);
