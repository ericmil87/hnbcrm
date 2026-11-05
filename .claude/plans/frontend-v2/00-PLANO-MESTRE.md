# Frontend v2 — plano mestre

> Data: 04/11/2026. Base: `main` em `41ce687` (v0.78.1). Autoria: inventário por 4 agentes Sonnet (`inventarios/`), seções por 3 agentes Opus (`01-`, `02-`, `03-`), consolidação e arbitragem aqui. **Onde uma seção contradizer este arquivo, vale este arquivo.**

## 1. Para quem e para quê

HNBCRM é "WhatsApp Business com funil e um Atendente IA". O público que paga é dono de PME, corretor de imóveis e startup pequena: gente que sabe usar WhatsApp e não sabe (nem quer saber) o que é bridge, handoff, pipeline ou autopilot. O frontend v2 entrega quatro coisas, nesta ordem de valor:

1. **Mais fácil de usar**: vocabulário do dia a dia (uma palavra por conceito), 4 grupos de navegação em vez de 14 itens soltos, Configurações em 6 grupos com busca e nada a mais de 2 cliques, página "Requer atenção" (ex-"Repasses") com "Assumir conversa" e "Devolver à IA" sempre à vista.
2. **Temas**: Escuro (o atual), Claro (corrigido para AA) e **Estilo WhatsApp** (acento verde, área de conversa com papel de parede e bolhas verdes). Preferência por pessoa, segue a conta entre aparelhos.
3. **Onboarding "do zero ao WhatsApp com IA em 10 minutos"**: 8 passos (Seu negócio → Seu funil → Conectar WhatsApp → Atendente IA → Teste → Extras → Equipe → Pronto), WhatsApp por QR code como padrão com **conexão por código** no celular, persona escrita pela IA a partir da descrição do negócio, transcrição e leitura de imagens ligadas com um toque, checklist "Primeiros passos" no Painel até completar.
4. **Copiloto que configura o Atendente IA**: 9 ferramentas novas (ler e propor mudanças de jeito de atender, conhecimento, horário, palavras que chamam a equipe, follow-up, áudio, imagens), sempre em duas fases com prévia "Antes → Depois" e clique humano. Vale no painel e no Telegram (mas nunca no modo automático do Telegram).

## 2. Arquivos deste plano

| Arquivo | Conteúdo | Quem lê |
|---|---|---|
| `00-PLANO-MESTRE.md` (este) | visão, decisões de integração, glossário resumido, **ordem única de execução**, critérios globais, pendências do dono | orquestrador, sempre |
| `01-temas.md` | sistema de temas: tokens RGB, paletas por tema, chat, aplicação/persistência, seletor, guardas; PRs T1–T6 (+T7 opcional) | implementador do PR do trilho T |
| `02-onboarding-ia.md` | wizard v2, "Configurar com IA", tools do Copiloto, templates por segmento, código de conexão na web; PRs O1–O10 | implementador do PR do trilho O |
| `03-reorganizacao-vocabulario.md` | glossário completo (40 termos), nav única, Configurações em 2 níveis, primitivos, decomposição dos componentes gigantes, URL, mobile/a11y; PRs R1–R14 | implementador do PR do trilho R |
| `inventarios/*.md` | fatos medidos no código (rotas, contagens, linhas, lacunas) | implementador, para conferir um fato; não é plano |
| `PROMPT-CLOUD.md` | prompt do orquestrador para o Claude Code cloud | o dono cola na sessão |
| `STATUS.md` | memória do orquestrador entre PRs (criado/atualizado por ele) | orquestrador |

## 3. Princípios que valem para todos os PRs

