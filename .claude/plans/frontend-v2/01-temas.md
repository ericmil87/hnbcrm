> Seção do plano Frontend v2 (trilho **T**). Redigida por agente Opus em 04/11/2026 a partir de `inventarios/temas.md`. **Onde contradizer `00-PLANO-MESTRE.md` (seção 5, decisões I2, I5, I9), vale o plano mestre.** Numeração dos ramos: tabela do plano mestre (T1 = fv2-08, T2 = fv2-10, T3 = fv2-12, T4 = fv2-14, T5 = fv2-15, T6 = fv2-30, T7 = fv2-32).

# Plano — Sistema de temas (Escuro, Claro, Estilo WhatsApp)

Fonte: checkout limpo de HEAD (`scratchpad/head`, v0.78.1). Paths relativos à raiz do repo. Fatos e contagens vêm do inventário `scratchpad/inv-theme.md` e de greps conferidos por mim. Contrastes calculados com a fórmula WCAG 2.1 (luminância relativa), não estimados.

## 0. Resumo executivo

- O usuário escolhe entre **3 temas**: **Escuro** (o atual, idêntico), **Claro** (corrigido para AA) e **Estilo WhatsApp** (base clara, acento verde, área de conversa com papel de parede bege e bolhas verdes).
- A troca é feita por **variáveis CSS em canais RGB** sob `[data-theme]` no `<html>`. Os 3146 usos de `text-text-*`, 1546 de `brand-*` e 670 de `semantic-*` continuam com o mesmo nome de classe.
- `brand-*`, `semantic-*` e um novo `ai-*` (substitui o roxo cru) viram variáveis. No tema WhatsApp o `brand-*` vira verde; o logo continua laranja.
- O Inbox ganha tokens próprios de chat (fundo, papel de parede, bolhas, tique de lido, link, composer, badge de não lidas).
- Preferência salva em `localStorage` (aplicação antes da primeira pintura por um script externo de 10 linhas, compatível com a CSP) e em `teamMembers.uiTheme` no Convex (segue o usuário entre aparelhos e orgs).
- Superfícies públicas (landing, login, developers, termos, privacidade, formulário público) ficam sempre no Escuro.
- Três testes de guarda: contraste AA por tema calculado a partir do `index.css`, catraca contra novas cores cruas de paleta, e ausência do legado `.light`.
- Entrega em **6 PRs** pequenos, cada um verificável sem deployment Convex.

**Achado que muda premissas:** o `STYLE_GUIDE.md` (§1.2) afirma que o Escuro atual passa AA, mas não passa em dois pares centrais. O plano mantém o Escuro idêntico (pedido do dono) e registra a dívida no teste como exceção explícita.

| Par no Escuro atual | STYLE_GUIDE diz | Medido |
|---|---|---|
| `text-muted #71717A` sobre `surface-base #0F0F11` | 4,6:1 | **3,96:1** (falha AA texto) |
| `text-muted` sobre `surface-raised #18181B` | — | **3,67:1** |
| `text-muted` sobre `surface-overlay #1F1F23` | — | **3,40:1** |
| branco sobre `brand-600 #EA580C` (botão primário, bolha da equipe) | 4,6:1 | **3,56:1** (passa só como texto grande/UI) |
| rótulo "Equipe" `brand-200` sobre bolha `brand-600` | — | **2,63:1** |
| tique "lida" `brand-400` sobre bolha `brand-600` | — | **1,57:1** (quase invisível) |
| rótulo "Agente IA" `purple-300` sobre bolha IA | — | **4,06:1** |

Correção do Escuro fica proposta como PR opcional fora deste plano (seção 9).

---

## 1. Decisões de arquitetura

| # | Decisão | Por quê (uma linha) |
|---|---|---|
| D1 | Variáveis de cor viram **canais RGB** (`--rgb-surface-base: 15 15 17`) e o Tailwind usa `rgb(var(--rgb-x) / <alpha-value>)`. | Faz `/NN` funcionar em todo token (hoje é no-op silencioso em surface/border/text). |
| D2 | Mantém **aliases de cor completa** (`--surface-base: rgb(var(--rgb-surface-base))`) para CSS cru e `style={{}}`. | `charts.tsx`, `MarketingTab.tsx`, scrollbar, skeleton e `body` usam `var(--surface-*)`/`var(--text-muted)` e não podem quebrar. |
| D3 | Os **37 usos no-op** de `X/NN` em surface/border/text são **removidos** no PR 1, com lista no corpo do PR. | Hoje não geram CSS; removê-los mantém o Escuro idêntico quando o alfa passar a funcionar. |
| D4 | `brand-50..900`, `semantic-*` e novo `ai-300..700` viram variáveis por tema; nomes de classe não mudam (exceto `purple-N` → `ai-N`). | Um acento por tema sem tocar 1546 + 670 usos. |
| D5 | Nos temas claros, os degraus usados como **texto** (`brand-300/400/500`, `ai-300/400`) recebem tons escuros. | 260 `text-brand-400` e 237 `text-brand-500` falham AA sobre branco com os hex atuais. |
| D6 | Tokens de chat dedicados (`chat-*`, `bubble-*`, `tick-read`, `badge-unread`, `composer*`). | Hoje `brand-600` é ao mesmo tempo botão, bolha e badge; o WhatsApp precisa separá-los. |
| D7 | Tema aplicado por **`data-theme` no `<html>`**; Escuro = `:root` sem atributo. | Portais (`Modal`, `SlideOver`, `Toaster`) renderizam em `body` e herdam; aliases de D2 resolvem no mesmo elemento. |
| D8 | Pré-pintura por **script externo** `public/theme-init.js`, síncrono no `<head>`. | CSP tem `script-src 'self'` sem inline; arquivo próprio passa sem nonce. |
| D9 | Persistência: `localStorage` (`hnbcrm:theme`) + **campo opcional `teamMembers.uiTheme`**, gravado em todas as associações ativas do mesmo `userId`. | Respeita o invariante "toda tabela tem `organizationId`" e segue o usuário entre orgs e aparelhos. |
| D10 | Padrão para quem nunca escolheu: **Escuro**. | Zero mudança para a base atual; o seletor é opt-in. |
| D11 | Superfícies públicas ficam no Escuro porque o atributo só é aplicado sob `/app` (script e hook checam a rota). | Isola sem tocar nas páginas públicas. |
| D12 | **Estilo WhatsApp com base clara**, sem sub-opção escura. | É o visual que corretores e PMEs veem no celular e no WhatsApp Web por padrão; o Escuro já cobre quem quer fundo escuro. |
| D13 | Rótulo na UI: **"Estilo WhatsApp"**; identificador `whatsapp`. | Deixa claro que é inspiração visual, sem sugerir produto oficial da Meta. |
| D14 | Variante Tailwind `light-theme:` (`:is([data-theme="light"],[data-theme="whatsapp"]) &`) para os poucos casos que precisam de par claro/escuro. | Substitui o `[.light_&]:` do `WhatsAppPreview` e resolve calendário e timeline sem criar token por cor. |
| D15 | Fonte: **self-host Inter** com `@fontsource-variable/inter` (PR 6, independente). | Inter está documentada e nunca foi carregada; CSP `font-src 'self'` permite; `unicode-range` baixa só o subset usado. |
| D16 | Sombras (`shadow-card`, `-hover`, `elevated`, `glow`) e o brilho do skeleton viram variáveis por tema. | Sombras de 30–50% de preto pesam demais em fundo claro. |

### 1.1 Gotcha de CSS que justifica D7

Uma custom property que referencia outra (`--surface-base: rgb(var(--rgb-surface-base))`) é resolvida **no elemento onde foi declarada**. Como os aliases ficam em `:root` e o `[data-theme]` também fica no `<html>`, os dois estão no mesmo elemento e o alias acompanha o tema. Se o tema fosse aplicado num wrapper interno, os aliases herdados do `<html>` continuariam no Escuro. Por isso o atributo vai no `<html>` e não no `AppShell`. Essa regra entra em `.claude/rules/frontend.md`.

### 1.2 Isolamento das superfícies públicas

| Superfície | Rota | Como fica no Escuro |
|---|---|---|
| Landing, Developers, Playground, Login, Termos, Privacidade | `/`, `/developers*`, `/entrar`, `/termos`, `/privacidade` | Nunca recebem `data-theme`: o script só aplica se `location.pathname` começa com `/app`, e o hook só roda dentro de `AuthLayout`. |
| Formulário público | `/f/:slug` | Idem. O miolo continua com as variáveis `--form-*` do formulário. |
| Widget embed | site do cliente | Já isolado (CSS próprio em `src/embed/loader.ts`), não é afetado. |
| Navegação SPA de `/app` para `/` | cliente | O cleanup do hook remove o atributo ao desmontar `AuthLayout`. |

