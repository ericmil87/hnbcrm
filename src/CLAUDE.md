# CLAUDE.md — Frontend (React + TailwindCSS)

## Structure

```
src/
├── main.tsx                    # Entry: ConvexAuthProvider + RouterProvider (react-router v7)
├── App.tsx                     # (legacy, unused — superseded by router + AuthLayout)
├── SignInForm.tsx              # Password + Anonymous sign-in (PT-BR)
├── SignOutButton.tsx           # Sign-out button
├── index.css                  # CSS custom properties (dark/light), auth classes, shimmer
├── lib/
│   ├── utils.ts               # cn() utility (clsx + tailwind-merge)
│   └── routes.ts              # TAB_ROUTES / PATH_TO_TAB route mapping constants
└── components/
    ├── ui/                    # Reusable UI primitives
    │   ├── Button.tsx         # Pill button (primary, secondary, ghost, dark, danger)
    │   ├── Input.tsx          # Bordered input with label, error, icon
    │   ├── Badge.tsx          # Semantic pill badge (default, brand, success, error, warning, info)
    │   ├── Card.tsx           # Surface card (default, sunken, interactive)
    │   ├── Modal.tsx          # Bottom sheet (mobile) / centered dialog (desktop)
    │   ├── SlideOver.tsx      # Full-screen (mobile) / side panel (desktop)
    │   ├── Spinner.tsx        # Brand-colored loading spinner
    │   ├── Skeleton.tsx       # Shimmer loading placeholder
    │   ├── Avatar.tsx         # Initials avatar with AI badge + status dot
    │   ├── ConfirmDialog.tsx  # Reusable confirmation modal (danger/default variants)
    │   └── ApiKeyRevealModal.tsx # API key reveal with copy + security warning
    ├── notifications/
    │   └── NotificationPreferences.tsx  # Email notification preferences (Settings tab)
    ├── SEO.tsx                # Dynamic meta tags (react-helmet-async) — NEW
    ├── StructuredData.tsx     # JSON-LD structured data for rich results — NEW
    ├── layout/                # App shell and navigation
    │   ├── AuthLayout.tsx     # Auth-gated layout for /app/* (auth → org → onboarding → ScrollRestoration → AppShell + Outlet)
    │   ├── AppShell.tsx       # Orchestrates Sidebar (md+) vs BottomTabBar (mobile) — NOW USES WINDOW SCROLL
    │   ├── Sidebar.tsx        # Desktop left nav — URL-based active state (useLocation)
    │   └── BottomTabBar.tsx   # Mobile bottom tabs — URL-based (exports Tab type)
    ├── LandingPage.tsx         # Public sales landing page at /
    ├── AuthPage.tsx            # Auth screen at /entrar with back link
    ├── Dashboard.tsx           # (legacy, unused — superseded by Outlet routing)
    ├── DashboardOverview.tsx   # Metrics overview (route: /app/painel)
    ├── KanbanBoard.tsx         # Pipeline board with drag-and-drop (route: /app/pipeline)
    ├── LeadDetailPanel.tsx     # SlideOver for lead details
    ├── CreateLeadModal.tsx     # Modal for creating new leads
    ├── Inbox.tsx               # Conversation inbox (route: /app/entrada)
    ├── HandoffQueue.tsx        # AI-to-human handoff management (route: /app/repasses)
    ├── TeamPage.tsx            # Team member management (route: /app/equipe)
    ├── Settings.tsx            # Organization settings (route: /app/configuracoes)
    ├── AuditLogs.tsx           # Audit log viewer (route: /app/auditoria)
    ├── ContactsPage.tsx        # Contacts management (route: /app/contatos)
    ├── calendar/               # Calendar views (day/week/month, event CRUD, DnD)
    │   ├── CalendarPage.tsx    # Main page: view state, DnD context, data queries
    │   ├── CalendarHeader.tsx  # View toggle (Dia/Semana/Mes), date nav, filters
    │   ├── MonthView.tsx       # 7-column month grid with event dots
    │   ├── WeekView.tsx        # 7-column time grid with event blocks
    │   ├── DayView.tsx         # Single column time grid + date strip
    │   ├── TimeGrid.tsx        # Shared 06:00-22:00 grid, current time indicator
    │   ├── EventBlock.tsx      # Draggable event block (useDraggable)
    │   ├── EventDot.tsx        # Small colored dot for month view
    │   ├── DayCell.tsx         # Day cell in month view (useDroppable)
    │   ├── CalendarEventModal.tsx    # Create/edit event form
    │   ├── EventDetailSlideOver.tsx  # Event detail slide-over panel
    │   ├── CalendarFilters.tsx       # Filter popover (team member, type)
    │   ├── useCalendarState.ts       # Custom hook for calendar state
    │   └── constants.ts              # Color mappings, labels, PT-BR names
    ├── forms/                  # Form builder & renderer
    │   ├── FormListPage.tsx   # Form management list (route: /app/formularios)
    │   ├── FormBuilderPage.tsx # WYSIWYG form builder (route: /app/formularios/:id)
    │   ├── builder/           # Builder components
    │   │   ├── types.ts       # Shared types for form builder
    │   │   ├── FieldPalette.tsx    # Drag-to-add field type palette
    │   │   ├── FieldCard.tsx       # Draggable field card in canvas
    │   │   ├── FieldCanvas.tsx     # Drop zone for form fields
    │   │   ├── FieldConfigPanel.tsx # Field property editor
    │   │   ├── CrmMappingSelect.tsx # CRM entity/field mapping selector
    │   │   ├── FormSettingsPanel.tsx # Lead creation & assignment settings
    │   │   ├── ThemePanel.tsx      # Visual theme customization
    │   │   └── PublishDialog.tsx   # Publish confirmation with embed codes
    │   └── renderer/          # Public form renderer
    │       ├── FormRenderer.tsx    # Renders form from field definitions
    │       ├── FormField.tsx       # Individual field renderer
    │       └── FormSuccess.tsx     # Post-submit success screen
├── pages/
│   ├── DevelopersPage.tsx      # Public developer portal at /developers
│   └── PublicFormPage.tsx      # Public form page at /f/:slug (no auth)
    ├── ErrorBoundary.tsx       # Error boundary wrapper
    └── OrganizationSelector.tsx # Org switcher dropdown
```

