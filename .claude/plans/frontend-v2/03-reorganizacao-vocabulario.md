> Seção do plano Frontend v2 (trilho **R**). Redigida por agente Opus em 04/11/2026 a partir de `inventarios/frontend.md` e `inventarios/textos.md`. **Onde contradizer `00-PLANO-MESTRE.md` (seção 5, decisões I1, I2, I4, I8), vale o plano mestre.** O glossário da §1.2 é o glossário final do programa. Numeração dos ramos: R1 = fv2-01, R2 = fv2-03, R3 = fv2-05, R4 = fv2-07, R5 = fv2-09, R6 = fv2-13, R7 = fv2-17, R8 = fv2-19, R9 = fv2-21, R10 = fv2-25, R11 = fv2-26, R12 = fv2-27, R13 = fv2-28, R14 = fv2-29.

# Plano: arquitetura de informação, vocabulário e reorganização do frontend

Seção do plano de "frontend mais organizado e mais fácil de usar" do HNBCRM. Base: HEAD `41ce687` (v0.78.1), lido do checkout limpo. Fontes de fato: `inv-frontend.md` e `inv-copy.md` (mesma pasta), mais leitura direta de `src/main.tsx`, `src/lib/routes.ts`, `src/lib/orgSwitch.ts`, `layout/{Sidebar,BottomTabBar,AppShell}.tsx`, `Settings.tsx`, `HandoffQueue.tsx`, `Inbox.tsx`, `settings/AiSection.tsx`, `ui/{Button,EmptyState}.tsx`, `vitest.config.mts`, `vite.config.ts`, `package.json` e os geradores de links do backend (`convex/**`).

Esta seção NÃO planeja: (a) o sistema de temas (tokens, 3 temas, alternador) e (b) o assistente de onboarding v2 + ferramentas do Copiloto para configurar o atendente. Ela só define os **contratos** que essas duas seções consomem (marcados com "Contrato").

Público-alvo das decisões: dono de PME, corretor de imóveis, startup pequena. Imagem mental: "WhatsApp Business, só que com funil e um atendente com IA". Toda decisão abaixo é avaliada por duas perguntas: "a pessoa entende a palavra sem treinamento?" e "o próximo PR fica mais fácil de escrever?".

---

## 0. Princípios e restrições que valem para todo o plano

| # | Princípio | Consequência prática |
|---|---|---|
| P1 | **Nenhuma URL existente quebra.** | O backend grava e envia links: `/app/repasses?handoff=`, `/app/entrada?conversation=`, `/app/pipeline?lead=`, `/app/tarefas?task=`, `/app/campanhas?campanha=`, `/app/grupos?post=`, `/app/configuracoes?secao=channels|ai|notifications` (Telegram, e-mail, tabela de notificações, retorno do OAuth da Meta em `convex/lib/metaOAuth.ts`). Esses caminhos e parâmetros continuam canônicos. Renomeamos **rótulos**, não caminhos. |
| P2 | **Frontend apenas.** | Nenhum PR deste plano muda `convex/`. Onde um fluxo precisaria de dado novo do servidor, o item fica em "Fora do escopo" com a dependência explícita. |
| P3 | **Mover antes de mudar.** | Toda decomposição começa com um PR de movimentação literal (mesmo JSX, mesmo comportamento) e só depois altera comportamento. Isso mantém a revisão possível com `git diff --color-moved`. |
| P4 | **Um nome por conceito, definido em código.** | Rótulos de navegação, títulos de página e estados vazios saem de `src/lib/vocab.ts`. Um teste de varredura impede a volta dos termos banidos. |
| P5 | **URL é a fonte da verdade** para entidade aberta, aba e filtro de tela. Preferências pessoais (colunas, último funil) continuam em `localStorage` com try/catch. |
| P6 | **Verificável sem humano.** | Cada PR fecha com `npx tsc -p tsconfig.app.json`, `npx vitest run`, `npx vite build` e asserções `grep`. Nada depende de deployment Convex. |

---

## 1. Vocabulário

### 1.1 Regras de escrita (valem para todo texto visível)

| Regra | Decisão | Exemplo certo | Exemplo errado |
|---|---|---|---|
| Capitalização | **Sentence case** em tudo: menu, títulos, abas, botões, cabeçalhos de card, opções de select. Só nomes próprios e siglas ficam maiúsculos. | "Adicionar nota", "Campos personalizados", "Novo funil" | "Adicionar Nota", "Campos Personalizados", "Nova Pipeline" |
| Nomes próprios | WhatsApp, Instagram, Messenger, Telegram, Meta, Google, LGPD, Pix, QR code. | "Conectar WhatsApp por QR code" | "whatsapp", "qr code", "PIX" |
| E-mail | Sempre "e-mail", com hífen e minúsculo no meio da frase. | "E-mail do contato" | "Email" |
| Reticências | Um caractere "…" em estados de carregamento. | "Salvando…" | "Salvando..." |
| Toast de sucesso | Particípio, sem "com sucesso", sem exclamação. | "Lead criado", "Etapa excluída" | "Lead criado!", "Repasse aceito com sucesso" |
| Toast de erro | "Não foi possível {verbo}." + o que fazer quando houver. Mensagem de `ConvexError` do servidor tem prioridade e é exibida como está. | "Não foi possível salvar. Tente de novo." | "Falha ao salvar", "Erro ao salvar evento" |
| Estado vazio | Título diz o que falta; descrição diz como surge; ação leva ao próximo passo. | "Nenhuma conversa ainda" / "As conversas aparecem aqui quando um cliente manda mensagem para o seu WhatsApp." / [Conectar WhatsApp] | "Nenhum X encontrado" sozinho |
| Pessoa | Segunda pessoa ("você", "sua equipe"). A IA é feminina: "a IA", "ela responde". | "A IA pediu ajuda" | "O bot solicitou handoff" |
| Termos técnicos | Só dentro do grupo de configurações **Avançado** e nas páginas `/developers*`. | "Webhooks" em Avançado | "Sistema de Webhooks" no Painel |

### 1.2 Glossário final (um nome por conceito)

Parti da proposta de `inv-copy.md` §"Glossário proposto". Onde discordo, a coluna "Por quê" explica. "Valor no código" lista ids que **não mudam** (rotas, enums, nomes de função).

| # | Conceito | Nome na interface | Variações que somem | Valor no código (não muda) | Por quê |
|---|---|---|---|---|---|
| 1 | Tela de mensagens | **Conversas** | Caixa de Entrada, Entrada, inbox | rota `/app/entrada`, `Tab "inbox"`, componente `Inbox` | É a palavra do WhatsApp. Já é o título da tela (`Inbox.tsx:1732`). |
| 2 | Fila em que a IA pediu ajuda | **Requer atenção** (menu e título) | Repasses, Fila de Repasses, Repasses pendentes, Repasses IA-Humano | rota `/app/repasses`, `Tab "handoffs"`, `?handoff=` | Diz o que a pessoa deve fazer. Proposta do dono. Ver decisão 1.4. |
| 3 | Um item dessa fila | **Pedido de ajuda** ("A IA pediu ajuda") | repasse, handoff | tabela `handoffs` | Descreve o fato. |
| 4 | Aceitar o pedido | **Assumir conversa** | Aceitar repasse, Assumir | `acceptHandoff` | Verbo único e direto. |
| 5 | Recusar e devolver com instrução | **Devolver à IA** | Rejeitar repasse, Deixar com a IA | `rejectHandoff`, `returnToAi`, `ReturnToAiButton` | Discordo de "Deixar com a IA": "Devolver à IA" já está em uso, é claro e casa com o nome técnico. |
| 6 | Funil de vendas | **Funil** (menu), "funil de vendas" (texto); plural "funis" | Pipeline, Board, Quadro, "Nova Pipeline" | rota `/app/pipeline`, `Tab "board"`, tabela `boards`, `?board=` | Corretor e dono de PME falam "funil". Gênero: "o funil", "Novo funil". |
| 7 | Fase do funil | **Etapa** | Estágio | tabela `stages` | "Etapa" já domina (98 contra 24). |
| 8 | Pessoa/negócio em andamento no funil | **Lead** (masculino: "o lead", "Novo lead") | — | tabela `leads`, `?lead=` | Discordo de "Cliente em potencial": longo, e corretores usam "lead" no dia a dia. Fica num único lugar (`VOCAB.lead`) para o dono trocar depois por "Oportunidade" sem caça manual nos títulos. Primeira aparição na tela vazia do Funil explica: "Lead é alguém interessado que você quer transformar em cliente." |
| 9 | Pessoa na agenda de contatos | **Contato** | — | tabela `contacts` | Termo do WhatsApp. |
| 10 | IA que conversa com clientes | **Atendente IA** (curto: "a IA") | Atendente virtual, Assistente, bot, robô, Atendente com IA | `agentProfile`, `attendant` | Discordo de "Atendente com IA": "Atendente IA" já tem 34 usos e é mais curto para botão. |
| 11 | IA que ajuda a equipe (painel e Telegram) | **Copiloto** (descrição fixa: "assistente da sua equipe") | Copiloto IA, Assistente no app, "Copiloto in-app", assistente | `copilot*` | Discordo de "Assistente da equipe": "Copiloto" é marca já usada no FAB, no Telegram e no CHANGELOG; basta uma frase de descrição. |
| 12 | Modo em que a IA só sugere | **Sugerir respostas** (descrição: "você revisa antes de enviar") | modo sugestão, rascunho, modo rascunho | `mode: "suggest"` | Descreve o efeito. |
| 13 | Modo em que a IA responde sozinha | **Responder sozinha** | Autopilot, autopilot, piloto automático, Automático | `mode: "autopilot"` | Remove o anglicismo; descreve o efeito. |
| 14 | Texto pronto da IA aguardando revisão | **Resposta sugerida** | Rascunho da IA, Sugestão do atendente IA | `AiDraftCard`, `aiDrafts` | Libera "rascunho" para campanhas e publicações. |
| 15 | Campanha/publicação não enviada | **Rascunho** | — | status `draft` | Único sentido de "rascunho". |
| 16 | WhatsApp oficial | **WhatsApp oficial (Meta)** | Cloud API, Cloud API (Meta), API oficial | `provider: "meta"` / cloud | Sem sigla. "API oficial" fica só em Avançado e no assistente de conexão como detalhe. |
| 17 | WhatsApp não oficial | **WhatsApp por QR code** | bridge, gateway, canal não oficial, API não-oficial | `provider: "bridge"`, `convex/lib/bridge*` | Descreve o que a pessoa faz. O aviso de risco de banimento continua, reescrito sem "API". |
| 18 | Conectar um número | **Conectar número** | Provisionar, instância, parear | `provision*`, `pairphone` | Um verbo; a infraestrutura some. "Código de pareamento" vira "código de conexão". |
| 19 | WhatsApp/Instagram/Messenger | **Canal** | — | `channel`, `channelConfigs` | Só esse sentido. |
| 20 | De onde veio o lead/contato | **Origem** | Canal de aquisição, Fonte de leads, UTM Source (rótulo) | `leadSources`, `utm_*` | Separa de "canal". "Fontes de leads" → "Origens dos leads". UTM fica visível como valor, com rótulo "Campanha de anúncio (UTM)" só em Avançado/detalhe. |
| 21 | Etiqueta de classificação | **Etiqueta** | Tag, Tags | `labels`, `tags` | Um nome. |
| 22 | Mensagem de retomada agendada pela IA | **Follow-up** (com hífen, minúsculo no meio da frase) | Retorno, Follow-ups (maiúsculo) | `followUp*` | Discordo de "Retorno": ambíguo (retorno de ligação, devolução). Corretores dizem "follow-up". Sempre acompanhado de descrição na primeira aparição. |
| 23 | Instruções de comportamento | **Jeito de atender** (rótulo do bloco); campo: "Como a IA deve se apresentar e conversar" | Persona | `persona` | "Persona" é jargão. |
| 24 | Base de conhecimento | **O que a IA sabe do seu negócio** | Conhecimento (sozinho) | `knowledge` | Autoexplicativo. |
| 25 | Qualificação BANT | **Qualificação** com os 4 campos "Orçamento", "Quem decide", "Necessidade", "Prazo" | Qualificação BANT, BANT | `bant*` | A sigla aparece só no tooltip de ajuda. |
| 26 | Visualização kanban/lista | **Modo quadro** / **Modo lista**; "Filtros salvos" | Visão Kanban, Visão Lista, Visões salvas, Criar Nova Visão | `views`, `ViewSelector` | "Visão" é calco de "view". |
| 27 | Registro de alterações | **Histórico de alterações** | Auditoria, Logs de Auditoria | rota `/app/auditoria`, `Tab "audit"` | Amigável e descritivo. |
| 28 | Painel de métricas multiunidade (módulo) | **Relatórios** (menu e título) | Central, Painel da Central | rota `/app/central`, `Tab "central"`, módulo `central` | Discordo de "Atendimento por unidade": longo demais para menu. "Relatórios" diz o que a tela é; a permissão já é `reports:view`. |
| 29 | Configuração dos módulos opcionais | **Unidades e departamentos** (painel de Configurações) | Central (aba de Configurações), Módulos | `?secao=central` | Remove o terceiro sentido de "Central". |
| 30 | Departamento da operação | **Departamento** | Setor (nesse sentido) | `departments` | "Setor" fica livre para o ramo do negócio. |
| 31 | Ramo do negócio (onboarding/contato) | **Ramo de atividade** | Setor | `industry`/`sector` | Desfaz a colisão. |
| 32 | Quem pediu para não receber | **Descadastrados** (aba); frase: "Pediu para não receber mensagens" | Opt-out, Lista vazia | `optOuts` | Termo conhecido de e-mail marketing, sem inglês. |
| 33 | Membro de IA com chave de API | **Agente de IA** | Agente IA | `type: "ai"` | Mantém, com preposição. |
| 34 | Papel humano "Agente" | **Atendente** (papel), "Administrador", "Gerente" | Agente (humano), Admin | `role: "agent"`, `"admin"` | Desfaz a colisão com "Agente de IA". |
| 35 | Limites anti-loop | **Limite de respostas seguidas** | Guarda-corpos anti-loop, guardrail | `maxReplies*` | Sem metáfora. |
| 36 | Modelo/roteamento/BYO/fallback | **Modelo de IA** (só em Avançado); "Usar minha própria chave" no lugar de BYO; "modelo reserva" no lugar de fallback | — | `routing`, `byo` | Concentra o técnico. |
| 37 | Chaves API | **Chaves de integração** (Avançado) | Chaves API, Token (rótulo) | `apiKeys`, `?secao=apikeys` | Linguagem de produto. |
| 38 | Webhooks | **Webhooks** (só em Avançado), descrição "avisos automáticos para outros sistemas" | Sistema de Webhooks (no Painel) | `?secao=webhooks` | Quem integra conhece o termo; o leigo não chega até ele. |
| 39 | Agenda (eventos + tarefas por data) | **Agenda** | Calendário | rota `/app/calendario`, `Tab "calendar"` | Palavra de corretor; "Calendário" soa como componente. |
| 40 | Painel inicial | **Painel** | Dashboard, Dashboard Tempo Real | `/app/painel` | Mantém. |

