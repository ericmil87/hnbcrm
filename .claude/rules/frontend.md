---
paths:
  - "src/**"
---

# Frontend rules (React + Tailwind, PT-BR, mobile-first)

## Language and copy
- All user-facing text is Portuguese (BR). Code, comments and identifiers stay as the surrounding file does.
- Glossary lives in `src/lib/vocab.ts` (`VOCAB`, `BANNED_UI_TERMS`): one name per concept (Conversas, Requer atenção, Funil/Etapa, Atendente IA, Sugerir respostas/Responder sozinha, Etiqueta, Histórico de alterações, Relatórios, Agenda...). Menu labels, page titles and empty states import `VOCAB`; running text does not have to, `src/lib/vocabGuard.test.ts` protects it. Only labels change: routes, `?secao=` ids, `Tab` ids, enums and function names keep their code names.
- Sentence case everywhere (buttons, titles, tabs, selects); only proper nouns and acronyms stay capitalized (`PROPER_NOUNS` in `src/lib/uiStrings.ts`). "E-mail" with hyphen, "…" for loading, IA is feminine, second person.
- Toasts: success is a past participle without "com sucesso" or "!" ("Lead criado"); error is "Não foi possível {verbo}." and a `ConvexError` message from the server wins (`mutationErrorMessage`).
- Technical terms (Webhooks, Chaves de integração, Modelo de IA, Cloud API, bridge, gateway) only inside `settings/advanced/` and `/developers`. `vocabGuard.test.ts` fails with `file:line — "text" -> use "X"`; do not add to `src/lib/vocabGuard.allowlist.ts` without a reason (max 30 punctual entries, each with `reason`; `PENDING_SCOPE` is for files not yet migrated, with `TODO(fv2-29)`).
- Icons come from `lucide-react`, imported individually. Never use emoji as icons. Icon-only buttons need `aria-label`.
- Numbers, money and counters get `tabular-nums`.