---

## 2. Arquitetura de tokens

### 2.1 Variáveis (todas definidas em `src/index.css`)

Canais RGB (`R G B`, separados por espaço) com prefixo `--rgb-`:

| Grupo | Variáveis | Classe Tailwind resultante |
|---|---|---|
| Superfície | `--rgb-surface-{base,raised,overlay,sunken}` | `bg-surface-*` (inalterada) |
| Borda | `--rgb-border-{default,subtle,strong}` | `border-border`, `border-border-*` |
| Texto | `--rgb-text-{primary,secondary,muted}` | `text-text-*` (3146 usos, inalterada) |
| Marca | `--rgb-brand-{50..900}` | `brand-*` |
| Semântica | `--rgb-semantic-{success,error,warning,info}` | `semantic-*` |
| IA (novo) | `--rgb-ai-{300,400,500,600,700}` | `ai-*` (substitui `purple-*`) |
| Chat (novo) | `--rgb-chat-bg`, `--rgb-chat-header`, `--rgb-composer`, `--rgb-composer-field` | `bg-chat-bg`, `bg-chat-header`, `bg-composer`, `bg-composer-field` |
| Bolhas (novo) | `--rgb-bubble-in`, `--rgb-bubble-in-link`, `--rgb-bubble-out`, `--rgb-bubble-out-fg`, `--rgb-bubble-out-label`, `--rgb-bubble-out-link`, `--rgb-bubble-ai`, `--rgb-bubble-ai-label`, `--rgb-bubble-note`, `--rgb-bubble-note-label`, `--rgb-bubble-note-border`, `--rgb-bubble-system`, `--rgb-bubble-system-fg` | `bg-bubble-*`, `text-bubble-*`, `border-bubble-*` |
| Recibos e ação (novo) | `--rgb-tick-read`, `--rgb-chat-send`, `--rgb-badge-unread`, `--rgb-badge-unread-fg` | `text-tick-read`, `bg-chat-send`, `bg-badge-unread`, `text-badge-unread-fg` |

Variáveis de valor completo (não-cor ou alias):

| Variável | Uso |
|---|---|
| `--surface-*`, `--border-default/subtle/strong`, `--text-*` | Aliases `rgb(var(--rgb-*))` para CSS cru (D2). |
| `--color-semantic-{success,error,warning,info}` | Alias. **Corrige bug existente:** `FormSubmissionsPage.tsx:1079-1194` usa `var(--color-semantic-*)`, que hoje não existe. |
| `--chat-wallpaper` | `background-image` do papel de parede (`none` no Escuro e no Claro). |
| `--shadow-card`, `--shadow-card-hover`, `--shadow-elevated`, `--shadow-glow`, `--shadow-bubble` | Sombras por tema; `tailwind.config.js` aponta `boxShadow.*` para elas. |
| `--shimmer-highlight` | Faixa do `.skeleton-shimmer` (hoje `rgba(255,255,255,0.04)` fixo). |

Regras de uso das bolhas:

- O texto da bolha de entrada continua `text-text-primary` (em todos os temas é a mesma cor), então não há `bubble-in-fg`.
- **Bolha de saída da equipe e da IA usam o mesmo `bubble-out-fg`**. Os ~69 `text-white/NN`, `bg-white/NN` e `border-white/NN` nos ramos `variant === "outbound"` dos 10 componentes de `src/components/inbox/` viram `text-bubble-out-fg/NN` etc. No Escuro e no Claro o valor é branco (idêntico); no WhatsApp é `#111B21`. O teste de tokens garante `bubble-out-fg` legível sobre `bubble-out` e `bubble-ai`.
- `bg-black/15` dentro da bolha (chips, bloco de código) fica como está: funciona sobre fundo escuro e claro.

### 2.2 `tailwind.config.js` (forma alvo)

```js
const c = (name) => `rgb(var(--rgb-${name}) / <alpha-value>)`;
const scale = (name, steps) => Object.fromEntries(steps.map((s) => [s, c(`${name}-${s}`)]));

colors: {
  brand: scale("brand", [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
  ai: scale("ai", [300, 400, 500, 600, 700]),
  surface: { base: c("surface-base"), raised: c("surface-raised"), overlay: c("surface-overlay"), sunken: c("surface-sunken") },
  border: { DEFAULT: c("border-default"), subtle: c("border-subtle"), strong: c("border-strong") },
  text: { primary: c("text-primary"), secondary: c("text-secondary"), muted: c("text-muted") },
  semantic: { success: c("semantic-success"), error: c("semantic-error"), warning: c("semantic-warning"), info: c("semantic-info") },
  chat: { bg: c("chat-bg"), header: c("chat-header"), send: c("chat-send") },
  composer: { DEFAULT: c("composer"), field: c("composer-field") },
  bubble: { in: c("bubble-in"), "in-link": c("bubble-in-link"), out: c("bubble-out"), "out-fg": c("bubble-out-fg"), /* … */ },
  tick: { read: c("tick-read") },
  badge: { unread: c("badge-unread"), "unread-fg": c("badge-unread-fg") },
},
boxShadow: { card: "var(--shadow-card)", "card-hover": "var(--shadow-card-hover)", elevated: "var(--shadow-elevated)", glow: "var(--shadow-glow)", bubble: "var(--shadow-bubble)" },
```

- Remover `darkMode: 'class'` (não há utilitário `dark:` em `src`; o único "dark" é nome de variante do `Button`).
- Adicionar o plugin inline da variante `light-theme:` (D14) via `plugin(({ addVariant }) => addVariant("light-theme", ':is([data-theme="light"],[data-theme="whatsapp"]) &'))`.
- Tailwind é `~3` (suporta `<alpha-value>` desde 3.3).

---

## 3. Paletas

### 3.1 Base (superfície, borda, texto)

| Token | Escuro (= hoje) | Claro | Estilo WhatsApp |
|---|---|---|---|
| `surface-base` | `#0F0F11` | `#FAFAFA` | `#F0F2F5` |
| `surface-raised` | `#18181B` | `#FFFFFF` | `#FFFFFF` |
| `surface-overlay` | `#1F1F23` | `#FFFFFF` | `#FFFFFF` |
| `surface-sunken` | `#09090B` | `#F4F4F5` | `#E9EDEF` |
| `border-default` | `#27272A` | `#E4E4E7` | `#D1D7DB` |
| `border-subtle` | `#1E1E22` | `#EBEBED` (era `#F4F4F5`, invisível) | `#E9EDEF` |
| `border-strong` | `#3F3F46` | `#D4D4D8` | `#AEBAC1` |
| `text-primary` | `#FAFAFA` | `#18181B` | `#111B21` |
| `text-secondary` | `#A1A1AA` | `#52525B` | `#3B4A54` |
| `text-muted` | `#71717A` | `#6B6B74` (era `#A1A1AA`, 2,46:1) | `#54656F` |

Contrastes medidos dos temas novos (mínimo exigido 4,5):

| Par | Claro | WhatsApp |
|---|---|---|
| primary / base | 16,97 | 15,57 |
| secondary / sunken | 7,03 | 7,77 |
| muted / base | 5,05 | 5,40 |
| muted / raised | 5,28 | 6,06 |
| muted / sunken | 4,80 | 5,14 |

### 3.2 Marca

No Claro e no WhatsApp, 300/400/500 são tons de texto (AA sobre `raised`, `base` e `sunken`); 50–200 são tintas; 600 é o botão primário (AA com branco).

| Token | Escuro (= hoje) | Claro | Estilo WhatsApp |
|---|---|---|---|
| `brand-50` | `#FFF7ED` | `#FFF7ED` | `#E7FCE3` |
| `brand-100` | `#FFEDD5` | `#FFEDD5` | `#D9FDD3` |
| `brand-200` | `#FED7AA` | `#FED7AA` | `#B9F0D8` |
| `brand-300` | `#FDBA74` | `#9A3412` | `#015C4B` |
| `brand-400` | `#FB923C` | `#C2410C` | `#017561` |
| `brand-500` | `#FF6B00` | `#C2410C` | `#017561` |
| `brand-600` | `#EA580C` | `#AD3A0B` | `#008069` |
| `brand-700` | `#C2410C` | `#9A3412` | `#016B57` |
| `brand-800` | `#9A3412` | `#7C2D12` | `#015C4B` |
| `brand-900` | `#7C2D12` | `#6C2710` | `#0A3D33` |