Termos que ficam como estão (já são bons): Tarefa, Projeto, Campanha, Grupo, Formulário, Equipe, Configurações, Transcrição, Ler imagens, Agrupar mensagens, Temperatura (frio/morno/quente), Unidade, Respostas rápidas.

### 1.3 Onde o glossário vive no código

**`src/lib/vocab.ts`** (novo, sem dependências, testado):

```ts
/** Glossário da interface. Fonte única para menu, títulos, estados vazios. */
export const VOCAB = {
  conversations: { one: "conversa", many: "conversas", nav: "Conversas", title: "Conversas" },
  attention:     { nav: "Requer atenção", title: "Requer atenção",
                   subtitle: "Conversas em que a IA pediu ajuda a alguém da equipe",
                   item: "pedido de ajuda", accept: "Assumir conversa", giveBack: "Devolver à IA" },
  funnel:        { one: "funil", many: "funis", nav: "Funil", title: "Funil de vendas", new: "Novo funil" },
  stage:         { one: "etapa", many: "etapas", new: "Nova etapa" },
  lead:          { one: "lead", many: "leads", new: "Novo lead", article: "o" },
  contact:       { one: "contato", many: "contatos", nav: "Contatos", new: "Novo contato" },
  attendant:     { name: "Atendente IA", short: "a IA",
                   modeSuggest: "Sugerir respostas", modeSuggestHint: "Você revisa antes de enviar",
                   modeAuto: "Responder sozinha", draft: "Resposta sugerida" },
  copilot:       { name: "Copiloto", hint: "Assistente da sua equipe" },
  whatsappQr:    "WhatsApp por QR code",
  whatsappOfficial: "WhatsApp oficial (Meta)",
  connectNumber: "Conectar número",
  audit:         { nav: "Histórico de alterações", title: "Histórico de alterações" },
  reports:       { nav: "Relatórios", title: "Relatórios" },
  agenda:        { nav: "Agenda", title: "Agenda" },
  // … demais entradas da tabela 1.2
} as const;

/** Termos que não podem aparecer em texto visível fora da allowlist. */
export const BANNED_UI_TERMS: ReadonlyArray<{ pattern: RegExp; use: string }> = [
  { pattern: /\bRepasses?\b/, use: "Requer atenção / pedido de ajuda" },
  { pattern: /\bHandoffs?\b/, use: "pedido de ajuda" },
  { pattern: /\bPipelines?\b/, use: "Funil" },
  { pattern: /\bBoards?\b/, use: "Funil" },
  { pattern: /\b[Aa]utopilot\b/, use: "Responder sozinha" },
  { pattern: /\bbridge\b/i, use: "WhatsApp por QR code" },
  { pattern: /\bgateway\b/i, use: "(omitir)" },
  { pattern: /\b[Pp]rovision/, use: "Conectar número" },
  { pattern: /\binst[âa]ncia\b/i, use: "(omitir)" },
  { pattern: /\bCaixa de Entrada\b/, use: "Conversas" },
  { pattern: /\b[Ee]st[áa]gios?\b/, use: "Etapa" },
  { pattern: /\bTags?\b/, use: "Etiqueta" },
  { pattern: /\bOpt-out\b/i, use: "Descadastrados" },
  { pattern: /\bLogs? de Auditoria\b/, use: "Histórico de alterações" },
  { pattern: /\bEmail\b/, use: "E-mail" },
  { pattern: /\bVis[ãa]o (Kanban|Lista)\b/, use: "Modo quadro / Modo lista" },
  { pattern: /\bguarda-corpos?\b/i, use: "Limite de respostas seguidas" },
];
```

Quem consome `VOCAB` (obrigatório): `src/lib/nav.ts` (rótulos do menu), `PageHeader` de cada página (título), estados vazios das 14 páginas do menu, `document.title` (ver 2.6). Texto corrido dentro de componentes **não** precisa importar `VOCAB` (seria ruído); ele é protegido pelo teste de varredura.

### 1.4 Como impor: teste de varredura

**`src/lib/vocabGuard.test.ts`** (roda no projeto vitest "lib" atual, com `node:fs` como os guards de `convex/*Port.test.ts`):

1. Lista recursivamente `src/**/*.tsx` e `src/**/*.ts`, exceto `*.test.*`.
2. Extrai **apenas texto visível** com um extrator simples e testado (`src/lib/uiStrings.ts`, puro): texto JSX entre `>` e `<` sem `{`, e literais de string em atributos `title|label|placeholder|aria-label|description` e em chamadas `toast.*(`. Comentários (`//`, `/* */`, `{/* */}`) são removidos antes. Identificadores, imports e nomes de componentes não são texto e não são verificados.
3. Para cada string, aplica `BANNED_UI_TERMS`. Falha com `arquivo:linha — "texto" → use "X"`.
4. **Allowlist** em `src/lib/vocabGuard.allowlist.ts`:
   - por caminho (glob): `src/pages/DevelopersPage.tsx`, `src/pages/PlaygroundPage.tsx`, `src/components/developers/**`, `src/lib/apiRegistry.ts`, `src/pages/{Terms,Privacy}Page.tsx`, `src/components/settings/advanced/**` (Webhooks, Chaves, Modelo de IA podem usar termos técnicos), `src/embed/**`;
   - por termo + caminho (pontual, cada item com motivo): ex. `{ term: "Tags", file: "…/FormSubmissionsPage.tsx", reason: "nome de coluna exportada em CSV" }`.
   - A allowlist tem teto: o teste falha se tiver mais de 30 entradas pontuais (impede que vire lixeira).
5. Segundo teste no mesmo arquivo: **sentence case** em botões. Para texto dentro de `<Button …>…</Button>` e rótulos de `nav.ts`/`SETTINGS_PANELS`, falha se duas ou mais palavras consecutivas (fora a primeira) começarem com maiúscula e não estiverem em `PROPER_NOUNS` (`WhatsApp`, `QR`, `Meta`, `Pix`, `LGPD`, `IA`, `Instagram`, `Messenger`, `Telegram`, `Google`, `CSV`, `UTM`, `API`, `HNBCRM`). Escopo inicial: `ui/`, `layout/`, `settings/`, `Inbox.tsx`, `inbox/`, `HandoffQueue.tsx`, `KanbanBoard.tsx`; o escopo cresce por PR (lista `SENTENCE_CASE_SCOPE` no próprio teste).

Teste do extrator (`src/lib/uiStrings.test.ts`): 10 casos (JSX simples, JSX com expressão, atributo, `toast.error("…")`, comentário ignorado, template literal com `${}` ignora a parte dinâmica, string em `className` ignorada, `aria-label`, texto multilinha, entidade HTML).

Regra escrita em `.claude/rules/frontend.md`, seção "Language and copy": "Glossário em `src/lib/vocab.ts`. Rótulos de menu, títulos de página e estados vazios importam `VOCAB`. Sentence case. Termos técnicos só em `settings/advanced/` e `/developers`. `vocabGuard.test.ts` falha com o termo certo; não adicione allowlist sem motivo."

### 1.5 Decisão: "Requer atenção" é uma página, com atalho em Conversas

**Recomendação: manter a página dedicada (`/app/repasses`), renomeada "Requer atenção", e adicionar um atalho com contagem no topo da lista de Conversas e no cabeçalho da conversa.**

Por quê, em uma linha cada:
- O backend não oferece filtro "com pedido de ajuda pendente" em `conversations.getConversations` (args atuais: `archived`, fila, canal, `limit`); filtrar no cliente sobre o lote de 50 esconderia pedidos fora do lote.
- A página trabalha sobre `handoffs.getHandoffs({status:"pending"})`, que traz motivo, resumo e a espiada (`HandoffPeekSlideOver`); isso não cabe numa linha de conversa.
- Telegram, sino de notificações e e-mail já apontam para `/app/repasses?handoff=<id>`, e "Assumir" já navega para `/app/entrada?conversation=<id>`. Nada disso muda.

O que muda na experiência:
1. Menu: item "Requer atenção" logo abaixo de "Conversas", com o badge vermelho de `getPendingHandoffCount` (já existe).
2. Conversas: quando a contagem > 0, uma faixa no topo da lista: "**3 conversas precisam de você** · Ver" (link para `/app/repasses`). Usa a mesma query de contagem; some com zero.
3. Cabeçalho da conversa com pedido pendente (já detectado por `isHandoffPending`): botões visíveis, não em menu: **Assumir conversa** (primário) e **Devolver à IA** (secundário). Hoje a lógica existe em `Inbox.tsx:846-1056`; o PR 10 só a move para `ConversationHeader` e troca rótulos.
4. Página "Requer atenção": título e subtítulo de `VOCAB.attention`; cartões dizem "A IA pediu ajuda · {motivo}"; botões "Assumir conversa", "Devolver à IA", "Ver conversa" (espiar). Estado vazio: "Tudo em dia" / "Quando a IA precisar de alguém da equipe, a conversa aparece aqui."

---

## 2. Navegação e arquitetura de informação

### 2.1 Modelo declarativo único: `src/lib/nav.ts`

Hoje a lista de itens está duplicada em `Sidebar.tsx:41-56` e `BottomTabBar.tsx:43-61`, com rótulos e ordem diferentes, e o tipo `Tab` mora em um componente (`BottomTabBar.tsx:30`) importado por `lib/routes.ts`.

```ts
// src/lib/nav.ts
import type { PermissionCategory } from "../../convex/lib/permissions";
import type { OrgModuleKey } from "@/hooks/useOrgModules"; // keyof Omit<OrgModules,"demoMode">
import type { Tab } from "./routes";

export type NavGroupId = "atendimento" | "organizacao" | "divulgacao" | "gestao";
export type NavBadgeSource = "inboxUnread" | "pendingAttention" | "pausedCampaigns";

export interface NavItemDef {
  id: Tab;
  label: string;                 // de VOCAB
  icon: LucideIcon;              // import individual de lucide-react
  group: NavGroupId;
  permission?: { category: PermissionCategory; level: string };
  module?: OrgModuleKey;
  badge?: NavBadgeSource;
  mobile: "primary" | "more";
  /** Prefixos extras que ativam o item (sub-rotas). O próprio TAB_ROUTES[id] já conta. */
  matchPrefixes?: string[];
}

export const NAV_GROUPS: ReadonlyArray<{ id: NavGroupId; label: string | null }>;
export const NAV_ITEMS: ReadonlyArray<NavItemDef>;

/** Filtra por permissão e módulo. Pura: recebe `can` e `modules`. */
export function visibleNavItems(can: (c: PermissionCategory, l: string) => boolean,
                                modules: Partial<Record<OrgModuleKey, boolean>>): NavItemDef[];

/** Item ativo por prefixo mais longo; `/app/formularios/abc/submissoes` → "forms". */
export function activeTabForPath(pathname: string): Tab | null;

/** Divide os visíveis em barra inferior (máx. 4) e "Mais". */
export function splitMobile(items: NavItemDef[]): { primary: NavItemDef[]; more: NavItemDef[] };
```

`src/lib/routes.ts` passa a declarar o tipo `Tab` (string union, os mesmos 14 ids) e mantém `TAB_ROUTES` intacto (52 usos). `PATH_TO_TAB` é substituído por `activeTabForPath`; `lib/orgSwitch.ts` passa a usar `activeTabForPath` + `TAB_ROUTES` com o mesmo comportamento (o teste existente `orgSwitch.test.ts` precisa continuar verde sem edição). `BottomTabBar.tsx` reexporta `type Tab` por um PR para não quebrar imports; o PR 5 troca os imports e remove a reexportação.

Hook de badges: `src/hooks/useNavBadges.ts` faz as três `useQuery` que hoje estão nos dois componentes (cada uma com `"skip"` quando o item não está visível) e devolve `Record<NavBadgeSource, number>`. Sidebar e BottomTabBar viram apenas renderizadores do modelo.

### 2.2 Agrupamento proposto

De 14 itens planos para 4 grupos com separador e rótulo discreto (rótulo visível só em `lg`, quando a sidebar está larga).

| Grupo | Item (rótulo) | Rota (inalterada) | Ícone (lucide) | Permissão | Módulo | Badge | Mobile |
|---|---|---|---|---|---|---|---|
| (sem rótulo) | Painel | `/app/painel` | `LayoutDashboard` | — | | | primary |
| Atendimento | Conversas | `/app/entrada` | `MessageSquare` | inbox:view_own | | inboxUnread | primary |
| Atendimento | Requer atenção | `/app/repasses` | `HandHelping` (ou `BellRing`) | inbox:view_own | | pendingAttention | primary |
| Atendimento | Funil | `/app/pipeline` | `Kanban` | leads:view_own | | | primary |
| Atendimento | Contatos | `/app/contatos` | `Contact2` | contacts:view | | | more |
| Organização | Tarefas | `/app/tarefas` | `CheckSquare` | tasks:view_own | | | more |
| Organização | Agenda | `/app/calendario` | `CalendarDays` | tasks:view_own | | | more |
| Divulgação | Campanhas | `/app/campanhas` | `Megaphone` | campaigns:view | | pausedCampaigns | more |
| Divulgação | Grupos | `/app/grupos` | `Users2` | inbox:view_own | | | more |
| Divulgação | Formulários | `/app/formularios` | `FileText` | settings:manage | | | more |
| Gestão | Relatórios | `/app/central` | `BarChart3` | reports:view | central | | more |
| Gestão | Equipe | `/app/equipe` | `Users` | team:view | | | more |
| Gestão | Histórico de alterações | `/app/auditoria` | `ScrollText` | auditLogs:view | | | more |
| Gestão | Configurações | `/app/configuracoes` | `Settings` | settings:view | | | more |

Por quê esta ordem: o fluxo central do produto é "cliente escreve → IA atende → humano entra quando preciso → lead anda no funil"; os três primeiros itens depois do Painel são esse fluxo. Equipe, Histórico e Configurações são de administração e vão para o fim.

**Mobile (barra inferior):** Painel · Conversas · Requer atenção · Funil · **Mais**. O "Mais" abre uma folha (bottom sheet com `Modal`) organizada pelos mesmos grupos, em grade de 3 colunas com ícone + rótulo (alvos de 44 px), e mostra um ponto no botão "Mais" quando algum item escondido tem badge (`pausedCampaigns`). Contatos, Tarefas e Agenda ficam na primeira linha da folha. A troca de organização e "Sair" ficam no rodapé da folha (como hoje).

Por quê Requer atenção na barra e Tarefas não: o pedido de ajuda é urgente e tem contagem; tarefas têm o widget no Painel. A regra está em `NAV_ITEMS[].mobile` e é trocável em uma linha.

**Desktop colapsado (`md`, 64 px):** só ícones; cada botão tem `aria-label` = rótulo e `Tooltip` (primitivo novo, seção 4) em vez de `title`. Separadores finos entre grupos.

### 2.3 Rotas, redirecionamentos e correções do roteador

