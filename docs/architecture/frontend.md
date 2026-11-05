# Frontend — arquitetura, build e SEO

> Histórico técnico movido **verbatim** do `CLAUDE.md` da raiz em 22/10/2026 (snapshot do commit 1f51a2f). Ordem = ordem de versão. Pegadinhas que mudam a forma de codar foram destiladas em `.claude/rules/`; este arquivo é a fonte completa, para ler quando se mexe nesta área.

## Estado atual

SPA react-router v7, chunking/lazy loading, SEO. Regras de UI estão em `STYLE_GUIDE.md` e `src/CLAUDE.md`; a regra por caminho em `.claude/rules/frontend.md`.

## Decisões, pegadinhas medidas e histórico

### Frontend

**Frontend:** SPA with react-router v7. Dark theme default, mobile-first, PT-BR UI. `src/main.tsx` → `HelmetProvider` → `ConvexAuthProvider` → `RouterProvider`. Public routes: `/` (LandingPage), `/entrar` (AuthPage). App routes: `/app/*` wrapped by `AuthLayout` → `ScrollRestoration` → `AppShell` → `<Outlet />`. Page components get `organizationId` via `useOutletContext`. Reusable UI in `src/components/ui/`, layout in `src/components/layout/`. State is Convex reactive queries + local `useState`. Path alias `@/` → `src/`.

### Build optimizations

**Build optimizations:** Vite configured with manual chunking (react-vendor, convex-vendor, utils-vendor, icons-vendor), lazy loading for authenticated routes via React.lazy(), gzip/brotli compression, and bundle visualization (rollup-plugin-visualizer). Initial bundle: ~157 KB brotli (77% reduction from 1 MB baseline).

### Testes de componente, páginas públicas e formatadores (Frontend v2, fv2-01)

`vitest.config.mts` tem dois projetos: `backend-e-lib` (edge-runtime; `convex/**/*.test.ts` e `src/**/*.test.ts`) e `componentes` (jsdom + Testing Library; `src/**/*.test.tsx`, setup em `src/test/setup.ts`, `renderWithRouter` em `src/test/render.tsx`). Testes de componente cobrem primitivos e componentes de apresentação que recebem dados por props, sem mock de `useQuery`. As páginas públicas pesadas (`LandingPage`, `AuthPage`, `DevelopersPage`, `PlaygroundPage`) são `React.lazy` para o `apiRegistry` não entrar no bundle inicial; `RouteErrorPage` (eager, de propósito) é o `errorElement` e `NotFoundPage` o 404. Datas, tempo relativo, dinheiro e contagens saem de `src/lib/format.ts` (pt-BR fixo, `now` por argumento). Controles de formulário (`Switch`, `Select`, `SegmentedControl`, `Tabs`, `FormField`, `Textarea`) vivem em `src/components/ui/` e substituem switches, abas e `<select>` artesanais (fv2-03).

### SEO

**SEO:** react-helmet-async for dynamic meta tags, Open Graph + Twitter Cards, JSON-LD structured data, sitemap.xml, robots.txt. Reusable `<SEO />` component in `src/components/SEO.tsx`.

