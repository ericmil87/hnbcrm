// Single source of truth for all REST API endpoints
// Drives the playground forms, docs tables, and OpenAPI generation

export type ParamLocation = "query" | "body";

export interface ApiParam {
  name: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  location: ParamLocation;
  description: string;
  enumValues?: string[];
  default?: string;
  nested?: ApiParam[];
}

export interface ApiEndpoint {
  id: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  category: string;
  title: string;
  description: string;
  params: ApiParam[];
  responseExample: Record<string, unknown>;
}

export const API_CATEGORIES = [
  "Leads",
  "Contatos",
  "Conversas",
  "Handoffs",
  "Pipeline",
  "Atividades",
  "Dashboard",
  "Fontes",
  "Auditoria",
] as const;

export type ApiCategory = (typeof API_CATEGORIES)[number];

export const ALL_ENDPOINTS: ApiEndpoint[] = [
  // ---- Leads ----
  {
    id: "inbound-lead",
    method: "POST",
    path: "/api/v1/inbound/lead",
    category: "Leads",
    title: "Criar Lead (Inbound)",
    description: "Cria um lead com contato e mensagem opcionais. Auto-atribui a agente IA se configurado.",
    params: [
      { name: "title", type: "string", required: true, location: "body", description: "Titulo do lead" },
      { name: "contact", type: "object", required: false, location: "body", description: "Dados do contato", nested: [
        { name: "email", type: "string", required: false, location: "body", description: "Email do contato" },
        { name: "phone", type: "string", required: false, location: "body", description: "Telefone" },
        { name: "firstName", type: "string", required: false, location: "body", description: "Primeiro nome" },
        { name: "lastName", type: "string", required: false, location: "body", description: "Sobrenome" },
        { name: "company", type: "string", required: false, location: "body", description: "Empresa" },
      ]},
      { name: "message", type: "string", required: false, location: "body", description: "Mensagem inicial (cria conversa)" },
      { name: "channel", type: "string", required: false, location: "body", description: "Canal da conversa", enumValues: ["whatsapp", "telegram", "email", "webchat", "internal"], default: "webchat" },
      { name: "value", type: "number", required: false, location: "body", description: "Valor do lead", default: "0" },
      { name: "currency", type: "string", required: false, location: "body", description: "Moeda (ex: BRL)" },
      { name: "priority", type: "string", required: false, location: "body", description: "Prioridade", enumValues: ["low", "medium", "high", "urgent"], default: "medium" },
      { name: "temperature", type: "string", required: false, location: "body", description: "Temperatura", enumValues: ["cold", "warm", "hot"], default: "cold" },
      { name: "sourceId", type: "string", required: false, location: "body", description: "ID da fonte do lead" },
      { name: "tags", type: "array", required: false, location: "body", description: "Tags do lead", default: "[]" },
      { name: "customFields", type: "object", required: false, location: "body", description: "Campos personalizados", default: "{}" },
    ],
    responseExample: { success: true, leadId: "jd7x8k2m9n4p5q1r", contactId: "k3b7y9w2x5z8a4c6" },
  },
  {
    id: "list-leads",
    method: "GET",
    path: "/api/v1/leads",
    category: "Leads",
    title: "Listar Leads",
    description: "Lista leads com filtros opcionais por board, etapa e responsavel.",
    params: [
      { name: "boardId", type: "string", required: false, location: "query", description: "Filtrar por board" },
      { name: "stageId", type: "string", required: false, location: "query", description: "Filtrar por etapa" },
      { name: "assignedTo", type: "string", required: false, location: "query", description: "Filtrar por responsavel" },
      { name: "limit", type: "number", required: false, location: "query", description: "Limite de resultados (max 500)", default: "200" },
      { name: "cursor", type: "string", required: false, location: "query", description: "Cursor para paginação" },
    ],
    responseExample: {
      leads: [
        { _id: "jd7x8k2m9n4p5q1r", title: "Novo lead via formulario", boardId: "kn8y...", stageId: "m2a4...", contactId: "p5b7...", assignedTo: null, value: 5000, priority: "medium", temperature: "warm", tags: [], customFields: {}, _creationTime: 1739620800000 },
      ],
      nextCursor: "1739620800000|jd7x8k2m9n4p5q1r",
      hasMore: false,
    },
  },
  {
    id: "get-lead",
    method: "GET",
    path: "/api/v1/leads/get",
    category: "Leads",
    title: "Detalhes do Lead",
    description: "Retorna detalhes completos de um lead por ID.",
    params: [
      { name: "id", type: "string", required: true, location: "query", description: "ID do lead" },
    ],
    responseExample: {
      lead: { _id: "jd7x8k2m9n4p5q1r", title: "Lead exemplo", boardId: "kn8y...", stageId: "m2a4...", contactId: "p5b7...", assignedTo: null, value: 5000, priority: "medium", temperature: "warm", tags: ["inbound"], customFields: {}, _creationTime: 1739620800000 },
    },
  },
  {
    id: "update-lead",
    method: "POST",
    path: "/api/v1/leads/update",
    category: "Leads",
    title: "Atualizar Lead",
    description: "Atualiza campos de um lead existente.",
    params: [
      { name: "leadId", type: "string", required: true, location: "body", description: "ID do lead" },
      { name: "title", type: "string", required: false, location: "body", description: "Novo titulo" },
      { name: "value", type: "number", required: false, location: "body", description: "Novo valor" },
      { name: "priority", type: "string", required: false, location: "body", description: "Nova prioridade", enumValues: ["low", "medium", "high", "urgent"] },
      { name: "temperature", type: "string", required: false, location: "body", description: "Nova temperatura", enumValues: ["cold", "warm", "hot"] },
      { name: "tags", type: "array", required: false, location: "body", description: "Novas tags" },
      { name: "customFields", type: "object", required: false, location: "body", description: "Campos personalizados" },
      { name: "sourceId", type: "string", required: false, location: "body", description: "ID da fonte" },
    ],
    responseExample: { success: true },
  },
  {
    id: "delete-lead",
    method: "POST",
    path: "/api/v1/leads/delete",
    category: "Leads",
    title: "Remover Lead",
    description: "Remove permanentemente um lead.",
    params: [
      { name: "leadId", type: "string", required: true, location: "body", description: "ID do lead" },
    ],
    responseExample: { success: true },
  },
  {
    id: "move-lead-stage",
    method: "POST",
    path: "/api/v1/leads/move-stage",
    category: "Leads",
    title: "Mover Lead de Etapa",
    description: "Move um lead para outra etapa do pipeline.",
    params: [
      { name: "leadId", type: "string", required: true, location: "body", description: "ID do lead" },
      { name: "stageId", type: "string", required: true, location: "body", description: "ID da nova etapa" },
    ],
    responseExample: { success: true },
  },
  {
    id: "assign-lead",
    method: "POST",
    path: "/api/v1/leads/assign",
    category: "Leads",
    title: "Atribuir Lead",
    description: "Atribui um lead a um membro da equipe.",
    params: [
      { name: "leadId", type: "string", required: true, location: "body", description: "ID do lead" },
      { name: "assignedTo", type: "string", required: false, location: "body", description: "ID do membro (null para desatribuir)" },
    ],
    responseExample: { success: true },
  },
  {
    id: "request-handoff",
    method: "POST",
    path: "/api/v1/leads/handoff",
    category: "Leads",
    title: "Solicitar Repasse",
    description: "Solicita repasse de IA para humano em um lead.",
    params: [
      { name: "leadId", type: "string", required: true, location: "body", description: "ID do lead" },
      { name: "reason", type: "string", required: true, location: "body", description: "Motivo do repasse" },
      { name: "toMemberId", type: "string", required: false, location: "body", description: "ID do membro destino" },
      { name: "summary", type: "string", required: false, location: "body", description: "Resumo do contexto" },
      { name: "suggestedActions", type: "array", required: false, location: "body", description: "Acoes sugeridas", default: "[]" },
    ],
    responseExample: { success: true, handoffId: "h4n8d0f2f9i3d1x7" },
  },

  // ---- Contacts ----
  {
    id: "list-contacts",
    method: "GET",
    path: "/api/v1/contacts",
    category: "Contatos",
    title: "Listar Contatos",
    description: "Lista todos os contatos da organizacao.",
    params: [
      { name: "limit", type: "number", required: false, location: "query", description: "Limite de resultados (max 500)", default: "500" },
      { name: "cursor", type: "string", required: false, location: "query", description: "Cursor para paginação" },
    ],
    responseExample: {
      contacts: [
        { _id: "k3b7y9w2x5z8a4c6", firstName: "Maria", lastName: "Silva", email: "maria@empresa.com", phone: "+5511999999999", company: "Empresa LTDA", _creationTime: 1739620800000 },
      ],
      nextCursor: "1739620800000|k3b7y9w2x5z8a4c6",
      hasMore: false,
    },
  },
  {
    id: "create-contact",
    method: "POST",
    path: "/api/v1/contacts/create",
    category: "Contatos",
    title: "Criar Contato",
    description: "Cria um novo contato na organizacao.",
    params: [
      { name: "firstName", type: "string", required: false, location: "body", description: "Primeiro nome" },
      { name: "lastName", type: "string", required: false, location: "body", description: "Sobrenome" },
      { name: "email", type: "string", required: false, location: "body", description: "Email" },
      { name: "phone", type: "string", required: false, location: "body", description: "Telefone" },
      { name: "company", type: "string", required: false, location: "body", description: "Empresa" },
      { name: "title", type: "string", required: false, location: "body", description: "Cargo" },
      { name: "whatsappNumber", type: "string", required: false, location: "body", description: "Numero WhatsApp" },
      { name: "telegramUsername", type: "string", required: false, location: "body", description: "Username Telegram" },
      { name: "tags", type: "array", required: false, location: "body", description: "Tags" },
      { name: "bio", type: "string", required: false, location: "body", description: "Bio" },
      { name: "linkedinUrl", type: "string", required: false, location: "body", description: "URL LinkedIn" },
      { name: "city", type: "string", required: false, location: "body", description: "Cidade" },
      { name: "state", type: "string", required: false, location: "body", description: "Estado" },
      { name: "country", type: "string", required: false, location: "body", description: "Pais" },
      { name: "industry", type: "string", required: false, location: "body", description: "Setor" },
      { name: "companySize", type: "string", required: false, location: "body", description: "Porte da empresa" },
      { name: "cnpj", type: "string", required: false, location: "body", description: "CNPJ" },
      { name: "companyWebsite", type: "string", required: false, location: "body", description: "Website" },
      { name: "customFields", type: "object", required: false, location: "body", description: "Campos personalizados" },
    ],
    responseExample: { success: true, contactId: "k3b7y9w2x5z8a4c6" },
  },
  {
    id: "get-contact",
    method: "GET",
    path: "/api/v1/contacts/get",
    category: "Contatos",
    title: "Detalhes do Contato",
    description: "Retorna detalhes completos de um contato por ID.",
    params: [
      { name: "id", type: "string", required: true, location: "query", description: "ID do contato" },
    ],
    responseExample: {
      contact: { _id: "k3b7y9w2x5z8a4c6", firstName: "Maria", lastName: "Silva", email: "maria@empresa.com", phone: "+5511999999999", company: "Empresa LTDA", tags: ["cliente"], _creationTime: 1739620800000 },
    },
  },
  {
    id: "update-contact",
    method: "POST",
    path: "/api/v1/contacts/update",
    category: "Contatos",
    title: "Atualizar Contato",
    description: "Atualiza dados de um contato existente.",
    params: [
      { name: "contactId", type: "string", required: true, location: "body", description: "ID do contato" },
      { name: "firstName", type: "string", required: false, location: "body", description: "Primeiro nome" },
      { name: "lastName", type: "string", required: false, location: "body", description: "Sobrenome" },
      { name: "email", type: "string", required: false, location: "body", description: "Email" },
      { name: "phone", type: "string", required: false, location: "body", description: "Telefone" },
      { name: "company", type: "string", required: false, location: "body", description: "Empresa" },
      { name: "title", type: "string", required: false, location: "body", description: "Cargo" },
      { name: "tags", type: "array", required: false, location: "body", description: "Tags" },
      { name: "city", type: "string", required: false, location: "body", description: "Cidade" },
      { name: "state", type: "string", required: false, location: "body", description: "Estado" },
      { name: "country", type: "string", required: false, location: "body", description: "Pais" },
      { name: "customFields", type: "object", required: false, location: "body", description: "Campos personalizados" },
    ],
    responseExample: { success: true },
  },
  {
    id: "enrich-contact",
    method: "POST",
    path: "/api/v1/contacts/enrich",
    category: "Contatos",
    title: "Enriquecer Contato",
    description: "Enriquece dados do contato via agente de IA.",
    params: [
      { name: "contactId", type: "string", required: true, location: "body", description: "ID do contato" },
      { name: "fields", type: "object", required: true, location: "body", description: "Campos a enriquecer (chave: valor)" },
      { name: "source", type: "string", required: true, location: "body", description: "Fonte dos dados (ex: linkedin, google)" },
      { name: "confidence", type: "number", required: false, location: "body", description: "Confianca (0-1)" },
    ],
    responseExample: { success: true },
  },
  {
    id: "contact-gaps",
    method: "GET",
    path: "/api/v1/contacts/gaps",
    category: "Contatos",
    title: "Gaps de Enriquecimento",
    description: "Retorna campos vazios do contato que podem ser enriquecidos.",
    params: [
      { name: "id", type: "string", required: true, location: "query", description: "ID do contato" },
    ],
    responseExample: {
      contact: { _id: "k3b7y9w2x5z8a4c6", firstName: "Maria", missingFields: ["linkedinUrl", "industry", "companySize"], enrichmentScore: 45 },
    },
  },
  {
    id: "search-contacts",
    method: "GET",
    path: "/api/v1/contacts/search",
    category: "Contatos",
    title: "Buscar Contatos",
    description: "Busca contatos por texto (nome, email, empresa).",
    params: [
      { name: "q", type: "string", required: true, location: "query", description: "Texto de busca" },
      { name: "limit", type: "number", required: false, location: "query", description: "Limite de resultados (max 100)", default: "20" },
    ],
    responseExample: {
      contacts: [
        { _id: "k3b7y9w2x5z8a4c6", firstName: "Maria", lastName: "Silva", email: "maria@empresa.com", company: "Empresa LTDA" },
      ],
    },
  },

  // ---- Conversations ----
  {
    id: "list-conversations",
    method: "GET",
    path: "/api/v1/conversations",
    category: "Conversas",
    title: "Listar Conversas",
    description: "Lista conversas, opcionalmente filtradas por lead.",
    params: [
      { name: "leadId", type: "string", required: false, location: "query", description: "Filtrar por lead" },
      { name: "limit", type: "number", required: false, location: "query", description: "Limite de resultados (max 500)", default: "200" },
      { name: "cursor", type: "string", required: false, location: "query", description: "Cursor para paginação" },
    ],
    responseExample: {
      conversations: [
        { _id: "c9v2s4t7n1a8e3r6", leadId: "jd7x8k2m9n4p5q1r", channel: "webchat", status: "active", lastMessageAt: 1739620800000, _creationTime: 1739620800000 },
      ],
      nextCursor: "1739620800000|c9v2s4t7n1a8e3r6",
      hasMore: false,
    },
  },
  {
    id: "get-messages",
    method: "GET",
    path: "/api/v1/conversations/messages",
    category: "Conversas",
    title: "Mensagens da Conversa",
    description: "Retorna todas as mensagens de uma conversa.",
    params: [
      { name: "conversationId", type: "string", required: true, location: "query", description: "ID da conversa" },
    ],
    responseExample: {
      messages: [
        { _id: "m5s8g3j1k7p4q9w2", conversationId: "c9v2s4t7n1a8e3r6", content: "Ola, gostaria de saber mais.", contentType: "text", isInternal: false, _creationTime: 1739620800000 },
      ],
    },
  },
  {
    id: "send-message",
    method: "POST",
    path: "/api/v1/conversations/send",
    category: "Conversas",
    title: "Enviar Mensagem",
    description: "Envia uma mensagem em uma conversa existente.",
    params: [
      { name: "conversationId", type: "string", required: true, location: "body", description: "ID da conversa" },
      { name: "content", type: "string", required: true, location: "body", description: "Conteudo da mensagem" },
      { name: "contentType", type: "string", required: false, location: "body", description: "Tipo de conteudo", enumValues: ["text", "image", "file", "audio"], default: "text" },
      { name: "isInternal", type: "boolean", required: false, location: "body", description: "Nota interna?", default: "false" },
    ],
    responseExample: { success: true, messageId: "m5s8g3j1k7p4q9w2" },
  },

  // ---- Handoffs ----
  {
    id: "list-handoffs",
    method: "GET",
    path: "/api/v1/handoffs",
    category: "Handoffs",
    title: "Listar Handoffs",
    description: "Lista handoffs com filtro opcional por status.",
    params: [
      { name: "status", type: "string", required: false, location: "query", description: "Filtrar por status", enumValues: ["pending", "accepted", "rejected"] },
      { name: "limit", type: "number", required: false, location: "query", description: "Limite de resultados (max 500)", default: "200" },
      { name: "cursor", type: "string", required: false, location: "query", description: "Cursor para paginação" },
    ],
    responseExample: {
      handoffs: [
        { _id: "h4n8d0f2f9i3d1x7", leadId: "jd7x8k2m9n4p5q1r", status: "pending", reason: "Cliente pediu atendimento humano", _creationTime: 1739620800000 },
      ],
      nextCursor: "1739620800000|h4n8d0f2f9i3d1x7",
      hasMore: false,
    },
  },
  {
    id: "pending-handoffs",
    method: "GET",
    path: "/api/v1/handoffs/pending",
    category: "Handoffs",
    title: "Handoffs Pendentes",
    description: "Lista apenas handoffs com status pendente.",
    params: [],
    responseExample: {
      handoffs: [
        { _id: "h4n8d0f2f9i3d1x7", leadId: "jd7x8k2m9n4p5q1r", status: "pending", reason: "Negociacao complexa", _creationTime: 1739620800000 },
      ],
    },
  },
  {
    id: "accept-handoff",
    method: "POST",
    path: "/api/v1/handoffs/accept",
    category: "Handoffs",
    title: "Aceitar Handoff",
    description: "Aceita um handoff pendente.",
    params: [
      { name: "handoffId", type: "string", required: true, location: "body", description: "ID do handoff" },
      { name: "notes", type: "string", required: false, location: "body", description: "Notas de aceitacao" },
    ],
    responseExample: { success: true },
  },
  {
    id: "reject-handoff",
    method: "POST",
    path: "/api/v1/handoffs/reject",
    category: "Handoffs",
    title: "Rejeitar Handoff",
    description: "Rejeita um handoff pendente.",
    params: [
      { name: "handoffId", type: "string", required: true, location: "body", description: "ID do handoff" },
      { name: "notes", type: "string", required: false, location: "body", description: "Motivo da rejeicao" },
    ],
    responseExample: { success: true },
  },

  // ---- Pipeline / Reference ----
  {
    id: "list-boards",
    method: "GET",
    path: "/api/v1/boards",
    category: "Pipeline",
    title: "Listar Boards",
    description: "Lista boards (pipelines) com suas etapas.",
    params: [],
    responseExample: {
      boards: [
        {
          _id: "kn8y3b7w2x5z8a4c",
          name: "Pipeline Vendas",
          isDefault: true,
          stages: [
            { _id: "m2a4...", name: "Novo", order: 0 },
            { _id: "n5b8...", name: "Qualificado", order: 1 },
            { _id: "p7c2...", name: "Proposta", order: 2 },
            { _id: "q9d4...", name: "Fechado", order: 3 },
          ],
        },
      ],
    },
  },
  {
    id: "list-team-members",
    method: "GET",
    path: "/api/v1/team-members",
    category: "Pipeline",
    title: "Listar Membros da Equipe",
    description: "Lista todos os membros da equipe (humanos e IA).",
    params: [],
    responseExample: {
      members: [
        { _id: "t2m5k8j3n7p1q4w9", name: "Ana Costa", type: "human", role: "admin", status: "active" },
        { _id: "t3m6k9j4n8p2q5w0", name: "Agente IA", type: "ai", role: "member", status: "active" },
      ],
    },
  },
  {
    id: "list-field-definitions",
    method: "GET",
    path: "/api/v1/field-definitions",
    category: "Pipeline",
    title: "Listar Campos Personalizados",
    description: "Lista definicoes de campos personalizados.",
    params: [],
    responseExample: {
      fields: [
        { _id: "f1d3k5j7n9p1q3w5", name: "receita_anual", label: "Receita Anual", type: "number", entityType: "lead" },
      ],
    },
  },

  // ---- Activities ----
  {
    id: "list-activities",
    method: "GET",
    path: "/api/v1/activities",
    category: "Atividades",
    title: "Listar Atividades",
    description: "Lista atividades de um lead.",
    params: [
      { name: "leadId", type: "string", required: true, location: "query", description: "ID do lead" },
      { name: "limit", type: "number", required: false, location: "query", description: "Limite de resultados (max 200)", default: "50" },
      { name: "cursor", type: "string", required: false, location: "query", description: "Cursor para paginação" },
    ],
    responseExample: {
      activities: [
        { _id: "a1c3t5v7y9b1d3f5", leadId: "jd7x8k2m9n4p5q1r", type: "note", content: "Ligacao realizada", _creationTime: 1739620800000 },
      ],
      nextCursor: "1739620800000|a1c3t5v7y9b1d3f5",
      hasMore: false,
    },
  },
  {
    id: "create-activity",
    method: "POST",
    path: "/api/v1/activities",
    category: "Atividades",
    title: "Criar Atividade",
    description: "Cria uma atividade em um lead.",
    params: [
      { name: "leadId", type: "string", required: true, location: "body", description: "ID do lead" },
      { name: "type", type: "string", required: true, location: "body", description: "Tipo da atividade", enumValues: ["note", "call", "email", "meeting", "task"] },
      { name: "content", type: "string", required: false, location: "body", description: "Conteudo da atividade" },
      { name: "metadata", type: "object", required: false, location: "body", description: "Metadados adicionais" },
    ],
    responseExample: { success: true, activityId: "a1c3t5v7y9b1d3f5" },
  },

  // ---- Dashboard ----
  {
    id: "dashboard",
    method: "GET",
    path: "/api/v1/dashboard",
    category: "Dashboard",
    title: "Dashboard Analytics",
    description: "Retorna metricas e KPIs do dashboard.",
    params: [],
    responseExample: {
      totalLeads: 142,
      leadsThisMonth: 28,
      conversionRate: 0.23,
      totalValue: 450000,
      leadsByStage: { Novo: 45, Qualificado: 32, Proposta: 18, Fechado: 12 },
    },
  },

  // ---- Lead Sources ----
  {
    id: "list-lead-sources",
    method: "GET",
    path: "/api/v1/lead-sources",
    category: "Fontes",
    title: "Listar Fontes de Lead",
    description: "Lista todas as fontes de leads configuradas.",
    params: [],
    responseExample: {
      sources: [
        { _id: "s1r3c5e7g9i1k3m5", name: "Website", type: "organic", isActive: true },
        { _id: "s2r4c6e8g0i2k4m6", name: "Google Ads", type: "paid", isActive: true },
      ],
    },
  },

  // ---- Audit Logs ----
  {
    id: "list-audit-logs",
    method: "GET",
    path: "/api/v1/audit-logs",
    category: "Auditoria",
    title: "Listar Logs de Auditoria",
    description: "Lista logs de auditoria com filtros avancados e paginacao por cursor.",
    params: [
      { name: "entityType", type: "string", required: false, location: "query", description: "Tipo de entidade" },
      { name: "action", type: "string", required: false, location: "query", description: "Tipo de acao", enumValues: ["create", "update", "delete", "stage_change", "assign", "handoff_request", "handoff_accept", "handoff_reject"] },
      { name: "severity", type: "string", required: false, location: "query", description: "Severidade", enumValues: ["low", "medium", "high", "critical"] },
      { name: "actorId", type: "string", required: false, location: "query", description: "ID do ator" },
      { name: "startDate", type: "number", required: false, location: "query", description: "Data inicio (timestamp ms)" },
      { name: "endDate", type: "number", required: false, location: "query", description: "Data fim (timestamp ms)" },
      { name: "cursor", type: "string", required: false, location: "query", description: "Cursor para paginacao" },
      { name: "limit", type: "number", required: false, location: "query", description: "Limite de resultados (max 200)" },
    ],
    responseExample: {
      logs: [
        { _id: "al1g3k5m7o9q1s3u", entityType: "lead", action: "create", severity: "low", description: "Lead criado: Novo lead", _creationTime: 1739620800000 },
      ],
      nextCursor: "eyJ...",
      hasMore: true,
    },
  },
];

export function getEndpoint(id: string): ApiEndpoint | undefined {
  return ALL_ENDPOINTS.find((e) => e.id === id);
}

export function getEndpointsByCategory(category: string): ApiEndpoint[] {
  return ALL_ENDPOINTS.filter((e) => e.category === category);
}