## Patterns

**Data fetching:** Always use `useQuery(api.module.functionName, args)` from `convex/react`. Pass `"skip"` instead of args when dependencies aren't ready:
```tsx
const leads = useQuery(
  api.leads.list,
  selectedOrgId ? { organizationId: selectedOrgId } : "skip"
);
```

**Mutations:** Use `useMutation(api.module.functionName)` and call the returned function. Wrap with toast notifications from `sonner`:
```tsx
const createLead = useMutation(api.leads.create);
toast.promise(createLead({ ... }), { loading: "Criando...", success: "Criado!", error: "Falha" });
```

**Loading states:** Use the `Spinner` component:
```tsx
if (data === undefined) return <Spinner size="lg" />;
```

**Auth gates:** `AuthLayout` (`src/components/layout/AuthLayout.tsx`) wraps all `/app/*` routes. Uses `useConvexAuth()` to check auth status — unauthenticated users are redirected to `/entrar`. The layout also gates on org selection, onboarding wizard, and team member loading before rendering `<Outlet />`.

**Organization scoping:** `AuthLayout` passes `organizationId` via `<Outlet context={{ organizationId }}>`. Page components access it with `useOutletContext<AppOutletContext>()` (type exported from `AuthLayout.tsx`). Every query includes it.

**Navigation:** URL-based via react-router v7. `src/lib/routes.ts` defines `TAB_ROUTES` (Tab → path) and `PATH_TO_TAB` (path → Tab). `Sidebar` and `BottomTabBar` derive active state from `useLocation()` and navigate via `useNavigate()`. The `Tab` type is exported from `BottomTabBar.tsx`.

**SEO per route:** Use the `<SEO />` component from `@/components/SEO` in each public page:
```tsx
import { SEO } from '@/components/SEO';

export function MyPublicPage() {
  return (
    <>
      <SEO
        title="Page Title"
        description="Page description for search engines and social cards"
        keywords="keyword1, keyword2, keyword3"
        ogImage="/path-to-image.png"
      />
      {/* page content */}
    </>
  );
}
```

**Lazy loading routes:** Use React.lazy() for authenticated routes to reduce initial bundle:
```tsx
import { lazy, Suspense } from "react";
import { Spinner } from "@/components/ui/Spinner";

const DashboardOverview = lazy(() => import("./components/DashboardOverview").then(m => ({ default: m.DashboardOverview })));

function LazyRoute({ Component }: { Component: React.LazyExoticComponent<() => JSX.Element> }) {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center"><Spinner size="lg" /></div>}>
      <Component />
    </Suspense>
  );
}

// In router:
{ path: "painel", element: <LazyRoute Component={DashboardOverview} /> }
```

**Scroll restoration:** React Router v7's `<ScrollRestoration />` is configured in `AuthLayout.tsx`. Window scrolls naturally (no nested scroll containers). Scroll position automatically saved/restored on navigation and page reloads.

## React Anti-Patterns

- **NEVER** call `Date.now()` or functions that return new values in useQuery args → use `useState(() => Date.now())` instead (prevents infinite loops)
- **NEVER** pass `new Set()` / `new Map()` / `[]` / `{}` directly to useState → use initializer function: `useState(() => new Set())`
- **NEVER** call setState in render body → use useEffect or event handlers only
- **NEVER** call Convex queries in Suspense fallback components → Fallbacks should only render static UI (e.g., `<Spinner />`)

## Styling

- **Dark theme default** — CSS custom properties in `index.css` (`:root` = dark, `.light` = override)
- **Mobile-first** — base styles target mobile, responsive via `md:`, `lg:` breakpoints
- **Color tokens:** `bg-surface-base`, `bg-surface-raised`, `text-text-primary`, `text-text-secondary`, `border-border`, `bg-brand-600`
- **Components:** Use `cn()` from `@/lib/utils` for conditional classes. All UI primitives in `src/components/ui/`
- **Icons:** `lucide-react` (tree-shakeable SVGs) — never use emoji icons
- **Buttons:** Pill shape (`rounded-full`), primary = `bg-brand-600 text-white`
- **Cards:** `rounded-card border border-border bg-surface-raised`

## UI Language

All user-facing text is in **Portuguese (BR)**. Navigation: Painel, Pipeline, Caixa de Entrada, Repasses, Equipe, Auditoria, Configurações.

