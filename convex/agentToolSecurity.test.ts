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
    const copilotAllowed = new Set(["leadId", "contactId"]);
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
    for (const tool of ATTENDANT_TOOLS) {
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

  test("toda tool declara permissão RBAC", () => {
    for (const tool of ALL_AGENT_TOOLS) {
      expect(tool.permission.category).toBeTruthy();
      expect(tool.permission.level).toBeTruthy();
    }
  });
});
