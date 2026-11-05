> Seção do plano Frontend v2 (trilho **O**). Redigida por agente Opus em 04/11/2026 a partir de `inventarios/onboarding-canais-ia.md`. **Onde contradizer `00-PLANO-MESTRE.md` (seção 5, decisões I1, I3, I10), vale o plano mestre: a seção D e o PR 8 deste arquivo foram substituídos pelo PR O8' (fv2-22), e os componentes compartilhados seguem o padrão e os caminhos de `03-reorganizacao-vocabulario.md › §3.4`.** Numeração dos ramos: O1 = fv2-02, O2 = fv2-04, O3 = fv2-06, O4 = fv2-11, O5 = fv2-18, O6 = fv2-16, O7 = fv2-20, O8' = fv2-22, O9 = fv2-23, O10 = fv2-24.

# Plano: Onboarding v2 ("do zero ao WhatsApp com IA em 10 minutos") + configuração assistida por IA + Copiloto que altera o Atendente IA

Base: checkout limpo de HEAD (`41ce687`, v0.78.1). Todos os caminhos são relativos à raiz do repo. Inventário de partida: `scratchpad/inv-onboarding.md` (fatos citados aqui foram conferidos no código de HEAD).

Público-alvo: corretor/imobiliária, startup, pequena e média empresa, sem perfil técnico. Linguagem da UI: PT-BR simples ("Atendente IA", "Requer atenção", "Conectar com código", "Ler imagens", "Ouvir áudios"). Nada de "pipeline", "LGPD ack", "bridge", "webhook", "prompt" na tela do wizard; os termos técnicos ficam no código e nas Configurações avançadas.

---

## 0. Resumo executivo

| Decisão | Recomendação | Por quê (1 linha) |
|---|---|---|
| Fluxo | 8 passos: Negócio → Funil → WhatsApp → Atendente IA → Teste → Extras → Equipe → Pronto | Segue a ordem que o Eric pediu e respeita as dependências reais (visão exige IA ativa; transcrição exige canal) |
| Quando ligar a IA | No fim do passo 1, checkbox humano "Quero que a IA me ajude a configurar" (aceite LGPD) chama `setAiEnabled` | O Copiloto e o gerador de persona exigem `orgAiActive`; sem isso o modo "Configurar com IA" não existe |
| Funil | Nova `applyFunnelTemplate` re-executável enquanto o funil padrão não tem leads; `setupPipelineFromWizard` vira legado | A atual apaga TODOS os boards e origens e roda uma vez só |
| WhatsApp | Bridge gerenciado por padrão; "Conectar com código" (padrão no celular) e "QR" (padrão no computador) | Quem está no próprio celular não consegue escanear o QR da mesma tela |
| Persona | Action `generateAttendantDraft` (LLM da org) devolve rascunho editável; salvar passa por `updateAgentProfile` | Uma porta de escrita só; a IA propõe, o humano aprova |
| Aceites | LGPD, risco do bridge e autopilot antecipado são sempre checkbox humano; nenhuma tool marca aceite | Princípio "avisar, não travar" + CLAUDE.md (IA opt-in com aceite re-checado) |
| Modo conversa | Reusar `CopilotPanel` em variante embutida + `purpose:"setup"` no `/api/copilot/stream`; o servidor monta o `contextBlock` | Zero runtime novo; o mesmo two-phase e o mesmo RBAC do Copiloto |
| Tools do Copiloto | 9 tools novas em `convex/lib/copilotConfigTools.ts`; escrita SEMPRE two-phase com prévia "Antes → Depois"; nunca no modo automático do Telegram | Mudança de config é sensível e precisa de clique humano |
| Gerar persona como tool | NÃO criar `generateAttendantProfileDraft` como tool; criar a tool de leitura `getAttendantSetupGuide` | O Copiloto já é um LLM: ele redige com o guia e propõe via `updateAttendantPersona`; executor de tool roda em mutation e não pode chamar LLM |
| E-mail | Acrescentar `requireAccountWithEmail` em `updateAgentProfile`, `setFeatureToggles`, `createAttendantOneClick` | CLAUDE.md lista "AI toggles" como porta crítica; hoje há lacuna |
| Templates | `convex/lib/onboardingTemplates.ts` puro, testado, importado pelo front | Fonte única para wizard, gerador de persona, Copiloto e testes |

---

## 1. Estado atual (só o que o plano usa)

- **Wizard atual**: 5 passos em `src/components/onboarding/OnboardingWizard.tsx` (538 linhas): setor/porte/objetivo/moeda/fuso → funil (`setupPipelineFromWizard`) → dados de exemplo (`requestSampleData`) → convites → conclusão (`completeWizard`). Não cobre canal, atendente, transcrição nem visão. O "agente IA" do passo de equipe é um `teamMembers` sem `agentProfile`.
- **Gating** em `src/components/layout/AuthLayout.tsx`: só admin; "Pular" fecha só em estado React (volta no reload).
- **Funil**: `onboarding.setupPipelineFromWizard` apaga todos os boards, estágios e origens; recusa se o wizard já terminou ou se há leads.
- **WhatsApp**: `channelConfigs.provisionBridgeChannel` (RP settings:manage + e-mail; `webhookUrl` montado no cliente) → `getBridgeQrCode` (polling 4 s no `QrModal`). O código de pareamento (`runBridgeReconnectStep({mode:"code"})` em `convex/lib/channelReconnectCore.ts`) só é usado pelo Telegram (`convex/telegramReconnect.ts`, teto 3/h por canal na tabela `telegramReconnects`).
- **IA**: `aiSettings.activateOneFlow` (LGPD + aceite bridge + cria atendente em `suggest`), `setAiEnabled`, `updateAgentProfile` (única porta de persona/conhecimento/horário/repasse/follow-up; sem e-mail), `setFeatureToggles` (visão; sem e-mail). Textos em `agentProfileTexts` via `lib/agentProfileTexts.ts`.
- **Transcrição**: `channelConfigs.autoTranscribeAudio` por canal via `updateChannelConfig`; serviço Whisper depende de `WHISPER_SERVICE_URL`. Nenhuma tela diz se ele existe.
- **Simulador**: `attendant.simulateAttendant` (RP settings:view, não exige `orgAiActive`, não passa pelo teto de gasto).
- **Copiloto**: `runCopilotTurn` (`convex/lib/copilotTurn.ts`) aceita `contextBlock` e `toolFilter`; o endpoint web `convex/copilotHttp.ts` só aceita `{organizationId, threadId, message}`. Sessão exige `orgAiActive` e `copilotEnabled !== false`. Nenhuma tool toca `aiConfig`, `agentProfile` ou `channelConfigs`. Two-phase: `pendingActions` + `confirmPendingActionCore` (`convex/lib/copilotPendingActions.ts`), com delegação por família (`isGroupPendingTool`, `isAttendantPendingTool`). Modo automático do Telegram (`telegramCopilot.ts:1060`) filtra `effect === "read"` ou escrita na allowlist `autoWriteTools`.
- **Segurança das tools**: `convex/agentToolSecurity.test.ts` exige nomes únicos, `permission` declarada, `resultFields` sem segredo, e nenhum parâmetro em `INJECTED_PARAM_NAMES` (inclui `agentMemberId`).

---

## A. Wizard v2

### A.1 Fluxo

