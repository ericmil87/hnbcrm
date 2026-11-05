# Inventário do sistema de temas / design tokens (HNBCRM)

Fonte: checkout limpo de HEAD (`$W` = `.../scratchpad/head`). Paths relativos a `$W`. Somente leitura. Contagens feitas com grep em `src/**/*.{ts,tsx}` excluindo `*.test.*` (salvo indicação).

## 1. CSS e Tailwind

### 1.1 `src/index.css` (126 linhas) — todas as variáveis

Só existem **10 variáveis** de cor (4 surface, 3 border, 3 text); tudo é hex literal (não há canais RGB).

| Variável | Dark (`:root`, l.6-19) | Light (`.light`, l.22-35) |
|---|---|---|
| `--surface-base` | `#0F0F11` | `#FAFAFA` |
| `--surface-raised` | `#18181B` | `#FFFFFF` |
| `--surface-overlay` | `#1F1F23` | `#FFFFFF` |
| `--surface-sunken` | `#09090B` | `#F4F4F5` |
| `--border-default` | `#27272A` | `#E4E4E7` |
| `--border-subtle` | `#1E1E22` | `#F4F4F5` |
| `--border-strong` | `#3F3F46` | `#D4D4D8` |
| `--text-primary` | `#FAFAFA` | `#18181B` |
| `--text-secondary` | `#A1A1AA` | `#52525B` |
| `--text-muted` | `#71717A` | `#A1A1AA` |


Outros blocos:
- l.38-40 `html { touch-action: manipulation }`.
- l.43-65 `body`: pilha de fonte (`"Inter Variable", Inter, ui-sans-serif, system-ui, ...`), `color: var(--text-primary)`, `background: var(--surface-base)`, font-smoothing.
- l.68-73 `.auth-input-field` e l.76-81 `.auth-button` (`@apply` com `border-border-strong`, `brand-500/600/700`, `ring-offset-surface-base`). Usadas só nas telas de auth.
- l.84-93 `.skeleton-shimmer`: gradiente `var(--surface-overlay)` -> **`rgba(255,255,255,0.04)`** (hardcoded branco; quase invisível no light) -> `var(--surface-overlay)`; animação `shimmer 1.5s`.
- l.96-112 scrollbar webkit (6px) com `var(--border-default)`/`--border-strong` (comentário diz "dark mode", mas já usa variáveis).
- l.115-117 `.pb-safe` (safe-area).
- l.120-126 `@media (prefers-reduced-motion: reduce)`: `animation-duration`/`transition-duration: 0.01ms !important`, `animation-iteration-count: 1`. Global, cobre `*`, `::before`, `::after`. Não trata `scroll-behavior`.

### 1.2 `tailwind.config.js` (135 linhas)

- `content`: `./index.html`, `./src/**/*.{js,ts,jsx,tsx}` (l.3-6). Plugins: nenhum (l.134).
- `darkMode: 'class'` (l.7), mas **só há 1 ocorrência de `dark:` em todo `src`** e é o nome de uma variante de `Button` (`src/components/ui/Button.tsx:8`), não um utilitário. Ou seja: o app não usa variantes `dark:`; a troca é 100% por variáveis.
- Cores (l.10-45):
  - `brand` 50-900: **hex fixos** (`500 #FF6B00`, `600 #EA580C`, `700 #C2410C`...). Não variam por tema.
  - `surface.{base,raised,overlay,sunken}`, `border.{DEFAULT,subtle,strong}`, `text.{primary,secondary,muted}`: `var(--...)`.
  - `semantic.{success #22C55E, error #EF4444, warning #EAB308, info #3B82F6}`: **hex fixos**.
- `fontFamily.sans`: `"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif` (l.46-48).
- `borderRadius`: `btn 9999px`, `card 12px`, `field 8px` (l.49-53).
- `boxShadow` (l.54-59): `card 0 1px 3px rgba(0,0,0,.3)`, `card-hover`, `elevated`, `glow rgba(255,107,0,.15)` — sombras pensadas para dark (preto 30-50%); fixas.
- `screens.xs: 375px`.
- `animation`/`keyframes` (l.63-131): `fade-in`, `fade-in-up`, `slide-in-right`, `slide-in-up`, `shimmer`, `pulse-brand`, `scale-in`, `progress-fill` (usa `--progress-width`), `checkmark`, `slide-in-left`, `bounce-in`, `shake`.

