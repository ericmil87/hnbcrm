# Mapa do frontend HNBCRM — preparação do módulo "Campanhas"

Repositório: `/home/eric/projects/ClawCRM/clawcrm-repo`
Stack: React 19 + react-router 7 + TailwindCSS 3 + Vite 6 + Convex. 188 arquivos em `src/`.
Levantamento de mapeamento apenas — nenhuma solução proposta.

---

# 1. Roteamento e navegação

## Router

`src/main.tsx:48-78`. `createBrowserRouter` plano; `/app` tem `AuthLayout` como element e todos os filhos são rotas lazy.

```tsx
const TasksPage = lazy(() => import("./components/TasksPage").then(m => ({ default: m.TasksPage })));
// ...
{ path: "tarefas", element: <LazyRoute Component={TasksPage} /> },
```

Rotas atuais sob `/app` (`src/main.tsx:56-77`):

| path | componente |
|---|---|
| (index) | `<Navigate to="painel" replace />` |
| `painel` | DashboardOverview |
| `pipeline` | KanbanBoard |
| `contatos` | ContactsPage |
| `entrada` | Inbox |
| `tarefas` | TasksPage |
| `calendario` | CalendarPage |
| `repasses` | HandoffQueue |
| `equipe` | TeamPage |
| `auditoria` | AuditLogs |
| `formularios` | FormListPage |
| `formularios/:formId` | FormBuilderPage |
| `formularios/:formId/submissoes` | FormSubmissionsPage |
| `formularios/:formId/analytics` | FormAnalyticsPage |
| `formularios/:formId/experimento/:experimentId` | FormExperimentPage |
| `configuracoes` | Settings |

Rotas públicas: `/`, `/developers`, `/developers/playground`, `/entrar`, `/termos`, `/privacidade`, `/f/:formSlug`.

`LazyRoute` (`src/main.tsx:38-44`) é um wrapper de Suspense com spinner de tela cheia:

```tsx
function LazyRoute({ Component }: { Component: React.LazyExoticComponent<() => React.JSX.Element> }) {
  return (
    <Suspense fallback={<div className="flex h-screen items-center justify-center"><Spinner size="lg" /></div>}>
      <Component />
    </Suspense>
  );
}
```

Providers (`src/main.tsx:80-87`): `HelmetProvider` → `ConvexAuthProvider` → `RouterProvider`, mais `<Toaster theme="dark" />` do sonner.

## Constantes de rota

`src/lib/routes.ts:3-19`. `TAB_ROUTES` mapeia id de `Tab` → path; `PATH_TO_TAB` é o inverso derivado. Os dois componentes de navegação leem o estado ativo de `PATH_TO_TAB[location.pathname]`, então uma rota nova sem entrada aqui nunca fica destacada.

```ts
export const TAB_ROUTES: Record<Tab, string> = {
  dashboard: "/app/painel",
  board: "/app/pipeline",
  contacts: "/app/contatos",
  inbox: "/app/entrada",
  tasks: "/app/tarefas",
  calendar: "/app/calendario",
  handoffs: "/app/repasses",
  team: "/app/equipe",
  audit: "/app/auditoria",
  forms: "/app/formularios",
  settings: "/app/configuracoes",
};
```

União `Tab` em `src/components/layout/BottomTabBar.tsx:25`:

```ts
export type Tab = "dashboard" | "board" | "contacts" | "inbox" | "tasks" | "calendar" | "handoffs" | "team" | "audit" | "settings" | "forms";
```

## Sidebar (desktop, md+)

`src/components/layout/Sidebar.tsx`. Itens são um array simples em `:34-46`:

```ts
interface NavItem {
  id: Tab;
  label: string;
  icon: React.ElementType;
  permission?: { category: PermissionCategory; level: string };
}

const navItems: NavItem[] = [
  { id: "dashboard", label: "Painel", icon: LayoutDashboard },
  { id: "board", label: "Pipeline", icon: Kanban, permission: { category: "leads", level: "view_own" } },
  { id: "contacts", label: "Contatos", icon: Contact2, permission: { category: "contacts", level: "view" } },
  { id: "inbox", label: "Caixa de Entrada", icon: MessageSquare, permission: { category: "inbox", level: "view_own" } },
  { id: "handoffs", label: "Repasses", icon: ArrowRightLeft, permission: { category: "inbox", level: "view_own" } },
  { id: "tasks", label: "Tarefas", icon: CheckSquare, permission: { category: "tasks", level: "view_own" } },
  { id: "calendar", label: "Calendário", icon: CalendarDays, permission: { category: "tasks", level: "view_own" } },
  { id: "team", label: "Equipe", icon: Users, permission: { category: "team", level: "view" } },
  { id: "audit", label: "Auditoria", icon: ScrollText, permission: { category: "auditLogs", level: "view" } },
  { id: "forms", label: "Formulários", icon: FileText, permission: { category: "settings", level: "manage" } },
  { id: "settings", label: "Configurações", icon: Settings, permission: { category: "settings", level: "view" } },
];
```

Filtragem em `:60-65`:

```tsx
const { can } = usePermissions(organizationId);
const visibleItems = useMemo(() => {
  return navItems.filter((item) => {
    if (!item.permission) return true;
    return can(item.permission.category, item.permission.level);
  });
}, [can]);
```

Ícones são componentes lucide guardados como `React.ElementType` e renderizados via `const Icon = item.icon; <Icon size={20} className="shrink-0" />` (`:101`, `:120`). Aside colapsada em `w-16`, expandida em `lg:w-56` (`:85`); rótulos são `hidden lg:block`.

Botão do item (`:106-141`):

```tsx
className={cn(
  "relative w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
  "min-h-[44px]",
  isActive
    ? "bg-brand-500/10 text-brand-500"
    : "text-text-secondary hover:text-text-primary hover:bg-surface-overlay"
)}
aria-current={isActive ? "page" : undefined}
```

## Badges

`Sidebar.tsx:67-82` e `BottomTabBar.tsx:82-97`. Ambos consultam `api.conversations.getInboxUnreadCount` e `api.handoffs.getPendingHandoffCount`, com `"skip"` quando falta permissão de inbox:

```ts
const canSeeInbox = can("inbox", "view_own");
const inboxUnread = useQuery(api.conversations.getInboxUnreadCount, canSeeInbox ? { organizationId } : "skip");
const pendingHandoffs = useQuery(api.handoffs.getPendingHandoffCount, canSeeInbox ? { organizationId } : "skip");
const badgeCounts: Partial<Record<Tab, number | undefined>> = { inbox: inboxUnread, handoffs: pendingHandoffs };
```

Contagem é capada em `99+`. Sidebar expandida renderiza o pill no fim da linha (`ml-auto`), colapsada renderiza absoluto sobre o ícone (`Sidebar.tsx:122-139`):

```tsx
<span className="hidden lg:flex ml-auto min-w-[18px] h-[18px] px-1 items-center justify-center rounded-full bg-brand-600 text-white text-[10px] font-semibold leading-none tabular-nums">
```

## BottomTabBar (mobile, `md:hidden`)

Dois arrays: `primaryTabs` (`:35-41`, cinco itens na barra: dashboard, board, calendar, inbox, tasks) e `moreTabs` (`:44-51`, overflow: contacts, handoffs, team, audit, forms, settings). Props `{ organizationId, showMore, onToggleMore }` (`:53-57`), com o estado `showMore` morando no `AppShell`.

O botão "Mais" ganha um ponto quando qualquer item do overflow tem badge (`:179-184`). Barra é `fixed bottom-0 left-0 right-0 z-30 md:hidden ... pb-safe` com `h-16` (`:133-134`).

## AppShell

`src/components/layout/AppShell.tsx`, 75 linhas. Props `{ onSignOut, organizationId, orgSelector?, children }`.

```tsx
<div className="min-h-screen bg-surface-base">
  <Sidebar onSignOut={onSignOut} organizationId={organizationId} orgSelector={orgSelector} />
  <main className="md:ml-16 lg:ml-56 transition-all duration-200">
    <header className="sticky top-0 z-30 h-14 md:h-16 flex items-center justify-end px-4 md:px-6 bg-surface-raised/95 backdrop-blur border-b border-border">
      <NotificationBell organizationId={organizationId} />
    </header>
    <div className="min-h-[calc(100vh-3.5rem)] md:min-h-[calc(100vh-4rem)] pb-20 md:pb-0">
      <div className="p-4 md:p-6">{children}</div>
    </div>
  </main>
  <BottomTabBar organizationId={organizationId} showMore={showMore} onToggleMore={() => setShowMore(!showMore)} />
  {/* FAB do Copiloto */}
</div>
```

O header só carrega o sino de notificações. O FAB do Copiloto é gated em `aiStatus?.active && aiStatus.copilotEnabled` (`:56`), posicionado `fixed z-40 bottom-20 right-4 md:bottom-6 md:right-6 h-14 w-14 rounded-full bg-brand-600` — relevante porque uma barra flutuante nova (estilo bulk-action) disputa esse canto.

## Como adicionar rota + item de menu

Quatro edições, todas obrigatórias:

1. `src/components/layout/BottomTabBar.tsx:25` — adicionar o id à união `Tab`.
2. `src/lib/routes.ts` — adicionar `<id>: "/app/<path>"` a `TAB_ROUTES` (o `PATH_TO_TAB` deriva sozinho).
3. `src/main.tsx` — `const X = lazy(...)` + `{ path: "<path>", element: <LazyRoute Component={X} /> }`.
4. `Sidebar.tsx:34-46` (`navItems`) **e** `BottomTabBar.tsx:35-51` (`primaryTabs` ou `moreTabs`).

