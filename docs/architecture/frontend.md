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

`vitest.config.mts` tem dois projetos: `backend-e-lib` (edge-runtime; `convex/**/*.test.ts` e `src/**/*.test.ts`) e `componentes` (jsdom + Testing Library; `src/**/*.test.tsx`, setup em `src/test/setup.ts`, `renderWithRouter` em `src/test/render.tsx`). Testes de componente cobrem primitivos e componentes de apresentação que recebem dados por props, sem mock de `useQuery`. As páginas públicas pesadas (`LandingPage`, `AuthPage`, `DevelopersPage`, `PlaygroundPage`) são `React.lazy` para o `apiRegistry` não entrar no bundle inicial; `RouteErrorPage` (eager, de propósito) é o `errorElement` e `NotFoundPage` o 404. Datas, tempo relativo, dinheiro e contagens saem de `src/lib/format.ts` (pt-BR fixo, `now` por argumento). Controles de formulário (`Switch`, `Select`, `SegmentedControl`, `Tabs`, `FormField`, `Textarea`) vivem em `src/components/ui/` e substituem switches, abas e `<select>` artesanais (fv2-03); os primitivos de estrutura (`PageHeader`, `SectionCard`, `EmptyState`, `Stepper`, `SearchInput`, `Popover`, `Menu`, `Tooltip`) e a variante Tailwind `coarse` (alvos de 44 px em telas de toque) completam o kit (fv2-05).

### Glossário e guarda de vocabulário (Frontend v2, fv2-07)

`src/lib/vocab.ts` guarda o glossário da interface (`VOCAB`: Conversas, Requer atenção, Funil, Etapa, Atendente IA, Sugerir respostas / Responder sozinha, Histórico de alterações, Relatórios, Agenda...) e `BANNED_UI_TERMS` (Repasse, Pipeline, Board, Autopilot, bridge, gateway, Cloud API, Tag, Email, Opt-out, Persona, Setor...). Só rótulos mudam; rotas, ids de `?secao=`/`Tab`, enums e nomes de função continuam os do código. `src/lib/uiStrings.ts` (puro) extrai apenas texto visível (texto JSX, atributos `title|label|placeholder|aria-label|description`, propriedades de mesmo nome e `toast.*`), sem comentários, `className` nem partes dinâmicas de template. `src/lib/vocabGuard.test.ts` (`@vitest-environment node`, lê `src/**` do disco) falha com `arquivo:linha — "texto" → use "X"`, com allowlist por caminho (Developers, Playground, Termos/Privacidade, `settings/advanced/`, `embed/`, landing), exceções pontuais com `reason` (teto 30) e `PENDING_SCOPE` para telas ainda não migradas (`TODO(fv2-29)`). O segundo teste do arquivo cobra sentence case nos `<Button>` e nos `label:` de navegação do `SENTENCE_CASE_SCOPE`. `src/lib/timezones.ts` traz os fusos com nomes em português (o `value` IANA persistido não muda). O extrator lê texto JSX, atributos/propriedades de rótulo (`label|title|placeholder|description|name|desc|hint|subtitle|header`), `toast.*` e ramos de ternário com frase; strings em outros objetos ou argumentos de função não são vistas e devem ser revisadas à mão. Os textos de backend (Telegram, e-mails, sino) ainda usam os nomes antigos e mudam em um PR futuro.

### SEO

**SEO:** react-helmet-async for dynamic meta tags, Open Graph + Twitter Cards, JSON-LD structured data, sitemap.xml, robots.txt. Reusable `<SEO />` component in `src/components/SEO.tsx`.

