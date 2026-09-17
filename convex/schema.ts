import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

// Shared saved-view filters validator — single source of truth, reused by
// convex/savedViews.ts arg validators (never duplicate this shape inline).
// Lead/contact fields and task fields live in the same flat optional object;
// entityType decides which subset a view actually uses.
export const savedViewFiltersValidator = v.object({
  boardId: v.optional(v.id("boards")),
  stageIds: v.optional(v.array(v.id("stages"))),
  assignedTo: v.optional(v.id("teamMembers")),
  priority: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"))),
  temperature: v.optional(v.union(v.literal("cold"), v.literal("warm"), v.literal("hot"))),
  tags: v.optional(v.array(v.string())),
  hasContact: v.optional(v.boolean()),
  company: v.optional(v.string()),
  minValue: v.optional(v.number()),
  maxValue: v.optional(v.number()),
  channel: v.optional(v.union(
    v.literal("whatsapp"),
    v.literal("telegram"),
    v.literal("email"),
    v.literal("webchat"),
    v.literal("internal")
  )),
  // P1 — filtros de tarefas (entityType "tasks"); todos opcionais para
  // não afetar views de leads existentes
  statuses: v.optional(v.array(v.union(
    v.literal("pending"), v.literal("in_progress"),
    v.literal("completed"), v.literal("cancelled")
  ))),
  priorities: v.optional(v.array(v.union(
    v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent")
  ))),
  taskType: v.optional(v.union(v.literal("task"), v.literal("reminder"))),
  activityType: v.optional(v.union(
    v.literal("todo"), v.literal("call"), v.literal("email"),
    v.literal("follow_up"), v.literal("meeting"), v.literal("research")
  )),
  projectId: v.optional(v.id("taskProjects")),
  labelIds: v.optional(v.array(v.id("taskLabels"))),
  assigneeIds: v.optional(v.array(v.id("teamMembers"))),
  dueFilter: v.optional(v.union(
    v.literal("overdue"), v.literal("today"), v.literal("week"),
    v.literal("month"), v.literal("none")
  )),
});


// Shared permissions validator — used by teamMembers and apiKeys
const permissionsValidator = v.object({
  leads: v.union(v.literal("none"), v.literal("view_own"), v.literal("view_all"), v.literal("edit_own"), v.literal("edit_all"), v.literal("full")),
  contacts: v.union(v.literal("none"), v.literal("view"), v.literal("edit"), v.literal("full")),
  inbox: v.union(v.literal("none"), v.literal("view_own"), v.literal("view_all"), v.literal("reply"), v.literal("full")),
  tasks: v.union(v.literal("none"), v.literal("view_own"), v.literal("view_all"), v.literal("edit_own"), v.literal("edit_all"), v.literal("full")),
  reports: v.union(v.literal("none"), v.literal("view"), v.literal("full")),
  team: v.union(v.literal("none"), v.literal("view"), v.literal("manage")),
  settings: v.union(v.literal("none"), v.literal("view"), v.literal("manage")),
  auditLogs: v.union(v.literal("none"), v.literal("view")),
  apiKeys: v.union(v.literal("none"), v.literal("view"), v.literal("manage")),
  // Campanhas (disparo em massa de WhatsApp). Opcional: membros com permissões
  // explícitas gravadas antes da categoria existir continuam válidos —
  // resolvePermissions completa com o default do role.
  campaigns: v.optional(
    v.union(v.literal("none"), v.literal("view"), v.literal("manage"), v.literal("full"))
  ),
});

export { permissionsValidator };

// ── AI Agent Config (opt-in total: enabled default false, nada roda sem ativação) ──

// IDs de modelo CANÔNICOS — o adapter em lib/llm mapeia para o id de cada provider.
const aiModelsValidator = v.object({
  copilot: v.string(), // default "kimi-k2.7-code"
  attendant: v.string(), // default "deepseek-v4-flash"
  classify: v.string(), // default "deepseek-v4-flash"
  complex: v.optional(v.string()), // default "deepseek-v4-pro"
});

// Config de provider por-org. mode "platform" (default) usa as keys da plataforma
// (OpenCode Go → fallback OpenRouter); "byo" usa a key da org em orgSecrets.
// Ordem da cadeia da plataforma. Reusado no override por produto.
const platformOrderValidator = v.union(
  v.literal("auto"),
  v.literal("openrouter-first"),
  v.literal("opencode-only"),
  v.literal("openrouter-only")
);

// Override de rota POR PRODUTO de IA. Ausente = herda o `platformOrder` da org.
// A chave própria (BYO) continua sendo decisão da organização inteira: ela não
// tem fallback, e deixar UM produto sozinho numa rota caída é o tipo de coisa
// que ninguém percebe até o cliente reclamar.
//
// `model` só existe para a VISÃO, e por um motivo: nos outros produtos o modelo
// já mora em `models.{copilot,attendant}`. Na visão, ausente significa
// "Automático" — a cadeia inteira com fallover — e não "use o default".
const productRoutingValidator = v.object({
  order: v.optional(platformOrderValidator),
  model: v.optional(v.string()),
});

const providerConfigValidator = v.object({
  mode: v.union(v.literal("platform"), v.literal("byo")),
  byo: v.optional(
    v.object({
      provider: v.union(
        v.literal("opencode-go"),
        v.literal("openrouter"),
        v.literal("openai"),
        v.literal("anthropic"),
        v.literal("custom")
      ),
      baseUrl: v.optional(v.string()), // só para "custom"
      apiKeyRef: v.object({ kind: v.literal("orgSecret"), id: v.id("orgSecrets") }),
    })
  ),
  // ZDR é transparência + aviso, não bloqueio (a org é a controladora). O caminho
  // padrão da plataforma já é zero-retention; o aviso só aparece ao sair do padrão.
  zdr: v.boolean(), // default true
  strictZdr: v.optional(v.boolean()), // modo estrito opcional: backend RECUSA rotas não-ZDR
  // Ordem PADRÃO da cadeia no modo "platform": auto (OpenCode Go → OpenRouter),
  // openrouter-first inverte o primário, *-only remove o fallback. Cada produto
  // pode sobrescrever em `products` abaixo.
  platformOrder: v.optional(platformOrderValidator),
  // Aceite explícito registrado quando o admin escolhe uma rota não-ZDR sob zdr:true.
  nonZdrAck: v.optional(
    v.object({ acceptedAt: v.number(), acceptedBy: v.id("teamMembers"), route: v.string() })
  ),
  models: aiModelsValidator,
  // Config por produto de IA (Configurações → IA → "Produtos de IA"). Cada
  // produto herda o padrão da org quando o campo está ausente.
  products: v.optional(
    v.object({
      copilot: v.optional(productRoutingValidator),
      attendant: v.optional(productRoutingValidator),
      vision: v.optional(productRoutingValidator),
      // Publicações programadas em grupos (F3). Ausente = herda a rota da org.
      groupPosts: v.optional(productRoutingValidator),
      // Agente que RESPONDE dentro do grupo (F4) — outro produto, outra rota.
      groupAgent: v.optional(productRoutingValidator),
    })
  ),
});

const aiConfigValidator = v.object({
  // Kill-switch global. DEFAULT FALSE — nenhuma inferência dispara sem o admin
  // ativar E registrar o aceite LGPD (o runtime exige ambos).
  enabled: v.boolean(),
  autoAssign: v.boolean(),
  handoffThreshold: v.number(),
  // Gate de reconhecimento LGPD ("minha política divulga uso de IA + transferência
  // internacional"). Obrigatório para o runtime rodar — orgs legadas com
  // enabled:true mas sem lgpdAck continuam com a IA desligada.
  lgpdAck: v.optional(v.object({ acceptedAt: v.number(), acceptedBy: v.id("teamMembers") })),
  // Toggles por produto sob o mestre. undefined = ligado (compat com orgs que
  // ativaram antes de existirem os toggles).
  copilotEnabled: v.optional(v.boolean()),
  attendantEnabled: v.optional(v.boolean()),
  // Aceite org-level de risco do canal bridge (API não-oficial, banimento
  // permanente possível). Sem ele o atendente NUNCA atende canal bridge — é
  // condição de elegibilidade re-checada no commit (revogação vale já para runs
  // em voo). Revogar remove o objeto; o histórico fica no auditLog.
  bridgeAiAck: v.optional(
    v.object({ acceptedAt: v.number(), acceptedBy: v.id("teamMembers") })
  ),
  // Passe de visão: descrever imagens recebidas (comprovante, documento, foto)
  // para que o atendente responda ao que a pessoa mandou em vez de "[imagem]".
  // DEFAULT FALSE de propósito — diferente de copilotEnabled/attendantEnabled,
  // aqui `undefined` significa DESLIGADO: a imagem do cliente (que pode ser
  // RG/CNH) sai para um provider externo e cada imagem custa dinheiro. Opt-in
  // explícito por org.
  visionEnabled: v.optional(v.boolean()),
  // Agente de grupo (v0.57, F4). DEFAULT FALSE como `visionEnabled`: responder
  // dentro de um grupo alcança gente que nunca falou com a empresa. A F1 só
  // declara o campo; quem o lê é a F4.
  groupAgentEnabled: v.optional(v.boolean()),
  // Aceite PRÓPRIO do autopilot em GRUPO (review de segurança nº 5). O
  // `autopilotEarlyAck` do atendente 1 a 1 foi assinado para outro risco:
  // responder sozinho a UMA pessoa que escreveu para a empresa. Publicar sozinho
  // numa sala de dezenas de terceiros é um risco maior e pede aceite próprio.
  // Sem ele (e com o atendente fora de `autopilot`), a política do grupo cai
  // para `suggest` — avisar, não travar: o operador escolhe, com o aviso na
  // frente e o audit `high` no rastro.
  groupAutopilotAck: v.optional(
    v.object({ acceptedAt: v.number(), acceptedBy: v.id("teamMembers") })
  ),
  providerConfig: v.optional(providerConfigValidator),
  // Teto amigável de uso mensal (nº de conversas atendidas). Kill-switch de custo.
  monthlyConversationBudget: v.optional(v.number()),
});

export { aiConfigValidator };

// Perfil de agente em teamMembers (só para type:"ai" ou config do copiloto).
const agentProfileValidator = v.object({
  kind: v.union(v.literal("copilot"), v.literal("attendant")),
  // Todo atendente começa em "suggest" (gera rascunho, não auto-envia).
  mode: v.union(v.literal("suggest"), v.literal("autopilot")),
  systemPrompt: v.optional(v.string()),
  knowledge: v.optional(v.string()),
  language: v.optional(v.string()), // default "pt-BR"
  // Escopo de atuação: canais (só Meta até HMAC por-tenant no bridge) e boards.
  channelConfigIds: v.optional(v.array(v.id("channelConfigs"))),
  boardIds: v.optional(v.array(v.id("boards"))),
  schedule: v.optional(
    v.object({
      timezone: v.string(), // default "America/Sao_Paulo"
      startHour: v.number(),
      endHour: v.number(),
      days: v.optional(v.array(v.number())), // 0=Dom … 6=Sáb; ausente = todos
    })
  ),
  handoffKeywords: v.optional(v.array(v.string())), // ex.: ["humano", "atendente"]
  maxRepliesPerConversation: v.optional(v.number()), // default 20
  maxRepliesPerHour: v.optional(v.number()), // teto por janela (cliente-que-é-bot)
  // Silêncio que fecha a rajada de inbounds antes da IA responder (default 5s).
  // Quem digita fragmentado ("Oi" / "tudo" / "bem?") pede valores maiores.
  messageDebounceSeconds: v.optional(v.number()),
  maxToolCallsPerRun: v.optional(v.number()), // default 6
  model: v.optional(v.string()), // override do id canônico da org
  temperature: v.optional(v.number()),
  disclosure: v.optional(v.string()), // divulgação LGPD na 1ª resposta ao cliente
  // Regras de pipeline do atendente (P4 v4.1). Tudo opcional = comportamento atual.
  pipelineConfig: v.optional(
    v.object({
      boardId: v.optional(v.id("boards")), // board p/ novos leads dos canais do atendente
      initialStageId: v.optional(v.id("stages")), // deve pertencer a boardId
      advanceRules: v.optional(v.string()), // linguagem natural → seção "REGRAS DO FUNIL" do prompt
      qualifiedStageId: v.optional(v.id("stages")), // movimento DETERMINÍSTICO pós-qualificação
      qualifyThreshold: v.optional(v.number()), // score BANT mínimo p/ mover (default 3)
      allowMoveStages: v.optional(v.boolean()), // default true; false remove moveThisLead da run E recusa no executor
      // v4.2: whitelist de custom fields (keys de fieldDefinitions, entity lead)
      // que a IA pode preencher via updateThisLeadInfo. O executor valida chave
      // E opção server-side — o modelo nunca escreve fora desta lista.
      captureFields: v.optional(v.array(v.string())),
    })
  ),
  // Autopilot ANTECIPADO: quem ligou o autopilot sem passar pelo gate de
  // métricas (10 sugestões revisadas / 60% de aceitação) aceitando o risco
  // explicitamente. Fica no perfil (não só no auditLog) para a UI mostrar que o
  // gate foi pulado e por quem. Voltar ao modo sugestão NÃO apaga (histórico).
  autopilotEarlyAck: v.optional(
    v.object({ acceptedAt: v.number(), acceptedBy: v.id("teamMembers") })
  ),
});

