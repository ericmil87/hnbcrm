import { useEffect } from "react";
import { Outlet } from "react-router";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import { writeSessionHint } from "@/lib/sessionHint";

/**
 * Convex on demand. Loaded by main.tsx (route `lazy`) only for the routes that talk to the backend
 * (`/entrar`, `/f/:slug`, `/app/*`, and `/comecar` when it exists): the public marketing pages never
 * download `convex-vendor` nor open the WebSocket.
 *
 * The client is a module singleton: created once, the first time this chunk loads, and reused when
 * the visitor goes back and forth between public and Convex routes (the provider remounts, the
 * client, its connection and the auth tokens in localStorage stay).
 */
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

/**
 * Mantém a marca local "há sessão neste navegador" (`lib/sessionHint.ts`) igual ao estado do Convex
 * Auth, para a landing (sem Convex) mostrar "Abrir o meu CRM" a quem está logado.
 */
function SessionHintSync() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  useEffect(() => {
    if (!isLoading) writeSessionHint(isAuthenticated);
  }, [isAuthenticated, isLoading]);
  return null;
}

export function ConvexRoot() {
  return (
    <ConvexAuthProvider client={convex}>
      <SessionHintSync />
      <Outlet />
    </ConvexAuthProvider>
  );
}