## Design tokens (use the token, never a raw hex)
- Defined in `src/index.css` (CSS variables, `:root` = dark, `[data-theme="light"]` and `[data-theme="whatsapp"]` override every `--rgb-*` key) and `tailwind.config.js`.
- Color tokens are RGB channels (`--rgb-surface-base: 15 15 17`) and Tailwind uses `rgb(var(--rgb-x) / <alpha-value>)`, so opacity works on every token (`bg-surface-base/50`, `border-border/60`, `text-text-muted/70`). Never write a `bg-surface-*/NN` expecting it to be ignored.
- In raw CSS or `style={{}}` use the full-color aliases (`var(--surface-base)`, `var(--text-muted)`, `var(--border-default)`, `var(--color-semantic-error)`); never `var(--rgb-*)` outside `index.css` and `tailwind.config.js`.
- The theme attribute lives on `<html>` (aliases are resolved on the element where they are declared; a wrapper-level theme would leave them on the root palette).
- `useUiTheme` runs only in `AuthLayout`; public pages never receive `data-theme`. `public/theme-init.js` is the only script allowed in `public/` (CSP `script-src 'self'`, no inline scripts).
- Chat tokens exist and must be used in new conversation code: `bg-chat-bg|chat-header|chat-send`, `bg-composer`, `bg-composer-field`, `bg-bubble-in|out|ai|note|system`, `text-bubble-out-fg|out-label|ai-label|note-label|in-link|out-link|system-fg`, `border-bubble-note-border`, `text-tick-read`, `bg-badge-unread` + `text-badge-unread-fg`, `shadow-bubble`, and the `.chat-wallpaper` utility. `ai-*` (300..700) replaces `purple-*` (forbidden in `src`, except `developers/JsonHighlighter.tsx`). Use the `light-theme:` variant (light + whatsapp) only for inevitable light/dark pairs; prefer tokens. Choose by order: semantic token, then token with alpha, then `light-theme:` for fixed data colors. Theme thumbnails in `AppearancePicker` are the one exception: hex comes from `THEME_OPTIONS[].preview` as data in `style={{}}` (never `[#hex]` classes), so they do not follow the active theme. The theme is a per-user preference (no "Automático"); picker lives in the sidebar, the mobile "Mais" sheet and Settings › Conta › Aparência.
- `src/lib/rawColorsGuard.test.ts` is a per-file ratchet against raw Tailwind palette classes (`bg-red-500`, `text-sky-400`) and `[#hex]`: files outside its `ALLOWLIST` must have zero raw colors (a new file is born clean), listed files cannot exceed their ceiling, and ceilings only go down (never raise one to pass: migrate to a token or justify it). `purple-` is allowed only in `developers/JsonHighlighter.tsx`. Chat/bubble tokens are mandatory in conversation code (`getBubbleStyle` in `inbox/MessageBubble.tsx`, covered by `inbox/bubbleStyle.test.ts`); inside the outbound bubble use `bubble-out-fg[/N]` instead of `white` (never `/70` or `/60` on text, icons only). `light-theme:` only for unavoidable pairs of data colors.
- `shadow-card|card-hover|elevated|glow|bubble` point to CSS variables and do NOT combine with `shadow-<color>` (Tailwind cannot split the color out of the value).
- Contrast helper: `src/lib/contrast.ts`; `src/lib/themeTokens.test.ts` freezes the dark palette and lists the AA pairs dark already fails.
- Surfaces: `bg-surface-base` (page), `bg-surface-raised` (cards), `bg-surface-overlay` (modals, dropdowns), `bg-surface-sunken` (kanban columns, inset areas).
- Text: `text-text-primary`, `text-text-secondary`, `text-text-muted`.
- Borders: `border-border`, `border-border-subtle`, `border-border-strong`.
- Brand: `brand-50..900`. Primary action is `bg-brand-600` (AA with white text), not `brand-500`. Selected state: `border-brand-500 bg-brand-500/10`.
- Semantic: `semantic-success|error|warning|info` (`text-semantic-error`, `bg-semantic-error/10`). Warning is amber, distinct from brand orange.
- Radius: `rounded-card` (12px) for cards, `rounded-field` (8px) for inputs, `rounded-full` for buttons and badges.
- Shadows: `shadow-card`, `shadow-card-hover`, `shadow-elevated`. Animations: `animate-fade-in`, `fade-in-up`, `slide-in-right`, `slide-in-up`, `shimmer`.
- Typography (Inter, `font-sans`): body 14px, small 13px, caption 11-12px, H1 22px (md 28), H2 18px (md 22), H3 16px (md 18). Weights 400/500/600/700 only.
- Conditional classes via `cn()` from `@/lib/utils`.