**Limitação confirmada empiricamente** (rodei o tailwindcss do repo sobre HTML de teste): como `surface/border/text` são `var(--x)` sem canal alfa, **o modificador de opacidade não gera CSS**. `bg-brand-500/15` gera `rgb(255 107 0 / 0.15)`, mas `bg-surface-sunken/50` **não gera nada** (no-op silencioso). Há **37 usos** assim em `src` (15 `bg-surface-sunken/50`, 6 `/60`, 5 `bg-surface-base/80`, 4 `bg-surface-overlay/50`, e mais 7 isolados). Trocar para variáveis com canais RGB (`rgb(var(--x) / <alpha-value>)`) ativaria esses 37 estilos de repente (mudança visual hoje inexistente).

## 2. Como o tema é alternado hoje

- **Não existe seletor de tema voltado ao usuário.** Nenhum hook, contexto ou componente.
- `index.html:2`: `<html lang="pt-BR" class="dark">` estático. A classe `dark` não tem nenhuma regra CSS (o dark é o `:root`); a classe `.light` **nunca é aplicada por nenhum código** (`grep classList|"light"|.light` só acha o próprio CSS e `WhatsAppPreview.tsx`). Sem script de pré-pintura, sem `prefers-color-scheme` em `src` (0 ocorrências), sem `<meta name="color-scheme">` nem `theme-color` (0).
- `localStorage` em `src` é usado para: org selecionada e orgs conhecidas (`components/layout/AuthLayout.tsx:47-115`), posição do FAB (`copilot/CopilotFab.tsx:28,46`), thread do copiloto (`hooks/useCopilotStream.ts`), último board (`KanbanBoard.tsx:796-804`), colunas de contatos (`ContactsPage.tsx:74-92`), filtros do inbox (`Inbox.tsx:157,223`), id de visitante A/B (`lib/abTesting.ts`), embed (`embed/loader.ts`). **Nenhum para tema.**
- `Settings.tsx`: seções `general|ai|apikeys|fields|sources|webhooks|channels|data|notifications|central` (l.29-33); `general` = `OrgProfileSection` (l.118), sem preferência de tema/aparência.
- **Schema Convex**: `convex/schema.ts` não tem campo `theme`/`appearance`/`colorScheme` em `users` (vem de `authTables`, l.3701), nem em `teamMembers` (l.724-756: org, userId, name, email, role, type, status, avatarFileId, capabilities, permissions, agentProfile, mustChangePassword, removedAt...). `notificationPreferences` (l.2298) é por `teamMemberId` (por org) com booleans de notificação (`invite`, `handoffRequested`, `handoffResolved`, `taskOverdue`, `taskAssigned`, `leadAssigned`, `newMessage`, `dailyDigest` + opcionais `taskCommentMention`, `taskDueSoon`, `aiDraftPending`, `campaignCompleted`...), nenhuma preferência visual. O único `theme` no schema é `forms.theme` (l.2420: `primaryColor`, `backgroundColor`, `textColor`, `borderRadius`, `showBranding`) — tema **do formulário público**, não do app.
- Outras âncoras de tema hardcoded: `src/main.tsx:90` `<Toaster theme="dark" />` (sonner fixo em dark). `STYLE_GUIDE.md` §8.3 (l.695-711) documenta "Light mode via classe `.light` no `<html>`" — promessa não implementada na UI.
- Container das rotas autenticadas: `main.tsx:59-83` (`/app` -> `AuthLayout`); o `body` herda o fundo do `:root`.

## 3. Cores cruas que furam os tokens

### 3.1 Literais hex/rgb/hsl em `src` (sem `index.css` e sem testes)

**249** ocorrências em ~25 arquivos. Top 15 (ocorrências):

