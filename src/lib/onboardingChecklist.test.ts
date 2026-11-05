import { describe, expect, it } from "vitest";
import {
  CHECKLIST_ORDER,
  checklistAction,
  checklistTotals,
  hasWizardWork,
  orderChecklistItems,
} from "./onboardingChecklist";

const item = (id: string, completed = false, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  completed,
  ...extra,
});

describe("checklist v2", () => {
  it("checklist v2 ordena itens e calcula total", () => {
    const shuffled = [
      item("firstAiReply"),
      item("teamMemberInvited", true),
      item("business", true),
      item("bridgeAiAck"),
      item("legacyUnknown"),
      item("attendant"),
    ];
    const ordered = orderChecklistItems(shuffled).map((i) => i.id);
    expect(ordered).toEqual(["business", "attendant", "bridgeAiAck", "teamMemberInvited", "firstAiReply", "legacyUnknown"]);
    expect(CHECKLIST_ORDER).toHaveLength(9);
    expect(checklistTotals(shuffled)).toEqual({ completed: 2, total: 6, percent: 33, allDone: false });
    expect(checklistTotals([item("a", true)]).allDone).toBe(true);
    expect(checklistTotals([])).toEqual({ completed: 0, total: 0, percent: 0, allDone: false });
  });

  it("cada item leva ao lugar certo", () => {
    expect(checklistAction(item("whatsapp", false, { target: "wizard", step: "whatsapp" }))).toEqual({
      to: "/app/configuracao-inicial?passo=whatsapp",
      label: "Fazer agora",
    });
    expect(checklistAction(item("extras", false, { target: "wizard", step: "extras", skipped: true }))?.label).toBe("Retomar");
    expect(checklistAction(item("bridgeAiAck", false, { target: "settings_ai" }))?.to).toBe("/app/configuracoes?secao=ai");
    expect(checklistAction(item("firstAiReply", false, { target: "inbox" }))?.to).toBe("/app/entrada");
    expect(checklistAction(item("business", true, { target: "wizard", step: "business" }))).toBeNull();
  });

  it("oferece continuar a configuração só com passo do assistente por fazer", () => {
    expect(hasWizardWork([item("business", true, { target: "wizard" }), item("firstAiReply", false, { target: "inbox" })])).toBe(false);
    expect(hasWizardWork([item("test", false, { target: "wizard", step: "test" })])).toBe(true);
  });
});
