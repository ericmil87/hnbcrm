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
├── hooks/
│   └── useCopilotStream.ts    # SSE client hook for the in-app Copilot chat stream (tool-call loop, pendingActions)
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
    │   ├── Checkbox.tsx       # Styled checkbox with label/description
    │   ├── FileDropZone.tsx   # Drag-and-drop + clique p/ escolher arquivo (.csv), nome/tamanho, aviso >10 MB, acessível
    │   └── ApiKeyRevealModal.tsx # API key reveal with copy + security warning
    ├── notifications/
    │   ├── NotificationBell.tsx        # Header bell — unread count, opens NotificationPanel
    │   ├── NotificationPanel.tsx       # In-app notification list (tarefas + handoff_requested/handoff_resolved/ai_draft_pending), navega pelo ponteiro do item, mark read
    │   └── NotificationPreferences.tsx # Email notification preferences (Settings tab)
    ├── copilot/
    │   └── CopilotPanel.tsx   # Copilot chat SlideOver — streams via useCopilotStream, renders tool calls + pendingAction confirmations
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
    ├── KanbanBoard.tsx         # Pipeline board with drag-and-drop (route: /app/pipeline) — deep-link ?board=<id> e ?lead=<id> (abre LeadDetailPanel; param sincronizado no abrir/fechar p/ o back do browser)
    ├── LeadDetailPanel.tsx     # SlideOver for lead details
    ├── CreateLeadModal.tsx     # Modal for creating new leads
    ├── leads/                  # Alternate list view for leads (shared with KanbanBoard)
    │   ├── LeadsListView.tsx        # Sortable/filterable table view of leads with row selection
    │   └── LeadsBulkActionBar.tsx   # Bulk move/assign/archive bar for selected leads
    ├── Inbox.tsx               # Conversation inbox (route: /app/entrada) — search, labels, scheduling, bulk select, banner âmbar + badge de repasse pendente (aceitar inline), deep-link ?conversation=<id> robusto (busca via getConversationById quando a conversa não está na lista carregada)
    ├── inbox/                  # Inbox building blocks (shared with LeadDetailPanel)
    │   ├── MessageBubble.tsx        # Message rendering (media, quotes, reactions, ticks)
    │   ├── VoiceRecorder.tsx        # Mic recording + upload of voice notes
    │   ├── VoiceTranscription.tsx   # Transcription display / "Transcrever" action
    │   ├── EmojiPickerButton.tsx    # Emoji picker for the composer
    │   ├── QuickReplies.tsx         # "/" quick replies (hook + dropdown + manage modal)
    │   ├── ConversationActionsMenu.tsx  # Archive + labels menu ("..." in conversation header)
    │   ├── AiDraftCard.tsx          # AI attendant draft review (suggest mode) + loop de coaching (chips + instrução → regenerar) + AiConversationControls (assumir / devolver para IA / pedir sugestão) + ReturnToAiButton
    │   └── ...                      # ReactionPicker, ForwardModal, AudioPlayer, etc.
    ├── HandoffQueue.tsx        # Fila de repasses IA→humano (route: /app/repasses) — "Espiar conversa" (peek read-only), deep-link ?handoff=<id>, aceitar assume e navega p/ /app/entrada?conversation=<id>
    ├── handoffs/               # Peças da fila de repasses
    │   └── HandoffPeekSlideOver.tsx # Espiada read-only na conversa do repasse (resumo estruturado + BANT, sem composer)
    ├── TeamPage.tsx            # Team member management (route: /app/equipe)
    ├── Settings.tsx            # Organization settings (route: /app/configuracoes) — deep-link ?secao=<id> p/ abrir numa seção
    ├── settings/                # Settings section panels
    │   ├── AiSection.tsx            # AI config: activation/LGPD ack, Copiloto/Atendente toggles, bridge risk ack, attendant profile
    │   ├── ChannelsSection.tsx      # WhatsApp channel configs (Meta Cloud API + bridge), QR pairing, risk ack
    │   ├── ChannelHealthPanel.tsx   # 7-day delivery/health stats per WhatsApp channel
    │   ├── DataSection.tsx          # Aba "Dados" (gate settings:manage): export rápido (CSV/backup JSON + LGPD) com histórico reativo e download; imports com contadores, linhas com erro, desfazer/cancelar
    │   └── ImportWizard.tsx         # Wizard de importação em 5 passos (entidade+upload → mapeamento com encodeHeaderKey → dry-run → execução reativa → resultado); retoma pelo status server-side do job
    ├── AuditLogs.tsx           # Audit log viewer (route: /app/auditoria)
    ├── ContactsPage.tsx        # Contacts management (route: /app/contatos)
    ├── TasksPage.tsx           # Task manager (route: /app/tarefas) — list/kanban per project, deep-link ?task=<id>
    ├── CreateTaskModal.tsx     # Task creation — project, lead, labels, multi-assignee, reminder
    ├── TaskDetailSlideOver.tsx # Task detail — subtasks, dependencies, mentions, stacked navigation, seção Lead (vincular/trocar/remover + abrir no funil + pular p/ conversa)
    ├── tasks/                  # Task manager building blocks (used by TasksPage, CreateTaskModal, TaskDetailSlideOver)
    │   ├── ProjectSwitcher.tsx      # Task project selector/switcher
    │   ├── ProjectFormModal.tsx     # Create/edit task project modal
    │   ├── ColumnsEditorModal.tsx   # Kanban columns editor (add/reorder, WIP limit, done column)
    │   ├── TaskKanbanBoard.tsx      # Kanban board with drag-and-drop columns/cards, manual order
    │   ├── TaskFiltersBar.tsx       # Filter bar (status, priority, project, labels, assignee, due)
    │   ├── SavedFiltersMenu.tsx     # Saved filter views (savedViews entityType "tasks")
    │   ├── LabelPicker.tsx          # Task label multi-select with color
    │   ├── AssigneesPicker.tsx      # Multi-assignee picker (human + AI)
    │   ├── ReminderSelect.tsx       # Early reminder (reminderMinutesBefore) selector
    │   ├── SubtasksSection.tsx      # Subtasks list + progress (parentTaskId hierarchy)
    │   └── DependenciesSection.tsx  # Informational blockedBy dependencies (not enforced)
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
    ├── ErrorBoundary.tsx       # Error boundary wrapper
    └── OrganizationSelector.tsx # Org switcher dropdown
└── pages/
    ├── DevelopersPage.tsx      # Public developer portal at /developers
    ├── PlaygroundPage.tsx      # Full-screen interactive REST API playground at /developers/playground
    ├── PrivacyPage.tsx         # Public privacy policy page at /privacidade
    ├── TermsPage.tsx           # Public terms of use page at /termos
    └── PublicFormPage.tsx      # Public form page at /f/:slug (no auth)
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