| # | Arquivo | n | Categoria |
|---|---|---|---|
| 1 | `src/lib/onboardingTemplates.ts` | 65 | cores de etapas/boards dos templates (dado gravado no banco, `#3B82F6`, `#8B5CF6`...) |
| 2 | `src/components/KanbanBoard.tsx` | 22 | paleta de cor de etapa (l.433+: zinc/red/orange/yellow...) |
| 3 | `src/components/forms/renderer/FormField.tsx` | 15 | erro `#EF4444` + `rgba(var(--form-*-rgb))` (tema do form público) |
| 4 | `src/components/campaigns/WhatsAppPreview.tsx` | 14 | verdes/cinzas do WhatsApp (ver 4.3) |
| 5 | `src/components/tasks/LabelPicker.tsx` | 10 | paleta de labels (dado do usuário) |
| 6 | `src/components/tasks/ProjectFormModal.tsx` | 9 | paleta de cor de projeto |
| 7 | `src/lib/groupDisplay.ts` | 8 | cores de remetente em grupo (`#f97316`, `#22c55e`, `#38bdf8`, `#e879f9`...) |
| 8 | `src/embed/loader.ts` | 8 | CSS inline do widget embutido no site do cliente |
| 9 | `src/components/inbox/ConversationActionsMenu.tsx` | 8 | paleta de etiqueta de conversa |
| 10 | `src/components/onboarding/ConfettiCanvas.tsx` | 7 | confete (`#FF6B00`, `#FB923C`, `#FED7AA`, `#10B981`...) |
| 11 | `src/components/forms/renderer/FormRenderer.tsx` | 7 | defaults do tema do form público |
| 12 | `src/components/forms/FormAnalyticsPage.tsx` | 5 | sparkline `#EA580C`, `stroke="#18181B"` (= surface-raised dark fixo) |
| 13 | `src/components/SocialIcons.tsx` | 3 | cores de marca (LinkedIn/Instagram/Facebook) |
| 14 | `src/components/ManageStagesModal.tsx` | 3 | cor padrão `#3B82F6` |
| 15 | `src/components/forms/FormBuilderPage.tsx` | 3 | idem form |

Categorias: (a) **cores de dado do usuário** (etapas, labels, projetos, etiquetas) — escolhidas e gravadas, não devem mudar por tema; (b) tema do form público (isolado); (c) widget embed (isolado); (d) confete/SVG/ícones de marca; (e) WhatsApp (único bloco que deve virar token). Outros hex relevantes: `JsonHighlighter.tsx:38` `bg-[#0d1117]` (bloco de código GitHub-dark), `FormAnalyticsPage.tsx:152` stroke `#18181B`.
Valores arbitrários `[#hex]` em classes: **51 em 9 arquivos**. `style={{ background|color }}`: 87 ocorrências.

### 3.2 Classes de paleta Tailwind que ignoram tokens (prefixos bg/text/border/ring/from/to/via/fill/stroke...)

O app é majoritariamente token-based; as paletas cruas são poucas.

| Família | n | Onde |
|---|---|---|
| purple | **38** | `inbox/AiDraftCard.tsx` (13), `settings/AiSection.tsx` (9), `handoffs/HandoffPeekSlideOver.tsx` (4), `inbox/MessageBubble.tsx`, `inbox/FollowUpChip.tsx`, `LeadDetailPanel.tsx`, `TaskDetailSlideOver.tsx`, `ui/MentionTextarea.tsx`, `developers/JsonHighlighter.tsx` — identidade visual da **IA** |
| amber | 6 | `calendar/constants.ts`, `JsonHighlighter.tsx`, `hover:bg-amber-600` em `Inbox.tsx:2868` e `LeadDetailPanel.tsx:935` (nota interna) |
| emerald | 4 | `calendar/constants.ts` (demo), `JsonHighlighter.tsx` |
| red | 2 | `ui/Button.tsx:9` (`hover:bg-red-600 active:bg-red-700`) |
| rose | 3 | `calendar/constants.ts` (reminder) |
| blue | 3 | `calendar/constants.ts` (call) |
| zinc | 3 | `calendar/constants.ts` (other) |
| gray | 3 | `JsonHighlighter.tsx`, `RequestBuilder.tsx` |
| sky / indigo / teal / cyan | 1 cada | `JsonHighlighter.tsx`; `LeadDetailPanel.tsx:2177-2183` (timeline) |
| green, orange, yellow, slate, neutral, stone, lime, pink, violet, fuchsia | 0 | — |
| `white` (`bg|text|border-white`, c/ alfa) | 208 | 201 `bg-white|text-white` em 71 arquivos (quase todos `text-white` sobre `bg-brand-600`/`bg-semantic-*`/bolhas); 30 `bg-white/N` |
| `black` | 22 | 22 `bg-black/N|text-black` em 14 arquivos (overlays de modal, `bg-black/15` em chips dentro da bolha) |

