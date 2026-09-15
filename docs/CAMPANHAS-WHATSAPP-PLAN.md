# Campanhas de WhatsApp (disparo em massa) — plano v1

Data: 2026-09-08. Base: main v0.54.0. Pesquisa externa em `docs/AI-WHATSAPP-LIMITS.md`
(jul/2026) + rodada nova de 08/09/2026 (Meta v26.0, limites por portfólio, cap por
usuário, Marketing Messages API, curvas de aquecimento do bridge) — resumo na seção 1.

## 0. O que o Eric pediu (tradução em requisitos)

| # | Requisito | Onde entra |
|---|---|---|
| R1 | Oficial (Meta Cloud API) e não-oficial (bridge) — em conjunto na mesma org, ou só um dos dois; quem usa escolhe por campanha | §3 (uma campanha = um canal; org pode ter os dois) |
| R2 | Disparar para números NOVOS (sem contato/lead/conversa) — "um local para disparar para leads" | §4 (público) + §5 (worker cria contato → lead → conversa) |
| R3 | Importar CSV/XLS de novos leads e a campanha entrar em contato | §4.2 |
| R4 | Limites anti-ban configuráveis, default = o seguro de hoje | §6 (motor de limites + tabelas) |
| R5 | Novidades da API oficial contempladas | §1 + §7 (templates, 131049/131050, tier por portfólio) |
| R6 | Pular o gate do autopilot com aviso de risco | **FEITO** (§10, F0) |
| R7 | Delay, campanha, segmentar, filtrar | §4.1 + §6 |
| R8 | Texto, imagem, áudio, vídeo, documento — o que cada API permitir | §5.3 |
| R9 | Preview ao vivo estilo WhatsApp | §8.2 |
| R10 | Fácil para humanos E agentes IA usarem | §8 (wizard) + §9 (tools do copiloto, REST, MCP, contexto do atendente) |
| R11 | Campanhas que cada lead participou ficam registradas; tudo logado/auditável, seguro | §3.2 (`campaignRecipients.by_lead`), §11 |

## 1. O que mudou na Meta e muda o desenho (verificado 08/09/2026)

- **Limite de envio é por PORTFÓLIO desde 07/10/2025**, compartilhado por todos os números: 250 → 2.000 → 10.000 → 100.000 → ilimitado (o degrau de 1.000 morreu). Sobe em ≤6h quando usa ≥50% do limite em 7 dias com qualidade alta. Campo: `whatsapp_business_manager_messaging_limit` (o `messaging_limit_tier` foi descontinuado). Consequência: a campanha lê o tier no início e o mostra na UI; o teto diário default = 80% do tier.
- **Cobrança por mensagem desde 01/07/2025**: marketing sempre cobra (~US$ 0,0625 no BR), utility dentro da janela é grátis. A campanha mostra custo estimado ANTES de lançar (nº de destinatários × preço da categoria do template).
- **Cap dinâmico por usuário** (erro **131049**): a Meta segura marketing para quem não lê. Regra: 1 retry depois de 24h, nunca antes (retry precoce bloqueia o usuário por 24h). Brasil está sujeito; EUA não recebe template de marketing.
- **Opt-out nativo** (erro **131050**): o destinatário pediu para parar. Vai para a lista de supressão da org, para sempre.
- **Sem checagem prévia de número** (`/contacts` foi removido): 131026 é "não tem WhatsApp" e cada tentativa errada custa qualidade. No bridge o wuzapi tem `/user/check` — a campanha checa antes de enviar (grátis).
- **Template pacing**: template novo/amarelo pode devolver `held_for_quality_assessment`; se virar RED, pausa (3h/6h/desabilita) e as retidas falham com **132015**. Circuit breaker: 132015 pausa a campanha.
- **Marketing Messages API** (ex-MM Lite, endpoint `/marketing_messages`): mesmo schema e preço da Cloud API, com otimização de entrega e TTL. **Fora da v1** — só otimiza, não muda regra; entra como flag na v2.
- **Mídia outbound Meta**: imagem jpeg/png 5 MB, vídeo mp4/3gp 16 MB, áudio 16 MB (ogg só OPUS), documento 100 MB. Header de template aceita imagem/vídeo/documento; recomendação oficial é subir e usar `media id` (v1 usa `link`, como o dispatch atual; v2 troca para media id).
- **Bridge (não-oficial)**: nada é publicado. Consenso conservador: 20/dia nos 2 primeiros dias, 200/dia no teto mesmo aquecido, 30–120s entre envios, pausa de 15–30 min a cada 30, ≤30/hora, janela 09–20h, sem link no 1º contato, variar texto, pular número inexistente. Kill switches: taxa de resposta <10% após 50 envios; duplo-tique <60% após 20. Botões interativos NÃO funcionam no bridge em 2026.

