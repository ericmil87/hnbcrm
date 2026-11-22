import { describe, expect, it } from "vitest";
import { isProposalExpired } from "./appointmentActions";
import { OUTCOME_TARGETS, proposalExpired, pendingBadgeLabel, pendingRowInfo, pendingTotal, visibleSections } from "./agendaPending";

const none = { approvals: false, conflicts: false, noOutcome: false, suggestions: false };

describe("contador de pendências", () => {
  it("soma as quatro seções", () => {
    expect(pendingTotal({ approvals: 2, conflicts: 1, noOutcome: 3, suggestions: 0 }, none)).toEqual({ total: 6, more: false });
  });
  it("corte do servidor vira mínimo ('50+')", () => {
    const t = pendingTotal({ approvals: 50, conflicts: 0, noOutcome: 0, suggestions: 0 }, { ...none, approvals: true });
    expect(pendingBadgeLabel(t)).toBe("50+");
    expect(pendingBadgeLabel({ total: 6, more: false })).toBe("6");
    expect(pendingBadgeLabel({ total: 120, more: false })).toBe("99+");
  });
});

describe("seções visíveis", () => {
  it("ordem da tela; sugestões só com conteúdo; cortada sem itens ainda aparece", () => {
    expect(visibleSections({ approvals: 1, conflicts: 0, noOutcome: 2, suggestions: 0 }, none)).toEqual(["approvals", "noOutcome"]);
    expect(visibleSections({ approvals: 0, conflicts: 0, noOutcome: 0, suggestions: 1 }, none)).toEqual(["suggestions"]);
    expect(visibleSections({ approvals: 0, conflicts: 0, noOutcome: 0, suggestions: 0 }, { ...none, suggestions: true })).toEqual([]);
    expect(visibleSections({ approvals: 0, conflicts: 0, noOutcome: 0, suggestions: 0 }, none)).toEqual([]);
  });
});

describe("linha de pendência", () => {
  it("quem, quando no fuso da org, serviço e lugar alocado", () => {
    const info = pendingRowInfo(
      { contactName: "Maria", serviceName: "Sessão", startTime: Date.UTC(2026, 10, 23, 17, 0), resources: [{ name: "Sala 1", allocated: true }, { name: "Ana", allocated: true }, { name: "Sala 2", allocated: false }] },
      "America/Sao_Paulo"
    );
    expect(info).toEqual({ who: "Maria", when: "seg, 23/11 · 14:00", service: "Sessão", place: "Sala 1 · Ana" });
  });
  it("desfechos de um toque", () => {
    expect(OUTCOME_TARGETS).toEqual({ attended: "completed", noShow: "no_show" });
  });
});

describe("proposta vencida", () => {
  it("mesma regra do painel do agendamento", () => {
    for (const status of ["pending_approval", "scheduled"]) {
      for (const [start, now] of [[100, 200], [200, 200], [300, 200]]) {
        expect(proposalExpired(status, start, now)).toBe(isProposalExpired(status, start, now));
      }
    }
  });
});