| # | Passo (título na tela) | O que o usuário faz | Porta de backend | Nova? | Pode pular? |
|---|---|---|---|---|---|
| 1 | **Seu negócio** | Escolhe o segmento (7 cartões), digita nome do negócio, "o que você vende" (1–3 frases), "quem são seus clientes", tom (Formal / Amigável / Descontraído), cidade/região opcional. País/fuso/moeda num "Mais opções" recolhido (default BRL, America/Sao_Paulo, 55). No rodapé: checkbox "Quero que a IA me ajude a configurar (o assistente processa dados de clientes com provedores de IA, conforme a LGPD)" | `onboarding.saveBusinessProfile` + (checkbox marcado) `aiSettings.setAiEnabled({enabled:true, lgpdAck:true})` | `saveBusinessProfile` nova | Não (segmento e "o que vende" obrigatórios) |
| 2 | **Seu funil** | Vê o funil sugerido do segmento (5–7 etapas), renomeia, reordena, adiciona/remove; botão "Restaurar sugestão". Opcional: "Campos que importam" (checkboxes vindos do template, ex. "Tipo de imóvel", "Orçamento") | `onboarding.applyFunnelTemplate` | Nova | Sim (fica o "Funil de Vendas" criado na criação da org) |
| 3 | **Conectar WhatsApp** | Cartão único "Seu WhatsApp" com nome de exibição; "Conectar com código" (digita o número, recebe `XXXX-XXXX`, instrução em 4 passos com prints) ou "Mostrar QR". Status ao vivo (Aguardando → Conectado como +55…). Aviso de risco do WhatsApp não oficial em linguagem simples com checkbox. Link "Outras opções" (API oficial da Meta, Instagram) abre as Configurações em nova aba | `provisionBridgeChannel` (sem `webhookUrl` do cliente) → `startBridgePairing` / `pollBridgePairing` (novas) | Duas actions novas | Sim ("Pular por enquanto") |
| 4 | **Atendente IA** | (a) se a IA não foi ligada no passo 1: checkbox LGPD aqui; checkbox "Entendo o risco de usar IA no WhatsApp não oficial" se há canal bridge. (b) botão "Criar meu atendente" → cria em modo **Sugerir** (a IA escreve, a equipe aprova). (c) "Escrever com IA" gera nome, persona, conhecimento, palavras de repasse e mensagem de boas-vindas a partir do passo 1; usuário edita no `AttendantPersonaForm`. (d) Horário de atendimento (presets: "Sempre", "Comercial seg–sex 8–18", "Personalizado"). Salvar | `activateOneFlow` → `generateAttendantDraft` (nova action) → `updateAgentProfile` (patch com `systemPrompt`, `knowledge`, `handoffKeywords`, `schedule`, `channelConfigIds`, `pipelineConfig.boardId/initialStageId`) | `generateAttendantDraft` nova | Sim (sem atendente; checklist cobra) |
| 5 | **Teste** | Chat simulado: 3 perguntas típicas do segmento como botões ("Quanto custa?", "Tem horário amanhã?", "Quero falar com uma pessoa") + campo livre. Mostra a resposta e as ações que a IA faria ("moveria para Qualificado", "pediria atendimento humano"). Botão "Ajustar persona" volta ao passo 4 | `attendant.simulateAttendant` (existente) + `onboarding.markWizardStep({step:"test"})` | Não | Sim |
| 6 | **Extras** | Dois cartões: "Ouvir áudios (transcrever mensagens de voz)" e "Ler imagens (descrever fotos e comprovantes)". Cada um diz o que faz, custo em palavras ("incluído no plano" / "cerca de R$ 0,002 por imagem"), e se está disponível neste servidor. Liga com 1 toque | `channelConfigs.updateChannelConfig({autoTranscribeAudio})`; `aiSettings.setFeatureToggles({visionEnabled})`; leitura `onboarding.getPlatformCapabilities` (nova) | Query nova | Sim |
| 7 | **Equipe** | Convites humanos (nome, e-mail, papel). Remove o convite de "agente IA" vazio | `nodeActions.inviteHumanMember` (existente) | Não | Sim |
| 8 | **Pronto** | Resumo do que ficou configurado e do que falta; botão "Ir para o Painel"; a lista "Primeiros passos" passa a morar no Painel até completar | `onboarding.completeWizard` (ajustada para v2) | Ajuste | — |

O passo "Dados de exemplo" sai do wizard: misturar leads fictícios com o WhatsApp real confunde o usuário e trava a re-execução do funil (`applyFunnelTemplate` recusa com leads). `requestSampleData` continua existindo e não é chamado pelo wizard v2.

### A.2 Modo "Configurar com IA" dentro do wizard

Em todos os passos, se `aiActive` e `copilotEnabled`, aparece o botão "Configurar conversando" que abre o painel de chat embutido (seção B). As mudanças propostas pela IA aparecem como cartões "Antes → Depois" com "Confirmar"; ao confirmar, o passo correspondente se atualiza sozinho (queries reativas). Os aceites continuam como checkboxes nos passos 1 e 4; o chat responde "marque a caixa X no passo Y" quando precisar.

### A.3 Dependências e mensagens de pré-requisito

| Situação | O que a UI mostra | Onde se decide |
|---|---|---|
| Conta sem e-mail (sessão anônima legada) | Bloco no topo do wizard: "Para conectar o WhatsApp e ligar a IA, entre com e-mail e senha." Passos 3, 4 e 6 desabilitados | `getOnboardingStatus.accountHasEmail` |
| Gateway gerenciado não configurado (`WA_BRIDGE_DEFAULT_URL` ou `WA_BRIDGE_ADMIN_TOKEN` ausente) | Passo 3: "A conexão rápida do WhatsApp ainda não está disponível neste servidor. Você pode pular e conectar depois em Configurações › Canais." Botões de conexão escondidos; "Pular" em destaque | `getPlatformCapabilities.managedBridge` |
| `WA_BRIDGE_HMAC_SECRET` ausente ou curto | Mesmo texto acima (o provisionamento falharia) | `getPlatformCapabilities.managedBridge` também exige HMAC ≥ 32 |
| Nenhuma chave de LLM da plataforma e sem BYO | Passo 1 esconde o checkbox de IA; passo 4 cria o atendente com a persona do template (sem "Escrever com IA") e avisa "A IA ainda não está disponível neste servidor"; passo 5 escondido | `getPlatformCapabilities.llm` |
| Whisper ausente (`WHISPER_SERVICE_URL`) | Cartão "Ouvir áudios" desabilitado com "Indisponível neste servidor" | `getPlatformCapabilities.transcription` |
| Visão sem IA ativa | Cartão "Ler imagens" desabilitado com "Ligue o Atendente IA primeiro" | `getAiStatus.active` |
| Teto de gasto em `block` | Botão "Escrever com IA" e chat mostram a mensagem de teto (`SPEND_CAP_BLOCKED_MESSAGE`) | `generateAttendantDraft` e `copilotStream` já checam |
| Usuário não admin | Wizard não aparece (regra atual) | `computeShouldShowWizard` |

### A.4 Modelo de dados do progresso (aditivo)

Campo novo e opcional em `organizations.onboardingMeta` (`convex/schema.ts` ~713). Nada é removido; orgs antigas continuam válidas.

```ts
onboardingMeta: v.optional(v.object({
  industry: v.optional(v.string()),        // existente; passa a guardar o segmento v2
  companySize: v.optional(v.string()),     // existente
  mainGoal: v.optional(v.string()),        // existente
  wizardCompletedAt: v.optional(v.number()), // existente
  // ── v2 (aditivo) ──
  wizardVersion: v.optional(v.number()),   // 2 para orgs que entraram no fluxo novo
  business: v.optional(v.object({
    displayName: v.optional(v.string()),   // ≤ 80
    offer: v.optional(v.string()),         // "o que você vende", ≤ 600
    audience: v.optional(v.string()),      // "quem são seus clientes", ≤ 400
    tone: v.optional(v.union(v.literal("formal"), v.literal("amigavel"), v.literal("descontraido"))),
    region: v.optional(v.string()),        // ≤ 80
  })),
  aiAssisted: v.optional(v.boolean()),     // marcou "Quero que a IA me ajude"
  steps: v.optional(v.object({
    business: v.optional(stepStateValidator),
    funnel: v.optional(stepStateValidator),
    whatsapp: v.optional(stepStateValidator),
    attendant: v.optional(stepStateValidator),
    test: v.optional(stepStateValidator),
    extras: v.optional(stepStateValidator),
    team: v.optional(stepStateValidator),
  })),
  wizardDeferredAt: v.optional(v.number()), // "Continuar depois" persistido
})),
// stepStateValidator = v.object({ status: v.union(v.literal("done"), v.literal("skipped")), at: v.number() })
```

Regras:
- **Fonte de verdade = dados reais quando existem.** `getOnboardingStatus` deriva "feito" de dados (canal conectado, atendente existe, visão ligada etc.); `steps.*` guarda só o que não dá para derivar ("pulou", "testou", "revisou a persona").
- **Retomada**: o passo atual do usuário continua em `onboardingProgress.wizardCurrentStep` (por membro, já existe). Ao abrir, o wizard vai para o primeiro passo sem estado em `steps`, a menos que o membro tenha um passo salvo mais adiante.
- **Pular o wizard inteiro** ("Continuar depois") grava `wizardDeferredAt`; `computeShouldShowWizard` passa a devolver falso com ele. O Painel mostra o cartão "Continue a configuração" que abre a rota `/app/configuracao-inicial`.
- **Admin-only**: as mutations novas exigem `requirePermission(ctx, orgId, "settings", "manage")`; a exibição automática continua só para `role === "admin"`.
- **Orgs legadas** (com `wizardCompletedAt` e sem `wizardVersion`): nunca recebem o wizard à força; podem abri-lo pela rota a partir do checklist ou de Configurações › Geral ("Refazer configuração guiada"). Nesse modo o passo Funil cria um funil NOVO em vez de substituir (ver A.5).

### A.5 Funil re-executável (`applyFunnelTemplate`)

Nova mutation em `convex/onboarding.ts`:

```ts
applyFunnelTemplate({
  organizationId,
  boardName: string,          // 1–60
  boardColor?: string,
  stages: [{ name, color, isClosedWon?, isClosedLost? }], // 2–12; exatamente 1 ganho e 1 perda no máximo
  fields?: [{ key, name, type, options? }],                // ≤ 8, do template
}) → { boardId, mode: "replaced" | "created" }
```

