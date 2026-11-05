# HNBCRM — Guia de Estilos Frontend

> **Stack:** Vite + React + TypeScript | Convex (backend) | TailwindCSS
> **Abordagem:** Mobile First | Dark Mode Padrão | Suporte a Light Mode
> **Última atualização:** Fevereiro 2026

---

## 1. Identidade Visual

### 1.1 Logo

O logo HNBCRM é um ícone de aperto de mãos em laranja, representando a colaboração entre humanos e bots de IA. Existe em três variantes de cor:

**Arquivos de logo:**

| Arquivo | Variante | Uso |
|---|---|---|
| `public/orange_icon_logo_transparent-bg-528x488.png` | Laranja sobre transparente | **Principal** — sidebar, header em fundos escuros |
| `public/white_icon_logo_transparent-bg-528x488.png` | Branco sobre transparente | Splash screens, marcas d'água em fundos escuros |
| `public/black_icon_logo_transparent-bg-528x488.png` | Preto sobre transparente | Light mode, impressão |
| `public/icon_logo_white_bg_full-700x700.png` | Laranja sobre fundo branco | Favicon, meta tags, Open Graph |
| `public/icon_logo_white_bg_full-700x700.jpg` | Laranja sobre fundo branco (JPG) | Fallback para plataformas sem suporte PNG |

**Regras de uso:**
- Área de respiro mínima: 1x a largura do ícone em todas as direções
- Tamanho mínimo do ícone: 24px (mobile), 32px (desktop)
- Nunca distorcer, rotacionar ou alterar as proporções do logo
- Em fundos escuros: usar versão laranja ou branca sobre transparente
- Em fundos claros: usar versão preta sobre transparente

### 1.2 Paleta de Cores

#### Laranja Primário (cor da marca ~#FF6B00)

```css
:root {
  /* === LARANJA PRIMÁRIO === */
  --brand-50:  #FFF7ED;  /* Bg sutil (light mode) */
  --brand-100: #FFEDD5;  /* Hover bg (light mode) */
  --brand-200: #FED7AA;  /* Badges claros */
  --brand-300: #FDBA74;  /* Decorativo */
  --brand-400: #FB923C;  /* Ícones, interativo secundário */
  --brand-500: #FF6B00;  /* **Cor primária da marca** */
  --brand-600: #EA580C;  /* Botão primário bg (AA com texto branco, 4.6:1) */
  --brand-700: #C2410C;  /* Pressed/ativo */
  --brand-800: #9A3412;  /* Ênfase escura */
  --brand-900: #7C2D12;  /* Acento mais escuro */
}
```

| Token | Hex | Uso |
|---|---|---|
| `brand-50` | `#FFF7ED` | Background sutil (light mode) |
| `brand-100` | `#FFEDD5` | Hover background (light mode) |
| `brand-200` | `#FED7AA` | Badges claros |
| `brand-300` | `#FDBA74` | Decorativo |
| `brand-400` | `#FB923C` | Ícones, interativo secundário |
| `brand-500` | `#FF6B00` | **Cor primária da marca** |
| `brand-600` | `#EA580C` | Botão primário (contraste AA com texto branco) |
| `brand-700` | `#C2410C` | Pressed/ativo |
| `brand-800` | `#9A3412` | Ênfase escura |
| `brand-900` | `#7C2D12` | Acento mais escuro |

#### Superfícies Dark Mode

| Token | Hex | Uso |
|---|---|---|
| `surface-base` | `#0F0F11` | Background da página |
| `surface-raised` | `#18181B` | Cards |
| `surface-overlay` | `#1F1F23` | Modais, dropdowns |
| `surface-sunken` | `#09090B` | Colunas Kanban, áreas embutidas |

#### Bordas

| Token | Hex | Uso |
|---|---|---|
| `border-default` | `#27272A` | Borda padrão |
| `border-subtle` | `#1E1E22` | Borda sutil |
| `border-strong` | `#3F3F46` | Borda forte |

#### Texto (Dark Mode)

