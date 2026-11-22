// OpenAPI da Agenda v2 (I1): rotas /api/v1/scheduling/*, mescladas em `openapiSpec.ts`. Montado como OBJETO (não como
// texto) para não depender de escape de aspas; `openapiSpec.test.ts` confere que cada operação daqui tem a entrada
// correspondente em `ROUTE_PERMISSIONS` e vice-versa.

type Json = Record<string, unknown>;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const resp = (name: "BadRequest" | "Unauthorized" | "Forbidden" | "InternalError") => ({ $ref: `#/components/responses/${name}` });
const ok = (description: string, schema: Json) => ({ description, content: { "application/json": { schema } } });
const str = (description: string, extra: Json = {}) => ({ type: "string", description, ...extra });
const q = (name: string, description: string, required = false, schema: Json = { type: "string" }) => ({ name, in: "query", required, description, schema });
const body = (required: string[], properties: Json, description?: string) => ({
  required: true,
  ...(description ? { description } : {}),
  content: { "application/json": { schema: { type: "object", required, properties } } },
});

const NOT_FOUND = {
  description: "Não encontrado — o mesmo corpo para id inexistente, de outra organização ou que a chave não pode ver",
  content: { "application/json": { schema: { type: "object", properties: { error: { type: "string", example: "Agendamento não encontrado" }, code: { type: "integer", example: 404 } } } } },
};
const RULES_409 = {
  description:
    "Regra da agenda impediu a operação (code sched_rules) com violations e alternatives (horários no formato Slot) — ou, no caso de idempotência, code idempotency_key_reused (a chave já foi usada com outros dados). Tratamento: escolha uma alternativa devolvida e repita; force só aceita códigos de severity warn (nunca capacidade).",
  content: { "application/json": { schema: ref("SchedRulesError") } },
};

const WHEN_PROPS = {
  startsAt: str("Início em ISO 8601 COM fuso (ex.: 2026-11-27T14:30:00-03:00)"),
  startsAtLocal: str("Início local AAAA-MM-DDTHH:mm no fuso da organização (ex.: 2026-11-27T14:30). Hora que não existe (salto do horário de verão) = 400"),
  startTime: { type: "number", description: "Início em epoch ms (o que o Slot devolve). Informe UM dos três; mais de um precisa indicar o mesmo instante" },
};
const BOOK_PROPS = {
  serviceId: str("ID do serviço (de GET /scheduling/services)"),
  variantKey: str("Chave da variação do serviço, quando há"),
  ...WHEN_PROPS,
  contactId: str("Contato do cliente"),
  leadId: str("Lead do cliente (gera atividade na linha do tempo)"),
  conversationId: str("Conversa de origem, quando há"),
  resourceIds: { type: "array", maxItems: 10, items: { type: "string" }, description: "Plano de recursos (de um Slot). Fixa o que foi pedido: recurso cheio = 409 com alternativas, recurso fechado/bloqueado = 409 de aviso (só passa com force). Troca por outro recurso só com allowResourceFallback: true" },
  allowResourceFallback: { type: "boolean", description: "Padrão: false quando resourceIds é enviado (e SEMPRE na remarcação, que parte dos recursos atuais): o recurso pedido nunca é trocado em silêncio, igual à tela. true = aceita o plano alternativo do mesmo início quando o pedido está cheio (a porta pode escolher outra sala/equipamento equivalente). Sem resourceIds ao marcar, a porta escolhe o plano" },
  force: { type: "array", maxItems: 10, items: { type: "string" }, description: "Códigos de AVISO (severity warn) que a equipe aceita, ex.: OUTSIDE_HOURS. Aceita também o PAR CÓDIGO:resourceId (ex.: RESOURCE_CLOSED:<id>), que vale só para aquele recurso (até 80 caracteres por item); o código puro continua valendo para qualquer recurso. Códigos de bloqueio (capacidade, duração, serviço inativo) nunca passam" },
  notes: str("Observação interna (até 500 caracteres)"),
};
const IDEMPOTENCY_HEADER = {
  name: "Idempotency-Key",
  in: "header",
  required: false,
  description: "Chave de idempotência (1–128 caracteres: letras, números, . _ : -). Alternativa ao campo requestId do corpo",
  schema: { type: "string" },
};

const key = (level: string) => `Requer permissão agenda: ${level} na chave de API (chave antiga sem a categoria agenda herda o nível de tasks).`;

const op = (
  summary: string,
  description: string,
  operationId: string,
  extra: Json & { responses: Json }
) => ({ tags: ["Agenda"], summary, description, operationId, ...extra });