| Par | Claro | WhatsApp |
|---|---|---|
| `brand-500` (texto) / raised | 5,18 | 5,65 |
| `brand-500` / base | 4,96 | 5,04 |
| `brand-500` / sunken | 4,71 | 4,79 |
| branco / `brand-600` (botão) | 6,20 | 4,89 |

No WhatsApp, `brand-600` (`#008069`, verde do cabeçalho do WhatsApp) é mais claro que `brand-500` (`#017561`). É intencional: 500 é texto/anel e precisa de AA sobre `#F0F2F5`; 600 é o verde icônico com AA para texto branco.

### 3.3 Semânticas

| Token | Escuro (= hoje) | Claro | Estilo WhatsApp |
|---|---|---|---|
| `semantic-success` | `#22C55E` | `#15803D` | `#166534` |
| `semantic-error` | `#EF4444` | `#B91C1C` | `#B91C1C` |
| `semantic-warning` | `#EAB308` | `#8A5A00` | `#8A5A00` |
| `semantic-info` | `#3B82F6` | `#1D4ED8` | `#1D4ED8` |

Todos ≥ 4,5 sobre `base`, `raised` e `sunken` dos temas claros, e ≥ 5,0 com texto branco por cima (botão "Enviar nota" usa `bg-semantic-warning text-white`). `success` no WhatsApp é mais escuro que o acento para não se confundir com ele.

### 3.4 IA (`ai-*`, substitui `purple-*`)

| Token | Escuro (= Tailwind purple) | Claro | Estilo WhatsApp |
|---|---|---|---|
| `ai-300` | `#D8B4FE` | `#6B21A8` | `#6B21A8` |
| `ai-400` | `#C084FC` | `#7E22CE` | `#7E22CE` |
| `ai-500` | `#A855F7` | `#9333EA` | `#9333EA` |
| `ai-600` | `#9333EA` | `#7E22CE` | `#7E22CE` |
| `ai-700` | `#7E22CE` | `#6B21A8` | `#6B21A8` |

`text-ai-400` sobre `sunken`: Claro 6,35; WhatsApp 6,23. A migração é mecânica (`purple-N` → `ai-N`), 38 usos em 9 arquivos.

### 3.5 Chat e bolhas

Fonte canônica do WhatsApp: `src/components/campaigns/WhatsAppPreview.tsx:69-81,368-372` (fundo `#efeae2`, bolha `#d9fdd3`, texto `#111b21`, tique `#027eb5`, composer `#f0f2f5`, enviar `#00a884`).

| Token | Escuro (= hoje) | Claro | Estilo WhatsApp |
|---|---|---|---|
| `chat-bg` | `#0F0F11` (= base) | `#F4F4F5` | `#EFEAE2` |
| `--chat-wallpaper` | `none` | `none` | padrão de pontos (ver abaixo) |
| `chat-header` | `#18181B` (= raised) | `#FFFFFF` | `#F0F2F5` |
| `composer` | `#18181B` | `#FFFFFF` | `#F0F2F5` |
| `composer-field` | `#09090B` (= sunken) | `#F4F4F5` | `#FFFFFF` |
| `bubble-in` | `#18181B` | `#FFFFFF` | `#FFFFFF` |
| `bubble-in-link` | `#FB923C` (= brand-400) | `#C2410C` | `#0565A0` |
| `bubble-out` (equipe) | `#EA580C` | `#C2410C` | `#D9FDD3` |
| `bubble-out-fg` (equipe e IA) | `#FFFFFF` | `#FFFFFF` | `#111B21` |
| `bubble-out-label` ("Equipe") | `#FED7AA` | `#FFEDD5` | `#017561` |
| `bubble-out-link` | `#FFFFFF` | `#FFFFFF` | `#0565A0` |
| `bubble-ai` | `#792CBF` (*) | `#7E22CE` | `#E8DEF8` |
| `bubble-ai-label` ("Agente IA") | `#D8B4FE` | `#F3E8FF` | `#6B21A8` |
| `bubble-note` (nota interna) | `#1F1F23` (= overlay) | `#FFFBEB` | `#FFF3C4` |
| `bubble-note-label` | `#EAB308` | `#7A4F01` | `#7A4F01` |
| `bubble-note-border` (usado `/30`, tracejado) | `#EAB308` | `#B45309` | `#B45309` |
| `bubble-system` (pílula "Exibindo as últimas N") | `#1F1F23` | `#FFFFFF` | `#FFFFFF` |
| `bubble-system-fg` | `#71717A` (= muted) | `#52525B` | `#54656F` |
| `tick-read` | `#FB923C` (= brand-400) | `#BAE6FD` | `#027EB5` |
| `chat-send` (botão enviar do composer) | `#EA580C` (= brand-600) | `#AD3A0B` | `#00A884` |
| `badge-unread` / `-fg` | `#EA580C` / `#FFFFFF` | `#AD3A0B` / `#FFFFFF` | `#25D366` / `#111B21` |
| `--shadow-bubble` | `none` | `0 1px 0.5px rgba(11,20,26,.13)` | `0 1px 0.5px rgba(11,20,26,.13)` |

(*) Hoje a bolha da IA é `bg-purple-600/80` sobre `#0F0F11`. `#792CBF` é a composição exata (diferença ≤ 1 nível por canal), o que permite uma cor sólida por tema sem alfa.

Papel de parede do WhatsApp (sem imagem, sem nova origem na CSP), copiado do padrão de `WhatsAppPreview.tsx:345-351`:

```css
[data-theme="whatsapp"] {
  --chat-wallpaper:
    radial-gradient(rgb(84 101 111 / .10) 0.6px, transparent 0.6px),
    radial-gradient(rgb(84 101 111 / .10) 0.6px, transparent 0.6px);
}
.chat-wallpaper { background-image: var(--chat-wallpaper); background-size: 18px 18px; background-position: 0 0, 9px 9px; }
```

Contrastes medidos das bolhas (texto ≥ 4,5; ícone de tique ≥ 3,0):

| Par | Claro | WhatsApp |
|---|---|---|
| `bubble-out-fg` / `bubble-out` | 5,18 | 15,75 |
| `bubble-out-fg` / `bubble-ai` | 6,98 | 13,50 |
| `bubble-out-fg` a 75% (rodapé, hora) / `bubble-out` | ≥ 4,5 (cálculo com alfa no teste) | ≈ 7 |
| `bubble-out-label` / `bubble-out` | 4,52 | 5,09 |
| `bubble-ai-label` / `bubble-ai` | 5,92 | 6,74 |
| `bubble-in-link` / `bubble-in` | 5,18 | 6,22 |
| `bubble-out-link` / `bubble-out` | 5,18 | 5,61 |
| `bubble-note-label` / `bubble-note` | 6,87 | 6,40 (aprox.) |
| `tick-read` / `bubble-out` | 3,90 | 4,07 |
| `tick-read` / `bubble-ai` | 5,26 | 3,49 |
| `badge-unread-fg` / `badge-unread` | 6,20 | 8,80 |
| `bubble-system-fg` / `bubble-system` | 7,73 | 6,06 |
| branco / `chat-send` (ícone) | 6,20 | 3,03 |

### 3.6 Sombras e skeleton

| Variável | Escuro (= hoje) | Claro e WhatsApp |
|---|---|---|
| `--shadow-card` | `0 1px 3px rgba(0,0,0,.3)` | `0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.10)` |
| `--shadow-card-hover` | `0 4px 12px rgba(0,0,0,.4)` | `0 4px 12px rgba(16,24,40,.12)` |
| `--shadow-elevated` | `0 8px 24px rgba(0,0,0,.5)` | `0 8px 24px rgba(16,24,40,.16)` |
| `--shadow-glow` | `0 0 20px rgba(255,107,0,.15)` | `0 0 20px rgb(var(--rgb-brand-500) / .15)` |
| `--shimmer-highlight` | `rgba(255,255,255,0.04)` | `rgba(0,0,0,0.04)` |

---

## 4. Aplicação, persistência e sincronização

### 4.1 Peças