Top arquivos para `bg-white` literal: `inbox/AudioPlayer.tsx` (5), `settings/ChannelsSection.tsx` (4), `inbox/SpecialMessageCard.tsx` (4), `inbox/MetaSpecialCard.tsx` (4), `team/InviteMemberModal.tsx` (3).

Tokens semânticos/brand em texto (usam hex fixos, pensados para fundo escuro): `text-brand-300|400` **272**, `text-brand-500` 237, `text-semantic-warning` 116, `text-semantic-error` 177, `text-semantic-success` 57, `text-semantic-info` 8. Sobre fundo branco esses tons têm contraste insuficiente (ex.: `#EAB308` sobre `#FFF` ~1,9:1; `brand-400 #FB923C` ~2,3:1) — são o principal risco de um tema claro.

## 4. Visuais do Inbox

### 4.1 `src/components/inbox/MessageBubble.tsx` (704 linhas)

`getBubbleStyle` (l.~100-150) define 4 variantes:

| Tipo | `bg` | `rounded` | Rótulo / cor | Rodapé |
|---|---|---|---|---|
| Nota interna (`isInternal`) | `bg-surface-overlay border border-dashed border-semantic-warning/30 text-text-primary` | `rounded-lg rounded-br-none`, alinha à direita | "Nota Interna" `text-semantic-warning` | `text-text-muted` |
| Entrada (contato) | `bg-surface-raised text-text-primary` | `rounded-lg rounded-bl-none`, esquerda | "Contato" `text-text-secondary` | `text-text-muted` |
| Saída IA | `bg-purple-600/80 text-white` | `rounded-lg rounded-br-none`, direita | "Agente IA" `text-purple-300` | `text-white/75` |
| Saída equipe | `bg-brand-600 text-white` | idem | "Equipe" `text-brand-200` | `text-white/75` |

- Container da bolha: `px-3 py-2 flex flex-col gap-1.5` (l.505-510); largura `max-w-xs lg:max-w-md`; destaque ao saltar de citação `ring-2 ring-brand-500 ring-offset-surface-base`; falha `ring-1 ring-semantic-error/60`.
- Dentro de bolha de saída, textos auxiliares usam `text-white/70|80|90` e chips `bg-white/15`, `bg-black/15` (l.550,558,589-668) — acoplados a "fundo escuro saturado". `variant: inbound|outbound` já existe e decide essas cores.
- Horário: `text-[10px] tabular-nums` (l.433) no rodapé `flex items-center justify-end gap-1 mt-1` (l.410).
- Recibos (`DeliveryTick`, l.~170-190): falha `AlertCircle text-semantic-error`; lida `CheckCheck text-brand-400`; entregue `CheckCheck text-current opacity-70`; enviada `Check text-current opacity-70`. (Na bolha laranja, "lida" em `brand-400` tem pouco contraste sobre `brand-600`.)
- Erro de entrega `text-semantic-error` 10px; aviso `text-semantic-warning` 11px; reações `text-text-muted`; autor de grupo: avatar `text-white` + nome com `style={{ color: groupSender.color }}` (cores de `lib/groupDisplay.ts`).
- Menu de ações: botão `h-7 w-7 rounded-full text-text-muted hover:bg-surface-raised focus:ring-brand-500`.
- Cards de rascunho IA (`AiDraftCard.tsx`) e `FollowUpChip`: roxo.
- Evento de sistema (transferência): `inbox/central/CentralChips.tsx:121-138` `TransferEvent` — pílula centralizada `rounded-2xl border border-border bg-surface-raised/70` (o `/70` é **no-op**, ver 1.2), ícone `text-brand-500`, textos `text-text-secondary|primary|muted`. Não há separador de dia nem "mensagem de sistema" tipo WhatsApp.

### 4.2 `src/components/Inbox.tsx` (3103 linhas)