| Token | Hex | Uso |
|---|---|---|
| `text-primary` | `#FAFAFA` | Texto principal |
| `text-secondary` | `#A1A1AA` | Texto secundário |
| `text-muted` | `#71717A` | Texto terciário/placeholder |

#### Superfícies Light Mode

| Token | Hex | Uso |
|---|---|---|
| `surface-base` | `#FAFAFA` | Background da página |
| `surface-raised` | `#FFFFFF` | Cards |
| `surface-sunken` | `#F4F4F5` | Áreas embutidas |

#### Cores Semânticas

| Token | Hex | Uso |
|---|---|---|
| `success` | `#22C55E` | Sucesso, confirmações |
| `error` | `#EF4444` | Erros, exclusões |
| `warning` | `#EAB308` | Avisos (âmbar — distinto do laranja) |
| `info` | `#3B82F6` | Informações |

#### Conformidade de Contraste

Todos os pares de texto/fundo atendem WCAG AA:
- `#FAFAFA` sobre `#0F0F11` → 18.1:1 (AAA)
- `#A1A1AA` sobre `#0F0F11` → 7.2:1 (AAA)
- `#71717A` sobre `#0F0F11` → 4.6:1 (AA)
- Botões primários usam `brand-600` (`#EA580C`, 4.6:1 com branco) em vez de `brand-500` para conformidade AA em texto de corpo

### 1.3 Configuração TailwindCSS

```js
// tailwind.config.js
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#FFF7ED',
          100: '#FFEDD5',
          200: '#FED7AA',
          300: '#FDBA74',
          400: '#FB923C',
          500: '#FF6B00',
          600: '#EA580C',
          700: '#C2410C',
          800: '#9A3412',
          900: '#7C2D12',
        },
        surface: {
          base:    'var(--surface-base)',
          raised:  'var(--surface-raised)',
          overlay: 'var(--surface-overlay)',
          sunken:  'var(--surface-sunken)',
        },
        border: {
          DEFAULT: 'var(--border-default)',
          subtle:  'var(--border-subtle)',
          strong:  'var(--border-strong)',
        },
        text: {
          primary:   'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          muted:     'var(--text-muted)',
        },
        semantic: {
          success: '#22C55E',
          error:   '#EF4444',
          warning: '#EAB308',
          info:    '#3B82F6',
        },
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        btn:   '9999px',  // Pill (rounded-full)
        card:  '12px',    // rounded-xl
        field: '8px',     // rounded-lg
      },
      boxShadow: {
        card:        '0 1px 3px rgba(0, 0, 0, 0.3)',
        'card-hover': '0 4px 12px rgba(0, 0, 0, 0.4)',
        elevated:    '0 8px 24px rgba(0, 0, 0, 0.5)',
        glow:        '0 0 20px rgba(255, 107, 0, 0.15)',
      },
      screens: {
        xs: '375px',
        sm: '640px',
        md: '768px',
        lg: '1024px',
        xl: '1280px',
      },
      animation: {
        'fade-in':       'fadeIn 200ms ease-out',
        'fade-in-up':    'fadeInUp 200ms ease-out',
        'slide-in-right': 'slideInRight 300ms ease-out',
        'slide-in-up':   'slideInUp 300ms ease-out',
        'shimmer':       'shimmer 1.5s ease-in-out infinite',
        'pulse-brand':   'pulseBrand 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          from: { opacity: '0' },
          to:   { opacity: '1' },
        },
        fadeInUp: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        slideInRight: {
          from: { transform: 'translateX(100%)' },
          to:   { transform: 'translateX(0)' },
        },
        slideInUp: {
          from: { transform: 'translateY(100%)' },
          to:   { transform: 'translateY(0)' },
        },
        shimmer: {
          '0%':   { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        pulseBrand: {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.6' },
        },
      },
    },
  },
  plugins: [],
}
```

---

## 2. Tipografia

**Fonte principal:** Inter (já carregada — excelente para dashboards CRM com muitos dados, suporta números tabulares)

### 2.1 Escala Tipográfica (Mobile First)

