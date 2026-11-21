import { describe, expect, it } from "vitest";
import { automationErrors, automationFromSettings, automationToPatch, needsAutoAck, previewDraftArgs, touchesAnother, weightsAreDefault } from "./agendaAutomation";
import type { SettingsView } from "../../convex/lib/schedViews";

const settings = (ack = false): SettingsView =>
  ({
    gridMinutes: 30, minNoticeMin: 120, maxAdvanceDays: 60,
    smart: { mode: "rank", weights: { adjacency: 40, deadGap: 50, openNewResource: 20, earlyFirst: 10, balance: 0, preference: 30 }, minOffer: 3 },
    ai: { consult: true, book: "propose", reschedule: "propose", cancel: "handoff", firstVisitNeedsApproval: true, maxAiBookingsPerContactPerDay: 2, ...(ack ? { autoAck: { by: "m1", at: 5 } } : {}) },
    humanConfirm: { mode: "auto" },
  }) as unknown as SettingsView;

describe("agendaAutomation", () => {
  const saved = automationFromSettings(settings())!;
  it("leitor sem manage não tem formulário", () => {
    expect(automationFromSettings({ ...settings(), ai: undefined })).toBeUndefined();
  });
  it("sem mudanças, patch vazio", () => {
    expect(automationToPatch(saved, saved)).toEqual({ patch: {} });
    expect(weightsAreDefault(saved.weights)).toBe(true);
  });
  it("marca sozinha exige aceite e manda aiAutoAck só quando aceito agora", () => {
    const f = { ...saved, book: "auto" as const };
    expect(needsAutoAck(f)).toBe(true);
    expect(automationErrors(f).ack).toBeDefined();
    const ok = { ...f, ackAcceptedNow: true };
    expect(automationErrors(ok).ack).toBeUndefined();
    expect(automationToPatch(ok, saved)).toEqual({ patch: { ai: { book: "auto" } }, aiAutoAck: true });
  });
  it("com aceite já gravado não pede de novo nem reenvia", () => {
    const s2 = automationFromSettings(settings(true))!;
    const f = { ...s2, book: "auto" as const };
    expect(needsAutoAck(f)).toBe(false);
    expect(automationToPatch(f, s2)).toEqual({ patch: { ai: { book: "auto" } } });
  });
  it("pesos: voltar ao padrão manda null; custom manda objeto", () => {
    const custom = { ...saved, weights: { ...saved.weights, adjacency: "80" } };
    expect(automationToPatch(custom, saved).patch.smart?.weights).toMatchObject({ adjacency: 80 });
    expect(automationToPatch(saved, custom).patch.smart?.weights).toBeNull();
    expect(automationErrors({ ...saved, weights: { ...saved.weights, balance: "2000" } }).weights).toBeDefined();
    expect(previewDraftArgs({ ...saved, weights: { ...saved.weights, balance: "x" } }).weights).toBeUndefined();
  });
  it("encostado", () => {
    expect(touchesAnother(["logo após outro atendimento"])).toBe(true);
    expect(touchesAnother(["abre um recurso novo"])).toBe(false);
  });
});