const READ_ERRORS = { "400": resp("BadRequest"), "401": resp("Unauthorized"), "403": resp("Forbidden") };
const LIMITS = "Limites (custo de leitura do plano Free): lista de agendamentos até 31 dias por consulta; horários com janela padrão de 3 dias e máximo de 7; pendências com limit (padrão 20, máx. 50 por seção). Consulta que estoura o teto de leitura do servidor = 400 pedindo para restringir janela/recursos.";

export const SCHEDULING_TAG = {
  name: "Agenda",
  description:
    "Agenda v2: serviços, recursos, horários livres e agendamentos com as MESMAS regras das telas. Datas: ISO com offset + hora local + timezone. Módulo `scheduling` desligado = 400 «Módulo não habilitado: Agenda». Eventos de webhook: appointment.created, .approved, .confirmed, .rescheduled, .cancelled, .completed, .no_show, .needs_attention, .undone, .restored (payload sem telefone, e-mail nem notas). Atividades no lead: appointment_booked, appointment_changed, appointment_completed. Permissões: valem as da CHAVE (quando gravadas; senão as do membro), iguais em leitura e escrita; a chave nunca pode mais do que declara e fechar a agenda inteira exige manage. Chave de membro de IA só lê (escrever = 403). " + LIMITS,
};

