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
  // Ordem da cadeia no modo "platform": auto (OpenCode Go → OpenRouter),
  // openrouter-first inverte o primário, *-only remove o fallback.
  platformOrder: v.optional(
    v.union(
      v.literal("auto"),
      v.literal("openrouter-first"),
      v.literal("opencode-only"),
      v.literal("openrouter-only")
    )
  ),
  // Aceite explícito registrado quando o admin escolhe uma rota não-ZDR sob zdr:true.
  nonZdrAck: v.optional(
    v.object({ acceptedAt: v.number(), acceptedBy: v.id("teamMembers"), route: v.string() })
  ),
  models: aiModelsValidator,
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
});

const applicationTables = {
  // Organizations
  organizations: defineTable({
    name: v.string(),
    slug: v.string(),
    settings: v.object({
      timezone: v.string(),
      currency: v.string(),
      aiConfig: v.optional(aiConfigValidator),
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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_phone_number_id", ["phoneNumberId"])
    .index("by_verify_token", ["verifyToken"])
    .index("by_bridge_instance", ["bridgeInstanceId"]),

  // Conversations
  conversations: defineTable({
    organizationId: v.id("organizations"),
    leadId: v.id("leads"),
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
    // Lock/lease OCC do turno de IA — evita resposta dupla de dois inbounds
    // concorrentes. Claims concorrentes leem+escrevem o mesmo doc → só uma commita.
    aiTurnLock: v.optional(v.object({ runId: v.string(), leaseUntil: v.number() })),
    // "Assumir conversa"/"Pausar IA" explícito: IA não responde até este timestamp
    // (Number.MAX_SAFE_INTEGER = pausa indefinida até reativar).
    aiPausedUntil: v.optional(v.number()),
    messageCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_organization", ["organizationId"])
    .index("by_lead", ["leadId"])
    .index("by_lead_and_channel", ["leadId", "channel"])
    .index("by_organization_and_status", ["organizationId", "status"]),

  // Messages
  messages: defineTable({
    organizationId: v.id("organizations"),
    conversationId: v.id("conversations"),
    leadId: v.id("leads"),
    direction: v.union(v.literal("inbound"), v.literal("outbound"), v.literal("internal")),
    senderId: v.optional(v.id("teamMembers")), // null for inbound from contact
    senderType: v.union(v.literal("contact"), v.literal("human"), v.literal("ai")),
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
    }),

  // Etiquetas de conversa (org-scoped), atribuídas via conversations.labelIds.
  conversationLabels: defineTable({
    organizationId: v.id("organizations"),
    name: v.string(),
    color: v.string(), // hex da paleta fixa do frontend
    createdAt: v.number(),
  }).index("by_organization", ["organizationId"]),

  // Mensagens agendadas do inbox — entregues via ctx.scheduler.runAt.
  scheduledMessages: defineTable({
    organizationId: v.id("organizations"),
    conversationId: v.id("conversations"),
    content: v.string(),
    scheduledAt: v.number(),
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
    leadId: v.id("leads"),
    fromMemberId: v.id("teamMembers"),
    toMemberId: v.optional(v.id("teamMembers")),
    reason: v.string(),
    summary: v.optional(v.string()),
    suggestedActions: v.array(v.string()),
    status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("rejected")),
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
      v.literal("task_overdue")
    ),
    title: v.string(),
    body: v.optional(v.string()),
    taskId: v.optional(v.id("tasks")),
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
    kind: v.union(v.literal("copilot"), v.literal("attendant"), v.literal("simulator")),
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
    // Teto da espera pela transcrição de áudio (D1): setado no 1º requeue por
    // transcrição; estourado, a run acontece com o marcador de indisponível.
    transcriptWaitUntil: v.optional(v.number()),
    // Uma única mensagem de fallback por item em instabilidade (flag anti-spam).
    fallbackSentAt: v.optional(v.number()),
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
  channelPacing: defineTable({
    organizationId: v.id("organizations"),
    channelConfigId: v.id("channelConfigs"),
    nextDispatchAt: v.number(),
    // Métrica-only (SEM enforcement): envios do dia UTC, p/ calibrar um futuro
    // warm-up/cap de canal bridge com dados reais.
    dailyCount: v.optional(v.object({ day: v.string(), sent: v.number() })),
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
};

export default defineSchema({
  ...authTables,
  ...applicationTables,
});