| Peça | Arquivo | Conteúdo |
|---|---|---|
| Constantes compartilhadas | `convex/lib/uiTheme.ts` (novo) | `export const UI_THEMES = ["dark", "light", "whatsapp"] as const`, `type UiTheme`, `uiThemeValidator = v.union(v.literal("dark"), v.literal("light"), v.literal("whatsapp"))`, `isUiTheme(x)`. Frontend importa daqui (regra "shared rules from `convex/lib`"). |
| Schema | `convex/schema.ts`, tabela `teamMembers` | `uiTheme: v.optional(uiThemeValidator)` (aditivo; DEV e PROD aceitam os mesmos documentos). |
| Mutation | `convex/teamMembers.ts` (módulo existente) | `setMyUiTheme({ organizationId, theme })`, `returns: v.null()`. Chama `requireAuth`; recusa membro sem `userId`; lê `teamMembers.by_user` e faz `patch({ uiTheme })` em cada associação com `type === "human"` e `!isMembershipRevoked(m)`. Sem `activities`, `auditLogs` nem webhook, seguindo o precedente de `notificationPreferences.ts` (preferência pessoal, não evento de negócio). |
| Leitura | `getCurrentTeamMember` (já existe, `returns: v.any()`) | O campo chega ao cliente sem nova query. |
| Lógica pura | `src/lib/theme.ts` (novo) + `src/lib/theme.test.ts` | `THEME_STORAGE_KEY = "hnbcrm:theme"`, `isAppPath(pathname)`, `resolveTheme({ server, local })` (server definido vence; senão local válido; senão `"dark"`), `shouldPushLocalToServer({ server, local })`, `toasterTheme(theme)` (`"dark"` ou `"light"`), `THEME_COLOR` por tema para `<meta name="theme-color">`. |
| Aplicação no DOM | `src/lib/themeDom.ts` (novo) | `applyTheme(theme)`: `dark` remove o atributo; os outros fazem `setAttribute("data-theme", t)`; atualiza `<meta name="theme-color">`; notifica assinantes (`subscribe`/`getAppliedTheme` para `useSyncExternalStore`). `clearTheme()` remove tudo. |
| Hook | `src/hooks/useUiTheme.ts` (novo) | Usado em `AuthLayout`. Lê `currentMember?.uiTheme` e `localStorage`; aplica `resolveTheme`; empurra o valor local ao servidor uma vez quando `shouldPushLocalToServer`; expõe `{ theme, setTheme }`; cleanup chama `clearTheme()`. `setTheme` aplica na hora, grava `localStorage` (em `try/catch`) e chama a mutation com `toast.error` na falha. |
| Pré-pintura | `public/theme-init.js` (novo) + `index.html` | Script síncrono no `<head>`, antes do CSS. |
| Toaster | `src/components/ui/ThemedToaster.tsx` (novo) + `src/main.tsx` | `<Toaster theme={toasterTheme(useSyncExternalStore(subscribe, getAppliedTheme))} />` no lugar de `theme="dark"`. |

### 4.2 Script de pré-pintura

```js
// public/theme-init.js — servido de 'self' (CSP script-src 'self'), sem módulo.
(function () {
  try {
    var t = localStorage.getItem("hnbcrm:theme");
    if ((t === "light" || t === "whatsapp") && location.pathname.indexOf("/app") === 0) {
      document.documentElement.setAttribute("data-theme", t);
    }
  } catch (e) {}
})();
```

```html
<html lang="pt-BR">
  <head>
    <meta charset="UTF-8" />
    <meta name="theme-color" content="#0F0F11" />
    <script src="/theme-init.js"></script>
    …
```

- Remove `class="dark"` do `<html>` (classe sem nenhuma regra CSS).
- O Vite mantém `<script>` sem `type="module"` como está e copia `public/` para a raiz do build. O critério de aceite confere que `dist/theme-init.js` existe e que `dist/index.html` o referencia.
- Se outro aparelho mudou o tema, o primeiro frame usa o valor local e o servidor corrige em seguida. É aceitável: só acontece na primeira abertura depois da troca.

### 4.3 Fluxo de sincronização

| Situação | Resultado |
|---|---|
| Servidor tem `uiTheme` | Aplica o do servidor e regrava `localStorage`. |
| Servidor vazio, `localStorage` com `light`/`whatsapp` | Aplica o local e envia ao servidor uma vez (migra a escolha do aparelho). |
| Os dois vazios | Escuro, sem escrita. |
| Usuário troca o tema | Aplica na hora, grava local, chama `setMyUiTheme` (todas as orgs do usuário). |
| Troca de org | `currentMember` muda, mas o valor é o mesmo porque a mutation grava em todas as associações. Uma associação criada depois herda no primeiro `setTheme` ou na migração local. |
| Membro removido | `getCurrentTeamMember` não o retorna; nada muda. |

---

## 5. Seletor (UI, PT-BR)

| Lugar | Forma | Quem vê |
|---|---|---|
| Sidebar desktop, rodapé, acima de "Sair" | Botão `Palette` "Aparência" (44 px, `aria-label="Aparência"`) que abre `ThemePickerModal` | Todos os membros humanos |
| "Mais" no mobile (`BottomTabBar.tsx`, bloco "Conta") | Linha "Aparência" com o nome do tema atual; abre o mesmo modal (bottom sheet pelo `Modal`) | Todos |
| Configurações › Geral | Card "Aparência" no topo, acima do perfil da org, com os 3 cards inline | Quem tem `settings:view` |

Configurações não basta sozinha porque exige `settings:view` (`Sidebar.tsx:55`) e agentes podem não ter.

Componente `src/components/settings/AppearancePicker.tsx` (reusado no modal e no card):

- `role="radiogroup"` com 3 cards `role="radio"` e `aria-checked`, navegação por setas, cada card ≥ 44 px de altura.
- Cada card tem uma **miniatura estática** (div com cores fixas do tema, sem depender do tema ativo): faixa de sidebar, 2 linhas de lista, uma bolha de entrada e uma de saída.
- O card selecionado usa `ring-2 ring-brand-500` e um ícone `Check`.

| Elemento | Texto |
|---|---|
| Título do card/modal | Aparência |
| Subtítulo | Escolha as cores do seu painel. A preferência vale só para você e acompanha sua conta em qualquer aparelho. |
| Opção 1 | **Escuro** — Padrão do HNBCRM. Confortável para longas jornadas. |
| Opção 2 | **Claro** — Fundo branco, ideal para ambientes iluminados. |
| Opção 3 | **Estilo WhatsApp** — Cores e conversas com a cara do WhatsApp. |
| Toast de erro | Não foi possível salvar sua preferência de tema. Ela vale só neste aparelho por enquanto. |
| Linha no "Mais" | Aparência · {nome do tema} |

---

## 6. Migração de cores cruas

| Categoria | Onde | Ação |
|---|---|---|
| IA roxa (38) | `inbox/AiDraftCard.tsx`, `settings/AiSection.tsx`, `handoffs/HandoffPeekSlideOver.tsx`, `inbox/MessageBubble.tsx`, `inbox/FollowUpChip.tsx`, `LeadDetailPanel.tsx`, `TaskDetailSlideOver.tsx`, `ui/MentionTextarea.tsx` | `purple-N` → `ai-N` (mecânico). **Exceção:** `developers/JsonHighlighter.tsx` fica (bloco sempre escuro `#0d1117`). |
| Bolhas e itens dentro da bolha de saída (~69) | `MessageBubble`, `FormattedMessageText`, `QuotedBlock`, `ImageDescription`, `VoiceTranscription`, `MessageAttachments`, `AudioPlayer`, `MetaSpecialCard`, `SpecialMessageCard`, `DeferredMedia` | Nos ramos `outbound`: `text-white[/N]` → `text-bubble-out-fg[/N]`, `bg-white/N` → `bg-bubble-out-fg/N`, `border-white/N` → `border-bubble-out-fg/N`. Links: `text-brand-400 hover:text-brand-500` → `text-bubble-in-link hover:opacity-80`; outbound `text-white` → `text-bubble-out-link`. |
| Recibo "lida" | `MessageBubble.tsx:181` | `text-brand-400` → `text-tick-read`. |
| Área de conversa | `Inbox.tsx:2599` (div `messagesScrollRef`) | Adiciona `bg-chat-bg chat-wallpaper`. |
| Cabeçalho mobile da conversa | `Inbox.tsx:2326` | `bg-surface-raised` → `bg-chat-header`. |
| Composer | `Inbox.tsx:2689` e textarea | `bg-surface-raised` → `bg-composer`; textarea `bg-surface-sunken` → `bg-composer-field`. |
| Pílula "Exibindo as últimas N" | `Inbox.tsx:2632` | `bg-surface-overlay text-text-muted` → `bg-bubble-system text-bubble-system-fg`. |
| Badge de não lidas (lista) | `Inbox.tsx:~2223` | `bg-brand-600 text-white` → `bg-badge-unread text-badge-unread-fg`. |
| Âmbar no hover da nota | `Inbox.tsx:2868`, `LeadDetailPanel.tsx:935` | `hover:bg-amber-600` → `hover:bg-semantic-warning/90`. |
| Calendário | `calendar/constants.ts:14-20` | Mantém `bg-X-500/20 text-X-400` e acrescenta `light-theme:text-X-700`. |
| Timeline do lead | `LeadDetailPanel.tsx:2177-2183` (sky/indigo/teal/cyan) | Mesmo padrão `light-theme:text-X-700`. |
| Sparkline | `forms/FormAnalyticsPage.tsx:123-152` | `#EA580C` → `rgb(var(--rgb-brand-600))`; `stroke="#18181B"` → `var(--surface-raised)`. |
| Skeleton | `index.css` `.skeleton-shimmer` | `rgba(255,255,255,0.04)` → `var(--shimmer-highlight)`. |
| `bg-white/N` sobre superfície (30 usos) | lista do grep | Se o pai for superfície do app, troca por `bg-text-primary/N` (no Escuro `#FAFAFA` a ≤ 15% difere < 1 nível do branco). Se o pai for `bg-brand-*`, `bg-semantic-*`, bolha de saída ou `bg-black`, mantém. |
| `WhatsAppPreview` | `campaigns/WhatsAppPreview.tsx:69-81,368-372` | Mantém as cores canônicas; troca `[.light_&]:` por `light-theme:`. |