## 2. Decisões de produto (recomendação — confirmar)

| # | Decisão | Alternativa descartada |
|---|---|---|
| D1 | **Uma campanha = um canal** (`channelConfigId`). A org pode ter Meta e bridge e escolhe por campanha. | "Split" automático entre canais — esconde de quem opera qual número está queimando. v2 pode ter "canal secundário para falha 131026". |
| D2 | **Meta = template obrigatório** (destinatário novo está sempre fora da janela). Texto livre só para quem tem janela aberta — a campanha oferece "só quem tem janela aberta" como filtro. | Tentar texto livre e ver 131047 — queima qualidade. |
| D3 | **Lista de supressão org-wide** (`optOuts`): palavra-chave inbound (SAIR/PARAR/STOP/CANCELAR, configurável), erro 131050, botão manual no contato. Campanha NUNCA envia para quem está nela. | Opt-out por campanha — o Termos de Uso (§3) proíbe contato com quem não consentiu; tem que ser global. |
| D4 | **Aceites obrigatórios por campanha**: (a) "tenho consentimento/base legal para contatar esta lista" (LGPD + Termos §3); (b) no bridge, o `bridgeAiAck`-like para disparo: "sei que é API não-oficial e pode banir o número". Sem os dois, o botão Lançar não existe. Gravado com quem/quando + auditLog `high`. | — |
| D5 | **Modo seguro por default**; subir acima dos tetos seguros exige digitar "ENTENDO" no campo + auditLog. Nunca acima do teto DURO (bridge 200/dia, Meta 100% do tier). | Sem teto duro — é a ferramenta levando a culpa pelo ban. |
| D6 | **Números novos viram contato + lead + conversa** no board/estágio que a campanha escolhe (default: board default, 1º estágio), com `sourceId` = fonte "Campanha" (criada na 1ª campanha) e tag `campanha:<slug>`. A resposta chega pelo ingest normal → inbox → atendente IA (se o canal tiver atendente) → tudo já existe. | Tabela separada de "prospects" fora do CRM — quebra R2 ("entrar em contato" é o pipeline). |
| D7 | **Variação de texto obrigatória no bridge**: ≥2 variantes (ou spintax `{a|b|c}`) quando >30 destinatários. Personalização `{{nome}}`, `{{campo}}` em ambos. | — |
| D8 | **Categoria RBAC nova `campaigns`**: `none < view < manage < full` (full = lançar/cancelar/excluir). Defaults: admin full, manager manage, agent view, ai view. O copiloto RASCUNHA (manage via pendingActions para lançar); lançar é sempre humano. | Reusar `inbox:full` — mistura quem responde com quem dispara em massa. |
| D9 | **Worker = scheduler do Convex** (um job por campanha, auto-reagendado; item a item), reaproveitando `scheduleWhatsappDispatch` (pacing por canal já existe) e os webhooks de status existentes. Sem infra nova. | Cron global — pior para pausar/cancelar por campanha. |
| D10 | **Snapshot do público no lançamento** (recipients materializados, dedupe por telefone, supressão aplicada). Editar filtro depois não muda a campanha em curso. | Público "vivo" — relatório não bate com o que foi enviado. |
| D11 | **XLSX no cliente** (SheetJS lazy-chunk → CSV) — o servidor só recebe CSV via `lib/csv.ts`. | Parser XLSX no Convex (sem Node no runtime padrão). |
| D12 | **Templates Meta sincronizados sob demanda** (`whatsappTemplates` cache + botão "Atualizar"), status/qualidade/categoria/idioma/componentes. Criar template na Meta fica FORA da v1 (link para o WhatsApp Manager). | Editor de template — a aprovação é assíncrona e a UX é da Meta. |