```
Display:  28px / 36px line-height / Bold (700)      → md: 36px / 44px
H1:       22px / 28px / Bold (700)                   → md: 28px / 36px
H2:       18px / 24px / Semibold (600)               → md: 22px / 28px
H3:       16px / 22px / Semibold (600)               → md: 18px / 24px
Body:     14px / 20px / Regular (400)                → Mantém
Small:    13px / 18px / Regular (400)                → Mantém
Caption:  11px / 14px / Medium (500)                 → md: 12px / 16px
```

Utilitários Tailwind: `text-caption` (12px / 16px, mínimo legível para texto de apoio) e `text-micro` (11px / 14px, só para selos e marcadores). Para alvos de toque use a variante `coarse:` (`(pointer: coarse)`), por exemplo `coarse:min-h-11` (44px).

### 2.2 Pesos Utilizados

| Peso | Nome | Uso |
|---|---|---|
| 400 | Regular | Corpo de texto, descrições |
| 500 | Medium | Captions, labels, valores em tabelas |
| 600 | Semibold | Subtítulos H2/H3, botões secundários |
| 700 | Bold | Títulos H1/Display, botões primários, métricas |

### 2.3 Números Tabulares

Usar a classe `tabular-nums` em todas as métricas, valores monetários, tabelas e contadores para alinhamento consistente de dígitos:

```html
<span class="tabular-nums">R$ 45.230,00</span>
<span class="tabular-nums">1.234 leads</span>
```

---

## 3. Componentes UI

### 3.1 Botões

Todos os botões seguem o formato **pill** (bordas totalmente arredondadas).

> **Componente:** `src/components/ui/Button.tsx`

```
┌──────────────────────────────────────────────────────────────┐
│ VARIANTE      │ BG            │ TEXTO        │ USO           │
├──────────────────────────────────────────────────────────────┤
│ Primary       │ brand-600     │ branco       │ CTAs          │
│ Secondary     │ surface-overlay│ text-primary │ Ações alt     │
│ Ghost         │ transparente  │ brand-500    │ Links, terci  │
│ Dark          │ surface-raised│ brand-400    │ Fundos escuros│
│ Danger        │ error         │ branco       │ Exclusões     │
└──────────────────────────────────────────────────────────────┘
```

**Tamanhos:**

| Tamanho | Altura | Padding H | Font | Uso |
|---|---|---|---|---|
| `sm` | 32px | 12px | 13px | Ações inline, tabelas |
| `md` | 40px | 16px | 14px | Padrão desktop |
| `lg` | 48px | 24px | 16px | CTAs mobile (touch target) |

`sm` e `md` ganham `coarse:min-h-11` (44px em telas de toque); `iconOnly` é um quadrado de 40px (`coarse:` 44px) e exige `aria-label`; `loading` mostra spinner, `aria-busy` e desabilita. O anel de foco usa `focus-visible:` (aparece só ao navegar por teclado).

**Estrutura de página:** `PageHeader` (único `<h1>`, voltar com `aria-label="Voltar"`, selo e ações que quebram para baixo no mobile); `SectionCard` (`<section aria-labelledby>` com `<h2>`, descrição, ícone e ações); `EmptyState` (ícone, título `h2`/`h3`, descrição, ação principal e secundária, `size` `sm`/`md`).

**Especificações:**
- Border-radius: `rounded-full` (pill)
- Font: Inter Semibold (600) para primary, Medium (500) para demais
- Transição: `all 150ms ease-in-out`
- Estados: default → hover (escurece 10%) → pressed (escurece 20%) → disabled (opacity 0.5)
- Focus: `ring-2 ring-brand-500 ring-offset-2 ring-offset-surface-base`

### 3.2 Campos de Input

> **Componente:** `src/components/ui/Input.tsx`

**Estilo Bordado (padrão para formulários):**

