---
paths:
  - "src/**"
---

# Frontend rules (React + Tailwind, PT-BR, mobile-first)

## Language and copy
- All user-facing text is Portuguese (BR). Code, comments and identifiers stay as the surrounding file does.
- Icons come from `lucide-react`, imported individually. Never use emoji as icons. Icon-only buttons need `aria-label`.
- Numbers, money and counters get `tabular-nums`.

## Design tokens (use the token, never a raw hex)
- Defined in `src/index.css` (CSS variables, `:root` = dark, `.light` overrides) and `tailwind.config.js`.
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
- `Button`: variants `primary` (CTA), `secondary`, `ghost` (tertiary/links), `dark`, `danger` (destructive); sizes `sm` 32px, `md` 40px, `lg` 48px (use `lg` for mobile CTAs).
- `Input`, `Checkbox`: bordered style with label/error/icon. Inputs are `text-base md:text-sm` (16px minimum on mobile or iOS zooms).
- `Badge`: `default | brand | success | error | warning | info`. `Card`: `default | sunken | interactive`.
- `Modal`: bottom sheet on mobile, centered dialog on sm+. It renders in a portal on `body`; do not wrap it in your own z-index hacks.
- `SlideOver`: full screen on mobile, 480px side panel on md+. For stacked panels render the child as a DOM sibling AFTER the parent (both `z-50`, DOM order decides).
- `ConfirmDialog` (`danger | default`) for any destructive confirmation. `EmptyState`, `Skeleton`/`Spinner` for loading, `Pagination`, `CollapsibleSection`, `FileDropZone`, `Avatar` (human vs `ai`), `Markdown` (never raw HTML).
- Loading: `Spinner` for whole-view waits, `Skeleton` for async content. Fallbacks in `Suspense` must be static (no Convex queries).

## Mobile-first
- Write base styles for mobile, then `md:`/`lg:`. Breakpoints: xs 375, sm 640, md 768, lg 1024, xl 1280. Verify at 375, 768, 1024.
- Touch targets at least 44x44px. Bottom-anchored UI (sheets, FABs, composers) uses `pb-safe` or `env(safe-area-inset-*)`.
- Window scrolls naturally; do not add nested scroll containers for page content. Kanban on mobile scrolls horizontally with snap.
- Respect `prefers-reduced-motion`. Focus ring: `focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base`.

## Data, org and permissions
- Page components get the org with `useOutletContext<AppOutletContext>()` (type from `AuthLayout.tsx`). Every query takes `organizationId`.
- Conditional queries: `useQuery(api.x.y, ready ? { organizationId } : "skip")`.
- Permissions: `usePermissions(organizationId)` (`src/hooks/usePermissions.ts`) and `<PermissionGate>` (`src/components/guards/PermissionGate.tsx`). Hide or disable UI by permission, but the server is the real gate.
- Optional org modules (`units`, `departments`, `attribution`, `central`) are read with `useOrgModules`; module off means the UI is identical to before.
- Mutations: `useMutation` plus `sonner` toasts (`toast.promise`). Convex user errors are `ConvexError` with PT-BR text; show it.

## Routing and deep links
- Route constants live in `src/lib/routes.ts` (`TAB_ROUTES`, `PATH_TO_TAB`); navigate with `useNavigate`, derive active state from `useLocation`.
- Authenticated routes are lazy (`React.lazy`) under `AuthLayout`. Public pages call `<SEO />` (`src/components/SEO.tsx`).
- The URL is the source of truth for open entities. Params: `?task=`, `?lead=`, `?conversation=`, `?handoff=`, `?nova=`, `?board=`, `?secao=`. Open/close and selection must write the param (so browser back works); selecting something else clears stale params in the same write. Org switch clears entity params (`src/lib/orgSwitch.ts`).

## Anti-patterns (each causes real bugs)
- No `Date.now()`, `new Set()`/`new Map()`/`[]`/`{}` in `useQuery` args or passed directly to `useState`; use `useState(() => ...)`.
- No setState in the render body; use effects or handlers.
- No Convex queries inside a Suspense fallback.
- No raw hex colors when a token exists; no emoji icons; no English UI strings.

## Where logic goes
- Non-trivial pure logic goes in `src/lib/*.ts` with a sibling `*.test.ts` (vitest includes `src/**/*.test.ts`); components stay thin. Examples: `src/lib/contactName.ts`, `src/lib/fabPosition.ts`.
- Rules shared with the backend are imported from `convex/lib/*` (single source), never copied.
- New components: named export, `PascalCase.tsx`, `interface XProps`, placed in the feature folder (`inbox/`, `tasks/`, `settings/`...) or `ui/` if generic.
- Build chunks (`vite.config.ts` `manualChunks`): `react-vendor`, `convex-vendor`, `utils-vendor`, `icons-vendor`, `xlsx-vendor` (xlsx only via dynamic `import()`). Keep heavy libs lazy; new origins (fonts, CDN, iframe) also need the CSP in `vercel.json`.

Full reference: `STYLE_GUIDE.md`, `src/CLAUDE.md`, `docs/architecture/frontend.md`
