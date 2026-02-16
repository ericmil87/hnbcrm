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
    ├── layout/                # App shell and navigation
    │   ├── AuthLayout.tsx     # Auth-gated layout for /app/* (auth → org → onboarding → AppShell + Outlet)
    │   ├── AppShell.tsx       # Orchestrates Sidebar (md+) vs BottomTabBar (mobile)
    │   ├── Sidebar.tsx        # Desktop left nav — URL-based active state (useLocation)
    │   └── BottomTabBar.tsx   # Mobile bottom tabs — URL-based (exports Tab type)
    ├── LandingPage.tsx         # Public sales landing page at /
    ├── AuthPage.tsx            # Auth screen at /entrar with back link
├── pages/
│   └── DevelopersPage.tsx      # Public developer portal at /developers
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