Pular o passo 2 quebra o destaque do item ativo em ambas as navegações.

## Outlet context

`src/components/layout/AuthLayout.tsx:21-23` e `:168`:

```tsx
export type AppOutletContext = { organizationId: Id<"organizations"> };
// ...
<Outlet context={{ organizationId: activeOrgId } satisfies AppOutletContext} />
```

O layout faz gate em cadeia: `useConvexAuth()` → seleção de org → wizard de onboarding → `mustChangePassword` → `ScrollRestoration` + `AppShell`. Org selecionada persiste em `localStorage` sob `hnbcrm.selectedOrgId` (`:25-33`), com try/catch para modo privado.

---

# 2. Compositor do inbox

## Estrutura do compositor

Inline em `src/components/Inbox.tsx:1563-1731`, dentro de `<form onSubmit={handleSendMessage} className="shrink-0 border-t border-border bg-surface-raised">`, com miolo em `max-w-4xl mx-auto w-full p-4`.

| Elemento | Linhas |
|---|---|
| Checkbox "Nota interna" + Badge de aviso | 1567-1576 |
| Barra de citação de resposta (`replyTo`) | 1579-1597 |
| Lista de mensagens agendadas pendentes | 1599-1609 |
| Aviso "apenas o primeiro anexo será enviado" | 1610-1614 |
| `QuickReplyDropdown` | 1616-1622 |
| `FileUploadButton` + `EmojiPickerButton` + `MentionTextarea` | 1623-1663 |
| Popover de agendamento (`datetime-local`) | 1665-1701 |
| `VoiceRecorder` OU Button de submit | 1702-1723 |

Sem permissão de `inbox:reply`, o form inteiro é substituído por uma linha de texto (`:1727-1731`).

O campo de texto é `MentionTextarea` (`src/components/ui/MentionTextarea.tsx`, 256 linhas), não um `<textarea>` cru. Props usadas: `inputRef`, `value`, `onChange(value)`, `onKeyDown`, `teamMembers`, `mentionEnabled` (só `true` em nota interna), `placeholder`, `rows={1}`, `className`.

Teclado (`:1642-1650`):

```tsx
onKeyDown={(e) => {
  if (quickReplies.handleKeyDown(e)) return;   // quick replies têm prioridade
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (newMessage.trim() || stagedFiles.length > 0) handleSendMessage(e as unknown as React.FormEvent);
  }
}}
```

Microfone substitui o botão de enviar quando o compositor está vazio (`Inbox.tsx:936-938`):

```ts
const composerEmpty = newMessage.trim() === "" && stagedFiles.length === 0;
const showVoice = channelIsWhatsapp && !isInternal && canReply && (recorderActive || composerEmpty);
```

Estado relevante do compositor (`Inbox.tsx:110-143`): `newMessage`, `isInternal`, `stagedFiles: UploadedFile[]`, `replyTo: InboxMessage | null`, `recorderActive`, `scheduleOpen`, `scheduleValue`, `transcribingIds: Set`, `describingIds: Set`. Ref do textarea em `:235` (`composerInputRef`), usada para inserir emoji na posição do cursor (`:238`).

## Envio

`handleSendMessage` em `src/components/Inbox.tsx:560-585`, via `useMutation(api.conversations.sendMessage)` (declarada em `:219`):

```ts
const handleSendMessage = async (e: React.FormEvent) => {
  e.preventDefault();
  const trimmed = newMessage.trim();
  if ((!trimmed && stagedFiles.length === 0) || !selectedConversation) return;
  try {
    const mentionedUserIds = isInternal ? extractMentionIds(trimmed) : undefined;
    const attachments = stagedFiles.map((f) => f.fileId);
    await sendMessage({
      conversationId: selectedConversation as Id<"conversations">,
      content: trimmed,
      contentType: attachments.length ? deriveContentType(stagedFiles) : "text",
      isInternal,
      attachments: attachments.length ? attachments : undefined,
      mentionedUserIds: mentionedUserIds?.length ? mentionedUserIds : undefined,
      replyToMessageId: !isInternal && replyTo ? (replyTo._id as Id<"messages">) : undefined,
    });
    setNewMessage(""); setStagedFiles([]); setReplyTo(null); stopTyping();
  } catch (error) {
    toast.error("Falha ao enviar mensagem");
  }
};
```

`handleSendVoice` (`:587-597`) manda `contentType: "audio"` com um anexo único.

Outras mutations/actions do inbox (`:209-224`): `api.scheduledMessages.listPending/schedule/cancel`, `api.conversations.bulkSetConversationsArchived`, `bulkApplyConversationLabel`, `reactToMessage`, `markConversationRead`, `sendTypingState`; actions `api.transcription.transcribe` e `api.vision.describeImage`.

Agendamento (`:253-297`): popover com `<input type="datetime-local">`, converte com `new Date(scheduleValue).getTime()`, chama `scheduleMessage({ ..., scheduledAt })`. Os botões dentro do popover são `type="button"` de propósito — o default `submit` dispararia o envio imediato junto (comentário em `:1689-1690`).

## Upload de mídia

`src/components/ui/FileUploadButton.tsx`, 204 linhas. Fluxo de três passos em `:85-121`:

```ts
const generateUploadUrl = useMutation(api.files.generateUploadUrl);
const saveFile = useMutation(api.files.saveFile);

for (const file of filesToUpload) {
  const uploadUrl = await generateUploadUrl({ organizationId });
  const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
  if (!response.ok) throw new Error(`Falha ao enviar ${file.name}`);
  const { storageId } = await response.json();
  const fileId = await saveFile({
    organizationId, storageId, name: file.name, mimeType: file.type, size: file.size,
    fileType: "message_attachment",
  });
  newFiles.push({ fileId, name: file.name, mimeType: file.type, size: file.size });
}
```

Tipo de saída (`:29-34`):

```ts
export interface UploadedFile {
  fileId: Id<"files">;
  name: string;
  mimeType: string;
  size: number;
}
```

Props (`:36-43`): `organizationId`, `onFilesUploaded(files)`, `onFilesRemoved?(fileId)`, `uploadedFiles`, `disabled?`, `className?`. Teto `MAX_FILES = 5` (`:27`). Allowlist `ACCEPTED_TYPES` em `:9-25`: jpeg/png/gif/webp, pdf, doc/docx, xls/xlsx, text/plain, text/csv, application/json, audio/mpeg, audio/wav, audio/ogg. **Sem vídeo.** Chips dos arquivos staged em `:146-166`; botão é `p-2 rounded-full` com `Paperclip` ou `Loader2 animate-spin`.

`VoiceRecorder` (`src/components/inbox/VoiceRecorder.tsx:11-18`):

```ts
interface VoiceRecorderProps {
  organizationId: Id<"organizations">;
  disabled?: boolean;
  onActiveChange?: (active: boolean) => void;   // esconde o input de texto durante a gravação
  onRecorded: (file: UploadedFile) => Promise<void> | void;
}
type Mode = "idle" | "recording" | "preview";
```

Prefere `audio/ogg;codecs=opus`, cai para `audio/webm;codecs=opus` (`:24-35`). Faz o próprio upload e devolve um `UploadedFile` pronto.

## Bolha de mensagem

`src/components/inbox/MessageBubble.tsx`, 391 linhas. Props (`:25-50`):

```ts
interface MessageBubbleProps {
  message: InboxMessage;
  channelIsWhatsapp: boolean;      // ticks + reply/react/forward só valem no WhatsApp
  canInteract: boolean;
  currentMemberId?: string | null;
  contactName?: string;
  transcribing?: boolean;
  describing?: boolean;
  visionEnabled?: boolean;
  highlighted?: boolean;
  onReply / onReact(message, emoji) / onForward / onTranscribe / onDescribeImage / onJumpToMessage
}
```

Resolver de estilo `getBubbleStyle` (`:63-110`) devolve quatro formas:

| Caso | align | bg | rounded | label | labelColor | footerText |
|---|---|---|---|---|---|---|
| `isInternal` | `justify-end` | `bg-surface-overlay border border-dashed border-semantic-warning/30 text-text-primary` | `rounded-lg rounded-br-none` | Nota Interna | `text-semantic-warning` | `text-text-muted` |
| inbound / `senderType==="contact"` | `justify-start` | `bg-surface-raised text-text-primary` | `rounded-lg rounded-bl-none` | Contato | `text-text-secondary` | `text-text-muted` |
| `senderType==="ai"` | `justify-end` | `bg-purple-600/80 text-white` | `rounded-lg rounded-br-none` | Agente IA | `text-purple-300` | `text-white/75` |
| humano outbound | `justify-end` | `bg-brand-600 text-white` | `rounded-lg rounded-br-none` | Equipe | `text-brand-200` | `text-white/75` |

Corpo da bolha (`:300-390`), nessa ordem: linha de label → `QuotedBlock` → aviso "Mídia indisponível" → `MessageAttachments` → `VoiceTranscription` → `ImageDescription` → texto → footer → linha de erro de entrega.

```tsx
<div id={`msg-${message._id}`} className={cn("group flex scroll-mt-4", style.align)}>
  <div className="relative flex flex-col gap-1 max-w-xs lg:max-w-md">
    {actions}
    <div className={cn(
      "px-3 py-2 flex flex-col gap-1.5",
      style.bg, style.rounded,
      isFailed && "ring-1 ring-semantic-error/60",
      highlighted && "ring-2 ring-brand-500 ring-offset-2 ring-offset-surface-base transition-shadow"
    )}>
      <div className={cn("text-xs font-medium", style.labelColor)}>{/* nome */}</div>
      ...
      {visibleText && <p className="text-sm whitespace-pre-wrap break-words">{visibleText}</p>}
      {footer}
    </div>
    {reactionChips}
  </div>
</div>
```