Ficam como estão (cores de dado ou isoladas): cores de etapa, label, projeto e etiqueta escolhidas pelo usuário (`KanbanBoard`, `LabelPicker`, `ProjectFormModal`, `ConversationActionsMenu`, `ManageStagesModal`, `onboardingTemplates`); cores de remetente de grupo (`lib/groupDisplay.ts`); tema do formulário público (`forms/renderer/*`, `forms/builder/ThemePanel.tsx`); widget `embed/loader.ts`; `SocialIcons`, `ConfettiCanvas`, `JsonHighlighter`, `RequestBuilder`; `ui/Button.tsx` danger (`hover:bg-red-600 active:bg-red-700` com texto branco funciona em todos os temas).

---

## 7. Guardas automatizadas

Todos os testes de leitura de arquivo usam `// @vitest-environment node` na primeira linha e `readFileSync` (mesmo padrão de `convex/secretScan.test.ts`; o ambiente padrão do vitest é `edge-runtime`, sem `fs`). Ficam em `src/lib/` com sufixo `.test.ts` (o `include` do vitest é `src/**/*.test.ts`).

### 7.1 `src/lib/themeTokens.test.ts` (PR 1, ampliado no PR 2)

Parser simples por regex do `src/index.css`:

1. Extrai blocos `:root { … }` e `[data-theme="light"] { … }` / `[data-theme="whatsapp"] { … }`.
2. Lê cada `--rgb-*: R G B;` em mapa `{ theme → { token → [r,g,b] } }`. Claro e WhatsApp herdam de `:root` e sobrescrevem.

Asserções:

| Teste | O que garante |
|---|---|
| **Escuro congelado** | Cada token herdado (surface, border, text, brand, semantic, ai, chat, bubble) tem exatamente o hex da tabela das seções 3.1–3.5, coluna Escuro. É a prova automática de "Escuro idêntico". |
| **Cobertura completa** | O conjunto de chaves `--rgb-*` em cada `[data-theme]` é igual ao de `:root` (nenhum tema claro herda cor escura por esquecimento). |
| **Formato** | Todo `--rgb-*` tem 3 inteiros 0–255 separados por espaço. |
| **Contraste AA** | Para cada tema, uma lista de pares `[fg, bg, mínimo, alfa?]` (seção 7.2). Com alfa, compõe `fg` sobre `bg` antes de medir. |
| **Bolhas compartilham fg** | `bubble-out-fg` passa ≥ 4,5 sobre `bubble-out` **e** `bubble-ai` em cada tema. |
| **Exceções do Escuro** | Lista `DARK_KNOWN_FAILURES` com os pares da tabela do resumo e o valor medido; o teste falha se um par da lista passar a cumprir AA (avisa para tirar da lista) ou se um par novo falhar. |

### 7.2 Pares checados por tema

| fg | bg | mínimo |
|---|---|---|
| `text-primary`, `text-secondary`, `text-muted` | `surface-base`, `surface-raised`, `surface-overlay`, `surface-sunken` | 4,5 |
| `brand-300`, `brand-400`, `brand-500` | `surface-base`, `surface-raised`, `surface-sunken` | 4,5 (só Claro e WhatsApp) |
| branco | `brand-600`, `semantic-success`, `semantic-error`, `semantic-warning`, `semantic-info` | 4,5 |
| `semantic-*` | `surface-base`, `surface-raised`, `surface-sunken` | 4,5 (só Claro e WhatsApp) |
| `ai-300`, `ai-400` | `surface-raised`, `surface-sunken` | 4,5 |
| `text-primary` | `bubble-in`, `bubble-note`, `chat-bg` | 4,5 |
| `bubble-out-fg` | `bubble-out`, `bubble-ai` | 4,5 |
| `bubble-out-fg` a 0,75 | `bubble-out`, `bubble-ai` | 4,5 |
| `bubble-out-label` / `bubble-ai-label` / `bubble-note-label` | respectivas bolhas | 4,5 |
| `bubble-in-link` / `bubble-out-link` | `bubble-in` / `bubble-out` | 4,5 |
| `tick-read` | `bubble-out`, `bubble-ai` | 3,0 |
| `badge-unread-fg` | `badge-unread` | 4,5 |
| `bubble-system-fg` | `bubble-system` | 4,5 |
| branco | `chat-send` | 3,0 (ícone) |
| `ring` = `brand-500` | `surface-base` | 3,0 (foco) |

### 7.3 `src/lib/rawColorsGuard.test.ts` (PR 3)

Catraca contra classes de paleta crua do Tailwind e `[#hex]` arbitrário.

- Varre `src/**/*.{ts,tsx}` exceto `*.test.*`.
- Regex de paleta: `\b(?:[a-z-]+:)*(?:bg|text|border|ring|from|to|via|fill|stroke|outline|divide|accent|caret|decoration|shadow|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b`.
- Regex arbitrária: `-\[#[0-9a-fA-F]{3,8}\]`.
- `ALLOWLIST: Record<string, number>` com o máximo por arquivo depois da migração (ex.: `components/calendar/constants.ts`, `developers/JsonHighlighter.tsx`, `developers/RequestBuilder.tsx`, `ui/Button.tsx`, `campaigns/WhatsAppPreview.tsx`, `LeadDetailPanel.tsx` (timeline), mais os arquivos de cor de dado com `[#hex]`).
- Falha se um arquivo fora da lista tiver ocorrência, ou se um arquivo da lista passar do teto. A mensagem diz em PT-BR qual token usar.
- Teste extra: `purple-` não aparece em nenhum arquivo fora de `JsonHighlighter.tsx`.

### 7.4 `src/lib/themeLegacy.test.ts` (PR 2)

- `src/index.css` não contém o seletor `.light`.
- Nenhum arquivo em `src` contém `[.light_&]`.
- `index.html` não contém `class="dark"` (a partir do PR 4).
- `tailwind.config.js` não contém `darkMode`.

### 7.5 Backend `convex/uiTheme.test.ts` (PR 4, convex-test)

- Grava o tema e `getCurrentTeamMember` devolve o valor.
- Usuário com associação em 2 orgs: as duas recebem o valor.
- Associação removida (`removedAt`) **não** é alterada.
- Membro IA da mesma org não é alterado.
- Associação de **outro usuário** na mesma org não é alterada (multi-tenant).
- Sem autenticação: lança erro.
- Org da qual o usuário não é membro: lança erro (`requireAuth`).
- Literal inválido é rejeitado pelo validador.

---

## 8. Entrega em PRs

Regras comuns a todos os PRs:

- Branch própria a partir de `main`, PR para `main`, sem linha de coautoria de IA.
- Verificação em todo PR: `npx tsc -p convex`, `npx tsc -p tsconfig.app.json`, `npx tsc -p tsconfig.node.json`, `npx vitest run`, `npx vite build`. Nenhum PR roda `npx convex dev` ou `deploy`.
- Diff de até ~600 linhas (sem contar o lockfile).
- O PR descreve no corpo o que mudou visualmente e em qual tema.

### PR 1 — Tokens em canais RGB, Escuro idêntico