Comportamento seguro:
1. RP(settings, manage).
2. Localiza o board padrão (`isDefault`). Se ele **não tem nenhum lead** (`leads.by_board` `.first()` nulo) e não está arquivado: **substitui no lugar**. Mantém o `boardId`, apaga só estágios sem leads e recria os estágios na ordem; renomeia o board. Não toca outros boards nem `leadSources`.
3. Se o board padrão tem leads: cria um board novo (`createBoardWithStages` core) com `isDefault:false` e devolve `mode:"created"`; a UI explica "Seu funil atual tem contatos, criamos um novo ao lado".
4. Se algum atendente aponta `pipelineConfig.boardId`/`initialStageId`/`qualifiedStageId` para estágios que sumiram, re-aponta `initialStageId` para o 1º estágio aberto e limpa `qualifiedStageId` (via o core de `updateAgentProfile`, auditado).
5. Campos: upsert por `key` em `fieldDefinitions` (não duplica ao re-executar).
6. Grava `onboardingMeta.steps.funnel = {status:"done", at}`, `auditLogs` (severity medium) e `activities` não se aplica (sem entidade de lead).
7. Idempotente: chamar duas vezes com o mesmo payload produz o mesmo estado.

`setupPipelineFromWizard` fica como está (o wizard v1 some no PR 10). Marcar no código como legado; removê-la num PR futuro depois de confirmar que nenhum cliente a chama.

### A.6 Conectar WhatsApp: código de pareamento na web

Novas actions em `convex/channelConfigs.ts`, ambas autorizadas por `internalGetConfigForMember` (RP settings:manage) e conta com e-mail:

| Função | Args | Retorno | Regras |
|---|---|---|---|
| `startBridgePairing` | `{configId, mode: "qr" \| "code", phone?: string}` | `{state: "qr" \| "code" \| "connected" \| "error", qrCode?, linkingCode?, displayPhoneNumber?, displacedFrom?, error?, attemptsLeft?}` | `mode:"code"` exige `phone`; normaliza com `normalizePhone` de `convex/lib/phone.ts` usando `settings.defaultCountryCode`; recusa se < 10 dígitos. Teto **3 códigos por hora por canal**, contado na mesma tabela `telegramReconnects` (uma linha por canal, `hourStart`/`attempts`), para que web e Telegram somem no mesmo teto anti-ban. QR não conta no teto (comportamento atual). Grava `bridgePhone` só quando o pareamento conclui (o core já faz). Nunca loga nem persiste o código ou o QR |
| `pollBridgePairing` | `{configId, mode}` | mesmo shape | `phase:"poll"` do core: nunca pede código novo. A UI chama a cada 4 s por até 3 min (código) ou enquanto o modal está aberto (QR) |

`getBridgeQrCode` continua (Configurações usa); o PR 3 a reescreve como chamada a `startBridgePairing({mode:"qr"})` para manter uma porta só.

`provisionBridgeChannel`: `webhookUrl` vira opcional. Sem ele, o servidor monta `${process.env.CONVEX_SITE_URL}/webhooks/bridge` (helper puro `bridgeWebhookUrl(siteUrl)` em `convex/lib/bridgeGateway.ts`, testado). O front deixa de montar a URL.

UI: no celular (`matchMedia("(max-width: 640px)")` ou `pointer: coarse`) o padrão é "Conectar com código"; no computador, QR. Instruções com os rótulos do app em PT-BR ("Aparelhos conectados › Conectar um aparelho › Conectar com número de telefone"). Como a validade exata do código não foi medida, a UI mostra "o código vale por cerca de 2 minutos" e oferece "Gerar outro código" depois de 150 s.

### A.7 "Primeiros passos" v2 (Painel)

`getOnboardingChecklist` ganha itens derivados de dados; `totalCount` passa a ser calculado. Ordem:

| Item | Feito quando | Ação do item |
|---|---|---|
| Conte sobre seu negócio | `onboardingMeta.business.offer` preenchido | abre wizard no passo 1 |
| Monte seu funil | `steps.funnel.done` ou `wizardCompletedAt` (legado) | passo 2 |
| Conecte seu WhatsApp | algum `channelConfigs` WhatsApp com `bridgeSessionState === "connected"` ou Meta `status === "active"` | passo 3 |
| Ligue o Atendente IA | `getAiStatus.active && hasAttendant` | passo 4 |
| Aceite o uso da IA no WhatsApp não oficial | só aparece se há canal bridge e atendente sem `bridgeAiAck` | Configurações › IA, cartão do aceite |
| Teste seu atendente | `steps.test.done` | passo 5 |
| Ouça áudios e leia imagens | `autoTranscribeAudio` em algum canal ou `visionEnabled` | passo 6 |
| Convide sua equipe | > 1 membro humano | passo 7 |
| Primeira conversa respondida pela IA | existe `messages` com `metadata.aiDraft` ou autor IA (consulta por índice, `.first()`) | Inbox |

Os itens antigos "Webhook ou API" e "Campos personalizados" saem do checklist (não são para o público-alvo). O cartão continua dispensável; quando tudo estiver feito, celebra e some sozinho.

---

## B. "Configurar com IA" (modo conversa)

**Recomendação: reusar `CopilotPanel` numa variante embutida, com `purpose:"setup"` no endpoint de streaming.** Motivo: o runtime (`runCopilotTurn`), o RBAC, o teto de gasto, o two-phase e o cartão de confirmação já existem; um componente dedicado duplicaria tudo.

Contrato:

1. **Front**: `CopilotPanel` ganha props `variant?: "drawer" | "embedded"` e `purpose?: "setup"`. `useCopilotStream(organizationId, { purpose })` envia `purpose` no corpo do POST. No wizard, o painel abre como coluna lateral no desktop e como folha de baixo no celular.
2. **Endpoint** (`convex/copilotHttp.ts`): aceita `purpose?: "setup"` (qualquer outro valor é ignorado). Com `"setup"`, monta no servidor um `contextBlock` com `buildSetupContextBlock(status)` (puro, em `convex/lib/onboardingSetupContext.ts`) a partir de `internal.onboarding.internalGetSetupContext`: segmento, `business`, passos feitos/pulados, nome do atendente e modo, canal conectado (só "conectado / não conectado", nunca número completo), capacidades da plataforma. O cliente nunca envia texto de contexto.
3. **Thread própria**: a primeira mensagem com `purpose:"setup"` cria a thread com título "Configuração guiada"; o wizard guarda o `threadId` em `onboardingProgress.wizardData.setupThreadId` para retomar.
4. **Sem `toolFilter`**: o Copiloto completo continua disponível (criar board, campos, respostas rápidas, as tools novas da seção C). O `contextBlock` orienta: "entreviste em no máximo 5 perguntas, proponha uma mudança por vez, nunca peça para o usuário colar senhas, aceites só por checkbox".
5. **Pré-requisito**: IA ativa (passo 1 ou 4). Sem ela, o botão "Configurar conversando" mostra "Marque 'Quero que a IA me ajude' no passo 1".

Depois do wizard, o mesmo modo fica em Configurações › IA ("Ajustar conversando") e no Copiloto normal (as tools são as mesmas; o `purpose` só muda o contexto inicial).

---

## C. Ferramentas do Copiloto para configurar o Atendente IA

### C.1 Princípios

- **Arquivo**: `convex/lib/copilotConfigTools.ts` (executores + prévia), registrados em `COPILOT_READ_TOOLS`/`COPILOT_WRITE_TOOLS` de `convex/lib/agentTools.ts` com `audience: "copilot"`.
- **Permissão**: `{ category: "settings", level: "manage" }` para escrita; `{ category: "settings", level: "view" }` para leitura. Mesmo nível das portas (`updateAgentProfile`, `setFeatureToggles`, `updateChannelConfig`).
- **Escrita sempre two-phase**: fase 1 grava `pendingActions` com `preview` PT-BR "Antes → Depois"; fase 2 executa pela porta existente re-checando permissão e e-mail. `effect: "write"` no registry (não `"destructive"`, para não cair no ramo destrutivo genérico), mas o executor nunca escreve na fase 1.
- **Execução pelas portas**: um core extraído de cada mutation pública (`updateAgentProfileCore`, `setFeatureTogglesCore`, `patchChannelTranscriptionCore`) em `convex/lib/attendantConfigOps.ts`; a mutation pública e a confirmação chamam o mesmo core. `auditLogs.metadata.via = "copilot"` (ou `"telegram"`).
- **Nunca**: ligar/desligar `aiConfig.enabled`, gravar `lgpdAck`, `bridgeAiAck`, `autopilotEarlyAck`, `groupAutopilotAck`, `nonZdrAck`, mudar provider/modelo/teto de gasto, provisionar ou apagar canal. Quando o pedido exige um desses, a tool devolve `{status:"requer_acao_humana", instruction, url}` (padrão de `launchCampaign`).
- **Sem ids para o modelo**: o atendente é endereçado por `attendantName` opcional (string). Se a org tem 1 atendente, ele é o alvo; se tem vários e o nome não bate, a tool devolve `{error, attendants: [nomes]}`. Canais por **apelido** (`channelLabel`, o `displayName`) ou "todos". O `pendingActions.args` guarda os ids resolvidos no servidor (o modelo não os vê; `resultFields` não os inclui).
- **Telegram modo automático**: as tools de escrita de config **não** entram em `autoWriteTools` (allowlist) e o executor recusa explicitamente `scope.via === "telegram_auto"` com "Mudanças de configuração só com sua confirmação". No modo sugestão do Telegram e na web, a proposta vira botão de confirmação (o Telegram já renderiza `pendingActions`).
- **Conta com e-mail**: re-checada na confirmação (`requireAccountWithEmail(ctx, member.userId)`), porque a confirmação do Telegram não tem sessão JWT.

