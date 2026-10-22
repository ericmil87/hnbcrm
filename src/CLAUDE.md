# CLAUDE.md — Frontend (React + TailwindCSS)

Rules (tokens, primitives, mobile-first, anti-patterns): `.claude/rules/frontend.md` and `STYLE_GUIDE.md`. Architecture/build/SEO history: `docs/architecture/frontend.md`.

## Structure

```
src/
├── main.tsx                    # Entry: ConvexAuthProvider + RouterProvider (react-router v7)
├── App.tsx / Dashboard.tsx     # legacy, unused (superseded by router + AuthLayout)
├── SignInForm.tsx              # Password sign-in; links to components/auth/ForgotPasswordForm.tsx (password reset)
├── SignOutButton.tsx           # Sign-out button
├── index.css                   # CSS custom properties (dark/light), auth classes, shimmer
├── lib/utils.ts, routes.ts     # cn() (clsx + tailwind-merge); TAB_ROUTES / PATH_TO_TAB route constants
├── hooks/useCopilotStream.ts   # SSE client hook for the Copilot chat (tool-call loop)
└── components/
    ├── ui/                     # Primitives: Button, Input, Badge, Card, Modal (bottom sheet/dialog), SlideOver, Spinner, Skeleton, Avatar,
    │                           #   ConfirmDialog, Checkbox, FileDropZone (drag/click .csv, >10 MB warning), ApiKeyRevealModal
    ├── notifications/          # NotificationBell (unread count) → NotificationPanel (list, opens item pointer, mark read); NotificationPreferences (Settings)
    ├── copilot/CopilotPanel.tsx  # Copilot chat SlideOver: streams via useCopilotStream, renders tool calls + pendingAction confirmations
    ├── SEO.tsx, StructuredData.tsx  # Dynamic meta tags (react-helmet-async); JSON-LD
    ├── layout/                 # AuthLayout (auth → org → onboarding → ScrollRestoration → AppShell + Outlet), AppShell (Sidebar md+ / BottomTabBar mobile), Sidebar, BottomTabBar
    ├── LandingPage.tsx, AuthPage.tsx  # Public sales page at /; auth screen at /entrar
    ├── DashboardOverview.tsx   # Metrics (/app/painel)
    ├── KanbanBoard.tsx         # Pipeline drag-and-drop (/app/pipeline); deep-links ?board=<id>, ?lead=<id> (opens LeadDetailPanel, param synced for browser back)
    ├── LeadDetailPanel.tsx, CreateLeadModal.tsx  # Lead SlideOver / creation modal
    ├── leads/                  # LeadsListView (sortable table, row selection), LeadsBulkActionBar (move/assign/archive)
    ├── Inbox.tsx               # Inbox (/app/entrada): search, labels, scheduling, bulk select, pending-handoff banner, ?conversation=<id> (getConversationById fallback)
    ├── inbox/                  # MessageBubble, VoiceRecorder, VoiceTranscription, EmojiPickerButton, QuickReplies ("/"), ConversationActionsMenu,
    │                           #   AiDraftCard (+ coaching, AiConversationControls, ReturnToAiButton), ReactionPicker, ForwardModal, AudioPlayer…
    ├── HandoffQueue.tsx        # AI→human handoffs (/app/repasses): peek, ?handoff=<id>; accepting navigates to /app/entrada?conversation=<id>
    ├── handoffs/HandoffPeekSlideOver.tsx  # Read-only peek at the handoff conversation (summary + BANT, no composer)
    ├── TeamPage.tsx, AuditLogs.tsx, ContactsPage.tsx  # /app/equipe, /app/auditoria, /app/contatos
    ├── Settings.tsx            # /app/configuracoes, deep-link ?secao=<id>
    ├── settings/               # AiSection, ChannelsSection (Meta + bridge, QR), ChannelHealthPanel (7-day stats), DataSection (export/import), ImportWizard (5 steps)
    ├── TasksPage.tsx           # /app/tarefas, list/kanban per project, ?task=<id>
    ├── CreateTaskModal.tsx, TaskDetailSlideOver.tsx  # Task creation / detail (subtasks, dependencies, mentions, Lead section)
    ├── tasks/                  # ProjectSwitcher, ProjectFormModal, ColumnsEditorModal, TaskKanbanBoard, TaskFiltersBar, SavedFiltersMenu, LabelPicker,
    │                           #   AssigneesPicker, ReminderSelect, SubtasksSection, DependenciesSection
    ├── calendar/               # CalendarPage (state, DnD), CalendarHeader, MonthView, WeekView, DayView, TimeGrid, EventBlock (useDraggable), EventDot, DayCell (useDroppable),
    │                           #   CalendarEventModal, EventDetailSlideOver, CalendarFilters, useCalendarState.ts, constants.ts
    ├── forms/                  # FormListPage (/app/formularios), FormBuilderPage (/app/formularios/:id)
    │   ├── builder/            # types.ts, FieldPalette, FieldCard, FieldCanvas, FieldConfigPanel, CrmMappingSelect, FormSettingsPanel, ThemePanel, PublishDialog
    │   └── renderer/           # FormRenderer, FormField, FormSuccess (public renderer)
    ├── ErrorBoundary.tsx
    └── org/OrgSwitcher.tsx     # Org switcher modal (list, new organization, sign out)
└── pages/                      # DevelopersPage (/developers), PlaygroundPage (/developers/playground), PrivacyPage (/privacidade), TermsPage (/termos), PublicFormPage (/f/:slug)
```

## Patterns

- **Data:** `useQuery(api.module.fn, ready ? { organizationId } : "skip")`; mutations via `useMutation` + `toast.promise` from `sonner`; loading = `<Spinner size="lg" />`.
- **Auth/org:** `AuthLayout` (`useConvexAuth()`) redirects unauthenticated users to `/entrar`, gates org/onboarding, and passes `<Outlet context={{ organizationId }}>`;
  pages read it with `useOutletContext<AppOutletContext>()`.
- **Navigation:** URL-based; `Sidebar`/`BottomTabBar` derive active state from `useLocation()` via `TAB_ROUTES`/`PATH_TO_TAB`; `Tab` type exported from `BottomTabBar.tsx`.
- **Public pages:** render `<SEO title description keywords ogImage />` from `@/components/SEO`.
- **Lazy routes:** `lazy(() => import("./components/X").then(m => ({ default: m.X })))` wrapped in `LazyRoute` (Suspense + `<Spinner size="lg" />`); the Suspense fallback must be static.
- **Scroll:** `<ScrollRestoration />` lives in `AuthLayout.tsx`; the window scrolls (no nested scroll containers).

## Anti-patterns

`Date.now()` / `new Set()` / `[]` / `{}` in `useQuery` args or `useState` (use `useState(() => ...)`), setState in render, Convex queries in Suspense fallbacks.

## Styling and language

Dark default (`:root` dark, `.light` override in `index.css`), mobile-first (`md:`/`lg:`), tokens `bg-surface-base|raised`, `text-text-primary|secondary`, `border-border`, `bg-brand-600`;
`cn()` from `@/lib/utils`; `lucide-react` icons (no emoji); pills `rounded-full`, cards `rounded-card border border-border bg-surface-raised`.
All user-facing text is Portuguese (BR); nav: Painel, Pipeline, Caixa de Entrada, Repasses, Equipe, Auditoria, Configurações.
