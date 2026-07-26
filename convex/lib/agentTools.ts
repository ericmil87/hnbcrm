/**
 * Registry ESTÁTICO de tools de IA — a superfície completa que os modelos podem
 * chamar. Nada de resolução dinâmica por nome: os executores (copilot.ts /
 * attendant.ts) fazem switch explícito sobre estes nomes e injetam os IDs de
 * escopo (organizationId, teamMemberId, conversationId…) — o modelo NUNCA
 * fornece esses IDs (por isso eles não aparecem em `parameters`).
 *
 * Segurança validada em build (agentToolSecurity.test.ts):
 *  - nenhum nome do TOOL_DENYLIST pode aparecer aqui;
 *  - toda tool declara `resultFields` (whitelist de campos de saída) e nenhum
 *    campo casa SECRET_FIELD_PATTERN — executores DEVEM projetar o retorno via
 *    projectToolResult() antes de devolvê-lo ao modelo;
 *  - `parameters` não pode conter campos de escopo injetados pelo runtime.
 */
import type { PermissionCategory } from "./permissions";

export interface AgentToolSpec {
  name: string;
  description: string;
  /** JSON Schema dos parâmetros VISÍVEIS ao modelo (sem IDs de escopo). */
  parameters: Record<string, unknown>;
  /** Gate RBAC aplicado server-side via assertAgentCan no executor. */
  permission: { category: PermissionCategory; level: string };
  audience: "copilot" | "attendant" | "both";
  effect: "read" | "write" | "destructive";
  /** Whitelist de campos que o executor pode devolver ao modelo. */
  resultFields: string[];
}

/** Campos que o runtime injeta e o modelo jamais controla. */
export const INJECTED_PARAM_NAMES = [
  "organizationId",
  "teamMemberId",
  "agentMemberId",
  "conversationId",
  "leadId",
  "contactId",
] as const;

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

// ── Tools do ATENDENTE: escopadas ao registro do atendimento em curso. ──
// Zero tools de listagem org-wide, zero destrutivas, zero settings/equipe/canais.
// O contexto (histórico, lead, contato) é INJETADO pelo runtime — o atendente
// não "busca", ele já recebe o que precisa.
export const ATTENDANT_TOOLS: AgentToolSpec[] = [
  {
    name: "replyToCustomer",
    description:
      "Envia (ou, em modo sugestão, rascunha) a resposta ao cliente desta conversa. Use uma única vez por turno, ao final.",
    parameters: schema(
      { text: { type: "string", description: "Texto da resposta em português (curto e direto)" } },
      ["text"]
    ),
    permission: { category: "inbox", level: "reply" },
    audience: "attendant",
    effect: "write",
    resultFields: ["status", "messageId", "mode"],
  },
  {
    name: "moveThisLead",
    description:
      "Move o lead deste atendimento para outro estágio do funil (use o nome exato de um estágio listado no contexto).",
    parameters: schema(
      { stageName: { type: "string", description: "Nome exato do estágio de destino" } },
      ["stageName"]
    ),
    permission: { category: "leads", level: "edit_own" },
    audience: "attendant",
    effect: "write",
    resultFields: ["status", "stageName"],
  },
  {
    name: "scheduleFollowUp",
    description: "Agenda um follow-up (tarefa) para o lead deste atendimento.",
    parameters: schema(
      {
        title: { type: "string", description: "Título curto do follow-up" },
        dueInHours: {
          type: "number",
          description: "Prazo em horas a partir de agora (ex.: 24 = amanhã)",
        },
      },
      ["title", "dueInHours"]
    ),
    permission: { category: "tasks", level: "edit_own" },
    audience: "attendant",
    effect: "write",
    resultFields: ["status", "taskId", "dueAt"],
  },
  {
    name: "qualifyThisLead",
    description:
      "Atualiza a qualificação BANT do lead deste atendimento com o que a conversa revelou.",
    parameters: schema(
      {
        budget: { type: "boolean", description: "Tem orçamento?" },
        authority: { type: "boolean", description: "Fala com quem decide?" },
        need: { type: "boolean", description: "Tem necessidade real?" },
        timeline: { type: "boolean", description: "Tem prazo definido?" },
      },
      []
    ),
    permission: { category: "leads", level: "edit_own" },
    audience: "attendant",
    effect: "write",
    resultFields: ["status", "score", "movedTo"],
  },
  {
    name: "requestHandoff",
    description:
      "Escala este atendimento para um humano AGORA (cliente pediu, assunto sensível, fora do escopo, ou baixa confiança). Inclua um resumo útil — o humano que assumir vê seu contexto.",
    parameters: schema(
      {
        reason: { type: "string", description: "Motivo curto do repasse" },
        summary: { type: "string", description: "Resumo do atendimento até aqui" },
        suggestedActions: {
          type: "array",
          items: { type: "string" },
          description: "Próximos passos sugeridos ao humano",
        },
      },
      ["reason", "summary"]
    ),
    permission: { category: "inbox", level: "reply" },
    audience: "attendant",
    effect: "write",
    resultFields: ["status", "handoffId"],
  },
];