- **Rotas não mudam, só rótulos.** `/app/entrada` exibe "Conversas", `/app/repasses` exibe "Requer atenção", `/app/pipeline` exibe "Funil". O backend (Telegram, e-mail, sino, retorno OAuth da Meta) gera esses links e `?secao=` com ids legados; nada disso quebra.
- **Identificadores de código não mudam** (`Inbox`, `HandoffQueue`, `handoffs`, `boards`, `agentProfile`…). Só a interface muda. Nomes novos em arquivos novos podem usar o vocabulário novo (`ConversationThread`, `AttentionQueue` não: continua `HandoffQueue`).
- **Tokens, nunca cor crua.** Depois de T1/T2, toda cor nova é token (`surface/text/border/brand/semantic/ai/chat-*`). Cores escolhidas pelo usuário (etapas, etiquetas) e a paleta canônica do `WhatsAppPreview` são as únicas exceções.
- **URL é a fonte da verdade** para entidade aberta, aba e filtros. Parâmetros existentes mantidos; novos listados em `03 › §6`.
- **Primitivos antes de código novo.** `src/components/ui/` existentes + os de R2/R3. Nenhum `<select>` cru, switch artesanal ou `title=` novo.
- **Componentes de configuração = campos controlados + painel que salva patch parcial** (`03 › §3.4`): `fromProfile/toPatch/validate` puros em `src/lib/attendantConfig.ts`. O wizard monta os mesmos campos e decide quando salvar. É o contrato entre os trilhos R e O.
- **Backend**: `requireAuth`/`requirePermission` sempre; `requireAccountWithEmail` nas portas críticas (O2 fecha a lacuna em `updateAgentProfile`, `setFeatureToggles`, `createAttendantOneClick`, `createChannelConfig`); schema só aditivo; side effects pelas portas únicas; nenhuma tool do Copiloto liga `aiConfig.enabled` nem grava aceite (LGPD, risco do bridge, autopilot antecipado); toda escrita de configuração pelo Copiloto é two-phase com `beforeHash`.
- **Cada PR traz seus testes e sua documentação** (CHANGELOG sob `## [Não lançado — Frontend v2]`, área em `docs/architecture/`, regra em `.claude/rules/frontend.md`/`src/CLAUDE.md` quando muda a forma de codar). Testes de guarda existentes nunca são afrouxados.
- **PT-BR, sentence case, sem emoji como ícone, 44 px no toque, mobile-first, Escuro padrão.**

## 4. Glossário resumido (completo em `03 › §1.2`, código em `src/lib/vocab.ts` a partir de R4)

| Conceito | Nome na interface | Some |
|---|---|---|
| Tela de mensagens | **Conversas** | Caixa de Entrada, Entrada, inbox |
| Fila em que a IA pediu ajuda | **Requer atenção** | Repasses, Fila de Repasses |
| Item dessa fila | **Pedido de ajuda** ("A IA pediu ajuda") | repasse, handoff |
| Aceitar / recusar | **Assumir conversa** / **Devolver à IA** | Aceitar repasse, Deixar com a IA |
| Funil de vendas / fase | **Funil** / **Etapa** | Pipeline, Board, Quadro, Estágio |
| Pessoa no funil | **Lead** (centralizado em `VOCAB.lead`) | — |
| IA que fala com clientes | **Atendente IA** | Atendente virtual, Assistente, bot, "Atendente com IA" |
| IA que ajuda a equipe | **Copiloto** ("assistente da sua equipe") | Copiloto IA, Assistente no app |
| Modos | **Sugerir respostas** / **Responder sozinha** | modo sugestão, Autopilot |
| Texto da IA aguardando revisão | **Resposta sugerida** | Rascunho da IA |
| WhatsApp oficial / não oficial | **WhatsApp oficial (Meta)** / **WhatsApp por QR code** | Cloud API, bridge, gateway |
| Conectar um número | **Conectar número**; "código de conexão" | Provisionar, parear, instância, "código de pareamento" |
| Canal × origem | **Canal** (WhatsApp/Instagram) / **Origem** (de onde veio o lead) | Canal de aquisição, Fonte de leads |
| Persona / conhecimento | **Jeito de atender** / **O que a IA sabe do seu negócio** | Persona, Conhecimento |
| Auditoria / Central / Calendário | **Histórico de alterações** / **Relatórios** / **Agenda** | — |
| Chaves API / Opt-out / Tag | **Chaves de integração** / **Descadastrados** / **Etiqueta** | — |

Ficam: Tarefa, Projeto, Campanha, Grupo, Formulário, Equipe, Configurações, Follow-up, Transcrição, Painel.

## 5. Decisões de integração (onde as seções se sobrepunham)