// ── Campanhas de WhatsApp (disparo em massa) ──
// Tetos de envio de uma campanha. TODOS os números são estimativas de
// engenharia calibráveis (ver docs/AI-WHATSAPP-LIMITS.md) — o teto DURO vive em
// lib/campaignPacing.ts e nunca é ultrapassado, nem com override.
const campaignPacingValidator = v.object({
  minDelaySec: v.number(),
  maxDelaySec: v.number(),
  batchSize: v.number(), // envios entre pausas de lote (0 = sem lote)
  batchPauseMin: v.number(),
  maxPerHour: v.number(),
  maxPerDay: v.number(),
  maxNewContactsPerDay: v.optional(v.number()),
  respectWarmup: v.optional(v.boolean()), // bridge: aplica a rampa por idade do número
});

const campaignScheduleValidator = v.object({
  startAt: v.optional(v.number()), // ausente = ao lançar
  timezone: v.string(),
  windowStartHour: v.number(), // 0-23
  windowEndHour: v.number(), // 1-24 (exclusivo)
  days: v.array(v.number()), // 0=Dom … 6=Sáb
});

const campaignAckValidator = v.object({ acceptedAt: v.number(), acceptedBy: v.id("teamMembers") });

const campaignVariantValidator = v.object({
  text: v.string(),
  attachmentFileIds: v.optional(v.array(v.id("files"))),
});

const campaignTemplateParamValidator = v.object({
  // "field" = campo do destinatário (vars/nome), "const" = texto fixo
  source: v.union(v.literal("field"), v.literal("const")),
  value: v.string(),
});

const campaignAudienceFiltersValidator = v.object({
  boardId: v.optional(v.id("boards")),
  stageIds: v.optional(v.array(v.id("stages"))),
  tags: v.optional(v.array(v.string())),
  assignedTo: v.optional(v.id("teamMembers")),
  temperature: v.optional(v.union(v.literal("cold"), v.literal("warm"), v.literal("hot"))),
  priority: v.optional(
    v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent"))
  ),
  lastActivityBefore: v.optional(v.number()),
  lastActivityAfter: v.optional(v.number()),
  onlyOpenWindow: v.optional(v.boolean()), // só quem tem janela de 24h aberta (Meta)
  excludeCampaignedWithinDays: v.optional(v.number()),
  excludeRepliedToCampaigns: v.optional(v.boolean()),
});

// Filtros do público "membros de grupos" (v0.57 / F5, D15). Não se misturam com
// os de segmento: ali a origem é um LEAD do CRM, aqui é um participante de uma
// sala de WhatsApp que pode nunca ter falado com a empresa.
const campaignMemberFiltersValidator = v.object({
  excludeAdmins: v.optional(v.boolean()),
  excludeExistingContacts: v.optional(v.boolean()),
  excludeCampaignedWithinDays: v.optional(v.number()),
  activeInGroupWithinDays: v.optional(v.number()), // falou no grupo nos últimos N dias
  excludeGroupChatIds: v.optional(v.array(v.id("groupChats"))), // quem também está nestes grupos sai
  /**
   * Seleção explícita de pessoas (chave do participante = `lid ?? phone`).
   *
   * Ausente ou vazio = TODOS os elegíveis, o comportamento de sempre. Presente,
   * só estas pessoas entram — e os demais filtros continuam valendo por cima
   * (um admin escolhido some se "não mandar para administradores" estiver
   * ligado). Chave que não existe nos grupos escolhidos é ignorada: a lista é
   * um recorte do público, não uma fonte de destinatário.
   *
   * Teto 1024 = o teto de participantes de um grupo do WhatsApp.
   */
  includeKeys: v.optional(v.array(v.string())),
});

const campaignStatusValidator = v.union(
  v.literal("draft"),
  v.literal("scheduled"),
  v.literal("running"),
  v.literal("paused"),
  v.literal("completed"),
  v.literal("canceled"),
  v.literal("failed")
);

const campaignRecipientStatusValidator = v.union(
  v.literal("pending"),
  v.literal("queued"),
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("read"),
  v.literal("replied"),
  v.literal("failed"),
  v.literal("skipped"),
  v.literal("opted_out")
);

export {
  campaignPacingValidator,
  campaignScheduleValidator,
  campaignAckValidator,
  campaignVariantValidator,
  campaignTemplateParamValidator,
  campaignAudienceFiltersValidator,
  campaignMemberFiltersValidator,
  campaignStatusValidator,
  campaignRecipientStatusValidator,
};

// ── Publicações programadas em grupos de WhatsApp (v0.57 / F3, D7 e D8) ──
//
// "Todo dia às 12h o Guardião posta no grupo XYZ". Uma publicação = destinos +
// agenda + fonte de conteúdo + política de aprovação. O worker é um job
// auto-reagendado POR publicação (molde do `campaignWorker.tick`), não um cron
// global: pausar uma publicação não pode depender de filtrar um cron.

// Agenda com granularidade de MINUTO e dias 1..7 (1 = segunda). É outra coisa
// que `campaignScheduleValidator` (janela de hora cheia, dias 0..6 domingo-
// primeiro): a campanha pergunta "posso enviar AGORA?", a publicação pergunta
// "QUANDO é o próximo disparo?". O helper puro é `lib/groupPostSchedule.ts`.
const groupPostScheduleValidator = v.object({
  timezone: v.string(), // IANA
  times: v.array(v.string()), // "HH:MM" locais, 1..10
  days: v.array(v.number()), // 1..7 (1 = segunda … 7 = domingo)
  startAt: v.optional(v.number()),
  endAt: v.optional(v.number()),
  jitterMinutes: v.optional(v.number()), // 0..30, determinístico por slot
});

const groupPostLibraryItemValidator = v.object({
  text: v.string(), // aceita spintax {a|b} e {{grupo}}/{{data}}/{{dia_semana}}
  attachmentFileIds: v.optional(v.array(v.id("files"))), // no máx. 1 (limite do bridge)
  contentType: v.optional(
    v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio"))
  ),
});

const groupPostContentValidator = v.object({
  kind: v.union(v.literal("library"), v.literal("ai")),
  library: v.optional(
    v.object({
      items: v.array(groupPostLibraryItemValidator),
      order: v.union(v.literal("sequential"), v.literal("random")),
      noRepeatWindow: v.optional(v.number()), // aleatório: não repete os últimos N
      cursor: v.optional(v.number()), // sequencial: próximo índice (circular)
      // Últimos índices sorteados, só o tanto que `noRepeatWindow` pede. Não é
      // histórico — é o estado mínimo da regra "não repita os últimos N".
      recentIndexes: v.optional(v.array(v.number())),
    })
  ),
  ai: v.optional(
    v.object({
      prompt: v.string(),
      persona: v.optional(v.union(v.literal("attendant"), v.literal("custom"))),
      customPersona: v.optional(v.string()), // usado quando persona === "custom"
      useKnowledge: v.boolean(), // injeta o `knowledge` do atendente
      maxChars: v.optional(v.number()),
      generateMinutesBefore: v.number(), // 5..1440 (default de produto: 60)
      requiresApproval: v.boolean(), // false exige `campaigns:full` para configurar
      onMissedApproval: v.union(v.literal("skip"), v.literal("send")),
    })
  ),
});

// Texto gerado pela IA esperando decisão humana. Vive no doc (é um por vez) em
// vez de tabela própria: a publicação só tem UM pendente, o do próximo slot.
const groupPostPendingValidator = v.object({
  text: v.string(),
  attachmentFileIds: v.optional(v.array(v.id("files"))),
  generatedAt: v.number(),
  dueAt: v.number(), // instante do slot a que este texto pertence
  slotKey: v.string(), // idempotência: texto de um slot não serve para outro
  status: v.union(v.literal("pendingApproval"), v.literal("approved"), v.literal("rejected")),
  approvedBy: v.optional(v.id("teamMembers")),
  editedText: v.optional(v.string()), // o humano corrigiu antes de aprovar
  model: v.optional(v.string()),
  provider: v.optional(v.string()),
});

const groupPostTimelineValidator = v.object({
  at: v.number(),
  kind: v.string(), // created | activated | paused | resumed | ended | sent | skipped | failed | pending | approved | rejected | caps
  detail: v.optional(v.string()),
  actorId: v.optional(v.id("teamMembers")),
  slotKey: v.optional(v.string()),
  // Só nas entradas `kind: "sent"` — é o que a aba "Histórico" liga ao inbox.
  sends: v.optional(
    v.array(
      v.object({
        groupChatId: v.id("groupChats"),
        conversationId: v.optional(v.id("conversations")),
        messageId: v.optional(v.id("messages")),
        error: v.optional(v.string()),
      })
    )
  ),
});

export {
  groupPostScheduleValidator,
  groupPostLibraryItemValidator,
  groupPostContentValidator,
  groupPostPendingValidator,
  groupPostTimelineValidator,
};