### C.2 Catálogo

| Tool | Efeito | Parâmetros visíveis ao modelo | Executa (fase 2) | `resultFields` |
|---|---|---|---|---|
| `getAttendantConfig` | read | `attendantName?` | — (lê `agentProfile` + `readAgentTexts`, aceites como booleanos, canais por apelido, `visionEnabled`, transcrição por canal) | `name, mode, language, persona, knowledge, handoffKeywords, schedule, followUps, channels, visionEnabled, transcription, bridgeAiAckDone, autopilotEligible, attendants` (persona/conhecimento truncados em 6 000 caracteres com aviso) |
| `getAttendantSetupGuide` | read | `segment?` | — (template do segmento + `business` da org + checklist) | `segment, businessSummary, personaSeed, faqSeed, handoffSeed, missingSteps` |
| `updateAttendantPersona` | write (2-phase) | `attendantName?, newName?, persona?` (≤ 20 000), `greeting?` (≤ 500), `language?` | `updateAgentProfileCore({ patch: { systemPrompt }})` + rename do `teamMembers.name` (mesmo core, campo `name` novo no core, auditado) | `status, preview` |
| `updateAttendantKnowledge` | write (2-phase) | `attendantName?, text` (≤ 20 000), `mode: "append" \| "replace"` | `updateAgentProfileCore({ patch: { knowledge }})` (append concatena com `\n\n` no servidor) | `status, preview` |
| `setAttendantMode` | write (2-phase) | `attendantName?, mode: "suggest" \| "autopilot"` | `updateAgentProfileCore({ patch: { mode }})`; para `autopilot`, só propõe se o gate de métricas passa (≥ 10 revisadas e ≥ 60%); se não passa, devolve `requer_acao_humana` com o link do modal "Ativar o autopilot antes do gate". A tool nunca envia `autopilotRiskAck` | `status, preview, instruction, url` |
| `setAttendantHours` | write (2-phase) | `attendantName?, always?: boolean, startHour?, endHour?, days?: string[]` (seg…dom) | `updateAgentProfileCore({ patch: { schedule }})` (fuso = fuso da org; `always:true` envia `schedule:null`) | `status, preview` |
| `setHandoffRules` | write (2-phase) | `attendantName?, keywords?: string[]` (≤ 30, cada ≤ 40), `mode: "append" \| "replace"` | `updateAgentProfileCore({ patch: { handoffKeywords }})` | `status, preview` |
| `setFollowUpSettings` | write (2-phase) | `attendantName?, mode?: "off" \| "draft" \| "send", maxChain?, quietStartHour?, quietEndHour?, dailyCap?` | `updateAgentProfileCore({ patch: { followUps }})` (merge com o atual no servidor; a validação de faixas do core vale) | `status, preview` |
| `setAiFeatures` | write (2-phase) | `vision?: boolean, transcription?: { channelLabel?: string, all?: boolean, enabled: boolean }` | `setFeatureTogglesCore({ visionEnabled })` e/ou `patchChannelTranscriptionCore` por canal. Visão só com `orgAiActive`; transcrição devolve aviso se `WHISPER_SERVICE_URL` ausente | `status, preview, warnings` |

Nome final no registry: `setAiFeatures` (e não `setFeatureToggles`, que é o nome da mutation pública e confundiria o grep de portas).

`generateAttendantProfileDraft` **não** vira tool: o modelo do Copiloto lê `getAttendantSetupGuide` e redige; a escrita passa por `updateAttendantPersona`/`updateAttendantKnowledge` com prévia. O gerador LLM (`generateAttendantDraft`) existe só como action pública da UI do wizard.

### C.3 Prévia "Antes → Depois"

Helper puro `buildConfigPreview(tool, before, after): string` em `convex/lib/copilotConfigPreview.ts`, testado. Formato (PT-BR, sem markdown pesado, cabe no Telegram):

```
Atendente "Sofia": horário de atendimento
Antes: sempre (24 h)
Depois: seg a sex, 8h às 18h (America/Sao_Paulo)
```

Para textos longos (persona, conhecimento): mostra contagem e as primeiras/últimas linhas alteradas por diff de linhas simples (`diffLines` puro, sem dependência nova), no máximo 12 linhas, mais "(+N linhas)". Para modo autopilot, a prévia inclui a frase fixa "A IA vai responder sozinha aos clientes, sem aprovação".

O frontend do Copiloto já mostra `preview` no cartão de confirmação; o PR 7 só troca o `whitespace` para `pre-wrap` e destaca "Antes"/"Depois".

### C.4 Confirmação

`confirmPendingActionCore` ganha um ramo no `default`, no mesmo padrão dos grupos e do atendimento:

```ts
if (isConfigPendingTool(pending.tool)) {
  const outcome = await executeConfigPendingAction(ctx, pending, member, via);
  if (!outcome.ok) throw new ConvexError(outcome.message);
  message = outcome.message;
  break;
}
```

`executeConfigPendingAction` re-checa: `assertAgentCan(ctx, member._id, "settings", "manage")`, `requireAccountWithEmail(ctx, member.userId)`, que o atendente ainda existe e é da org, e o **estado atual igual ao "antes" da prévia** (hash do campo guardado em `args.beforeHash`). Se mudou, recusa com "A configuração mudou desde a proposta; peça de novo ao Copiloto" (evita sobrescrever uma edição feita na tela nesse meio-tempo). Para `setAttendantMode → autopilot`, re-roda o gate de métricas.

### C.5 System prompt do Copiloto

Novo parágrafo em `buildSystemPrompt` (`convex/lib/copilotTurn.ts`), ao lado de "ONBOARDING" e "CAMPANHAS":

> ATENDENTE IA: você pode ler a configuração (getAttendantConfig, getAttendantSetupGuide) e PROPOR mudanças de persona, conhecimento, horário, repasse, follow-up e recursos (áudio/imagem). Toda mudança gera um cartão de confirmação; diga ao usuário para conferir "Antes/Depois". Você NUNCA liga a IA, nunca aceita termos (LGPD, risco do WhatsApp não oficial, autopilot antecipado) e nunca mexe em modelos ou custos: explique o que a pessoa precisa marcar e onde. Uma mudança por vez.

`copilotPrompt.test.ts` ganha asserções para essas frases.

### C.6 Gap de e-mail

**Decisão: acrescentar `requireAccountWithEmail`** em `aiSettings.updateAgentProfile`, `aiSettings.setFeatureToggles`, `aiSettings.createAttendantOneClick` e no caminho manual `channelConfigs.createChannelConfig`. Motivo: CLAUDE.md lista "AI toggles" e "channel provisioning" como portas críticas; contas anônimas foram purgadas em 03/10/2026, então o risco de quebrar cliente real é nulo. As ops internas (`internalSetBotGuard` etc.) ficam como estão (sem sessão).

---

## D. Contrato com Configurações › IA e › Canais

A reorganização visual de Configurações é outra seção do plano. Este plano fixa só o contrato: **o wizard e as Configurações usam os mesmos componentes**, extraídos de `AiSection.tsx` (3 309 linhas) e `ChannelsSection.tsx` (1 985 linhas).

| Componente (novo arquivo) | Extraído de | Usado em | Props principais |
|---|---|---|---|
| `src/components/ai/AttendantPersonaForm.tsx` | `AttendantConfig` seção Persona + Repasse | Passo 4; Configurações › IA | `organizationId, agentMemberId, draft?, onSaved` (salva via `updateAgentProfile`) |
| `src/components/ai/AttendantHoursPicker.tsx` | seção Horário | Passo 4; Configurações | `value, onChange` (presets + personalizado) |
| `src/components/ai/AttendantSimulator.tsx` | `SimulatorModal` | Passo 5 (inline); Configurações (modal) | `organizationId, agentMemberId, suggestions?: string[], variant: "inline" \| "modal"` |
| `src/components/ai/FeatureToggleCard.tsx` | `ProductRow` | Passo 6; Configurações | `title, description, costLabel, available, unavailableReason?, checked, onChange` |
| `src/components/channels/ChannelConnectCard.tsx` | `BridgeForm` + `QrModal` | Passo 3; Configurações › Canais | `organizationId, configId?, defaultMode: "code" \| "qr", onConnected` |
| `src/components/pipeline/FunnelEditor.tsx` | `WizardStep2Pipeline` | Passo 2; (futuro) Configurações › Funis | `value, onChange, onRestore` |

Regra: nenhum componente compartilhado chama mutation diferente da que as Configurações chamam hoje; o wizard é só uma sequência desses cartões.