| # | Conflito | Decisão | Efeito nos arquivos de seção |
|---|---|---|---|
| I1 | Extração dos formulários do Atendente: `02 › PR O8` (componentes em `src/components/ai/` que salvam sozinhos) × `03 › PR R7/R8` (campos controlados + painel, `settings/attendant/`, `src/lib/attendantConfig.ts`) | **Vale o padrão de `03`** (testável por props, o wizard decide quando salvar). **O8 deixa de existir como está**; vira **O8'** = só o que o wizard precisa e `03` não cria: `FunnelEditor` (de `WizardStep2Pipeline`), variante `inline` do simulador (`AttendantSimulator`), presets de horário em `AttendantHoursForm` (`variant="wizard"`), `src/lib/pairingUi.ts` (+teste). Caminhos de `03`. | Em `02`, substituir a seção D e o PR 8 por este O8'; `ChannelConnectCard` fica em `settings/channels/` e nasce em **R9** já com "Conectar com código" (consome O3). |
| I2 | Onde fica "Aparência": `01` (card em Configurações › Geral + botão na sidebar + linha no "Mais") × `03` (painel reservado `?secao=appearance`, grupo Conta) | **Painel `appearance` de `03` + botão na sidebar + linha no "Mais" de `01`.** O card não entra em Geral. | T5 implementa `AppearancePanel` e o registra em `settings/registry.ts` (R6). Por isso **R6 antes de T5**. |
| I3 | Vocabulário divergente entre `inventarios/textos.md` e `03 › §1.2` ("Atendente com IA" × "Atendente IA"; "Assistente da equipe" × "Copiloto"; "código de pareamento" × "código de conexão") | **Vale `03 › §1.2`**, com um acréscimo: "código de pareamento" → **"código de conexão"** em toda a UI (o termo técnico `pairphone` fica no código). | Copy do wizard em `02` e do seletor em `01` segue o glossário; o `vocabGuard` (R4) cobre. |
| I4 | Catraca de cores cruas (T3) × decomposições que movem código com classes cruas (R10–R13) | A catraca é por arquivo; **arquivo novo nasce com zero cor crua**: quem move código migra para token no mesmo PR. T1–T3 entram antes de R10. | Critério acrescentado aos PRs R10–R13. |
| I5 | Infra de teste: `03 › R1` cria projetos vitest (`edge-runtime` para `*.test.ts`, `jsdom` para `*.test.tsx`); testes de `01` que leem `index.css` precisam de `fs` | Testes que leem arquivo levam `// @vitest-environment node` na primeira linha (padrão já usado no repo). | Critério em T1/T2/T3. |
| I6 | Módulos novos em `convex/` (T4 `convex/uiTheme.ts`; O1–O7 vários) sem `convex codegen` na nuvem | Edição manual de duas linhas em `convex/_generated/api.d.ts` (ver `PROMPT-CLOUD.md › §4`). `tsc -p convex` valida. | — |
| I7 | `CHANGELOG.md` recebe entradas de dois trilhos em paralelo | Um único cabeçalho `## [Não lançado — Frontend v2]` no topo com subtítulos `### Aparência`, `### Configuração inicial e Copiloto`, `### Navegação e Configurações`. Conflito de merge = manter as duas entradas. Versão do `package.json` não muda (o dono roda `/release`). | — |
| I8 | Textos do backend ainda dizem "Repasse" (Telegram, e-mail, sino) — fora do escopo de `03` | PR extra **X1** (backend, S) no fim: trocar o vocabulário visível ao usuário nas notificações/e-mails/mensagens do Telegram, sem mudar ids nem links. | Novo PR nesta tabela. |
| I9 | Escuro atual falha AA em pares centrais (`01 › §0`); `01` o mantém idêntico por premissa | Manter idêntico nas fases 0–5 (evita ruído visual durante a migração). **T7 (opcional, S)** corrige no fim, trocando só valores do `:root` e esvaziando `DARK_KNOWN_FAILURES`. | Novo PR nesta tabela. |
| I10 | "Dados de exemplo" no wizard | Sai do wizard (`02 › H.3`). `requestSampleData` continua existindo para o checklist/Painel oferecer depois. | — |

