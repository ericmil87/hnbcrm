import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_STATUS_META,
  isActiveStatus,
  isExpiredProposal,
  isKnownOrigin,
  isKnownStatus,
  originBadgeKind,
  originLabel,
  statusLabelOf,
  statusMeta,
  vacancyOf,
} from "./agendaStatus";
import { APPOINTMENT_ORIGINS, APPOINTMENT_STATUSES } from "./agendaTypes";
import { ACTIVE_STATUSES, ALL_STATUSES, TERMINAL_STATUSES } from "../../convex/lib/schedStatus";

describe("status", () => {
    it("paridade com o SERVIDOR: lista, ativos e terminais vêm de convex/lib/schedStatus", () => {
    expect([...APPOINTMENT_STATUSES]).toEqual([...ALL_STATUSES]);
    expect(Object.keys(APPOINTMENT_STATUS_META).sort()).toEqual([...ALL_STATUSES].sort());
    for (const s of ALL_STATUSES) {
      expect(APPOINTMENT_STATUS_META[s].active, s).toBe(ACTIVE_STATUSES.includes(s));
      expect(APPOINTMENT_STATUS_META[s].terminal, s).toBe(TERMINAL_STATUSES.includes(s));
    }
    expect(isActiveStatus("completed")).toBe(true);
    expect(APPOINTMENT_STATUS_META.completed.terminal).toBe(false);
    expect(APPOINTMENT_STATUS_META.completed.final).toBe(true);
    expect(APPOINTMENT_STATUS_META.confirmed.final).toBe(false);
  });

  it("só aguardando aprovação é tracejado", () => {
    expect(APPOINTMENT_STATUSES.filter((s) => APPOINTMENT_STATUS_META[s].dashed)).toEqual(["pending_approval"]);
    expect(APPOINTMENT_STATUS_META.pending_approval.blockClassName).toContain("border-dashed");
  });

  it("classes usam só tokens do tema (nada de cor crua)", () => {
    for (const s of APPOINTMENT_STATUSES) {
      expect(APPOINTMENT_STATUS_META[s].blockClassName, s).not.toMatch(/#[0-9a-f]{3,8}|\b(?:red|green|blue|yellow|gray|slate|zinc)-\d{2,3}\b|\b(?:bg|text|border)-(?:white|black)\b/i);
    }
  });

  it("status desconhecido não quebra", () => {
    expect(statusMeta("novo_do_backend").label).toBe("Marcado");
    expect(isKnownStatus("novo_do_backend")).toBe(false);
    expect(isKnownStatus("confirmed")).toBe(true);
  });
});

describe("origem", () => {
  it("IA, Equipe, Link", () => {
    expect(originBadgeKind("ai")).toBe("ai");
    expect(originBadgeKind("waitlist")).toBe("ai");
    expect(originBadgeKind("public")).toBe("link");
    for (const o of ["staff", "api", "human_message", "import", "outra"]) expect(originBadgeKind(o), o).toBe("staff");
    expect(originLabel("ai")).toBe("IA");
    expect(originLabel("public")).toBe("Link");
    expect(originLabel("human_message")).toBe("Equipe");
  });

  it("origens do schema são conhecidas", () => {
    for (const o of APPOINTMENT_ORIGINS) expect(isKnownOrigin(o)).toBe(true);
    expect(isKnownOrigin("x")).toBe(false);
  });
});

describe("vacancyOf", () => {
  it("1/2, cheio e limites", () => {
    expect(vacancyOf(1, 2)).toMatchObject({ label: "1/2", full: false, a11y: "1 de 2 vagas ocupadas" });
    expect(vacancyOf(2, 2)).toMatchObject({ label: "2/2", full: true });
    expect(vacancyOf(0, 1)).toMatchObject({ label: "0/1", full: false, a11y: "0 de 1 vaga ocupada" });
    expect(vacancyOf(5, 2)).toMatchObject({ label: "5/2", over: true });
    expect(vacancyOf(2, 1)).toMatchObject({ label: "2/1", over: true, full: true, a11y: "2 de 1 vaga: acima da capacidade" });
    expect(vacancyOf(1, 1).over).toBe(false);
    expect(vacancyOf(-1, 2).label).toBe("0/2");
    expect(vacancyOf(1, 0).label).toBe("1/1");
    expect(vacancyOf(NaN, NaN).label).toBe("0/1");
    expect(vacancyOf(1, 2.9).capacity).toBe(2);
  });
});

describe("proposta vencida", () => {
  const now = 1_000_000;
  const pend = { status: "pending_approval", startTime: now + 1000 };
  it("vence pelo horário ou pela marca do servidor, só em aguardando aprovação", () => {
    expect(isExpiredProposal(pend, now)).toBe(false);
    expect(isExpiredProposal({ ...pend, startTime: now - 1 }, now)).toBe(true);
    expect(isExpiredProposal({ ...pend, needsAttention: { code: "proposal_expired" } }, now)).toBe(true);
    expect(isExpiredProposal({ ...pend, needsAttention: { code: "no_resource" } }, now)).toBe(false);
    expect(isExpiredProposal({ status: "scheduled", startTime: now - 1, needsAttention: { code: "proposal_expired" } }, now)).toBe(false);
  });
  it("rótulo: Vencida no lugar de Aguardando aprovação", () => {
    expect(statusLabelOf({ ...pend, needsAttention: { code: "proposal_expired" } }, now)).toBe("Vencida");
    expect(statusLabelOf(pend, now)).toBe("Aguardando aprovação");
  });
});