// ── Tools de LEITURA do copiloto: age como o usuário (RBAC dele, enforçado
// server-side). Sem nenhuma rota que retorne credencial — configs só mascaradas. ──
export const COPILOT_READ_TOOLS: AgentToolSpec[] = [
  {
    name: "getPipelineOverview",
    description:
      "Visão geral do funil: boards, estágios e contagem/valor de leads por estágio.",
    parameters: schema(
      { boardName: { type: "string", description: "Opcional: nome do board específico" } },
      []
    ),
    permission: { category: "leads", level: "view_all" },
    audience: "copilot",
    effect: "read",
    resultFields: ["boards"],
  },
  {
    name: "listLeads",
    description: "Lista leads com filtros (estágio, responsável, temperatura, tags…).",
    parameters: schema(
      {
        stageName: { type: "string" },
        assigneeName: { type: "string" },
        temperature: { type: "string", enum: ["cold", "warm", "hot"] },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        limit: { type: "number" },
      },
      []
    ),
    permission: { category: "leads", level: "view_all" },
    audience: "copilot",
    effect: "read",
    resultFields: ["leads", "totalShown"],
  },
  {
    name: "getLeadDetail",
    description: "Detalhes de um lead (contato, estágio, valor, qualificação, timeline recente).",
    parameters: schema({ leadId: { type: "string", description: "ID do lead" } }, ["leadId"]),
    permission: { category: "leads", level: "view_all" },
    audience: "copilot",
    effect: "read",
    resultFields: ["lead", "timeline"],
  },
  {
    name: "searchContacts",
    description: "Busca contatos por nome, e-mail, telefone ou empresa.",
    parameters: schema(
      {
        query: { type: "string", description: "Termo de busca" },
        limit: { type: "number" },
      },
      ["query"]
    ),
    permission: { category: "contacts", level: "view" },
    audience: "copilot",
    effect: "read",
    resultFields: ["contacts"],
  },
  {
    name: "getDashboardStats",
    description: "Métricas do painel: leads novos, conversões, valor em aberto, atividade recente.",
    parameters: schema({}, []),
    permission: { category: "reports", level: "view" },
    audience: "copilot",
    effect: "read",
    resultFields: ["stats"],
  },
  {
    name: "listTeamMembers",
    description: "Lista os membros da equipe (nome, papel, status) — sem dados sensíveis.",
    parameters: schema({}, []),
    permission: { category: "team", level: "view" },
    audience: "copilot",
    effect: "read",
    resultFields: ["members"],
  },
  {
    name: "listBoardsAndStages",
    description: "Lista boards (pipelines) e seus estágios na ordem.",
    parameters: schema({}, []),
    permission: { category: "leads", level: "view_own" },
    audience: "copilot",
    effect: "read",
    resultFields: ["boards"],
  },
  {
    name: "listQuickReplies",
    description: "Lista as respostas rápidas configuradas (atalho + conteúdo).",
    parameters: schema({}, []),
    permission: { category: "inbox", level: "view_own" },
    audience: "copilot",
    effect: "read",
    resultFields: ["quickReplies"],
  },
  {
    name: "listTasks",
    description: "Lista tarefas e lembretes (com filtro de status/responsável).",
    parameters: schema(
      {
        status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
        limit: { type: "number" },
      },
      []
    ),
    permission: { category: "tasks", level: "view_all" },
    audience: "copilot",
    effect: "read",
    resultFields: ["tasks"],
  },
];