Figurinha sozinha renderiza sem fundo de bolha (`:196-197`, `:287-298`).

### Ticks de entrega

`DeliveryTick` (`:112-125`):

```tsx
if (status === "failed")    return <AlertCircle className="size-3.5 text-semantic-error shrink-0" />;
if (status === "read")      return <CheckCheck  className="size-3.5 text-brand-400 shrink-0" />;
if (status === "delivered") return <CheckCheck  className="size-3.5 text-current opacity-70 shrink-0" />;
return                             <Check       className="size-3.5 text-current opacity-70 shrink-0" />;
```

Footer (`:271-276`):

```tsx
<div className={cn("flex items-center justify-end gap-1 mt-1", style.footerText)}>
  <span className="text-[10px] tabular-nums">{timestamp}</span>
  {showDeliveryTick && <DeliveryTick message={message} />}
</div>
```

`timestamp` é `new Date(message.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })` (`:199-202`). Tick só aparece se `!message.isInternal && direction === "outbound" && channelIsWhatsapp` (`:181-182`).

### Renderização de mídia

`src/components/inbox/MessageAttachments.tsx:44-153`, branching por mime:

- **figurinha** → `<img className="max-w-[128px] max-h-[128px] object-contain">`, sem lightbox (`:62-72`)
- **imagem** → botão que abre `ImageLightbox`, thumb `max-w-[240px] max-h-[240px] object-cover rounded-lg`, `loading="lazy"` (`:75-92`)
- **áudio** → `<AudioPlayer src variant isVoiceNote>` (`:95-104`)
- **vídeo** → `<video controls preload="metadata" className="max-w-full max-h-[320px] rounded-lg">` (`:107-117`)
- **documento** → chip de download (`:120-141`):

```tsx
<a href={file.url} download={file.name} className={cn(
  "flex items-center gap-2.5 px-3 py-2 rounded-lg max-w-[280px] transition-colors",
  outbound ? "bg-white/15 text-white hover:bg-white/25"
           : "bg-surface-sunken/70 text-text-secondary hover:bg-surface-sunken"
)}>
  <DocumentIcon mimeType={file.mimeType} />
  <div className="flex-1 min-w-0">
    <span className="block text-xs font-medium truncate">{file.name}</span>
    <span className={cn("text-[10px]", outbound ? "text-white/70" : "text-text-muted")}>{formatFileSize(file.size)}</span>
  </div>
  <Download size={16} className="shrink-0" />
</a>
```

Anexo sem URL cai em "Anexo indisponível" (`:47-59`).

`AudioPlayer` (`src/components/inbox/AudioPlayer.tsx`, 171 linhas): player próprio com play/pause, barra de progresso, velocidades `[1, 1.5, 2]` (`:14`), e um objeto `tone` de duas ramificações por `variant` (`:38-56`) para ler bem nos dois fundos de bolha.

### Tipos e helpers

`src/components/inbox/types.ts`, 203 linhas — a referência única de shape de mensagem (o backend devolve `v.any()`):

```ts
export interface InboxAttachmentFile { _id: string; name: string; mimeType: string; size: number; url: string | null; }

export interface InboxMessage {
  _id: string; conversationId: string; content: string;
  contentType?: "text" | "image" | "file" | "audio";
  direction: string; senderType: string; isInternal: boolean; createdAt: number;
  deliveryStatus?: "sent" | "delivered" | "read" | "failed";
  imageDescription?: string;
  metadata?: Record<string, any>;
  attachmentFiles?: InboxAttachmentFile[];
  sender?: { name?: string | null } | null;
}
```

Helpers exportados: `getQuoted`, `getQuotedMessageId`, `getReactions`, `getTranscription`, `getVision`, `groupReactions`, `isImageMime`, `isAudioMime`, `isVideoMime`, `formatFileSize`, `isMediaPlaceholder` (regex `^\[[^\]]{1,40}\]$` — suprime `[imagem]` quando a mídia real existe), `isVoiceNote`, `isSticker`, `isImageMessage`, `hasMediaProblem`. Tipos `QuotedMeta`, `ReactionMeta`, `TranscriptionMeta`, `VisionMeta`, `VisionKind`, `VisionFields`.

Demais peças do inbox: `ReactionChips`, `ReactionPicker`, `QuotedBlock`, `ImageLightbox`, `MessageActionsBar`, `ForwardModal`, `ConversationActionsMenu`, `VoiceTranscription`, `ImageDescription`, `AiDraftCard`, `QuickReplies`, `EmojiPickerButton`.

---

# 3. Templates Meta

**Não existe UI de templates.** O único vestígio visível ao usuário é o rótulo da janela de 24h no header da conversa (`src/components/Inbox.tsx:903-926`), cujo estado expirado diz `"Janela fechada — requer template"` — um rótulo sem CTA por trás:

```ts
const getServiceWindowInfo = (serviceWindowExpiresAt: number | null) => {
  if (!serviceWindowExpiresAt || serviceWindowExpiresAt <= now) {
    return { text: "Janela fechada — requer template", tone: "text-semantic-warning" as const };
  }
  const remainingMinutes = Math.max(1, Math.round((serviceWindowExpiresAt - now) / 60_000));
  const label = remainingMinutes < 60
    ? `Janela fecha em ${remainingMinutes}min`
    : `Janela fecha em ${Math.round(remainingMinutes / 60)}h`;
  return { text: label, tone: "text-text-secondary" as const };
};
```

A janela é escondida por completo em conversas bridge (`:920-926`): `currentConversation.serviceWindowApplies !== false`.

Capacidade existe no backend e não é consumida pelo frontend:

- `convex/conversations.ts:1441-1550` — `internalSendTemplate`, args `{ conversationId, teamMemberId, templateName, languageCode, components? }`, com guarda de org (`:1456-1459`), grava mensagem `[template] ${templateName}` (`:1494`) e activity (`:1545`).
- `convex/router.ts:888-895` — rota REST exigindo `conversationId`, `templateName`, `languageCode`.

Não há nenhuma listagem de templates aprovados em lugar nenhum (nem query, nem UI). Um módulo de campanhas precisaria construir tanto a listagem quanto a superfície de envio do zero.

Outras ocorrências de "template" em `src/` são de outro domínio: `src/lib/onboardingTemplates.ts` (templates de pipeline por indústria) e `buildJsonTemplate` no playground de API (`src/components/developers/RequestBuilder.tsx:530`).

---

# 4. Settings

## Shell

`src/components/Settings.tsx`, 906 linhas. Nove seções declaradas em `:27-37`:

```ts
type SettingsSection = "general" | "ai" | "apikeys" | "fields" | "sources" | "webhooks" | "channels" | "data" | "notifications";

const SETTINGS_SECTIONS: Array<{ id: SettingsSection; name: string }> = [
  { id: "general", name: "Geral" },
  { id: "ai", name: "IA" },
  { id: "apikeys", name: "Chaves API" },
  { id: "fields", name: "Campos Personalizados" },
  { id: "sources", name: "Fontes de Leads" },
  { id: "webhooks", name: "Webhooks" },
  { id: "channels", name: "Canais" },
  { id: "data", name: "Dados" },
  { id: "notifications", name: "Notificações" },
];
```

Tabs renderizadas como pills (`:78-91`):

```tsx
className={cn(
  "px-4 py-2 rounded-full text-sm font-medium transition-colors",
  activeSection === section.id
    ? "bg-brand-600 text-white"
    : "bg-surface-overlay text-text-secondary hover:bg-surface-raised"
)}
```

Depois uma cadeia de `{activeSection === "x" && <XSection organizationId={organizationId} />}` (`:94-102`). Página inteira gated em `can("settings","view")` (`:61-68`), com fallback de `ShieldAlert` + texto.

Deep-link `?secao=<id>` (`:48-59`):

```tsx
const [searchParams] = useSearchParams();
const sectionParam = searchParams.get("secao");
const [activeSection, setActiveSection] = useState<SettingsSection>(
  isSettingsSection(sectionParam) ? sectionParam : "general"
);
const lastParamRef = useRef<string | null>(sectionParam);
useEffect(() => {
  if (lastParamRef.current === sectionParam) return;
  lastParamRef.current = sectionParam;
  if (isSettingsSection(sectionParam)) setActiveSection(sectionParam);
}, [sectionParam]);
```

O `lastParamRef` evita que o param obsoleto sobrescreva o clique do usuário. Note que o param só semeia o estado — clicar numa tab **não** atualiza a URL.

Seções inline no próprio arquivo: `OrgProfileSection` (`:108`), `ApiKeysSection`, `CustomFieldsSection`, `LeadSourcesSection`, `WebhooksSection`.

## ChannelsSection

`src/components/settings/ChannelsSection.tsx`, 1334 linhas.

URLs de webhook derivadas do env (`:37-42`):

```ts
const CONVEX_SITE = ((import.meta.env.VITE_CONVEX_URL as string) ?? "").replace(/* .cloud -> .site */);
const WEBHOOK_CALLBACK_URL = `${CONVEX_SITE}/webhooks/whatsapp`;
const BRIDGE_WEBHOOK_URL = `${CONVEX_SITE}/webhooks/bridge`;
```

Tipo mascarado do canal (`:44-74`):