- Lista de conversas (l.1957+): contêiner `overflow-y-auto flex-1`; item `p-4 border-b border-border`, hover `bg-surface-overlay`, não lida `bg-brand-500/5`, selecionada `bg-brand-500/10 border-l-2 border-l-brand-500` (l.2050-2058); badge de não lidas `bg-brand-600 text-white text-[10px]` (l.2223). Filtros ativos: `bg-brand-500/15 border-brand-500 text-brand-500` (l.1785-1909); busca `bg-surface-sunken border-border-strong rounded-full` (l.1759); destaque de busca `bg-brand-500/30` (l.1576). Barra de seleção em massa `border-t border-border bg-surface-raised` (l.2264).
- Painel da conversa (l.2318): `flex-1 flex flex-col bg-surface-base`. **Área de mensagens** (l.2599-2604): `flex-1 min-h-0 overflow-y-auto` com filho `max-w-4xl mx-auto w-full p-4 space-y-4` — **sem fundo/wallpaper próprio** (herda `surface-base`). Ponto natural para um wallpaper: o `div` de `ref={messagesScrollRef}` (l.2599).
- Cabeçalho mobile: `border-b border-border bg-surface-raised` (l.2326); "carregar anteriores" = `Button ghost`; "Exibindo as últimas N" = `bg-surface-overlay rounded-full`.
- Composer (l.2689): `<form className="shrink-0 border-t border-border bg-surface-raised">`; textarea `bg-surface-sunken` com `border-border-strong focus:border-brand-500 focus:ring-brand-500/20` (nota interna: `border-semantic-warning/30 focus:border-semantic-warning`); resposta citada `border-l-2 border-brand-500 bg-surface-sunken` (l.2704); botão Enviar `Button primary` (brand-600), em nota interna `bg-semantic-warning hover:bg-amber-600 text-white` (l.2868); janela fechada `bg-surface-raised text-center` (l.2892).

**Tokens específicos de tema que seriam necessários** (hoje inexistentes): `--bubble-in-bg/fg`, `--bubble-out-bg/fg` (equipe), `--bubble-ai-bg/fg`, `--bubble-note-*`, `--bubble-meta` (timestamp/rodapé dentro da bolha), `--tick-read` (azul do WhatsApp `#53BDEB` vs brand), `--chat-bg` (cor) + `--chat-wallpaper` (imagem/padrão), `--accent` (substitui `brand-*` onde for a cor de ação), `--header-bg` do painel da conversa, `--sidebar-selected`, `--badge-unread`. Hoje `brand-600` faz de "bolha de saída", "botão primário" e "badge de não lidas" ao mesmo tempo.

### 4.3 `src/components/campaigns/WhatsAppPreview.tsx` — já imita o WhatsApp

Usa a classe `.light` via variante arbitrária `[.light_&]:` (l.69-81) — única parte do app que "espera" `.light`.

| Elemento | Dark | Light | Linha |
|---|---|---|---|
| Bolha de saída | `#005c4b` texto `#e9edef` | `#d9fdd3` texto `#111b21` | 72 |
| Texto auxiliar da bolha | `#e9edef`/60 | `#111b21`/55 | 73 |
| Fundo do chat | `#0b141a` | `#efeae2` | 75 |
| Cabeçalho | `#1f2c34` / `#e9edef` | `#008069` / branco | 76 |
| Tique "lido" | `#53bdeb` (sobre `#005c4b`) | `#027eb5` (sobre `#d9fdd3`) | 78-79 |
| Chip/data (cinza) | `#182229` / `#8696a0` | `white/80` / `#54656f` | 81 |
| Barra do composer | `#1f2c34` | `#f0f2f5` | 368 |
| Campo de texto | `#2a3942` | branco | 369 |
| Botão enviar | `#00a884` | `#00a884` | 372 |
| Moldura do celular | `#111` (borda 6px) | idem | 319 |

Esses são exatamente os valores canônicos do WhatsApp (dark e light) e servem de **fonte de verdade da paleta** do tema WhatsApp.

## 5. Brand, semânticos, foco, gráficos