## 3. Modelo de dados

### 3.1 `campaigns`
```
organizationId, name, description?
status: draft | scheduled | running | paused | completed | canceled | failed
channelConfigId, provider: meta | bridge   (denormalizado no lançamento)
content: {
  kind: "text" | "template"
  variants: [{ text, attachmentFileIds?: files[], contentType }]   // texto/mídia (bridge ou Meta-em-janela)
  template?: { name, language, category, headerFileId?, bodyParams: [{ source: "field"|"const", value }], buttonParams? }
}
audience: {
  source: "segment" | "import" | "manual"
  filters?: { boardId?, stageIds?, tags?, assignedTo?, temperature?, priority?, lastActivityBefore?, lastActivityAfter?, onlyOpenWindow?, excludeCampaignedWithinDays? }
  importFileId?, manualCount?
  targetBoardId?, targetStageId?          // onde criar leads de números novos (D6)
  snapshotAt?, total?
}
schedule: { startAt?: number, timezone, windowStart: 9, windowEnd: 20, days: [1..5] }
pacing: { minDelaySec, maxDelaySec, batchSize, batchPauseMin, maxPerHour, maxPerDay, respectWarmup: bool, safeMode: bool, overrideAck?: {acceptedAt, acceptedBy} }
safety: { consentAck: {acceptedAt, acceptedBy}, bridgeRiskAck?: {...}, stopOnReplyRateBelow?: 0.10, stopOnDeliveryRateBelow?: 0.60, checkNumbersFirst: bool }
stats: { total, pending, sent, delivered, read, replied, failed, skipped, optedOut, cost? }
pausedReason?: string, pausedBy?: teamMembers, lastError?
tierAtLaunch?: string, templateQualityAtLaunch?: string
createdBy, startedAt?, completedAt?, createdAt, updatedAt
schedulerFnId?: string
índices: by_organization, by_organization_and_status, by_channel_config
```

### 3.2 `campaignRecipients`
```
campaignId, organizationId
phone (normalizado E.164 sem "+", via normalizePhone), displayName?
vars: Record<string,string>            // colunas do CSV / campos do lead p/ {{placeholders}}
contactId?, leadId?, conversationId?, messageId?
status: pending | queued | sent | delivered | read | replied | failed | skipped | opted_out
variantIndex?, attempts, scheduledFor?, errorCode?, lastError?
sentAt?, deliveredAt?, readAt?, repliedAt?
createdAt
índices: by_campaign_and_status, by_campaign_and_phone, by_message, by_conversation, by_lead, by_organization_and_phone
```
`by_lead` responde "de quais campanhas este lead participou" (R11) e alimenta a aba no `LeadDetailPanel` e o contexto do atendente.

### 3.3 `optOuts` (supressão org-wide, D3)
```
organizationId, phone, source: keyword | meta_131050 | manual | import
campaignId?, contactId?, reason?, createdBy?, createdAt
índice: by_organization_and_phone
```

### 3.4 `whatsappTemplates` (cache da Meta, D12)
```
organizationId, channelConfigId, metaId, name, language, category, status, qualityScore?, components: any, syncedAt
índices: by_channel_config, by_channel_config_and_name
```