## UI primitives (`src/components/ui/`): reuse, do not recreate
- `Button`: variants `primary` (CTA), `secondary`, `ghost` (tertiary/links), `dark`, `danger` (destructive); sizes `sm` 32px, `md` 40px, `lg` 48px (use `lg` for mobile CTAs); `sm`/`md` grow to 44px on touch (`coarse:min-h-11`). `loading` shows a spinner, sets `aria-busy` and disables. `iconOnly` is typed to require `aria-label`.
- `Input`, `Checkbox`: bordered style with label/error/icon. Inputs are `text-base md:text-sm` (16px minimum on mobile or iOS zooms).
- Form controls: `Switch` (`role="switch"`, `hideLabel` when the visible text is elsewhere), `Select` (native `<select>`, `options` or `groups`), `SegmentedControl` (`radiogroup`), `Tabs` + `TabPanel` (roving tabindex, arrows/Home/End, horizontal scroll on mobile), `FormField` (label/hint/error wiring), `Textarea` (`autoGrow`, `maxLength` counter). `useMediaQuery` (`src/hooks`) replaces manual `window.innerWidth` checks.
- Structure primitives: `PageHeader` (the single `<h1>`; `back`, `badge`, `actions`), `SectionCard` (`<section aria-labelledby>` + `<h2>`), `EmptyState` (`action.href` renders a `Link`, `secondaryAction`, `size`), `Stepper` (`aria-current="step"`, "Passo 2 de 5" on mobile), `SearchInput` (debounced, "Limpar busca"), `Popover` (portal, flip/clamp via `src/lib/popoverPosition.ts`, Esc/outside click, returns focus), `Menu` (`role="menu"`, arrows/Home/End; bottom sheet under 768px), `Tooltip` (wraps the child in an `inline-flex` span; pass `wrapperClassName` for block/full-width triggers; hover + focus; touch: long press 500 ms, or a single tap with `asInfo`/disabled trigger).
- `title=` only on truncated text, never on a control; icon-only controls need `aria-label`; hint text for controls goes in `Tooltip`. Use `coarse:` (pointer: coarse) for 44px targets; `text-caption` (12px) is the minimum readable size, `text-micro` (11px) only for badges/markers.
- No raw `<select>`, hand-made switch or ad-hoc tab buttons in new code; use the primitives above.
- `Badge`: `default | brand | success | error | warning | info`. `Card`: `default | sunken | interactive`.
- `Modal`: bottom sheet on mobile, centered dialog on sm+. It renders in a portal on `body`; do not wrap it in your own z-index hacks.
- `SlideOver`: full screen on mobile, 480px side panel on md+. For stacked panels render the child as a DOM sibling AFTER the parent (both `z-50`, DOM order decides).
- `ConfirmDialog` (`danger | default`) for any destructive confirmation. `EmptyState`, `Skeleton`/`Spinner` for loading, `Pagination`, `CollapsibleSection`, `FileDropZone`, `Avatar` (human vs `ai`), `Markdown` (never raw HTML).
- Loading: `Spinner` for whole-view waits, `Skeleton` for async content. Fallbacks in `Suspense` must be static (no Convex queries).

## Mobile-first
- Write base styles for mobile, then `md:`/`lg:`. Breakpoints: xs 375, sm 640, md 768, lg 1024, xl 1280. Verify at 375, 768, 1024.
- Touch targets at least 44x44px. Bottom-anchored UI (sheets, FABs, composers) uses `pb-safe` or `env(safe-area-inset-*)`.
- Viewport height: `dvh` always via `supports-[height:100dvh]:` after the `vh` class (e.g. `min-h-screen supports-[height:100dvh]:min-h-[100dvh]`); two plain utilities in a row make `vh` win.
- Window scrolls naturally; do not add nested scroll containers for page content. Kanban on mobile scrolls horizontally with snap.
- Respect `prefers-reduced-motion`. Focus ring (keyboard only): `focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base`; animate with `motion-safe:`.

## Data, org and permissions
- Page components get the org with `useOutletContext<AppOutletContext>()` (type from `AuthLayout.tsx`). Every query takes `organizationId`.
- Conditional queries: `useQuery(api.x.y, ready ? { organizationId } : "skip")`.
- Permissions: `usePermissions(organizationId)` (`src/hooks/usePermissions.ts`) and `<PermissionGate>` (`src/components/guards/PermissionGate.tsx`). Hide or disable UI by permission, but the server is the real gate.
- Optional org modules (`units`, `departments`, `attribution`, `central`) are read with `useOrgModules`; module off means the UI is identical to before.
- Mutations: `useMutation` plus `sonner` toasts (`toast.promise`). Convex user errors are `ConvexError` with PT-BR text; show it.

## Routing and deep links