```ts
type Provider = "meta" | "bridge";
type BridgeSessionState = "connected" | "connecting" | "qr" | "disconnected" | "banned";

type ChannelConfig = {
  _id: Id<"channelConfigs">;
  channel: "whatsapp";
  provider: Provider;
  displayName: string;
  // Meta
  phoneNumberId: string | null; wabaId: string | null; displayPhoneNumber: string | null;
  verifyToken: string | null; appSecretMasked: string | null; accessTokenMasked: string | null; hasToken: boolean;
  // Bridge
  bridgeBaseUrl: string | null; bridgeInstanceId: string | null; bridgeTokenMasked: string | null;
  hasBridgeToken: boolean; bridgeSessionState: BridgeSessionState | null;
  autoTranscribeAudio: boolean;
  status: "active" | "disabled" | "error";
  lastHealthCheckAt: number | null; healthDetail: string | null;
  createdAt: number; updatedAt: number;
};
```

Componente principal em `:117`, gated em `can("settings","manage")` (`:118-119`). Dados: `useQuery(api.channelConfigs.getChannelConfigs, { organizationId })` (`:129`). Operações (`:133-138`):

- actions: `createChannelConfig`, `updateChannelConfig`, `provisionBridgeChannel`, `checkChannelHealth`
- mutations: `setChannelConfigStatus`, `deleteChannelConfig`

Todos os handlers usam `toast.promise` com `{loading, success, error}` em PT-BR (`:155-180`).

Sub-componentes: `statusBadgeVariant` `:76`, `statusLabel` `:82`, `bridgeStateBadge` `:89`, `ChannelCard` `:363` (props em `:363-387`: `organizationId`, `config`, `testing`, `copiedField`, `onTest`, `onEdit`, `onToggle`, `onToggleAutoTranscribe`, `onDelete`, `onShowQr`, `onCopy`), `BridgeQrModal` `:561` (poll de 4s, `QR_POLL_INTERVAL_MS = 4000`), `ChannelFormModal` `:750`, `ProviderChooser` `:805`, `MetaForm` `:840`, `BridgeForm` `:1035`.

O card é `rounded-lg border border-border bg-surface-sunken p-3.5` (`:397`), com subtítulo preferindo `displayPhoneNumber` e caindo para o id de roteamento (`:390`).

Texto do `ProviderChooser` (`:818`, `:831`) já explicita a diferença que importa para campanhas: Meta "com janela de 24h e templates"; bridge "Sem janela de 24h nem templates".

## ChannelHealthPanel

`src/components/settings/ChannelHealthPanel.tsx`, 100 linhas — a coisa mais próxima de um widget de relatório no app.

```tsx
const WINDOW_DAYS = 7;
// Congelado na montagem — janela móvel não precisa ser reativa ao minuto.
const [since] = useState(() => Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
const stats = useQuery(api.channelConfigs.getChannelStats, { organizationId, since });
if (!stats) return null;
```

O `useState(() => Date.now())` é deliberado — evita o anti-padrão de `Date.now()` direto em args de `useQuery`.

Métricas derivadas (`:30-32`): `failureRate = failed/sent`, `deliveredRate = delivered/sent`, `highFailure = sent >= 10 && failureRate > 0.1`.

Quatro tiles em `grid grid-cols-2 sm:grid-cols-4 gap-2` (`:68-85`): "Enviadas (7d)", "Entregues" (% + sub "N lidas"), "Falhas" (contagem + sub %), "Recebidas (7d)". Tile é `rounded-lg bg-surface-raised border border-border px-3 py-2` com label `text-[11px] text-text-muted` e valor `text-lg font-semibold tabular-nums`, vermelho quando `Falhas > 0`.

Banda âmbar de alerta em `:57-66` quando `highFailure`, com texto sobre risco de restrição/ban. Rodapé (`:87-97`) mostra último envio/recebimento via `formatRelative` (`:13-21`) e nota de amostragem quando `stats.sampled`.

## AiSection

`src/components/settings/AiSection.tsx`, 2330 linhas.

Branch de topo (`:98-114`):

```tsx
const needsActivation = !status.active || !status.hasAttendant;
return (
  <div className="space-y-6">
    {needsActivation ? (
      <ActivationWizardCard organizationId={organizationId} status={status} />
    ) : (
      <>
        <ActivationCard ... />
        <FeatureTogglesCard ... />
        <BridgeAiCard ... />
        <AttendantCard ... />
        <UsageCard ... />
        <PrivacyCard ... />
      </>
    )}
  </div>
);
```

### Switch (primitivo local, não está em `ui/`)

`:38-75`:

```tsx
function Switch({ checked, onChange, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label}
      onClick={onChange} disabled={disabled}
      className="shrink-0 flex items-center justify-center p-2 -m-2 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50 disabled:cursor-not-allowed">
      <span aria-hidden="true" className={cn(
        "pointer-events-none relative inline-flex h-7 w-12 items-center rounded-full transition-colors",
        checked ? "bg-brand-600" : "bg-surface-overlay border border-border-strong"
      )}>
        <span className={cn("inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-6" : "translate-x-1")} />
      </span>
    </button>
  );
}
```

O `p-2 -m-2` dá alvo de toque de 44px sem inflar o pill visual.

### Tipo de status

`:118-137`:

```ts
type AiStatus = {
  enabled: boolean; lgpdAckDone: boolean; active: boolean;
  copilotEnabled: boolean; attendantEnabled: boolean; visionEnabled: boolean;
  bridgeAiAckDone: boolean; hasAttendant: boolean; hasBridgeChannel: boolean;
  models: { copilot: string; attendant: string; classify: string; complex?: string };
  strictZdr: boolean; monthlyConversationBudget: number | null;
  providerMode: "platform" | "byo"; platformOrder: string;
  products: Record<"copilot" | "attendant" | "vision", { order: string; model: string }>;
  byo: { provider: string; baseUrl: string | null; keyLast4: string | null } | null;
};
```

### Aceite LGPD

`ActivationCard` (`:812-925`). Ligar a IA com `!status.lgpdAckDone` abre modal (`:884`):

```tsx
const handleToggle = () => {
  if (!status.enabled && !status.lgpdAckDone) { setShowAckModal(true); return; }   // :825
  ...
};
// confirmação do modal:
await setAiEnabled({ organizationId, enabled: true, lgpdAck: true });              // :843
```

Modal titulado `"Ativar IA — LGPD"` cita "transferência internacional de dados (LGPD, art. 33)" (`:894`). Feito o aceite, uma linha com `ShieldCheck` diz "Reconhecimento LGPD registrado" (`:871-876`). O wizard tem caminho paralelo em `:279-297` (`needsLgpdAck`, `canSubmit = !needsLgpdAck || lgpdChecked`, mutation `activateOneFlow` com `lgpdAck: true`).

### Aceite de risco do bridge (`bridgeAiAck`)

`BridgeAiCard` (`:694-810`). Card com ícone de alerta e um `Switch` ligado a `status.bridgeAiAckDone` (`:756-761`):

```tsx
<Card>
  <div className="flex items-center justify-between gap-4">
    <div className="flex items-start gap-3 min-w-0">
      <div className="h-10 w-10 shrink-0 rounded-full bg-semantic-warning/10 flex items-center justify-center">
        <AlertTriangle size={20} className="text-semantic-warning" />
      </div>
      <div className="min-w-0">
        <h3 className="text-lg font-semibold text-text-primary">Canais não oficiais (bridge)</h3>
        <p className="text-sm text-text-secondary mt-1">
          Libera o atendente IA para responder também nos canais WhatsApp conectados via
          bridge (API não oficial). Sem isso, a IA só atende pelos canais oficiais (Meta).
        </p>
      </div>
    </div>
    <Switch checked={status.bridgeAiAckDone} onChange={handleToggle}
            label="Canais não oficiais (bridge)" disabled={busy} />
  </div>
```

Modal de risco (`:764-795`):

```tsx
<Modal open={showRiskModal} onClose={...} title="Atendente IA em canais bridge">
  <div className="space-y-4">
    <div className="flex items-start gap-2.5 p-3.5 rounded-lg border border-semantic-error/40 bg-semantic-error/10">
      <AlertTriangle size={18} className="shrink-0 text-semantic-error mt-0.5" />
      <p className="text-sm font-semibold text-text-primary">
        Aceito e reconheço que a API não-oficial viola os Termos do WhatsApp e pode causar
        banimento permanente do número, inclusive com uso de IA.
      </p>
    </div>
    <Checkbox checked={riskChecked} onChange={(e) => setRiskChecked(e.target.checked)}
              label="Li e aceito o risco acima" />
    <div className="flex gap-2 pt-2">
      <Button variant="secondary" onClick={...} className="flex-1">Cancelar</Button>
      <Button onClick={() => void handleAccept()} disabled={!riskChecked || busy} className="flex-1">
        Liberar no bridge
      </Button>
    </div>
  </div>
</Modal>
```

Revogar passa por `ConfirmDialog` (`:797`). Padrão reutilizável para qualquer aceite de risco de disparo em massa.

### Modo suggest/autopilot e gate de métricas

`AttendantConfig` (`:1137`), métricas de `api.aiSettings.getAttendantMetrics` (`:1145`). `isAutopilot = profile.mode === "autopilot"` (`:1220`); alternar chama `patch: { mode: isAutopilot ? "suggest" : "autopilot" }` (`:1233`).

Bloco do gate (`:1358-1398`):