- **brand-\***: 1546 ocorrências em 185 arquivos. Top: `pages/DevelopersPage.tsx` (83), `settings/AiSection.tsx` (50), `Inbox.tsx` (35), `LandingPage.tsx` (29), `LeadDetailPanel.tsx` (28), `KanbanBoard.tsx` (26), `settings/ChannelsSection.tsx` (20), `forms/FormExperimentPage.tsx` (20). Valores fixos em `tailwind.config.js`. Botão primário = `brand-600` (AA com branco, STYLE_GUIDE l.45/113).
- **semantic-\***: 670 em 124 arquivos (hex fixos).
- **Tokens de superfície/borda/texto**: `surface-*` 1174 (191 arquivos), `border`/`border-subtle|strong` 946 (177), `text-text-*` **3146** (204). Portanto trocar as 10 variáveis alcança praticamente a UI toda.
- **Foco**: `focus:ring`/`focus-visible:ring` 810 em 116 arquivos, quase sempre `ring-brand-500` (+ `ring-offset-surface-base`). Se o accent mudar, o anel deve acompanhar.
- **Sombras** `shadow-card|card-hover|elevated|glow`: 55 usos em 36 arquivos, valores fixos de dark.
- **Gráficos**: **sem biblioteca** (não há recharts/d3/chart.js em `package.json`). SVG próprio em `components/central/charts.tsx` (usa `var(--text-muted)`, `var(--border-default)`, `stroke: var(--surface-raised)` — **já tema-aware**, l.14-17,257) e sparkline em `forms/FormAnalyticsPage.tsx:123-152` (`#EA580C` + `stroke="#18181B"` fixos, **não** tema-aware). Calendário: `calendar/constants.ts:14-20` usa `bg-<cor>-500/20 text-<cor>-400` (pensado para dark). Ícones: `lucide-react`; toasts: `sonner` (tema fixo dark).

## 6. Superfícies públicas / embed (não podem ser afetadas)

Isolamento **inexistente por mecanismo**; hoje só "não há seletor". Todas usam os mesmos tokens do app:

| Superfície | Arquivos | Uso de tokens |
|---|---|---|
| Landing (`/`) | `LandingPage.tsx` (47 usos de `surface-/text-text-/border-border`), `landing/Footer.tsx` (10), `landing/OpenSourceSection.tsx` (6) | `bg-surface-base`, brand etc. Seria afetada. |
| Auth (`/entrar`) | `AuthPage.tsx` (5), `auth/ForgotPasswordForm.tsx` (7); `.auth-input-field`/`.auth-button` em `index.css` | `bg-gradient-to-b from-surface-overlay to-surface-base`. Seria afetada. |
| Developers / Playground | `pages/DevelopersPage.tsx` (185), `PlaygroundPage` | Seria afetada; blocos de código com `#0d1117` fixo. |
| Termos / Privacidade | `pages/TermsPage.tsx` (17) | Seria afetada. |
| Form público `/f/:slug` | `pages/PublicFormPage.tsx`: wrapper `min-h-screen bg-surface-base` (l.315,340; no modo embed sem fundo); `forms/renderer/FormRenderer.tsx` injeta `--form-primary|bg|text|radius` por `style` (l.388-396); `FormField.tsx` usa `rgba(var(--form-text-rgb...))`. Builder: `forms/builder/ThemePanel.tsx` + `forms.theme` no schema. | O **miolo** do form é isolado (variáveis `--form-*` por formulário); o **wrapper/fundo e mensagens de erro** usam `surface-base`/`text-text-*`, então seriam afetados. |
| Widget embed (site do cliente) | `src/embed/loader.ts`: CSS em string, classes `hnbcrm-*`, `#fff`, `rgba()`, `#6366f1`; roda no DOM do cliente, fora do bundle de tokens. | Totalmente isolado. |

Rotas do app: `/` e `/entrar` etc. são irmãs de `/app` no mesmo `createBrowserRouter` (`main.tsx:51-84`); o tema, se aplicado em `<html>`, vaza para todas. Aplicar o tema só em um wrapper de `AuthLayout` (`/app/*`) isolaria as públicas, mas portais (Modal/SlideOver/Toaster) renderizados em `document.body` ficariam **fora** do wrapper.

## 7. Fontes

- "Inter" **não é carregada em lugar nenhum**: sem `@fontsource`, sem `@font-face`, sem `<link>` de fonte em `index.html`, sem dependência em `package.json`. A pilha `"Inter Variable", Inter, ui-sans-serif, system-ui...` cai na fonte do sistema salvo se o usuário tiver Inter instalada.
- `components/SEO.tsx:52-53` emite `preconnect`/`dns-prefetch` para `fonts.googleapis.com` (sem nenhum uso real).
- CSP (`vercel.json`, hoje **Report-Only**): `font-src 'self' data:`; `style-src 'self' 'unsafe-inline'`; `script-src 'self'` (sem inline). Google Fonts seria bloqueado se a CSP virar enforce; fonte self-hosted (`/assets`) passa. Duas políticas: rotas normais (l.25-33) com `X-Frame-Options: DENY` e `frame-ancestors 'none'`; `/f/*` (l.34-42) sem esses dois (embed em iframe permitido).