```css
.input-bordered {
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  border-radius: 8px; /* rounded-lg */
  padding: 10px 14px;
  font-size: 14px;
  color: var(--text-primary);
  transition: border-color 150ms, box-shadow 150ms;
}

.input-bordered:focus {
  border-color: var(--brand-500);
  box-shadow: 0 0 0 2px rgba(255, 107, 0, 0.2);
  outline: none;
}

.input-bordered::placeholder {
  color: var(--text-muted);
}
```

**Estilo Underline (apenas telas de autenticação):**

```css
.input-underline {
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-strong);
  padding: 12px 0;
  font-size: 16px; /* mínimo 16px para evitar zoom no iOS */
  color: var(--text-primary);
}

.input-underline:focus {
  border-bottom-color: var(--brand-500);
  outline: none;
}
```

**Variantes de campo:**
- **Com label:** Label acima, texto `text-secondary`, font `13px medium`
- **Com erro:** Borda `semantic-error`, mensagem de erro abaixo em `text-semantic-error`
- **Com ícone:** Ícone à esquerda com `padding-left: 40px`

### 3.2.1 Controles de formulário

Primitivos em `src/components/ui/`, todos com teste de teclado e `aria-*`:

- `Switch`: `button role="switch"`, rótulo clicável (ou `hideLabel` quando o texto está fora), área de toque de 44 px também no `sm`.
- `Select`: `<select>` nativo estilizado, `text-base md:text-sm`, opções planas (`options`) ou agrupadas (`groups`).
- `SegmentedControl`: escolha única entre poucas opções (`radiogroup`, setas).
- `Tabs` + `TabPanel`: `tablist`/`tab`/`tabpanel`, setas, Home/End; rolagem horizontal no celular. Variantes `underline` e `pills`.
- `FormField` e `Textarea`: rótulo, dica e erro ligados por id; `(opcional)` com `showOptional`; contador com `maxLength`.

### 3.3 Cards

> **Componente:** `src/components/ui/Card.tsx`

```
┌──────────────────────────────────────────────────────────┐
│ VARIANTE      │ BACKGROUND      │ USO                    │
├──────────────────────────────────────────────────────────┤
│ Default       │ surface-raised  │ Cards de conteúdo      │
│ Sunken        │ surface-sunken  │ Colunas Kanban, inset  │
│ Interactive   │ surface-raised  │ Cards clicáveis        │
│               │ + hover:overlay │ com hover elevado       │
└──────────────────────────────────────────────────────────┘
```

**Especificações:**
- Border: `1px solid var(--border-default)`
- Border-radius: `12px` (rounded-xl)
- Padding: `16px` mobile, `24px` desktop (`p-4 md:p-6`)
- Shadow: `shadow-card` (default), `shadow-card-hover` (interactive hover)

### 3.4 Modais

> **Componente:** `src/components/ui/Modal.tsx`

**Mobile (< sm):** Bottom sheet
- Posicionado no fundo da tela
- Animação: `animate-slide-in-up`
- Border-radius: `rounded-t-xl` (apenas topo)
- Altura máxima: `max-h-[85vh]`
- Swipe down para fechar

**Desktop (sm+):** Diálogo centralizado
- Centralizado vertical e horizontal
- Animação: `animate-fade-in-up`
- Border-radius: `rounded-xl`
- Largura máxima: `max-w-lg`

**Overlay:** `bg-black/60 backdrop-blur-sm`
- `role="dialog"` + `aria-modal="true"`
- Fecha ao clicar fora ou pressionar Escape

### 3.5 Slide-overs (Painéis Laterais)

> **Componente:** `src/components/ui/SlideOver.tsx`

**Mobile (< md):** Tela cheia
- `inset-0` (ocupa toda a viewport)
- Header com botão voltar

**Desktop (md+):** Painel lateral fixo
- Largura: `480px` (`w-[480px]`)
- Posição: direita (`right-0 top-0 bottom-0`)
- Animação: `animate-slide-in-right`
- Background: `surface-raised`

### 3.6 Badges

> **Componente:** `src/components/ui/Badge.tsx`

Formato pill com cores semânticas. Background sutil + texto colorido:

| Variante | Background | Texto | Uso |
|---|---|---|---|
| `default` | `surface-overlay` | `text-secondary` | Padrão |
| `brand` | `brand-500/10` | `brand-400` | Destaque da marca |
| `success` | `success/10` | `success` | Ativo, concluído |
| `error` | `error/10` | `error` | Urgente, falha |
| `warning` | `warning/10` | `warning` | Atenção, pendente |
| `info` | `info/10` | `info` | Informativo |

**Especificações:**
- Border-radius: `rounded-full` (pill)
- Padding: `px-2.5 py-0.5`
- Font: `text-xs font-medium`

### 3.7 Navegação

**Mobile (< md): Barra de abas inferior**
> **Componente:** `src/components/layout/BottomTabBar.tsx`

- Fixa no fundo da tela
- 5 abas principais + "Mais" para Settings/Auditoria
- Ícones Lucide + label abaixo
- Aba ativa: `text-brand-500`
- Safe area: `pb-[env(safe-area-inset-bottom)]`
- Altura: `64px` + safe area

**Abas:**
| Aba | Label | Ícone Lucide |
|---|---|---|
| dashboard | Painel | `LayoutDashboard` |
| board | Pipeline | `Kanban` |
| inbox | Entrada | `MessageSquare` |
| handoffs | Repasses | `ArrowRightLeft` |
| team | Equipe | `Users` |
| more | Mais | `MoreHorizontal` |

**Desktop (md+): Sidebar esquerdo fixo**
> **Componente:** `src/components/layout/Sidebar.tsx`

- Fixo à esquerda
- Colapsado (apenas ícones) no `md`, expandido com labels no `lg`
- Logo HNBCRM no topo
- Itens de navegação com ícones + labels
- Seletor de organização na parte inferior
- Botão de sair

### 3.8 Avatar

> **Componente:** `src/components/ui/Avatar.tsx`

- Circular, tamanhos: `sm` (32px), `md` (40px), `lg` (48px)
- Iniciais do nome como fallback (background `brand-600`, texto branco)
- Indicador de tipo: humano (sem badge) vs. IA (badge com ícone `Bot`)
- Status online/offline: ponto verde/cinza no canto inferior direito

### 3.9 Spinner

> **Componente:** `src/components/ui/Spinner.tsx`

- Animação circular com cor `brand-500`
- Tamanhos: `sm` (16px), `md` (24px), `lg` (32px)
- Texto acessível: `<span class="sr-only">Carregando...</span>`

### 3.10 Skeleton

> **Componente:** `src/components/ui/Skeleton.tsx`

- Background base: `surface-overlay`
- Shimmer: gradiente branco com 4% opacity varrendo da esquerda para direita
- Animação: `animate-shimmer` (1.5s loop)
- Variantes: `text` (retângulo arredondado), `circle` (avatar), `card` (retângulo grande)

---

## 4. Layout & Responsividade (Mobile First)

### 4.1 App Shell

> **Componente:** `src/components/layout/AppShell.tsx`

Orquestra a navegação responsiva:
- Mobile (< md): conteúdo + `BottomTabBar` fixa
- Desktop (md+): `Sidebar` fixa + conteúdo com margem esquerda

```
Mobile:                    Desktop (md+):
┌──────────────┐           ┌────┬───────────────┐
│              │           │    │               │
│   Conteúdo   │           │ S  │   Conteúdo    │
│              │           │ I  │               │
│              │           │ D  │               │
│              │           │ E  │               │
├──────────────┤           │    │               │
│  Bottom Tab  │           │    │               │
└──────────────┘           └────┴───────────────┘
```

### 4.2 Breakpoints e Grid

```
Mobile (< 640px):
  - Container: 100% - 32px padding (16px cada lado)
  - Grid: 1 coluna
  - Tipografia: escala mobile

Tablet (640px - 767px):
  - Container: max 640px, centralizado
  - Grid: 2 colunas onde fizer sentido

Desktop médio (768px - 1023px):
  - Sidebar aparece (colapsado, apenas ícones)
  - Grid: 2-3 colunas

Desktop (1024px+):
  - Sidebar expandido com labels
  - Grid: 2-4 colunas conforme contexto
  - Tipografia: escala desktop

Desktop grande (1280px+):
  - Container: max 1200px para conteúdo
  - Grid: até 4 colunas
```