```tsx
{metrics && (
  <div className="mt-4 p-3 rounded-lg bg-surface-sunken flex flex-wrap items-center gap-x-6 gap-y-2">
    <div className="text-sm">
      <span className="text-text-muted">Sugestões revisadas: </span>
      <span className="font-medium text-text-primary">{metrics.reviewed}</span>
    </div>
    <div className="text-sm">
      <span className="text-text-muted">Taxa de aceitação: </span>
      <span className="font-medium text-text-primary">
        {metrics.reviewed > 0 ? `${Math.round(metrics.acceptanceRate * 100)}%` : "—"}
      </span>
    </div>
    <div className="flex-1" />
    {isAutopilot ? (
      <Button variant="secondary" onClick={() => void handleModeToggle()}>Voltar ao modo sugestão</Button>
    ) : metrics.autopilotUnlocked ? (
      <Button onClick={() => void handleModeToggle()}>Ativar autopilot</Button>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-xs text-text-muted">
        <Lock size={13} />
        Autopilot libera com 10+ sugestões revisadas e 60%+ de aceitação
      </span>
    )}
    {(isAutopilot || metrics.autopilotUnlocked) && (
      <p className="w-full flex items-center gap-1.5 text-xs text-text-muted">
        <Clock size={12} className="shrink-0" />
        Em autopilot, considere definir um horário de atendimento (
        <button type="button" onClick={() => setShowCustomize(true)}
                className="text-brand-500 hover:text-brand-400 font-medium">Personalizar</button>
        ) se não quiser envios de madrugada.
      </p>
    )}
  </div>
)}
```

### Outros pedaços úteis

- `FeatureTogglesCard` `:469-694` — três produtos (copilot/attendant/vision) com interruptor + modelo + rota cada, `saveModel` com `window.confirm` para rota não-ZDR (`:510-517`), `saveRouting` com `toast.promise` (`:535-544`).
- Selects usam uma string compartilhada, não componente — `SELECT_CLS` (`:2039-2040`):
  `"w-full bg-surface-raised border border-border-strong text-text-primary rounded-field px-3.5 py-2.5 text-sm focus:outline-none focus:border-brand-500"`
- `PERSONAS` `:77-83`, `UsageCard` `:1925`, `PrivacyCard` `:2042`, `SimulatorModal` `:1767`, `SIM_KINDS` `:1737`.
- Limites e defaults do atendente `:1080-1086`: `DEFAULT_REPLIES_PER_CONVERSATION = 20`, `DEFAULT_REPLIES_PER_HOUR = 10`, `DEFAULT_DEBOUNCE_SECONDS = 5`, `MAX_DEBOUNCE_SECONDS = 120`, `SLOW_DEBOUNCE_SECONDS = 30`. Validação com `readReplyLimit`/`replyLimitWarning`/`debounceWarning` (`:1088-1135`) e `WarningNote` (`:1062`).

## ImportWizard

`src/components/settings/ImportWizard.tsx`, 1164 linhas.

Props (`:261-268`) e passos (`:176`):

```ts
const STEPS = ["Arquivo", "Colunas", "Prévia", "Importação", "Resultado"];
```

`stepFromStatus(status)` (`:178`) retoma o passo pelo status server-side do job; `StepTrail` (`:194-231`) desenha a trilha. Componentes de passo: `StepFile` `:593`, `StepMapping` `:722`, `StepPreview` `:892`, `StepRunning` `:1048`, `StepResult` `:1088`. Renderização condicional em `:493-547`.

Tipos e constantes exportados, reutilizáveis:

```ts
export type ImportStatus = "mapping" | "previewing" | "preview_ready" | "running"
  | "completed" | "completed_with_errors" | "failed" | "rolled_back" | "canceled";   // :36-45
export type DuplicateStrategy = "skip" | "update" | "create";                        // :47
export interface ImportJobDoc { ... }                                                // :49-81
export const IMPORT_ENTITY_LABEL: Record<ImportEntity, string>                       // :83-86
export const DUPLICATE_STRATEGY_LABEL                                                // :88+
export function importStatusMeta(status)                                             // :102
export function downloadTextFile(content, fileName, mimeType)                        // :143
export function formatCount(value)                                                   // :170
export function ImportProgressBar({ processed, total })                              // :1029
```

`MAX_IMPORT_BYTES = 10 * 1024 * 1024` (`:591`); `ENTITY_CHOICES` `:549`; `STRATEGY_CHOICES` `:569`. Importa helpers compartilhados do backend: `encodeHeaderKey` de `convex/lib/importKeys` (`:24`) e `CUSTOM_FIELD_PREFIX`/`IGNORE_FIELD`/`filterFieldDefs`/`listImportTargets` de `convex/lib/importMapping` (`:25-32`). Usa `mutationErrorMessage` de `@/lib/errors` (`:23`).

## FileDropZone

`src/components/ui/FileDropZone.tsx`, 186 linhas. Controlado:

```ts
interface FileDropZoneProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
  accept?: string;            // default ".csv"
  maxSizeBytes?: number;      // default 10 MB
  disabled?: boolean;
  hint?: string;
  className?: string;
}
```

`<input type="file" className="peer sr-only">` real atrás de um `<label htmlFor>` (acessível, foco por teclado). Contador `dragDepth` para enter/leave corretos (`:52`, `:83-94`). Validação de extensão em `selectFile` (`:60-73`). Aviso de tamanho renderizado mas **não bloqueante** (`:58`, `:171-176`). Área é `min-h-[140px] rounded-card border border-dashed`, com estado de drag `border-brand-500 bg-brand-500/10`. Botão de remover é `h-11 w-11` (alvo de toque).

## DataSection

`src/components/settings/DataSection.tsx`, 586 linhas. Componente `:164`, gate `settings:manage`.

Dados (`:172-190`): `useQuery` de `api.exports.*` e `api.imports.*` (jobs + `downloadUrl`), mutations `createExportJob`, `rollbackImport`, `cancelImport`, action `getFailedRowsCsv`.

Três `Card`s: header/aviso `:212-223`, exportação `:283-412`, importação `:415-555`.

Grade de ações de exportação (`:296-326`):

```tsx
<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
  {EXPORT_ACTIONS.map((action) => {
    const Icon = action.icon;
    return (
      <button key={action.key} type="button" onClick={() => handleExport(action)}
        disabled={Boolean(activeExport)}
        className={cn(
          "flex min-h-[68px] items-start gap-3 rounded-card border border-border bg-surface-sunken p-3 text-left transition-colors",
          "hover:border-brand-500/60 hover:bg-surface-overlay",
          "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-raised",
          "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border disabled:hover:bg-surface-sunken"
        )}>
        <Icon size={20} className="mt-0.5 shrink-0 text-brand-500" />
        <span className="min-w-0">
          <span className="block text-sm font-medium text-text-primary">
            {action.label} <span className="text-text-muted">({action.format.toUpperCase()})</span>
          </span>
          <span className="block text-xs text-text-secondary">{action.description}</span>
          {action.note && <span className="mt-1 block text-xs text-semantic-warning">{action.note}</span>}
        </span>
      </button>
    );
  })}
</div>
```

Guarda de job único (`:328-332`) e histórico reativo "Exportações recentes" (`:334-412`) com `Spinner` durante `undefined`. Helpers locais: `exportStatusMeta` `:71`, `exportJobTitle` `:88`, `formatDateTime` `:94`, `expiryLabel` `:102`.

---

# 5. Filtros e list views

## Leads

`src/components/KanbanBoard.tsx` (1500+ linhas) hospeda as duas visões. Estado de filtro (`:697-704`):

```ts
const [searchQuery, setSearchQuery] = useState("");
const [priorityFilter, setPriorityFilter] = useState<string>("all");
const [temperatureFilter, setTemperatureFilter] = useState<string>("all");
const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
const [viewMode, setViewMode] = useState<"kanban" | "list">("kanban");
```

Filtragem é **client-side** num `useMemo` (`:836-868`), ordenação em `:873-891` (chaves `title`/`value`/`stage`/`priority`/`temperature`/`assignee`/`updatedAt`, com direção default por tipo em `:914`). Boards arquivados são separados em `:719`.

JSX: barra de busca e filtros `:1325-1420` (com `<select>` nativos em `:1338`, `:1354`, `:1369`), alternador kanban/lista `:1388-1412`, colunas do kanban `:1435-1450`, `LeadsListView` `:1524`, `LeadsBulkActionBar` `:1547` (só quando `viewMode === "list" && selectedLeadIds.size > 0`).

### LeadsListView

`src/components/leads/LeadsListView.tsx`, 276 linhas. **Puramente apresentacional — nenhuma query/mutation.** O integrador ordena antes de passar.

```ts
export type LeadSortKey = "title" | "value" | "stage" | "priority" | "temperature" | "assignee" | "updatedAt";

export interface EnrichedLead {
  _id: string; title: string; value: number; currency: string;
  priority: LeadPriority; temperature: LeadTemperature; tags: string[];
  assignedTo?: string; updatedAt: number; lastActivityAt?: number;
  contact?: { name?: string } | null;
  stage?: { name: string; color?: string } | null;
  assignee?: { name: string; type?: "human" | "ai" } | null;
}

export interface LeadsListViewProps {
  leads: EnrichedLead[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  allSelected: boolean;
  sortKey: LeadSortKey;
  sortOrder: "asc" | "desc";
  onSort: (key: LeadSortKey) => void;
  onRowClick: (id: string) => void;
}
```

Rótulos e variantes: `PRIORITY_LABELS` `:54`, `TEMPERATURE_LABELS` `:61`, `getPriorityVariant` `:67`, `getTemperatureVariant` `:73`, `formatCurrency` com `Intl.NumberFormat("pt-BR", {style:"currency"})` `:79-89`. Tem tabela para desktop e variante em cards para mobile.