---

## E. Templates por segmento

Arquivo: `convex/lib/onboardingTemplates.ts` (puro, sem imports de `_generated`), com teste `convex/lib/onboardingTemplates.test.ts`. O front importa daqui (`src/lib/onboardingTemplates.ts` passa a reexportar), como já acontece com `convex/lib/permissions.ts`.

```ts
export type SegmentKey = "imobiliaria" | "saas" | "servicos" | "saude" | "ecommerce" | "educacao" | "outro";
export interface SegmentTemplate {
  key: SegmentKey;
  label: string;            // "Imobiliária / corretor"
  icon: string;             // nome lucide-react
  funnel: { boardName: string; boardColor: string; stages: StageSeed[] };
  fields: FieldSeed[];      // ≤ 6
  personaId: string;        // id em AGENT_PERSONAS (lib/agentPersonas.ts)
  personaSeed: string;      // parágrafos-base da persona com {negocio}, {oferta}, {tom}
  faqSeed: { q: string; a: string }[];   // 4–6, respostas com "[preencha]" onde depende do negócio
  handoffKeywords: string[];
  simulatorPrompts: string[]; // 3 perguntas para o passo Teste
  advanceRules: string;
}
```

Chaves mantêm compatibilidade com `onboardingMeta.industry` existente (`imobiliaria`, `ecommerce`, `saas`, `servicos`, `educacao`, `saude`, `outro`); `financeiro` continua aceito (mapeia para `servicos`) mas sai da tela.

Conteúdo (o implementador escreve o texto completo; aqui o esqueleto):

| Segmento | Funil (etapas) | Campos | Persona (2–3 linhas) | FAQ seed | Repasse |
|---|---|---|---|---|---|
| **Imobiliária / corretor** | Novo contato → Qualificado → Visita agendada → Proposta → Documentação → Fechado (ganho) → Desistiu (perda) | Tipo de imóvel, Compra ou aluguel, Bairros de interesse, Orçamento, Prazo para mudar | Assistente do corretor; descobre se é compra ou aluguel, região, faixa de preço e prazo; oferece agendar visita e passa ao corretor quando o cliente quer visitar ou negociar valor | Documentos para alugar; financiamento; visitas; taxa de condomínio/IPTU | visita, proposta, negociar, financiamento aprovado, falar com corretor |
| **Startup / SaaS** | Lead → Conversa inicial → Demonstração → Teste grátis → Proposta → Cliente (ganho) → Perdido | Tamanho da empresa, Cargo, Ferramenta atual, Plano de interesse | SDR educado e objetivo; entende o problema, porte e urgência; agenda demonstração; nunca promete funcionalidade que não está no conhecimento | Preço e planos; período de teste; integração; segurança/LGPD | contrato, desconto, integração específica, cancelar, suporte técnico |
| **Serviços locais** | Pedido de orçamento → Visita/diagnóstico → Orçamento enviado → Agendado → Concluído (ganho) → Não fechou | Serviço desejado, Endereço/bairro, Urgência, Melhor horário | Atendente de recepção; coleta o serviço, local e urgência, passa faixa de preço do conhecimento e agenda | Área atendida; formas de pagamento; garantia; horário | orçamento fechado, reclamação, urgência, falar com o responsável |
| **Clínica / saúde** | Contato → Triagem → Consulta agendada → Compareceu → Em tratamento (ganho) → Não agendou | Especialidade, Convênio, Primeira consulta?, Preferência de horário | Recepcionista acolhedora; agenda consultas, informa convênios e preparo; **nunca dá orientação clínica** e encaminha sintomas a humano | Convênios aceitos; valores particulares; preparo de exames; endereço | dor, sintoma, emergência, resultado de exame, falar com o doutor |
| **Loja / e-commerce** | Interessado → Dúvida respondida → Carrinho/pedido → Pago (ganho) → Desistiu | Produto de interesse, Tamanho/variação, Cidade (frete) | Vendedor simpático; tira dúvida de produto, prazo e frete; manda link de compra; passa trocas e problemas de pedido a humano | Prazo de entrega; frete; trocas e devoluções; formas de pagamento | troca, devolução, pedido atrasado, defeito, reembolso |
| **Educação / cursos** | Interessado → Informações enviadas → Aula experimental → Matrícula (ganho) → Não matriculou | Curso de interesse, Modalidade (online/presencial), Turno, Para quem é | Consultor de matrículas; entende objetivo do aluno, recomenda o curso, informa datas e valores, convida para aula experimental | Datas de início; valores e parcelamento; certificado; modalidade | bolsa, desconto, matrícula, cancelar, falar com coordenação |
| **Outro** | Novo lead → Em conversa → Proposta → Ganho → Perdido | — | Atendente geral cordial; entende a necessidade, responde com o conhecimento e passa a humano quando não souber | Horário; contato; como comprar | falar com humano, reclamação |

Personas novas em `convex/lib/agentPersonas.ts`: `saas` e `educacao` (hoje caem em `geral`); `personaForIndustry` passa a ler o mapa do template.

---

## F. Gerador de persona (`generateAttendantDraft`)

- **Arquivo**: action pública em `convex/attendantDraft.ts`; lógica pura em `convex/lib/attendantDraft.ts` (`buildAttendantDraftPrompt(input)`, `parseAttendantDraft(raw)`).
- **Args**: `{ organizationId }` (lê `business` e segmento do servidor; o cliente não manda texto livre para o prompt além do que já salvou em `saveBusinessProfile`).
- **Gates**: RP(settings, manage) + e-mail (via `internalQuery` de setup), `orgAiActive`, `internalSpendGate` (bloqueia com a mensagem do teto), rotas `resolveCopilotRoutes(..., "attendant")`.
- **LLM**: `chatWithFallback(routes, { messages, responseFormat json quando a rota suportar })`, timeout 45 s, temperatura 0,4. Registra custo em `agentRuns` com `kind: "attendant_draft"` (literal novo e aditivo no validator) para entrar no uso do mês.
- **Saída**: `{ name, persona, greeting, knowledge, handoffKeywords: string[], warnings: string[] }`. `parseAttendantDraft` aceita JSON puro ou cercado por crases, corta tamanhos (persona ≤ 8 000, conhecimento ≤ 8 000, ≤ 20 palavras de repasse), e cai no template do segmento campo a campo quando falta algo (`warnings` diz o quê). Passa `llmOutputGuard` só para remover tool-call cru (o texto não vai ao cliente, mas vira prompt).
- **Não persiste nada**: a UI mostra no `AttendantPersonaForm`; salvar chama `updateAgentProfile`.
- **Boas-vindas**: não existe campo próprio; o `greeting` entra na persona como bloco "Primeira mensagem ao cliente: …". Sem mudança de schema.

---

## G. Plano de entrega (PRs)

Ordem: backend primeiro (PRs 1–7), depois frontend (PRs 8–10). Cada PR é independente o bastante para um subagente Sonnet numa sessão de nuvem sem Convex nem humano. Critério comum a todos os PRs (não repetido abaixo):

```bash
npx tsc -p convex && npx tsc -p tsconfig.app.json && npx tsc -p tsconfig.node.json
npx vitest run
npx vite build
```

E: entrada no `CHANGELOG.md` (PT-BR) quando o PR muda comportamento visível; nada de `npx convex dev`/`deploy`; schema só aditivo; sem `Co-Authored-By`.

`convex/_generated/api.d.ts` não pode ser regenerado sem deployment: os subagentes que criam arquivos novos em `convex/` devem editar `api.d.ts` à mão (import + entrada no `ApiFromModules`), como já foi feito em PRs anteriores; o critério de aceite inclui `tsc -p convex` verde.

### PR 1 — Templates por segmento (puro)

- **Objetivo**: fonte única de funis, campos, sementes de persona/FAQ/repasse e perguntas de teste por segmento.
- **Arquivos**: `convex/lib/onboardingTemplates.ts` (novo), `convex/lib/onboardingTemplates.test.ts` (novo), `convex/lib/agentPersonas.ts` (personas `saas`, `educacao`; `personaForIndustry` usa o template), `src/lib/onboardingTemplates.ts` (vira reexport + adaptador `INDUSTRY_TEMPLATES` para o wizard v1 continuar compilando).
- **Passos**: 1) escrever tipos e os 7 segmentos (tabela E); 2) helper `segmentTemplate(key)` com fallback `outro` e mapa legado (`financeiro → servicos`); 3) `renderPersonaSeed(template, business)` puro (substitui `{negocio}`, `{oferta}`, `{tom}`; remove placeholders não preenchidos); 4) adaptar `src/lib/onboardingTemplates.ts`.
- **Critérios de aceite**:
  - [ ] 7 segmentos; cada um com 4–8 estágios, exatamente 1 `isClosedWon` e 1 `isClosedLost`, cores `#RRGGBB`.
  - [ ] Todo `personaId` existe em `AGENT_PERSONAS`.
  - [ ] `grep -rn "INDUSTRY_TEMPLATES" src` continua resolvendo (wizard v1 intacto).
  - [ ] Nenhum texto com emoji (`/\p{Extended_Pictographic}/u`).