| Item | Decisão |
|---|---|
| Caminhos existentes | Todos continuam canônicos (P1). Nenhum redirecionamento é necessário porque nenhum caminho muda. |
| 404 | Adicionar `{ path: "*", element: <NotFoundPage/> }` na raiz e `{ path: "*", element: <Navigate to="painel" replace/> }` dentro de `/app` (caminho interno desconhecido volta ao Painel com um toast "Página não encontrada"). `NotFoundPage` lazy, com link para `/` e `/app`. |
| `errorElement` | `RouteErrorPage` no nó raiz e no `/app` (usa `useRouteError`), com "Algo deu errado. Recarregar" e o mesmo visual do `ErrorBoundary`. Evita a tela branca quando um chunk lazy falha após deploy (erro "Failed to fetch dynamically imported module" → botão recarrega). |
| Item ativo em sub-rotas | `activeTabForPath` por prefixo mais longo (testado com as 4 sub-rotas de formulários). |
| `?date=&event=` da Agenda | `UpcomingEventsWidget.tsx:220` já emite; `useCalendarState` passa a ler `date` (`YYYY-MM-DD`), `view` (`day|week|month`) e `event` (abre `EventDetailSlideOver`). Ver seção 6. |
| Código morto | Apagar `src/components/Dashboard.tsx` (stub "Legacy", zero imports). `src/App.tsx` já não existe; corrigir a árvore em `src/CLAUDE.md`. |
| `Tab` em componente | Move para `src/lib/routes.ts` (seção 2.1). |
| Título da aba do navegador | `usePageTitle(VOCAB.x.title)` em cada página (`document.title = "{título} · HNBCRM"`); hoje todas as abas do navegador têm o mesmo título. |

### 2.4 AppShell

- Cabeçalho do shell passa a mostrar o **título da página** no mobile (hoje mostra só a org). O título vem do item ativo do modelo (`NAV_ITEMS`), e a troca de org vai para a folha "Mais" e para a sidebar (onde já está). Isso dá orientação no celular sem breadcrumb.
- `min-h-[calc(100vh-…)]` → `min-h-[calc(100dvh-…)]` (seção 7).
- `copilotOpen` continua local (o Copiloto é sobreposição, não página; abrir por link não é um caso pedido).

---

## 3. Reestruturação de Configurações

### 3.1 Modelo de dois níveis com a URL como verdade

**Decisão:** manter `/app/configuracoes?secao=<painel>` (não usar subcaminhos). Por quê: o backend já gera `?secao=channels|ai|notifications` e o retorno da Meta usa `?secao=channels&meta=…&pendente=…`; um único parâmetro com ids estáveis cobre tudo sem redirecionamento.

- Nível 1 = **grupo** (6 grupos). Nível 2 = **painel** (um formulário ou cartão de assunto único). O `secao` sempre aponta para um **painel**; o grupo é derivado.
- `/app/configuracoes` sem `secao`:
  - **mobile:** lista de grupos e painéis (estilo ajustes do celular: ícone, nome, uma linha de descrição, chevron). Tocar abre o painel com botão "Voltar" no `PageHeader` (que volta para a lista via `navigate(-1)` quando a origem foi a lista, senão `?secao=` vazio).
  - **desktop:** coluna lateral de navegação (grupos com rótulo + painéis) e o painel `general` aberto à direita.
- Clicar num painel **escreve** `?secao=` com `setSearchParams` (push, para o "voltar" funcionar). Param desconhecido → lista (mobile) ou `general` (desktop), sem erro.
- Busca: campo "Buscar nas configurações" no topo da lista. Filtra por `label` + `keywords` (ex.: painel `ai-features` tem keywords "transcrição, áudio, imagem, visão, grupos, telegram"). Puro, em `src/lib/settingsSearch.ts`, testado. Responde ao pedido "onde fica a transcrição?" sem decorar o menu.
- Ids legados `ai`, `apikeys`, `fields`, `sources`, `webhooks`, `channels`, `data`, `notifications`, `central`, `general` continuam sendo ids de painel válidos (P1).

**Registro:** `src/components/settings/registry.ts`

```ts
export type SettingsGroupId = "conta" | "whatsapp" | "atendente" | "equipe" | "dados" | "avancado";
export interface SettingsPanelDef {
  id: string;                       // valor de ?secao=
  group: SettingsGroupId;
  label: string;                    // sentence case
  description: string;              // uma linha
  icon: LucideIcon;
  keywords?: string[];
  permission?: { category: PermissionCategory; level: string };
  visible?: (ctx: { can: Can; modules: OrgModules; aiActive: boolean }) => boolean;
  /** Painel renderizado; lazy para não carregar o atendente ao abrir "Geral". */
  Component: React.LazyExoticComponent<(p: { organizationId: Id<"organizations"> }) => React.JSX.Element>;
  /** Alternativa a Component: link para outra rota (ex.: Equipe). */
  href?: string;
}
export const SETTINGS_GROUPS: ReadonlyArray<{ id: SettingsGroupId; label: string }>;
export const SETTINGS_PANELS: ReadonlyArray<SettingsPanelDef>;
export function resolveSettingsPanel(param: string | null, visible: SettingsPanelDef[]): SettingsPanelDef | null;
```

`resolveSettingsPanel` e o filtro de visibilidade ficam puros em `src/lib/settingsNav.ts` com testes (ids legados, id desconhecido, painel invisível por permissão cai no primeiro visível do mesmo grupo).

### 3.2 Grupos e painéis

| Grupo | Painel (`?secao=`) | Rótulo | Conteúdo (origem atual) | Permissão para ver |
|---|---|---|---|---|
| **Conta** | `general` | Dados da empresa | `OrgProfileSection` (nome, fuso, moeda, país padrão). Fusos traduzidos como no onboarding (`WizardStep1Welcome.tsx:62-70`); extrair a lista para `src/lib/timezones.ts` e usar nos dois. | settings:view |
| Conta | `appearance` | Aparência | **Contrato com a seção de temas**: o registro reserva o id e o lugar; o componente `AppearancePanel` é entregue pela seção de temas. Até lá, o painel não aparece (`visible: () => false`). | todos |
| Conta | `notifications` | Notificações | `NotificationPreferences` + `TelegramCard` (vínculo do Copiloto no Telegram). | settings:view |
| **WhatsApp e canais** | `channels` | Números conectados | Lista de canais (`ChannelCard`), botão "Conectar número" (`ChannelConnectCard`), QR em modal, saúde do canal, histórico, grupos do número. | settings:view |
| WhatsApp e canais | `instagram` | Instagram e Messenger | `MetaMessagingCard` + `MetaChannelCards` (hoje dentro de Canais). Só com o módulo `metaMessaging` ou `settings:manage`. | settings:view |
| **Atendente IA** | `ai` | Visão geral | Liga/desliga a IA, aceite LGPD (`ActivationCard`), assistente de ativação (`ActivationWizardCard`), status do atendente, modo (Sugerir respostas / Responder sozinha) e botão "Testar a IA" (simulador). Id legado `ai` cai aqui. | settings:view |
| Atendente IA | `ai-attendant` | Jeito de atender | `AttendantPersonaForm` + `AttendantKnowledgeForm` + `AttendantHoursForm`. | settings:view (edição: manage) |
| Atendente IA | `ai-conversation` | Comportamento na conversa | `ConversationBehaviorForm` (agrupar mensagens, limites de respostas seguidas, proteção contra robôs), `FunnelRulesForm` (funil e etapa inicial, mover etapa ao qualificar). | idem |
| Atendente IA | `ai-handoff` | Quando chamar a equipe | `HandoffRulesForm` (palavras que chamam alguém, motivos, horário fora → espera). | idem |
| Atendente IA | `ai-followup` | Follow-ups | `FollowUpForm` (modo, encadeamento, janela de envio, teto diário). | idem |
| Atendente IA | `ai-features` | Recursos da IA | `FeatureToggleCard` ×N: **Ouvir áudios (transcrição)** com a lista de números e o toggle por canal (mesma mutação do `ChannelCard`), **Ler imagens**, IA em grupos, IA no WhatsApp por QR code (`BridgeAiCard`, aceite de risco), Copiloto, Copiloto no Telegram (atalho para `notifications`). Agenda externa (`ExternalAgendaSection`). | idem |
| Atendente IA | `ai-usage` | Uso e limites de gasto | `UsageCard` (uso do mês, orçamento, teto). | settings:view |
| **Equipe** | `team` | Membros e permissões | `href: "/app/equipe"` (a página continua onde está; o painel é um atalho). | team:view |
| **Dados** | `data` | Importar e exportar | `DataSection` + `ImportWizard`. | settings:view |
| Dados | `fields` | Campos personalizados | `CustomFieldsSection` (abas Lead/Contato com `Tabs`). | settings:view |
| Dados | `sources` | Origens dos leads | `LeadSourcesSection`. | settings:view |
| **Avançado** | `central` | Unidades e departamentos | `CentralSection` (módulos opcionais, unidades, departamentos, investimento em anúncios). Mesma regra de hoje: `manage || anyModuleEnabled`. | settings:view |
| Avançado | `ai-models` | Modelo de IA e privacidade | Seletores de roteamento (`RoutingSelect*`, hoje em `FeatureTogglesCard`) + `PrivacyCard` (provedor, "usar minha própria chave"). | settings:manage |
| Avançado | `apikeys` | Chaves de integração | `ApiKeysSection`. | settings:view |
| Avançado | `webhooks` | Webhooks | `WebhooksSection`. | settings:view |

Arquivos: os painéis técnicos vão para `src/components/settings/advanced/` (é onde o guard de vocabulário permite termos técnicos).

### 3.3 Onde cada pedido típico passa a ficar (≤ 2 cliques)

Cliques contados a partir do shell, no desktop. No mobile soma-se 1 ("Mais").

| O usuário procura | Antes (inv-frontend §3) | Depois | Cliques |
|---|---|---|---|
| Transcrição de áudio | Configurações → Canais → card do canal (3) | Configurações → Atendente IA › **Recursos da IA** (toggle por número). Também continua no card do número. Busca "transcrição" acha. | 2 |
| Ler imagens (visão) | Configurações → IA → Produtos (2-3, só com IA ativa) | Configurações → Atendente IA › Recursos da IA | 2 |
| Persona | IA → Atendente → Personalizar → bloco (3-4) | Configurações → Atendente IA › Jeito de atender | 2 |
| Horário, comportamento, repasse, follow-up | 3-4, dentro de bloco de 1100 linhas | um painel cada (tabela 3.2) | 2 |
| QR do WhatsApp | Canais → card → botão (3 + modal) | Configurações → WhatsApp e canais › Números conectados → "Mostrar QR code" visível no card quando desconectado (botão primário). Também: faixa "WhatsApp desconectado · Reconectar" no topo de Conversas (já há sinal de saúde do canal). | 2 (+modal) |
| Testar a IA (simulador) | 4 | Atendente IA › Visão geral → "Testar a IA" | 2 (+modal) |
| Uso/custo | final de página longa | Atendente IA › Uso e limites de gasto | 2 |

### 3.4 Formulários compartilhados (contrato com o onboarding v2)

Padrão obrigatório para os formulários extraídos de `AiSection` e `ChannelsSection`: **separar campos (controlados, sem dados) de painel (carrega e salva)**. O assistente de onboarding monta os mesmos campos dentro dos seus passos e decide quando salvar.

```ts
// Contrato genérico dos formulários de configuração
export interface ConfigFormProps<T> {
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
  /** Erros por campo, vindos de validate(). */
  errors?: Partial<Record<keyof T, string>>;
  /** "panel" mostra títulos e descrições completos; "wizard" mostra versão enxuta. */
  variant?: "panel" | "wizard";
}
// Cada formulário exporta também, em src/lib/attendantConfig.ts:
//   fromProfile(profile): T      — lê do agentProfile atual
//   toPatch(value: T): AgentProfilePatch — monta o patch PARCIAL de updateAgentProfile
//   validate(value: T): Partial<Record<keyof T, string>>
```

A mutação `api.aiSettings.updateAgentProfile({agentMemberId, patch})` já aceita patch parcial (`convex/aiSettings.ts:841`), então cada painel salva só o seu pedaço. Persona e conhecimento continuam carregados via `getAttendantTexts` só quando o painel abre e só para `settings:manage` (regra de `AiSection.tsx:1391-1400`: sem os textos carregados, o patch **não** inclui `persona`/`knowledge`, senão gravaria vazio). Essa regra vira teste de `toPatch`.

| Componente (arquivo) | Campos | Origem atual | Usado por |
|---|---|---|---|
| `AttendantPersonaForm` (`settings/attendant/AttendantPersonaForm.tsx`) | nome da IA, tom (`PERSONAS`), "Como a IA deve se apresentar e conversar" | `AiSection.tsx:87-93`, `:1849-1880` | painel `ai-attendant`, onboarding |
| `AttendantKnowledgeForm` | "O que a IA sabe do seu negócio" | `:1855` | idem |
| `AttendantHoursForm` | horário de atendimento, fuso, comportamento fora do horário | `:1884-1917` | idem |
| `ConversationBehaviorForm` | agrupar mensagens (1-120 s), limites por conversa/hora (0 = sem limite), proteção contra robôs + etiqueta | `:1918-2063` | `ai-conversation` |
| `FunnelRulesForm` | funil e etapa inicial, permitir mover etapa, regras de avanço | `:2243-2300` | `ai-conversation`, onboarding |
| `HandoffRulesForm` | palavras que chamam a equipe, motivos | `:2226-2240` | `ai-handoff`, onboarding |
| `FollowUpForm` | modo, encadeamento máx., janela, teto diário | `:1326-1366`, `:2064-2225` | `ai-followup` |
| `AttendantModeSwitch` | Sugerir respostas / Responder sozinha + aceite de risco antecipado | `:1532-1800` | `ai`, onboarding |
| `FeatureToggleCard` (`settings/ai/FeatureToggleCard.tsx`) | ícone, título, descrição, `Switch`, slot de detalhe, aviso | padrão de `FeatureTogglesCard` `:516-813` | `ai-features`, onboarding |
| `ChannelConnectCard` (`settings/channels/ChannelConnectCard.tsx`) | escolha WhatsApp oficial / por QR code, aviso de risco, botão "Conectar número", estado do QR | `ProviderChooser` `:1415`, `BridgeForm` `:1686`, `BridgeQrModal` `:1128` | painel `channels`, onboarding |
| `ChannelTranscriptionToggle` | toggle de transcrição de um canal | `ChannelCard` `:750-775` | `channels`, `ai-features` |
| `AttendantSimulatorButton` | botão + `SimulatorModal` | `:2465-2695` | `ai`, onboarding (passo "teste sua IA") |

**Contrato com a seção de onboarding:** o onboarding importa apenas esses componentes e as funções `fromProfile/toPatch/validate` de `src/lib/attendantConfig.ts`; não importa nada de `settings/AiSection.tsx`. Os ids de painel (`channels`, `ai`, `ai-attendant`, `ai-handoff`, `ai-features`) são os destinos estáveis para "Primeiros passos" e para o Copiloto ("abra Configurações → …").

---

## 4. Primitivos de UI

### 4.1 Infra de teste de componente

`package.json` não tem `@testing-library/*` nem `jsdom` (verificado). `vitest.config.mts` usa `environment: "edge-runtime"` com `include: ["convex/**/*.test.ts","src/**/*.test.ts"]` e não tem alias `@`.

Mudanças:

```ts
// vitest.config.mts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

const alias = { "@": path.resolve(__dirname, "./src") };

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "backend-e-lib",
          environment: "edge-runtime",
          server: { deps: { inline: ["convex-test"] } },
          include: ["convex/**/*.test.ts", "src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "componentes",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["./src/test/setup.ts"],
        },
      },
    ],
  },
});
```