## 6. Ordem única de execução

Numeração `fv2-NN` é a do ramo (`feat/fv2-NN-<slug>`) e do prefixo de commit. "Origem" aponta o bloco do PR no arquivo de seção. Trilhos: **R** (`03`, só `src/`), **T** (`01`, `src/` + 1 módulo Convex em T4), **O** (`02`, backend primeiro). Dois PRs independentes podem correr em paralelo, no máximo um por diretório (`src/` × `convex/`).

### Fase 0 — Fundação (barata; destrava tudo)

| fv2 | Origem | Título | Camada | Tam. | Depende de |
|---|---|---|---|---|---|
| 01 | R1 (+CI) | Testes de componente (jsdom + Testing Library), limpeza do roteador (sub-rotas ativas, `?date=&event=`, `Dashboard.tsx`/`App.tsx`), `src/lib/format.ts`; **acrescentar `frontend-v2` em `on.push.branches` de `.github/workflows/ci.yml`** | src + ci | M | — |
| 02 | O1 | Templates por segmento (`convex/lib/onboardingTemplates.ts`, puro, 7 segmentos) | convex | M | — |
| 03 | R2 | Primitivos de formulário: Switch, FormField, Textarea, Select, SegmentedControl, Tabs | src | M | 01 |
| 04 | O2 | Portas extraídas (`updateAgentProfileCore`, `setFeatureTogglesCore`) + `requireAccountWithEmail` nas 4 funções + `getPlatformCapabilities` | convex | M | — |
| 05 | R3 | Primitivos de estrutura: PageHeader, SectionCard, Tooltip (toque), Popover/Menu, Stepper, EmptyState, Button `loading`/`iconOnly`/`coarse:`, SearchInput | src | M | 03 |
| 06 | O3 | WhatsApp: `startBridgePairing`/`pollBridgePairing` na web + `webhookUrl` montado no servidor (`CONVEX_SITE_URL`) | convex | M | — |
| 07 | R4 | Glossário `src/lib/vocab.ts` + `vocabGuard.test.ts` + sentence case + troca dos rótulos existentes | src | M | 05 |
| 08 | T1 | Tokens em canais RGB, Escuro idêntico (teste de tokens congelados), remoção dos 37 alfas no-op, `--color-semantic-*` definido | src | M | 07 |
| 09 | R5 | Modelo de navegação único `src/lib/nav.ts` (4 grupos; Sidebar + BottomTabBar; mobile: Painel · Conversas · Requer atenção · Funil · Mais) | src | M | 07 |
| 10 | T2 | Paletas Claro e Estilo WhatsApp, escala `ai-*` (substitui `purple-*`), guarda de contraste AA por tema | src | M | 08 |

### Fase 1 — Vitórias visíveis (temas + Configurações)

| fv2 | Origem | Título | Camada | Tam. | Depende de |
|---|---|---|---|---|---|
| 11 | O4 | Backend do onboarding v2: `onboardingMeta` aditivo (`wizardVersion`, `business`, `aiAssisted`, `steps`, `wizardDeferredAt`), `saveBusinessProfile`, `applyFunnelTemplate` re-executável, `markWizardStep`, `completeWizard` v2, checklist v2 derivado de dados | convex | L | 02, 04 |
| 12 | T3 | Conversa com cara de tema: tokens de chat no Inbox/MessageBubble, cores cruas restantes migradas, catraca `rawColorsGuard.test.ts` | src | M/L | 10 |
| 13 | R6 | Configurações em dois níveis (6 grupos, `settings/registry.ts`, `?secao=` com ids legados, busca, painéis lazy, painel `appearance` reservado) | src | L | 09 |
| 14 | T4 | Aplicação do tema (`data-theme`, `public/theme-init.js`, só sob `/app`), persistência `localStorage` + `teamMembers.uiTheme` (`convex/uiTheme.ts`, `setMyUiTheme` em todas as filiações humanas ativas), `ThemedToaster`, `<meta theme-color>` | src + convex | M | 10 |
| 15 | T5 | Seletor "Aparência": `AppearancePicker` (radiogroup, miniaturas estáticas) no painel `appearance`, botão na sidebar, linha no "Mais"; docs + CHANGELOG | src | M | 12, 13, 14 |
| 16 | O6 | Tools do Copiloto para o Atendente IA (`convex/lib/copilotConfigTools.ts`, 9 tools, two-phase + `beforeHash`, fora do modo automático do Telegram) | convex | L | 04, 11 |