- Navigation menu: `src/lib/nav.ts` (`NAV_ITEMS`) is the only list. A new menu item = one line in `NAV_ITEMS` (label from `VOCAB`, icon, group, permission, module, badge, `mobile: "primary" | "more"`) plus its `TAB_ROUTES` entry; never add a second list in `Sidebar`/`BottomTabBar`. The bar holds at most 4 primary items. Menu pages call `usePageTitle(...)`.
- Settings (`/app/configuracoes`): the panel is `?secao=<id>` (written with push on click; ids are stable because the backend and e-mails link to them; the group is derived). A new panel = one entry in `SETTINGS_PANELS` (`src/components/settings/registry.ts`: id, group, sentence-case label from `VOCAB`, description, icon, keywords for search, permission/visible, lazy `Component` or `href`); the shell, mobile list and search pick it up. Technical terms (API, webhook) only in `src/components/settings/advanced/`. Lists with a modal form use `useInlineCrud`.
- Connecting a WhatsApp number goes only through `ChannelConnectCard` (`src/components/settings/channels/`; the setup wizard reuses it with `variant="wizard"`): never rebuild the provider choice, the ban-risk acceptance or the pairing steps elsewhere. Pairing uses `startBridgePairing`/`pollBridgePairing` (code or QR); `getBridgeQrCode` is not used by the UI. Never build `webhookUrl` on the client (the server uses `CONVEX_SITE_URL`) and never log or persist a QR or linking code. Pure rules (default mode by viewport, `XXXX-XXXX` format, 150 s / 3 min windows) live in `src/lib/channelConnect.ts`.
- Route constants live in `src/lib/routes.ts` (`TAB_ROUTES`, `activeTabForPath`); navigate with `useNavigate`, derive active state from `useLocation`.
- Authenticated routes are lazy (`React.lazy`) under `AuthLayout`. Public pages call `<SEO />` (`src/components/SEO.tsx`).
- The URL is the source of truth for open entities. Params: `?task=`, `?lead=`, `?conversation=`, `?handoff=`, `?nova=`, `?board=`, `?secao=`, and the Agenda's `?view=`, `?date=`, `?event=`. Open/close and selection must write the param (so browser back works); selecting something else clears stale params in the same write. Org switch clears entity params (`src/lib/orgSwitch.ts`).

## Anti-patterns (each causes real bugs)
- No `Date.now()`, `new Set()`/`new Map()`/`[]`/`{}` in `useQuery` args or passed directly to `useState`; use `useState(() => ...)`.
- No setState in the render body; use effects or handlers.
- No Convex queries inside a Suspense fallback.
- No raw hex colors when a token exists; no emoji icons; no English UI strings.

## Where logic goes
- Component tests (`*.test.tsx`) run in the `componentes` vitest project (jsdom + Testing Library, `src/test/`); only presentational components fed by props, never mock `useQuery`. A test that reads from disk needs `// @vitest-environment node` (and a `.test.ts` name so it runs in `backend-e-lib`).
- Date/time/relative/money/count formatting always comes from `src/lib/format.ts`; never `toLocale*String` or a local `formatCurrency`/`timeAgo` in a component.
- Non-trivial pure logic goes in `src/lib/*.ts` with a sibling `*.test.ts` (vitest includes `src/**/*.test.ts`); components stay thin. Examples: `src/lib/contactName.ts`, `src/lib/fabPosition.ts`.
- Settings editors that save a partial patch (attendant: `settings/attendant/`): controlled fields (strings when empty means "keep server default") + a panel that saves a partial patch. Pure `fromProfile/toPatch/validate` per form live in `src/lib/attendantConfig.ts`; `toPatch` never writes persona/knowledge unless the texts were loaded (`loaded: true`), otherwise it would overwrite them with empty.
- Rules shared with the backend are imported from `convex/lib/*` (single source), never copied.
- New components: named export, `PascalCase.tsx`, `interface XProps`, placed in the feature folder (`inbox/`, `tasks/`, `settings/`...) or `ui/` if generic.
- Build chunks (`vite.config.ts` `manualChunks`): `react-vendor`, `convex-vendor`, `utils-vendor`, `icons-vendor`, `xlsx-vendor` (xlsx only via dynamic `import()`). Keep heavy libs lazy; new origins (fonts, CDN, iframe) also need the CSP in `vercel.json`.

Full reference: `STYLE_GUIDE.md`, `src/CLAUDE.md`, `docs/architecture/frontend.md`