### LeadsBulkActionBar

`src/components/leads/LeadsBulkActionBar.tsx`, 246 linhas. Também apresentacional.

```ts
export interface LeadsBulkActionBarProps {
  count: number;
  stages: { _id: string; name: string; color?: string }[];
  teamMembers: { _id: string; name: string; type?: "human" | "ai" }[];
  onMove: (stageId: string) => void;
  onAssign: (memberId: string | null) => void;
  onAddTag: (tag: string) => void;
  onArchive: () => void;
  archiveLabel: string;
  onDelete?: () => void;
  canDelete?: boolean;
  onClear: () => void;
}
```

Container (`:86-90`):

```tsx
<div ref={rootRef} className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:bottom-4 md:pb-0">
  <div className="flex w-full max-w-2xl flex-wrap items-center gap-1.5 rounded-2xl border border-border bg-surface-overlay p-2 shadow-elevated">
```

Ações: Mover (popover de estágios com bolinha de cor), Atribuir (popover com `Avatar` + "Remover responsável"), Etiquetar (form inline), Arquivar, Excluir (só com `canDelete`, em `text-semantic-error`), e X para limpar. `actionButtonClass(active)` em `:27-32` — `h-11` para alvo de toque. Efeito único fecha popovers por clique fora + Escape (`:51-67`). O pai é dono do `Set` de seleção e de todas as mutations.

## Saved views (leads/contatos)

`src/components/ViewSelector.tsx`:

```ts
export interface ViewFilters {
  boardId?: Id<"boards">; stageIds?: Id<"stages">[]; assignedTo?: Id<"teamMembers">;
  priority?: "low" | "medium" | "high" | "urgent";
  temperature?: "cold" | "warm" | "hot";
  tags?: string[]; hasContact?: boolean; company?: string;
  minValue?: number; maxValue?: number;
}

interface ViewSelectorProps {
  organizationId: Id<"organizations">;
  entityType: "leads" | "contacts";
  currentViewId: string | null;
  onViewChange: (viewId: string | null, filters: ViewFilters) => void;
  className?: string;
}
```

Backed por `api.savedViews.getSavedViews` (`:47`) e `deleteSavedView` (`:56`), mais `defaultViews` embutidas por `entityType` (`:59+`). Companion: `src/components/CreateViewModal.tsx`.

**Tarefas usam outra implementação** do mesmo backend: `src/components/tasks/SavedFiltersMenu.tsx`, `entityType: "tasks"`, com shape próprio `TaskSavedFilters` (`:15-30`) e props `{organizationId, currentFilters, onApply}` (`:39-44`).

## Contatos

`src/components/ContactsPage.tsx`. **Sem barra de filtros** — só busca com debounce de 300ms (`:101-107`) que troca a fonte da query (`:128-139`):

```ts
const searchResults = useQuery(api.contacts.searchContacts,
  debouncedSearch.length >= 2 ? { organizationId, searchText: debouncedSearch } : "skip");
const allContacts = useQuery(api.contacts.getContacts,
  debouncedSearch.length < 2 ? { organizationId } : "skip");
const contacts = debouncedSearch.length >= 2 ? searchResults : allContacts;
```

Seletor de colunas com `activeColumns` persistido (`:72`), `fieldDefinitions` para campos personalizados (`:57`), e `Pagination` client-side (`:141-144`, `:490`) com reset de página ao mudar a busca.

---

# 6. UI kit (`src/components/ui/`)

| Componente | Props principais | Notas |
|---|---|---|
| `Button.tsx` | `variant`: primary \| secondary \| ghost \| dark \| danger; `size`: sm \| md \| lg | sempre `rounded-full`; forwardRef; `h-8/h-10/h-12` |
| `Input.tsx` | `label`, `error`, `icon` | ícone à esquerda vira `pl-10`; forwardRef |
| `Badge.tsx` | `variant`: default \| brand \| success \| error \| warning \| info | `rounded-full px-2.5 py-0.5 text-xs font-medium` |
| `Card.tsx` | `variant`: default \| sunken \| interactive | `rounded-card border border-border p-4 md:p-6` |
| `Modal.tsx` | `open`, `onClose`, `title`, `className` | bottom sheet no mobile, `sm:max-w-lg` centrado no desktop; Escape + lock de scroll; `z-50` |
| `SlideOver.tsx` | `open`, `onClose`, `title`, `titleIcon`, `headerActions`, `className`, `bodyClassName` | fullscreen mobile, `md:w-[480px]` à direita; `z-50`; seta de voltar no mobile, X no desktop |
| `Spinner.tsx` | `size`: sm \| md \| lg | `border-brand-500 border-t-transparent` |
| `Skeleton.tsx` | `variant`: text \| circle \| card | classe `skeleton-shimmer` |
| `Avatar.tsx` | `name`, `type: "human"\|"ai"`, `size`, `status`, `imageUrl` | tipo `ai` ganha badge `Bot`; `status` vira ponto colorido |
| `Checkbox.tsx` | `label`, `description`, `containerClassName` | input `sr-only` como peer; forwardRef |
| `ConfirmDialog.tsx` | `open`, `onClose`, `onConfirm`, `title`, `description`, `confirmLabel`, `cancelLabel`, `variant: "danger"\|"default"` | usa `Modal` + dois `Button` |
| `EmptyState.tsx` | `icon: React.ElementType`, `title`, `description`, `action: {label,onClick}` | ícone 48px `text-text-muted` |
| `CollapsibleSection.tsx` | `title`, `defaultOpen`, `filledCount`, `totalCount` | animação `grid-rows-[0fr]` → `[1fr]` |
| `Pagination.tsx` | `page`, `pageSize`, `total`, `hasMore`, `onPageChange` | "Exibindo N–M de T registros" |
| `Markdown.tsx` | `content`, `className` | memo; parse via `src/lib/markdown.ts` para AST tipada, nunca HTML cru |
| `FileDropZone.tsx` | ver §4 | |
| `FileUploadButton.tsx` | ver §2 | |
| `MentionTextarea.tsx` / `MentionRenderer.tsx` | compositor com `@` e renderizador | 256 / 58 linhas |
| `AttachmentPreview.tsx`, `AvatarUpload.tsx`, `ApiKeyRevealModal.tsx` | auxiliares | |

## O que NÃO existe

Não há primitivo de **Tabs, Select, Tooltip, Table, Popover ou Switch** em `ui/`.

- Tabs são pill rows feitas à mão: `Settings.tsx:78-91`, `DashboardOverview.tsx:364-385`, `ChannelsSection`.
- Selects são `<select>` nativo com string de classe repetida: `AiSection.tsx:2039` (`SELECT_CLS`), `TaskFiltersBar.tsx:60-61` (`selectClass`).
- Switch é local do `AiSection.tsx:38`.
- Popovers são `div absolute` + effect de clique fora, replicado em `LeadsBulkActionBar.tsx:51-67`, `SavedFiltersMenu`, `TaskFiltersBar`, `ViewSelector`.
- Toasts: `sonner` direto — `toast.success/error(msg)` ou `toast.promise(p, {loading, success, error})`.

## Tokens de cor e tema

`tailwind.config.js`, `darkMode: 'class'`:

```js
brand: { 50:'#FFF7ED', 100:'#FFEDD5', 200:'#FED7AA', 300:'#FDBA74', 400:'#FB923C',
         500:'#FF6B00', 600:'#EA580C', 700:'#C2410C', 800:'#9A3412', 900:'#7C2D12' },
surface: { base, raised, overlay, sunken }        // var(--surface-*)
border:  { DEFAULT, subtle, strong }              // var(--border-*)
text:    { primary, secondary, muted }            // var(--text-*)
semantic:{ success:'#22C55E', error:'#EF4444', warning:'#EAB308', info:'#3B82F6' }
borderRadius: { btn:'9999px', card:'12px', field:'8px' }
boxShadow: { card, 'card-hover', elevated, glow }
screens: { xs: '375px' }
fontFamily.sans: ['"Inter Variable"', 'Inter', ...]
```

Animações disponíveis: `fade-in`, `fade-in-up`, `slide-in-right`, `slide-in-up`, `shimmer`, `pulse-brand`, `scale-in`, `progress-fill`, `checkmark`, `slide-in-left`, `bounce-in`, `shake`.

`src/index.css:5-33` — dark é `:root`, light é `.light`:

```css
:root {
  --surface-base:#0F0F11; --surface-raised:#18181B; --surface-overlay:#1F1F23; --surface-sunken:#09090B;
  --border-default:#27272A; --border-subtle:#1E1E22; --border-strong:#3F3F46;
  --text-primary:#FAFAFA; --text-secondary:#A1A1AA; --text-muted:#71717A;
}
.light { --surface-base:#FAFAFA; --surface-raised:#FFFFFF; --surface-overlay:#FFFFFF; --surface-sunken:#F4F4F5;
  --border-default:#E4E4E7; --border-subtle:#F4F4F5; --border-strong:#D4D4D8;
  --text-primary:#18181B; --text-secondary:#52525B; --text-muted:#A1A1AA; }
```

Classes utilitárias em `index.css`: `.auth-input-field`, `.auth-button`, `.skeleton-shimmer`. `html { touch-action: manipulation }` para bloquear zoom de duplo toque.

## Classes recorrentes