### Fase 2 — Atendente IA e canais nas Configurações (contrato com o wizard)

| fv2 | Origem | Título | Camada | Tam. | Depende de |
|---|---|---|---|---|---|
| 17 | R7 | Atendente IA (1/2): `src/lib/attendantConfig.ts` + testes, divisão de `AiSection` por cartão (`settings/ai/`, `settings/attendant/`, `settings/advanced/AiModelsPanel`) | src | M | 13 |
| 18 | O5 | Gerador de persona `generateAttendantDraft` (action; `agentRuns.kind = attendant_draft`; parse tolerante com fallback no template) | convex | M | 02, 11 |
| 19 | R8 | Atendente IA (2/2): formulários controlados (`AttendantPersonaForm`, `AttendantKnowledgeForm`, `AttendantHoursForm`, `ConversationBehaviorForm`, `FunnelRulesForm`, `HandoffRulesForm`, `FollowUpForm`, `AttendantModeSwitch`), `FeatureToggleCard`, painéis `ai`, `ai-attendant`, `ai-conversation`, `ai-handoff`, `ai-followup`, `ai-features` (transcrição por número + "Ler imagens" a 2 cliques), `ai-usage`, `ai-models`; `AiSection.tsx` removido | src | L | 17 |
| 20 | O7 | Modo conversa "Configurar com IA": `purpose:"setup"` em `/api/copilot/stream`, `contextBlock` montado no servidor, `CopilotPanel` variante embutida | convex + hook | M | 11, 16 |
| 21 | R9 | WhatsApp e canais: `ChannelConnectCard` (WhatsApp oficial × por QR code, aviso de risco, **"Conectar com código"** via fv2-06 + QR), `ChannelCard`, `ChannelTranscriptionToggle`, painéis `channels` e `instagram`; `ChannelsSection` dividido | src | L | 06, 19 |

### Fase 3 — Wizard v2

| fv2 | Origem | Título | Camada | Tam. | Depende de |
|---|---|---|---|---|---|
| 22 | O8' (I1) | Componentes só do wizard: `FunnelEditor` (de `WizardStep2Pipeline`, com "Restaurar sugestão"), `AttendantSimulator` variante `inline` com sugestões por segmento, presets de horário em `AttendantHoursForm variant="wizard"`, `src/lib/pairingUi.ts` (+teste: celular usa código por padrão, formato `XXXX-XXXX`, novo código após 150 s) | src | M | 19, 21 |
| 23 | O9 | Wizard v2 passos 1–4 (Seu negócio com checkbox LGPD humano → `setAiEnabled`; Seu funil → `applyFunnelTemplate`; Conectar WhatsApp → `provisionBridgeChannel` + código/QR, "Pular por enquanto"; Atendente IA → `activateOneFlow` + "Escrever com IA" (`generateAttendantDraft`) + `AttendantPersonaForm` + horário → `updateAgentProfile` com `channelConfigIds` e `pipelineConfig`), rota `/app/configuracao-inicial`, progresso persistido, "Continuar depois" | src | L | 11, 18, 22 |
| 24 | O10 | Wizard v2 passos 5–8 (Teste com `simulateAttendant`; Extras com `getPlatformCapabilities` + transcrição por canal + `visionEnabled`; Equipe; Pronto) + "Configurar com IA" embutido (fv2-20) + "Primeiros passos" v2 no Painel (9 itens) + troca do gating em `AuthLayout` + remoção do wizard v1 + docs | src | L | 20, 23 |

### Fase 4 — Conversas e painéis de detalhe