| Campo | Conteúdo |
|---|---|
| Objetivo | Trocar a infraestrutura de tokens sem mudar um pixel do Escuro e sem expor seletor. |
| Tamanho | **M** (~350 linhas) |
| Arquivos | `src/index.css`, `tailwind.config.js`, `src/lib/themeTokens.test.ts` (novo), 19 arquivos com no-op de alfa (abaixo), `.claude/rules/frontend.md` |

Arquivos com os 37 no-ops (contagem): `pages/DevelopersPage.tsx` 15, `ui/Markdown.tsx` 4, `ui/AttachmentPreview.tsx` 3, `UpcomingTasksWidget.tsx` 2, `LandingPage.tsx` 2, `inbox/MetaSpecialCard.tsx` 2, `inbox/central/CentralChips.tsx` 2, e 1 em `pages/TermsPage.tsx`, `pages/PrivacyPage.tsx`, `team/MemberDetailSlideOver.tsx`, `layout/AppShell.tsx`, `landing/OpenSourceSection.tsx`, `inbox/SpecialMessageCard.tsx`, `inbox/QuotedBlock.tsx`, `inbox/MessageBubble.tsx`, `inbox/MessageAttachments.tsx`, `inbox/central/ConversationRoutingBar.tsx`, `forms/FormExperimentPage.tsx`, `CampaignsPage.tsx`.

Passos:

1. **Antes de tudo**, rodar o grep abaixo e salvar a saída no corpo do PR (lista de remoções).
   ```bash
   grep -rnoE '\b[a-z:-]*(bg|text|border|ring|from|to|via|divide|ring-offset)-(surface-(base|raised|overlay|sunken)|text-(primary|secondary|muted)|border(-subtle|-strong)?)/[0-9]+' src --include=*.ts --include=*.tsx | grep -v '\.test\.'
   ```
2. Remover cada classe listada (a classe inteira, incluindo prefixo de variante como `hover:` ou `even:`). Não substituir por outra.
3. Reescrever `src/index.css`: `:root` com todos os `--rgb-*` do Escuro (base, brand, semantic, ai, chat, bubble, tick, badge) e aliases de D2 (`--surface-*`, `--border-*`, `--text-*`, `--color-semantic-*`), sombras e `--shimmer-highlight`. Manter temporariamente o bloco `.light` convertido para `--rgb-*` (removido no PR 2). `body`, scrollbar e `.skeleton-shimmer` passam a usar os aliases e `--shimmer-highlight`. Adicionar a classe utilitária `.chat-wallpaper`.
4. Reescrever `tailwind.config.js` conforme seção 2.2 (sem a variante `light-theme:` ainda; `darkMode` continua até o PR 2).
5. Criar `themeTokens.test.ts` com os testes "Escuro congelado", "Formato" e as exceções do Escuro.
6. Em `.claude/rules/frontend.md`, seção "Design tokens": tokens são canais RGB com alfa funcionando; nunca escrever `var(--rgb-*)` cru em CSS (use o alias); o tema vive em `<html>` (gotcha 1.1).

Critérios de aceite:

- [ ] O grep do passo 1 retorna 0 linhas.
- [ ] `grep -c -- '--rgb-' src/index.css` ≥ 60.
- [ ] `grep -n "#[0-9A-Fa-f]\{6\}" tailwind.config.js` retorna 0 linhas.
- [ ] `grep -n "var(--color-semantic-success)" src/components/forms/FormSubmissionsPage.tsx` continua presente e `grep -n -- "--color-semantic-success:" src/index.css` retorna 1 linha.
- [ ] `npx vite build` passa e `grep -o "rgb(var(--rgb-surface-base) / var(--tw-bg-opacity" dist/assets/*.css | head -1` encontra a regra.
- [ ] Teste "Escuro congelado" verde.
- [ ] As 4 verificações de tipo e o vitest verdes.

Riscos e mitigação:

| Risco | Mitigação |
|---|---|
| Classe com alfa que já era usada como "efeito desejado" desaparece de vez | Hoje ela já não gera CSS; a lista no PR permite reintroduzir com intenção depois. |
| Gradientes `from-surface-*` mudam de cor de parada transparente | Com `<alpha-value>` o Tailwind gera `rgb(… / 0)` da mesma cor, melhor que o atual; confirmado pela regra no CSS gerado. |
| Inline `style={{ color: "var(--text-muted)" }}` quebra | Aliases de D2 mantêm `--text-muted` como cor completa. |

### PR 2 — Paletas Claro e Estilo WhatsApp, IA tokenizada, guarda de contraste

| Campo | Conteúdo |
|---|---|
| Objetivo | Definir os dois temas novos (ainda sem seletor), migrar o roxo da IA, remover o legado `.light`. |
| Tamanho | **M** (~450 linhas) |
| Arquivos | `src/index.css`, `tailwind.config.js`, 8 arquivos com `purple-*` (seção 6), `campaigns/WhatsAppPreview.tsx`, `src/lib/themeTokens.test.ts`, `src/lib/themeLegacy.test.ts` (novo), `STYLE_GUIDE.md` |

Passos:

1. Adicionar blocos `[data-theme="light"]` e `[data-theme="whatsapp"]` com **todas** as chaves de `:root`, valores das seções 3.1–3.6. Remover o bloco `.light`.
2. Em `tailwind.config.js`, remover `darkMode` e adicionar a variante `light-theme:` (D14).
3. Substituir `purple-` por `ai-` em todos os arquivos, exceto `developers/JsonHighlighter.tsx`.
   ```bash
   grep -rlE '\b[a-z:-]*(bg|text|border|ring|from|to|via|fill|stroke|shadow)-purple-[0-9]+' src --include=*.tsx --include=*.ts | grep -v JsonHighlighter
   ```
4. Em `WhatsAppPreview.tsx`, trocar cada `[.light_&]:` por `light-theme:` e corrigir o comentário das linhas 69-70.
5. Ampliar `themeTokens.test.ts` com "Cobertura completa", "Contraste AA" (tabela 7.2) e "Bolhas compartilham fg". Criar `themeLegacy.test.ts` (itens de 7.4, exceto o de `index.html`).
6. `STYLE_GUIDE.md`: §1.2 ganha a tabela de 3 temas, corrige os contrastes do Escuro com os valores medidos e lista as exceções; §8.3 descreve `data-theme`.

Critérios de aceite:

- [ ] `grep -rnE 'purple-[0-9]' src --include=*.tsx --include=*.ts | grep -v JsonHighlighter | grep -v '\.test\.'` retorna 0 linhas.
- [ ] `grep -rn '\[\.light_&\]' src` retorna 0 linhas.
- [ ] `grep -n '^\.light' src/index.css` retorna 0 linhas e `grep -c 'data-theme="' src/index.css` ≥ 2.
- [ ] `grep -n darkMode tailwind.config.js` retorna 0 linhas.
- [ ] Contraste AA verde para Claro e WhatsApp; Escuro só falha nos pares de `DARK_KNOWN_FAILURES`.
- [ ] Teste "Escuro congelado" continua verde, incluindo `ai-*` iguais aos hex do Tailwind purple.
- [ ] Verificações de tipo, vitest e build verdes.

Riscos e mitigação:

| Risco | Mitigação |
|---|---|
| Algum `purple-N` com degrau sem token (ex.: `purple-200`, `purple-900`) | Antes de trocar, listar os degraus usados com `grep -ohE 'purple-[0-9]+' … \| sort -u`; se aparecer degrau fora de 300–700, adicionar o token correspondente nos 3 temas e no teste. |
| Tema novo sem seletor fica "morto" | É esperado; o PR 4 liga a aplicação. Dá para testar manualmente no DevTools com `document.documentElement.dataset.theme = "whatsapp"`. |

### PR 3 — Conversa com cara de tema e cores cruas restantes

| Campo | Conteúdo |
|---|---|
| Objetivo | Inbox usa os tokens de chat (bolhas, papel de parede, composer, recibos, badge) e as cores cruas restantes passam a respeitar o tema. Catraca contra novas cores cruas. |
| Tamanho | **M/L** (~500 linhas) |
| Arquivos | `src/components/inbox/{MessageBubble,FormattedMessageText,QuotedBlock,ImageDescription,VoiceTranscription,MessageAttachments,AudioPlayer,MetaSpecialCard,SpecialMessageCard,DeferredMedia}.tsx`, `src/components/Inbox.tsx`, `src/components/LeadDetailPanel.tsx`, `src/components/calendar/constants.ts`, `src/components/forms/FormAnalyticsPage.tsx`, arquivos com `bg-white/N` sobre superfície, `src/lib/rawColorsGuard.test.ts` (novo), `src/components/inbox/bubbleStyle.test.ts` (novo) |

Passos:

1. Exportar `getBubbleStyle` (hoje função local em `MessageBubble.tsx:108`) para testar. Novos valores:

   | Tipo | `bg` | `labelColor` | `footerText` |
   |---|---|---|---|
   | Nota interna | `bg-bubble-note border border-dashed border-bubble-note-border/30 text-text-primary` | `text-bubble-note-label` | `text-text-muted` |
   | Entrada | `bg-bubble-in text-text-primary shadow-bubble` | `text-text-secondary` | `text-text-muted` |
   | IA | `bg-bubble-ai text-bubble-out-fg shadow-bubble` | `text-bubble-ai-label` | `text-bubble-out-fg/75` |
   | Equipe | `bg-bubble-out text-bubble-out-fg shadow-bubble` | `text-bubble-out-label` | `text-bubble-out-fg/75` |

2. `DeliveryTick` "lida": `text-tick-read`.
3. Nos 10 componentes de `inbox/`, aplicar a regra de troca dos ramos `outbound` (seção 6). Usar `grep -nE 'white' <arquivo>` em cada um e trocar só as ocorrências dentro de condição `variant === "outbound"` ou equivalente.
4. `Inbox.tsx`: área de mensagens (`bg-chat-bg chat-wallpaper`), cabeçalho, composer, textarea, pílula "Exibindo as últimas N", badge de não lidas, `hover:bg-amber-600` (seção 6). `LeadDetailPanel.tsx:935` idem para o âmbar.
5. Calendário e timeline: acrescentar `light-theme:text-X-700` ao lado de cada `text-X-400`.
6. `FormAnalyticsPage.tsx`: sparkline com variáveis.
7. `bg-white/N` sobre superfície: listar com `grep -rnE '\bbg-white/[0-9]+' src --include=*.tsx`, decidir pelo pai imediato (regra da seção 6) e anotar no PR cada decisão.
8. Criar `bubbleStyle.test.ts`: nenhum valor de `getBubbleStyle` contém `purple`, `brand-`, `text-white` ou `semantic-warning`. Criar `rawColorsGuard.test.ts` (7.3) com o allowlist gerado pela contagem **após** os passos 1–7.

Critérios de aceite:

- [ ] `grep -nE 'text-white|bg-purple|bg-brand-600|text-brand-(200|400)' src/components/inbox/MessageBubble.tsx` retorna 0 linhas.
- [ ] `grep -n 'chat-wallpaper' src/components/Inbox.tsx` retorna 1 linha.
- [ ] `grep -rnE 'text-white' src/components/inbox/FormattedMessageText.tsx` retorna 0 linhas.
- [ ] `grep -n '#18181B\|#EA580C' src/components/forms/FormAnalyticsPage.tsx` retorna 0 linhas.
- [ ] `grep -n 'amber-600' src/components/Inbox.tsx src/components/LeadDetailPanel.tsx` retorna 0 linhas.
- [ ] `rawColorsGuard.test.ts` e `bubbleStyle.test.ts` verdes; teste "Escuro congelado" continua verde.
- [ ] Verificações de tipo, vitest e build verdes.

Riscos e mitigação:

| Risco | Mitigação |
|---|---|
| Trocar `text-white` fora do ramo outbound (ex.: avatar de grupo, botão sobre `bg-brand-600`) | Só trocar dentro de condição outbound; avatar com `text-white` sobre cor de remetente fica. O `bubbleStyle.test.ts` cobre a função central. |
| Escuro muda por arredondamento (IA `#792CBF` vs `purple-600/80`) | Diferença ≤ 1 nível por canal, imperceptível; documentado no PR. |
| Cores de remetente de grupo (`#22c55e`, `#38bdf8`…) com pouco contraste sobre bolha branca | Fora do escopo (seção 10); anotado como pendência. |

### PR 4 — Aplicação, persistência e Toaster

| Campo | Conteúdo |
|---|---|
| Objetivo | O tema escolhido é aplicado antes da primeira pintura em `/app`, persiste no aparelho e na conta, e o Toaster acompanha. Ainda sem seletor visível. |
| Tamanho | **M** (~450 linhas) |
| Arquivos | `convex/lib/uiTheme.ts` (novo), `convex/schema.ts`, `convex/teamMembers.ts`, `convex/uiTheme.test.ts` (novo), `convex/_generated/api.d.ts` (2 linhas à mão), `public/theme-init.js` (novo), `index.html`, `src/lib/theme.ts` (novo), `src/lib/theme.test.ts` (novo), `src/lib/themeDom.ts` (novo), `src/hooks/useUiTheme.ts` (novo), `src/components/ui/ThemedToaster.tsx` (novo), `src/main.tsx`, `src/components/layout/AuthLayout.tsx`, `src/lib/themeLegacy.test.ts`, `docs/architecture/frontend.md`, `convex/CLAUDE.md` se listar campos de `teamMembers` |

Passos:

1. Criar `convex/lib/uiTheme.ts` (seção 4.1).
2. `convex/_generated/api.d.ts`: como não há deployment para rodar codegen, adicionar à mão a linha `import type * as lib_uiTheme from "../lib/uiTheme.js";` e a entrada `"lib/uiTheme": typeof lib_uiTheme;`, ambas na posição alfabética entre os vizinhos `lib_*`. O próximo `convex dev` do Eric regenera igual.
3. `convex/schema.ts`: `uiTheme: v.optional(uiThemeValidator)` em `teamMembers`.
4. `convex/teamMembers.ts`: mutation `setMyUiTheme` com `args` e `returns: v.null()` (seção 4.1). Usar `withIndex("by_user", q => q.eq("userId", userId))`, nunca `.filter()`.
5. Criar `convex/uiTheme.test.ts` (seção 7.5).
6. Criar `public/theme-init.js` e editar `index.html` (seção 4.2).
7. Criar `src/lib/theme.ts` + teste, `src/lib/themeDom.ts`, `src/hooks/useUiTheme.ts`. Chamar `useUiTheme(currentMember)` em `AuthLayout.tsx` logo depois de `currentMember` ficar disponível (perto da linha 211), antes de qualquer `return` condicional, respeitando as regras de hooks.
8. Criar `ThemedToaster` e trocar `<Toaster theme="dark" />` em `main.tsx`.
9. `themeLegacy.test.ts`: acrescentar a checagem de `class="dark"` em `index.html` e que `index.html` referencia `/theme-init.js` antes de `/src/index.css`.
10. `docs/architecture/frontend.md`: um parágrafo "Temas" (tokens RGB, `data-theme` no `<html>`, script de pré-pintura, `teamMembers.uiTheme`, isolamento por rota).

Critérios de aceite:

- [ ] `grep -n 'theme="dark"' src/main.tsx` retorna 0 linhas.
- [ ] `grep -n 'class="dark"' index.html` retorna 0 linhas; `grep -n 'theme-init.js' index.html` retorna 1 linha.
- [ ] Depois de `npx vite build`: `test -f dist/theme-init.js` e `grep -c theme-init.js dist/index.html` = 1.
- [ ] `grep -n 'uiTheme' convex/schema.ts` mostra campo `v.optional`.
- [ ] `grep -n '\.filter(' convex/teamMembers.ts` não aumenta em relação a `main`.
- [ ] `convex/uiTheme.test.ts` e `src/lib/theme.test.ts` verdes (casos de `resolveTheme`, `shouldPushLocalToServer`, `isAppPath` para `/app`, `/app/entrada`, `/`, `/entrar`, `/f/x`, `/apple`).
- [ ] Verificações de tipo (inclui `npx tsc -p convex` com o `api.d.ts` editado), vitest e build verdes.

Riscos e mitigação:

| Risco | Mitigação |
|---|---|
| `isAppPath("/apple")` aceitar rota pública futura | Regra é `pathname === "/app" \|\| pathname.startsWith("/app/")`; o script usa a mesma regra e o teste cobre `/apple`. |
| `localStorage` indisponível (modo privado) | Todo acesso em `try/catch`; cai no Escuro ou no valor do servidor. |
| Escrita do tema em todas as orgs vira vetor de escrita cruzada | A mutation só toca documentos com o `userId` autenticado; o teste multi-tenant garante. |
| `api.d.ts` editado à mão diverge do codegen | Formato idêntico ao gerado (linha de import + entrada alfabética); o PR avisa que o próximo `convex dev` pode reordenar sem efeito. |
| Schema não-aditivo quebraria DEV ou PROD | Campo `v.optional`; nenhum documento existente fica inválido. |

### PR 5 — Seletor "Aparência" e documentação