- devDependencies novas: `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `jsdom` (versões estáveis atuais; o lockfile registra a exata; CI usa `npm ci`).
- `src/test/setup.ts`: `import "@testing-library/jest-dom/vitest"`, `afterEach(cleanup)`, stub de `window.matchMedia` (para `useMediaQuery`) e de `ResizeObserver`.
- `src/test/render.tsx`: `renderWithRouter(ui, { route })` com `createMemoryRouter`. Componentes que usam Convex não entram em teste de componente neste plano (sem mock de `useQuery`); testes de componente cobrem primitivos e componentes puros de apresentação (que recebem dados por props). Isso é proposital: obriga a separar apresentação de dados.
- Verificar no PR 1 que a suíte backend continua com o mesmo número de testes (`npx vitest run --project backend-e-lib` antes/depois). O `{ retry: 2 }` de `groupMediaPolicy.test.ts` não é tocado.
- Rótulos dos projetos ficam em português porque aparecem no relatório; nomes de arquivo continuam em inglês.

### 4.2 Primitivos novos ou ampliados

Todos em `src/components/ui/`, export nomeado, `interface XProps`, com `X.test.tsx` ao lado.

| Primitivo | Props (esboço) | Comportamento e a11y | Substitui | Teste de componente |
|---|---|---|---|---|
| `Switch` | `checked`, `onCheckedChange(b)`, `label`, `description?`, `disabled?`, `size?: "sm"|"md"`, `id?` | `button role="switch" aria-checked`, rótulo clicável, alvo ≥ 44 px (área de toque com padding mesmo no `sm`), foco visível | 7 funções (`AiSection.tsx:48`, `CentralSection.tsx:116`, 5 `ToggleSwitch` em `forms/builder/*`) + 12 arquivos com `role="switch"` inline | clique e Espaço alternam; `disabled` não alterna; `aria-checked` reflete prop |
| `Tabs` | `value`, `onValueChange`, `items: {id,label,icon?,badge?,disabled?}[]`, `ariaLabel`, `variant?: "underline"|"pills"`; `TabPanel id` | `role="tablist"/"tab"/"tabpanel"`, `aria-selected`, `aria-controls`, roving tabindex, setas ←/→, Home/End; rolagem horizontal com snap no mobile (sem quebra em várias linhas) | abas ad-hoc de `LeadDetailPanel:102`, `ContactDetailPanel:97`, `Settings:447`, `PublishDialog:104`, `FormAnalyticsPage:306`, `CentralPage`, `GroupsPage`, `GroupAudienceTabs` | setas movem foco e selecionam; `aria-selected` único; item desabilitado é pulado |
| `SegmentedControl` | `value`, `onValueChange`, `options: {value,label,icon?}[]`, `ariaLabel`, `size?` | `role="radiogroup"` + `role="radio"`, setas | "Todas/Diretas/Grupos" (`Inbox.tsx:150`, `aria-pressed`), Modo quadro/lista, Ativas/Arquivadas, visão da Agenda | seleção por clique e setas; `aria-checked` |
| `Select` | `value`, `onValueChange`, `options: {value,label,disabled?}[]` ou `groups`, `placeholder?`, `label?`, `hint?`, `error?`, `disabled?`, `size?` | **`<select>` nativo estilizado** (decisão: nativo dá o seletor do sistema no celular, acessível e sem dependência); seta via ícone; `text-base md:text-sm` (sem zoom no iOS) | 111 `<select>` crus e 5+ constantes `SELECT_CLASS/SELECT_CLS`; migração começa em Settings e Inbox | muda valor, mostra erro com `aria-invalid` + `aria-describedby` |
| `FormField` | `label`, `htmlFor`, `hint?`, `error?`, `required?`, `children` | liga label/hint/erro por id (`useId`), "(opcional)" quando não `required` e `showOptional` | rótulos copiados `text-[13px] font-medium …` (ex. `AiSection.tsx:2247`), 36 `<textarea>` sem wrapper | `getByLabelText` acha o filho; erro anunciado |
| `Textarea` | `label?`, `hint?`, `error?`, `autoGrow?`, `maxLength?` com contador | usa `FormField` | `<textarea>` crus | contador, autoGrow |
| `PageHeader` | `title`, `subtitle?`, `actions?: ReactNode`, `back?: { to: string } | { onClick }`, `badge?` | `<h1>` único por página (hoje mistura h1/h2); botão voltar com `aria-label="Voltar"`; ações quebram para baixo no mobile | 14 títulos de página escritos à mão | renderiza h1; voltar chama handler |
| `SectionCard` | `title`, `description?`, `icon?`, `actions?`, `children`, `as?: "section"` | `<section aria-labelledby>` com `<h2>` | 46 `h3 text-lg font-semibold` de cards | heading ligado à seção |
| `Tooltip` | `content`, `children` (um elemento focável), `side?` | Abre em hover **e** foco; no toque abre em **pressão longa** (500 ms) ou em toque se o gatilho não tiver outra ação (`asInfo`); fecha com Esc e toque fora; `aria-describedby`; sem dependência externa | 322 `title=` (migração progressiva: ícone-only primeiro) e `BantInfoTooltip` | foco abre; Esc fecha; `aria-describedby` presente |
| `Popover` + `Menu` | `Popover`: `open`, `onOpenChange`, `anchor` (ref), `side`, `align`; `Menu`: `trigger`, `items: {label,icon?,onSelect,danger?,disabled?}[]` | Portal no `body`; posição calculada por função pura `computePopoverPosition(anchorRect, popSize, viewport, side, align)` em `src/lib/popoverPosition.ts` (testada) com flip e clamp; no mobile (`useMediaQuery("(max-width: 767px)")`) o `Menu` vira bottom sheet; `role="menu"/"menuitem"`, setas, Esc devolve foco ao gatilho | `LeadActionsMenu`, `ConversationActionsMenu`, `ProjectSwitcher` (usa `window.innerWidth`), `StageEditPopover` (`KanbanBoard:450`), `SavedFiltersMenu` | setas, Esc, foco volta; posição: 6 casos puros (flip em cima/baixo, clamp esquerdo/direito) |
| `Stepper` | `steps: {id,label}[]`, `current`, `completed?: string[]`, `orientation?`, `onStepClick?` | `<ol>` com `aria-current="step"`; no mobile mostra "Passo 2 de 5 · Nome" | `ImportWizard.StepTrail`, `WizardStepIndicator`, indicadores de `CampaignWizard` e `GroupPostWizard` (o onboarding v2 usa este) | `aria-current` no passo atual; clique só em concluídos |
| `EmptyState` (ampliado) | + `secondaryAction?`, `action.href?` (renderiza `Link`), `size?: "sm"|"md"`, `children?` | ícone 40 px, título `h2`/`h3` configurável | estados vazios só com título | renderiza link quando `href` |
| `Button` (ampliado) | + `loading?: boolean` (spinner + `aria-busy`, desabilita), `iconOnly?: boolean` (exige `aria-label` no tipo: `iconOnly: true` ⇒ `"aria-label": string`), tamanhos com área de toque (ver 7.1) | | 23 `setSaving` manuais com texto trocado; botões ícone-only | `loading` desabilita e anuncia; tipo exige `aria-label` (teste de tipo com `// @ts-expect-error`) |
| `SearchInput` | `value`, `onValueChange` (debounced via `useDebouncedValue`), `placeholder`, `onClear` | ícone, botão limpar com `aria-label="Limpar busca"` | buscas ad-hoc de Contacts, Team, Inbox, TaskFiltersBar; debounces manuais `Inbox.tsx:308`, `ContactsPage.tsx:50` | limpar zera; debounce com fake timers |

Hook de apoio: `src/hooks/useMediaQuery.ts` (com teste) substitui o breakpoint manual de `CopilotFab.tsx:68-70` e os cálculos com `window.innerWidth` dos menus.

Não entra agora: DatePicker próprio (o nativo `datetime-local` é bom no celular), Drawer de filtros (vem com `Popover`/`Modal` no mobile), biblioteca de headless UI (decisão: sem dependência nova de runtime; os 10 primitivos acima são pequenos e testados).

---

## 5. Decomposição dos componentes gigantes

Regra geral (P3): **PR de mover** (mesmos nomes internos, mesmo JSX, só cortes e imports; o diff revisado com `git diff --color-moved=dimmed-zebra` mostra quase tudo como movido) seguido, quando necessário, de **PR de mudar**. Lógica pura sai para `src/lib/*.ts` com teste no mesmo PR em que sai.

### 5.1 `Inbox.tsx` (3103 linhas; `Inbox()` de 186 a 3043)

Arquivos-alvo:

| Arquivo | Conteúdo (linhas atuais) |
|---|---|
| `src/lib/inboxState.ts` (+ teste) | `activeBotSuspicion`, `isHandoffPending`, `aiStateChipInfo`, `readKindFilter` (113-170); filtro client-side de lista (631-650) como `filterConversations(list, {kind,labelId})`; chave de lote `listFilterKey` |
| `src/hooks/useInboxFilters.ts` | arquivadas, etiqueta, direto/grupo, canal/conta, fila (186-340). **URL**: `archived=1`, `label=<id>`; direto/grupo e canal continuam em `localStorage` (preferência), seção 6 |
| `src/hooks/useConversationList.ts` | paginação 50→500, `useKeepPrevious`, scroll infinito da lista (339-470) |
| `src/hooks/useConversationSelection.ts` | `?conversation=` ↔ estado com a janela de corrida documentada (1271-1490, incluindo os refs de 1347-1378), `?nova=`, rascunho vindo de `location.state` |
| `src/hooks/useBulkConversationSelection.ts` | seleção múltipla e ações em lote (1490-1711) |
| `inbox/ConversationList.tsx` | JSX da lista (1712-2314): cabeçalho, filtros (`SegmentedControl`, `Select`), faixa "Requer atenção", itens, vazio, "Carregar mais" |
| `inbox/ConversationListItem.tsx` | uma linha (avatar, nome, prévia, hora, badges, chip IA) |
| `inbox/ConversationHeader.tsx` | cabeçalho da conversa: contato, canal, etapa do funil, chip de estado da IA, **Assumir conversa / Devolver à IA**, suspeita de robô, ações (`Menu`) (790-1056 + JSX) |
| `inbox/ConversationThread.tsx` | mensagens, paginação para cima, âncora/auto-scroll, markread, presença/typing (480-625, 1057-1120, 2315-2700) — **compartilhado com o lead** |
| `inbox/Composer.tsx` | texto, nota interna, respostas rápidas, emoji, anexos, voz, agendamento, janela de 24 h (480-625, 1120-1260, 2700-2904). Props `features: { voice?: boolean; schedule?: boolean; internalNote?: boolean }` |
| `inbox/useGroupMode.ts` | menções e nomes por JID (676-790) |
| `inbox/InboxOverlays.tsx` | painéis sobrepostos lead/contato/membros/resumo (2905-3043) |
| `Inbox.tsx` | orquestra (meta: < 400 linhas) |

Contratos de props (para o lead reutilizar):

```ts
interface ConversationThreadProps {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  variant?: "page" | "embedded";      // embedded = dentro do LeadDetailPanel
  onOpenLead?: (leadId: Id<"leads">) => void;
}
interface ComposerProps {
  organizationId: Id<"organizations">;
  conversationId: Id<"conversations">;
  canReply: boolean;
  features?: { voice?: boolean; schedule?: boolean; internalNote?: boolean; quickReplies?: boolean };
  onSent?: () => void;
}
```

Rede de segurança (checklist que o PR copia na descrição e o agente verifica por leitura do diff e por testes):
- `?conversation=<id>` abre a conversa mesmo fora do lote carregado e mesmo arquivada (`ConversationDeepLinkResolver` sob `ErrorBoundary`); id inválido não derruba a tela.
- Abrir outra conversa limpa params velhos na mesma escrita; "voltar" do navegador fecha/reabre.
- `?nova=` abre o modal de nova conversa; `location.state` com rascunho preenche o composer.
- Trocar o filtro de servidor volta o lote para 50; filtros só de tela mantêm o lote.
- Faixa de pedido pendente, Assumir (navega/abre a conversa e toast) e Devolver à IA funcionam em conversa direta e em grupo (`pendingGroupHandoff` × `pendingLeadHandoff`).
- Chip "IA preparando resposta…" / "IA em espera: …" continua.
- Voz, reação, transcrever, descrever imagem, baixar mídia, agendar e cancelar agendamento continuam.
- Seleção múltipla: arquivar/desarquivar com o toast de contagem correto.
- Contagem de não lidas e badge da sidebar continuam (dependem do backend, não mudam).
- Testes novos: `inboxState.test.ts` (todas as funções puras) e `ConversationListItem.test.tsx` (apresentação por props).

### 5.2 `LeadDetailPanel.tsx` (2259)

| Arquivo | Conteúdo |
|---|---|
| `leads/detail/LeadDetailPanel.tsx` | shell + `Tabs` (aba na URL: `leadTab`) |
| `leads/detail/LeadActionsMenu.tsx` | 177-301, usando `Menu` |
| `leads/detail/LeadConversationTab.tsx` | **substitui 302-975** por `ConversationThread variant="embedded"` + `Composer features={{voice:false, schedule:false}}` + seletor de conversa quando o lead tem mais de uma |
| `leads/detail/LeadDetailsTab.tsx` | 1336-2024, dividido em `LeadContactBlock`, `LeadOwnerStageBlock`, `LeadQualificationBlock` (antigo BANT), `LeadCustomFieldsBlock`, `LeadDocumentsBlock` |
| `leads/detail/LeadTasksTab.tsx`, `LeadActivityTab.tsx` | 2025-2259 |
| `src/lib/leadFields.ts` (+ teste) | `toDateInputValue` (1080) e validações de qualificação |
| `LeadDetailPanel.tsx` (raiz) | reexporta por compatibilidade até o fim do PR seguinte |

Ganho: remove ~670 linhas duplicadas e faz o lead ganhar automaticamente as correções futuras do Inbox. Safety net: comportamento listado em `LeadDetailPanel.tsx:318-570` (comentários "Paridade com o Inbox"): markread, presença nossa e do contato, janela de serviço, auto-scroll, scroll infinito para cima, respostas rápidas, emoji. O lead não ganha voz nem agendamento (paridade com hoje; decisão consciente, mudar é um flag).

### 5.3 `settings/AiSection.tsx` (3309)

| Arquivo | Conteúdo (linhas atuais) |
|---|---|
| `src/lib/attendantConfig.ts` (+ teste) | constantes e validações 1215-1325 (`readDebounceSeconds`, `debounceWarning`, `readReplyLimit`, `replyLimitWarning`, `readFollowUp*`), `fromProfile/toPatch/validate` por formulário (3.4), `formatBrlApprox/formatUsd/parseDecimal` (2716-2729) → `src/lib/format.ts` |
| `settings/ai/AiOverviewPanel.tsx` | `ActivationWizardCard/Modal` (157-358), `ActivationCard` (933-1081), `AttendantCard` (1083-1173), `AttendantModeSwitch` |
| `settings/ai/FeatureToggleCard.tsx`, `settings/ai/AiFeaturesPanel.tsx` | `FeatureTogglesCard` (516-813) sem os seletores de modelo; `BridgeAiCard` (815-931); `ChannelTranscriptionToggle` por número |
| `settings/attendant/*Form.tsx` + `*Panel.tsx` | os formulários de 3.4, a partir de `AttendantConfig` (1368-2463) |
| `settings/ai/SimulatorModal.tsx` | 2424-2695 |
| `settings/ai/UsagePanel.tsx` | 2697-2994 |
| `settings/advanced/AiModelsPanel.tsx` | `RoutingSelect*`, `RouteNote`, `ProductRow` (343-514) + `PrivacyCard` (2996-3309) |
| `settings/AiSection.tsx` | removido no PR 8 (o registro aponta para os painéis); `?secao=ai` cai em `AiOverviewPanel` |

Safety net:
- `toPatch` nunca inclui `persona`/`knowledge` se os textos não foram carregados (teste).
- Autopilot antecipado continua exigindo o aceite (`autopilotRiskAck`) e o modal de risco.
- Validações produzem as mesmas mensagens de hoje (teste de tabela com os textos atuais, depois ajustados ao glossário no mesmo PR).
- Sem `settings:manage` os campos ficam travados com aviso, nunca em "Carregando…" para sempre.
- Etiqueta da proteção contra robôs usa `validateBotGuardTag` (já compartilhada); com proteção desligada volta ao padrão.
- Janela de follow-up: início < fim.

### 5.4 `settings/ChannelsSection.tsx` (1985)

| Arquivo | Conteúdo |
|---|---|
| `settings/channels/ChannelsPanel.tsx` | 159-590 (lista, retorno OAuth da Meta lendo `meta/pendente/state`, handlers) |
| `settings/channels/ChannelCard.tsx` | 592-883, com `ChannelTranscriptionToggle` extraído |
| `settings/channels/BridgeHistoryPanel.tsx`, `BridgeQrModal.tsx` | 884-1353 |
| `settings/channels/ChannelConnectCard.tsx` | `ChannelFormModal` + `ProviderChooser` + fluxo (1354-1490) |
| `settings/channels/MetaForm.tsx`, `QrCodeConnectForm.tsx` | 1491-1985 (antigo `BridgeForm`; o nome de arquivo pode manter `Bridge` porque é código, mas o texto visível muda) |
| `src/lib/channelBadges.ts` (+ teste) | helpers de badge 112-158 |

Safety net: retorno OAuth `?secao=channels&meta=…&pendente=…` funciona e limpa os params; QR renova sozinho; modo gerenciado só mostra "Conectar número"; campos de instância/admin token só aparecem no modo manual (que vira bloco "Avançado" recolhido); segredos mascarados.

### 5.5 `KanbanBoard.tsx` (1787)

| Arquivo | Conteúdo |
|---|---|
| `funnel/FunnelPage.tsx` (antigo `KanbanBoard()` 670-1787, orquestração) | |
| `funnel/LeadCard.tsx`, `funnel/StageColumn.tsx` | 125-337 |
| `funnel/QuickAddLead.tsx` | 338-414 |
| `funnel/StageEditPopover.tsx` | 415-563, usando `Popover` (some o `window.innerWidth`) |
| `funnel/AddStageColumn.tsx` | 564-650 |
| `funnel/FunnelToolbar.tsx` | busca, filtros, modo quadro/lista (`SegmentedControl`), seletor de funil |
| `funnel/FunnelDialogs.tsx` | os ~12 modais montados em 1583-1771 |
| `src/lib/funnelFilters.ts` (+ teste) | labels/variantes (92-123), filtro client-side (845), ordenação (886) |
| `src/hooks/useFunnelUrlState.ts` | `board`, `lead`, `view`, `q`, filtros (seção 6) |

`KanbanBoard.tsx` continua exportando `KanbanBoard` (reexport de `FunnelPage`) para não mexer em `main.tsx` além do necessário.

Safety net: `?board=` e `?lead=` (abre o painel, param sincronizado com "voltar"); último funil por org em `localStorage`; arrastar entre etapas chama a mesma mutação (porta única `moveLeadToStageCore` no servidor; o front não muda a chamada); ações em lote; motivo de fechamento ao mover para Ganho/Perdido.

### 5.6 Tarefas: `TaskDetailSlideOver` duplicado

- Renomear `components/calendar/TaskDetailSlideOver.tsx` (284) para `calendar/TaskQuickView.tsx` (é uma visão resumida da agenda) com botão "Abrir tarefa" que navega para `/app/tarefas?task=<id>`. Some a ambiguidade de nome.
- O grande (1600) vai para `tasks/detail/`: `TaskDetailSlideOver.tsx` (shell + navegação em pilha), `TaskFields.tsx` (914-1079), `TaskAiFollowUp.tsx` (898 + `FollowUpCard` 1437), `TaskComments.tsx` (1242-1361, usa `MentionTextarea`; `detectMentionTrigger` (90-118) sai para `src/lib/mentions.ts`, que já existe, com teste), `TaskActionsBar.tsx` (665-807).
- `TasksPage.tsx`: `StatusBoardView` e família (1044-1288) são substituídos por `tasks/TaskKanbanBoard.tsx` se a paridade for confirmada por leitura; senão ficam e o PR registra a diferença.

### 5.7 `ContactDetailPanel.tsx` (1002) e `ContactsPage`

- `contacts/detail/ContactDetailPanel.tsx` com `Tabs` (`contactTab`: `info|leads|groups`), `ContactInfoTab` (os 9 `CollapsibleSection` viram 4: Dados, Endereço e empresa, Origem, Etiquetas e notas), `ContactLeadsTab` (`LinkedLeadCard`), `ContactGroupsTab`, `ContactOptOutControl`.
- `formatRelativeDate` (703) → `src/lib/format.ts`.
- `ContactsPage`: contato aberto passa para a URL (`?contact=<id>`), busca `?q=` (replace), página `?page=`.

### 5.8 `Settings.tsx` (945)

Vira a casca de dois níveis (seção 3) com < 200 linhas. As cinco seções inline vão para arquivos: `settings/OrgProfilePanel.tsx`, `settings/advanced/ApiKeysPanel.tsx`, `settings/CustomFieldsPanel.tsx`, `settings/LeadSourcesPanel.tsx`, `settings/advanced/WebhooksPanel.tsx`. O padrão repetido "lista + formulário inline + `ConfirmDialog`" vira o hook `useInlineCrud<T>()` (`showForm`, `editingId`, `form`, `confirmDeleteId`, `startCreate`, `startEdit`, `cancel`) em `src/hooks/useInlineCrud.ts` com teste de reducer puro (`src/lib/inlineCrud.ts`).

### 5.9 Formatadores: `src/lib/format.ts`

Funções (todas com `locale = "pt-BR"` fixo e `timeZone` opcional):

| Função | Substitui |
|---|---|
| `formatDate(ts)`, `formatDateTime(ts)`, `formatTime(ts)` | `toLocaleDateString/TimeString` espalhados |
| `formatRelative(ts, now)` ("há 5 min", "ontem", "12/10") | `formatRelativeDate` (`ContactDetailPanel:703`, `UpcomingTasksWidget:540`, `FormListPage:38`, `TaskKanbanBoard:156`), `timeAgo` (`FormSubmissionsPage`) |
| `formatMoney(value, currency = "BRL")` | `formatCurrency` (`DashboardOverview:765`, `LeadsListView:79`), `formatBRL` (`centralFormat.ts:19`, `centralMeta.ts:126`), `formatBrlApprox`, `formatUsd` |
| `formatCount(n)` | `formatCount` de `ImportWizard` |
| `parseDecimal(raw)` | `AiSection.tsx:2725` |

Telefone **não** entra: continua em `lib/phone`/`convex/lib/phone.ts` (porta única do projeto). `now` é sempre argumento (testável; e nunca `Date.now()` em args de `useQuery`). Teste: ~25 casos, incluindo fuso e moeda da org (`settings` da org tem moeda; o default é BRL).

---

## 6. URL como fonte da verdade

Convenção de nomes (documentada em `.claude/rules/frontend.md`): **ids de entidade e estado de tela em inglês camelCase** (seguindo `conversation`, `lead`, `task`, `handoff`, `board`, `post`, `event`, `date`, já emitidos), **exceto os que já existem em português** (`secao`, `aba`, `nova`, `novo`, `campanha`), que ficam como estão. Aberturas de entidade usam *push* (o "voltar" fecha); filtros usam *replace* (não poluem o histórico). Abrir outra entidade limpa as velhas na mesma escrita.

Hook genérico: `src/hooks/useSearchParamState.ts` com a parte pura em `src/lib/searchParamState.ts` (parse/serialize por tipo: string, enum, boolean `1`, número, lista separada por vírgula) e o mecanismo de "escrita em voo" que hoje está duplicado em `Inbox.tsx:1347-1378` e `HandoffQueue.tsx:48-60` (ref `{target, stale}`), testado com casos de corrida.

| Tela | Estado | Param | Tipo/valores | Push/replace | Hoje |
|---|---|---|---|---|---|
| Configurações | painel | `secao` | id do registro | push | lido, não escrito |
| Conversas | arquivadas | `archived` | `1` | replace | `useState` |
| Conversas | etiqueta | `label` | id | replace | `useState` |
| Contatos | contato aberto | `contact` | id | push | `useState` (`ContactsPage.tsx:51`) |
| Contatos | busca, página | `q`, `page` | string, número | replace | `useState` |
| Painel do contato | aba | `contactTab` | `info|leads|groups` | replace | `useState` (`ContactDetailPanel.tsx:97`) |
| Painel do lead | aba | `leadTab` | `conversation|details|tasks|activity` (ids atuais do código) | replace | `useState` (`LeadDetailPanel.tsx:102`) |
| Funil | modo | `view` | `board|list` | replace | `useState` |
| Funil | busca e filtros | `q`, `owner`, `temp`, `priority`, `unit` | string/ids | replace | `useState` (699-730) |
| Agenda | visão, data, evento | `view`, `date`, `event` | `day|week|month`, `YYYY-MM-DD`, id | `view/date` replace, `event` push | ignorados (`useCalendarState.ts:6-7`) |
| Tarefas | modo, filtro rápido | `view`, `smart` | `list|status`, id do pill | replace | `useState` (`TasksPage.tsx:99-103`) |
| Tarefas | filtros | `status`, `assignee`, `label`, `project` | ids | replace | `useState` |
| Histórico de alterações | filtros | `entity`, `action`, `actor`, `severity`, `from`, `to`, `q` | strings/ids, datas `YYYY-MM-DD` | replace | `useState` (`AuditLogs.tsx:40-50`) |
| Histórico de alterações | item aberto | `log` | id | push | `expandedLogId` |
| Campanhas | filtros | `status`, `provider` | enums | replace | `useState` (`CampaignsPage.tsx:49-50`) |
| Equipe | membro aberto, busca | `member`, `q` | id, string | push / replace | `useState` (`TeamPage.tsx:69-71`) |

`cursorStack` da Auditoria e as páginas de lote do Inbox **não** vão para a URL (cursor de paginação do Convex expira; recarregar volta ao início, o que é o esperado).

Troca de organização (`src/lib/orgSwitch.ts`): `ORG_AGNOSTIC_PARAMS` passa a incluir `view`, `date`, `leadTab`, `contactTab`, `smart`, `archived`, `q` (não apontam para entidade). Ids (`contact`, `label`, `owner`, `actor`, `event`, `member`, `log`, `project`, `assignee`, `unit`) caem na troca. Teste novo em `orgSwitch.test.ts`.

---

## 7. Mobile e acessibilidade

### 7.1 Alvos de toque e `Button`

**Decisão:** manter as alturas visuais de `sm` (32 px) e `md` (40 px) no desktop e garantir 44 px em ponteiro grosso com uma utilidade Tailwind.

- `tailwind.config.js`: variante `coarse` via `screens: { coarse: { raw: "(pointer: coarse)" } }`.
- `Button`: `sm` → `h-8 coarse:min-h-11`, `md` → `h-10 coarse:min-h-11`, `iconOnly` → `w-10 h-10 coarse:min-w-11 coarse:min-h-11`.
- Mesma regra em `Tabs`, `SegmentedControl`, pills e itens de menu.
- Por quê: subir tudo para 44 px deixaria as telas densas do desktop (funil, tabelas) maiores sem motivo; o problema real é o toque.

Teste: `Button.test.tsx` checa as classes `coarse:min-h-11` em `sm`/`md`.

### 7.2 Altura de viewport

- `100vh`/`h-screen`/`min-h-screen` (31 usos) → `dvh` onde o elemento ocupa a tela no mobile: `AppShell.tsx:28,54`, `AuthLayout.tsx:433,455`, `LazyRoute` fallback (`main.tsx`), folha "Mais" (`BottomTabBar.tsx:136`), `SlideOver`/`Modal` em tela cheia. Tailwind 3: usar classes arbitrárias `min-h-[100dvh]` (com fallback `min-h-screen` antes, para navegadores sem `dvh`).
- Asserção do PR: `grep -rn "100vh\|h-screen\|min-h-screen" src/components/layout src/components/ui src/main.tsx` só retorna linhas que também têm a versão `dvh`.

### 7.3 Texto pequeno

- 238 usos de `text-[9px|10px|11px]`. **Decisão:** token `text-caption` = 12 px / 16 px de altura de linha em `tailwind.config.js` (`fontSize.caption`), e `text-micro` = 11 px reservado para contadores dentro de badges.
- Substituição: `text-[9px]` e `text-[10px]` → `text-caption` (ou `text-micro` dentro de badge redondo); `text-[11px]` → `text-caption`.
- Guard: teste `src/lib/uiClassGuard.test.ts` falha em `text-\[(9|10)px\]` em `src/components/**` (allowlist: `campaigns/WhatsAppPreview.tsx`, que imita o WhatsApp, e `forms/renderer/**`, tema do formulário público). `text-[11px]` entra no guard no PR 14.

### 7.4 Tooltips no toque e nomes acessíveis

- Ordem de migração de `title=` → `Tooltip`: (1) botões ícone-only da sidebar colapsada, cabeçalho da conversa e composer; (2) badges e chips de estado da IA; (3) o resto progressivamente. `title` puro continua permitido em texto truncado (mostra o nome completo no hover do desktop), não em controles.
- Guard de nome acessível: `src/lib/a11yGuard.test.ts` procura `<Button iconOnly` e `<button` cujo conteúdo é só um componente de ícone lucide (regex sobre JSX de uma linha e multilinha simples) sem `aria-label`; allowlist pontual com motivo. Primeiro rodada só em `layout/`, `ui/`, `inbox/`, `settings/`; o escopo cresce.
- Teste de tipo: `Button` com `iconOnly` sem `aria-label` não compila.

### 7.5 Outros

- `prefers-reduced-motion`: primitivos novos (Popover, Tooltip, Tabs) não animam com redução ligada (`motion-safe:` do Tailwind).
- Foco: todos os primitivos usam o anel do guia (`focus-visible:ring-2 ring-brand-500 ring-offset-2 ring-offset-surface-base`). Trocar `focus:` por `focus-visible:` no `Button` (o anel não aparece mais ao clicar com mouse).
- Hierarquia de títulos: um `h1` por página (`PageHeader`), `h2` em `SectionCard`.
- Cores: os 151 hex crus são assunto da seção de temas; aqui só garantimos que nenhum primitivo novo usa hex.

---

## 8. Desempenho e bundle

| Item | Decisão | Verificação |
|---|---|---|
| `DevelopersPage`, `PlaygroundPage`, `lib/apiRegistry.ts`, `components/developers/*` | `lazy()` com `LazyRoute` em `main.tsx` | `npx vite build` não lista `apiRegistry` no chunk de entrada; asserção: `grep -L "apiRegistry" dist/assets/index-*.js` |
| `LandingPage` | `lazy()` também: quem abre `/app` não baixa a landing. Ela continua rápida para `/` porque o chunk é pequeno e pré-carregado com `<link rel="modulepreload">` pelo Vite. | idem para um texto único da landing |
| `AuthPage` | lazy | |
| `OnboardingWizard` dentro de `AuthLayout` | `lazy()` (só aparece uma vez por org) | |
| `CopilotPanel` + `Markdown` + `useCopilotStream` | `lazy()` montado só quando `copilotOpen` (o FAB fica eager) | |
| `qrcode.react` | já só no `TelegramCard`; com painéis lazy de Configurações, só carrega no painel `notifications` | |
| Painéis de Configurações | cada painel do registro é `lazy` (seção 3.1) | abrir "Dados da empresa" não carrega o chunk do atendente |
| `react-helmet-async` | mantido (é usado pelo SEO); fora do escopo | |
| Fallback do `Suspense` | `Spinner` estático com `min-h-[100dvh]` | |
| `rollup-plugin-visualizer` com `open: !CI` | o agente roda com `CI=1` para não tentar abrir navegador | |

Meta: o chunk de entrada do app autenticado cai pelo tamanho de `DevelopersPage` + `apiRegistry` (~2,9 mil linhas de dados e JSX). O PR registra o antes/depois do `vite build` (tamanho gzip de `index-*.js`) na descrição.

---

## 9. Fluxos simples para o público-alvo

Só o que é implementável no frontend com as queries existentes.

1. **Primeiro acesso no Painel: "Primeiros passos".** `OnboardingChecklist` (já montado em `DashboardOverview.tsx:14`) passa a ser o primeiro bloco do Painel enquanto houver passo pendente. **Contrato com a seção de onboarding:** ela define os passos e como cada um é marcado como concluído; esta seção fornece (a) a posição no Painel, (b) os destinos estáveis de cada passo: `connect-whatsapp` → `/app/configuracoes?secao=channels`, `activate-attendant` → `?secao=ai`, `teach-attendant` → `?secao=ai-attendant`, `handoff-rules` → `?secao=ai-handoff`, `set-funnel` → `/app/pipeline`, `invite-team` → `/app/equipe`, (c) o arquivo `src/lib/firstSteps.ts` com `FIRST_STEP_TARGETS: Record<FirstStepId, string>` e teste de que todo destino é rota/painel existente (`resolveSettingsPanel` não devolve null).
2. **Painel sem vitrine técnica.** A vitrine "funcionalidades" (`DashboardOverview.tsx:656-760`: "Pipeline Kanban", "API REST", "Sistema de Webhooks", "Paleta de Comandos Cmd+K", "Motor de Automações (Em breve)") sai do app logado. No lugar, quando a org é nova, três cartões de ação: "Conectar WhatsApp", "Ligar o Atendente IA", "Criar seu funil".
3. **Conversas com "Requer atenção".** Faixa no topo da lista com a contagem (1.5); conversa com pedido pendente mostra **Assumir conversa** e **Devolver à IA** no cabeçalho, um toque cada. Depois de assumir, um chip "Você está atendendo" substitui o chip da IA (estado já disponível em `aiConvState`/`handoffState`).
4. **Chip de quem está respondendo** no cabeçalho de cada conversa: "A IA está respondendo sozinha", "A IA sugere, você envia", "Você está atendendo", "IA em espera: {motivo}". Usa `aiStatus`, `agentProfile.mode` e `aiConvState` já carregados.
5. **WhatsApp desconectado em destaque.** Se o canal do número tem estado desconectado (dado já usado em `ChannelHealthPanel`/notificações), faixa em Conversas: "Seu WhatsApp está desconectado · Reconectar" → `?secao=channels`.
6. **Menos modais.** (a) Nova etapa: coluna "Adicionar etapa" inline (já existe `AddStageColumn`); remover o caminho duplicado por modal. (b) Seleção de funil: `Menu` em vez de modal. (c) Menus de ações de lead/conversa viram `Menu` (no celular, bottom sheet). (d) Confirmações destrutivas continuam com `ConfirmDialog`.
7. **Estados vazios que ensinam.** Para as 14 páginas do menu, título/descrição/ação seguindo 1.1, com textos em `VOCAB.<x>.empty`. Exemplos: Conversas vazia → "Conectar WhatsApp"; Funil vazio → explica "lead" e oferece "Criar funil"; Requer atenção vazia → "Tudo em dia".
8. **Cartão do lead estilo WhatsApp (última mensagem).** Depende de dado do servidor: `getLeads` não devolve prévia de mensagem (o campo `lastMessagePreview` existe em `conversations`, não em `leads`). Fica em "Fora do escopo" com a dependência descrita; o `LeadCard` extraído no PR 13 já recebe uma prop opcional `lastMessage?: { text: string; at: number; fromContact: boolean }` e a renderiza quando presente, para o backend ligar depois sem mexer no front.

---

## 10. Plano de entrega (PRs)

Ordem: ferramentas e primitivos → vocabulário e navegação → Configurações → decomposições (um gigante por PR) → varreduras de URL e acessibilidade. Cada PR parte de `main` atualizado, roda num agente Sonnet sem humano e sem deployment Convex. Tamanho: S ≤ 300, M ≤ 700, L ≤ 700 linhas **novas** de diff (linhas puramente movidas, vistas com `git diff -M --color-moved`, não contam; o PR declara "movidas: N, novas: M").

Critérios comuns a todos os PRs (não repetidos abaixo):
- [ ] `npx tsc -p tsconfig.app.json` sem erro (e `npx tsc -p convex`, `npx tsc -p tsconfig.node.json`, que não devem mudar).
- [ ] `npx vitest run` verde; contagem de testes do projeto "backend-e-lib" não diminui.
- [ ] `CI=1 npx vite build` verde.
- [ ] Nenhum arquivo em `convex/` alterado (`git diff --name-only main | grep '^convex/'` vazio).
- [ ] Nenhum texto novo em inglês ou fora do glossário (após o PR 4, o `vocabGuard` cobre).
- [ ] Entrada em `CHANGELOG.md` (PT-BR, voltada ao usuário) quando há mudança visível.
- [ ] Sem linha de atribuição de IA no commit (regra do projeto).

### PR 1 — Testes de componente, limpeza do roteador e formatadores

- **Objetivo:** habilitar testes `.tsx`, remover código morto, dar 404/erro de rota, tirar páginas públicas pesadas do carregamento inicial e centralizar formatadores.
- **Arquivos:** `vitest.config.mts`, `package.json`, `package-lock.json`, `src/test/setup.ts`, `src/test/render.tsx`, `src/main.tsx`, `src/pages/NotFoundPage.tsx`, `src/components/RouteErrorPage.tsx`, `src/components/Dashboard.tsx` (apagar), `src/lib/format.ts`, `src/lib/format.test.ts`, chamadores das funções da tabela 5.9 (`ContactDetailPanel`, `UpcomingTasksWidget`, `FormListPage`, `TaskKanbanBoard`, `DashboardOverview`, `leads/LeadsListView`, `central/centralFormat.ts`, `inbox/central/centralMeta.ts`, `FormSubmissionsPage`, `ImportWizard`).
- **Passos:** 1) instalar devDeps e configurar `projects` (4.1); 2) teste-semente `src/test/smoke.test.tsx` renderizando `Badge`; 3) lazy de `LandingPage`, `AuthPage`, `DevelopersPage`, `PlaygroundPage`; 4) rotas `*` e `errorElement`; 5) apagar `Dashboard.tsx`; 6) criar `format.ts` com testes e trocar as funções locais por imports (mesma saída; onde o formato atual divergir entre telas, adotar o de `ContactDetailPanel` e listar a diferença na descrição).
- **Critérios de aceite:**
  - [ ] `npx vitest run --project componentes` executa ≥ 1 teste.
  - [ ] `grep -rn "function formatRelativeDate\|function formatCurrency\|function formatBRL\|function timeAgo" src --include=*.tsx --include=*.ts | grep -v "lib/format.ts"` vazio.
  - [ ] `grep -c "apiRegistry" dist/assets/index-*.js` = 0 após build.
  - [ ] `test ! -f src/components/Dashboard.tsx`.
  - [ ] `main.tsx` contém `path: "*"` e `errorElement`.
- **Testes:** `format.test.ts` (~25 casos), `smoke.test.tsx`, `RouteErrorPage.test.tsx` (renderiza com erro de import dinâmico e mostra "Recarregar").
- **Tamanho:** M.
- **Riscos/mitigação:** `projects` mudar a descoberta de testes do backend → comparar a contagem antes/depois e anexar na descrição. `@vitejs/plugin-react` no projeto jsdom conflitar com edge-runtime → plugin só no projeto "componentes". Formato de data mudar numa tela → teste de tabela com as saídas atuais.

### PR 2 — Primitivos de formulário: Switch, FormField, Textarea, Select, SegmentedControl, Tabs

- **Objetivo:** criar os primitivos de entrada e substituir as 7 implementações de switch.
- **Arquivos:** `src/components/ui/{Switch,FormField,Textarea,Select,SegmentedControl,Tabs}.tsx` + `.test.tsx`; `settings/AiSection.tsx` (remove `Switch` local), `settings/CentralSection.tsx` (remove `Switch` exportado), `forms/builder/{FieldConfigPanel,FormSettingsPanel,ConditionalLogicEditor,StepManager,ThemePanel}.tsx` (remove `ToggleSwitch`), `src/hooks/useMediaQuery.ts` + teste.
- **Passos:** 1) primitivos com props de 4.2; 2) trocar as 7 funções por `Switch` (mesmos rótulos); 3) `Tabs` em `Settings.tsx:447` (campos lead/contato) como primeiro consumidor; 4) `Select` nas 6 ocorrências de `Settings.tsx`.
- **Critérios:**
  - [ ] `grep -rn "function Switch\|function ToggleSwitch" src` vazio fora de `ui/Switch.tsx`.
  - [ ] `grep -rn 'role="tablist"' src/components/ui/Tabs.tsx` presente; `grep -c "<select" src/components/Settings.tsx` = 0.
  - [ ] Cada primitivo tem teste de teclado (setas/Espaço) e de `aria-*`.
- **Testes:** 6 arquivos `.test.tsx` + `useMediaQuery.test.ts`.
- **Tamanho:** M.
- **Riscos:** switches de `forms/builder` com estilo próprio do tema do formulário → `Switch` aceita `className`; validar visual pela classe, não por screenshot. Comportamento de `role="switch"` inline nos 12 arquivos fica para o PR 14.

### PR 3 — Primitivos de estrutura: PageHeader, SectionCard, Tooltip, Popover/Menu, Stepper, EmptyState, Button, SearchInput

- **Objetivo:** completar o kit de 4.2.
- **Arquivos:** `src/components/ui/{PageHeader,SectionCard,Tooltip,Popover,Menu,Stepper,SearchInput}.tsx` + testes; `ui/EmptyState.tsx`, `ui/Button.tsx` (+ testes); `src/lib/popoverPosition.ts` + teste; `tailwind.config.js` (variante `coarse`, `fontSize.caption/micro`); `.claude/rules/frontend.md` (seção de primitivos).
- **Passos:** 1) `computePopoverPosition` puro com 6+ casos; 2) `Popover` com portal, Esc, clique fora, devolução de foco; 3) `Menu` sobre `Popover` e bottom sheet no mobile; 4) `Tooltip` com hover/foco/pressão longa; 5) `Button` com `loading`, `iconOnly` (tipo discriminado) e `coarse:min-h-11`, `focus-visible`; 6) `EmptyState` com `href`/`secondaryAction`; 7) `Stepper`; 8) `SearchInput` com `useDebouncedValue`.
- **Critérios:**
  - [ ] Todos os primitivos novos com teste; `Button` com `@ts-expect-error` para `iconOnly` sem `aria-label`.
  - [ ] `grep -n "coarse" tailwind.config.js` presente.
  - [ ] Nenhum consumidor migrado ainda além de 1 exemplo por primitivo (mantém o PR pequeno): `PageHeader` em `HandoffQueue`, `Menu` em `LeadActionsMenu`, `Stepper` em `ImportWizard`.
- **Testes:** 8 `.test.tsx` + `popoverPosition.test.ts`.
- **Tamanho:** M.
- **Riscos:** `focus` → `focus-visible` mudar o anel em telas existentes → é a intenção (só some no clique de mouse); citar no CHANGELOG. Tooltip com pressão longa conflitar com clique → no toque, pressão longa só em gatilhos `asInfo` ou desabilitados.

### PR 4 — Glossário e guarda de vocabulário

- **Objetivo:** criar `VOCAB`, o teste de varredura, e aplicar o glossário nos rótulos de navegação, títulos de página, estados vazios e toasts das telas principais.
- **Arquivos:** `src/lib/vocab.ts`, `src/lib/uiStrings.ts` + teste, `src/lib/vocabGuard.test.ts`, `src/lib/vocabGuard.allowlist.ts`; textos em `HandoffQueue.tsx`, `handoffs/HandoffPeekSlideOver.tsx`, `Inbox.tsx` (só strings), `inbox/AiDraftCard.tsx`, `DashboardOverview.tsx`, `KanbanBoard.tsx` + `DeleteBoardModal`/`EditBoardModal`/`ManageStagesModal`, `AuditLogs.tsx`, `central/CentralPage.tsx`, `settings/AiSection.tsx` (strings), `settings/ChannelsSection.tsx` (strings), `notifications/NotificationPreferences.tsx` (inclui acentos "atribuída"), `campaigns/*` (Opt-out, Bridge, Cloud API), `ViewSelector.tsx`, `CreateTaskModal.tsx`, `ContactDetailPanel.tsx` (Tags), `SignInForm.tsx`/`team/InviteMemberModal.tsx` (Email, Admin, Agente), `Settings.tsx` (fusos em português via `src/lib/timezones.ts`, "Select"/"Phone" → "Lista de opções"/"Telefone"), `onboarding/*` (Pipeline → Funil, Setor → Ramo de atividade, "+DDI" → "código do país"), emoji `📎` em `AiDraftCard.tsx:255` → ícone `Paperclip`.
- **Passos:** 1) `vocab.ts` + extrator + guard com allowlist inicial; 2) rodar o guard e corrigir até verde **no escopo do PR** (as telas acima); o restante do app entra na allowlist por caminho com marcação `TODO(PR14)` (lista explícita, conta para o teto separado `PENDING_SCOPE`, que o PR 14 zera); 3) sentence case nos botões e títulos das telas tocadas; 4) padrão de toast (1.1).
- **Critérios:**
  - [ ] `npx vitest run src/lib/vocabGuard.test.ts` verde.
  - [ ] `grep -rn '"Repasses"\|Fila de Repasses\|Caixa de Entrada\|Logs de Auditoria\|Painel da Central\|Nova Pipeline' src/components` vazio.
  - [ ] `grep -rn "Autopilot\|autopilot" src/components --include=*.tsx | grep -v "mode\|=== \"autopilot\"\|'autopilot'"` só mostra identificadores (nenhum texto JSX).
  - [ ] `grep -rn "📎" src` vazio.
- **Testes:** `uiStrings.test.ts` (10 casos), `vocabGuard.test.ts` (o guard + teste de que a allowlist pontual tem ≤ 30 entradas e cada uma tem `reason`), `vocab.test.ts` (todo rótulo de `VOCAB` passa no próprio guard e é sentence case).
- **Tamanho:** M (muitas linhas trocadas, cada uma trivial).
- **Riscos:** texto que vai para o cliente final (mensagem de WhatsApp, prompt) confundido com rótulo de UI → o PR só toca componentes React; strings que viram mensagem ao cliente moram no backend e não são alteradas. Testes do backend que comparam texto de notificação ("Repasse solicitado") não são afetados (texto do backend não muda). O CHANGELOG explica a troca de nomes ("Repasses agora se chama Requer atenção").

### PR 5 — Modelo de navegação único

- **Objetivo:** `nav.ts` consumido por Sidebar e BottomTabBar, grupos, item ativo por prefixo, título da página no shell e na aba do navegador.
- **Arquivos:** `src/lib/nav.ts` + teste, `src/lib/routes.ts` (tipo `Tab`, remove `PATH_TO_TAB`), `src/lib/orgSwitch.ts` (+ teste estendido), `src/hooks/useNavBadges.ts`, `src/hooks/usePageTitle.ts`, `layout/Sidebar.tsx`, `layout/BottomTabBar.tsx`, `layout/AppShell.tsx`, imports de `Tab` nos chamadores, `src/CLAUDE.md` (árvore e padrão de navegação).
- **Passos:** 1) modelo e funções puras; 2) Sidebar renderiza grupos com separador, `Tooltip` no modo colapsado; 3) BottomTabBar: 4 primários + "Mais" em folha por grupos com ponto de badge; 4) shell mostra título no mobile; 5) `usePageTitle` nas 14 páginas; 6) remover `NavItem` duplicado.
- **Critérios:**
  - [ ] `grep -rn "PATH_TO_TAB" src` vazio; `grep -rn "const navItems\|const primaryTabs\|const moreTabs" src/components/layout` vazio.
  - [ ] `activeTabForPath("/app/formularios/x/submissoes") === "forms"` (teste).
  - [ ] `orgSwitch.test.ts` existente verde sem alteração dos casos antigos.
  - [ ] Teste garante que todo `Tab` de `TAB_ROUTES` aparece exatamente uma vez em `NAV_ITEMS` e que `splitMobile` devolve ≤ 4 primários.
- **Testes:** `nav.test.ts` (visibilidade por permissão e módulo, prefixo, mobile split, todos os rótulos vêm de `VOCAB`), `Sidebar.test.tsx` só se o componente receber dados por props (o PR separa `SidebarView` puro de `Sidebar` com hooks e testa a view: item ativo com `aria-current="page"`, badge com texto acessível "3 não lidas").
- **Tamanho:** M.
- **Riscos:** mudar a barra inferior altera hábito de quem usa Calendário na barra → CHANGELOG avisa; a regra é uma linha em `NAV_ITEMS`. Badges disparando queries para itens ocultos → `"skip"` quando o item não está visível (teste da função que decide o skip).

### PR 6 — Configurações em dois níveis

- **Objetivo:** casca nova com registro, URL escrita no clique, busca, e as cinco seções inline em arquivos próprios.
- **Arquivos:** `src/components/settings/registry.ts`, `src/lib/settingsNav.ts` + teste, `src/lib/settingsSearch.ts` + teste, `src/components/Settings.tsx` (reescrito como casca), `settings/OrgProfilePanel.tsx`, `settings/CustomFieldsPanel.tsx`, `settings/LeadSourcesPanel.tsx`, `settings/advanced/ApiKeysPanel.tsx`, `settings/advanced/WebhooksPanel.tsx`, `src/hooks/useInlineCrud.ts`, `src/lib/inlineCrud.ts` + teste, `src/lib/timezones.ts` (se não veio no PR 4).
- **Passos:** 1) mover as 5 seções literalmente (PR de mover dentro do PR: primeiro commit só move); 2) `useInlineCrud` nas 4 listas; 3) registro com os ids legados apontando para os componentes atuais (`ai` → `AiSection` inteiro, `channels` → `ChannelsSection` inteiro, por enquanto); 4) casca: lista no mobile, coluna lateral no desktop, `PageHeader` com voltar, `SearchInput`; 5) clique escreve `?secao=` (push).
- **Critérios:**
  - [ ] `wc -l src/components/Settings.tsx` < 200.
  - [ ] Teste: todos os ids legados (`general, ai, apikeys, fields, sources, webhooks, channels, data, notifications, central`) resolvem para um painel; id desconhecido → null; `central` invisível sem `manage` e sem módulo.
  - [ ] Teste: busca "transcrição" encontra o painel de canais (e, após o PR 8, `ai-features`).
  - [ ] `grep -rn "setActiveSection" src/components/Settings.tsx` vazio (o estado é a URL).
  - [ ] Retorno OAuth: `ChannelsSection` continua lendo `meta`/`pendente` (sem mudança de código nele).
- **Testes:** `settingsNav.test.ts`, `settingsSearch.test.ts`, `inlineCrud.test.ts`, `SettingsNavView.test.tsx` (navegação apresentacional: clicar chama `onSelect(id)`; `aria-current`).
- **Tamanho:** M.
- **Riscos:** deep-links externos (`DashboardOverview:202`, `GroupPostsTab:333`, `GroupsPage:166`, `NotificationPanel:145,172`, `CentralPage:100`) → ids legados preservados e testados. Lazy dos painéis com flash → fallback `Skeleton` estático.

### PR 7 — Atendente IA (1/2): lógica pura e divisão do arquivo

- **Objetivo:** tirar a validação de `AiSection` para `src/lib/attendantConfig.ts` com testes e dividir o arquivo por cartão, sem mudar comportamento.
- **Arquivos:** `src/lib/attendantConfig.ts` + teste, `settings/ai/{AiOverviewPanel,FeatureTogglesCard,BridgeAiCard,ActivationCard,AttendantCard,SimulatorModal,UsagePanel}.tsx`, `settings/advanced/AiModelsPanel.tsx` (routing + privacy), `settings/attendant/AttendantConfig.tsx` (ainda monolítico, movido), `settings/AiSection.tsx` (vira orquestrador fino com a mesma ordem de render), `src/lib/format.ts` (`formatUsd` etc. se não vieram no PR 1).
- **Passos:** 1) commit de movimentação; 2) extrair funções puras e cobri-las; 3) trocar `<select>` locais pelo `Select` (14 ocorrências) e cabeçalhos por `SectionCard`.
- **Critérios:**
  - [ ] `wc -l src/components/settings/AiSection.tsx` < 200.
  - [ ] Nenhum arquivo em `settings/ai/` ou `settings/attendant/` > 700 linhas, exceto `AttendantConfig.tsx` (resolvido no PR 8).
  - [ ] `grep -rn "SELECT_CLS" src` vazio.
  - [ ] `attendantConfig.test.ts` cobre os limites: debounce 0/1/120/121, teto 0 (sem limite) e negativo, janela de follow-up início ≥ fim, teto diário 500.
- **Testes:** `attendantConfig.test.ts` (~30 casos).
- **Tamanho:** M (quase tudo movido; novas ≈ 400).
- **Riscos:** mudança de ordem dos cartões → snapshot da ordem por teste do orquestrador puro (`aiSectionOrder(aiStatus)` devolve a lista de cartões e é testado com os estados "inativa", "ativa sem atendente", "ativa com atendente").

### PR 8 — Atendente IA (2/2): formulários reutilizáveis e painéis

- **Objetivo:** quebrar `AttendantConfig` (~1100 linhas) nos formulários de 3.4, criar os painéis `ai`, `ai-attendant`, `ai-conversation`, `ai-handoff`, `ai-followup`, `ai-features`, `ai-usage`, `ai-models` e pôr transcrição/visão a 2 cliques.
- **Arquivos:** `settings/attendant/{AttendantPersonaForm,AttendantKnowledgeForm,AttendantHoursForm,ConversationBehaviorForm,FunnelRulesForm,HandoffRulesForm,FollowUpForm,AttendantModeSwitch}.tsx`, `settings/attendant/{AttendantProfilePanel,ConversationPanel,HandoffPanel,FollowUpPanel}.tsx`, `settings/ai/{FeatureToggleCard,AiFeaturesPanel}.tsx`, `settings/channels/ChannelTranscriptionToggle.tsx` (extraído de `ChannelsSection` ~750-775; o card do canal passa a usá-lo), `settings/attendant/useAttendantProfile.ts` (carrega perfil, textos quando permitido, salva patch parcial), `settings/registry.ts`, `src/lib/attendantConfig.ts` (`fromProfile/toPatch/validate` por formulário), remoção de `settings/attendant/AttendantConfig.tsx` e de `settings/AiSection.tsx`.
- **Passos:** 1) `fromProfile/toPatch/validate` com testes primeiro; 2) formulários controlados com `variant`; 3) painéis com barra "Salvar alterações" (aparece só com alteração pendente; `Button loading`); 4) registro aponta `ai` → `AiOverviewPanel` e os novos ids; 5) `AiFeaturesPanel` lista os números com `ChannelTranscriptionToggle` e o cartão "Ler imagens"; 6) aviso de alteração não salva ao trocar de painel (`useBlocker` do react-router).
- **Critérios:**
  - [ ] `test ! -f src/components/settings/AiSection.tsx`.
  - [ ] Nenhum arquivo novo > 450 linhas.
  - [ ] `toPatch` testado: devolve só as chaves do formulário; sem textos carregados não inclui `persona`/`knowledge`.
  - [ ] Teste de componente de cada `*Form` (apresentacional): alterar campo chama `onChange` com o valor; erro aparece com `aria-invalid`; `variant="wizard"` esconde descrições longas.
  - [ ] Busca "transcrição", "imagem", "persona", "horário" acha o painel certo (teste de `settingsSearch`).
  - [ ] `grep -rn "from \"@/components/settings/AiSection\"" src` vazio.
- **Testes:** `attendantConfig.test.ts` (estendido), 8 `*Form.test.tsx`, `FeatureToggleCard.test.tsx`.
- **Tamanho:** L.
- **Riscos:** salvar parcial sobrescrever campo de outro painel → patch só com as chaves do formulário (teste). Autopilot antecipado → `AttendantModeSwitch` mantém o modal de risco e `autopilotRiskAck`; checklist de 5.3 copiado na descrição. Painéis do atendente com IA inativa → mostram `EmptyState` "Ligue o Atendente IA primeiro" com link para `?secao=ai`.

### PR 9 — WhatsApp e canais

- **Objetivo:** dividir `ChannelsSection` e entregar `ChannelConnectCard` reutilizável, com vocabulário "WhatsApp por QR code / WhatsApp oficial (Meta) / Conectar número".
- **Arquivos:** `settings/channels/{ChannelsPanel,ChannelCard,BridgeHistoryPanel,BridgeQrModal,ChannelConnectCard,MetaForm,QrCodeConnectForm,InstagramPanel}.tsx`, `src/lib/channelBadges.ts` + teste, `settings/registry.ts` (`channels`, `instagram`), remoção de `settings/ChannelsSection.tsx`, passo a passo da Meta movido para um bloco "Detalhes técnicos" recolhido (termos técnicos permitidos via allowlist pontual de arquivo `MetaForm.tsx`).
- **Passos:** 1) mover; 2) `ChannelConnectCard` com props `onConnected(channelId)` e `variant`; 3) no card de número desconectado, botão primário "Mostrar QR code"; 4) campos de modo manual (instância, admin token) dentro de `CollapsibleSection` "Configuração manual (avançado)".
- **Critérios:**
  - [ ] `test ! -f src/components/settings/ChannelsSection.tsx`; nenhum arquivo novo > 600 linhas.
  - [ ] `grep -rni "gateway\|provision\|instância" src/components/settings/channels/*.tsx` só em `QrCodeConnectForm.tsx` dentro do bloco manual (allowlist pontual com motivo).
  - [ ] `ChannelConnectCard.test.tsx` (apresentacional): escolher QR mostra o aviso de risco e exige o aceite antes de "Conectar número".
- **Testes:** `channelBadges.test.ts`, `ChannelConnectCard.test.tsx`, `ChannelTranscriptionToggle.test.tsx`.
- **Tamanho:** M/L.
- **Riscos:** retorno OAuth da Meta → `ChannelsPanel` mantém a leitura e a limpeza de `meta/pendente/state` (checklist). Modo gerenciado × manual → condição copiada literal, teste da função pura `connectMode(env, channel)` se existir lógica.

### PR 10 — Conversas (1/2): lógica, hooks de URL, lista e cabeçalho

- **Objetivo:** tirar de `Inbox()` a lógica pura, os hooks de estado e o JSX da lista e do cabeçalho; adicionar a faixa "Requer atenção" e os botões de um toque.
- **Arquivos:** `src/lib/inboxState.ts` + teste, `src/lib/searchParamState.ts` + teste, `src/hooks/useSearchParamState.ts`, `src/hooks/{useInboxFilters,useConversationList,useConversationSelection,useBulkConversationSelection}.ts`, `inbox/{ConversationList,ConversationListItem,ConversationHeader,AttentionBanner,AiStatusChip,useGroupMode}.tsx/ts`, `Inbox.tsx`, `HandoffQueue.tsx` (usa `useSearchParamState` e `PageHeader`).
- **Passos:** 1) mover funções puras e testar; 2) `useSearchParamState` com o mecanismo de escrita em voo extraído de `Inbox.tsx:1347-1378` e `HandoffQueue.tsx:48-60`; 3) hooks; 4) `ConversationList`/`ListItem` (apresentacionais por props); 5) `ConversationHeader` com Assumir/Devolver visíveis e `AiStatusChip`; 6) `AttentionBanner` com `getPendingHandoffCount`.
- **Critérios:**
  - [ ] `wc -l src/components/Inbox.tsx` < 1500 (o thread/composer saem no PR 11).
  - [ ] `archived` e `label` na URL (teste de `searchParamState`); `kindFilter` continua em `localStorage`.
  - [ ] Checklist 5.1 na descrição, item a item, com o arquivo/linha onde cada comportamento passou a morar.
  - [ ] `HandoffQueue.tsx` e `Inbox.tsx` não têm mais `handoffParamSyncRef`/refs próprios de escrita em voo (`grep`).
- **Testes:** `inboxState.test.ts`, `searchParamState.test.ts` (incluindo corrida: escrita pedida, URL ainda antiga, efeito não reverte), `ConversationListItem.test.tsx`, `AiStatusChip.test.tsx`, `AttentionBanner.test.tsx` (some com 0; texto singular/plural).
- **Tamanho:** L.
- **Riscos:** regressão no deep-link `?conversation=` (o ponto mais frágil) → o hook mantém a mesma sequência de efeitos; teste puro da máquina de estados "param → seleção"; o resolver sob `ErrorBoundary` não muda.

### PR 11 — Conversas (2/2): thread e composer compartilhados com o lead

- **Objetivo:** extrair `ConversationThread` e `Composer` e fazer `LeadDetailPanel` usá-los, removendo ~670 linhas duplicadas.
- **Arquivos:** `inbox/{ConversationThread,Composer,InboxOverlays}.tsx`, `inbox/useThreadPaging.ts`, `inbox/useMarkReadAndPresence.ts`, `Inbox.tsx`, `LeadDetailPanel.tsx` (`ConversationTab` → `leads/detail/LeadConversationTab.tsx`).
- **Passos:** 1) mover thread e composer do Inbox; 2) props de 5.1; 3) `LeadConversationTab` com `variant="embedded"` e `features={{voice:false, schedule:false}}`; 4) apagar o `ConversationTab` antigo.
- **Critérios:**
  - [ ] `wc -l src/components/Inbox.tsx` < 400.
  - [ ] `grep -c "markConversationRead\|handleLoadOlder\|useInfiniteSentinel" src/components/LeadDetailPanel.tsx` = 0.
  - [ ] Checklist de paridade do lead (5.2) e do Inbox (5.1) na descrição.
- **Testes:** `useThreadPaging` com a parte pura em `src/lib/threadPaging.ts` (âncora de scroll ao carregar mais antigas; já existe `inboxPaging.ts`, reaproveitar), `Composer.test.tsx` só para a parte apresentacional (`ComposerView`: Enter envia, Shift+Enter quebra linha, nota interna muda o estilo e o rótulo, contador da janela de 24 h).
- **Tamanho:** L.
- **Riscos:** o lead ter conversas em mais de um canal → seletor simples (`Select`) quando houver mais de uma; com uma, igual a hoje. Presença "digitando…" duplicada se Inbox e painel do lead estiverem abertos na mesma conversa → o hook usa a mesma chave de presença; documentar.

### PR 12 — Painéis de detalhe: lead, contato e tarefa

- **Objetivo:** dividir `LeadDetailPanel` (resto), `ContactDetailPanel` e `TaskDetailSlideOver`; abas e contato aberto na URL; resolver o nome duplicado da tarefa.
- **Arquivos:** `leads/detail/*` (5.2), `contacts/detail/*` (5.7), `ContactsPage.tsx`, `tasks/detail/*` (5.6), `calendar/TaskQuickView.tsx` (renomeado), `calendar/CalendarPage.tsx` (import), `src/lib/leadFields.ts` + teste, `src/lib/mentions.ts` (+ `detectMentionTrigger` + teste), `src/lib/orgSwitch.ts` (+ params novos e teste).
- **Passos:** 1) mover; 2) `Tabs` nos dois painéis com `leadTab`/`contactTab`; 3) `?contact=` em `ContactsPage` com a mesma regra de "outra entidade limpa params velhos"; 4) `AuthLayout` passa a resolver `?contact=` na troca de org como faz com `?lead=` (só a lista de params de entidade; sem query nova: se `resolveEntityOrg` não suportar contato, o param é apenas descartado na troca, o que já é o comportamento seguro).
- **Critérios:**
  - [ ] Nenhum arquivo em `leads/detail`, `contacts/detail`, `tasks/detail` > 600 linhas.
  - [ ] `grep -rn "export function TaskDetailSlideOver" src | wc -l` = 1.
  - [ ] Teste de `orgSwitch`: `contact`, `contactTab`, `leadTab` tratados conforme seção 6.
- **Testes:** `leadFields.test.ts`, `mentions.test.ts` (estendido), `orgSwitch.test.ts` (estendido).
- **Tamanho:** M/L.
- **Riscos:** `LeadDetailPanel` é aberto de 4 lugares (Funil, Conversas, Contatos, Tarefas) → reexport no caminho antigo até o PR 13; `grep` de imports na descrição.

### PR 13 — Funil e Agenda

- **Objetivo:** dividir `KanbanBoard`, levar modo/busca/filtros do Funil para a URL e fazer a Agenda obedecer `?view=&date=&event=`.
- **Arquivos:** `funnel/*` (5.5), `src/lib/funnelFilters.ts` + teste, `src/hooks/useFunnelUrlState.ts`, `KanbanBoard.tsx` (reexport), `calendar/useCalendarState.ts` (lê/escreve URL), `calendar/CalendarPage.tsx`, `src/lib/calendarUrl.ts` + teste (parse de `date` inválida → hoje; `view` inválida → `day` no mobile, `week` no desktop).
- **Passos:** 1) mover; 2) `StageEditPopover` e seletor de funil sobre `Popover`/`Menu` (sai `window.innerWidth`); 3) URL do Funil; 4) URL da Agenda; 5) `LeadCard` com prop opcional `lastMessage` (seção 9.8), sem dado ainda.
- **Critérios:**
  - [ ] `wc -l src/components/funnel/FunnelPage.tsx` < 700; nenhum outro arquivo do funil > 450.
  - [ ] `grep -rn "window.innerWidth\|window.innerHeight" src/components/funnel src/components/tasks/ProjectSwitcher.tsx` vazio.
  - [ ] `calendarUrl.test.ts`: `?date=2026-11-04&event=x&view=week` produz o estado esperado; o link de `UpcomingEventsWidget` abre o evento.
  - [ ] `?board=` e `?lead=` continuam (checklist 5.5).
- **Testes:** `funnelFilters.test.ts`, `calendarUrl.test.ts`, `LeadCard.test.tsx` (com e sem `lastMessage`).
- **Tamanho:** L.
- **Riscos:** drag-and-drop do `@dnd-kit` depende da árvore de componentes (ids de draggable/droppable) → ids preservados literalmente; nenhum teste automático cobre o arrasto, então o PR lista a sequência de componentes e ids antes/depois.

### PR 14 — Varredura final: URL nas demais telas, acessibilidade, mobile e vocabulário restante

- **Objetivo:** fechar as pendências: filtros na URL (Tarefas, Histórico, Campanhas, Equipe), `dvh`, texto pequeno, `title` → `Tooltip` nos controles, guard de `aria-label`, `role="switch"` inline restantes, zerar o `PENDING_SCOPE` do guard de vocabulário, estados vazios das 14 páginas.
- **Arquivos:** `TasksPage.tsx`, `AuditLogs.tsx`, `CampaignsPage.tsx`, `TeamPage.tsx`, `layout/*`, `ui/{Modal,SlideOver}.tsx`, `main.tsx`, arquivos com `text-[9px|10px|11px]` (lote mecânico), `ChannelsSection` remanescentes/`InviteMemberModal`/`BridgeGroupsPanel`/`MemberDetailSlideOver`/`NotificationPreferences` (switch inline → `Switch`), `src/lib/uiClassGuard.test.ts`, `src/lib/a11yGuard.test.ts`, `src/lib/vocabGuard.allowlist.ts`, `src/lib/vocab.ts` (`empty` de cada página).
- **Passos:** 1) `useSearchParamState` nas quatro telas (tabela 6); 2) `dvh` (7.2); 3) `text-caption` (7.3) em lote com `sed` + revisão das 10 maiores ocorrências por arquivo; 4) `Tooltip` nos ícone-only de `layout/`, `inbox/`, `funnel/`; 5) guards de classe e de a11y; 6) textos restantes do glossário até o `PENDING_SCOPE` ficar vazio.
- **Critérios:**
  - [ ] `grep -rnE "text-\[(9|10)px\]" src/components | grep -v "WhatsAppPreview\|forms/renderer"` vazio.
  - [ ] `PENDING_SCOPE` vazio e `vocabGuard` verde.
  - [ ] `grep -rn 'role="switch"' src/components | grep -v "ui/Switch.tsx"` vazio.
  - [ ] `a11yGuard` verde no escopo `layout/ ui/ inbox/ settings/ funnel/`.
  - [ ] Teste de cada nova URL de filtro em `searchParamState.test.ts` (tipos e defaults).
- **Testes:** os dois guards + extensões.
- **Tamanho:** M (muitas trocas mecânicas; se passar de 700 novas, dividir em 14a "URL" e 14b "a11y/mobile/vocabulário", sem mudar a ordem).
- **Riscos:** trocar `text-[10px]` dentro de badges pequenos estourar o layout → `text-micro` (11 px) dentro de badge redondo; lista de exceções revisada na descrição.

### Dependências entre PRs

```
PR1 ─┬─ PR2 ─┬─ PR3 ─┬─ PR4 ─ PR5 ─ PR6 ─ PR7 ─ PR8 ─ PR9
     │       │       │                              
     │       │       └──────────── PR10 ─ PR11 ─ PR12 ─ PR13 ─ PR14
```

PR 10 depende de PR 3 (Menu, Tooltip) e PR 4 (glossário); não depende de Configurações. Com dois agentes em paralelo, a trilha "Configurações" (6→9) e a trilha "Conversas/detalhes" (10→13) podem correr juntas depois do PR 5; o PR 14 fecha as duas.

---

## 11. Decisões assumidas

1. **Rotas não mudam**, só rótulos (P1). `/app/entrada` exibe "Conversas", `/app/repasses` exibe "Requer atenção", `/app/pipeline` exibe "Funil", `/app/auditoria` exibe "Histórico de alterações", `/app/central` exibe "Relatórios", `/app/calendario` exibe "Agenda". Trocar caminhos depois exige redirecionamentos e mudar os geradores de link do backend; não vale o risco agora.
2. "Requer atenção" é página própria com atalho em Conversas (1.5), porque não há filtro de servidor por pedido pendente.
3. "Lead" continua como termo (glossário #8), centralizado em `VOCAB.lead` para troca futura. "Follow-up" e "Copiloto" também continuam.
4. `?secao=` continua sendo o único parâmetro de Configurações, com ids estáveis; o grupo é derivado.
5. Formulários de configuração seguem o padrão "campos controlados + painel que salva patch parcial", base da reutilização pelo onboarding.
6. `Select` é `<select>` nativo estilizado; nenhuma biblioteca headless nova. `Popover/Menu/Tooltip` são próprios com posicionamento puro testado.
7. Testes de componente cobrem primitivos e componentes de apresentação por props; componentes com Convex não ganham mock de `useQuery` neste plano.
8. Alvo de 44 px garantido em ponteiro grosso (`coarse:`), sem aumentar a densidade do desktop.
9. Caption mínima de 12 px; 11 px só em badge de contagem.
10. Barra inferior: Painel, Conversas, Requer atenção, Funil, Mais.
11. Preferências pessoais (direto/grupo, canal, colunas, último funil) continuam em `localStorage`; filtros de tela vão para a URL.
12. O lead embutido não ganha gravação de voz nem agendamento (paridade com hoje).
13. Medida de tamanho de PR ignora linhas puramente movidas.

## 12. Fora do escopo

- **Sistema de temas** (tokens, 3 temas, alternador, `Toaster theme`, 151 hex crus): seção de temas. Aqui só se reserva o painel `appearance`.
- **Assistente de onboarding v2 e ferramentas do Copiloto** para configurar o atendente: seção de onboarding. Aqui só os formulários reutilizáveis, os ids de painel e `FIRST_STEP_TARGETS`.
- **Qualquer mudança no backend**, incluindo: prévia da última mensagem no cartão do lead (`getLeads` não devolve `lastMessagePreview`); filtro de servidor "com pedido de ajuda pendente" em `getConversations`; textos de notificações, e-mails e mensagens do Telegram ("Repasse solicitado" etc.), que continuam com o vocabulário antigo até um PR de backend dedicado; `resolveEntityOrg` para `?contact=`.
- Landing page, `/developers` e o `CHANGELOG` antigo: o vocabulário novo vale para o app logado e para entradas novas do CHANGELOG; reescrever a landing é trabalho de marketing.
- Renomear identificadores de código (`Inbox`, `HandoffQueue`, `KanbanBoard`, `handoffs`, `boards`): o código mantém os nomes técnicos; só a interface muda.
- Testes end-to-end (Playwright) e regressão visual.
- Paleta de comandos (Cmd+K), automações, DatePicker próprio.
- Migração completa dos 111 `<select>` e 322 `title=`: o plano migra Configurações, Conversas, Funil e controles ícone-only; o resto segue progressivo, protegido pelos guards.

## 13. Documentação a atualizar (no PR indicado)

| Documento | O que muda | PR |
|---|---|---|
| `src/CLAUDE.md` | Árvore: remover `App.tsx`/`Dashboard.tsx`; adicionar `lib/nav.ts`, `lib/vocab.ts`, `lib/format.ts`, `settings/{ai,attendant,channels,advanced}/`, `inbox/{ConversationList,ConversationThread,Composer,ConversationHeader}`, `leads/detail/`, `contacts/detail/`, `tasks/detail/`, `funnel/`, `src/test/`. Navegação: "`Tab` em `lib/routes.ts`; Sidebar e BottomTabBar renderizam `NAV_ITEMS`; item ativo por `activeTabForPath`". Rótulos da nav pelo glossário. | 1, 5, 6, 8, 11, 13 |
| `.claude/rules/frontend.md` | Seção "Language and copy": glossário, sentence case, toasts, guard. Seção "UI primitives": lista nova (Switch, Tabs, SegmentedControl, Select, FormField, Textarea, PageHeader, SectionCard, Tooltip, Popover/Menu, Stepper, SearchInput, Button `loading`/`iconOnly`). Seção "Routing and deep links": tabela de params (seção 6), push × replace, `useSearchParamState`, `ORG_AGNOSTIC_PARAMS`. Seção "Mobile-first": `coarse:` e `dvh`, `text-caption`. Seção "Where logic goes": testes `.tsx` no projeto "componentes" (jsdom), só componentes de apresentação. | 3, 4, 5, 10, 14 |
| `STYLE_GUIDE.md` | Tipografia (caption 12 px, micro 11 px só em badge), botões e alvos de toque, padrões de `PageHeader`/`SectionCard`/`EmptyState`, capitalização, padrão de toasts e erros, glossário resumido com link para `vocab.ts`. | 3, 4 |
| `docs/architecture/frontend.md` | Parágrafos novos: modelo de navegação; Configurações em dois níveis e registro; padrão "campos controlados + painel" (contrato com o onboarding); decomposição do Inbox e o thread compartilhado com o lead; URL como verdade e o mecanismo de escrita em voo; infra de testes de componente; lazy das páginas públicas. | 1, 5, 6, 8, 11 |
| `docs/architecture/inbox.md` | Onde mora cada comportamento do Inbox após os PRs 10-11; faixa "Requer atenção". | 10, 11 |
| `docs/architecture/ai-attendant.md` | Painéis de configuração do atendente e o salvamento parcial. | 8 |
| `docs/architecture/README.md` | Nada novo além das linhas de índice se algum arquivo de área ganhar seção nova. | — |
| `CHANGELOG.md` (PT-BR, para o cliente) | Uma entrada por PR com mudança visível. Exemplos: "Novos nomes no menu: Caixa de Entrada agora é **Conversas**, Repasses agora é **Requer atenção**, Pipeline agora é **Funil**, Auditoria agora é **Histórico de alterações**." / "Configurações reorganizadas em grupos, com busca. A transcrição de áudios e a leitura de imagens ficam em Atendente IA › Recursos da IA." / "No celular, a barra inferior mostra Conversas e Requer atenção." Sem jargão técnico, sem nomes de arquivo. | 4, 5, 6, 8, 9, 10, 13 |