| fv2 | Origem | Título | Camada | Tam. | Depende de |
|---|---|---|---|---|---|
| 25 | R10 | Conversas (1/2): lógica pura e hooks de URL (`useInboxFilters`), `ConversationList`, `ConversationHeader` com **Assumir conversa / Devolver à IA** à vista, faixa "N conversas precisam de você · Ver" | src | L | 05, 07, 12 |
| 26 | R11 | Conversas (2/2): `ConversationThread` + `Composer` compartilhados com `LeadDetailPanel` (remove ~670 linhas duplicadas) | src | L | 25 |
| 27 | R12 | Painéis de detalhe: lead (`leads/detail/`), contato (`contacts/detail/`, `?contact=`), tarefa (unificar os dois `TaskDetailSlideOver`) | src | L | 26 |
| 28 | R13 | Funil e Agenda: `KanbanBoard` dividido (`funnel/`), "Modo quadro/Modo lista", `?view=&date=&event=` na Agenda | src | M | 05, 07 |
| 29 | R14 | Varredura final: URL nas demais telas (filtros de Histórico, Tarefas, Campanhas), `coarse:` 44 px, `dvh`, caption 12 px, `title=` → Tooltip, aria-label em ícone-only, vocabulário restante, lazy de Developers/Playground/Landing | src | M | 27, 28 |

### Fase 5 — Opcionais (se sobrar orçamento)

| fv2 | Origem | Título | Camada | Tam. | Depende de |
|---|---|---|---|---|---|
| 30 | T6 | Inter self-hosted (`@fontsource-variable/inter`, CSP `font-src 'self'`) | src | S | — |
| 31 | X1 (I8) | Vocabulário novo nos textos do backend visíveis ao usuário: Telegram, e-mails, sino ("A IA pediu ajuda" em vez de "Repasse solicitado"), sem mudar links/ids | convex | S | 07 |
| 32 | T7 (I9) | Escuro acessível: `text-muted`, botão primário, rótulo e tique da bolha da equipe passam AA; `DARK_KNOWN_FAILURES` vazio | src | S | 15 |
| 33 | — | Limpeza: remover `setupPipelineFromWizard`, `requestSampleData` do fluxo antigo (se nada mais usa), `seed.ts` com nomes em inglês | convex | S | 24 |

### Grafo resumido

```
Trilho src:    01 → 03 → 05 → 07 → 08 → 10 → 12 ─┐
                                 └→ 09 → 13 ───────┼→ 15
                                             14 ───┘
               13 → 17 → 19 → 21 → 22 → 23 → 24
               12 + 07 → 25 → 26 → 27 → 29 ;  28 → 29
Trilho convex: 02, 04, 06 (paralelos) → 11 → 16 → 20 ; 11 → 18
Sincronismos:  21 precisa de 06 ; 23 precisa de 11+18 ; 24 precisa de 20
```

### Escopo por ambiente

| Onde | PRs | Por quê |
|---|---|---|
| Claude Code cloud (sessão autônoma, ~US$ 250) | **fv2-01 a fv2-22** | Cabem no orçamento e nenhum deles troca fluxo que um cliente usa hoje sem guarda: o onboarding real (`AuthLayout`) e o Inbox continuam intocados; o backend novo é aditivo e só é chamado por telas que ainda não existem (exceto fv2-04 e fv2-16, cobertos por convex-test). |
| Local, com o Eric acompanhando | **fv2-23 a fv2-33** | Wizard v2 substitui o gating do onboarding; Fase 4 divide o Inbox e os painéis de detalhe; opcionais. Exigem validação viva. |

Retomada: `STATUS.md` em `frontend-v2` (seção "Para retomar") + PR em rascunho `frontend-v2 → main` com a tabela de integrados. Para continuar em sessão nova, colar `PROMPT-CLOUD.md` com a seção 1b ajustada ao novo intervalo.

## 7. Critérios globais de aceite (além dos de cada PR)

```bash
npx tsc -p convex -noEmit --pretty false
npx tsc -p tsconfig.app.json -noEmit --pretty false
npx tsc -p tsconfig.node.json -noEmit --pretty false
npx vitest run          # 0 falhas; contagem nunca diminui
npx vite build
```