### 4.3 Sistema de Espaçamento

Usar múltiplos de 4px (padrão do Tailwind):

```
space-1:  4px    (micro — gap entre ícone e label)
space-2:  8px    (tight — gap entre itens de lista)
space-3:  12px   (compact — padding interno pequeno)
space-4:  16px   (default — padding de cards mobile)
space-5:  20px   (comfortable — gap entre seções)
space-6:  24px   (relaxed — padding de cards desktop)
space-8:  32px   (spacious — margem entre seções)
space-10: 40px   (generous — espaçamento de página)
space-12: 48px   (section gap mobile)
space-16: 64px   (section gap desktop)
```

### 4.4 Regras Mobile First Obrigatórias

1. **Touch targets:** Mínimo 44×44px para qualquer elemento interativo
2. **Font-size inputs:** Mínimo 16px para evitar zoom automático no iOS
3. **Safe areas:** Respeitar notch e home indicator do iOS com `env(safe-area-inset-*)`
4. **Scroll:** Scroll suave com `-webkit-overflow-scrolling: touch`
5. **Kanban mobile:** Scroll horizontal com snap points (`scroll-snap-type: x mandatory`)

---

## 5. Animações & Micro-interações

```css
/* Transições padrão */
--transition-fast:   100ms ease-in-out;
--transition-normal: 200ms ease-in-out;
--transition-slow:   300ms ease-in-out;

/* Entrada de elementos */
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes slideInRight {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}

@keyframes slideInUp {
  from { transform: translateY(100%); }
  to   { transform: translateY(0); }
}

/* Skeleton shimmer */
@keyframes shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}

/* Pulse de notificação */
@keyframes pulseBrand {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.6; }
}
```

**Regras:**
- Usar `prefers-reduced-motion: reduce` para desabilitar animações
- Animações de entrada: `fadeInUp` com stagger de 50ms entre itens de lista
- Skeleton loading para todo conteúdo assíncrono
- Transições em hover/focus: usar `transition-fast` (100ms) para estados imediatos

---

## 6. Acessibilidade

- Contraste mínimo WCAG AA: 4.5:1 para texto, 3:1 para elementos grandes
- `#FAFAFA` sobre `#0F0F11` = ratio ~18.1:1 (AAA)
- `#A1A1AA` sobre `#0F0F11` = ratio ~7.2:1 (AAA)
- `#EA580C` sobre `#FFFFFF` = ratio ~4.6:1 (AA)
- Todos os ícones interativos precisam de `aria-label`
- Focus visible com ring laranja: `focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-base`
- Suporte a screen readers com landmarks (`<nav>`, `<main>`, `<header>`, `<aside>`)
- `role="dialog"` + `aria-modal="true"` em modais
- Link "Pular para conteúdo" no topo do app
- Texto para screen readers em estados de carregamento: `<span class="sr-only">Carregando...</span>`

---

## 7. Performance

- **Bundle splitting:** Lazy load de componentes de página com `React.lazy()` + `Suspense`
- **Ícones:** `lucide-react` para ícones SVG tree-shakeable (substituir emojis)
- **Fontes:** Inter já está disponível via `"Inter Variable"`
- **Skeleton loading:** Para todo conteúdo assíncrono (queries do Convex)
- **Convex:** Usar queries reativas e paginação cursor-based para listas longas
- **Imagens:** Usar `loading="lazy"` em imagens de avatar e logo

---

## 8. Padrões de Código

### 8.1 Estrutura de Pastas