export const SCHEDULING_PATHS: Record<string, Json> = {
  "/api/v1/scheduling/services": {
    get: op("Listar serviços ativos", `Serviços marcáveis da organização (nome, duração, variações, folgas, requisitos de recurso, preço de exibição). ${key("view_own")}`, "schedulingListServices", {
      responses: { "200": ok("Serviços", { type: "object", properties: { timezone: { type: "string" }, services: { type: "array", items: ref("SchedService") } } }), ...READ_ERRORS },
    }),
  },
  "/api/v1/scheduling/resources": {
    get: op("Listar recursos ativos", `Pessoas, salas e equipamentos ativos, com a semana de funcionamento. ${key("view_own")}`, "schedulingListResources", {
      responses: { "200": ok("Recursos", { type: "object", properties: { timezone: { type: "string" }, resources: { type: "array", items: ref("SchedResource") } } }), ...READ_ERRORS },
    }),
  },
  "/api/v1/scheduling/slots": {
    get: op(
      "Buscar horários livres",
      `Horários livres de um serviço numa janela de até 7 dias. NUNCA invente um horário: use os devolvidos aqui. Chave com agenda: edit ou mais recebe a audiência da equipe (resourceNames, reasons, reasonCodes e score); abaixo disso os mesmos horários SEM nome de recurso, motivo nem pontuação. Nunca traz dado de cliente. Serviço inexistente ou de outra organização = 404. reason ≠ ok explica a lista vazia (service_unavailable, no_matching_resource, unverifiable = não deu para verificar com segurança, appointment_unavailable). ${key("view_own")}`,
      "schedulingFindSlots",
      {
        parameters: [
          q("serviceId", "ID do serviço", true),
          q("from", "Primeiro dia (AAAA-MM-DD, fuso da organização)", true),
          q("to", "Último dia (padrão = from + 2, ou seja 3 dias; no máximo 7 dias)"),
          q("period", "Período do dia", false, { type: "string", enum: ["manha", "tarde", "noite", "qualquer"] }),
          q("resourceIds", "IDs de recursos separados por vírgula (restringe o plano)"),
          q("partySize", "Pessoas no mesmo horário (1 a 4)", false, { type: "integer" }),
          q("rescheduleAppointmentId", "Ao remarcar: as alocações desse agendamento não contam"),
          q("variantKey", "Variação do serviço"),
          q("limit", "Máximo de horários (padrão 3, até 50)", false, { type: "integer" }),
        ],
        responses: {
          "200": ok("Horários", {
            type: "object",
            properties: {
              timezone: { type: "string" },
              slots: { type: "array", items: ref("Slot") },
              hasMore: { type: "boolean" },
              relaxed: { type: "boolean" },
              relaxedDays: { type: "array", items: { type: "string" } },
              mode: { type: "string", enum: ["off", "rank", "restrict"] },
              firstPossible: ref("Slot"),
              earliestBookableAt: { type: "number" },
              earliestBookableAtIso: { type: "string" },
              truncated: { type: "boolean" },
              reason: { type: "string", enum: ["ok", "service_unavailable", "no_matching_resource", "unverifiable", "module_off", "no_access", "appointment_unavailable"] },
            },
          }),
          ...READ_ERRORS,
        },
      }
    ),
  },
  "/api/v1/scheduling/appointments": {
    get: op(
      "Listar agendamentos por intervalo",
      `Agendamentos com início entre from e to (datas locais), em ordem cronológica, com paginação por cursor opaco (nextCursor; hasMore). Chave com agenda: view_own só vê os agendamentos em que o membro é o profissional ou o criador; view_all ou mais vê todos. Até 31 dias por consulta (mais = 400); use cursor para paginar. ${key("view_own")}`,
      "schedulingListAppointments",
      {
        parameters: [
          q("from", "Primeiro dia (AAAA-MM-DD)", true),
          q("to", "Último dia (padrão = from; até 366 dias)"),
          q("status", "Filtro de status", false, { type: "string", enum: ["pending_approval", "scheduled", "confirmed", "checked_in", "completed", "no_show", "cancelled", "rescheduled"] }),
          q("limit", "Itens por página (1–100, padrão 50)", false, { type: "integer" }),
          q("cursor", "nextCursor da página anterior"),
        ],
        responses: {
          "200": ok("Página", { type: "object", properties: { timezone: { type: "string" }, appointments: { type: "array", items: ref("SchedAppointment") }, hasMore: { type: "boolean" }, nextCursor: { type: ["string", "null"] } } }),
          ...READ_ERRORS,
        },
      }
    ),
  },
  "/api/v1/scheduling/appointments/get": {
    get: op("Obter um agendamento", `Detalhe com conflitos abertos, quem marcou e as mudanças de status. 404 idêntico para inexistente, de outra organização ou fora da visão da chave. ${key("view_own")}`, "schedulingGetAppointment", {
      parameters: [q("id", "ID do agendamento", true)],
      responses: {
        "200": ok("Agendamento", {
          type: "object",
          properties: {
            appointment: ref("SchedAppointment"),
            openConflicts: { type: "array", items: { type: "object", properties: { _id: { type: "string" }, kind: { type: "string", enum: ["resource_closed", "capacity", "human_confirm", "resource_removed"] }, resourceId: { type: "string" }, localDate: { type: "string" }, createdAt: { type: "number" } } } },
            canEdit: { type: "boolean" },
            createdByName: { type: "string" },
            statusActors: { type: "array", items: { type: "object", properties: { status: { type: "string" }, at: { type: "number" }, actorName: { type: "string" }, undo: { type: "boolean" } } } },
          },
        }),
        ...READ_ERRORS,
        "404": NOT_FOUND,
      },
    }),
  },
  "/api/v1/scheduling/pending": {
    get: op("Pendências da agenda", `Aprovações de proposta (IA/cliente), conflitos abertos, atendimentos sem desfecho e sugestões de 1 toque (sugestões só com view_all ou mais). Até limit por seção (padrão 20, máx. 50); capped diz que há mais. ${key("view_own")}`, "schedulingPending", {
      parameters: [q("limit", "Itens por seção (padrão 20, máx. 50)", false, { type: "integer" })],
      responses: {
        "200": ok("Pendências", {
          type: "object",
          properties: {
            timezone: { type: "string" },
            approvals: { type: "array", items: ref("SchedAppointment") },
            conflicts: { type: "array", items: { type: "object", additionalProperties: true, description: "Conflito (_id, kind, appointmentId, resourceIds, localDate, suggestions, createdAt) com o agendamento embutido" } },
            noOutcome: { type: "array", items: ref("SchedAppointment") },
            suggestions: { type: "array", items: { type: "object", additionalProperties: true } },
            capped: { type: "object", properties: { approvals: { type: "boolean" }, conflicts: { type: "boolean" }, noOutcome: { type: "boolean" }, suggestions: { type: "boolean" } } },
          },
        }),
        ...READ_ERRORS,
      },
    }),
  },
  "/api/v1/scheduling/appointments/preview": {
    post: op(
      "Pré-visualizar um agendamento (não grava)",
      `Devolve o plano de recursos e os avisos que a marcação teria. SEMPRE pré-visualize antes de marcar. Com rescheduleAppointmentId simula a remarcação desse agendamento. Regra impeditiva = 409 com alternatives. ${key("edit")}`,
      "schedulingPreview",
      {
        requestBody: body(["serviceId"], { ...BOOK_PROPS, rescheduleAppointmentId: str("Simula a remarcação deste agendamento") }),
        responses: {
          "200": ok("Prévia", { type: "object", properties: { preview: { type: "boolean", const: true }, plan: { type: "array", items: { type: "object", properties: { role: { type: "string" }, resourceId: { type: "string" }, units: { type: "number" }, resourceName: { type: "string" } } } }, warnings: { type: "array", items: ref("SchedViolation") }, duplicateOf: { type: "string" } } }),
          ...READ_ERRORS,
          "404": NOT_FOUND,
          "409": RULES_409,
        },
      }
    ),
  },
  "/api/v1/scheduling/appointments/book": {
    post: op(
      "Marcar horário",
      `Cria o agendamento (origem api; o ator é o membro dono da chave). Idempotency-Key (cabeçalho) ou requestId (corpo) é OBRIGATÓRIO: a mesma chave com os mesmos dados devolve o MESMO agendamento (200, created: false); a mesma chave com outros dados = 409 idempotency_key_reused (com allowResourceFallback: true a 1ª chamada pode cair no plano alternativo; repetir com a mesma chave e os mesmos resourceIds dá idempotency_key_reused, repita sem resourceIds). Regra impeditiva = 409 sched_rules com alternatives. force só aceita avisos. Efeitos: auditoria, atividade no lead, webhook appointment.created. Idempotência: a chave vale para serviço, início, contato/lead/conversa, variantKey e, quando resourceIds é enviado, o conjunto de recursos (ordem não importa); notes diferente NÃO conta (devolve o agendamento já criado). Marcar em grupo: companions (1 a 3, { guestName, resourceIds? }) marca a pessoa principal e os acompanhantes juntos, tudo ou nada, idempotente por grupo (appointmentIds, partySize). Chave de membro de IA lê, mas escrever = 403. ${key("edit")}`,
      "schedulingBook",
      {
        parameters: [IDEMPOTENCY_HEADER],
        requestBody: body(["serviceId"], { ...BOOK_PROPS, requestId: str("Chave de idempotência (alternativa ao cabeçalho)"), companions: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", required: ["guestName"], properties: { guestName: str("Nome do acompanhante (até 80 caracteres)"), resourceIds: BOOK_PROPS.resourceIds } }, description: "Marcar em grupo (casal etc.): pessoa principal + acompanhantes, tudo ou nada" } }),
        responses: {
          "201": ok("Agendamento criado", ref("SchedBooked")),
          "200": ok("Repetição idempotente: o agendamento já existia", ref("SchedBooked")),
          ...READ_ERRORS,
          "404": NOT_FOUND,
          "409": RULES_409,
        },
      }
    ),
  },
  "/api/v1/scheduling/appointments/reschedule": {
    post: op(
      "Remarcar",
      `Cria o novo agendamento e encerra o antigo (rescheduled) na mesma transação. Idempotency-Key/requestId opcional (recomendado para repetição segura). Sem resourceIds, mantém os recursos ATUAIS e nunca os troca: sala/profissional fechado ou bloqueado no novo horário = 409 de aviso (violations com severity warn; só passa com force explícito), cheio = 409 com alternatives; para mudar de sala envie resourceIds (de um Slot) ou allowResourceFallback: true. Regra impeditiva = 409. ${key("edit")}`,
      "schedulingReschedule",
      {
        parameters: [IDEMPOTENCY_HEADER],
        requestBody: body(["appointmentId"], { appointmentId: str("Agendamento a remarcar"), ...WHEN_PROPS, resourceIds: BOOK_PROPS.resourceIds, allowResourceFallback: BOOK_PROPS.allowResourceFallback, force: BOOK_PROPS.force, requestId: str("Chave de idempotência") }),
        responses: { "200": ok("Remarcado (appointmentId = o novo)", ref("SchedBooked")), ...READ_ERRORS, "404": NOT_FOUND, "409": RULES_409 },
      }
    ),
  },
  "/api/v1/scheduling/appointments/cancel": {
    post: op("Cancelar", `Cancela o agendamento (webhook appointment.cancelled; lateCancel indica cancelamento tardio). ${key("edit")}`, "schedulingCancel", {
      requestBody: body(["appointmentId"], { appointmentId: str("Agendamento"), reason: str("Motivo (até 200 caracteres)"), cancelledBy: { type: "string", enum: ["staff", "client"], description: "Quem cancelou (padrão staff)" } }),
      responses: { "200": ok("Cancelado", { type: "object", properties: { success: { type: "boolean" }, lateCancel: { type: "boolean" } } }), ...READ_ERRORS, "404": NOT_FOUND },
    }),
  },
  "/api/v1/scheduling/appointments/status": {
    post: op(
      "Mudar status (confirmar, chegou, atendido, faltou, aprovar, recusar)",
      `to: scheduled (aprova uma proposta pendente), confirmed, checked_in, completed ou no_show. action: approve (= scheduled) ou reject (recusa uma proposta PENDENTE = cancela). reject só vale para status pending_approval: outro status = 400 «Este agendamento não é uma proposta pendente; use cancelar» e nada muda (para cancelar um agendamento ativo use /appointments/cancel). Transição inválida = 400. ${key("edit")}`,
      "schedulingSetStatus",
      {
        requestBody: body(["appointmentId"], { appointmentId: str("Agendamento"), to: { type: "string", enum: ["scheduled", "confirmed", "checked_in", "completed", "no_show"] }, action: { type: "string", enum: ["approve", "reject"] }, reason: str("Motivo, em reject") }),
        responses: { "200": ok("Feito", { type: "object", properties: { success: { type: "boolean" }, lateCancel: { type: "boolean", description: "Só em reject" } } }), ...READ_ERRORS, "404": NOT_FOUND },
      }
    ),
  },
  "/api/v1/scheduling/appointments/undo-status": {
    post: op("Desfazer a última mudança de status", `Volta ao estado anterior (restoredTo). Se o horário foi tomado nesse meio-tempo, 409. ${key("edit")}`, "schedulingUndoStatus", {
      requestBody: body(["appointmentId"], { appointmentId: str("Agendamento") }),
      responses: { "200": ok("Desfeito", { type: "object", properties: { success: { type: "boolean" }, restoredTo: { type: "string" } } }), ...READ_ERRORS, "404": NOT_FOUND, "409": RULES_409 },
    }),
  },
  "/api/v1/scheduling/appointments/resources": {
    post: op("Trocar sala, profissional ou equipamento", `Mesmas regras de capacidade de marcar. ${key("edit")}`, "schedulingReassign", {
      requestBody: body(["appointmentId", "resourceIds"], { appointmentId: str("Agendamento"), resourceIds: BOOK_PROPS.resourceIds, force: BOOK_PROPS.force }),
      responses: { "200": ok("Trocado", ref("SchedBooked")), ...READ_ERRORS, "404": NOT_FOUND, "409": RULES_409 },
    }),
  },
  "/api/v1/scheduling/resources/day": {
    post: op(
      "Fechar recurso (ou horário especial, extra, bloqueio) com prévia",
      `mode: preview (padrão, NÃO grava) ou commit. Fluxo seguro: faça a prévia, leia affected e items, e só então commit com expectedAffected = affected e acceptAffected = true (contagem diferente = recusa 400). Afetados: sala e equipamento realocam; pessoa vira conflito para resolver. Acima de 40 afetados o trabalho segue em lotes: acompanhe por GET /scheduling/closures/get?runId=. Sem resourceId (agenda inteira ou um tipo de recurso) exige agenda: manage. ${key("edit")}`,
      "schedulingCloseResource",
      {
        requestBody: body(["fromLocalDate"], {
          resourceId: str("Recurso (ausente = agenda inteira ou, com resourceKind, todo o tipo: exige manage)"),
          resourceKind: { type: "string", enum: ["person", "room", "equipment"] },
          fromLocalDate: str("Primeiro dia (AAAA-MM-DD)"),
          toLocalDate: str("Último dia (até 60 dias)"),
          kind: { type: "string", enum: ["closed", "custom", "extra", "block"], description: "Padrão closed (dia inteiro)" },
          intervals: { type: "array", maxItems: 6, items: { type: "object", properties: { startMin: { type: "integer" }, endMin: { type: "integer" } } }, description: "Minutos do dia; obrigatório em custom, extra e block" },
          reasonCode: { type: "string", enum: ["no_staff", "maintenance", "day_off", "holiday", "other"] },
          reason: str("Motivo livre (até 120 caracteres)"),
          mode: { type: "string", enum: ["preview", "commit"], default: "preview" },
          acceptAffected: { type: "boolean" },
          expectedAffected: { type: "number", description: "Contagem vista na prévia" },
        }),
        responses: { "200": ok("Prévia ou resultado", ref("SchedClosureResult")), ...READ_ERRORS, "404": NOT_FOUND },
      }
    ),
  },
  "/api/v1/scheduling/resources/reopen": {
    post: op("Reabrir recurso com prévia", `Remove as exceções MANUAIS do escopo nas datas (só o kind pedido, padrão closed); não desfaz realocações. Mesma prévia (mode) e mesmo manage para a agenda inteira. ${key("edit")}`, "schedulingReopen", {
      requestBody: body(["fromLocalDate"], {
        resourceId: str("Recurso (ausente = agenda inteira ou tipo: exige manage)"),
        resourceKind: { type: "string", enum: ["person", "room", "equipment"] },
        fromLocalDate: str("Primeiro dia"),
        toLocalDate: str("Último dia"),
        kind: { type: "string", enum: ["closed", "custom", "extra", "block"] },
        mode: { type: "string", enum: ["preview", "commit"], default: "preview" },
        acceptAffected: { type: "boolean" },
        expectedAffected: { type: "number" },
      }),
      responses: { "200": ok("Prévia ou resultado", ref("SchedClosureResult")), ...READ_ERRORS, "404": NOT_FOUND },
    }),
  },
  "/api/v1/scheduling/closures/get": {
    get: op("Andamento de um fechamento em lotes", `Estado e totais do fechamento (runId vem de resources/day). ${key("view_all")}`, "schedulingClosureRun", {
      parameters: [q("runId", "ID do fechamento", true)],
      responses: { "200": ok("Fechamento", { type: "object", properties: { run: ref("SchedClosureRun") } }), ...READ_ERRORS, "404": NOT_FOUND },
    }),
  },
  "/api/v1/scheduling/conflicts/resolve": {
    post: op("Resolver conflito", `action.type: resource (escolher outro recurso), reschedule (novo horário), cancel ou manual (marcar como resolvido, com nota). Regra impeditiva = 409. ${key("edit")}`, "schedulingResolveConflict", {
      requestBody: body(["conflictId", "action"], {
        conflictId: str("Conflito (de GET /scheduling/pending)"),
        action: { type: "object", required: ["type"], properties: { type: { type: "string", enum: ["resource", "reschedule", "cancel", "manual"] }, resourceIds: BOOK_PROPS.resourceIds, allowResourceFallback: BOOK_PROPS.allowResourceFallback, ...WHEN_PROPS, force: BOOK_PROPS.force, reason: str("Em cancel"), note: str("Em manual") } },
      }),
      responses: { "200": ok("Resolvido", { type: "object", properties: { success: { type: "boolean" } } }), ...READ_ERRORS, "404": NOT_FOUND, "409": RULES_409 },
    }),
  },
};

const timesProps = {
  startsAt: { type: "string", description: "Início ISO 8601 com offset do fuso da organização" },
  startsAtLocal: { type: "string", description: "Início AAAA-MM-DDTHH:mm" },
  endsAt: { type: "string" },
  endsAtLocal: { type: "string" },
  timezone: { type: "string", description: "Fuso IANA da organização" },
};
const WEBHOOK_EVENTS = ["appointment.created", "appointment.approved", "appointment.confirmed", "appointment.rescheduled", "appointment.cancelled", "appointment.completed", "appointment.no_show", "appointment.needs_attention", "appointment.undone", "appointment.restored"];

export const SCHEDULING_SCHEMAS: Record<string, Json> = {
  Slot: {
    type: "object",
    description: "Horário oferecido. Formato ÚNICO da busca e das alternatives do 409.",
    properties: {
      startTime: { type: "number" },
      endTime: { type: "number" },
      localDate: { type: "string" },
      label: { type: "string", description: "Texto curto com o dia da semana, ex.: «seg, 15/06 às 10:00»" },
      resourceIds: { type: "array", items: { type: "string" }, description: "Plano de recursos; devolva em resourceIds ao marcar" },
      resourceNames: { type: "array", items: { type: "string" }, description: "Só chave com agenda: edit+" },
      score: { type: "number", description: "Só chave com agenda: edit+ (0 nas demais)" },
      reasons: { type: "array", items: { type: "string" }, description: "Por que este horário (PT-BR). Só edit+" },
      reasonCodes: { type: "array", items: { type: "string", enum: ["ADJACENT", "ADJACENT_BEFORE", "ADJACENT_AFTER", "EDGE_OF_DAY", "DEAD_GAP", "NEW_RESOURCE", "EARLY", "BALANCE", "PREFERENCE"] }, description: "Motivos estruturados. Só edit+" },
      ...timesProps,
    },
  },
  SchedViolation: {
    type: "object",
    properties: {
      code: { type: "string", enum: ["CAPACITY_EXCEEDED", "DURATION_TOO_LONG", "WRONG_ORG_OR_INACTIVE", "RESOURCE_CLOSED", "OUTSIDE_HOURS", "RESOURCE_BLOCKED", "BUFFER_OVERLAP", "INTERNAL_EVENT_OVERLAP", "CLIENT_OVERLAP", "MAX_ACTIVE_PER_CONTACT", "MAX_ADVANCE", "PAST_START"] },
      severity: { type: "string", enum: ["block", "warn"], description: "warn pode ser aceito com force; block nunca" },
      message: { type: "string" },
    },
  },
  SchedRulesError: {
    type: "object",
    description: "Corpo do 409. code = sched_rules (regra) ou idempotency_key_reused (nesse caso só error e code).",
    properties: {
      error: { type: "string", description: "Mensagem da primeira violação" },
      code: { type: "string", enum: ["sched_rules", "idempotency_key_reused"] },
      violations: { type: "array", items: ref("SchedViolation") },
      alternatives: { type: "array", maxItems: 3, items: ref("Slot"), description: "Até 3 horários do mesmo dia no formato Slot" },
    },
  },
  SchedBooked: {
    type: "object",
    properties: {
      success: { type: "boolean" },
      appointmentId: { type: "string" },
      status: { type: "string", enum: ["pending_approval", "scheduled"] },
      appointmentIds: { type: "array", items: { type: "string" }, description: "Só em grupo (companions): todos os agendamentos do grupo" },
      partySize: { type: "integer", description: "Só em grupo" },
      created: { type: "boolean", description: "false na repetição idempotente" },
      duplicate: { type: "boolean", description: "true quando já havia o mesmo horário do mesmo cliente e serviço" },
      inConflict: { type: "boolean" },
      warnings: { type: "array", items: ref("SchedViolation"), description: "Avisos aceitos com force" },
    },
  },
  SchedService: {
    type: "object",
    properties: {
      _id: { type: "string" },
      name: { type: "string" },
      durationMin: { type: "number" },
      variants: { type: "array", items: { type: "object", properties: { key: { type: "string" }, name: { type: "string" }, durationMin: { type: "number" } } } },
      bufferBeforeMin: { type: "number" },
      bufferAfterMin: { type: "number" },
      requirements: { type: "array", items: { type: "object", properties: { role: { type: "string" }, kind: { type: "string", enum: ["person", "room", "equipment"] }, resourceIds: { type: "array", items: { type: "string" } }, tag: { type: "string" }, units: { type: "number" }, exclusive: { type: "boolean" } } } },
      priceCents: { type: "number" },
      active: { type: "boolean" },
      sortOrder: { type: "number" },
    },
    additionalProperties: true,
  },
  SchedResource: {
    type: "object",
    properties: {
      _id: { type: "string" },
      kind: { type: "string", enum: ["person", "room", "equipment"] },
      name: { type: "string" },
      capacity: { type: "number" },
      teamMemberId: { type: "string" },
      weekly: { type: "array", items: { type: "object", properties: { weekday: { type: "integer", description: "0 = domingo" }, startMin: { type: "integer" }, endMin: { type: "integer" } } } },
      tags: { type: "array", items: { type: "string" } },
      active: { type: "boolean" },
      sortOrder: { type: "number" },
    },
    additionalProperties: true,
  },
  SchedAppointment: {
    type: "object",
    description: "Projeção da API (estável): sem organização, _creationTime, blockStart/blockEnd, createdBy/approvedBy, token de lembrete, chave de idempotência nem identificador de calendário; notes só no detalhe.",
    properties: {
      _id: { type: "string" },
      serviceId: { type: "string" },
      serviceName: { type: "string" },
      variantKey: { type: "string" },
      kind: { type: "string", enum: ["normal", "fit_in", "untimed"] },
      startTime: { type: "number" },
      endTime: { type: "number" },
      localDate: { type: "string" },
      status: { type: "string", enum: ["pending_approval", "scheduled", "confirmed", "checked_in", "completed", "no_show", "cancelled", "rescheduled"] },
      origin: { type: "string", enum: ["staff", "ai", "public", "api", "human_message", "waitlist", "import"] },
      contactId: { type: "string" },
      leadId: { type: "string" },
      conversationId: { type: "string" },
      contactName: { type: "string" },
      guestName: { type: "string" },
      partyKey: { type: "string" },
      resources: { type: "array", items: { type: "object", properties: { resourceId: { type: "string" }, role: { type: "string" }, name: { type: "string" }, allocated: { type: "boolean", description: "false = em conflito, sem vaga reservada" } } } },
      notes: { type: "string", description: "Só no detalhe" },
      forcedRules: { type: "array", items: { type: "string" } },
      needsAttention: { type: "object", properties: { code: { type: "string" }, at: { type: "number" } } },
      rescheduledFromId: { type: "string" },
      rescheduledToId: { type: "string" },
      rescheduleOfId: { type: "string" },
      cancelledByClass: { type: "string", enum: ["staff", "client", "ai", "system"] },
      cancelReason: { type: "string" },
      lateCancel: { type: "boolean" },
      statusChangedAt: { type: "number" },
      createdAt: { type: "number" },
      updatedAt: { type: "number" },
      ...timesProps,
    },
    additionalProperties: true,
  },
  SchedClosureRun: {
    type: "object",
    description: "Andamento de um fechamento em lotes. Só campos de andamento (sem organização, autor nem erro interno).",
    properties: {
      _id: { type: "string" },
      kind: { type: "string", enum: ["resource_closed", "resource_removed", "capacity"] },
      resourceId: { type: "string" },
      resourceKind: { type: "string", enum: ["person", "room", "equipment"] },
      fromLocalDate: { type: "string" },
      toLocalDate: { type: "string" },
      status: { type: "string", enum: ["running", "done", "failed"] },
      truncated: { type: "boolean" },
      total: { type: "number" },
      totalIsPartial: { type: "boolean" },
      processed: { type: "number" },
      reallocated: { type: "number" },
      conflicts: { type: "number" },
      failed: { type: "number" },
      failureMessage: { type: "string", description: "Só quando status = failed: mensagem genérica" },
      createdAt: { type: "number" },
      updatedAt: { type: "number" },
      completedAt: { type: "number" },
    },
  },
  SchedClosureResult: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["preview", "commit"] },
      dates: { type: "array", items: { type: "string" } },
      affected: { type: "number", description: "Agendamentos que o fechamento atinge; use em expectedAffected" },
      reallocated: { type: "number" },
      conflicts: { type: "number" },
      pending: { type: "number", description: "Ainda em lotes (>0: acompanhe por runId)" },
      simulated: { type: "number" },
      capped: { type: "boolean" },
      exceptionIds: { type: "array", items: { type: "string" } },
      runId: { type: "string" },
      removed: { type: "number", description: "Reabrir: exceções removidas" },
      restorable: { type: "number" },
      reason: { type: "string", enum: ["covered_by_org_closure", "nothing_to_reopen"] },
      items: { type: "array", items: { type: "object", additionalProperties: true, description: "appointmentId, resourceIds, resourceNames, startTime (+ startsAt/startsAtLocal), localDate, serviceName, contactName, outcome (reallocated, conflict, skipped, unknown), toResourceName, suggestions (Slot[])" } },
    },
  },
  AppointmentWebhookPayload: {
    type: "object",
    description: `Corpo de data nos eventos ${WEBHOOK_EVENTS.join(", ")}. Sem telefone, e-mail nem notas.`,
    properties: {
      appointmentId: { type: "string" },
      status: { type: "string" },
      origin: { type: "string" },
      serviceName: { type: "string" },
      startsAt: { type: "string", description: "ISO com offset" },
      startsAtLocal: { type: "string" },
      timezone: { type: "string" },
      resources: { type: "array", items: { type: "object", properties: { name: { type: "string" }, role: { type: "string" } } } },
      leadId: { type: "string" },
      contactId: { type: "string" },
      previousAppointmentId: { type: "string", description: "Remarcação: o antigo (em .restored, o novo que foi desfeito)" },
    },
  },
};

/** Eventos de webhook de agendamento (a mesma lista da porta; `webhooks` do OpenAPI 3.1). */
export const SCHEDULING_WEBHOOKS: Record<string, Json> = Object.fromEntries(
  WEBHOOK_EVENTS.map((event) => [
    event,
    {
      post: {
        tags: ["Agenda"],
        summary: `Evento ${event}`,
        description: "Assine em Configurações > Webhooks (ou POST na API de webhooks) com este nome em events, ou com \"*\".",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { event: { type: "string", const: event }, timestamp: { type: "number" }, data: ref("AppointmentWebhookPayload") } } } } },
        responses: { "200": { description: "Recebido" } },
      },
    },
  ])
);

export const SCHEDULING_WEBHOOK_EVENTS: readonly string[] = WEBHOOK_EVENTS;