- superfície: `bg-surface-raised border border-border rounded-card`
- texto: `text-text-primary` / `-secondary` / `-muted`
- números: `tabular-nums` sempre
- alvo de toque: `min-h-[44px]` ou `h-11 w-11`
- popover: `rounded-xl border border-border bg-surface-overlay shadow-elevated`
- z-index: `z-30` navegação, `z-40` barras flutuantes/FAB, `z-50` modais e slide-overs
- input mobile: `text-base md:text-sm` ou `style={{fontSize:"16px"}}` para evitar zoom no iOS

## `cn()`

`src/lib/utils.ts:4-6`:

```ts
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }
```

---

# 7. Hooks

## `usePermissions(organizationId)`

`src/hooks/usePermissions.ts:36-64`. Retorna `{ permissions, role, isLoading, can(category, level), mustChangePassword, member }`.

```ts
const member = useQuery(api.teamMembers.getCurrentTeamMember, organizationId ? { organizationId } : "skip");
const isLoading = member === undefined;
const permissions = member ? resolvePermissions(member.role as Role, member.permissions) : null;
const can = (category: PermissionCategory, requiredLevel: string): boolean => {
  if (!permissions) return false;
  return hasPermission(permissions, category, requiredLevel);
};
```

`resolvePermissions`/`hasPermission` vêm de `convex/lib/permissions` — a mesma fonte do backend. `can` devolve `false` enquanto carrega, então UI condicional pisca fechada antes de abrir.

## `PermissionGate`

`src/components/guards/PermissionGate.tsx:19-35`. Props `{organizationId, category, level, children, fallback?}`. Renderiza `null` durante o loading, `fallback` (default `null`) quando negado.

## Organização (outlet context)

Primeira linha de toda página de `/app/*`:

```ts
const { organizationId } = useOutletContext<AppOutletContext>();
```

Exemplos: `TasksPage.tsx:88`, `Settings.tsx:44`, `KanbanBoard.tsx`, `ContactsPage.tsx`.

## Toasts

Sem hook. `import { toast } from "sonner"`. Dois padrões:

```ts
toast.error("Falha ao enviar mensagem");
toast.promise(createLead({...}), { loading: "Criando...", success: "Criado!", error: "Falha" });
```

`<Toaster theme="dark" />` montado em `src/main.tsx:84`.

## Deep-links (`useSearchParams`)

Padrão canônico de sincronização abrir/fechar em `src/components/KanbanBoard.tsx:800-825`:

```tsx
const openLeadPanel = useCallback((leadId: Id<"leads">) => {
  setSelectedLeadId(leadId);
  setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set("lead", leadId);
    return next;
  }, { replace: true });
}, [setSearchParams]);

const closeLeadPanel = useCallback(() => {
  setSelectedLeadId(null);
  setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    next.delete("lead");
    return next;
  }, { replace: true });
}, [setSearchParams]);
```

Sempre clona `new URLSearchParams(prev)` (preserva outros params) e passa `{ replace: true }`. `TasksPage.tsx:193-205` repete a forma. `TasksPage` lê o id direto de `searchParams` em vez de espelhar em estado (`:94`) — variante mais limpa.

Quando o registro pode estar fora da lista carregada, monta-se um resolver dentro de `ErrorBoundary` com `key={param}`: `Inbox.tsx:1742-1749` (`ConversationDeepLinkResolver`, definido em `:87-100`) e `KanbanBoard.tsx:1564-1567`.

Deep-links existentes: `/app/pipeline?board=&lead=`, `/app/tarefas?task=`, `/app/entrada?conversation=`, `/app/repasses?handoff=`, `/app/configuracoes?secao=`.

## Outros hooks

- `src/hooks/useCopilotStream.ts` (194 linhas) — cliente SSE do chat do copiloto, loop de tool calls, `pendingActions`.
- `src/hooks/useInView.ts` (26 linhas) — IntersectionObserver.
- `useQuickReplies` (`src/components/inbox/QuickReplies.tsx:30`) — hook local do módulo: args `{organizationId, value, onApply, enabled}`, devolve `{open, items, activeIndex, pick, handleKeyDown, manageOpen, setManageOpen}`.

## Helper de erro

`src/lib/errors.ts:3-7`:

```ts
export function mutationErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback;
  const cleaned = error.message.replace(/^.*Uncaught Error: /, "").split("\n")[0].trim();
  return cleaned || fallback;
}
```

## Anti-padrões documentados (`src/CLAUDE.md`)

- nunca `Date.now()` direto em args de `useQuery` → `useState(() => Date.now())`
- nunca `new Set()` / `[]` / `{}` direto em `useState` → função inicializadora
- nunca `setState` no corpo do render
- nunca query Convex dentro de fallback de Suspense

---

# 8. Tabela, relatórios e gráficos

## Nenhuma biblioteca de gráficos

`package.json` dependencies, na íntegra: `@auth/core`, `@convex-dev/auth`, `@convex-dev/resend`, `@dnd-kit/core`, `@dnd-kit/modifiers`, `@dnd-kit/sortable`, `@dnd-kit/utilities`, `clsx`, `convex`, `convex-helpers`, `lucide-react`, `react`, `react-dom`, `react-helmet-async`, `react-router`, `sonner`, `tailwind-merge`.

Sem recharts, chart.js, d3, victory ou nivo. Grep confirma zero ocorrências em `src/`.

## Gráficos são barras em div, feitas à mão

Implementação de referência: `PipelineByBoardWidget` em `src/components/DashboardOverview.tsx:342-440`. Tabs de board como pills (`:364-385`), linha de resumo (`:388-399`), e por estágio (`:403-437`):

```tsx
const percentage = selectedBoard.totalValue > 0 ? (stage.totalValue / selectedBoard.totalValue) * 100 : 0;
// ...
<div className="w-full bg-surface-sunken rounded-full h-2">
  <div className="h-2 rounded-full transition-all duration-300"
       style={{ width: `${Math.max(percentage, 2)}%`, backgroundColor: stage.stageColor }} />
</div>
```

O piso `Math.max(percentage, 2)` mantém visível o estágio de valor zero. Cor vem do dado (`stage.stageColor`), via `style` inline — Tailwind não gera classes dinâmicas.

## Tiles de estatística

Dois padrões:

1. `StatCard` (`DashboardOverview.tsx:459-479`) numa `grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4` (`:82-107`), props `{icon, label, value, colorClass}`.
2. Grade de quatro tiles do `ChannelHealthPanel.tsx:68-85` (ver §4) — mais próximo de um relatório, com `sub` opcional e coloração condicional.

Outros cards do dashboard: `QuickActionCard` `:488`, `FeatureCard` `:510`, `ComingSoonCard` `:540` (com flag `available` que troca o badge "Em Breve" por estilo de novidade), `AiActivationBanner` `:443`, `MyTasksWidget` `:212`, `LoadingSkeleton` `:570`.

## Nenhum componente de tabela reutilizável

Toda tabela é markup `<table>` sob medida:

- `src/components/leads/LeadsListView.tsx`
- `src/components/ContactsPage.tsx`
- `src/components/AuditLogs.tsx`
- listas de job em `src/components/settings/DataSection.tsx` (exportações `:334-412`, importações `:415-555`)

`Pagination.tsx` é a única peça compartilhada, e é client-side apenas.

**Melhor modelo para uma tela de relatório de campanha:** `DataSection.tsx` — card de tiles de ação, histórico reativo por `useQuery`, metadados por status via `exportStatusMeta`, guarda de job único ativo, e tratamento de link de download com expiração.

Outros widgets do painel: `RecentActivityWidget.tsx`, `UpcomingEventsWidget.tsx`, `UpcomingTasksWidget.tsx`. Analytics de formulários (`src/components/forms/FormAnalyticsPage.tsx`) é outro precedente de tela de métricas.

---

# 9. Tarefas — módulo completo de referência

Estrutura de arquivos a replicar:

```
src/components/TasksPage.tsx            1293  página: estado, queries, list + board, bulk
src/components/CreateTaskModal.tsx            modal de criação
src/components/TaskDetailSlideOver.tsx        painel de detalhe (navegação empilhada)
src/components/tasks/
  ProjectSwitcher.tsx      304   seletor de projeto (exporta TaskProjectSummary)
  ProjectFormModal.tsx     187   criar/editar projeto
  ColumnsEditorModal.tsx   378   editor de colunas do kanban
  TaskKanbanBoard.tsx      760   board dnd-kit, ordem manual de cards
  TaskFiltersBar.tsx       367   filtros + exporta TaskFilters/EMPTY_TASK_FILTERS/countActiveFilters
  SavedFiltersMenu.tsx     268   filtros salvos (savedViews entityType "tasks")
  LabelPicker.tsx          254   multi-select com cor
  AssigneesPicker.tsx      148   multi-responsável (humano + IA)
  ReminderSelect.tsx        52   lembrete antecipado
  SubtasksSection.tsx      192   subtarefas + progresso
  DependenciesSection.tsx  176   dependências informativas
```

## Convenções da página (`TasksPage.tsx:87-205`)

```tsx
export function TasksPage() {
  const { organizationId } = useOutletContext<AppOutletContext>();
  const { can, role } = usePermissions(organizationId);
  const canEdit = can("tasks", "edit_own");
  const canManageProjects = role === "admin" || role === "manager";

  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTaskId = (searchParams.get("task") as Id<"tasks"> | null) ?? null;

  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [smartFilter, setSmartFilter] = useState<SmartFilter>("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<TaskFilters>(() => ({ ...EMPTY_TASK_FILTERS }));
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(() => new Set());

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timeout);
  }, [searchInput]);
```

Pontos a copiar:

1. `useOutletContext` para o org id, permissões derivadas logo em seguida (`:90-91`).
2. Id do deep-link lido direto de `searchParams`, sem espelhar em estado (`:94`).
3. Busca com debounce indo para um `search` separado, só ele entra na query (`:100-101`, `:128-134`).
4. Ticker de `now` via `useState(() => Date.now())` + `setInterval` (`:121-125`).
5. Filtros como um objeto único com constante `EMPTY_*` e inicializador de função.
6. Args da query montados em `useMemo` com spread condicional para nunca mandar `undefined` (`:158-175`):

```tsx
const taskQueryArgs = useMemo(() => ({
  organizationId,
  ...(projectFilterId ? { projectId: projectFilterId } : {}),
  ...(search ? { search } : {}),
  ...(filters.status ? { status: filters.status as TaskStatus } : {}),
  ...(filters.priority ? { priority: filters.priority as TaskPriority } : {}),
  ...(filters.assigneeId ? { assigneeId: filters.assigneeId as Id<"teamMembers"> } : {}),
  ...(filters.activityType ? { activityType: filters.activityType as ActivityType } : {}),
  ...(filters.labelIds.length > 0 ? { labelIds: filters.labelIds } : {}),
  ...(isProjectBoard ? { sortBy: "order", sortOrder: "asc" as const } : {}),
}), [organizationId, projectFilterId, search, filters, isProjectBoard]);

const tasks = useQuery(api.tasks.getTasks, taskQueryArgs) as TaskListItem[] | undefined;
```

7. Query de colunas com `"skip"` quando não há projeto (`:144-147`).
8. Sub-componentes de renderização no mesmo arquivo: `SmartPill` `:743`, `ListView` `:787`, `TaskGroup` `:848`, `TaskRow` `:892`, `StatusBoardView` `:1040`, `StatusColumn` `:1129`, `DraggableStatusCard` `:1173`, `StatusCard` `:1200`.

## Tipos exportados pelos filhos

Os sub-componentes definem e exportam os próprios tipos, e a página importa dos filhos em vez de um arquivo de tipos compartilhado.

`src/components/tasks/TaskFiltersBar.tsx:12-58`:

```ts
export interface TaskFilters {
  status: string; priority: string; assigneeId: string;
  activityType: string; labelIds: Id<"taskLabels">[]; projectId: string;
}
export const EMPTY_TASK_FILTERS: TaskFilters = { status:"", priority:"", assigneeId:"", activityType:"", labelIds:[], projectId:"" };
export function countActiveFilters(filters: TaskFilters): number { ... }

interface TaskFiltersBarProps {
  filters: TaskFilters;
  onChange: (filters: TaskFilters) => void;
  teamMembers: { _id: Id<"teamMembers">; name: string }[] | undefined;
  labels: TaskLabelOption[] | undefined;
  projects: TaskProjectSummary[] | undefined;
  showProjectFilter: boolean;
  trailing?: React.ReactNode;      // slot p/ o menu de filtros salvos
}
```

O padrão `trailing?: React.ReactNode` é como o `SavedFiltersMenu` entra na barra sem acoplamento.

`src/components/tasks/SavedFiltersMenu.tsx:15-44`:

```ts
export interface TaskSavedFilters {
  statuses?: ("pending"|"in_progress"|"completed"|"cancelled")[];
  priorities?: ("low"|"medium"|"high"|"urgent")[];
  taskType?: "task" | "reminder";
  activityType?: "todo"|"call"|"email"|"follow_up"|"meeting"|"research";
  projectId?: Id<"taskProjects">;
  labelIds?: Id<"taskLabels">[];
  assigneeIds?: Id<"teamMembers">[];
  dueFilter?: "overdue"|"today"|"week"|"month"|"none";
}
interface SavedFiltersMenuProps {
  organizationId: Id<"organizations">;
  currentFilters: TaskSavedFilters;
  onApply: (filters: TaskSavedFilters) => void;
}
```

Outro módulo completo e recente para comparar: `src/components/calendar/` (14 arquivos, com `useCalendarState.ts` e `constants.ts` separados) e `src/components/forms/` (builder + renderer em subpastas).

---

# 10. Landing e docs

## LandingPage

`src/components/LandingPage.tsx`, 890 linhas. A grade de funcionalidades é um array local em `:208-305` — 18 entradas de `{icon, title, description}` — renderizado em `:335` dentro de `<section id="funcionalidades" aria-labelledby="features-heading">` (`:307-316`).

Títulos atuais, na ordem: Pipeline Kanban, Gestão de Tarefas, Gestão de Contatos, Caixa de Entrada Unificada, Canal WhatsApp, Repasses IA ↔ Humano, IA Copiloto & Atendente, Equipe Humanos + IA, Auditoria Completa, API REST Completa, Campos Personalizados, Visões Salvas, Multi-tenancy, Dashboard Tempo Real, Calendário, Webhooks HMAC-SHA256, Formulários, Armazenamento de Arquivos, Servidor MCP.

Adicionar "Campanhas" à página de marketing é uma entrada nesse array.

**Atenção:** a entrada de WhatsApp em `:231-232` já promete templates:

```
description: "API oficial (Cloud API) ou bridge não-oficial — mensagens, voz, mídia e templates."
```

Outras seções, cada uma com o próprio array local:

| Seção | `id` | array | linhas |
|---|---|---|---|
| Funcionalidades | `funcionalidades` | `features` | 208-366 |
| Desenvolvedores | `developers` | `cards` (API REST, Servidor MCP, API Playground, Agent Skills, Código Aberto) | 368-490 |
| Em breve | `em-breve` | `comingSoon` (Motor de Automações, Paleta de Comandos, Scoring de Leads com IA, Fluxos Multi-Agente) | 491-578 |
| Como funciona | — | `steps` | 579-649 |
| Preços | `precos` | — | 650+ |
| CTA final | — | — | 844+ |

Componentes auxiliares: `src/components/landing/Footer.tsx`, `src/components/landing/OpenSourceSection.tsx`, `src/components/SocialIcons.tsx`.

## Superfícies in-app que também listam features

`src/components/DashboardOverview.tsx` tem duas grades que vão desalinhar se só a landing for atualizada:

- `FeatureCard` grid em `:172-176` (`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4`), props `{icon, title, description, dataBadge, onClick}` (`:501-510`).
- `ComingSoonCard` grid em `:185-191` (`grid ... xl:grid-cols-4`), props `{icon, title, description, available, onClick}` (`:531-540`) — a flag `available` troca o badge "Em Breve" por estilo de novidade, então um recurso recém-lançado pode migrar de grade sem sair da lista.

## Páginas públicas e SEO

- `src/pages/DevelopersPage.tsx` — portal do desenvolvedor em `/developers`
- `src/pages/PlaygroundPage.tsx` — playground REST em `/developers/playground` (registro de endpoints em `src/lib/apiRegistry.ts`)
- `src/pages/TermsPage.tsx` — menciona templates de mensagem em `:126`
- `src/pages/PrivacyPage.tsx` — política de privacidade (relevante para a cláusula LGPD de disparo em massa)
- `src/pages/PublicFormPage.tsx` — `/f/:formSlug`

Não há site de documentação dentro do repositório.

`src/components/SEO.tsx` é o componente de meta tags por página (react-helmet-async), usado assim:

```tsx
<SEO title="..." description="..." keywords="..." ogImage="/..." />
```

`src/components/StructuredData.tsx` cuida do JSON-LD.

---

# Anexo — inventário de arquivos por diretório

```
src/
  main.tsx  App.tsx(legado)  SignInForm.tsx  SignOutButton.tsx  index.css  vite-env.d.ts
  lib/       utils.ts routes.ts errors.ts markdown.ts(+test) mentions.ts auditUtils.ts
             apiRegistry.ts abTesting.ts celebrations.ts onboardingTemplates.ts utmPersistence.ts
  hooks/     usePermissions.ts useCopilotStream.ts useInView.ts
  embed/     loader.ts
  pages/     DevelopersPage PlaygroundPage PrivacyPage TermsPage PublicFormPage
  components/
    ui/            22 primitivos (ver §6)
    layout/        AuthLayout AppShell Sidebar BottomTabBar
    guards/        PermissionGate
    inbox/         17 arquivos (ver §2)
    settings/      AiSection ChannelsSection ChannelHealthPanel DataSection ImportWizard
    leads/         LeadsListView LeadsBulkActionBar
    tasks/         11 arquivos (ver §9)
    calendar/      14 arquivos
    forms/         builder/ (10) renderer/ (4) experiment/ (1) + 5 páginas
    handoffs/      HandoffPeekSlideOver
    notifications/ NotificationBell NotificationPanel NotificationPreferences
    copilot/       CopilotPanel
    team/          ChangePasswordScreen InviteMemberModal MemberDetailSlideOver PermissionsEditor
    onboarding/    9 arquivos
    developers/    7 arquivos
    landing/       Footer OpenSourceSection
    (raiz)         Dashboard(legado) DashboardOverview KanbanBoard Inbox ContactsPage TasksPage
                   TeamPage Settings AuditLogs HandoffQueue LandingPage AuthPage
                   LeadDetailPanel ContactDetailPanel TaskDetailSlideOver
                   CreateLeadModal CreateContactModal CreateTaskModal CreateViewModal
                   EditBoardModal DeleteBoardModal ManageStagesModal CloseReasonModal
                   ViewSelector CustomFieldsRenderer LeadDocuments ErrorBoundary
                   OrganizationSelector SEO StructuredData SocialIcons
                   RecentActivityWidget UpcomingEventsWidget UpcomingTasksWidget
```