- **Testes** (`onboardingTemplates.test.ts`): `"todo segmento tem funil válido"`, `"chaves de campo são snake_case únicas"`, `"personaId existe"`, `"financeiro legado cai em servicos"`, `"renderPersonaSeed substitui e limpa placeholders"`, `"sem emoji nos textos"`, `"simulatorPrompts tem 3 itens"`.
- **Tamanho**: M (~450 linhas, quase tudo texto).
- **Riscos**: texto PT-BR fraco. Mitigação: o Eric revisa os textos na validação; o template é editável depois sem schema.

### PR 2 — Portas de configuração extraídas + e-mail + capacidades da plataforma

- **Objetivo**: cores reutilizáveis para as tools do Copiloto e fechamento da lacuna de e-mail.
- **Arquivos**: `convex/lib/attendantConfigOps.ts` (novo: `updateAgentProfileCore`, `setFeatureTogglesCore`, `patchChannelTranscriptionCore`), `convex/aiSettings.ts` (mutations viram wrappers finos + `requireAccountWithEmail` em `updateAgentProfile`, `setFeatureToggles`, `createAttendantOneClick`), `convex/channelConfigs.ts` (`createChannelConfig` + e-mail; `updateChannelConfig` delega o campo `autoTranscribeAudio` ao core), `convex/onboarding.ts` (query `getPlatformCapabilities`), `convex/attendantConfigOps.test.ts` (novo).
- **Passos**: 1) mover o corpo de `updateAgentProfile` para `updateAgentProfileCore(ctx, { agent, member, patch, autopilotRiskAck?, via?, rename? })` sem mudar comportamento; `via` vai para `auditLogs.metadata.via`; 2) idem `setFeatureToggles`; 3) `patchChannelTranscriptionCore(ctx, { config, member, enabled, via })` (patch + audit, igual ao caminho atual); 4) `getPlatformCapabilities({organizationId})` → `{ managedBridge, transcription, llm, metaMessaging }` booleanos, RA; `managedBridge` = URL + admin token + HMAC ≥ 32; `llm` = `OPENROUTER_API_KEY || OPENCODE_GO_API` ou BYO configurado; nunca devolve valores.
- **Critérios de aceite**:
  - [ ] Testes existentes de `aiSettings`/atendente passam sem alteração de asserção (comportamento igual).
  - [ ] `grep -n "requireAccountWithEmail" convex/aiSettings.ts` mostra as 3 mutations novas além das 4 antigas.
  - [ ] `getPlatformCapabilities` não contém `process.env.X` no retorno (só `!!`).
- **Testes** (`attendantConfigOps.test.ts`, convex-test): `"updateAgentProfile recusa conta sem e-mail"`, `"setFeatureToggles recusa conta sem e-mail"`, `"core grava via no audit"`, `"core preserva validação de follow-up"`, `"core rename muda teamMembers.name e audita"`, `"getPlatformCapabilities reflete envs sem vazar valores"` (com `vi.stubEnv`), `"agente sem settings:manage é recusado"`.
- **Tamanho**: M (~550).
- **Riscos**: fixtures de testes antigos criam usuário sem e-mail e passam a falhar. Mitigação: rodar `npx vitest run convex/` e ajustar fixtures (dar `email` ao usuário de teste), nunca afrouxar o guard; listar os arquivos tocados no PR.

### PR 3 — WhatsApp: código de pareamento na web + webhook no servidor

- **Objetivo**: conectar pelo celular sem QR e tirar a montagem do `webhookUrl` do cliente.
- **Arquivos**: `convex/channelConfigs.ts` (`startBridgePairing`, `pollBridgePairing`; `getBridgeQrCode` delega; `provisionBridgeChannel.webhookUrl` opcional), `convex/lib/bridgeGateway.ts` (`bridgeWebhookUrl`), `convex/lib/pairingQuota.ts` (novo, puro: `consumePairingAttempt(row, now)` → `{allowed, attemptsLeft, next}`), `convex/telegramReconnect.ts` (passa a usar `pairingQuota` para o mesmo teto), `convex/bridgePairing.test.ts` (novo).
- **Passos**: 1) helper puro de cota (3/h, janela que reinicia após 1 h) usado pelos dois caminhos; 2) `internalConsumePairingAttempt({configId, organizationId})` mutation sobre `telegramReconnects` (cria a linha se faltar; não mexe em `token`/campos do Telegram); 3) actions web com `normalizePhone` + `defaultCountryCode`; 4) `bridgeWebhookUrl(process.env.CONVEX_SITE_URL)`; erro claro se ausente e sem `webhookUrl` do cliente.
- **Critérios de aceite**:
  - [ ] `grep -n "pairphone\|mode: \"code\"" convex/channelConfigs.ts` mostra o caminho web.
  - [ ] Código e QR nunca aparecem em `console.log`, `auditLogs` nem no doc do canal (`grep` no diff).
  - [ ] 4ª tentativa de código na mesma hora devolve erro PT-BR com o horário de liberação; QR não consome cota.
- **Testes** (`bridgePairing.test.ts`, convex-test com `fetch` mockado como em `bridgeSession.test.ts`): `"código: normaliza número e chama pairphone"`, `"código: número curto devolve erro sem chamar gateway"`, `"código: quarta tentativa na hora é recusada"`, `"cota é compartilhada com o Telegram"`, `"poll nunca pede código novo"`, `"conectado grava bridgePhone e claim"`, `"membro sem settings:manage é recusado"`, `"provision sem webhookUrl usa CONVEX_SITE_URL"`; puro: `"consumePairingAttempt reinicia após 1 h"`.
- **Tamanho**: M (~500).
- **Riscos**: comportamento real do `pairphone` não totalmente medido (validade, segundo código invalida o primeiro). Mitigação: UI com "Gerar outro código" e fallback "Usar QR"; validação viva com o Eric (seção "O que exige o Eric").

### PR 4 — Backend do onboarding v2

- **Objetivo**: estado do wizard v2, funil re-executável, checklist novo.
- **Arquivos**: `convex/schema.ts` (campos aditivos de A.4), `convex/onboarding.ts` (`saveBusinessProfile`, `applyFunnelTemplate`, `markWizardStep`, `deferWizard`, `reopenWizard`, `getOnboardingStatus`, `internalGetSetupContext`; `computeShouldShowWizard` respeita `wizardDeferredAt`; `getOnboardingChecklist` v2; `completeWizard` grava `wizardVersion: 2`), `convex/lib/onboardingStatus.ts` (novo, puro: `deriveOnboardingStatus(snapshot)`), `convex/onboardingV2.test.ts` (novo).
- **Passos**: 1) validators aditivos; 2) `saveBusinessProfile` (RP settings:manage; trims e limites; grava `industry` = segmento; `steps.business`); 3) `applyFunnelTemplate` (regras A.5, usando o core de `createBoardWithStages` de `convex/boards.ts` — extrair `createBoardWithStagesCore` se ainda não existe — e `updateAgentProfileCore` para re-apontar o atendente); 4) `markWizardStep({step, status})` só para passos não deriváveis; 5) `getOnboardingStatus` (RA; inclui `accountHasEmail`, capacidades, status por passo, `nextStep`); 6) checklist v2 (A.7) com consultas por índice e `.first()`/`.take()`, nunca `.filter()` em query.
- **Critérios de aceite**:
  - [ ] Org criada antes do PR (sem campos novos) lê sem erro em todas as queries.
  - [ ] `applyFunnelTemplate` nunca apaga board com lead nem `leadSources` (teste).
  - [ ] Nenhum `Date.now()` dentro de query (`grep` no diff).
  - [ ] `getOnboardingChecklist` mantém os campos antigos que o front v1 lê até o PR 10.
- **Testes**: `"saveBusinessProfile exige settings:manage"`, `"saveBusinessProfile corta limites"`, `"applyFunnelTemplate substitui funil padrão vazio mantendo boardId"`, `"applyFunnelTemplate com leads cria funil novo"`, `"applyFunnelTemplate é idempotente"`, `"applyFunnelTemplate não toca leadSources nem outros boards"`, `"applyFunnelTemplate re-aponta estágio inicial do atendente"`, `"applyFunnelTemplate faz upsert de campos por key"`, `"deferWizard esconde o wizard"`, `"org legada com wizardCompletedAt não vê wizard"`, `"checklist: WhatsApp conectado marca o item"`, `"checklist: item de aceite bridge só aparece com canal bridge"`, `"getOnboardingStatus de membro agent não expõe business"` (agent não tem settings:view → recebe só `shouldShowWizard:false`); puro: `"deriveOnboardingStatus escolhe o próximo passo"`.
- **Tamanho**: L (~700).
- **Riscos**: tamanho. Mitigação: se passar de 700, separar checklist v2 num PR 4b.

### PR 5 — Gerador de persona por IA

