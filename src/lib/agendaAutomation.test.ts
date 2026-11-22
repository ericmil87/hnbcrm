import { describe, expect, it } from "vitest";
import { ackSentence, applyWizardAiChoice, automationErrors, automationFromSettings, automationToPatch, autoAckText, defaultAutomationForm, needsAutoAck, previewDraftArgs, weightsAreDefault } from "./agendaAutomation";
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
  it("revoga o aceite quando sai de tudo sozinho", () => {
    const s2 = automationFromSettings({ ...settings(true), ai: { ...settings(true).ai!, book: "auto" } })!;
    expect(automationToPatch({ ...s2, book: "propose" }, s2)).toEqual({ patch: { ai: { book: "propose" } }, aiAutoAck: false });
    expect(automationToPatch({ ...s2, consult: false }, s2).aiAutoAck).toBeUndefined();
  });
  it("texto do aviso segue as ações e a primeira visita", () => {
    const f = { ...saved, book: "auto" as const, reschedule: "auto" as const };
    expect(autoAckText(f)).toMatch(/marcar horários e remarcar sozinha/);
    expect(autoAckText(f)).toMatch(/primeira visita de cada cliente continua pedindo/);
    expect(autoAckText({ ...f, firstVisitNeedsApproval: false })).toMatch(/aprovação da primeira visita está desligada/);
    expect(autoAckText({ ...saved, cancel: "auto" })).toMatch(/A IA vai cancelar sozinha/);
  });
  it("quem aceitou", () => {
    expect(ackSentence({ by: "m1", dateText: "12/11/2026" }, "m1", () => "Ana")).toMatch(/^Você aceitou/);
    expect(ackSentence({ by: "m2", dateText: "12/11/2026" }, "m1", () => "Ana")).toMatch(/^Ana aceitou/);
  });
  it("escolha do assistente", () => {
    const d = defaultAutomationForm();
    expect(applyWizardAiChoice(d, "off")).toMatchObject({ consult: false, book: "off", reschedule: "off" });
    expect(applyWizardAiChoice(d, "auto")).toMatchObject({ consult: true, book: "auto", reschedule: "propose" });
  });
});

describe("claimJudge (conferir as respostas da IA)", () => {
  it("servidor sem o campo = ligado; o valor salvo vale", () => {
    const f = automationFromSettings({ ...settings(), ai: { ...settings().ai!, claimJudge: false } } as never)!;
    expect(f.claimJudge).toBe(false);
    expect(automationFromSettings(settings())!.claimJudge).toBe(true);
  });
  it("o patch leva só o que mudou", () => {
    const saved = automationFromSettings(settings())!;
    expect(automationToPatch(saved, saved).patch).toEqual({});
    expect(automationToPatch({ ...saved, claimJudge: false }, saved).patch).toEqual({ ai: { claimJudge: false } });
    expect(automationToPatch({ ...saved, claimJudge: true }, { ...saved, claimJudge: false }).patch).toEqual({ ai: { claimJudge: true } });
  });
  it("o padrão do assistente é ligado", () => {
    expect(defaultAutomationForm().claimJudge).toBe(true);
  });
});