```
src/
├── components/
│   ├── ui/              # Button, Input, Badge, Card, Modal, SlideOver, Spinner, Skeleton, Avatar
│   ├── layout/          # AppShell, Sidebar, BottomTabBar
│   ├── Dashboard.tsx     # Renderiza conteúdo de abas
│   ├── DashboardOverview.tsx
│   ├── KanbanBoard.tsx
│   ├── LeadDetailPanel.tsx
│   ├── CreateLeadModal.tsx
│   ├── Inbox.tsx
│   ├── HandoffQueue.tsx
│   ├── TeamPage.tsx
│   ├── AuditLogs.tsx
│   ├── Settings.tsx
│   ├── OrganizationSelector.tsx
│   └── ErrorBoundary.tsx
├── lib/
│   └── utils.ts         # cn() utility (clsx + tailwind-merge)
├── App.tsx
├── SignInForm.tsx
├── SignOutButton.tsx
├── main.tsx
└── index.css
```

### 8.2 Convenções de Código

```typescript
// Componentes: PascalCase, um por arquivo
// Arquivo: PascalCase.tsx para componentes, camelCase.ts para utils
// Props: interface ComponentNameProps {}
// Exportação: named export para todos os componentes

// Utilitário de classes condicionais:
import { cn } from '@/lib/utils'

// Exemplo de componente padrão:
interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: 'default' | 'sunken' | 'interactive'
}

export function Card({
  variant = 'default',
  className,
  children,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        'rounded-card border border-border p-4 md:p-6',
        variants[variant],
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}
```

### 8.3 Tema

O app usa **dark mode como padrão**. Light mode é suportado via classe `.light` no `<html>`:

```typescript
// Dark mode (padrão):
// Background: bg-surface-base (#0F0F11)
// Cards: bg-surface-raised (#18181B)
// Texto: text-text-primary (#FAFAFA)

// Light mode (classe .light no <html>):
// As CSS custom properties são sobrescritas automaticamente
// Background: bg-surface-base (#FAFAFA)
// Cards: bg-surface-raised (#FFFFFF)
// Texto: cores escuras do Tailwind
```

---

## 9. Telas de Autenticação

Layout da tela de login:

```
┌─────────────────────────────┐
│     [Logo Laranja]          │
│       HNBCRM                │
│                             │
│    Email                    │
│    ─────────────────        │
│    Senha                    │
│    ─────────────────        │
│                             │
│    ┌─────────────────┐      │
│    │     Entrar       │      │  ← Botão pill primário
│    └─────────────────┘      │
│                             │
│    Não tem conta? Cadastrar │
│                             │
│    ────── ou ──────         │
│                             │
│    ┌─────────────────┐      │
│    │ Entrar anonimamente│    │  ← Botão secundário
│    └─────────────────┘      │
└─────────────────────────────┘
```

- Background: gradiente de `surface-overlay` para `surface-base`
- Logo centralizado no topo com animação sutil de entrada (`animate-fade-in-up`)
- Campos com estilo underline
- Botão Entrar: full-width, `brand-600`, texto branco
- Autenticação: Email/Senha + Anônimo (via Convex Auth)

---

## 10. Contexto do Produto

**HNBCRM** (Humans & Bots CRM) é um CRM multi-tenant onde membros humanos da equipe e bots de IA colaboram para gerenciar leads, conversas e repasses. O logo de aperto de mãos representa essa parceria humano-IA.

**Funcionalidades-chave:**
- **Pipeline de vendas** — Quadro Kanban com estágios configuráveis
- **Caixa de entrada** — Conversas unificadas por WhatsApp, Telegram, Email
- **Repasses (Handoffs)** — Transferência de leads entre humanos e bots com contexto
- **Equipe** — Gerenciamento de membros humanos e bots com papéis e status
- **Auditoria** — Log completo de todas as ações com filtros e exportação
- **API REST** — Endpoints em `/api/v1/` autenticados via `X-API-Key`

**Público-alvo:** Equipes de vendas e suporte que utilizam agentes de IA ao lado de humanos em seu pipeline.

---

## 11. Idioma da Interface (Português BR)

Todo texto voltado ao usuário será em Português (BR):

