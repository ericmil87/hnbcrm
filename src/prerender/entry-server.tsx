/**
 * Build-time render of the public pages (scripts/prerenderPlugin.ts builds this file with Vite SSR
 * and calls `renderPage` for each path of PRERENDER_PATHS). No Convex, no browser globals at render.
 *
 * main.tsx hydrates this markup, so the DOM must be what the client's first render produces. That is
 * why the build renders the SAME route table (src/appRoutes.tsx) through react-router's static data
 * router: createStaticHandler(ROUTES) resolves the page's `lazy` exactly like createBrowserRouter
 * does, and StaticRouterProvider (hydrate={false}) builds the same tree as RouterProvider (same error
 * boundaries, same nesting), so `useId` values match (e.g. the BrandLogo SVG mask). The Toaster is
 * not here: it has its own root on the client. See docs/architecture/frontend.md, "Prerender".
 */
import { prerenderToNodeStream } from "react-dom/static";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { HelmetProvider, type HelmetServerState } from "react-helmet-async";
import { ROUTES } from "@/appRoutes";
import type { PrerenderPath } from "@/lib/prerender/routes";

const SITE_URL = import.meta.env.VITE_SITE_URL || "https://hnbcrm.com";

export interface RenderedPage {
  head: string;
  body: string;
}

async function streamToString(stream: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Renders one public page; waits for every Suspense boundary (e.g. the lazy community QR). */
export async function renderPage(path: PrerenderPath): Promise<RenderedPage> {
  const handler = createStaticHandler(ROUTES);
  const context = await handler.query(new Request(new URL(path, SITE_URL)));
  if (context instanceof Response) throw new Error(`prerender ${path}: redirect/response ${context.status}`);
  if (context.errors) throw new Error(`prerender ${path}: ${JSON.stringify(context.errors)}`);
  const router = createStaticRouter(handler.dataRoutes, context);

  const helmetContext: { helmet?: HelmetServerState } = {};
  const errors: unknown[] = [];
  const { prelude } = await prerenderToNodeStream(
    <HelmetProvider context={helmetContext}>
      <StaticRouterProvider router={router} context={context} hydrate={false} />
    </HelmetProvider>,
    { onError: (error) => void errors.push(error) },
  );
  const body = await streamToString(prelude);
  if (errors.length > 0) throw new Error(`prerender ${path}: ${String(errors[0])}`);
  const helmet = helmetContext.helmet;
  if (!helmet) throw new Error(`prerender ${path}: Helmet não coletou o head`);
  const head = [helmet.title, helmet.meta, helmet.link, helmet.script]
    .map((part) => part.toString())
    .filter(Boolean)
    .join("\n    ");
  return { head, body };
}
