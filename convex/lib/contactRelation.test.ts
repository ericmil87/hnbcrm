import { describe, expect, test } from "vitest";
import {
  CONTACT_RELATIONS,
  CONTACT_RELATION_LABEL,
  aiBlockReason,
  autoLeadArchivePatch,
  defaultRestoreLead,
  effectiveRelation,
  isContactRelation,
  isOffBusiness,
} from "./contactRelation";
import { AI_STATE_REASON_CODES } from "./aiStateReasons";
import { CONTACT_RELATION_EXPORT_LABELS } from "./exportColumns";
import { CONTACT_RELATION_IMPORT_VALUES, normalizeLabel } from "./importMapping";
import { conversationAiMode } from "./conversationAiMode";
import { buildNotificationCard, parseCallbackData, type CardContext } from "./telegramNotifications";

describe("contactRelation (puro)", () => {
  test("só os cinco tipos fora do comercial bloqueiam; ausente e customer não", () => {
    expect(isOffBusiness(undefined)).toBe(false);
    expect(isOffBusiness(null)).toBe(false);
    expect(isOffBusiness("customer")).toBe(false);
    for (const r of ["personal", "team", "supplier", "partner", "automated"] as const) {
      expect(isOffBusiness(r)).toBe(true);
      expect(aiBlockReason(r)).toBe("contato_nao_cliente");
    }
    expect(aiBlockReason("customer")).toBeNull();
    expect(isContactRelation("personal")).toBe(true);
    expect(isContactRelation("family")).toBe(false);
  });

  test("motivo da IA tem paridade com AI_STATE_REASON_CODES", () => {
    expect(AI_STATE_REASON_CODES).toContain("contato_nao_cliente");
  });

  test("contato lido manda; sem contato vale o espelho", () => {
    expect(effectiveRelation({ relation: undefined }, { contactRelation: "personal" })).toBeUndefined();
    expect(effectiveRelation(null, { contactRelation: "personal" })).toBe("personal");
  });

  test("lead automático nasce arquivado só para fora do comercial", () => {
    expect(autoLeadArchivePatch("team", 10)).toEqual({ archivedAt: 10 });
    expect(autoLeadArchivePatch("customer", 10)).toEqual({});
    expect(autoLeadArchivePatch(undefined, 10)).toEqual({});
  });

  test("restoreLead padrão: só ao sair de fora do comercial para cliente/sem tipo", () => {
    expect(defaultRestoreLead("personal", "customer")).toBe(true);
    expect(defaultRestoreLead("personal", null)).toBe(true);
    expect(defaultRestoreLead(null, "customer")).toBe(false);
    expect(defaultRestoreLead("personal", "team")).toBe(false);
    expect(defaultRestoreLead("personal", "team")).toBe(false);
  });

  test("paridade dos rótulos com export e import (módulos sem Convex)", () => {
    expect(CONTACT_RELATION_LABEL).toEqual({
      customer: "Lead",
      personal: "Pessoal",
      team: "Equipe",
      supplier: "Fornecedor",
      partner: "Parceiro",
      automated: "Robô",
    });
    expect(CONTACT_RELATION_EXPORT_LABELS).toEqual(CONTACT_RELATION_LABEL);
    for (const relation of CONTACT_RELATIONS) {
      // O rótulo exportado volta pelo import como o mesmo valor canônico.
      expect(CONTACT_RELATION_IMPORT_VALUES[normalizeLabel(CONTACT_RELATION_LABEL[relation])]).toBe(relation);
      expect(CONTACT_RELATION_IMPORT_VALUES[relation]).toBe(relation);
    }
    for (const value of Object.values(CONTACT_RELATION_IMPORT_VALUES)) {
      expect(isContactRelation(value)).toBe(true);
    }
  });
});

describe("conversationAiMode com tipo de contato", () => {
  const base = () => ({
    org: { settings: { aiConfig: { enabled: true, lgpdAck: { at: 1 } } } },
    aiMembers: [{ _id: "a1" as never, status: "active" as const, agentProfile: { kind: "attendant", mode: "autopilot" } as never }],
    conversation: { kind: "direct" as const, channel: "whatsapp" as const },
    lead: null,
  });
  test("off para contato fora do comercial (contato ou espelho); cliente segue atendido", () => {
    expect(conversationAiMode({ ...base(), contact: { relation: "personal" } })).toBe("off");
    expect(
      conversationAiMode({ ...base(), conversation: { ...base().conversation, contactRelation: "automated" }, contact: null })
    ).toBe("off");
    expect(conversationAiMode({ ...base(), contact: { relation: "customer" } })).toBe("auto");
  });
});

describe("Telegram: botão pe nos cartões", () => {
  const ctx = (relationAction?: "mark" | "convert"): CardContext => ({
    orgName: "Org",
    timezone: "America/Sao_Paulo",
    currency: "BRL",
    appBaseUrl: "https://app.test",
    discreet: false,
    now: 1_000,
    lead: { id: "l1", title: "Mieko" } as never,
    conversation: { id: "c1", channel: "whatsapp", ...(relationAction ? { relationAction } : {}) },
  });
  const notification = { _id: "n1", type: "new_message" as const, title: "Mieko", body: "oi", createdAt: 1_000, conversationId: "c1" };
  const datas = (relationAction?: "mark" | "convert") =>
    buildNotificationCard({ notification, context: ctx(relationAction) })
      .keyboard.flat()
      .map((b) => ("callback_data" in b ? b.callback_data : undefined))
      .filter(Boolean);

  test("mensagem nova oferece Pessoal; marcado oferece Virar lead; grupo nada", () => {
    expect(datas("mark")).toContain("pe:c1:p");
    expect(datas("convert")).toContain("pe:c1:l");
    expect(datas(undefined).some((d) => d!.startsWith("pe:"))).toBe(false);
    expect(parseCallbackData("pe:c1:p")).toEqual({ verb: "pe", id: "c1", extra: "p" });
  });

  test("cartão de repasse também oferece o botão", () => {
    const card = buildNotificationCard({
      notification: { ...notification, type: "handoff_requested", handoffId: "h1" },
      context: { ...ctx("mark"), handoff: { id: "h1", status: "pending", fromAi: true } },
    });
    const all = card.keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : ""));
    expect(all).toContain("pe:c1:p");
  });
});
