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
  /** "groupAgent" = a IA que responde DENTRO de um grupo (F4), sem tools de lead. */
  audience: "copilot" | "attendant" | "both" | "groupAgent";
  effect: "read" | "write" | "destructive";
  /** Whitelist de campos que o executor pode devolver ao modelo. */
  resultFields: string[];
}

/**
 * Campos que o runtime injeta e o modelo jamais controla.
 *
 * `groupChatId`/`groupPostId` entraram na lista pelo review de segurança nº 11:
 * hoje nenhuma tool do agente DE GRUPO aceita id (o par sala/conversa vem do
 * CLAIM), mas nada quebrava se uma futura aceitasse — e aí o modelo passaria a
 * escolher em qual sala publicar. As tools do COPILOTO continuam recebendo os
 * dois do modelo, pelo mesmo mecanismo que já isenta `leadId`/`contactId`: o
 * copiloto navega a org com o RBAC do usuário e o executor revalida a org.
 */
export const INJECTED_PARAM_NAMES = [
  "organizationId",
  "teamMemberId",
  "agentMemberId",
  "conversationId",
  "leadId",
  "contactId",
  "groupChatId",
  "groupPostId",
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
    name: "updateThisContact",
    description:
      "Salva nome e/ou e-mail do contato deste atendimento assim que a pessoa se apresentar (ex.: 'meu nome é Maria').",
    parameters: schema(
      {
        firstName: { type: "string", description: "Primeiro nome do contato" },
        lastName: { type: "string", description: "Sobrenome (se informado)" },
        email: { type: "string", description: "E-mail (apenas se a pessoa informar)" },
      },
      []
    ),
    permission: { category: "contacts", level: "edit" },
    audience: "attendant",
    effect: "write",
    resultFields: ["status"],
  },
  {
    name: "updateThisLeadInfo",
    description:
      "Atualiza dados do lead deste atendimento conforme a conversa revela: título, valor estimado, temperatura e os CAMPOS A CAPTURAR listados no contexto (use exatamente as chaves e opções listadas).",
    parameters: schema(
      {
        title: { type: "string", description: "Título curto do lead (ex.: nome + interesse)" },
        value: { type: "number", description: "Valor estimado do negócio (número, se souber)" },
        temperature: {
          type: "string",
          enum: ["cold", "warm", "hot"],
          description: "Temperatura do lead",
        },
        fields: {
          type: "object",
          description:
            "Campos a capturar: objeto {chave: valor} usando SOMENTE as chaves/opções listadas no contexto",
          additionalProperties: true,
        },
      },
      []
    ),
    permission: { category: "leads", level: "edit_own" },
    audience: "attendant",
    effect: "write",
    resultFields: ["status", "updated"],
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

// ── Tools do AGENTE DE GRUPO (F4, D6): a superfície mais estreita do produto. ──
// Três tools e nada mais. Sem tools de LEAD/CONTATO de propósito: numa sala de
// grupo não existe lead (a conversa não tem `leadId`), e dar a elas um id
// qualquer seria escrever no CRM por causa de uma frase de um desconhecido.
// Tudo o que o agente sabe chega INJETADO no contexto do turno.
export const GROUP_AGENT_TOOLS: AgentToolSpec[] = [
  {
    name: "replyToGroup",
    description:
      "Publica (ou, em modo sugestão, rascunha) a sua resposta NO GRUPO — todos os membros leem. Use uma única vez por turno.",
    parameters: schema(
      {
        text: {
          type: "string",
          description: "Texto curto da resposta em português (até 3 linhas)",
        },
        mentionKeys: {
          type: "array",
          items: { type: "string" },
          description:
            "Opcional: chaves de participantes a mencionar, EXATAMENTE como aparecem em participantes[].chave no contexto",
        },
      },
      ["text"]
    ),
    permission: { category: "inbox", level: "reply" },
    audience: "groupAgent",
    effect: "write",
    resultFields: ["status", "messageId", "mode"],
  },
  {
    // Nome próprio (não `requestHandoff`): os nomes de tool são únicos no
    // registry inteiro, e o repasse de grupo cria um handoff SEM lead.
    name: "requestGroupHandoff",
    description:
      "Chama um humano do time para esta conversa de grupo (assunto sensível, reclamação grave, pedido explícito de atendente). Depois avise no grupo, em uma linha, que já acionou a equipe.",
    parameters: schema(
      {
        reason: { type: "string", description: "Motivo curto do repasse" },
        summary: {
          type: "string",
          description: "Resumo do que está acontecendo no grupo, para quem assumir",
        },
      },
      ["reason"]
    ),
    permission: { category: "inbox", level: "reply" },
    audience: "groupAgent",
    effect: "write",
    resultFields: ["status", "handoffId"],
  },
  {
    name: "flagOpportunity",
    description:
      "Avisa a equipe de que um membro do grupo demonstrou intenção de compra ou pediu orçamento. NÃO cria lead nem manda mensagem privada — só notifica uma pessoa do time, que decide.",
    parameters: schema(
      {
        participantKey: {
          type: "string",
          description: "A chave do participante, como aparece em participantes[].chave no contexto",
        },
        summary: { type: "string", description: "O que a pessoa quer, em até 140 caracteres" },
      },
      ["participantKey", "summary"]
    ),
    permission: { category: "leads", level: "view_own" },
    audience: "groupAgent",
    effect: "write",
    resultFields: ["status"],
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
  {
    name: "listCampaigns",
    description:
      "Lista as campanhas de WhatsApp (disparo em massa) da organização com status, canal e contadores (enviadas, entregues, lidas, respondidas, falhas, opt-out).",
    parameters: schema(
      {
        status: {
          type: "string",
          enum: ["draft", "scheduled", "running", "paused", "completed", "canceled", "failed"],
        },
      },
      []
    ),
    permission: { category: "campaigns", level: "view" },
    audience: "copilot",
    effect: "read",
    resultFields: ["campaigns"],
  },
  {
    name: "getCampaignReport",
    description:
      "Relatório de uma campanha: contadores, taxas (entrega, leitura, resposta, falha, opt-out), motivos de falha, custo estimado, progresso e linha do tempo.",
    parameters: schema({ campaignId: { type: "string", description: "ID da campanha" } }, ["campaignId"]),
    permission: { category: "campaigns", level: "view" },
    audience: "copilot",
    effect: "read",
    resultFields: ["report"],
  },
  {
    name: "previewCampaignAudience",
    description:
      "Conta quantos destinatários uma campanha alcançaria e mostra uma amostra — sem criar nada. Três públicos: leads do CRM (segment, default), as SALAS de grupos monitorados (groups) ou os MEMBROS dessas salas, 1 a 1 (group_members).",
    parameters: schema(
      {
        source: {
          type: "string",
          enum: ["segment", "groups", "group_members"],
          description: "Default: segment (leads do CRM)",
        },
        boardName: { type: "string", description: "Nome do board (funil)" },
        stageNames: { type: "array", items: { type: "string" }, description: "Nomes dos estágios" },
        tags: { type: "array", items: { type: "string" } },
        temperature: { type: "string", enum: ["cold", "warm", "hot"] },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
        lastActivityBeforeDays: { type: "number", description: "Só leads sem atividade há mais de N dias" },
        lastActivityAfterDays: { type: "number", description: "Só leads com atividade nos últimos N dias" },
        onlyOpenWindow: { type: "boolean", description: "Só quem tem a janela de 24h do WhatsApp aberta" },
        excludeCampaignedWithinDays: { type: "number", description: "Excluir quem recebeu campanha nos últimos N dias" },
        groupNames: {
          type: "array",
          items: { type: "string" },
          description: "groups/group_members: nomes dos grupos monitorados (use listGroups para descobrir)",
        },
        memberFilters: {
          type: "object",
          description: "group_members: filtros sobre os participantes",
          properties: {
            excludeAdmins: { type: "boolean" },
            excludeExistingContacts: { type: "boolean", description: "Fora quem já é contato da org" },
            excludeCampaignedWithinDays: { type: "number" },
            activeInGroupWithinDays: { type: "number", description: "Só quem falou no grupo nos últimos N dias" },
            excludeGroupNames: {
              type: "array",
              items: { type: "string" },
              description: "Fora quem também está nestes grupos",
            },
            includeKeys: {
              type: "array",
              items: { type: "string" },
              description:
                "Só estas pessoas (chave do membro = campo `key` da lista `members` da prévia). Vazio = todos os elegíveis.",
            },
          },
          additionalProperties: false,
        },
      },
      []
    ),
    permission: { category: "campaigns", level: "manage" },
    audience: "copilot",
    effect: "read",
    resultFields: ["count", "excluded", "sample", "truncated", "funnel", "perGroup", "estimatedDays", "reach"],
  },
  // ── Grupos de WhatsApp (F4) ──
  // Nenhuma destas tocará o doc de `channelConfigs`: o retorno é montado campo
  // a campo a partir de `groupChats`/`groupPosts` (o token do gateway mora no
  // canal, e `SECRET_FIELD_PATTERN` é a segunda linha de defesa).
  {
    name: "listGroups",
    description:
      "Lista os grupos de WhatsApp conhecidos pelo CRM (nome, nº de membros, se está sendo acompanhado, política de IA e última atividade).",
    parameters: schema(
      {
        onlyMonitored: { type: "boolean", description: "Só os grupos acompanhados" },
        query: { type: "string", description: "Filtro pelo nome do grupo" },
      },
      []
    ),
    permission: { category: "inbox", level: "view_own" },
    audience: "copilot",
    effect: "read",
    resultFields: ["groups", "total"],
  },
  {
    name: "getGroupDetail",
    description:
      "Detalhe de um grupo: assunto, membros (nome e se é admin), atividade recente e política de IA. Use o groupChatId que veio de listGroups.",
    parameters: schema({ groupChatId: { type: "string" } }, ["groupChatId"]),
    permission: { category: "inbox", level: "view_own" },
    audience: "copilot",
    effect: "read",
    resultFields: ["group", "members", "membersTotal"],
  },
  {
    name: "listGroupPosts",
    description: "Lista as publicações programadas em grupos (nome, status, agenda e destinos).",
    parameters: schema(
      {
        status: { type: "string", enum: ["draft", "active", "paused", "ended"] },
      },
      []
    ),
    permission: { category: "campaigns", level: "view" },
    audience: "copilot",
    effect: "read",
    resultFields: ["posts", "total"],
  },
  {
    name: "getGroupPostHistory",
    description: "Histórico de disparos de uma publicação programada (enviados, pulados, falhas).",
    parameters: schema(
      { groupPostId: { type: "string" }, limit: { type: "number" } },
      ["groupPostId"]
    ),
    permission: { category: "campaigns", level: "view" },
    audience: "copilot",
    effect: "read",
    resultFields: ["post", "history"],
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
  {
    name: "createCampaignDraft",
    description:
      "Cria um RASCUNHO de campanha de WhatsApp (disparo em massa) com mensagem e público. NUNCA lança: o lançamento exige aceites (consentimento LGPD, risco do bridge e, no público group_members, o aceite de mandar privado para quem não iniciou conversa) feitos por um humano na tela de Campanhas. Prefira 2+ variantes de texto e {{nome}} para personalizar.",
    parameters: schema(
      {
        name: { type: "string" },
        description: { type: "string" },
        channelName: { type: "string", description: "Nome do canal WhatsApp (default: o único canal ativo)" },
        variants: {
          type: "array",
          items: { type: "string" },
          description: "Textos da mensagem (variantes rotacionadas; aceita {{nome}} e spintax {a|b})",
        },
        audience: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["segment", "manual", "groups", "group_members"] },
            boardName: { type: "string" },
            stageNames: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
            temperature: { type: "string", enum: ["cold", "warm", "hot"] },
            priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
            onlyOpenWindow: { type: "boolean" },
            excludeCampaignedWithinDays: { type: "number" },
            phones: { type: "array", items: { type: "string" }, description: "Manual: números (até 500)" },
            groupNames: {
              type: "array",
              items: { type: "string" },
              description: "groups/group_members: nomes dos grupos monitorados (mesmo canal)",
            },
            memberFilters: {
              type: "object",
              description: "group_members: filtros sobre os participantes",
              properties: {
                excludeAdmins: { type: "boolean" },
                excludeExistingContacts: { type: "boolean" },
                excludeCampaignedWithinDays: { type: "number" },
                activeInGroupWithinDays: { type: "number" },
                excludeGroupNames: { type: "array", items: { type: "string" } },
                includeKeys: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
          },
          required: ["kind"],
          additionalProperties: false,
        },
        targetBoardName: { type: "string", description: "Board onde números novos viram lead" },
        targetStageName: { type: "string" },
      },
      ["name", "variants", "audience"]
    ),
    permission: { category: "campaigns", level: "manage" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "campaignId", "name", "recipientsAdded", "invalid", "url", "next"],
  },
  {
    name: "pauseCampaign",
    description: "Pausa uma campanha em andamento (os envios param na hora; pode ser retomada depois).",
    parameters: schema(
      { campaignId: { type: "string" }, reason: { type: "string" } },
      ["campaignId"]
    ),
    permission: { category: "campaigns", level: "manage" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "campaignId"],
  },
  {
    name: "resumeCampaign",
    description: "Retoma uma campanha pausada.",
    parameters: schema({ campaignId: { type: "string" } }, ["campaignId"]),
    permission: { category: "campaigns", level: "manage" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "campaignId"],
  },
  {
    name: "launchCampaign",
    description:
      "NÃO lança a campanha: explica ao usuário como lançar pela tela (o lançamento exige aceites humanos e não pode ser feito pelo copiloto). Use para orientar quando pedirem para disparar.",
    parameters: schema({ campaignId: { type: "string" } }, ["campaignId"]),
    permission: { category: "campaigns", level: "full" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "campaignId", "url", "instruction"],
  },
  {
    name: "cancelCampaign",
    description:
      "PROPÕE o cancelamento de uma campanha em andamento/pausada. Não cancela agora: gera uma confirmação que o usuário precisa aprovar.",
    parameters: schema({ campaignId: { type: "string" } }, ["campaignId"]),
    permission: { category: "campaigns", level: "full" },
    audience: "copilot",
    effect: "destructive",
    resultFields: ["status", "pendingActionId", "preview"],
  },
  // ── Grupos de WhatsApp (F4) ──
  {
    name: "getGroupSummary",
    description:
      "Resumo por IA do que aconteceu num grupo. Devolve o resumo salvo quando ele é recente; senão MANDA GERAR um novo (leva alguns segundos — avise que é para perguntar de novo em seguida).",
    parameters: schema(
      {
        groupChatId: { type: "string" },
        hours: { type: "number", enum: [24, 168], description: "Janela: 24 (1 dia) ou 168 (7 dias)" },
      },
      ["groupChatId"]
    ),
    permission: { category: "inbox", level: "view_own" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "summary", "at", "hours", "ageMinutes"],
  },
  {
    name: "createGroupPostDraft",
    description:
      "Cria o RASCUNHO de uma publicação programada em grupos com mensagens prontas (biblioteca). Não ativa: quem ativa é uma pessoa.",
    parameters: schema(
      {
        name: { type: "string", description: "Nome da rotina (ex.: 'Bom dia do Guardião')" },
        groupChatIds: { type: "array", items: { type: "string" }, description: "Grupos de destino (do MESMO número)" },
        times: { type: "array", items: { type: "string" }, description: 'Horários "HH:MM" (ex.: ["12:00"])' },
        days: { type: "array", items: { type: "number" }, description: "Dias da semana 1=seg … 7=dom; vazio = todos" },
        timezone: { type: "string", description: 'Fuso (default: o da organização, ex. "America/Sao_Paulo")' },
        messages: { type: "array", items: { type: "string" }, description: "Textos da biblioteca, em ordem" },
        order: { type: "string", enum: ["sequential", "random"] },
      },
      ["name", "groupChatIds", "times", "messages"]
    ),
    permission: { category: "campaigns", level: "manage" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "groupPostId", "name", "schedule", "groups", "next"],
  },
  {
    name: "pauseGroupPost",
    description: "Pausa uma publicação programada ativa.",
    parameters: schema(
      { groupPostId: { type: "string" }, reason: { type: "string" } },
      ["groupPostId"]
    ),
    permission: { category: "campaigns", level: "manage" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "groupPostId"],
  },
  {
    name: "activateGroupPost",
    description:
      "PROPÕE ativar uma publicação programada. Não ativa agora: gera uma confirmação que o usuário precisa aprovar (a partir da ativação o CRM escreve sozinho no grupo).",
    parameters: schema({ groupPostId: { type: "string" } }, ["groupPostId"]),
    permission: { category: "campaigns", level: "full" },
    audience: "copilot",
    effect: "destructive",
    resultFields: ["status", "pendingActionId", "preview"],
  },
  {
    name: "sendGroupMessage",
    description:
      "PROPÕE publicar uma mensagem num grupo agora. Não envia: gera uma confirmação que o usuário precisa aprovar.",
    parameters: schema(
      { groupChatId: { type: "string" }, text: { type: "string" } },
      ["groupChatId", "text"]
    ),
    permission: { category: "inbox", level: "reply" },
    audience: "copilot",
    effect: "destructive",
    resultFields: ["status", "pendingActionId", "preview"],
  },
  {
    name: "createLeadFromGroupMember",
    description:
      "Cria contato + lead + conversa privada a partir de um membro de grupo (o membro precisa expor o telefone).",
    parameters: schema(
      {
        groupChatId: { type: "string" },
        participantKey: { type: "string", description: "A chave do membro, como aparece em getGroupDetail" },
      },
      ["groupChatId", "participantKey"]
    ),
    permission: { category: "leads", level: "edit_own" },
    audience: "copilot",
    effect: "write",
    resultFields: ["status", "leadId", "contactId", "conversationId", "created"],
  },
];

export const ALL_AGENT_TOOLS: AgentToolSpec[] = [
  ...ATTENDANT_TOOLS,
  ...GROUP_AGENT_TOOLS,
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