### Navegação
| Chave | Label |
|---|---|
| `dashboard` | Painel |
| `board` | Funil |
| `inbox` | Conversas |
| `handoffs` | Requer atenção |
| `calendar` | Agenda |
| `central` | Relatórios |
| `team` | Equipe |
| `audit` | Histórico de alterações |
| `settings` | Configurações |

Os ids (chaves) e as rotas não mudam; só o rótulo. A fonte é `src/lib/vocab.ts` (`VOCAB`).

### Autenticação
| Chave | Texto |
|---|---|
| `signIn` | Entrar |
| `signUp` | Cadastrar |
| `email` | E-mail |
| `password` | Senha |
| `signInAnonymous` | Entrar anonimamente |
| `or` | ou |
| `noAccount` | Não tem conta? |
| `hasAccount` | Já tem conta? |

### Status
| Chave | Texto |
|---|---|
| `active` | Ativo |
| `inactive` | Inativo |
| `busy` | Ocupado |

### Prioridade
| Chave | Texto |
|---|---|
| `urgent` | Urgente |
| `high` | Alta |
| `medium` | Média |
| `low` | Baixa |

### Temperatura de Lead
| Chave | Texto |
|---|---|
| `hot` | Quente |
| `warm` | Morno |
| `cold` | Frio |

### Ações Comuns
| Chave | Texto |
|---|---|
| `save` | Salvar |
| `cancel` | Cancelar |
| `delete` | Excluir |
| `edit` | Editar |
| `create` | Criar |
| `search` | Buscar |
| `filter` | Filtrar |
| `export` | Exportar |
| `loading` | Carregando… |
| `noResults` | Nenhum resultado encontrado |
| `confirm` | Confirmar |
| `back` | Voltar |

### Capitalização e pontuação
- **Sentence case** em tudo (menu, títulos, abas, botões, cabeçalhos de card, opções de select): "Adicionar nota", "Novo funil", "Campos personalizados". Só nomes próprios e siglas ficam em maiúscula: WhatsApp, Instagram, Messenger, Telegram, Meta, Google, LGPD, Pix, QR code, CSV, UTM, IA.
- "E-mail" com hífen. Reticências com um caractere ("Salvando…"). A IA é feminina ("a IA", "ela responde"); texto na segunda pessoa ("você", "sua equipe").
- `vocabGuard.test.ts` confere os botões e os rótulos de navegação do escopo (`SENTENCE_CASE_SCOPE`).

### Toasts
- **Sucesso:** particípio, sem "com sucesso" e sem exclamação: "Lead criado", "Etapa excluída".
- **Erro:** "Não foi possível {verbo}." + o que fazer, quando houver: "Não foi possível salvar. Tente de novo." A mensagem de `ConvexError` do servidor tem prioridade e aparece como está (`mutationErrorMessage`).

### Glossário resumido
Um nome por conceito, definido em `src/lib/vocab.ts`: **Conversas** (era Caixa de Entrada), **Requer atenção** (Repasses; cada item é um "pedido de ajuda"; ações "Assumir conversa" e "Devolver à IA"), **Funil** e **Etapa** (Pipeline, Board, Estágio), **Atendente IA** (Atendente virtual), **Copiloto** (assistente da equipe), **Sugerir respostas** / **Responder sozinha** (Autopilot), **Resposta sugerida** (rascunho da IA), **WhatsApp oficial (Meta)** e **WhatsApp por QR code** (Cloud API, bridge), **Conectar número**, **Etiqueta** (Tag), **Origem**, **Histórico de alterações** (Auditoria), **Relatórios** (Central), **Agenda** (Calendário), **Descadastrados** (Opt-out), **Ramo de atividade** (Setor do negócio) e **Departamento**, **Atendente** / **Administrador** / **Gerente** (papéis), **Modo quadro** / **Modo lista** e **Filtros salvos** (Visão). Termos técnicos (Webhooks, Chaves de integração, Modelo de IA) só em Configurações › Avançado e em `/developers`. Tabela completa e justificativas: `.claude/plans/frontend-v2/03-reorganizacao-vocabulario.md` §1.2.
