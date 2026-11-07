# CLAUDE.md — Frontend (React + TailwindCSS)

Rules (tokens, primitives, mobile-first, anti-patterns): `.claude/rules/frontend.md` and `STYLE_GUIDE.md`. Architecture/build/SEO history: `docs/architecture/frontend.md`.

## Structure

```
src/
├── main.tsx                    # Entry: ConvexAuthProvider + RouterProvider (react-router v7)
├── SignInForm.tsx              # Password sign-in; links to components/auth/ForgotPasswordForm.tsx (password reset)
├── SignOutButton.tsx           # Sign-out button
├── index.css                   # --rgb-* color channels + full-color aliases (dark/light/whatsapp), shadows, auth classes, shimmer, .chat-wallpaper
├── lib/utils.ts, routes.ts     # cn() (clsx + tailwind-merge); TAB_ROUTES + activeTabForPath() (longest-prefix active tab)
├── lib/format.ts               # pt-BR formatters (date/time/relative/money/count/parseDecimal, formatListTime for the Conversas list) — the only entry point
├── lib/pageHeader.ts           # pure signature/merge of the page contribution to the AppShell mobile header (components/layout/pageHeader.tsx: usePageHeader, PageHeaderSlot, globalMenuItems); test next to it
├── lib/copilotFabPref.ts      # per-device "Botão flutuante do Copiloto" pref (localStorage hnbcrm.copilotFab.enabled, off by default; hook hooks/useCopilotFabPref.ts); lib/copilotShortcut.ts = Ctrl/Cmd+K rule; tests next to them
├── lib/nav.ts                  # NAV_ITEMS/NAV_GROUPS (single nav model), visibleNavItems(), splitMobile(), badge helpers; test next to it
├── lib/vocab.ts                # VOCAB (one UI name per concept) + BANNED_UI_TERMS; guard: lib/vocabGuard.test.ts (+ vocabGuard.allowlist.ts)
├── lib/settingsNav.ts          # Settings: resolveSettingsPanel(), visibleSettingsPanels(), groupOf(), groupSettingsPanels(); test next to it
├── lib/settingsSearch.ts       # searchSettingsPanels(): label + keywords + description, accent/case-insensitive; test next to it
├── lib/funnelEditor.ts         # pure funnel-editor rules (rename/move/add/remove stage, fromTemplate, validateFunnel, toApplyFunnelTemplateArgs); test next to it
├── lib/attendantHoursPresets.ts # "Sempre"/"Comercial" hour presets + matching (wizard AttendantHoursForm); test next to it
├── lib/onboardingWizard.ts     # pure model of the v2 setup wizard (WIZARD_STEPS, firstPendingStep, canAdvance, stepAvailability, attendantGate, attendantStepPatch, wizardData helpers); test next to it
├── lib/onboardingChecklist.ts  # pure order/totals/actions of the Painel "Primeiros passos" (9 items from getOnboardingChecklist); test next to it
├── lib/onboardingTeam.ts       # invite-row rules of wizard step 7 (inviteRowsToSend, roles)
├── lib/pairingUi.ts            # wizard entry point for the pairing-code logic (re-exports lib/channelConnect.ts); test next to it
├── lib/inlineCrud.ts           # pure reducer for list + modal form + delete confirm (useInlineCrud); test next to it
├── lib/uiStrings.ts            # extracts visible strings from TSX (JSX text, label/title/placeholder/aria-label/description, toast.*), sentence-case check
├── lib/contrast.ts             # WCAG contrast helpers (hex/channels, luminance, ratio, alpha composite); test next to it
├── lib/themeTokens.test.ts     # reads index.css: dark palette frozen (--rgb-* channels), aliases, AA pairs + DARK_KNOWN_FAILURES
├── lib/theme.ts                # theme constants/pure logic (THEME_STORAGE_KEY, isAppPath, resolveTheme, shouldPushLocalToServer, toasterTheme, THEME_COLOR, THEME_OPTIONS, themeLabel); test next to it
├── lib/themeDom.ts             # applyTheme/clearTheme on <html> + meta theme-color; subscribe/getAppliedTheme
├── lib/funnelCardPrefs.ts      # Funil card preference (density compact|comfortable + visible fields, localStorage hnbcrm.funnelCard.<org>), tolerant parse (+ test); hook hooks/useFunnelCardPrefs.ts
├── lib/funnelFilters.ts        # Funil labels/variants, client filter, sort, URL (de)serialization (?view=&q=&owner=&temp=&priority=&unit=), initial-funnel pick (+ test)
├── hooks/useFunnelUrlState.ts  # Funil URL state: ?board= (initial pick), ?lead= (panel, replace), filters/view (replace), last funnel per org in localStorage
├── hooks/useUiTheme.ts         # AuthLayout only: syncs theme with teamMembers.uiTheme + localStorage; exposes {theme, setTheme}
├── lib/themeLegacy.test.ts     # guard: no .light in index.css, no [.light_&] in src, no darkMode in tailwind.config.js, index.html without class="dark" and with /theme-init.js first
├── lib/uiClassGuard.test.ts    # guard: no text-[9|10|11px] outside WhatsAppPreview/forms/renderer; viewport height in layout/ui/main needs dvh
├── lib/a11yGuard.test.ts       # guard (TS AST): icon-only buttons need aria-label; no title= on controls in layout/ui/inbox/funnel/settings
├── lib/rawColorsGuard.test.ts  # ratchet: raw Tailwind palette classes / [#hex] per file (ALLOWLIST ceilings only go down); purple- only in JsonHighlighter
├── lib/siblingKeysGuard.test.ts # guard (TS AST): fixed JSX siblings with `key` must have distinct keys at runtime (at most one bare `key={id}`; the others use static text like `header:${id}`; no repeated static format); bug it prevents: stacked conversation headers
├── lib/translationRules.ts     # pure translation rules (v0.80): TranslationMeta, getTranslationMeta, conversationLanguageState (lang/mode/foreign/active), languageChipLabel ("ES · auto"), languageDisplayName/selectableLanguages, translationBannerKind, bubbleTranslation (what a bubble shows by role/status; module off keeps only retained outbound actions), hasFreshUntranslated ("Traduzindo…" inferred); test next to it
├── lib/composerTranslation.ts  # pure composer-translation rules (F3): composerTranslationMode (off|quick|strict), PreviewSkipReason, planTranslatedSend (only `same_language` → `language:"off"`), sendArgsForPlan, PreviewCache (LRU 100), textForCounter, PREVIEW_DEBOUNCE_MS 700 / PREVIEW_SEND_CAP_MS 4000; test next to it
├── lib/translationPrefs.ts     # per-viewer "show original next to translation" (localStorage in try/catch + useSyncExternalStore) and dismissed-banner flags
├── lib/timezones.ts            # time zones with PT-BR names (value = IANA id, unchanged)
├── test/                       # setup.ts (jest-dom, matchMedia/ResizeObserver stubs), render.tsx (renderWithRouter) for *.test.tsx
├── hooks/useNavBadges.ts       # sidebar/tab bar counts (inboxUnread, pendingAttention, pausedCampaigns); "skip" for hidden items (badgeQueriesFor)
├── hooks/usePageTitle.ts       # document.title = "{title} · HNBCRM", restored on unmount; `usePageTitle(null)` leaves the title as is
├── hooks/useInlineCrud.ts      # useReducer over lib/inlineCrud (showForm/editingId/form/confirmDeleteId + actions)
├── hooks/useMediaQuery.ts      # matchMedia subscription (tested with the stub in src/test/setup.ts)
├── hooks/useNow.ts             # "now" that ticks every minute while enabled (Conversas list times turn into "Ontem")
├── lib/searchParamState.ts     # pure URL-state codecs (stringParam, enumParam, booleanParam `1`, numberParam, listParam), writeParams (several params in one write) and the in-flight write (beginWrite/settleWrite); test next to it
├── hooks/useSearchParamState.ts # typed search-param state: replace for filters, push for entities; `isInFlight()` guards URL → state effects (single copy of the `{target, stale}` mechanism)
├── hooks/useTranslationSettings.ts # translation module flag (`useOrgModules`) + `translation.getInboxSettings` (any member): team language, outbound mode
├── lib/inboxState.ts           # pure Conversas logic: activeBotSuspicion, isHandoffPending, aiStateChipInfo, readKindFilter, filterConversations (+ unreadOnly), countUnreadConversations, inboxFilterChips/applyInboxChip (mobile chips), listFilterKey, linkedMatchesView, decideConversationParamAction (param → selection state machine), emptyListMessage; test next to it
├── hooks/useOpenEntityParam.ts # open item in a URL param (?log=, ?member=): push + own-entry mark, close = navigate(-1) or replace, no scroll reset; test next to it
├── hooks/useTasksUrlState.ts   # Tarefas URL state: ?view=list|status, ?smart=, ?status=, ?assignee=, ?label=, ?project= (replace, one write for compound changes); pure part in lib/tasksFilters.ts (codecs, resolveTaskIds) + test
├── hooks/useAuditUrlState.ts   # Histórico URL state: ?entity=&action=&actor=&severity=&from=&to= (replace) and ?log= (push); pure part in lib/auditFilters.ts + test; cursorStack stays in state
├── lib/campaignFilters.ts      # Campanhas ?status=&provider= codecs (replace)
├── hooks/useInboxFilters.ts    # Conversas filters: `?archived=1`, `?label=<id>` and `?unread=1` (mobile chip) (URL, replace; `applyChipState`); direct/group and channel/account (localStorage); Central queue
├── hooks/useConversationList.ts # list batches 50→500, keep-previous, infinite sentinel
├── hooks/useConversationSelection.ts # `?conversation=` (push) ↔ open conversation, deep-link resolver state, `?nova=`, `location.state` draft; test next to it
├── hooks/useBulkConversationSelection.ts # multi-select in the list: archive/unarchive/label in bulk
├── lib/threadPaging.ts         # pure thread rules: scroll anchor on prepend, auto-scroll, jump to message, read signature, typing TTL (limits stay in lib/inboxPaging.ts); test next to it
├── lib/composerRules.ts        # pure composer rules: deriveContentType, Enter/Shift+Enter, reply preview, schedule default, placeholder; test next to it
├── hooks/useCopilotStream.ts   # SSE client hook for the Copilot chat (tool-call loop)
└── components/
    ├── ui/                     # Primitives: Button, Input, Badge, Card, Modal (bottom sheet/dialog), SlideOver, Spinner, Skeleton, Avatar,
    │                           #   ConfirmDialog, Checkbox, FileDropZone (drag/click .csv, >10 MB warning), ApiKeyRevealModal,
    │                           #   form controls: Switch, Select (native), SegmentedControl, Tabs/TabPanel, FormField, Textarea
    │                           #   structure: PageHeader, SectionCard, EmptyState, Stepper, SearchInput (`variant="pill"`), Popover, Menu, Tooltip (+ lib/popoverPosition.ts), FilterChips (toolbar of aria-pressed chips, horizontal scroll)
    ├── notifications/          # NotificationBell (unread count) → NotificationPanel (list, opens item pointer, mark read); NotificationPreferences (Settings)
    ├── copilot/CopilotPanel.tsx  # Copilot chat SlideOver: streams via useCopilotStream, renders tool calls + pendingAction confirmations
    ├── copilot/ConfigPreview.tsx # Pure "Antes/Depois" preview of a pendingAction (bold labels, -/+ diff colors)
    ├── SEO.tsx, StructuredData.tsx  # Dynamic meta tags (react-helmet-async); JSON-LD
    ├── layout/                 # AuthLayout (auth → org → onboarding → ScrollRestoration → AppShell + Outlet), AppShell (Sidebar md+ / BottomTabBar mobile), Sidebar, BottomTabBar
    ├── LandingPage.tsx, AuthPage.tsx  # Public sales page at /; auth screen at /entrar
    ├── DashboardOverview.tsx   # Metrics (/app/painel)
    ├── KanbanBoard.tsx         # re-export of funnel/FunnelPage (main.tsx lazy import, route /app/pipeline)
    ├── funnel/                 # Funil: FunnelPage (orchestration + dnd-kit), FunnelToolbar (search, filters, Modo quadro/lista) + FunnelCardPicker (Exibição dos cards: density and fields popover) + FunnelSelector (funnel/archived/settings Menus),
    │                           #   StageColumn (useDroppable id=stageId), LeadCard (LeadCardView + DraggableCard useDraggable id=leadId, optional `lastMessage`), QuickAddLead,
    │                           #   StageEditPopover (on Popover), AddStageColumn, FunnelDialogs (modals), useFunnelBulkActions, LeadDeepLinkResolver
    ├── CreateLeadModal.tsx     # Lead creation modal
    ├── LeadDetailPanel.tsx     # re-export of leads/detail/LeadDetailPanel (opened by funnel/FunnelPage, inbox/InboxOverlays, contacts/detail/ContactDetailPanel)
    ├── leads/detail/           # LeadDetailPanel (shell: Tabs; `?leadTab=` only when opened by `?lead=` of the same lead, otherwise local state), LeadActionsMenu (Menu), LeadConversationTab, LeadDetailsTab (composes LeadContactBlock, LeadOwnerStageBlock, LeadBasicsBlock, LeadCustomFieldsBlock, LeadQualificationBlock, LeadDocumentsBlock), LeadTasksTab, LeadActivityTab; pure rules in lib/leadFields.ts and lib/leadTab.ts
    ├── leads/                  # LeadsListView (sortable table, row selection), LeadsBulkActionBar (move/assign/archive)
    │   └── detail/LeadConversationTab.tsx  # lead panel "Conversa" tab: ConversationThread variant="embedded" + Composer (no voice/schedule), Select when the lead has >1 conversation
    ├── Inbox.tsx               # Inbox orchestrator (/app/entrada, < 400 lines): wires the hooks above to InboxListColumn/ConversationHeader + ConversationThread + Composer; ?conversation=<id> (getConversationById fallback)
    ├── inbox/                  # MessageBubble, VoiceRecorder, VoiceTranscription, EmojiPickerButton, QuickReplies ("/"), ConversationActionsMenu,
    │                           #   AiDraftCard (+ coaching, AiConversationControls, ReturnToAiButton), MessageActionsBar (menu de ações + reações rápidas; substitui o antigo ReactionPicker), AiControlMenu, ForwardModal, AudioPlayer…
    │                           #   fv2-25: ConversationList (presentational column: header, SegmentedControl/Select filters, search, items, empty state, "Carregar mais", bulk bar; `layout="mobile"` < md = WhatsApp style: pill search, chips, "Arquivadas" row) + ConversationListItem (`variant="compact"` 2 lines, long press → selection; `leadTitleToShow`), InboxFiltersSheet (mobile ⋯ → type/channel/account),
    │                           #   ConversationHeader (contact/group, origin, funnel stage, AiStatusChip, "Assumir conversa"/"Devolver à IA" always visible on a pending handoff, bot suspicion, actions menu),
    │                           #   AiStatusChip, AttentionBanner ("N conversas precisam de você · Ver" → /app/repasses; `usePendingAttentionCount`), GroupMenuItems, GroupConversationPanels (+ `useGroupPanels`),
    │                           #   useGroupMode (group doc + mention names by JID), ScheduledPendingRow, InboxListColumn (list wiring), InboxOverlays (+ `useInboxOverlays`: lead/contact/group panels), ConversationDeepLinkResolver, useConversationHeaderState (typing/window/draft/standby for the header),
    │                           #   fv2-26 (shared with the lead panel): ConversationThread (messages, upward paging, scroll anchor, mark read; `variant="page"|"embedded"`) + useThreadPaging (pure part in lib/threadPaging.ts) + useMarkReadAndPresence (`useContactTyping`, `useMarkRead`, `useTypingBroadcast`),
    │                           #   Composer (container) + ComposerView (presentational, tested; pure rules in lib/composerRules.ts; `features={{voice,schedule,internalNote,quickReplies}}`), conversationInteraction (context: reply target, location.state draft, pending jump), useConversationDoc
    │                           #   (bubbleStyle.test.ts: getBubbleStyle only uses chat/bubble tokens)
    │                           #   Tradução automática (v0.80, módulo opcional; all controls that write need `can("inbox","reply")`):
    │                           #     MessageTranslation (bolha: tradução principal + "Ver original"; "Traduzindo…"/falha/"Tentar de novo"/"Enviar sem traduzir"; enviada mostra o que o lead recebeu), ConversationLanguageChip (pílula + Popover, sem bandeira; mora no slot `languageControl` do Composer) + LanguageOptions + useConversationLanguage,
    │                           #     TranslationBanner (apresentacional) + ConversationTranslationBanner (container no topo do ConversationThread: idioma detectado, pergunta, convite para ligar), TranslationPreviewRow (slot `translationPreview`: prévia viva, "Editar", "Sem traduzir", "Idioma incerto · Traduzir como…") + useComposerTranslation (debounce, LRU, teto de 4 s, `decide()`),
    │                           #     ScheduledPendingRow ("Você escreveu"/versão traduzida da agendada), AiDraftCard ("Ver em pt-BR"), NewConversationModal (seletor de idioma), contacts/detail ("Idioma preferido"); painel settings/TranslationPanel.tsx (id `translation`, grupo `whatsapp`: módulo, idioma da equipe, "Ao responder" Revisar rápido/Enviar direto/Revisar antes, "Testar conexão" com os dois motores; ModelRoutingCard tem o bloco do produto)
    │                           #     Composer `features={{voice,schedule,internalNote,quickReplies,translation}}` (`translation:false` desliga chip e prévia, ex.: grupos); ComposerView recebe os slots `languageControl`/`translationPreview` (+ `fieldReadOnly` enquanto espera a prévia, `sendingLabel`)
    ├── HandoffQueue.tsx        # AI→human handoffs (/app/repasses): peek, ?handoff=<id> via useSearchParamState; accepting navigates to /app/entrada?conversation=<id>
    ├── handoffs/AttentionRow.tsx  # Presentational row of the Requer atenção list: compact (default) with expandable details, or comfortable card; density pref in lib/attentionPrefs.ts (localStorage hnbcrm.attentionDensity)
    ├── handoffs/AttentionListItem.tsx  # Mobile (< md) row of Requer atenção: 2 lines (name + time; reason dot + summary), whole row opens the peek, no per-row buttons; pure rules in lib/attentionList.ts
    ├── handoffs/HandoffPeekSlideOver.tsx  # Read-only peek at the handoff conversation (summary + BANT, no composer)
    ├── TeamPage.tsx, AuditLogs.tsx  # /app/equipe, /app/auditoria
    ├── ContactsPage.tsx        # /app/contatos: `?contact=<id>` (push; own entry marked in location.state, close = navigate(-1)), `?q=` and `?page=` (1-based, replace)
    ├── ContactDetailPanel.tsx  # re-export of contacts/detail/ContactDetailPanel (also opened from Conversas, Grupos and the lead panel)
    ├── contacts/detail/        # ContactDetailPanel (shell: Tabs `?contactTab=info|leads|groups`, replace), ContactInfoTab (4 sections: Dados, Endereço e empresa, Origem, Etiquetas e notas), ContactLeadsTab (LinkedLeadCard), ContactGroupsTab, ContactOptOutControl, ContactFields (ViewField/EditField/EditSelect); pure form in lib/contactForm.ts
    ├── Settings.tsx            # /app/configuracoes shell (two levels: 6 groups > panels). Panel = ?secao=<id> (push on click); group is derived. Mobile: ajustes-style list + search; desktop: sidebar + panel
    ├── onboarding/v2/          # Setup wizard v2 (`/app/configuracao-inicial`, steps 1-8, `?passo=` = current step; also rendered full screen by AuthLayout when shouldShowWizard): OnboardingWizardV2 (container: status/progress/AI queries, resume, defer, complete, Copilot "Configurar conversando"), OnboardingWizardV2View + WizardNav (presentational shell), StepBusiness, StepFunnel, StepWhatsapp (ChannelConnectCard variant="wizard"), StepAttendant, StepTest (AttendantSimulator inline), StepExtras (FeatureToggleCard x2), StepTeam, StepDone. `onboarding/OnboardingChecklist.tsx` = Painel "Primeiros passos" v2; `onboarding/WizardInviteResults.tsx` is shared with the team slide-over. The v1 wizard is gone
    ├── pipeline/FunnelEditor.tsx  # controlled funnel editor (name + stages, "Restaurar sugestão"), no Convex; shared by the v2 setup wizard and Settings
    ├── ai/AttendantSimulator.tsx  # simulateAttendant chat, variant inline|modal (+ AttendantSimulatorView, presentational)
    ├── settings/               # registry.ts (SETTINGS_GROUPS/SETTINGS_PANELS: one entry per panel, lazy Component or href; PLANNED_PANEL_IDS), SettingsNavView (presentational), OrgProfilePanel, AppearancePanel + AppearancePicker + ThemePickerModal (theme choice; sidebar/"Mais" open the modal), CustomFieldsPanel, LeadSourcesPanel, advanced/ (ApiKeysPanel, WebhooksPanel: technical terms allowed here), channels/ (ex-`src/components/settings/ChannelsSection.tsx`, dividido no fv2-21; ChannelsPanel = "Números conectados"; ChannelCard, ChannelConnectCard = único fluxo de conectar número (WhatsApp oficial (Meta) × por QR code, aviso de risco, PairingPanel com "Conectar com código" + QR; View apresentacional + container), BridgeQrModal ("Mostrar QR code"), BridgeHistoryPanel, MetaForm, QrCodeConnectForm (bloco "Configuração manual (avançado)"), InstagramPanel = "Instagram e Messenger", useConnectActions.ts concentra as actions de conexão (BridgeQrModal ainda usa useAction direto)), ChannelHealthPanel (7-day stats), DataSection (export/import), ImportWizard (5 steps)
    │   ├── settings/ai/        # AiOverviewPanel (`ai`), AiFeaturesPanel (`ai-features`), UsagePanel (`ai-usage`), FeatureToggleCard (icon, title, switch, detail slot), ActivationWizardCard, ActivationCard, BridgeAiCard, AttendantCard (status + AttendantModeSwitch + AttendantSimulator variant="modal"), aiTypes
    │   ├── settings/attendant/ # Controlled forms (ConfigFormProps<T>: value/onChange/disabled/errors/variant "panel"|"wizard"; no Convex): AttendantPersonaForm, AttendantKnowledgeForm, AttendantHoursForm, ConversationBehaviorForm, FunnelRulesForm, HandoffRulesForm, FollowUpForm, AttendantModeSwitch. Panels (load + partial save): AttendantProfilePanel (`ai-attendant`), ConversationPanel (`ai-conversation`), HandoffPanel (`ai-handoff`), FollowUpPanel (`ai-followup`); useAttendantProfile (+ useFormDraft), AttendantPanelFrame (SaveBar, useUnsavedGuard/useBlocker, usePanelSave), fields, types
    │   ├── settings/advanced/  # AiModelsPanel (`ai-models`: ModelRoutingCard + PrivacyCard), ModelRoutingParts (technical terms allowed here)
    │   └── settings/channels/  # ChannelTranscriptionToggle (per-channel audio transcription; used by `ai-features` and ChannelCard)
    ├── TasksPage.tsx           # /app/tarefas, list/kanban per project, ?task=<id>
    ├── CreateTaskModal.tsx     # Task creation modal
    ├── TaskDetailSlideOver.tsx # re-export of tasks/detail/TaskDetailSlideOver (`export { } from`, never a second `export function`)
    ├── tasks/detail/           # TaskDetailSlideOver (shell + stack navigation), TaskActionsBar (presentational; Menu), TaskFields, TaskAiFollowUp (+ FollowUpCard), TaskChecklist, TaskComments (own "@Name" mention format; detectMentionTrigger lives in lib/mentions.ts)
    ├── tasks/                  # ProjectSwitcher, ProjectFormModal, ColumnsEditorModal, TaskKanbanBoard, TaskFiltersBar, SavedFiltersMenu, LabelPicker,
    │                           #   AssigneesPicker, ReminderSelect, SubtasksSection, DependenciesSection
    ├── calendar/               # CalendarPage (state, DnD), CalendarHeader, MonthView, WeekView, DayView, TimeGrid, EventBlock (useDraggable), EventDot, DayCell (useDroppable),
    │                           #   CalendarEventModal, EventDetailSlideOver, TaskQuickView (task summary with "Abrir tarefa" -> /app/tarefas?task=<id>), CalendarFilters, useCalendarState.ts, constants.ts
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
- **Navigation:** URL-based; `Sidebar`/`BottomTabBar` derive active state from `useLocation()` via `TAB_ROUTES`/`activeTabForPath()`; `Tab` lives in `lib/routes.ts`; `Sidebar` and `BottomTabBar` only render `NAV_ITEMS` (`lib/nav.ts`, 4 groups; bar = 4 primary items + "Mais" sheet); active item by `activeTabForPath()`; every menu page calls `usePageTitle(VOCAB.x.title)`.
- **Public pages:** render `<SEO title description keywords ogImage />` from `@/components/SEO`.
- **Lazy routes:** `lazy(() => import("./components/X").then(m => ({ default: m.X })))` wrapped in `LazyRoute` (Suspense + `<Spinner size="lg" />`); the Suspense fallback must be static.
- **Scroll:** `<ScrollRestoration />` lives in `AuthLayout.tsx`; the window scrolls (no nested scroll containers).

## Anti-patterns

`Date.now()` / `new Set()` / `[]` / `{}` in `useQuery` args or `useState` (use `useState(() => ...)`), setState in render, Convex queries in Suspense fallbacks.

## Styling and language

Dark default (`:root` dark, `[data-theme="light"|"whatsapp"]` on `<html>` in `index.css`), mobile-first (`md:`/`lg:`), tokens `bg-surface-base|raised`, `text-text-primary|secondary`, `border-border`, `bg-brand-600`;
`cn()` from `@/lib/utils`; `lucide-react` icons (no emoji); pills `rounded-full`, cards `rounded-card border border-border bg-surface-raised`.
All user-facing text is Portuguese (BR); nav: Painel, Pipeline, Caixa de Entrada, Repasses, Equipe, Auditoria, Configurações.