### 3.5 Alterações em tabelas existentes
- `messages.metadata.campaign = { campaignId, recipientId }` (ligação; o inbox mostra chip "Campanha X").
- `channelPacing`: + `hourly: {hour, sent}`, `campaignDaily: {day, sent}` (o `dailyCount` atual conta tudo; campanha precisa do próprio).
- `channelConfigs`: + `bridgeConnectedAt?` (idade do número para warm-up; hoje só há `createdAt`).
- `organizations.settings.campaignDefaults?` (tetos default da org; ausente = tabela §6) + `optOutKeywords?`.
- `permissionsValidator`: + `campaigns`.
- `notifications.type`: + `campaign_completed`, `campaign_paused`.
- `leadSources`: fonte "Campanha" (criada sob demanda).
- `activities.type`: reaproveita `message`/`note`; entrada "Mensagem da campanha X enviada/entregue/respondida".

## 4. Público

### 4.1 Segmento (leads/contatos já no CRM)
Filtros server-side (`campaigns.previewAudience`, mesmo shape do `savedViews` de leads + extras): board, estágios, tags, responsável, temperatura, prioridade, última atividade antes/depois, "tem telefone", "só janela aberta (24h)", "não recebeu campanha nos últimos N dias", "excluir quem respondeu campanha anterior". Contador ao vivo + amostra de 10. No lançamento, snapshot → recipients (dedupe por telefone; `optOuts` fora; sem telefone → `skipped: no_phone`).

### 4.2 Importação (CSV / XLSX) — R3
Reaproveita `lib/csv.ts` (RFC 4180, `;`/`,`) e o mapeamento de `lib/importMapping.ts` (aliases PT-BR, `normalizePhone`). Colunas: telefone (obrigatório), nome, e-mail, empresa, tags, e **qualquer outra coluna vira `vars`** (`{{cidade}}` no texto). XLSX convertido no navegador (D11). Dry-run mostra: válidos, inválidos (telefone), duplicados, já em supressão, já existem como contato (vão ser reaproveitados, não duplicados). Números novos: contato+lead criados **no momento do envio** (não na importação — importar não é contatar; se a campanha for cancelada, nada foi criado).

### 4.3 Manual
Colar números (um por linha, com nome opcional "5511999990000, Maria").

## 5. Worker (motor de envio)

`internal.campaigns.tick({ campaignId })` — internalMutation auto-reagendada:
1. Carrega campanha; se não `running`, sai. Checa **janela** (fuso, dias, horas) → se fora, reagenda para a próxima abertura.
2. Checa **tetos** (§6) no `channelPacing` do canal: hora, dia, lote (pausa de lote). Se estourou, reagenda para quando abrir.
3. Checa **kill switches** (§6.3) → pausa com `pausedReason` + notificação + webhook.
4. Pega o próximo recipient `pending` (índice `by_campaign_and_status`, take 1). Se não há → `completed`.
5. Supressão (`optOuts`) → `opted_out`. Bridge com `checkNumbersFirst` → agenda `internal.campaigns.checkNumber` (action, wuzapi `/user/check`); sem WhatsApp → `skipped`.
6. Resolve/cria **contato** (`findOrCreateContactByPhone`), **lead** (`ensureLeadForContact` com `targetBoardId/StageId`), **conversa** (`getOrCreateConversation` + `channelConfigId` do canal da campanha) — mesmos helpers do ingest.
7. Renderiza a variante (round-robin/aleatório; spintax; `{{vars}}`; sem link no 1º contato se bridge e política ativa → bloqueado no wizard, não aqui).
8. Insere `messages` (`senderId` = criador da campanha, `metadata.campaign`, `metadata.scheduled: true` → ganha typing humanizado no bridge) e chama `scheduleWhatsappDispatch` → pacing por canal/conversa já existente → `internalDispatchMessage` (Meta/bridge, com o payload de template já suportado em `metadata.template`).
9. Marca recipient `queued` (+ `messageId`), incrementa contadores, e reagenda o tick para `now + delay(min,max) [+ pausa de lote]`.