- Nenhum teste de guarda apagado ou afrouxado; `{ retry: 2 }` em `groupMediaPolicy.test.ts` intocado.
- Depois de fv2-07: `vocabGuard` verde (termos banidos só em `settings/advanced/` e `/developers`).
- Depois de fv2-10: guarda de contraste AA verde para Claro e Estilo WhatsApp; Escuro idêntico (tokens congelados).
- Depois de fv2-12: `rawColorsGuard` verde; arquivo novo nasce com zero cor crua.
- Deep links que continuam funcionando em todos os PRs: `?conversation=`, `?lead=`, `?task=`, `?handoff=`, `?board=`, `?secao=` (ids legados), `?nova=`, `/app/repasses?handoff=<id>`, "Assumir" → `/app/entrada?conversation=<id>`.
- Revisão pelo `reviewer` sem "bloqueia" aberto.
- `CHANGELOG.md` sob `## [Não lançado — Frontend v2]`; `docs/architecture/` e regras atualizadas quando o PR pede.

## 8. Orçamento e expectativa

| Item | Estimativa |
|---|---|
| Custo médio por PR (implementador Sonnet + revisão Opus + orquestração) | US$ 8–15 |
| PRs que cabem em US$ 250 | 17–25 |
| Cobertura provável | Fases 0–2 inteiras; Fase 3 (wizard) provável; Fase 4 parcial; Fase 5 só se sobrar |

A ordem acima já reflete isso: o que o usuário final vê primeiro (nomes, navegação, temas, Configurações, Atendente IA a 2 cliques) vem antes das decomposições de código. Se o orçamento acabar no meio da Fase 3, o `STATUS.md` diz exatamente onde retomar.

## 9. O que exige o Eric (não automatizável)

- **Antes de rodar o cloud**: o working tree local de `clawcrm-repo` está num estado antigo (igual a `7b697fa`, v0.71.1) com 127 arquivos staged apagando os PRs #26–#39. Não commitar isso. `git reset --hard HEAD` restaura (não há trabalho novo não commitado: índice == commit antigo exato). Depois, commitar `.claude/plans/frontend-v2/` em `main` e dar push: o cloud lê o plano do GitHub.
- **Envs em PROD** (conferir com `npx convex env list --prod`, sem imprimir valores): `WA_BRIDGE_DEFAULT_URL`, `WA_BRIDGE_ADMIN_TOKEN`, `WA_BRIDGE_HMAC_SECRET`, `WHISPER_SERVICE_URL`, `WHISPER_SERVICE_TOKEN`, `OPENROUTER_API_KEY` (ou `OPENCODE_GO_API`), `CONVEX_SITE_URL` (fv2-06 passa a montar o webhook com ela).
- **Validação viva**: código de conexão num aparelho real (validade, se um segundo código invalida o primeiro, rótulos atuais do app WhatsApp); tema Estilo WhatsApp no celular; wizard completo numa org nova em DEV; pedir ao Copiloto "mude o horário para seg a sex 9–18" e confirmar.
- **Textos**: checkbox LGPD do passo 1 (jurídico); os 7 templates de segmento (persona, FAQ, etapas); decidir se "Lead" fica ou vira "Oportunidade" (`VOCAB.lead`, troca em um lugar).
- **Custo**: Copiloto e gerador de persona gastam a chave da plataforma durante o onboarding de contas gratuitas; definir `spendCap` padrão para orgs novas (fora deste plano).
- **Merge e deploy**: revisar `frontend-v2` → `main` (um PR grande ou por fase); backend em PROD só com `npm run deploy:prod` **antes** do merge em `main` que leva o frontend correspondente (Vercel publica o frontend no push). Depois, `/release`.

## 10. Fora do escopo (consolidado)

Tema por organização/white-label; tema "Automático" e WhatsApp escuro; wizard para API oficial da Meta/Instagram (ficam em "Outras opções"); tools do Copiloto para provisionar canal, mudar modelo/provedor/ZDR/teto; histórico de versões de persona com "desfazer"; rotas REST/MCP de configuração do atendente; prévia da última mensagem no cartão do lead (`getLeads` não devolve); filtro de servidor "com pedido de ajuda" em `getConversations`; renomear identificadores de código; landing page e `/developers` (vocabulário novo vale só no app logado); testes E2E/visuais; paleta de comandos; migração completa dos 111 `<select>` e 322 `title=` (progressiva, protegida pelos guards); CSP `enforce`.
