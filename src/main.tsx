import { createRoot, hydrateRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router";
import { HelmetProvider } from 'react-helmet-async';
import "./index.css";
import { ROUTES } from "./appRoutes";
import { ThemedToaster } from "./components/ui/ThemedToaster";
import { installPreloadErrorHandler } from "./lib/pwa/preloadError";

// Entry = router + public shells only (routes in appRoutes.tsx). Convex and the app shell load on demand.
installPreloadErrorHandler();

const router = createBrowserRouter(ROUTES);

const container = document.getElementById("root")!;
const app = (
  <HelmetProvider>
    <RouterProvider router={router} />
  </HelmetProvider>
);

// Toasts live in their own root: sonner always renders a <section>, which the build-time render of
// the prerendered pages does not have (it would break hydration). sonner's store is global, so
// toast() works from any tree.
const toasterContainer = document.createElement("div");
document.body.appendChild(toasterContainer);
createRoot(toasterContainer).render(<ThemedToaster />);

if (container.firstElementChild) {
  // Prerendered public page (scripts/prerenderPlugin.ts): hydrate the static HTML, keeping its DOM
  // nodes (replacing them with createRoot made the hero <h1> a new, later LCP candidate: 1.7 s ->
  // 5.0 s on throttled 4G). Hydration starts once the route module is loaded, so the first client
  // render is the same page; until then the static HTML stays on screen. Values that differ per
  // visitor (media queries, reduced motion) use a `false` server snapshot and update right after;
  // an unexpected mismatch still recovers (React re-renders the root on the client).
  const start = () => hydrateRoot(container, app);
  if (router.state.initialized) {
    start();
  } else {
    const unsubscribe = router.subscribe((state) => {
      if (!state.initialized) return;
      unsubscribe();
      start();
    });
  }
} else {
  // Empty #root (SPA fallback): render now, so the route's hydrateFallbackElement shows the spinner.
  createRoot(container).render(app);
}