**Ganchos de status** (sem polling):
- `internalMarkDispatched` / `internalMarkDispatchFailed` / webhook de status (`sent/delivered/read/failed`) → `campaignRecipients.by_message` → atualiza status + `stats`. Mapa de erros: 131026/131047 → `failed` (sem retry); 131049 → `pending` com `scheduledFor = +24h`, 1 retry; 131050 → `opted_out` + insere `optOuts`; 130429/131056/80007 → já retenta no dispatch; 131048 → congela canal (já) + **pausa a campanha**; 132015 → pausa a campanha ("template pausado pela Meta").
- Ingest inbound (`internalReceiveMessage`): se a conversa tem recipient `sent/delivered/read` nos últimos 7 dias → `replied` (+ `stats.replied`, atividade no lead). Se o texto casa palavra-chave de opt-out → `optOuts` + auto-resposta opcional "Você não receberá mais mensagens" + `opted_out`.
- Bridge `ReadReceipt`/`banned` → idem; sessão `banned`/`disconnected` → pausa campanha.

Pausar = `status: paused` + cancelar o scheduler; retomar = novo tick. Cancelar = pendentes viram `skipped: canceled`. Mensagens já enfileiradas no dispatch seguem (são ≤1).

### 5.3 Mídia por transporte
| Tipo | Meta (template) | Meta (janela aberta) | Bridge |
|---|---|---|---|
| Texto | body do template | ✔ | ✔ (+ spintax/variantes) |
| Imagem | header IMAGE | ✔ + legenda | ✔ + legenda |
| Vídeo | header VIDEO | ✔ | ✔ (`bridgeSendKindForMime` já suporta) |
| Áudio/voz | ✖ (template não tem header de áudio) | ✔ (ogg/opus) | ✔ (PTT; transcodifica como hoje) |
| Documento | header DOCUMENT | ✔ | ✔ |
| Botões | template (quick reply / URL) | ✖ v1 | ✖ (não renderiza no whatsmeow) |
O upload de vídeo hoje está fora da allowlist humana (`FileUploadButton`/`fileValidation`) — entra `video/mp4` com teto 16 MB.

## 6. Motor de limites (`convex/lib/campaignPacing.ts`, puro e testável)

### 6.1 Defaults seguros (D5) — Cloud API
| Parâmetro | Default | Teto duro |
|---|---|---|
| Destinatários/dia | 80% do tier (250 → 200) | 100% do tier |
| Delay entre envios | 1–3 s (pacing do canal já faz) | — |
| Lote / pausa | 200 / 30 min (tier 250); 1.000 / 5 min (≥10k) | — |
| Janela | 09–20h, seg–sex, fuso da org | 24h se override |
| Retry 131049 | 1×, após 24h | — |
| Parar em | 132015, template RED/PAUSED, 131048 | — |

### 6.2 Defaults seguros — bridge (idade = `bridgeConnectedAt ?? createdAt`)
| Dia desde a conexão | Msgs/dia | Novos contatos/dia | Delay | Máx/hora |
|---|---|---|---|---|
| 1–2 | 20 | 5 | 45–120 s | 10 |
| 3–4 | 40 | 10 | 40–110 s | 15 |
| 5–7 | 80 | 20 | 35–100 s | 20 |
| 8–14 | 120 | 30 | 30–90 s | 30 |
| 15+ | 150 | 50 | 30–90 s | 30 |
| **Teto duro** | **200** | 80 | ≥ 15 s | 40 |
+ pausa de 20 min a cada 30 envios; janela 09–20h seg–sex; `checkNumbersFirst` ligado; variantes obrigatórias (D7); número com < 3 dias: aviso vermelho + aceite explícito `newNumberRiskAck` no lançamento (revisto em 15/09/2026 — era bloqueio; somos ferramenta, avisamos mas não travamos); 3–7 dias: aviso.
Todos os números do §6 são **constantes documentadas como estimativa calibrável**, não limite oficial (regra já usada em `whatsappDispatch.ts`).