## 8. Acessibilidade

- `STYLE_GUIDE.md` (829 linhas): §1.2 "Conformidade de Contraste" (l.107-113) lista só pares **dark**: `#FAFAFA/#0F0F11` 18,1:1; `#A1A1AA/#0F0F11` 7,2:1; `#71717A/#0F0F11` 4,6:1 (AA); `brand-600 #EA580C` com branco 4,6:1. §a11y (l.604-607): AA 4,5:1 texto, 3:1 elementos grandes; `#EA580C` sobre `#FFF` 4,6:1. **Não há tabela de pares para light.**
- No light atual, `--text-muted #A1A1AA` sobre `#FAFAFA` dá ~2,4:1 (falha AA), e `--border-subtle #F4F4F5` sobre `#FAFAFA` é praticamente invisível.
- `prefers-reduced-motion`: tratado globalmente em `index.css:120-126` (STYLE_GUIDE l.595 prescreve). Não há `prefers-contrast` nem `forced-colors`.
- Alvos de toque 44px e `focus-visible` com anel brand são regra do projeto (CLAUDE.md); 810 usos de anel de foco.

## Restrições para um sistema de temas

- Só 10 variáveis dirigem a UI toda (surface 4, border 3, text 3); `text-text-*` aparece 3146 vezes, então trocar variáveis cobre quase tudo sem tocar componentes.
- Não existe seletor, persistência nem campo no schema (`users`, `teamMembers`, `notificationPreferences` não têm preferência visual); `.light` e `dark` em `<html>` são letra morta, e `Toaster theme="dark"` está fixo (`main.tsx:90`).
- `brand-*` (1546 usos) e `semantic-*` (670) são hex fixos, não variáveis; um accent verde exige transformá-los em variáveis (ou novos tokens `--accent-*`) sem quebrar `bg-brand-500/15` (hoje funciona porque são hex).
- Tokens `surface/border/text` são `var(--x)` sem canal alfa: 37 usos de `bg-surface-*/NN` são no-op hoje; mudar para canais RGB os "liga" e altera o visual do dark.
- Bolha de saída de equipe = `brand-600`, mesma cor do botão primário e do badge de não lidas; IA = `purple-600/80`; contato = `surface-raised`. Para bolhas verdes WhatsApp são necessários tokens próprios de bolha, wallpaper e tique (hoje inexistentes).
- A área de mensagens (`Inbox.tsx:2599`) não tem fundo próprio; wallpaper cabe nesse `div` (e o composer/cabeçalho estão em `surface-raised`).
- Texto auxiliar dentro das bolhas de saída é `text-white/NN` e `bg-white/15|black/15`, assumindo fundo escuro saturado; uma bolha clara (`#d9fdd3`) exige trocar essas classes por tokens (`variant: outbound` já existe em `getBubbleStyle`).
- A paleta canônica do WhatsApp (dark e light) já está codificada em `campaigns/WhatsAppPreview.tsx:69-81,368-372`, usando `[.light_&]:` — o único consumidor de `.light`.
- No light, `text-brand-300|400` (272 usos), `text-semantic-warning` (116) e `text-semantic-success` (57) têm contraste baixo sobre branco; `--text-muted` light (`#A1A1AA`) falha AA. Cores de dado (etapas, labels, projetos, calendário, remetentes de grupo) são hex gravados e não devem mudar por tema.
- Landing, Auth, Developers, Termos e o wrapper do form público usam os mesmos tokens e vazariam o tema se a classe for aplicada em `<html>`; só o widget `embed/loader.ts` (CSS próprio) e o miolo `--form-*` do form são naturalmente isolados. Portais/Toaster ficam fora de um wrapper em `/app`.
- Sem `color-scheme` nem pré-pintura: a classe está estática em `index.html` e a CSP (`script-src 'self'`, hoje Report-Only) impede script inline; um script anti-flash teria de ser arquivo externo. Inter não é carregada e a CSP só permite `font-src 'self' data:`.