// ── Tools de ESCRITA do copiloto (F2): gated + confirmação por reversibilidade.
// Destrutivas passam por pendingActions (two-phase, disparo humano). ──
export const COPILOT_WRITE_TOOLS: AgentToolSpec[] = [
  {
    name: "createLead",
    description: "Cria um lead num board/estágio.",
    parameters: schema(
      {
        title: { type: "string" },
        boardName: { type: "string", description: "Nome do board (default: board padrão)" },
        stageName: { type: "string", description: "Nome do estágio (default: primeiro)" },
        value: { type: "number" },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        temperature: { type: "string", enum: ["cold", "warm", "hot"] },
        contactId: { type: "string", description: "Opcional: ID de contato existente" },
        tags: { type: "array", items: { type: "string" } },
      },
      ["title"]
    ),
    permission: { category: "leads", level: "edit_own" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "leadId", "title"],
  },
  {
    name: "updateLead",
    description: "Atualiza campos de um lead (título, valor, prioridade, temperatura, tags).",
    parameters: schema(
      {
        leadId: { type: "string" },
        title: { type: "string" },
        value: { type: "number" },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        temperature: { type: "string", enum: ["cold", "warm", "hot"] },
        tags: { type: "array", items: { type: "string" } },
      },
      ["leadId"]
    ),
    permission: { category: "leads", level: "edit_own" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "leadId"],
  },
  {
    name: "moveLead",
    description: "Move um lead para outro estágio.",
    parameters: schema(
      { leadId: { type: "string" }, stageName: { type: "string" } },
      ["leadId", "stageName"]
    ),
    permission: { category: "leads", level: "edit_own" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "leadId", "stageName"],
  },
  {
    name: "assignLead",
    description: "Atribui um lead a um membro da equipe (pelo nome).",
    parameters: schema(
      { leadId: { type: "string" }, memberName: { type: "string" } },
      ["leadId", "memberName"]
    ),
    permission: { category: "leads", level: "edit_all" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "leadId", "memberName"],
  },
  {
    name: "createContact",
    description: "Cria um contato.",
    parameters: schema(
      {
        firstName: { type: "string" },
        lastName: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        company: { type: "string" },
      },
      []
    ),
    permission: { category: "contacts", level: "edit" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "contactId"],
  },
  {
    name: "createTask",
    description: "Cria uma tarefa ou lembrete (opcionalmente ligada a um lead).",
    parameters: schema(
      {
        title: { type: "string" },
        dueInHours: { type: "number" },
        leadId: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
      },
      ["title"]
    ),
    permission: { category: "tasks", level: "edit_own" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "taskId"],
  },
  {
    name: "createBoard",
    description:
      "Cria um novo board (pipeline) com estágios — usado no onboarding conversacional. Mostre um preview e confirme antes.",
    parameters: schema(
      {
        name: { type: "string" },
        stages: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              isClosedWon: { type: "boolean" },
              isClosedLost: { type: "boolean" },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
      ["name", "stages"]
    ),
    permission: { category: "settings", level: "manage" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "boardId", "stageCount"],
  },
  {
    name: "createFieldDefinition",
    description: "Cria um campo personalizado de lead ou contato (onboarding).",
    parameters: schema(
      {
        name: { type: "string" },
        key: { type: "string" },
        fieldType: {
          type: "string",
          enum: ["text", "number", "boolean", "date", "select", "multiselect"],
        },
        entityType: { type: "string", enum: ["lead", "contact"] },
        options: { type: "array", items: { type: "string" } },
      },
      ["name", "key", "fieldType", "entityType"]
    ),
    permission: { category: "settings", level: "manage" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "fieldDefinitionId"],
  },
  {
    name: "createQuickReply",
    description: "Cria uma resposta rápida ('/atalho') para o inbox.",
    parameters: schema(
      { shortcut: { type: "string" }, content: { type: "string" } },
      ["shortcut", "content"]
    ),
    permission: { category: "inbox", level: "reply" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "quickReplyId"],
  },
  {
    name: "deleteLead",
    description:
      "PROPÕE a exclusão de um lead. A exclusão NÃO acontece agora: gera uma confirmação que o usuário precisa aprovar.",
    parameters: schema({ leadId: { type: "string" } }, ["leadId"]),
    permission: { category: "leads", level: "full" },
    audience: "copilot",
    effect: "destructive",
    resultFields: ["status", "pendingActionId", "preview"],
  },
];

export const ALL_AGENT_TOOLS: AgentToolSpec[] = [
  ...ATTENDANT_TOOLS,
  ...COPILOT_READ_TOOLS,
  ...COPILOT_WRITE_TOOLS,
];

/** Converte specs para o formato `tools` do Chat Completions. */
export function toChatTools(specs: AgentToolSpec[]): {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}[] {
  return specs.map((s) => ({
    type: "function" as const,
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));
}

/**
 * Projeta o resultado de uma tool pela whitelist do spec — OBRIGATÓRIO em todo
 * executor antes de devolver ao modelo. Campos fora da whitelist (inclusive
 * qualquer *Encrypted/token/secret) simplesmente não passam.
 */
export function projectToolResult(
  spec: AgentToolSpec,
  result: Record<string, unknown>
): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of spec.resultFields) {
    if (field in result) projected[field] = result[field];
  }
  return projected;
}

export function toolSpecByName(name: string): AgentToolSpec | undefined {
  return ALL_AGENT_TOOLS.find((t) => t.name === name);
}