- **Objetivo**: "Escrever com IA" no passo 4.
- **Arquivos**: `convex/lib/attendantDraft.ts` (novo, puro), `convex/attendantDraft.ts` (novo: action `generateAttendantDraft` + `internalGetDraftSetup`), `convex/agentRuns.ts`/`convex/schema.ts` (literal `attendant_draft` aditivo em `kind`), `convex/lib/attendantDraft.test.ts`, `convex/attendantDraft.test.ts`.
- **Passos**: seção F.
- **Critérios de aceite**:
  - [ ] Sem `orgAiActive` a action lança "Ative a IA primeiro".
  - [ ] Teto de gasto em `block` lança a mensagem padrão.
  - [ ] A action não escreve em `teamMembers` nem `agentProfileTexts` (`grep` de `ctx.runMutation` no arquivo: só `agentRuns`).
- **Testes**: puros — `"prompt inclui segmento, oferta e tom"`, `"prompt não inclui dados de contatos"`, `"parse aceita JSON cercado por crases"`, `"parse cai no template campo a campo e avisa"`, `"parse corta tamanhos"`, `"parse remove tool-call cru"`; convex-test — `"internalGetDraftSetup exige settings:manage e e-mail"`, `"setup recusa org sem IA ativa"`, `"setup recusa com teto em block"`.
- **Tamanho**: M (~450).
- **Riscos**: modelo devolve JSON inválido. Mitigação: fallback do template sempre produz um rascunho utilizável.

### PR 6 — Tools do Copiloto para o Atendente IA

- **Objetivo**: seção C completa no backend.
- **Arquivos**: `convex/lib/agentTools.ts` (9 specs), `convex/lib/copilotConfigTools.ts` (novo: `isConfigCopilotReadTool`, `isConfigCopilotWriteTool`, `isConfigPendingTool`, `runConfigCopilotReadTool`, `runConfigCopilotWriteTool`, `executeConfigPendingAction`), `convex/lib/copilotConfigPreview.ts` (novo, puro: `buildConfigPreview`, `diffLines`, `hashBefore`), `convex/copilot.ts` (dispatch no `default` dos executores de leitura e escrita), `convex/lib/copilotPendingActions.ts` (ramo `isConfigPendingTool`), `convex/lib/copilotTurn.ts` (parágrafo C.5), `convex/lib/telegramAssistant.ts` (comentário + teste de que nenhuma tool de config entra em `autoWriteTools`), `src/hooks/useCopilotStream.ts` (`TOOL_LABELS`: "lendo o atendente", "propondo ajuste no atendente"…), testes.
- **Passos**: 1) specs com `permission` e `resultFields`; 2) resolução de atendente por nome e canal por apelido; 3) leitura; 4) proposta com `beforeHash`; 5) execução pelos cores do PR 2; 6) recusa de `telegram_auto`; 7) prompt.
- **Critérios de aceite**:
  - [ ] `agentToolSecurity.test.ts` verde sem mudanças no teste (nenhum parâmetro injetado, nenhum campo-segredo).
  - [ ] `grep -n "lgpdAck\|bridgeAiAck\|autopilotEarlyAck\|enabled:" convex/lib/copilotConfigTools.ts` não acha escrita (só leitura booleana).
  - [ ] Nenhuma escrita direta na fase 1 (`grep "ctx.db.patch\|ctx.db.replace" convex/lib/copilotConfigTools.ts` só dentro de `executeConfigPendingAction` ou dos cores).
- **Testes** (`convex/copilotConfigTools.test.ts`, convex-test; padrão de `copilotWrite.test.ts`): `"getAttendantConfig não devolve ids"`, `"updateAttendantPersona cria pendingAction com Antes/Depois e não muda nada"`, `"confirmar aplica persona via core e audita via copilot"`, `"confirmar recusa se a config mudou desde a proposta"`, `"confirmar recusa membro que perdeu settings:manage"`, `"confirmar recusa conta sem e-mail"`, `"setAttendantMode autopilot sem gate devolve requer_acao_humana"`, `"setAttendantMode autopilot com gate cria proposta"`, `"setAiFeatures visão exige IA ativa"`, `"setAiFeatures transcrição por apelido de canal"`, `"vários atendentes sem nome devolve lista de nomes"`, `"telegram_auto é recusado"`, `"agent sem settings:manage não vê as tools de escrita"`; puro (`copilotConfigPreview.test.ts`): `"prévia de horário"`, `"prévia de texto longo corta em 12 linhas"`, `"prévia de autopilot traz a frase de risco"`, `"hashBefore estável"`; `copilotPrompt.test.ts`: `"prompt fala de ATENDENTE IA e proíbe aceites"`; `telegramAssistant` existente: `"autoWriteTools nunca inclui tools de config"`.
- **Tamanho**: L (~700). Se passar, separar leitura (6a) de escrita (6b).
- **Riscos**: conflito com o switch de `copilot.ts` (arquivo grande). Mitigação: só duas linhas de dispatch no `default`, como grupos e atendimento.

### PR 7 — Modo conversa ("Configurar com IA")

- **Objetivo**: seção B.
- **Arquivos**: `convex/copilotHttp.ts` (`purpose`), `convex/lib/onboardingSetupContext.ts` (novo, puro), `convex/onboarding.ts` (`internalGetSetupContext` se não entrou no PR 4), `src/hooks/useCopilotStream.ts` (`purpose`), `src/components/copilot/CopilotPanel.tsx` (`variant`, `purpose`, cartão de confirmação com `pre-wrap` e destaque Antes/Depois), `convex/copilotStream.test.ts` (casos novos), `convex/lib/onboardingSetupContext.test.ts`.
- **Critérios de aceite**:
  - [ ] Corpo com `purpose` desconhecido é tratado como sem `purpose`.
  - [ ] O `contextBlock` não contém telefone completo, e-mail nem id (teste).
  - [ ] `CopilotPanel` sem props novas renderiza igual (o `CopilotFab` não muda).
- **Testes**: `"purpose setup injeta contextBlock do servidor"`, `"purpose desconhecido é ignorado"`, `"contextBlock mascara telefone"`, `"contextBlock lista passos pendentes"`.
- **Tamanho**: M (~400).
- **Riscos**: `copilotStream.test.ts` depende de mocks de LLM. Mitigação: testar `buildSetupContextBlock` puro e só a passagem do `contextBlock` no endpoint.

### PR 8 — Componentes compartilhados (extração sem mudança visual)

- **Objetivo**: seção D; Configurações passa a usar os componentes novos.
- **Arquivos**: `src/components/ai/AttendantPersonaForm.tsx`, `AttendantHoursPicker.tsx`, `AttendantSimulator.tsx`, `FeatureToggleCard.tsx`, `src/components/channels/ChannelConnectCard.tsx` (com "Conectar com código" usando PR 3), `src/components/pipeline/FunnelEditor.tsx`; `AiSection.tsx` e `ChannelsSection.tsx` importam deles; `src/lib/pairingUi.ts` (+ `.test.ts`: escolha do modo padrão por viewport, formatação `XXXX-XXXX`, contagem regressiva).
- **Critérios de aceite**:
  - [ ] `AiSection.tsx` e `ChannelsSection.tsx` encolhem (linhas removidas ≥ linhas movidas).
  - [ ] Configurações › Canais ganha "Conectar com código" ao lado de "Mostrar QR".
  - [ ] Ícones só `lucide-react`; alvos de toque ≥ 44 px; copy PT-BR.
- **Testes**: `src/lib/pairingUi.test.ts` (`"celular usa código por padrão"`, `"formata código de 8 caracteres"`, `"oferece novo código após 150 s"`).
- **Tamanho**: L (~700; é movimentação).
- **Riscos**: conflito com a seção de reorganização de Configurações (outro autor). Mitigação: este PR entra antes; a reorganização consome os componentes.

### PR 9 — Wizard v2, passos 1 a 4

- **Objetivo**: Negócio, Funil, WhatsApp, Atendente IA.
- **Arquivos**: `src/components/onboarding/v2/OnboardingWizardV2.tsx` (shell: indicador, navegação, retomada, "Continuar depois", painel "Configurar conversando"), `StepBusiness.tsx`, `StepFunnel.tsx`, `StepWhatsapp.tsx`, `StepAttendant.tsx`, `src/lib/onboardingWizard.ts` (+ `.test.ts`: ordem dos passos, `canAdvance`, próximo passo a partir do status), `src/lib/routes.ts` (rota `/app/configuracao-inicial`), `src/App.tsx`/router.
- **Critérios de aceite**:
  - [ ] Passos usam só portas listadas em A.1.
  - [ ] Checkbox LGPD desmarcado: nenhum botão de IA aparece e nenhuma chamada a `setAiEnabled`.
  - [ ] Sem gateway gerenciado: passo 3 mostra o texto de A.3 e o "Pular".
  - [ ] Atendente criado em modo Sugerir; o passo nunca oferece autopilot.
  - [ ] Ao salvar o passo 4, `channelConfigIds` recebe o canal conectado no passo 3 (se houver) e `pipelineConfig` aponta o funil do passo 2.