### 6.3 Kill switches (pausam com motivo, notificam `campaign_paused`)
- Taxa de resposta < 10% após 50 enviados (bridge) — configurável/desligável com ack.
- Entregues (duplo-tique) < 60% após 20 enviados.
- Falhas consecutivas ≥ 5.
- Canal: 131048, sessão bridge `banned`/`disconnected`, template 132015/RED.
- UI mostra **taxa de opt-out e de bloqueio** com o mesmo peso de "entregues" (é o indicador que antecede o ban).

## 7. Templates Meta (D12)
- `channelConfigs.syncMetaTemplates` (action): `GET /{wabaId}/message_templates?fields=id,name,status,category,language,quality_score,components` → upsert em `whatsappTemplates`.
- Wizard lista só `APPROVED`; mostra categoria (custo), qualidade, idioma; mapeia `{{1}}..{{n}}` do body para campo do lead/coluna do CSV/constante; header de mídia → upload (`link`, v2 media id); botões URL dinâmicos.
- `tierAtLaunch` lido de `GET /{phoneNumberId}?fields=whatsapp_business_manager_messaging_limit`.
- Custo estimado: destinatários × preço da categoria (tabela em `lib/whatsappPricing.ts`, BR; editável por env).

## 8. UI (`/app/campanhas`, item de menu + `Tab` "campaigns")

### 8.1 Lista
Cards/tabela: nome, canal (pill Meta/bridge), status, barra de progresso, enviadas/entregues/lidas/respondidas/falhas/opt-out, custo, criador, datas. Ações: Pausar/Retomar/Cancelar/Duplicar/Excluir (rascunho). Filtros por status e canal. Deep-link `?campanha=<id>`.

### 8.2 Wizard (5 passos, salva rascunho a cada passo)
1. **Canal e nome** — escolhe o número (Meta ou bridge) com saúde/tier/idade e o aviso do bridge.
2. **Público** — Segmento (filtros + contador ao vivo) | Importar CSV/XLSX (`FileDropZone` + mapeamento + dry-run) | Manual. Board/estágio destino para números novos.
3. **Mensagem** — bridge/Meta-janela: editor com variantes + spintax + `{{vars}}` + anexos (imagem/vídeo/áudio/doc) + gravação de voz; Meta: seletor de template + mapeamento de variáveis + header. À direita, **`WhatsAppPreview`**: moldura de celular, papel de parede, bolha verde com formatação do WhatsApp (`*negrito*`, `_itálico_`, `~riscado~`, `` ```mono``` ``), mídia renderizada (usa `MessageAttachments`/`AudioPlayer` já existentes), botões do template, hora e ✓✓; alterna entre variantes e entre 3 destinatários de amostra (variáveis substituídas de verdade). Contador de caracteres e aviso "link no 1º contato" (bridge).
4. **Limites e agenda** — modo seguro (tabela §6 resolvida para ESTE número: "seu número tem 4 dias → 40/dia") com sliders travados nos tetos; "Avançado" destrava até o teto duro mediante "ENTENDO"; janela/dias/fuso; início agora ou agendado; kill switches.
5. **Revisão e aceites** — resumo, custo estimado, duração estimada, aceite de consentimento (D4a), aceite de risco do bridge (D4b), botão **Lançar** (gate `campaigns:full`).

### 8.3 Detalhe/relatório
Tiles (enviadas, entregues %, lidas %, respondidas %, falhas, opt-out, bloqueios, custo), barra por status, timeline de eventos (lançada, pausada por X, retomada…), tabela de destinatários com filtro por status + busca + erro por linha + link para a conversa, exportar CSV do resultado. Botão "Reenviar falhas elegíveis" (só 131049 vencidos e falhas de rede).

### 8.4 Onde mais aparece
- `LeadDetailPanel` → aba/seção "Campanhas" (lista com status e data; clique abre a campanha).
- Inbox: chip "Campanha X" na bolha da mensagem de campanha; conversa nova iniciada por campanha ganha label automática `campanha`.
- Contato: botão "Não contatar (opt-out)" + badge quando em supressão.
- Sidebar: item "Campanhas" (ícone `Megaphone`), badge = campanhas pausadas por kill switch.

