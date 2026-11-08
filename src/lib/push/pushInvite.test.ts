import { describe, expect, it } from "vitest";
import { PUSH_INVITE_COOLDOWN_MS, planInvite, shouldInvite } from "./pushInvite";
import type { ArrivalItem } from "@/lib/notificationInbox";

const item = (over: Partial<ArrivalItem> & { _id: string }): ArrivalItem => ({ type: "handoff_requested", createdAt: 1000, ...over });
const base = { openConversationId: null, status: "default", lastShownAt: null, now: 10_000_000, shownThisSession: false };

describe("shouldInvite", () => {
  it("só com o aparelho ainda por ativar", () => {
    for (const status of ["subscribed", "denied", "unsupported", "needs-install", "loading", "error"]) {
      expect(shouldInvite({ status, lastShownAt: null, now: 1, shownThisSession: false })).toBe(false);
    }
    expect(shouldInvite({ status: "default", lastShownAt: null, now: 1, shownThisSession: false })).toBe(true);
  });

  it("no máximo 1 vez a cada 7 dias e 1 vez por sessão", () => {
    const now = 100 * 24 * 3600_000;
    expect(shouldInvite({ status: "default", lastShownAt: now - PUSH_INVITE_COOLDOWN_MS + 1, now, shownThisSession: false })).toBe(false);
    expect(shouldInvite({ status: "default", lastShownAt: now - PUSH_INVITE_COOLDOWN_MS, now, shownThisSession: false })).toBe(true);
    expect(shouldInvite({ status: "default", lastShownAt: null, now, shownThisSession: true })).toBe(false);
  });
});

describe("planInvite", () => {
  it("a 1ª leitura (carga) só semeia a marca d'água e nunca convida", () => {
    const plan = planInvite({ ...base, watermark: null, items: [item({ _id: "n1", createdAt: 5000 })] });
    expect(plan).toEqual({ invite: false, nextWatermark: 5000 });
  });

  it("convida quando chega pedido de ajuda depois da carga", () => {
    const plan = planInvite({ ...base, watermark: 5000, items: [item({ _id: "n2", createdAt: 6000 })] });
    expect(plan.invite).toBe(true);
    expect(plan.nextWatermark).toBe(6000);
  });

  it("convida com mensagem nova, mas não com tipos que não são de atendimento", () => {
    expect(planInvite({ ...base, watermark: 0, items: [item({ _id: "a", type: "new_message", createdAt: 2 })] }).invite).toBe(true);
    expect(planInvite({ ...base, watermark: 0, items: [item({ _id: "b", type: "task_due_soon", createdAt: 2 })] }).invite).toBe(false);
  });

  it("respeita o intervalo de 7 dias e a conversa aberta", () => {
    const items = [item({ _id: "c", createdAt: 9, conversationId: "conv1" })];
    expect(planInvite({ ...base, watermark: 0, items, lastShownAt: base.now - 1000 }).invite).toBe(false);
    expect(planInvite({ ...base, watermark: 0, items, openConversationId: "conv1" }).invite).toBe(false);
  });

  it("nunca convida se já está ativo ou bloqueado", () => {
    const items = [item({ _id: "d", createdAt: 9 })];
    expect(planInvite({ ...base, watermark: 0, items, status: "subscribed" }).invite).toBe(false);
    expect(planInvite({ ...base, watermark: 0, items, status: "denied" }).invite).toBe(false);
  });
});
