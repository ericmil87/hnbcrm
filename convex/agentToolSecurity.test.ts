/**
 * Teste de BUILD da superfície de tools de IA (camada 3 da defesa).
 * Falha o build se:
 *  - uma tool exposta tiver nome da TOOL_DENYLIST (funções que retornam segredos);
 *  - qualquer campo de saída (resultFields) casar o padrão de segredo;
 *  - `parameters` expuser ao modelo um campo de escopo injetado pelo runtime;
 *  - a projeção deixar passar um campo-segredo plantado num resultado.
 */
import { describe, expect, test } from "vitest";
import {
  ALL_AGENT_TOOLS,
  ATTENDANT_TOOLS,
  GROUP_AGENT_TOOLS,
  INJECTED_PARAM_NAMES,
  projectToolResult,
} from "./lib/agentTools";
import { SECRET_FIELD_PATTERN, TOOL_DENYLIST } from "./lib/agentSecurity";

describe("superfície de tools de IA (teste de build)", () => {
  test("nenhuma tool exposta está na denylist", () => {
    const exposed = new Set(ALL_AGENT_TOOLS.map((t) => t.name));
    for (const denied of TOOL_DENYLIST) {
      expect(exposed.has(denied), `tool proibida exposta: ${denied}`).toBe(false);
    }
  });

  test("nomes de tool são únicos", () => {
    const names = ALL_AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("nenhum resultField casa o padrão de segredo", () => {
    for (const tool of ALL_AGENT_TOOLS) {
      expect(tool.resultFields.length, `${tool.name} precisa declarar resultFields`).toBeGreaterThan(0);
      for (const field of tool.resultFields) {
        expect(
          SECRET_FIELD_PATTERN.test(field),
          `${tool.name}.${field} casa o padrão de segredo`
        ).toBe(false);
      }
    }
  });

  test("parameters não expõem campos de escopo injetados pelo runtime", () => {
    // Exceção: getLeadDetail/updateLead etc. do COPILOTO aceitam leadId do
    // modelo de propósito (o copiloto navega a org com o RBAC do usuário e o
    // executor re-valida a org via assertAgentCan). Já conversationId /
    // organizationId / *MemberId NUNCA são o modelo que fornece — e para o
    // ATENDENTE nem leadId/contactId (escopo vem do gatilho).
    // `groupChatId`/`groupPostId`: o copiloto os recebe do modelo (ele navega a
    // org), o agente DE GRUPO nunca — a sala dele vem do claim.
    const copilotAllowed = new Set(["leadId", "contactId", "groupChatId", "groupPostId"]);
    // `taskId`/`followUpId` (v0.60) não são exceção de ninguém: nem o copiloto
    // recebe id de tarefa do modelo hoje, e o follow-up do atendente é
    // endereçado por ÍNDICE ORDINAL resolvido no servidor.
    for (const tool of ALL_AGENT_TOOLS) {
      const props = Object.keys(
        (tool.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      );
      for (const injected of INJECTED_PARAM_NAMES) {
        if (tool.audience === "copilot" && copilotAllowed.has(injected)) continue;
        expect(
          props.includes(injected),
          `${tool.name} expõe parâmetro de escopo '${injected}' ao modelo`
        ).toBe(false);
      }
    }
  });

  test("atendente: zero tools destrutivas, zero listagem org-wide", () => {
    for (const tool of [...ATTENDANT_TOOLS, ...GROUP_AGENT_TOOLS]) {
      expect(tool.effect, `${tool.name} não pode ser destrutiva`).not.toBe("destructive");
      expect(
        /list|search|getContacts|getConversations/i.test(tool.name),
        `${tool.name} parece uma tool de listagem org-wide — proibido para o atendente`
      ).toBe(false);
    }
  });

  test("projectToolResult barra campos-segredo plantados no resultado", () => {
    // Simula um executor descuidado devolvendo o doc cru de um channelConfig.
    const poisoned = {
      status: "ok",
      messageId: "msg_1",
      mode: "suggest",
      accessTokenEncrypted: "v1:iv:cipher",
      bridgeTokenEncrypted: "v1:iv:cipher",
      verifyToken: "plain-secret",
      apiKey: "sk-leak",
    };
    for (const tool of ALL_AGENT_TOOLS) {
      const projected = projectToolResult(tool, poisoned);
      const keys = Object.keys(projected);
      for (const key of keys) {
        expect(
          SECRET_FIELD_PATTERN.test(key),
          `${tool.name}: projeção deixou passar campo-segredo '${key}'`
        ).toBe(false);
      }
    }
  });

  // ── Agente de grupo (F4) ──
  // A sala tem gente de fora da empresa e a conversa NÃO tem lead: a superfície
  // é de três tools, e qualquer coisa a mais aqui é um caminho novo do texto de
  // um desconhecido para o banco de dados.
  test("agente de grupo: exatamente três tools, nenhuma de lead/contato", () => {
    expect(GROUP_AGENT_TOOLS.map((t) => t.name).sort()).toEqual([
      "flagOpportunity",
      "replyToGroup",
      "requestGroupHandoff",
    ]);
    for (const tool of GROUP_AGENT_TOOLS) {
      expect(tool.audience).toBe("groupAgent");
      expect(
        /lead|contact|campaign|task|board|field/i.test(tool.name),
        `${tool.name} parece tocar CRM fora da sala`
      ).toBe(false);
    }
  });

  test("agente de grupo: nenhuma tool do ATENDENTE vaza para o grupo", () => {
    const groupNames = new Set(GROUP_AGENT_TOOLS.map((t) => t.name));
    for (const tool of ATTENDANT_TOOLS) {
      expect(groupNames.has(tool.name), `${tool.name} do 1:1 apareceu no grupo`).toBe(false);
    }
  });

  test("tools de grupo do copiloto não devolvem nada do canal", () => {
    // O token do gateway mora em `channelConfigs`. Nenhum retorno declarado
    // pode sequer nomear o canal — o executor monta tudo campo a campo.
    const groupTools = ALL_AGENT_TOOLS.filter((t) =>
      /group/i.test(t.name) || t.audience === "groupAgent"
    );
    expect(groupTools.length).toBeGreaterThan(5);
    for (const tool of groupTools) {
      for (const field of tool.resultFields) {
        expect(
          /channelConfig|bridgeToken|bridgeBaseUrl|instance/i.test(field),
          `${tool.name}.${field} devolveria dado do canal`
        ).toBe(false);
      }
      const projected = projectToolResult(tool, {
        status: "ok",
        bridgeTokenEncrypted: "v1:iv:cipher",
        bridgeBaseUrl: "https://wuzapi.example.com",
        channelConfigId: "abc",
      });
      expect(Object.keys(projected)).not.toContain("bridgeTokenEncrypted");
      expect(Object.keys(projected)).not.toContain("bridgeBaseUrl");
      expect(Object.keys(projected)).not.toContain("channelConfigId");
    }
  });

  // ── Follow-up da IA (v0.60) ──
  test("atendente: resolveFollowUp existe e não recebe id nenhum do modelo", () => {
    const tool = ATTENDANT_TOOLS.find((t) => t.name === "resolveFollowUp");
    expect(tool, "resolveFollowUp precisa existir no registry do atendente").toBeTruthy();
    const props = Object.keys(
      (tool!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    );
    // O modelo endereça o follow-up por índice ordinal — jamais por id.
    expect(props).toContain("index");
    for (const injected of ["taskId", "followUpId", "conversationId", "leadId"]) {
      expect(props.includes(injected), `resolveFollowUp expõe '${injected}'`).toBe(false);
    }
  });

  test("scheduleFollowUp não devolve id de tarefa ao modelo", () => {
    const tool = ATTENDANT_TOOLS.find((t) => t.name === "scheduleFollowUp")!;
    for (const field of tool.resultFields) {
      expect(
        /^(taskId|followUpId|leadId|contactId|conversationId)$/.test(field),
        `scheduleFollowUp devolveria o id '${field}' ao modelo`
      ).toBe(false);
    }
  });

  test("taskId e followUpId estão na lista de parâmetros injetados", () => {
    expect(INJECTED_PARAM_NAMES).toContain("taskId");
    expect(INJECTED_PARAM_NAMES).toContain("followUpId");
  });

  test("toda tool declara permissão RBAC", () => {
    for (const tool of ALL_AGENT_TOOLS) {
      expect(tool.permission.category).toBeTruthy();
      expect(tool.permission.level).toBeTruthy();
    }
  });
});

// ── Agenda v2 (D1): tools de horário do atendente ──
describe("tools de agenda do atendente (D1)", () => {
  const sched = ATTENDANT_TOOLS.filter((t) => ["findAvailableTimes", "bookOfferedTime"].includes(t.name));

  test("exatamente as duas tools do D1 (remarcar, cancelar e confirmar presença são D1b/F1)", () => {
    expect(sched.map((t) => t.name)).toEqual(["findAvailableTimes", "bookOfferedTime"]);
    for (const absent of ["rescheduleMyAppointment", "cancelMyAppointment", "confirmMyAttendance", "listAppointments", "getAppointment"]) {
      expect(ALL_AGENT_TOOLS.some((t) => t.name === absent && t.audience === "attendant")).toBe(false);
    }
  });

  test("os ids da agenda nunca são parâmetro (INJECTED_PARAM_NAMES) e a reserva só aceita o código da oferta", () => {
    for (const name of ["appointmentId", "serviceId", "resourceId", "offerId"]) {
      expect((INJECTED_PARAM_NAMES as readonly string[]).includes(name), name).toBe(true);
    }
    for (const tool of sched) {
      const props = Object.keys((tool.parameters as { properties: Record<string, unknown> }).properties);
      for (const injected of INJECTED_PARAM_NAMES) expect(props, `${tool.name} expõe ${injected}`).not.toContain(injected);
    }
    const book = sched.find((t) => t.name === "bookOfferedTime")!;
    expect(Object.keys((book.parameters as { properties: object }).properties)).toEqual(["offer"]);
  });

  test("a leitura roda sem escrita; a reserva é de escrita (nunca destrutiva) e pede a permissão `agenda`", () => {
    expect(sched.find((t) => t.name === "findAvailableTimes")).toMatchObject({ effect: "read", permission: { category: "agenda", level: "view_own" } });
    expect(sched.find((t) => t.name === "bookOfferedTime")).toMatchObject({ effect: "write", permission: { category: "agenda", level: "edit" } });
  });

  test("o retorno ao modelo é só texto: nenhum campo pode carregar nome de recurso, de cliente ou id", () => {
    for (const tool of sched) {
      expect(tool.resultFields).toEqual(["status", "resultado", "error", "proximo_passo", "ha_mais"]);
      const projected = projectToolResult(tool, { status: "ok", resultadoX: 1, resourceName: "Sala Rosa", contactName: "Ana", appointmentId: "x", resourceIds: ["y"], score: 40 });
      expect(Object.keys(projected)).toEqual(["status"]);
    }
  });

  test("não entram no agente de grupo", () => {
    expect(GROUP_AGENT_TOOLS.some((t) => ["findAvailableTimes", "bookOfferedTime"].includes(t.name))).toBe(false);
  });
});