## 9. Agentes IA, REST, MCP, webhooks

- **Copiloto** (`agentTools.ts`, audience copilot): `listCampaigns`, `getCampaignReport`, `previewCampaignAudience`, `createCampaignDraft` (write, gate `campaigns:manage`), `pauseCampaign`/`resumeCampaign` e `launchCampaign` via `pendingActions` (two-phase — lançar é humano). Denylist: nada de alterar tetos acima do seguro via tool.
- **Atendente**: contexto injetado "Este lead recebeu a campanha «X» em DD/MM com o texto: …" quando o recipient é ≤7 dias — a IA sabe por que a pessoa está respondendo (hoje ela veria uma mensagem outbound solta). Palavra-chave de opt-out é tratada ANTES da IA (o ingest marca e responde).
- **REST** (`/api/v1/campaigns`, `ROUTE_PERMISSIONS` fail-closed + `routerPermissions.test.ts`): `GET/POST /campaigns`, `GET/PATCH/DELETE /campaigns/:id`, `POST /campaigns/:id/recipients` (segment|manual|csv inline ≤5 MB|fileId), `GET /campaigns/:id/recipients`, `POST /campaigns/:id/launch|pause|resume|cancel`, `GET /campaigns/:id/report`, `GET/POST/DELETE /opt-outs`, `GET /whatsapp/templates`.
- **MCP** (`mcp-server/src/tools`): `crm_list_campaigns`, `crm_get_campaign`, `crm_create_campaign`, `crm_add_campaign_recipients`, `crm_launch_campaign`, `crm_pause_campaign`, `crm_campaign_report`, `crm_list_opt_outs`.
- **Webhooks**: `campaign.created|started|paused|resumed|completed|canceled`, `campaign.recipient_replied`, `contact.opted_out`.
- **Notificações in-app**: `campaign_completed`, `campaign_paused` (kill switch) para o criador + admins.

## 10. Fases e entregáveis

| Fase | Conteúdo | Arquivos principais | Testes |
|---|---|---|---|
| **F0 ✔** | Autopilot antecipado: `updateAgentProfile({ autopilotRiskAck })`, `agentProfile.autopilotEarlyAck`, audit `high`, modal "Já conheço — ativar agora" | `aiSettings.ts`, `schema.ts`, `AiSection.tsx` | `attendantCoach.test.ts` (3 novos) |
| **F1** | Schema §3, RBAC `campaigns`, `lib/campaignPacing.ts` (puro), `lib/campaignRender.ts` (spintax/vars), `campaigns.ts` (CRUD, público segment/manual, snapshot, launch/pause/resume/cancel), worker `tick`, ganchos de status/inbound/opt-out, `optOuts.ts`, notificações, audit, webhooks | `convex/campaigns.ts`, `convex/campaignWorker.ts`, `convex/optOuts.ts`, `convex/lib/campaign*.ts`, `schema.ts`, `permissions.ts`, `whatsapp.ts` (ganchos), `conversations.ts` (ingest) | `campaignPacing.test.ts`, `campaignRender.test.ts`, `campaigns.test.ts` (worker com fake timers, kill switches, opt-out, 131049/131050) |
| **F2** | Meta: sync de templates, campanha de template com variáveis/header, tier/custo | `channelConfigs.ts`, `whatsappTemplates`, `lib/whatsappPricing.ts` | `campaignTemplates.test.ts` |
| **F3** | Import CSV (server) + XLSX (cliente), UI completa §8 (lista, wizard, preview, relatório, aba no lead, chips no inbox, opt-out no contato, sidebar/rota/permissões na UI da equipe) | `src/components/campaigns/*`, `CampaignsPage.tsx`, `WhatsAppPreview.tsx`, `main.tsx`, `Sidebar.tsx`, `BottomTabBar.tsx`, `routes.ts`, `LeadDetailPanel.tsx`, `TeamPage` (editor de permissões) | `campaignImport.test.ts`, `src/lib/whatsappFormat.test.ts` |
| **F4** | Copiloto tools + pendingActions, contexto do atendente, REST, MCP, `llmsTxt`, `apiRegistry` (playground), landing/dashboard/CLAUDE.md/Termos (cláusula de disparo com consentimento) | `agentTools.ts`, `copilot.ts`, `attendant.ts`, `router.ts`, `mcp-server/src/tools/campaigns.ts` | `routerPermissions.test.ts`, `agentToolSecurity.test.ts`, `campaignsApi.test.ts` |
| **F5** | E2E vivo na Acme Corp Test (bridge real) com 3 números do Eric; ajuste fino dos defaults com o `dailyCount` real; v2 backlog: Marketing Messages API, media id, split de canal, A/B, agendamento no fuso do lead | — | relatório em `docs/CAMPANHAS-E2E-REPORT.md` |

