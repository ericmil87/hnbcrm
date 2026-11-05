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

### Sistema de temas (fase 1) (Frontend v2, fv2-08)

Os tokens de cor viram canais RGB (`--rgb-surface-base: 15 15 17`) em `src/index.css`, e o `tailwind.config.js` os consome com `rgb(var(--rgb-x) / <alpha-value>)` (helpers `c()` e `scale()`), então o alfa (`/NN`) passa a funcionar em surface, border e text; antes era um no-op silencioso e as 42 classes assim foram removidas para o Escuro continuar idêntico. Aliases de cor completa (`--surface-*`, `--border-*`, `--text-*`, `--color-semantic-*`) preservam CSS cru e `style={{}}`; `--color-semantic-*` corrige as métricas de `FormSubmissionsPage`, que usavam variáveis inexistentes. Entram os tokens de chat (`chat-*`, `composer*`, `bubble-*`, `tick-read`, `badge-unread*`), a escala `ai-300..700` (= purple atual), sombras e brilho do skeleton por variável, e `.chat-wallpaper`. O tema vive no `<html>` porque um alias é resolvido no elemento onde foi declarado. Esta fase não expõe seletor nem paleta clara nova (o bloco `.light` segue temporariamente). `src/lib/themeTokens.test.ts` congela o Escuro e lista em `DARK_KNOWN_FAILURES` os pares AA que ele já falha (ex.: `text-muted` sobre `surface-base` 3,96:1, branco sobre `brand-600` 3,56:1); `src/lib/contrast.ts` é a função de contraste.

### SEO

**SEO:** react-helmet-async for dynamic meta tags, Open Graph + Twitter Cards, JSON-LD structured data, sitemap.xml, robots.txt. Reusable `<SEO />` component in `src/components/SEO.tsx`.

### Configurações em dois níveis e registro (Frontend v2, fv2-13)

`/app/configuracoes` tem 6 grupos (Conta, WhatsApp e canais, Atendente IA, Equipe, Dados, Avançado) e, dentro deles, painéis. O painel é `?secao=<id>` (a URL é o estado; clicar escreve o parâmetro com push, e o grupo é derivado do painel); ids legados (`general`, `ai`, `apikeys`, `fields`, `sources`, `webhooks`, `channels`, `data`, `notifications`, `central`) continuam válidos porque o backend os usa em links de e-mail, Telegram e retorno OAuth da Meta (`?secao=channels&meta=…&pendente=…`, lido pelo `ChannelsSection`, que remove só `meta`/`pendente`). `src/components/settings/registry.ts` declara `SETTINGS_GROUPS` e `SETTINGS_PANELS` (rótulo, descrição, ícone, palavras-chave, permissão, `visible`, `Component` lazy ou `href`); a lógica pura fica em `lib/settingsNav.ts` (`resolveSettingsPanel`: id desconhecido → null, painel oculto cai no primeiro visível do grupo) e `lib/settingsSearch.ts` (busca sem acento por rótulo, palavras-chave e descrição). No celular, sem `secao`, aparece uma lista estilo ajustes com busca; no desktop, coluna lateral e o painel `general`. `appearance` está reservado (`visible: () => false`) até a seção de temas; os painéis do Atendente IA (`ai-*`) e `instagram` aparecem em `PLANNED_PANEL_IDS` e entram nos PRs fv2-17/19/21. Painel novo = uma entrada no registro.

### Modelo de navegação (Frontend v2, fv2-09)

`src/lib/nav.ts` é a única lista de itens do menu (`NAV_ITEMS`, 14 itens em 4 grupos: Atendimento, Organização, Divulgação, Gestão; o Painel fica solto no topo). Cada item declara rótulo (de `VOCAB`), ícone, grupo, permissão, módulo, fonte do badge e `mobile: "primary" | "more"`. `visibleNavItems(can, modules)` e `splitMobile(items)` (até 4 na barra inferior) são puras e testadas; o tipo `Tab` e `TAB_ROUTES`/`activeTabForPath` ficam em `src/lib/routes.ts` (prefixo mais longo, mais `matchPrefixes` do item). `Sidebar` e `BottomTabBar` são só renderizadores (`SidebarView`/`BottomTabBarView` puros, mais um wrapper com hooks). As contagens vêm de `useNavBadges`, que pula a query de um item oculto (`badgeQueriesFor`). No celular o cabeçalho do `AppShell` mostra o título da página, e `usePageTitle` define `document.title` como "{título} · HNBCRM". Adicionar um item é uma linha em `NAV_ITEMS` mais a rota em `TAB_ROUTES`.