| Campo | Conteúdo |
|---|---|
| Objetivo | O usuário escolhe o tema pela sidebar, pelo "Mais" no mobile e em Configurações › Geral. |
| Tamanho | **M** (~400 linhas) |
| Arquivos | `src/components/settings/AppearancePicker.tsx` (novo), `src/components/settings/ThemePickerModal.tsx` (novo), `src/components/layout/Sidebar.tsx`, `src/components/layout/BottomTabBar.tsx`, `src/components/layout/AuthLayout.tsx` (repasse de `theme`/`setTheme` via props ou pelo `AppOutletContext`), `src/components/Settings.tsx`, `src/lib/theme.ts` (rótulos), `src/lib/theme.test.ts`, `CHANGELOG.md`, `STYLE_GUIDE.md`, `.claude/rules/frontend.md` |

Passos:

1. Em `src/lib/theme.ts`, adicionar `THEME_OPTIONS: Array<{ id: UiTheme; label: string; description: string; preview: {...cores fixas} }>` com os textos da seção 5. Testar que há 3 opções, ids iguais a `UI_THEMES` e textos sem string em inglês.
2. Criar `AppearancePicker` (radiogroup, miniaturas estáticas, `Check` do `lucide-react`) e `ThemePickerModal` (usa `Modal`).
3. `Sidebar.tsx`: botão "Aparência" acima de "Sair", mesmo estilo e altura mínima de 44 px, ícone `Palette`.
4. `BottomTabBar.tsx`: linha "Aparência · {tema}" no bloco "Conta", entre "Organização" e "Sair"; fecha o sheet e abre o modal.
5. `Settings.tsx`: card "Aparência" com `AppearancePicker` no topo da seção `general`.
6. `CHANGELOG.md`: entrada PT-BR no topo, sob o cabeçalho da próxima versão (o `/release` define o número):
   > ### Aparência: escolha entre Escuro, Claro e Estilo WhatsApp
   > - Cada pessoa da equipe escolhe as cores do painel em **Aparência** (menu lateral, "Mais" no celular ou Configurações › Geral). A escolha acompanha a conta em qualquer aparelho.
   > - **Estilo WhatsApp**: acento verde, conversas com fundo bege e bolhas verdes, como no aplicativo.
   > - **Claro** revisado para leitura confortável (contraste AA em textos, links e avisos).
   > - O Escuro continua o padrão e não mudou.
7. `STYLE_GUIDE.md` §8.3 e `.claude/rules/frontend.md`: como escolher token por tema, quando usar `light-theme:`, lista dos tokens de chat.

Critérios de aceite:

- [ ] `grep -rn 'Estilo WhatsApp' src/lib/theme.ts` retorna 1 linha; `grep -rln 'AppearancePicker' src/components` lista o próprio arquivo, `ThemePickerModal.tsx` e `Settings.tsx`.
- [ ] `grep -n 'Aparência' src/components/layout/Sidebar.tsx src/components/layout/BottomTabBar.tsx` retorna ao menos 1 linha em cada.
- [ ] `grep -n 'role="radiogroup"' src/components/settings/AppearancePicker.tsx` retorna 1 linha.
- [ ] `grep -n 'Aparência' CHANGELOG.md` encontra a entrada no topo.
- [ ] `rawColorsGuard.test.ts` continua verde (as miniaturas usam `style={{ background }}` com hex de `THEME_OPTIONS`, não classes `[#hex]`; o arquivo `theme.ts` não é `.tsx` com classe).
- [ ] Verificações de tipo, vitest e build verdes.

Riscos e mitigação:

| Risco | Mitigação |
|---|---|
| Miniaturas usam o tema ativo e ficam iguais | Cores vêm de `THEME_OPTIONS.preview` (hex fixos), não de tokens. |
| Sidebar estreita (só ícones abaixo de `lg`) corta o rótulo | Mesmo padrão de "Sair": rótulo `hidden lg:block` e `aria-label`. |

### PR 6 — Fonte Inter self-hosted (independente)

| Campo | Conteúdo |
|---|---|
| Objetivo | Carregar de fato a fonte documentada, sem nova origem na CSP. |
| Tamanho | **S** (~20 linhas + lockfile) |
| Arquivos | `package.json`, `package-lock.json`, `src/main.tsx`, `src/components/SEO.tsx`, `docs/architecture/frontend.md` |

Passos:

1. `npm install @fontsource-variable/inter`.
2. Em `src/main.tsx`, `import "@fontsource-variable/inter/wght.css";` antes de `./index.css`. A família gerada é `"Inter Variable"`, que já é a primeira da pilha em `index.css` e `tailwind.config.js`.
3. Remover `preconnect` e `dns-prefetch` para `fonts.googleapis.com` em `SEO.tsx:52-53` (sem uso real e bloqueados pela CSP futura).
4. Nota em `docs/architecture/frontend.md`: fonte self-hosted, `unicode-range` baixa só os subsets usados.

Critérios de aceite:

- [ ] `npx vite build` passa e `ls dist/assets/*.woff2 | grep -i inter` lista arquivos.
- [ ] `grep -n fonts.googleapis src/components/SEO.tsx` retorna 0 linhas.
- [ ] `grep -n '@fontsource-variable/inter' src/main.tsx package.json` retorna 1 linha em cada.

Riscos e mitigação:

| Risco | Mitigação |
|---|---|
| Mais peso no primeiro carregamento | Arquivo variável único por subset; só o latin é baixado em páginas PT-BR; `font-display: swap` vem no CSS do pacote. |
| Mudança de métrica da fonte desloca layouts justos | Inter tem métricas próximas das fontes de sistema; o PR anexa a lista de telas para conferir (Inbox, Kanban, Configurações). |

### Ordem e dependências

| PR | Depende de | Pode ir em paralelo com |
|---|---|---|
| 1 Tokens RGB | — | 6 |
| 2 Paletas + IA | 1 | 6 |
| 3 Conversa + cores cruas | 2 | 4, 6 |
| 4 Aplicação + persistência | 2 | 3, 6 |
| 5 Seletor + docs | 3 e 4 | 6 |
| 6 Inter | — | todos |

---

## 9. Decisões assumidas (o dono não especificou)

- **Escuro idêntico**, inclusive nas falhas de AA medidas. A correção (muted `#8B8B94`, botão `brand-600` → `#C2410C`, rótulo e tique da bolha da equipe) vira um **PR 7 opcional**, que exige só mudar valores do `:root` e esvaziar `DARK_KNOWN_FAILURES`.
- **Estilo WhatsApp com base clara**, sem variante escura. Os valores canônicos do WhatsApp escuro já estão em `WhatsAppPreview.tsx` e um quarto tema seria só um bloco de CSS.
- **No Estilo WhatsApp o acento do app inteiro vira verde** (botões, foco, seleção, filtros). Dois acentos competindo confundem; a identidade fica no logo laranja, no layout e nos componentes.
- **Sem opção "Automático (seguir o sistema)"**. Exigiria decidir entre Claro e WhatsApp como "claro do sistema" e um listener de `prefers-color-scheme`; fácil de somar depois em `resolveTheme`.
- **Preferência por pessoa, não por organização.** Um admin não força tema na equipe.
- **Padrão para novos usuários: Escuro.**
- **Sem registro em `activities`/`auditLogs`** para troca de tema, como `notificationPreferences`.
- **Chave local `hnbcrm:theme`.**
- **Nada de `color-scheme: dark` no Escuro**: mudaria a aparência de controles nativos (datas, selects) e quebraria o "idêntico". Os temas claros não precisam dele.
- **`<meta name="theme-color">`** acompanha o tema: Escuro `#0F0F11`, Claro `#FAFAFA`, WhatsApp `#008069` (barra do navegador no celular verde, como o app).

## 10. Fora do escopo

- Corrigir o AA do Escuro (PR 7 opcional, acima).
- Tema por organização ou marca do cliente (white-label).
- Tema "Automático" e WhatsApp escuro.
- Reestruturar a lista de conversas (avatar maior, sem bordas, layout de duas linhas do WhatsApp); só cores mudam.
- Separadores de dia e mensagens de sistema no estilo WhatsApp dentro da conversa.
- Contraste das cores de remetente em grupo (`lib/groupDisplay.ts`) sobre bolha branca.
- Cores escolhidas pelo usuário (etapas, labels, projetos, etiquetas) e o tema do formulário público.
- Superfícies públicas (landing, login, developers, termos, privacidade, formulário público) e o widget embed: continuam no Escuro.
- `prefers-contrast` e `forced-colors`.
- Tornar a CSP `enforce` (este plano já é compatível com ela).