- **Testes**: `src/lib/onboardingWizard.test.ts` (`"pula para o primeiro passo pendente"`, `"passo 4 exige aceite antes de gerar"`, `"sem capacidade de LLM esconde Escrever com IA"`).
- **Tamanho**: L (~700).
- **Riscos**: wizard v1 e v2 convivendo. Mitigação: o v2 fica atrás da rota até o PR 10 trocar o gating.

### PR 10 — Wizard v2, passos 5 a 8 + checklist no Painel + troca do gating

- **Objetivo**: Teste, Extras, Equipe, Pronto; v2 vira o padrão.
- **Arquivos**: `StepTest.tsx` (usa `AttendantSimulator` inline com `simulatorPrompts`), `StepExtras.tsx` (`FeatureToggleCard` ×2), `StepTeam.tsx` (reaproveita `WizardStep4TeamInvite` sem o convite de IA), `StepDone.tsx`; `src/components/onboarding/OnboardingChecklist.tsx` (itens v2, link "Continuar configuração"); `src/components/layout/AuthLayout.tsx` (renderiza v2; "Continuar depois" chama `deferWizard`); remoção dos componentes v1 (`OnboardingWizard.tsx`, `WizardStep1..5`, `WizardStep3SampleData.tsx`) e do adaptador do PR 1; docs (seção I).
- **Critérios de aceite**:
  - [ ] `grep -rn "WizardStep3SampleData\|setupPipelineFromWizard" src` vazio.
  - [ ] Recarregar a página depois de "Continuar depois" não reabre o wizard.
  - [ ] Checklist mostra os 9 itens de A.7 e some quando tudo está feito.
  - [ ] Docs e CHANGELOG atualizados.
- **Testes**: `"checklist v2 ordena itens e calcula total"` (puro em `src/lib/onboardingChecklist.ts`), `"deferWizard persiste"` (já no PR 4, reforçado).
- **Tamanho**: L (~650 com a remoção do v1 contando como linhas negativas).
- **Riscos**: admins de orgs novas no meio do v1 durante o deploy. Mitigação: `onboardingProgress.wizardCurrentStep` antigo é ignorado pelo v2 (começa do primeiro passo pendente pelo status derivado).

### Resumo dos PRs

| PR | Título | Camada | Tamanho | Depende de |
|---|---|---|---|---|
| 1 | Templates por segmento | backend puro | M | — |
| 2 | Portas extraídas + e-mail + capacidades | backend | M | — |
| 3 | Código de pareamento web + webhook no servidor | backend | M | — |
| 4 | Backend do onboarding v2 | backend | L | 1, 2 |
| 5 | Gerador de persona | backend | M | 1, 4 |
| 6 | Tools do Copiloto para o Atendente | backend | L | 2, 4 |
| 7 | Modo conversa | backend + hook | M | 4, 6 |
| 8 | Componentes compartilhados | frontend | L | 2, 3 |
| 9 | Wizard v2 passos 1–4 | frontend | L | 4, 5, 8 |
| 10 | Wizard v2 passos 5–8 + gating + checklist | frontend + docs | L | 7, 9 |

PRs 1, 2 e 3 podem rodar em paralelo.

---

## H. Decisões assumidas

1. A IA é ligada no passo 1 por checkbox humano explícito (aceite LGPD) quando o usuário quer ajuda da IA. Ligar a IA sem atendente não responde ninguém, então não há risco de mensagem a cliente nesse momento.
2. O atendente nasce sempre em modo Sugerir. Autopilot nunca é oferecido no wizard; continua no fluxo atual de Configurações (gate de métricas ou aceite de risco).
3. "Dados de exemplo" saem do wizard (misturam fictício com WhatsApp real e travam o funil re-executável).
4. A cota de código de pareamento (3/h por canal) é compartilhada entre web e Telegram na tabela `telegramReconnects`, sem tabela nova. QR continua sem cota.
5. Boas-vindas do atendente ficam dentro da persona; não há campo novo `greeting`.
6. `generateAttendantProfileDraft` não é tool do Copiloto; o Copiloto redige a partir de `getAttendantSetupGuide`.
7. As tools de escrita de config são `effect:"write"` com two-phase próprio, e não `"destructive"`, para não alterar o comportamento genérico de tools destrutivas.
8. `requireAccountWithEmail` passa a valer em `updateAgentProfile`, `setFeatureToggles`, `createAttendantOneClick` e `createChannelConfig`.
9. Confirmação de proposta de config recusa se o campo mudou desde a proposta (`beforeHash`).
10. O modo conversa reutiliza `CopilotPanel`; o contexto é sempre montado no servidor.
11. `setupPipelineFromWizard` fica no código como legado até um PR de limpeza futuro.
12. Templates moram em `convex/lib/` e o front importa de lá (mesmo padrão de `permissions.ts`).

## I. Atualizações de documentação exigidas

| Arquivo | O que acrescentar |
|---|---|
| `docs/architecture/ai-copilot.md` | Parágrafo "Copiloto configura o Atendente IA": 9 tools, two-phase com `beforeHash`, o que nunca faz (aceites, `enabled`, modelos, custos), exclusão do modo automático do Telegram, `purpose:"setup"` e contexto montado no servidor |
| `docs/architecture/ai-attendant.md` | `updateAgentProfileCore` como porta única de persona/conhecimento/horário/repasse/follow-up; gerador `generateAttendantDraft` (não persiste, `agentRuns.kind = attendant_draft`); e-mail obrigatório nas portas de config |
| `docs/architecture/whatsapp-bridge.md` | Código de pareamento na web (`startBridgePairing`/`pollBridgePairing`), cota compartilhada com o Telegram, `webhookUrl` montado no servidor via `CONVEX_SITE_URL` |
| `docs/architecture/frontend.md` (ou a área de onboarding no índice) | Wizard v2: passos, componentes compartilhados com Configurações, rota `/app/configuracao-inicial`, checklist v2 |
| `.claude/rules/ai-pipeline.md` | 3 bullets: tools de config são sempre two-phase e nunca entram em `autoWriteTools`; nenhuma tool grava aceite nem `aiConfig.enabled`; nova tool de config vai em `copilotConfigTools.ts` e é confirmada pelo ramo `isConfigPendingTool` |
| `.claude/rules/whatsapp-bridge.md` | 1 bullet: código de pareamento passa por `runBridgeReconnectStep` e pela cota única; nunca logar código/QR |
| `CHANGELOG.md` | Entradas PT-BR por versão: "Configuração guiada nova: conecte o WhatsApp e ligue o Atendente IA em minutos", "Conectar WhatsApp com código", "O Copiloto agora ajusta o Atendente IA (com sua confirmação)" |

## J. O que exige o Eric

- **Envs em PROD** (conferir com `npx convex env list --prod`, sem imprimir valores): `WA_BRIDGE_DEFAULT_URL`, `WA_BRIDGE_ADMIN_TOKEN`, `WA_BRIDGE_HMAC_SECRET` (≥ 32), `WHISPER_SERVICE_URL`, `WHISPER_SERVICE_TOKEN`, `OPENROUTER_API_KEY` e/ou `OPENCODE_GO_API`, `CONVEX_SITE_URL` (o PR 3 passa a depender dela para o webhook).
- **Validação viva do código de pareamento** num aparelho real: validade do código, se um segundo código invalida o primeiro, rótulos atuais do app, se `resolveBridgePhone` acha o número logo depois. Ajustar o texto "cerca de 2 minutos" com o número medido.
- **Revisão dos textos** dos 7 templates (persona, FAQ, etapas) e do texto do checkbox LGPD do passo 1 (jurídico).
- **Decisão de custo**: o Copiloto e o gerador de persona gastam a chave da plataforma durante o onboarding de contas gratuitas. Definir se orgs novas nascem com `spendCap` padrão (ex.: `warn` em R$ 20) — fora do escopo deste plano, mas afeta o risco.
- **E2E vivo** em DEV com conta nova: criar org → 8 passos → mensagem real chegando ao atendente em modo Sugerir → pedir ao Copiloto "mude o horário para seg a sex 9–18" e confirmar.
- **Deploy**: rodar `npm run deploy:prod` só com a suíte verde, depois do merge de cada PR de backend.

## K. Fora do escopo

- Reorganização visual de Configurações › IA (outra seção do plano; aqui só o contrato de componentes).
- Renomear a fila de repasse para "Requer atenção" (outra seção de copy).
- Wizard para API oficial da Meta, Instagram e Messenger (ficam como "Outras opções" com link para Configurações).
- Tools do Copiloto para provisionar/apagar canal, mudar modelo, provider, ZDR ou teto de gasto.
- Agenda externa, divulgação (`disclosureMode`) e regras BANT avançadas no wizard (continuam em Configurações › Avançadas; o Copiloto pode ler mas não altera nesta entrega).
- Histórico/versões de persona com "desfazer" (o audit já guarda antes/depois; uma tela de versões é trabalho futuro).
- Remoção de `setupPipelineFromWizard` e de `requestSampleData`.
- Rotas REST/MCP (`crm_*`) para configuração do atendente.