Ordem de execução com subagentes: F1 (backend, 1 agente Fable) ∥ F3-preview (`WhatsAppPreview` + formatação, 1 agente frontend) → F2 ∥ F3-wizard → F4 → review (code-review + security-review) → F5.

## 11. Segurança e conformidade
- Multi-tenant: toda query por `organizationId`; recipients/optOuts/templates validados contra a org da campanha; `channelConfigId` tem que ser da org.
- RBAC fail-closed em app, REST, MCP e tools de IA (`assertAgentCan`). Lançar/cancelar = `campaigns:full`; tetos acima do seguro = `campaigns:full` + "ENTENDO".
- Audit: create/update (medium), launch/cancel/override de teto/aceites (high), pause por kill switch (high, actorType `system`), opt-out manual (medium). Snapshot dos limites e aceites em `changes.after`.
- Segredos: token do bridge/Meta nunca sai do servidor (mesmo padrão); `exportSanitize` ganha as novas tabelas (backup JSON) sem segredos.
- LGPD: aceite de base legal por campanha (D4a); lista de supressão respeitada por TODOS os envios de campanha; `optOuts` entra no export; cláusula nova nos Termos ("disparos exigem consentimento; o HNBCRM aplica supressão").
- Anti-abuso da plataforma: teto duro não configurável (D5); número bridge com < 3 dias exige aceite explícito do risco (aviso, não trava — revisto em 15/09/2026); `secretScan`/`exportSecurity` cobrem os arquivos novos.

## 11.1 Lacunas do código atual que a v1 fecha (achados do mapeamento)
- **Telefone**: `normalizePhone` só tira não-dígitos — sem código de país, sem 9º dígito BR, sem validação. Entra `lib/phone.ts` (E.164 sem "+", default país da org = 55, regra do 9º dígito para celular BR, rejeita fixo quando `mobileOnly`), usado por import, manual e dedupe.
- **Eventos de campanha sem lead** (lançada/pausada/concluída): `activities.leadId` é obrigatório → esses eventos vão para `auditLogs` + timeline própria da campanha (`campaignEvents` embutido em `campaigns.timeline[]`, cap 100); só o envio por destinatário vira activity do lead.
- **Webhooks sem registry**: evento novo exige atualizar `llmsTxt.ts` e `DevelopersPage.tsx` (duas listas manuais) — entra na F4.
- **Notificação nova** toca 4 pontos: `notify.ts` (union + `PREFERENCE_FLAG`), `schema.ts` (union em `notifications` + flag em `notificationPreferences`).
- **`getLeads` filtra por um índice só**; o segmento de campanha faz a filtragem composta no servidor (`previewAudience`) com `take` paginado, não reusa `getLeads`.

## 12. Fora da v1 (explícito)
Marketing Messages API (`/marketing_messages`), criação/edição de template na Meta, A/B com estatística, split entre canais, agendamento no fuso de cada lead, sequências multi-passo (drip), listas interativas/botões no bridge, restauração de backup, XLSX no servidor.
