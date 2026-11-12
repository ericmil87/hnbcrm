import { Outlet } from "react-router";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";

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

export function ConvexRoot() {
  return (
    <ConvexAuthProvider client={convex}>
      <Outlet />
    </ConvexAuthProvider>
  );
}