const applicationTables = {
  // Organizations
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    settings: v.object({
      timezone: v.string(),
      currency: v.string(),
      aiConfig: v.optional(aiConfigValidator),
      // Campanhas: palavras-chave inbound que colocam o remetente na lista de
      // supressão (optOuts). Ausente = ["SAIR","PARAR","STOP","CANCELAR"].
      optOutKeywords: v.optional(v.array(v.string())),
      // Campanhas: tetos default da org (sobrepõem a tabela segura de
      // lib/campaignPacing, nunca o teto duro). Ausente = tabela.
      campaignDefaults: v.optional(campaignPacingValidator),
    }),
    onboardingMeta: v.optional(v.object({
      industry: v.optional(v.string()),
      companySize: v.optional(v.string()),
      mainGoal: v.optional(v.string()),
      wizardCompletedAt: v.optional(v.number()),
    })),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_slug", ["slug"]),

  // Team Members (humans and AI agents)
  teamMembers: defineTable({
    organizationId: v.id("organizations"),
    userId: v.optional(v.id("users")), // null for AI agents
    name: v.string(),
    email: v.optional(v.string()),
    role: v.union(v.literal("admin"), v.literal("manager"), v.literal("agent"), v.literal("ai")),
    type: v.union(v.literal("human"), v.literal("ai")),
    status: v.union(v.literal("active"), v.literal("inactive"), v.literal("busy")),
    avatarFileId: v.optional(v.id("files")),
    capabilities: v.optional(v.array(v.string())),
    permissions: v.optional(permissionsValidator),
    // Perfil do agente IA (persona, modo suggest/autopilot, escopo, guardrails).
    agentProfile: v.optional(agentProfileValidator),
    mustChangePassword: v.optional(v.boolean()),
    invitedBy: v.optional(v.id("teamMembers")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_user", ["userId"])
    .index("by_email", ["email"])
    .index("by_organization_and_type", ["organizationId", "type"])
    .index("by_organization_and_user", ["organizationId", "userId"]),

  // API Keys for AI agents
  apiKeys: defineTable({
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    name: v.string(),
    keyHash: v.string(),
    lastUsed: v.optional(v.number()),
    rateWindowStart: v.optional(v.number()), // fixed-window rate limit state
    rateWindowCount: v.optional(v.number()),
    isActive: v.boolean(),
    permissions: v.optional(permissionsValidator),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_team_member", ["teamMemberId"])
    .index("by_key_hash", ["keyHash"])
    .index("by_key_hash_and_active", ["keyHash", "isActive"]),

  // Boards (pipelines)
  boards: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    color: v.string(),
    isDefault: v.boolean(),
    order: v.number(),
    // Soft-delete timestamp: undefined = active, set = archived
    archivedAt: v.optional(v.number()),
    // Exclusão definitiva em andamento (cascata batched): o board fica arquivado
    // até o job terminar, mas não pode ser restaurado nem re-excluído.
    deletionStartedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_order", ["organizationId", "order"]),

  // Stages within boards
  stages: defineTable({
    organizationId: v.id("organizations"),
    boardId: v.id("boards"),
    name: v.string(),
    color: v.string(),
    order: v.number(),
    isClosedWon: v.boolean(),
    isClosedLost: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_board", ["boardId"])
    .index("by_board_and_order", ["boardId", "order"]),

  // Lead Sources
  leadSources: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    type: v.union(
      v.literal("website"),
      v.literal("social"),
      v.literal("email"),
      v.literal("phone"),
      v.literal("referral"),
      v.literal("api"),
      v.literal("campaign"),
      v.literal("other")
    ),
    isActive: v.boolean(),
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  // Custom Field Definitions
  fieldDefinitions: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    key: v.string(),
    type: v.union(
      v.literal("text"),
      v.literal("number"),
      v.literal("boolean"),
      v.literal("date"),
      v.literal("select"),
      v.literal("multiselect")
    ),
    entityType: v.optional(v.union(v.literal("lead"), v.literal("contact"))),
    options: v.optional(v.array(v.string())),
    isRequired: v.boolean(),
    order: v.number(),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_key", ["organizationId", "key"])
    .index("by_organization_and_entity", ["organizationId", "entityType"])
    .index("by_organization_and_entity_and_key", ["organizationId", "entityType", "key"]),

  // Contacts
  contacts: defineTable({
    organizationId: v.id("organizations"),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    company: v.optional(v.string()),
    title: v.optional(v.string()),
    whatsappNumber: v.optional(v.string()),
    telegramUsername: v.optional(v.string()),
    tags: v.array(v.string()),
    searchText: v.optional(v.string()),

    // Identity
    photoFileId: v.optional(v.id("files")),
    bio: v.optional(v.string()),

    // Social Profiles
    linkedinUrl: v.optional(v.string()),
    instagramUrl: v.optional(v.string()),
    facebookUrl: v.optional(v.string()),
    twitterUrl: v.optional(v.string()),

    // Location
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    country: v.optional(v.string()),

    // Professional
    industry: v.optional(v.string()),
    companySize: v.optional(v.string()),
    cnpj: v.optional(v.string()),
    companyWebsite: v.optional(v.string()),

    // Behavioral
    preferredContactTime: v.optional(v.union(
      v.literal("morning"), v.literal("afternoon"), v.literal("evening")
    )),
    deviceType: v.optional(v.union(
      v.literal("android"), v.literal("iphone"), v.literal("desktop"), v.literal("unknown")
    )),
    utmSource: v.optional(v.string()),
    acquisitionChannel: v.optional(v.string()),

    // Social Metrics
    instagramFollowers: v.optional(v.number()),
    linkedinConnections: v.optional(v.number()),
    socialInfluenceScore: v.optional(v.number()),

    // Custom Fields
    customFields: v.optional(v.record(v.string(), v.any())),

    // Enrichment provenance
    enrichmentMeta: v.optional(v.record(v.string(), v.object({
      source: v.string(),
      updatedAt: v.number(),
      confidence: v.optional(v.number()),
    }))),

    // Flexible overflow for future AI-discovered data
    enrichmentExtra: v.optional(v.record(v.string(), v.any())),

    // Opt-out de IA (LGPD art. 18): 9ª condição de elegibilidade do atendente —
    // contato com aiOptOut nunca recebe resposta automática (escala p/ humano).
    aiOptOut: v.optional(v.boolean()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_email", ["email"])
    .index("by_phone", ["phone"])
    .index("by_organization_and_email", ["organizationId", "email"])
    .index("by_organization_and_phone", ["organizationId", "phone"])
    .index("by_organization_and_company", ["organizationId", "company"])
    .index("by_organization_and_city", ["organizationId", "city"])
    .searchIndex("search_contacts", { searchField: "searchText", filterFields: ["organizationId"] }),

  // Leads
  leads: defineTable({
    organizationId: v.id("organizations"),
    title: v.string(),
    contactId: v.optional(v.id("contacts")),
    boardId: v.id("boards"),
    stageId: v.id("stages"),
    assignedTo: v.optional(v.id("teamMembers")),
    value: v.number(),
    currency: v.string(),
    priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent")),
    temperature: v.union(v.literal("cold"), v.literal("warm"), v.literal("hot")),
    sourceId: v.optional(v.id("leadSources")),
    tags: v.array(v.string()),
    customFields: v.record(v.string(), v.any()),
    qualification: v.optional(v.object({
      budget: v.optional(v.boolean()),
      authority: v.optional(v.boolean()),
      need: v.optional(v.boolean()),
      timeline: v.optional(v.boolean()),
      score: v.optional(v.number()),
    })),
    conversationStatus: v.union(
      v.literal("new"),
      v.literal("active"),
      v.literal("waiting"),
      v.literal("closed")
    ),
    handoffState: v.optional(v.object({
      status: v.union(v.literal("requested"), v.literal("pending"), v.literal("completed")),
      fromMemberId: v.id("teamMembers"),
      toMemberId: v.optional(v.id("teamMembers")),
      reason: v.string(),
      summary: v.optional(v.string()),
      suggestedActions: v.optional(v.array(v.string())),
      requestedAt: v.number(),
      completedAt: v.optional(v.number()),
    })),
    closedAt: v.optional(v.number()),
    closedReason: v.optional(v.string()),
    closedType: v.optional(v.union(v.literal("won"), v.literal("lost"))),
    // Soft-delete timestamp: undefined = active, set = archived
    archivedAt: v.optional(v.number()),
    lastActivityAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_board", ["organizationId", "boardId"])
    .index("by_board", ["boardId"])
    .index("by_stage", ["stageId"])
    .index("by_assigned_to", ["assignedTo"])
    .index("by_contact", ["contactId"])
    .index("by_organization_and_stage", ["organizationId", "stageId"])
    .index("by_organization_and_assigned", ["organizationId", "assignedTo"])
    .index("by_organization_and_archived", ["organizationId", "archivedAt"])
    .index("by_handoff_status", ["handoffState.status"])
    .index("by_last_activity", ["lastActivityAt"]),

  // Channel configurations (per-org connections to external messaging providers)
  channelConfigs: defineTable({
    organizationId: v.id("organizations"),
    channel: v.union(v.literal("whatsapp")), // union-ready for future channels
    // Which WhatsApp transport this config uses. Optional for backward compat:
    // legacy rows predate the field — read paths normalize undefined → "meta"
    // (see configProvider() in channelConfigs.ts). "meta" = Cloud API (Graph),
    // "bridge" = unofficial gateway (whatsmeow/wuzapi over REST + webhook).
    provider: v.optional(v.union(v.literal("meta"), v.literal("bridge"))),
    displayName: v.string(),
    // ── Meta Cloud API fields (present when provider === "meta") ──
    phoneNumberId: v.optional(v.string()), // Meta Cloud API phone number id (webhook routing key)
    wabaId: v.optional(v.string()), // WhatsApp Business Account id
    displayPhoneNumber: v.optional(v.string()), // human-readable, filled by health check
    verifyToken: v.optional(v.string()), // webhook GET handshake token
    // Secrets encrypted at rest (AES-256-GCM via lib/secretCrypto); never sent to clients
    appSecretEncrypted: v.optional(v.string()),
    accessTokenEncrypted: v.optional(v.string()),
    // Plaintext last-4 for masked display without decryption
    appSecretLast4: v.optional(v.string()),
    accessTokenLast4: v.optional(v.string()),
    // ── Bridge (whatsmeow/wuzapi) fields (present when provider === "bridge") ──
    bridgeBaseUrl: v.optional(v.string()), // REST base URL of the wuzapi gateway
    bridgeInstanceId: v.optional(v.string()), // instance/user id in the gateway (ingress routing key)
    bridgeTokenEncrypted: v.optional(v.string()), // per-instance token, AES-encrypted at rest
    bridgeTokenLast4: v.optional(v.string()),
    // Bridge pairing state from the last health check / QR fetch (whatsmeow session).
    // Drives the Channels card badge; absent on Meta configs. The coarse status
    // field (active/error) still mirrors "connected vs not" as the Meta path does.
    bridgeSessionState: v.optional(
      v.union(
        v.literal("connected"),
        v.literal("connecting"),
        v.literal("qr"),
        v.literal("disconnected"),
        v.literal("banned")
      )
    ),
    status: v.union(v.literal("active"), v.literal("disabled"), v.literal("error")),
    lastHealthCheckAt: v.optional(v.number()),
    healthDetail: v.optional(v.string()),
    // Auto-transcribe inbound voice notes with the local Whisper service
    // (convex/transcription.ts). Applies to both providers; absent/false = off.
    autoTranscribeAudio: v.optional(v.boolean()),
    // LEGADO (v0.51 → v0.52): existiu por uma versão como segundo interruptor da
    // leitura de imagens, num AND com aiConfig.visionEnabled. Dois interruptores
    // em telas diferentes para ligar UMA coisa era confuso e não valia a
    // flexibilidade — hoje quem manda é só `aiConfig.visionEnabled`. O campo
    // fica aqui porque o Convex valida os documentos existentes no push; nada
    // lê nem escreve nele.
    autoDescribeImages: v.optional(v.boolean()),
    // Quando a sessão bridge ficou "connected" pela primeira vez — idade do
    // número para o warm-up de campanhas (ausente = usa createdAt).
    bridgeConnectedAt: v.optional(v.number()),
    // Telefone pareado, SÓ DÍGITOS (E.164 sem '+'), preenchido quando a sessão
    // fica "connected". É a chave de EXCLUSIVIDADE: um número do WhatsApp só
    // pode estar ativo em UM canal do deployment inteiro. Sem isso o mesmo
    // número pareado em duas orgs faz cada mensagem do contato ser ingerida nas
    // duas — vazamento entre inquilinos, não só ruído. `displayPhoneNumber` é
    // para exibição (tem '+', e o caminho Meta também usa), então não serve de
    // chave.
    bridgePhone: v.optional(v.string()),
    // ── Histórico do aparelho (bridge, POR NÚMERO) ──
    // Rede de recuperação para o que o webhook não trouxe (janela de queda,
    // evento perdido, mensagem digitada no celular antes desta versão): o
    // gateway wuzapi guarda as mensagens numa tabela própria e devolve em
    // `GET /chat/history`. Opt-in explícito — ausente/false = DESLIGADO, e com
    // ele desligado o CRM nunca chama esses endpoints. A config é por canal
    // porque cada número tem sua instância (e seu volume) no gateway.
    bridgeHistoryEnabled: v.optional(v.boolean()),
    // Teto de mensagens por conversa, na ida (o `count` do pedido de sync) e na
    // volta (o `limit` da leitura). Ausente = BRIDGE_HISTORY_DEFAULT_LIMIT.
    bridgeHistoryLimit: v.optional(v.number()),
    // Janela em dias: nada mais velho que isso é importado, mesmo que o gateway
    // devolva. Ausente = BRIDGE_HISTORY_DEFAULT_DAYS.
    bridgeHistoryDays: v.optional(v.number()),
    // Resultado da última sincronização (para a UI não mentir sobre o estado).
    bridgeHistoryLastSyncAt: v.optional(v.number()),
    bridgeHistoryLastResult: v.optional(v.string()),
    // ── Grupos de WhatsApp (bridge, POR NÚMERO) — v0.57 ──
    // Opt-in explícito: ausente/false = o CRM não lista nem ingere grupo nenhum
    // deste número. Ligar exige o aceite de risco abaixo (D12).
    bridgeGroupsEnabled: v.optional(v.boolean()),
    bridgeGroupsAck: v.optional(
      v.object({ acceptedAt: v.number(), acceptedBy: v.id("teamMembers") })
    ),
    // NOSSO LID nesta instância (`GET /user/lid/{bridgePhone}` → data.lid).
    // É o que permite saber se somos admin do grupo e se fomos mencionados —
    // `GET /session/status` devolve `jid: ""` mesmo logado (medido).
    bridgeLid: v.optional(v.string()),
    bridgeGroupsLastSyncAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_phone_number_id", ["phoneNumberId"])
    .index("by_verify_token", ["verifyToken"])
    .index("by_bridge_instance", ["bridgeInstanceId"])
    // Deployment-wide de propósito (sem organizationId): a pergunta que ele
    // responde é "este número já está em ALGUMA conta?".
    .index("by_bridge_phone", ["bridgePhone"]),

  // Conversations
  conversations: defineTable({
    organizationId: v.id("organizations"),
    // OPCIONAL desde a v0.57 (grupos de WhatsApp): uma conversa `kind:"group"`
    // é uma SALA, não um lead — forçar um lead sintético poluiria funil,
    // dashboard e métricas. Toda conversa `kind:"direct"` (= ausente) continua
    // tendo lead, e o ingest 1:1 nunca cria conversa sem ele.
    leadId: v.optional(v.id("leads")),
    // Ausente = "direct" (todo o histórico anterior a grupos).
    kind: v.optional(v.union(v.literal("direct"), v.literal("group"))),
    // JID do chat no provedor quando não há contato/lead para resolvê-lo:
    // "1203…@g.us" numa conversa de grupo. É o destino do dispatch.
    externalChatId: v.optional(v.string()),
    groupChatId: v.optional(v.id("groupChats")),
    channel: v.union(
      v.literal("whatsapp"),
      v.literal("telegram"),
      v.literal("email"),
      v.literal("webchat"),
      v.literal("internal")
    ),
    channelConfigId: v.optional(v.id("channelConfigs")), // which connected number this conversation belongs to
    status: v.union(v.literal("active"), v.literal("closed")),
    lastMessageAt: v.optional(v.number()),
    lastInboundAt: v.optional(v.number()), // set by ingress — drives the 24h customer-service window
    nextDispatchAt: v.optional(v.number()), // pacing cursor for outbound dispatch (~1 msg/6s per recipient)
    // Presença do contato (ChatPresence do bridge) — "digitando..." no header.
    // `at` permite expirar no cliente (evento "paused" pode nunca chegar).
    contactPresence: v.optional(
      v.object({
        state: v.union(v.literal("composing"), v.literal("paused")),
        at: v.number(),
      })
    ),
    archivedAt: v.optional(v.number()), // conversa arquivada (fora da lista padrão)
    labelIds: v.optional(v.array(v.id("conversationLabels"))),
    // Não lidas pela EQUIPE (compartilhado, não por membro): ingress incrementa,
    // markConversationRead zera. Ausente = 0 (conversas antigas nascem "lidas").
    unreadCount: v.optional(v.number()),
    lastReadAt: v.optional(v.number()),
    // Lock/lease OCC do turno de IA — evita resposta dupla de dois inbounds
    // concorrentes. Claims concorrentes leem+escrevem o mesmo doc → só uma commita.
    aiTurnLock: v.optional(v.object({ runId: v.string(), leaseUntil: v.number() })),
    // "Assumir conversa"/"Pausar IA" explícito: IA não responde até este timestamp
    // (Number.MAX_SAFE_INTEGER = pausa indefinida até reativar).
    aiPausedUntil: v.optional(v.number()),
    // Informações passadas pela equipe humana à IA ("Devolver para IA" /
    // rejeitar repasse com instrução): persistem na conversa e entram como
    // fonte oficial em TODOS os turnos seguintes do atendente (cap 20, FIFO).
    aiTeamNotes: v.optional(
      v.array(
        v.object({
          text: v.string(),
          byMemberId: v.optional(v.id("teamMembers")),
          at: v.number(),
        })
      )
    ),
    messageCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_lead", ["leadId"])
    .index("by_lead_and_channel", ["leadId", "channel"])
    .index("by_organization_and_status", ["organizationId", "status"])
    // Lista do inbox ordenada por última mensagem (desc) sem collect() da org.
    .index("by_organization_and_last_message", ["organizationId", "lastMessageAt"])
    // Badge da sidebar: range unreadCount > 0 direto no índice.
    .index("by_organization_and_unread", ["organizationId", "unreadCount"])
    // Conversa de grupo pelo JID, dentro de um canal (idempotência do ingest).
    .index("by_channel_config_and_external_chat", ["channelConfigId", "externalChatId"]),

  // Messages
  messages: defineTable({
    organizationId: v.id("organizations"),
    conversationId: v.id("conversations"),
    // OPCIONAL desde a v0.57: mensagem de conversa de grupo não tem lead.
    leadId: v.optional(v.id("leads")),
    direction: v.union(v.literal("inbound"), v.literal("outbound"), v.literal("internal")),
    senderId: v.optional(v.id("teamMembers")), // null for inbound from contact
    senderType: v.union(v.literal("contact"), v.literal("human"), v.literal("ai")),
    // ── Grupo: quem, dentro da sala, mandou esta mensagem ──
    // `senderLid` é o JID de privacidade ("…@lid"), a chave estável do membro;
    // `senderPhone` é o MSISDN quando o evento o expõe (`Info.SenderAlt`).
    // `senderName` vem do PushName — única fonte de nome no WhatsApp de grupo.
    senderLid: v.optional(v.string()),
    senderPhone: v.optional(v.string()),
    senderName: v.optional(v.string()),
    // Preenchido só quando o telefone do membro JÁ é um contato da org (D3:
    // membro de grupo NÃO vira contato automaticamente).
    senderContactId: v.optional(v.id("contacts")),
    // JIDs mencionados (ContextInfo.MentionedJID) — LID ou telefone.
    mentions: v.optional(v.array(v.string())),
    // Em grupo o quote precisa do JID do AUTOR da mensagem citada.
    quotedParticipantJid: v.optional(v.string()),
    // Quem leu esta mensagem no grupo (Receipt.MessageSender), cap 50.
    readBy: v.optional(v.array(v.object({ jid: v.string(), at: v.number() }))),
    content: v.string(),
    contentType: v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio")),
    attachments: v.optional(v.array(v.id("files"))),
    deliveryStatus: v.optional(v.union(
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("failed")
    )),
    isInternal: v.boolean(),
    mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
    externalId: v.optional(v.string()), // provider message id (e.g. WhatsApp wamid) for dedupe + status updates
    metadata: v.optional(v.record(v.string(), v.any())),
    // Cópia rasa de metadata.transcription.text — search index só indexa campo
    // de topo, então a transcrição pesquisável vive aqui (setada ao transcrever).
    transcriptText: v.optional(v.string()),
    // Idem para o passe de visão: cópia rasa de metadata.vision.text, para o
    // search index encontrar o que estava escrito na imagem (convex/vision.ts).
    imageDescription: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_conversation", ["conversationId"])
    .index("by_lead", ["leadId"])
    .index("by_organization", ["organizationId"])
    .index("by_conversation_and_created", ["conversationId", "createdAt"])
    .index("by_organization_and_external_id", ["organizationId", "externalId"])
    .searchIndex("search_content", {
      searchField: "content",
      filterFields: ["organizationId", "conversationId"],
    })
    .searchIndex("search_transcript", {
      searchField: "transcriptText",
      filterFields: ["organizationId", "conversationId"],
    })
    .searchIndex("search_image", {
      searchField: "imageDescription",
      filterFields: ["organizationId", "conversationId"],
    }),

  // Etiquetas de conversa (org-scoped), atribuídas via conversations.labelIds.
  conversationLabels: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    color: v.string(), // hex da paleta fixa do frontend
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  /**
   * Grupos de WhatsApp conhecidos por um canal bridge (v0.57).
   *
   * Um grupo é uma SALA, não um lead: os metadados vivem aqui e a troca de
   * mensagens reusa `conversations`/`messages` com `kind:"group"`. Acompanhar é
   * OPT-IN por grupo (`monitored`, default false) — o número do cliente está em
   * grupo de família/escola, e ingerir tudo seria vazamento (D4).
   *
   * Escopo: org + canal. O MESMO grupo pareado em dois números da mesma org
   * gera duas linhas (uma por canal) — aceito e documentado na v1.
   */
  groupChats: defineTable({
    organizationId: v.id("organizations"),
    channelConfigId: v.id("channelConfigs"),
    // Conversa `kind:"group"` — criada só quando o grupo passa a ser monitorado.
    conversationId: v.optional(v.id("conversations")),
    jid: v.string(), // "1203…@g.us"
    subject: v.string(),
    topic: v.optional(v.string()),
    ownerJid: v.optional(v.string()),
    pictureUrl: v.optional(v.string()),
    createdAtWa: v.optional(v.number()),
    isAnnounce: v.optional(v.boolean()),
    isLocked: v.optional(v.boolean()),
    isEphemeral: v.optional(v.boolean()),
    disappearingTimer: v.optional(v.number()),
    isCommunityParent: v.optional(v.boolean()),
    linkedParentJid: v.optional(v.string()),
    weAreAdmin: v.optional(v.boolean()),
    weAreSuperAdmin: v.optional(v.boolean()),
    // "lid" = Participants[].JID vem como @lid e o telefone em PhoneNumber.
    addressingMode: v.optional(v.union(v.literal("lid"), v.literal("pn"))),
    // SEMPRE Participants.length: o /group/list devolve ParticipantCount 0.
    participantsCount: v.optional(v.number()),
    // Chave do participante = `lid ?? phone`. Nome só existe via PushName das
    // mensagens (cache oportunista) — o gateway devolve DisplayName vazio.
    participants: v.optional(
      v.array(
        v.object({
          lid: v.optional(v.string()),
          phone: v.optional(v.string()),
          name: v.optional(v.string()),
          isAdmin: v.boolean(),
          isSuperAdmin: v.boolean(),
          contactId: v.optional(v.id("contacts")),
          joinedAt: v.optional(v.number()),
          leftAt: v.optional(v.number()),
        })
      )
    ),
    monitored: v.boolean(),
    monitoredSince: v.optional(v.number()),
    monitoredBy: v.optional(v.id("teamMembers")),
    // Política da IA no grupo (D6). A F1 gravou; a F4 lê e acrescentou os
    // campos de gatilho por palavra-chave, alerta, radar e digest.
    ai: v.optional(
      v.object({
        mode: v.union(v.literal("off"), v.literal("mention")),
        replyMode: v.union(
          v.literal("inherit"),
          v.literal("suggest"),
          v.literal("autopilot")
        ),
        maxPerHour: v.optional(v.number()),
        maxPerDay: v.optional(v.number()),
        extraInstructions: v.optional(v.string()),
        // F4 — gatilho EXTRA do agente (além de menção/citação): a mensagem que
        // contiver uma destas palavras chama a IA. Vazio/ausente = só menção.
        keywords: v.optional(v.array(v.string())),
        // F4 — alerta SEM LLM: palavra que gera notificação `group_mention`
        // para o time (ex.: "reclamação", "cancelar"). Não aciona a IA.
        alertKeywords: v.optional(v.array(v.string())),
        // F4 — radar de oportunidade (§9.3). Default OFF: classifica mensagem
        // de membro em lote de 15 min e sugere criar lead.
        opportunityRadar: v.optional(v.boolean()),
        // F4 — digest diário "HH:MM" no fuso da org. Ausente = sem digest.
        dailyDigestAt: v.optional(v.string()),
        // Quando o ÚLTIMO digest saiu. Campo próprio de propósito: a
        // idempotência do cron horário olhava `summary.at`, o mesmo campo que
        // o "Resumo por IA" manual grava — pedir um resumo à tarde cancelava o
        // digest daquele dia (achado menor do review de correção).
        lastDigestAt: v.optional(v.number()),
      })
    ),
    summary: v.optional(
      v.object({
        text: v.string(),
        at: v.number(),
        model: v.optional(v.string()),
        // Janela resumida (24 = 1 dia, 168 = 7 dias) — a UI mostra "das últimas
        // 24 h" sem precisar guardar a escolha em outro lugar.
        hours: v.optional(v.number()),
      })
    ),
    // F4 — estado do radar de oportunidade. `scheduledFor` é o coalescing: com
    // um lote já agendado, mensagem nova não agenda outro (uma chamada por
    // janela de 15 min por grupo, não uma por mensagem).
    radar: v.optional(
      v.object({
        scheduledFor: v.optional(v.number()),
        lastRunAt: v.optional(v.number()),
      })
    ),
    leftAt: v.optional(v.number()),
    removedAt: v.optional(v.number()), // sumiu do /group/list
    lastSyncAt: v.optional(v.number()),
    lastMessageAt: v.optional(v.number()),
    // Eventos do grupo (join/leave/promote/rename) — `activities` exige leadId,
    // então a linha do tempo da sala mora aqui (cap 100, FIFO).
    timeline: v.optional(
      v.array(
        v.object({
          at: v.number(),
          type: v.string(),
          actorJid: v.optional(v.string()),
          data: v.optional(v.string()),
        })
      )
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_channel_config", ["channelConfigId"])
    .index("by_channel_config_and_jid", ["channelConfigId", "jid"])
    .index("by_organization_and_monitored", ["organizationId", "monitored"])
    .index("by_conversation", ["conversationId"]),

  /**
   * Publicações programadas em grupos (v0.57, F3 — D7/D8 do plano).
   *
   * Uma linha = uma rotina de postagem ("seg/qua/sex às 09h, uma dica da
   * biblioteca em sequência", "todo dia 12h a mensagem do dia pela IA, com
   * aprovação"). O worker (`groupPostWorker.tick`) é um job auto-reagendado
   * por publicação com `tickToken` anti-zumbi.
   *
   * `channelConfigId` é DENORMALIZADO dos targets porque todos os grupos de uma
   * publicação são do mesmo canal (v1) e porque o worker consulta canal, sessão
   * e tetos antes de olhar grupo nenhum.
   */
  groupPosts: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    status: v.union(
      v.literal("draft"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("ended")
    ),
    channelConfigId: v.id("channelConfigs"),
    targets: v.array(
      v.object({
        groupChatId: v.id("groupChats"),
        /**
         * Desde quando este destino aparece inválido (grupo desmonitorado,
         * saímos dele, apagado). O destino só SAI da publicação depois de
         * `TARGET_GRACE_MS` assim — remover na primeira ocorrência apagava a
         * escolha do operador por um blip, e restaurar o grupo não a trazia
         * de volta.
         */
        missingSince: v.optional(v.number()),
      })
    ),
    schedule: groupPostScheduleValidator,
    content: groupPostContentValidator,
    pending: v.optional(groupPostPendingValidator),
    stats: v.object({
      sent: v.number(), // slots disparados com sucesso em pelo menos um grupo
      skipped: v.number(),
      failed: v.number(),
      lastSentAt: v.optional(v.number()),
      lastError: v.optional(v.string()),
    }),
    timeline: v.optional(v.array(groupPostTimelineValidator)), // cap 100 (FIFO)
    /**
     * Último slot JÁ resolvido (`lib/groupPostSchedule.slotKey`). É a
     * idempotência do disparo: dois ticks para o mesmo horário (retry, zumbi,
     * watchdog) só postam uma vez.
     */
    lastSlotKey: v.optional(v.string()),
    // Estado do worker (mesmo trio das campanhas)
    schedulerFnId: v.optional(v.string()),
    tickToken: v.optional(v.string()),
    nextRunAt: v.optional(v.number()), // instante do PRÓXIMO disparo (com jitter)
    /**
     * Chave do slot-BASE que originou o `nextRunAt` acima, gravada por quem
     * agenda (`nextRun`). Deduzir a chave do instante jitterado dava a chave
     * errada quando dois horários ficam a menos de `jitterMinutes` um do
     * outro, e a idempotência engolia o segundo disparo do dia.
     */
    nextSlotKey: v.optional(v.string()),
    /**
     * Ticks seguidos que encontraram o canal em estado TRANSITÓRIO (sessão
     * "disconnected", que uma única checagem de saúde com timeout já grava).
     * O tick adia com backoff e só pausa depois de esgotar as tentativas —
     * antes disso um blip de 1 minuto matava uma agenda que vive meses.
     * Zerado assim que o canal responde.
     */
    channelRetries: v.optional(v.number()),
    pausedReason: v.optional(v.string()),
    pausedBy: v.optional(v.id("teamMembers")),
    createdBy: v.id("teamMembers"),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_status", ["organizationId", "status"])
    .index("by_channel_config", ["channelConfigId"])
    // Watchdog (cron horário), DEPLOYMENT-WIDE de propósito: a pergunta é
    // "alguma publicação ativa perdeu o agendamento?", que não é de uma org.
    .index("by_status_and_next_run", ["status", "nextRunAt"]),

  // Mensagens agendadas do inbox — entregues via ctx.scheduler.runAt.
  scheduledMessages: defineTable({
    organizationId: v.id("organizations"),
    conversationId: v.id("conversations"),
    content: v.string(),
    scheduledAt: v.number(),
    // Sala de GRUPO: JIDs mencionados, guardados junto do texto. Sem isto, o
    // "@fulano" escrito no compositor sobrevivia como texto mas não notificava
    // ninguém na entrega (achado menor do review de correção).
    mentions: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("canceled"),
      v.literal("failed")
    ),
    createdBy: v.id("teamMembers"),
    scheduledFunctionId: v.optional(v.string()), // id do runAt, para cancelar
    sentMessageId: v.optional(v.id("messages")),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_conversation_and_status", ["conversationId", "status"])
    .index("by_organization", ["organizationId"]),

  // Respostas rápidas do inbox — inseridas digitando "/" no composer.
  quickReplies: defineTable({
    organizationId: v.id("organizations"),
    shortcut: v.string(), // sem a barra, ex. "saudacao"
    content: v.string(),
    createdBy: v.id("teamMembers"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_shortcut", ["organizationId", "shortcut"]),

  // Handoffs
  handoffs: defineTable({
    organizationId: v.id("organizations"),
    // OPCIONAL desde a v0.57: repasse vindo de uma conversa de grupo não tem
    // lead (a sala não é um lead). O card mostra o nome do grupo.
    leadId: v.optional(v.id("leads")),
    // Conversa de origem do repasse — resolvida na criação (fallback: conversa
    // mais recente não arquivada do lead). Repasses antigos não têm o campo.
    conversationId: v.optional(v.id("conversations")),
    // Título do card quando NÃO há lead (repasse de grupo): o nome da sala,
    // congelado na criação. Sem isto o card de /app/repasses sai anônimo — o
    // nome está em `groupChats.subject`, a dois saltos de `enrichHandoffs`.
    subjectLabel: v.optional(v.string()),
    fromMemberId: v.id("teamMembers"),
    toMemberId: v.optional(v.id("teamMembers")),
    reason: v.string(),
    summary: v.optional(v.string()),
    suggestedActions: v.array(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("rejected"),
      v.literal("canceled")
    ),
    acceptedBy: v.optional(v.id("teamMembers")),
    resolvedBy: v.optional(v.id("teamMembers")),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_organization", ["organizationId"])
    .index("by_lead", ["leadId"])
    .index("by_status", ["status"])
    .index("by_organization_and_status", ["organizationId", "status"])
    // Repasse SEM lead (grupo) não tem `lead.handoffState` para segurar a
    // duplicata, e a elegibilidade do agente de grupo precisa saber se a sala
    // já foi escalada. Os dois faziam `.take(100)` no índice por org — numa org
    // com mais de 100 pendentes, o repasse da sala ficava fora da varredura.
    .index("by_conversation_and_status", ["conversationId", "status"])
    .index("by_status_and_created", ["status", "createdAt"]),

  // Activities (timeline events on leads)
  activities: defineTable({
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    type: v.union(
      v.literal("note"), v.literal("call"), v.literal("email_sent"),
      v.literal("stage_change"), v.literal("assignment"),
      v.literal("handoff"), v.literal("qualification_update"),
      v.literal("created"), v.literal("message_sent"),
      v.literal("message_received"),
      v.literal("task_created"), v.literal("task_completed"),
      v.literal("event_created"), v.literal("event_completed")
    ),
    actorId: v.optional(v.id("teamMembers")),
    actorType: v.union(v.literal("human"), v.literal("ai"), v.literal("system")),
    content: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.any())),
    createdAt: v.number(),
  })
    .index("by_lead", ["leadId"])
    .index("by_organization", ["organizationId"])
    .index("by_lead_and_created", ["leadId", "createdAt"])
    .index("by_organization_and_created", ["organizationId", "createdAt"]),

  // Audit Logs
  auditLogs: defineTable({
    organizationId: v.id("organizations"),
    entityType: v.string(),
    entityId: v.string(),
    action: v.union(
      v.literal("create"),
      v.literal("update"),
      v.literal("delete"),
      v.literal("move"),
      v.literal("assign"),
      v.literal("handoff")
    ),
    actorId: v.optional(v.id("teamMembers")),
    actorType: v.union(v.literal("human"), v.literal("ai"), v.literal("system")),
    changes: v.optional(v.object({
      before: v.optional(v.record(v.string(), v.any())),
      after: v.optional(v.record(v.string(), v.any())),
    })),
    metadata: v.optional(v.record(v.string(), v.any())),
    description: v.optional(v.string()),
    severity: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("critical")),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_entity", ["entityType", "entityId"])
    .index("by_actor", ["actorId"])
    .index("by_organization_and_created", ["organizationId", "createdAt"])
    .index("by_severity", ["severity"])
    .index("by_organization_and_actor", ["organizationId", "actorId"])
    .index("by_organization_and_entity_type_and_created", ["organizationId", "entityType", "createdAt"])
    .index("by_organization_and_action_and_created", ["organizationId", "action", "createdAt"])
    .index("by_organization_and_severity_and_created", ["organizationId", "severity", "createdAt"])
    .index("by_organization_and_actor_and_created", ["organizationId", "actorId", "createdAt"]),

  // Tasks & Reminders
  tasks: defineTable({
    organizationId: v.id("organizations"),

    // Core
    title: v.string(),
    description: v.optional(v.string()),
    type: v.union(v.literal("task"), v.literal("reminder")),
    status: v.union(v.literal("pending"), v.literal("in_progress"), v.literal("completed"), v.literal("cancelled")),
    priority: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent")),

    // Activity type (CRM context)
    activityType: v.optional(v.union(
      v.literal("todo"), v.literal("call"), v.literal("email"),
      v.literal("follow_up"), v.literal("meeting"), v.literal("research")
    )),

    // Time
    dueDate: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    snoozedUntil: v.optional(v.number()),

    // Relations (all optional — tasks work standalone or CRM-connected)
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    assignedTo: v.optional(v.id("teamMembers")),
    createdBy: v.id("teamMembers"),

    // Recurrence
    recurrence: v.optional(v.object({
      pattern: v.union(v.literal("daily"), v.literal("weekly"), v.literal("biweekly"), v.literal("monthly")),
      endDate: v.optional(v.number()),
      lastGeneratedAt: v.optional(v.number()),
    })),
    // Subtask hierarchy (parent of THIS task). Historically this held recurrence
    // lineage; that moved to recurrenceSourceId (see migrateTasksP1).
    parentTaskId: v.optional(v.id("tasks")),
    // Previous instance in a recurrence chain (lineage only, not hierarchy)
    recurrenceSourceId: v.optional(v.id("tasks")),

    // Projects & Kanban (P1)
    projectId: v.optional(v.id("taskProjects")),
    columnId: v.optional(v.id("taskColumns")),
    order: v.optional(v.number()),

    // Labels with color (P1) — legacy free-form `tags` kept below
    labelIds: v.optional(v.array(v.id("taskLabels"))),

    // Multi-assignee (P1). `assignedTo` stays as the primary assignee mirror
    // (= assigneeIds[0]) so existing indexes/API/MCP keep working.
    assigneeIds: v.optional(v.array(v.id("teamMembers"))),

    // Dependencies (P1) — informational, completion is not blocked server-side
    blockedBy: v.optional(v.array(v.id("tasks"))),

    // Relative reminder (P1): fire N minutes before dueDate
    reminderMinutesBefore: v.optional(v.number()),
    preDueReminderSentAt: v.optional(v.number()),

    // Checklist (embedded subtasks)
    checklist: v.optional(v.array(v.object({
      id: v.string(),
      title: v.string(),
      completed: v.boolean(),
    }))),

    // Reminder engine
    reminderTriggered: v.optional(v.boolean()),

    // Metadata
    tags: v.optional(v.array(v.string())),
    searchText: v.optional(v.string()),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_status", ["organizationId", "status"])
    .index("by_organization_and_assigned", ["organizationId", "assignedTo"])
    .index("by_organization_and_due_date", ["organizationId", "dueDate"])
    .index("by_organization_and_type", ["organizationId", "type"])
    .index("by_organization_and_assigned_and_status", ["organizationId", "assignedTo", "status"])
    .index("by_lead", ["leadId"])
    .index("by_contact", ["contactId"])
    .index("by_assigned_to", ["assignedTo"])
    .index("by_parent_task", ["parentTaskId"])
    .index("by_recurrence_source", ["recurrenceSourceId"])
    .index("by_organization_and_project", ["organizationId", "projectId"])
    .index("by_column", ["columnId"])
    .index("by_column_and_order", ["columnId", "order"])
    .index("by_project_and_status", ["projectId", "status"])
    .searchIndex("search_tasks", { searchField: "searchText", filterFields: ["organizationId"] }),

  // Task Comments
  taskComments: defineTable({
    organizationId: v.id("organizations"),
    taskId: v.id("tasks"),
    authorId: v.id("teamMembers"),
    authorType: v.union(v.literal("human"), v.literal("ai")),
    content: v.string(),
    mentionedUserIds: v.optional(v.array(v.id("teamMembers"))),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_task_and_created", ["taskId", "createdAt"])
    .index("by_organization", ["organizationId"]),

  // Task Projects (P1) — listas/projetos de tarefas, um nível, sem hierarquia
  taskProjects: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    color: v.optional(v.string()),
    order: v.number(),
    archivedAt: v.optional(v.number()),
    createdBy: v.id("teamMembers"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  // Task Columns (P1) — colunas do kanban, por projeto
  taskColumns: defineTable({
    organizationId: v.id("organizations"),
    projectId: v.id("taskProjects"),
    name: v.string(),
    order: v.number(),
    color: v.optional(v.string()),
    isDoneColumn: v.optional(v.boolean()),
    wipLimit: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_and_order", ["projectId", "order"])
    .index("by_organization", ["organizationId"]),

  // Task Labels (P1) — labels org-wide com cor (tasks.labelIds)
  taskLabels: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    color: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  // In-app Notifications (P1) — sino no AppShell
  notifications: defineTable({
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"),
    type: v.union(
      v.literal("task_assigned"),
      v.literal("task_comment_mention"),
      v.literal("task_due_soon"),
      v.literal("task_overdue"),
      v.literal("handoff_requested"),
      v.literal("handoff_resolved"),
      v.literal("ai_draft_pending"),
      v.literal("campaign_completed"),
      v.literal("campaign_paused"),
      // Grupos (v0.57): entramos/fomos adicionados a um grupo (cadastrado com
      // monitored:false — quem decide acompanhar é uma pessoa).
      v.literal("group_joined"),
      // Alguém mencionou o NOSSO número numa conversa de grupo monitorada.
      v.literal("group_mention"),
      // Publicações programadas (F3): texto da IA esperando aprovação / a
      // publicação parou sozinha (canal caído, grupo perdido, LLM falhou).
      v.literal("group_post_pending"),
      v.literal("group_post_failed"),
      // F4 — o radar classificou a mensagem de um membro como oportunidade.
      // Carrega `groupChatId` + `data.participantKey`/`data.suggestedDm`: o
      // botão do sino cria o lead e abre a conversa 1:1 com um rascunho. A IA
      // NUNCA manda a DM sozinha (D3 + risco de ban).
      v.literal("group_opportunity"),
      // F4 — digest diário do grupo (resumo + perguntas sem resposta).
      v.literal("group_digest")
    ),
    title: v.string(),
    body: v.optional(v.string()),
    // Ponteiros opcionais para a entidade de origem — a UI usa o que existir
    // para montar o deep-link do item do sino.
    taskId: v.optional(v.id("tasks")),
    handoffId: v.optional(v.id("handoffs")),
    conversationId: v.optional(v.id("conversations")),
    campaignId: v.optional(v.id("campaigns")),
    groupPostId: v.optional(v.id("groupPosts")),
    groupChatId: v.optional(v.id("groupChats")),
    // Carga extra do item do sino (F4): `participantKey` e `suggestedDm` da
    // oportunidade, `hours` do digest. Nunca é instrução — é só o que o botão
    // da notificação precisa para agir.
    data: v.optional(v.record(v.string(), v.any())),
    actorId: v.optional(v.id("teamMembers")),
    readAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_member_and_created", ["memberId", "createdAt"])
    .index("by_member_and_read", ["memberId", "readAt"])
    .index("by_organization", ["organizationId"]),

  // Calendar Events
  calendarEvents: defineTable({
    organizationId: v.id("organizations"),
    title: v.string(),
    description: v.optional(v.string()),
    eventType: v.union(
      v.literal("call"), v.literal("meeting"), v.literal("follow_up"),
      v.literal("demo"), v.literal("task"), v.literal("reminder"), v.literal("other")
    ),
    startTime: v.number(),
    endTime: v.number(),
    allDay: v.boolean(),
    status: v.union(v.literal("scheduled"), v.literal("completed"), v.literal("cancelled")),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    taskId: v.optional(v.id("tasks")),
    attendees: v.optional(v.array(v.id("teamMembers"))),
    createdBy: v.id("teamMembers"),
    assignedTo: v.optional(v.id("teamMembers")),
    location: v.optional(v.string()),
    meetingUrl: v.optional(v.string()),
    color: v.optional(v.string()),
    recurrence: v.optional(v.object({
      pattern: v.union(v.literal("daily"), v.literal("weekly"), v.literal("biweekly"), v.literal("monthly")),
      endDate: v.optional(v.number()),
      lastGeneratedAt: v.optional(v.number()),
    })),
    parentEventId: v.optional(v.id("calendarEvents")),
    notes: v.optional(v.string()),
    searchText: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_start", ["organizationId", "startTime"])
    .index("by_organization_and_assigned", ["organizationId", "assignedTo"])
    .index("by_organization_and_type", ["organizationId", "eventType"])
    .index("by_organization_and_status", ["organizationId", "status"])
    .index("by_lead", ["leadId"])
    .index("by_contact", ["contactId"])
    .index("by_task", ["taskId"])
    .index("by_parent_event", ["parentEventId"])
    .searchIndex("search_events", { searchField: "searchText", filterFields: ["organizationId"] }),

  // Saved Views
  savedViews: defineTable({
    organizationId: v.id("organizations"),
    createdBy: v.id("teamMembers"),
    name: v.string(),
    entityType: v.union(v.literal("leads"), v.literal("contacts"), v.literal("tasks")),
    isShared: v.boolean(),
    filters: savedViewFiltersValidator,
    sortBy: v.optional(v.string()),
    sortOrder: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
    columns: v.optional(v.array(v.string())),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_entity", ["organizationId", "entityType"]),

  // Onboarding Progress
  onboardingProgress: defineTable({
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    wizardCompleted: v.boolean(),
    wizardCurrentStep: v.number(),
    wizardData: v.optional(v.any()),
    checklistDismissed: v.boolean(),
    seenSpotlights: v.array(v.string()),
    celebratedMilestones: v.array(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_member", ["organizationId", "teamMemberId"]),

  // Notification Preferences (opt-out model: no row = all enabled)
  notificationPreferences: defineTable({
    organizationId: v.id("organizations"),
    teamMemberId: v.id("teamMembers"),
    invite: v.boolean(),
    handoffRequested: v.boolean(),
    handoffResolved: v.boolean(),
    taskOverdue: v.boolean(),
    taskAssigned: v.boolean(),
    leadAssigned: v.boolean(),
    newMessage: v.boolean(),
    dailyDigest: v.boolean(),
    // P1 — opcionais (linhas existentes continuam válidas; ausente = habilitado)
    taskCommentMention: v.optional(v.boolean()),
    taskDueSoon: v.optional(v.boolean()),
    // P2 — rascunho da IA aguardando revisão (sino)
    aiDraftPending: v.optional(v.boolean()),
    // Campanhas — concluída / pausada por kill switch
    campaignCompleted: v.optional(v.boolean()),
    campaignPaused: v.optional(v.boolean()),
    // Grupos (v0.57) — entrada em grupo novo / menção ao nosso número
    groupJoined: v.optional(v.boolean()),
    groupMention: v.optional(v.boolean()),
    // Publicações programadas (F3) — aprovação pendente / publicação parada
    groupPostPending: v.optional(v.boolean()),
    groupPostFailed: v.optional(v.boolean()),
    // IA em grupos (F4) — oportunidade detectada / digest diário
    groupOpportunity: v.optional(v.boolean()),
    groupDigest: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_member", ["organizationId", "teamMemberId"])
    .index("by_member", ["teamMemberId"]),

  // Forms (embeddable lead capture)
  forms: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    slug: v.string(),
    description: v.optional(v.string()),
    status: v.union(v.literal("draft"), v.literal("published"), v.literal("archived")),
    publishedAt: v.optional(v.number()),

    // Fields — embedded array (atomic reorder via single patch)
    fields: v.array(v.object({
      id: v.string(),
      type: v.union(
        v.literal("text"), v.literal("email"), v.literal("phone"),
        v.literal("number"), v.literal("select"), v.literal("textarea"),
        v.literal("checkbox"), v.literal("date"),
        // Phase 2 field types
        v.literal("radio"), v.literal("url"), v.literal("hidden"),
        v.literal("heading"), v.literal("divider"), v.literal("rating")
      ),
      label: v.string(),
      placeholder: v.optional(v.string()),
      helpText: v.optional(v.string()),
      isRequired: v.boolean(),
      validation: v.optional(v.object({
        minLength: v.optional(v.number()),
        maxLength: v.optional(v.number()),
        min: v.optional(v.number()),
        max: v.optional(v.number()),
        pattern: v.optional(v.string()),
      })),
      options: v.optional(v.array(v.string())),
      defaultValue: v.optional(v.string()),
      width: v.optional(v.union(v.literal("full"), v.literal("half"))),
      crmMapping: v.optional(v.object({
        entity: v.union(v.literal("lead"), v.literal("contact")),
        field: v.string(),
      })),
      // Phase 3: Conditional logic
      conditionalLogic: v.optional(v.object({
        action: v.union(v.literal("show"), v.literal("hide")),
        logic: v.union(v.literal("all"), v.literal("any")),
        conditions: v.array(v.object({
          fieldId: v.string(),
          operator: v.union(
            v.literal("equals"), v.literal("not_equals"),
            v.literal("contains"), v.literal("not_contains"),
            v.literal("is_empty"), v.literal("is_not_empty"),
            v.literal("greater_than"), v.literal("less_than")
          ),
          value: v.optional(v.string()),
        })),
      })),
    })),

    // Theme
    theme: v.object({
      primaryColor: v.string(),
      backgroundColor: v.string(),
      textColor: v.string(),
      borderRadius: v.union(v.literal("none"), v.literal("sm"), v.literal("md"), v.literal("lg"), v.literal("full")),
      showBranding: v.boolean(),
    }),

    // Phase 4: Multi-step form grouping
    steps: v.optional(v.array(v.object({
      id: v.string(),
      title: v.string(),
      description: v.optional(v.string()),
      fieldIds: v.array(v.string()),
    }))),

    // Settings
    settings: v.object({
      submitButtonText: v.string(),
      successMessage: v.string(),
      redirectUrl: v.optional(v.string()),
      notifyOnSubmission: v.boolean(),
      notifyMemberIds: v.optional(v.array(v.id("teamMembers"))),
      leadTitle: v.string(),
      boardId: v.optional(v.id("boards")),
      stageId: v.optional(v.id("stages")),
      sourceId: v.optional(v.id("leadSources")),
      assignedTo: v.optional(v.id("teamMembers")),
      assignmentMode: v.union(v.literal("specific"), v.literal("round_robin"), v.literal("none")),
      defaultPriority: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("urgent")),
      defaultTemperature: v.union(v.literal("cold"), v.literal("warm"), v.literal("hot")),
      tags: v.array(v.string()),
      honeypotEnabled: v.boolean(),
      submissionLimit: v.optional(v.number()),
      // Phase 7: Custom thank you page
      successTitle: v.optional(v.string()),
      successSubtitle: v.optional(v.string()),
      successCta: v.optional(v.object({
        label: v.string(),
        url: v.string(),
      })),
      // Phase 7: Confirmation email
      confirmationEmail: v.optional(v.object({
        enabled: v.boolean(),
        subject: v.optional(v.string()),
        body: v.optional(v.string()),
        replyTo: v.optional(v.string()),
      })),
      // Partial submission capture
      partialCaptureEnabled: v.optional(v.boolean()),
    }),

    // Metadata
    createdBy: v.id("teamMembers"),
    submissionCount: v.number(),
    lastSubmissionAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_status", ["organizationId", "status"])
    .index("by_slug", ["slug"])
    .index("by_organization_and_slug", ["organizationId", "slug"]),

  // Form Submissions
  formSubmissions: defineTable({
    organizationId: v.id("organizations"),
    formId: v.id("forms"),
    data: v.record(v.string(), v.any()),
    leadId: v.optional(v.id("leads")),
    contactId: v.optional(v.id("contacts")),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    referrer: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    utmTerm: v.optional(v.string()),
    honeypotTriggered: v.boolean(),
    processingStatus: v.union(v.literal("processed"), v.literal("spam"), v.literal("error")),
    errorMessage: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    experimentId: v.optional(v.id("formExperiments")),
    variantId: v.optional(v.id("formExperimentVariants")),
    visitorId: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_form", ["formId"])
    .index("by_form_and_created", ["formId", "createdAt"])
    .index("by_form_and_status", ["formId", "processingStatus"])
    .index("by_organization_and_created", ["organizationId", "createdAt"]),

  // Form Partials (partial submission recovery)
  formPartials: defineTable({
    organizationId: v.id("organizations"),
    formId: v.id("forms"),
    sessionId: v.string(),
    status: v.union(v.literal("in_progress"), v.literal("abandoned"), v.literal("converted")),
    data: v.record(v.string(), v.any()),
    currentStep: v.optional(v.number()),
    completedFieldIds: v.array(v.string()),
    totalFields: v.number(),
    completionPercent: v.number(),
    ipAddress: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    referrer: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    utmTerm: v.optional(v.string()),
    experimentId: v.optional(v.id("formExperiments")),
    variantId: v.optional(v.id("formExperimentVariants")),
    visitorId: v.optional(v.string()),
    firstInteractionAt: v.number(),
    lastActivityAt: v.number(),
    convertedAt: v.optional(v.number()),
    submissionId: v.optional(v.id("formSubmissions")),
    createdAt: v.number(),
  })
    .index("by_form", ["formId"])
    .index("by_form_and_session", ["formId", "sessionId"])
    .index("by_form_and_status", ["formId", "status"])
    .index("by_status_and_activity", ["status", "lastActivityAt"])
    .index("by_organization_and_created", ["organizationId", "createdAt"]),

  // Form A/B Testing Experiments
  formExperiments: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    formId: v.id("forms"),
    hypothesis: v.optional(v.string()),
    status: v.union(v.literal("draft"), v.literal("running"), v.literal("paused"), v.literal("concluded")),
    winnerVariantId: v.optional(v.string()),
    concludedAt: v.optional(v.number()),
    concludedBy: v.optional(v.id("teamMembers")),
    createdBy: v.id("teamMembers"),
    startedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_form", ["formId"])
    .index("by_organization_and_status", ["organizationId", "status"]),

  // Form Experiment Variants
  formExperimentVariants: defineTable({
    organizationId: v.id("organizations"),
    experimentId: v.id("formExperiments"),
    formId: v.id("forms"),
    name: v.string(),
    variantKey: v.string(),
    trafficWeight: v.number(),
    views: v.number(),
    conversions: v.number(),
    isControl: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_experiment", ["experimentId"])
    .index("by_form", ["formId"])
    .index("by_organization", ["organizationId"]),

  // Webhooks
  webhooks: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    url: v.string(),
    events: v.array(v.string()),
    secret: v.string(),
    isActive: v.boolean(),
    lastTriggered: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  // File Storage
  files: defineTable({
    organizationId: v.id("organizations"),
    storageId: v.string(),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
    fileType: v.union(
      v.literal("message_attachment"),
      v.literal("contact_photo"),
      v.literal("member_avatar"),
      v.literal("lead_document"),
      v.literal("import_file"),
      v.literal("other")
    ),

    // Relations (all optional, at most one set)
    messageId: v.optional(v.id("messages")),
    contactId: v.optional(v.id("contacts")),
    leadId: v.optional(v.id("leads")),
    teamMemberId: v.optional(v.id("teamMembers")),

    uploadedBy: v.optional(v.id("teamMembers")), // absent for inbound media sent by contacts
    metadata: v.optional(v.record(v.string(), v.any())),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_type", ["organizationId", "fileType"])
    .index("by_message", ["messageId"])
    .index("by_contact", ["contactId"])
    .index("by_lead", ["leadId"])
    .index("by_storage_id", ["storageId"]),

  // ── AI Agent Config: tabelas do runtime ──

  // Registro de operações de IA (LGPD art. 37) SEM transcrições/PII — só
  // tokens, custo, nomes de tools e ponteiros. A conversa em si já vive em
  // messages/copilotMessages; não duplicamos conteúdo aqui.
  agentRuns: defineTable({
    organizationId: v.id("organizations"),
    // Atendente: o teamMember IA. Copiloto: o teamMember HUMANO que comandou.
    memberId: v.id("teamMembers"),
    kind: v.union(
      v.literal("copilot"),
      v.literal("attendant"),
      v.literal("simulator"),
      // Passe de visão (convex/vision.ts): 1 chamada por IMAGEM, não por turno.
      v.literal("vision"),
      // Geração da "mensagem do dia" de uma publicação programada em grupo.
      v.literal("group_post"),
      // F4 — turno do agente DENTRO de um grupo (respondeu a uma menção).
      v.literal("group_reply"),
      // F4 — classificação barata de oportunidade num lote de mensagens.
      v.literal("group_radar"),
      // F4 — resumo/digest de um grupo (sob demanda ou diário).
      v.literal("group_summary")
    ),
    status: v.union(
      v.literal("running"),
      v.literal("done"),
      v.literal("error"),
      v.literal("aborted")
    ),
    conversationId: v.optional(v.id("conversations")),
    leadId: v.optional(v.id("leads")),
    triggerMessageId: v.optional(v.id("messages")),
    threadId: v.optional(v.id("copilotThreads")),
    // Run iniciada por humano (coach/return_to_ai): fica FORA das métricas de
    // aceitação — rascunho ditado pelo time não mede "a IA sozinha acerta?".
    humanInitiated: v.optional(v.boolean()),
    provider: v.optional(v.string()), // provider efetivo (ex. "opencode-go")
    model: v.optional(v.string()), // id canônico do modelo
    requestCount: v.number(), // nº de chamadas /chat/completions na run
    toolCallNames: v.optional(v.array(v.string())), // só NOMES — nunca argumentos
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    cachedPromptTokens: v.optional(v.number()),
    costUsdEstimate: v.optional(v.number()),
    confidence: v.optional(v.number()),
    // Erro SANITIZADO (lib/llm/sanitize) — nunca contém keys/headers.
    error: v.optional(v.string()),
    resultMessageId: v.optional(v.id("messages")),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_organization_and_started", ["organizationId", "startedAt"])
    .index("by_conversation", ["conversationId"])
    .index("by_organization_and_kind_and_started", ["organizationId", "kind", "startedAt"]),

  // Fila de respostas do atendente. O gatilho de ingest ENFILEIRA aqui (nunca
  // runAfter(0) direto na inferência) — pacing por-org + debounce + backoff.
  aiReplyQueue: defineTable({
    organizationId: v.id("organizations"),
    conversationId: v.id("conversations"),
    triggerMessageId: v.id("messages"),
    agentMemberId: v.id("teamMembers"),
    status: v.union(
      v.literal("pending"),
      v.literal("processing"),
      v.literal("done"),
      v.literal("skipped"),
      v.literal("failed")
    ),
    attempts: v.number(),
    nextAttemptAt: v.number(), // slot de pacing/backoff (debounce incluído)
    // Teto da espera por ENRIQUECIMENTO DE MÍDIA (transcrição de áudio, passe
    // de visão, download em voo): setado no 1º requeue; estourado, a run
    // acontece com o marcador de indisponível.
    mediaWaitUntil: v.optional(v.number()),
    // LEGADO — teto da espera só de áudio, anterior ao mediaWaitUntil acima.
    // Mantido para as linhas em voo continuarem válidas sem migração; a leitura
    // é `mediaWaitUntil ?? transcriptWaitUntil ?? createdAt + teto`.
    transcriptWaitUntil: v.optional(v.number()),
    // Uma única mensagem de fallback por item em instabilidade (flag anti-spam).
    fallbackSentAt: v.optional(v.number()),
    // ── Loop de coaching (P2): itens INICIADOS POR HUMANO ──
    // `origin` ausente = fluxo normal (inbound do cliente). "coach" = humano
    // pediu/regenerou um rascunho (commit SEMPRE como sugestão); "return_to_ai"
    // = devolução da conversa à IA (respeita o modo do perfil). A instrução vive
    // no ITEM (contrato da run) e é copiada ao metadata do rascunho no commit.
    // "group_mention" (F4) = turno do AGENTE DE GRUPO: outro produto, outro
    // prompt, outras tools e tetos próprios do grupo. Compartilha a fila só
    // pelo que ela já resolve (debounce, coalescing, backoff).
    origin: v.optional(
      v.union(v.literal("coach"), v.literal("return_to_ai"), v.literal("group_mention"))
    ),
    instruction: v.optional(v.string()),
    instructedBy: v.optional(v.id("teamMembers")),
    // Rascunho que esta run substitui (regeneração) — vira status "revised".
    sourceDraftId: v.optional(v.id("messages")),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_conversation_and_status", ["conversationId", "status"])
    .index("by_organization_and_status", ["organizationId", "status"])
    .index("by_status_and_next_attempt", ["status", "nextAttemptAt"]),

  // Cursor de pacing de inferência por org (espelha o nextDispatchAt do WhatsApp,
  // mas em doc próprio para não contender no doc da organização).
  aiPacing: defineTable({
    organizationId: v.id("organizations"),
    nextInferenceAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  // Cursor de pacing de envio por NÚMERO WhatsApp (anti-burst, P2 v4.1). Doc
  // próprio (não um campo em channelConfigs) de propósito: um cursor quente no
  // doc do config re-executaria as queries da UI de Canais a cada envio e
  // ampliaria o conflito OCC de todo sendMessage.
  // ── Campanhas de WhatsApp (disparo em massa) — docs/CAMPANHAS-WHATSAPP-PLAN.md ──
  campaigns: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    description: v.optional(v.string()),
    status: campaignStatusValidator,
    channelConfigId: v.id("channelConfigs"),
    provider: v.union(v.literal("meta"), v.literal("bridge")), // denormalizado do canal
    content: v.object({
      kind: v.union(v.literal("text"), v.literal("template")),
      // texto/mídia (bridge, ou Meta dentro da janela de 24h). Várias variantes
      // = rotação anti-repetição; spintax {a|b} e {{vars}} dentro do texto.
      variants: v.array(campaignVariantValidator),
      contentType: v.optional(
        v.union(v.literal("text"), v.literal("image"), v.literal("file"), v.literal("audio"))
      ),
      template: v.optional(
        v.object({
          name: v.string(),
          language: v.string(),
          category: v.optional(v.string()),
          headerFileId: v.optional(v.id("files")),
          headerFormat: v.optional(v.string()), // IMAGE | VIDEO | DOCUMENT | TEXT
          bodyParams: v.optional(v.array(campaignTemplateParamValidator)),
          headerParams: v.optional(v.array(campaignTemplateParamValidator)),
          buttonParams: v.optional(v.array(campaignTemplateParamValidator)),
          bodyText: v.optional(v.string()), // cópia do body p/ preview e histórico
        })
      ),
    }),
    audience: v.object({
      // v0.57 (F5): "groups" = o destinatário é a SALA (1 por JID); "group_members"
      // = disparo 1 a 1 para os participantes das salas escolhidas (D15).
      source: v.union(
        v.literal("segment"),
        v.literal("import"),
        v.literal("manual"),
        v.literal("groups"),
        v.literal("group_members")
      ),
      filters: v.optional(campaignAudienceFiltersValidator),
      // Grupos escolhidos (groups/group_members). No público `manual` vindo da
      // seleção de membros carrega SÓ a origem, para o relatório por grupo.
      groupChatIds: v.optional(v.array(v.id("groupChats"))),
      memberFilters: v.optional(campaignMemberFiltersValidator),
      importFileId: v.optional(v.id("files")),
      // Onde criar o lead de um número NOVO (ausente = board default, 1º estágio)
      targetBoardId: v.optional(v.id("boards")),
      targetStageId: v.optional(v.id("stages")),
      targetTags: v.optional(v.array(v.string())),
      snapshotAt: v.optional(v.number()),
      total: v.optional(v.number()),
    }),
    schedule: campaignScheduleValidator,
    pacing: campaignPacingValidator,
    safeMode: v.boolean(), // false = override até o teto duro (exige "ENTENDO")
    overrideAck: v.optional(campaignAckValidator),
    safety: v.object({
      consentAck: v.optional(campaignAckValidator), // base legal para contatar a lista
      bridgeRiskAck: v.optional(campaignAckValidator), // API não-oficial pode banir
      newNumberRiskAck: v.optional(campaignAckValidator), // bridge lançado com número de < 3 dias (aviso, não trava)
      // D15: mensagem privada a quem não iniciou a conversa (membros de grupo)
      groupMembersDmAck: v.optional(campaignAckValidator),
      checkNumbersFirst: v.boolean(), // bridge: /user/check antes de enviar
      allowLinks: v.optional(v.boolean()), // bridge: permite link no 1º contato (default false)
      stopOnReplyRateBelow: v.optional(v.number()), // 0-1; ausente = desligado
      stopOnDeliveryRateBelow: v.optional(v.number()),
      minSampleForKillSwitch: v.optional(v.number()),
      maxConsecutiveFailures: v.optional(v.number()),
    }),
    stats: v.object({
      total: v.number(),
      pending: v.number(),
      queued: v.number(),
      sent: v.number(),
      delivered: v.number(),
      read: v.number(),
      replied: v.number(),
      failed: v.number(),
      skipped: v.number(),
      optedOut: v.number(),
      consecutiveFailures: v.number(),
      estimatedCostUsd: v.optional(v.number()),
      // Contador POR GRUPO DE ORIGEM (F5): é o teto de N membros/dia por grupo,
      // que o `capsExceeded` do canal não enxerga. Chave = Id<"groupChats">.
      // A quebra completa do relatório (entregues/lidas/respostas por grupo) é
      // calculada varrendo `campaignRecipients` — aqui fica só o que o worker
      // precisa ler a cada envio.
      byGroup: v.optional(
        v.record(
          v.string(),
          v.object({
            sent: v.number(),
            sentToday: v.number(),
            sentTodayKey: v.string(), // dia UTC, mesma convenção de channelPacing
          })
        )
      ),
    }),
    // Timeline de eventos da campanha (lançada, pausada, retomada…). Cap 100.
    timeline: v.optional(
      v.array(
        v.object({
          at: v.number(),
          kind: v.string(),
          detail: v.optional(v.string()),
          actorId: v.optional(v.id("teamMembers")),
        })
      )
    ),
    pausedReason: v.optional(v.string()),
    pausedBy: v.optional(v.id("teamMembers")),
    lastError: v.optional(v.string()),
    tierAtLaunch: v.optional(v.string()),
    templateQualityAtLaunch: v.optional(v.string()),
    // Estado do worker
    schedulerFnId: v.optional(v.string()),
    nextTickAt: v.optional(v.number()),
    tickToken: v.optional(v.string()), // idempotência: tick com token diferente sai
    batchSentSinceLastPause: v.optional(v.number()),
    snapshotOffset: v.optional(v.number()), // snapshot em lotes (segmento)
    createdBy: v.id("teamMembers"),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_status", ["organizationId", "status"])
    .index("by_channel_config", ["channelConfigId"]),

  // Destinatários materializados no lançamento (snapshot). Um por telefone.
  campaignRecipients: defineTable({
    organizationId: v.id("organizations"),
    campaignId: v.id("campaigns"),
    // E.164 sem "+" (lib/phone.ts) para uma pessoa. Quando o destinatário é uma
    // SALA (`groupChatId` preenchido) guarda o JID INTEIRO ("120…@g.us"): com o
    // "@" ele nunca colide com um telefone real na supressão nem no índice
    // `by_organization_and_phone`, e é literalmente o que vai no `Phone` do envio.
    phone: v.string(),
    displayName: v.optional(v.string()),
    // Destinatário = a sala (public "groups").
    groupChatId: v.optional(v.id("groupChats")),
    // Destinatário = pessoa, mas veio da lista de membros desta sala
    // (public "group_members", ou seleção manual no painel de membros).
    sourceGroupChatId: v.optional(v.id("groupChats")),
    memberName: v.optional(v.string()), // PushName do membro; vira {{nome}} sem contato
    vars: v.optional(v.record(v.string(), v.string())), // {{placeholders}}
    contactId: v.optional(v.id("contacts")),
    leadId: v.optional(v.id("leads")),
    conversationId: v.optional(v.id("conversations")),
    messageId: v.optional(v.id("messages")),
    status: campaignRecipientStatusValidator,
    variantIndex: v.optional(v.number()),
    attempts: v.number(),
    scheduledFor: v.optional(v.number()), // retry 131049 (+24h)
    errorCode: v.optional(v.number()),
    lastError: v.optional(v.string()),
    skipReason: v.optional(v.string()),
    isNewContact: v.optional(v.boolean()), // número sem conversa prévia no envio
    sentAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    readAt: v.optional(v.number()),
    repliedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"]) // backup JSON pagina por aqui
    .index("by_campaign", ["campaignId"])
    .index("by_campaign_and_status", ["campaignId", "status"])
    // O worker escolhe o próximo pendente numa janela finita. Sem `scheduledFor`
    // no índice, a janela pegava os 50 PRIMEIROS por criação — e as linhas
    // futuras do primeiro grupo escondiam as linhas prontas de todos os outros.
    // (`undefined` ordena antes de qualquer número: quem não tem agendamento
    // é justamente quem está pronto agora.)
    .index("by_campaign_and_status_and_scheduled", ["campaignId", "status", "scheduledFor"])
    .index("by_campaign_and_phone", ["campaignId", "phone"])
    .index("by_message", ["messageId"])
    .index("by_conversation", ["conversationId"])
    .index("by_lead", ["leadId"])
    .index("by_organization_and_phone", ["organizationId", "phone"]),

  // Lista de supressão org-wide: NENHUMA campanha envia para quem está aqui.
  optOuts: defineTable({
    organizationId: v.id("organizations"),
    phone: v.string(),
    source: v.union(
      v.literal("keyword"),
      v.literal("meta_131050"),
      v.literal("manual"),
      v.literal("import")
    ),
    campaignId: v.optional(v.id("campaigns")),
    contactId: v.optional(v.id("contacts")),
    reason: v.optional(v.string()),
    createdBy: v.optional(v.id("teamMembers")),
    createdAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_phone", ["organizationId", "phone"]),

  // Cache dos templates da Meta por canal (sync sob demanda).
  whatsappTemplates: defineTable({
    organizationId: v.id("organizations"),
    channelConfigId: v.id("channelConfigs"),
    metaId: v.string(),
    name: v.string(),
    language: v.string(),
    category: v.string(), // MARKETING | UTILITY | AUTHENTICATION
    status: v.string(), // APPROVED | PENDING | REJECTED | PAUSED | DISABLED
    qualityScore: v.optional(v.string()), // GREEN | YELLOW | RED | UNKNOWN
    components: v.any(),
    syncedAt: v.number(),
  })
    .index("by_channel_config", ["channelConfigId"])
    .index("by_channel_config_and_name", ["channelConfigId", "name"])
    .index("by_organization", ["organizationId"]),

  channelPacing: defineTable({
    organizationId: v.id("organizations"),
    channelConfigId: v.id("channelConfigs"),
    nextDispatchAt: v.number(),
    // Métrica-only (SEM enforcement): envios do dia UTC, p/ calibrar um futuro
    // warm-up/cap de canal bridge com dados reais.
    dailyCount: v.optional(v.object({ day: v.string(), sent: v.number() })),
    // Campanhas (COM enforcement, ao contrário de dailyCount): contadores de
    // envios de campanha por dia UTC / por hora, e novos contatos (número sem
    // conversa prévia) por dia — base dos tetos de lib/campaignPacing.
    campaignDaily: v.optional(v.object({ day: v.string(), sent: v.number(), newContacts: v.number() })),
    campaignHourly: v.optional(v.object({ hour: v.string(), sent: v.number() })),
    // Congelamento do canal para CAMPANHAS (131048 / sessão bridge caída):
    // campanhas não disparam antes disto; o atendimento reativo segue. As
    // publicações programadas em grupo respeitam o MESMO congelamento.
    campaignFrozenUntil: v.optional(v.number()),
    // Publicações programadas em grupo (F3): SLOTS disparados no dia UTC, COM
    // enforcement (teto em lib/groupPostCore.MAX_POSTS_PER_CHANNEL_PER_DAY).
    // Um slot que posta em 5 grupos conta 1 — quem espaça as 5 mensagens é o
    // pacing normal do canal.
    groupPostDaily: v.optional(v.object({ day: v.string(), sent: v.number() })),
  }).index("by_channel_config", ["channelConfigId"]),

  // Segredos por-org (BYO API key de LLM), cifrados via lib/secretCrypto.
  // NUNCA retornar encryptedValue a clientes — masking via last4.
  orgSecrets: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(), // rótulo dado pelo admin
    purpose: v.union(v.literal("llm-api-key")),
    provider: v.optional(v.string()),
    encryptedValue: v.string(),
    last4: v.string(),
    createdBy: v.id("teamMembers"),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  // Ações destrutivas propostas pelo copiloto — two-phase server-side: a tool
  // grava a proposta; a execução real é uma mutation disparada por humano.
  pendingActions: defineTable({
    organizationId: v.id("organizations"),
    requestedBy: v.id("teamMembers"), // o humano dono da sessão do copiloto
    threadId: v.optional(v.id("copilotThreads")),
    tool: v.string(), // nome da tool destrutiva (ex. "deleteLead")
    args: v.record(v.string(), v.any()),
    preview: v.string(), // efeito em PT-BR ("Vou excluir o lead 'X'")
    status: v.union(
      v.literal("pending"),
      v.literal("executed"),
      v.literal("canceled"),
      v.literal("expired")
    ),
    expiresAt: v.number(), // TTL
    createdAt: v.number(),
    executedAt: v.optional(v.number()),
  }).index("by_organization_and_status", ["organizationId", "status"]),

  // Threads do copiloto (chat in-app por membro humano).
  copilotThreads: defineTable({
    organizationId: v.id("organizations"),
    memberId: v.id("teamMembers"), // dono humano — só ele lê/escreve
    title: v.optional(v.string()),
    // Continuação de run longa: estado serializado para re-scheduling (>8 min).
    pendingContinuation: v.optional(v.boolean()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_organization_and_member", ["organizationId", "memberId"]),

  // Mensagens do copiloto — histórico OpenAI-compatible re-hidratável.
  copilotMessages: defineTable({
    organizationId: v.id("organizations"),
    threadId: v.id("copilotThreads"),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("tool")
    ),
    content: v.string(),
    // tool_calls emitidas pelo assistant (arguments como JSON string, formato OpenAI).
    toolCalls: v.optional(
      v.array(v.object({ id: v.string(), name: v.string(), arguments: v.string() }))
    ),
    toolCallId: v.optional(v.string()), // para role:"tool"
    status: v.optional(
      v.union(v.literal("streaming"), v.literal("done"), v.literal("error"))
    ),
    agentRunId: v.optional(v.id("agentRuns")),
    createdAt: v.number(),
  }).index("by_thread_and_created", ["threadId", "createdAt"]),

  // Golden conversations para regressão de persona (F5).
  agentEvals: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    transcript: v.array(
      v.object({
        role: v.union(v.literal("customer"), v.literal("agent")),
        content: v.string(),
        // Turno que chegou como nota de voz: o content é a transcrição.
        audio: v.optional(v.boolean()),
        // Turno que chegou como imagem: o content é a descrição que a leitura
        // de imagens produziria.
        image: v.optional(v.boolean()),
        // Turno que chegou como arquivo (PDF/planilha): o content é o NOME —
        // é tudo o que a IA recebe de verdade.
        file: v.optional(v.boolean()),
      })
    ),
    expectation: v.string(),
    tags: v.optional(v.array(v.string())),
    createdBy: v.id("teamMembers"),
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  // Lead Documents (join table for lead ↔ document relationships)
  leadDocuments: defineTable({
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
    fileId: v.id("files"),
    title: v.optional(v.string()),
    category: v.optional(v.union(
      v.literal("contract"),
      v.literal("proposal"),
      v.literal("invoice"),
      v.literal("other")
    )),
    uploadedBy: v.id("teamMembers"),
    createdAt: v.number(),
  })
    .index("by_lead", ["leadId"])
    .index("by_organization", ["organizationId"]),

  // ===== Export / Import de dados =====

  exportJobs: defineTable({
    organizationId: v.id("organizations"),
    requestedBy: v.id("teamMembers"),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("completed"), v.literal("failed")),
    format: v.union(v.literal("csv"), v.literal("json")),
    scope: v.union(v.literal("entity"), v.literal("full_backup")),
    entity: v.optional(v.union(v.literal("contacts"), v.literal("leads"), v.literal("tasks"))), // obrigatório quando scope=entity
    columns: v.optional(v.array(v.string())),        // subconjunto de colunas p/ CSV (precedente: savedViews.columns)
    progress: v.object({ processed: v.number(), total: v.optional(v.number()), currentEntity: v.optional(v.string()) }),
    resultStorageId: v.optional(v.id("_storage")),
    resultFileName: v.optional(v.string()),
    resultSize: v.optional(v.number()),
    rowCount: v.optional(v.number()),
    error: v.optional(v.string()),
    expiresAt: v.number(),                            // createdAt + 7 dias; cron limpa o blob
    createdAt: v.number(), startedAt: v.optional(v.number()), finishedAt: v.optional(v.number()),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_status", ["organizationId", "status"])
    .index("by_status_and_expires", ["status", "expiresAt"]),

  importJobs: defineTable({
    organizationId: v.id("organizations"),
    requestedBy: v.id("teamMembers"),
    status: v.union(
      v.literal("mapping"),        // arquivo carregado, headers detectados, aguardando mapeamento
      v.literal("previewing"),     // dry-run rodando
      v.literal("preview_ready"),  // dry-run pronto, aguardando confirmação
      v.literal("running"),
      v.literal("completed"), v.literal("completed_with_errors"),
      v.literal("failed"), v.literal("rolled_back"), v.literal("canceled"),
    ),
    entity: v.union(v.literal("contacts"), v.literal("leads")),
    fileId: v.id("files"),                            // fileType: "import_file"
    fileName: v.string(),
    detectedHeaders: v.optional(v.array(v.string())),
    suggestedMapping: v.optional(v.record(v.string(), v.string())),
    mapping: v.optional(v.record(v.string(), v.string())), // header → campo | "cf:<key>" | "__ignore__"
    duplicateStrategy: v.union(v.literal("skip"), v.literal("update"), v.literal("create")),
    matchFields: v.optional(v.array(v.string())),     // default contatos: ["email","phone"]
    dryRun: v.optional(v.object({
      totalRows: v.number(), validRows: v.number(), errorRows: v.number(),
      newRows: v.number(), updateRows: v.number(), skipRows: v.number(),
      sampleErrors: v.array(v.object({ row: v.number(), field: v.optional(v.string()), message: v.string() })), // cap 50
      preview: v.array(v.record(v.string(), v.any())), // 10 primeiras linhas já mapeadas
    })),
    progress: v.object({
      processed: v.number(), total: v.number(),
      created: v.number(), updated: v.number(), skipped: v.number(), failed: v.number(),
    }),
    error: v.optional(v.string()),
    createdAt: v.number(), startedAt: v.optional(v.number()), finishedAt: v.optional(v.number()),
  })
    .index("by_organization", ["organizationId"])
    .index("by_organization_and_status", ["organizationId", "status"]),

  importJobBatches: defineTable({
    organizationId: v.id("organizations"),
    jobId: v.id("importJobs"),
    batchIndex: v.number(),
    createdIds: v.array(v.string()),                  // ids de contacts/leads criados neste lote
    updated: v.array(v.object({ id: v.string(), before: v.record(v.string(), v.any()) })), // só campos alterados
    errors: v.array(v.object({ row: v.number(), message: v.string() })),
    createdAt: v.number(),
  })
    .index("by_job", ["jobId"])
    .index("by_organization", ["organizationId"]),
};

export default defineSchema({
  ...authTables,
  ...applicationTables,
});
