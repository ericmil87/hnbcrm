import { describe, expect, it } from "vitest";
import { ALL_STATUSES, canTransition } from "../../convex/lib/schedStatus";
import { actionLabel, isProposalExpired, appointmentHistory, availableActions, STATUS_TARGET, type DetailAction } from "./appointmentActions";

const NOW = 1_000_000;
const ctx = (status: string, over = {}) => ({ status, canEdit: true, startTime: NOW + 3_600_000, now: NOW, ...over });

describe("availableActions", () => {
  it("quem só vê não recebe ação nenhuma", () => {
    for (const s of ALL_STATUSES) expect(availableActions(ctx(s, { canEdit: false }))).toEqual({ status: [], other: [] });
  });
  it("aguardando aprovação: aprovar e recusar", () => {
    const a = availableActions(ctx("pending_approval"));
    expect(a.status).toEqual(["approve", "decline"]);
    expect(a.other).toEqual(["reschedule"]);
  });
  it("proposta vencida (início já passou): sem aprovar, só recusar ou marcar de novo", () => {
    const a = availableActions(ctx("pending_approval", { startTime: NOW - 1 }));
    expect(a.status).toEqual(["decline", "rebook"]);
    expect(a.other).toEqual([]);
    expect(isProposalExpired("pending_approval", NOW - 1, NOW)).toBe(true);
    expect(isProposalExpired("pending_approval", NOW + 1, NOW)).toBe(false);
    expect(isProposalExpired("scheduled", NOW - 1, NOW)).toBe(false);
  });
  it("marca proposal_expired do servidor vence a proposta mesmo com horário futuro; nunca aprova nem remarca", () => {
    const a = availableActions(ctx("pending_approval", { needsAttentionCode: "proposal_expired" }));
    expect(a).toEqual({ status: ["decline", "rebook"], other: [] });
    expect(isProposalExpired("pending_approval", NOW + 1, NOW, "proposal_expired")).toBe(true);
    expect(isProposalExpired("pending_approval", NOW + 1, NOW, "no_resource")).toBe(false);
    expect(isProposalExpired("scheduled", NOW + 1, NOW, "proposal_expired")).toBe(false);
  });
  it("só proposta vencida oferece marcar de novo", () => {
    for (const s of ALL_STATUSES) expect(availableActions(ctx(s)).status, s).not.toContain("rebook");
    expect(actionLabel("rebook")).toBe("Marcar de novo");
  });
  it("desfazer some quando o servidor disse que não há o que desfazer", () => {
    expect(availableActions(ctx("cancelled", { undoUnavailable: true })).other).toEqual([]);
  });
  it("proposta de remarcação não oferece remarcar", () => {
    expect(availableActions(ctx("pending_approval", { isRescheduleProposal: true })).other).toEqual([]);
  });
  it("marcado: confirmar, chegou, atendido; faltou só depois do início", () => {
    expect(availableActions(ctx("scheduled")).status).toEqual(["confirm", "checkIn", "complete"]);
    expect(availableActions(ctx("scheduled", { startTime: NOW - 1 })).status).toContain("noShow");
    expect(availableActions(ctx("scheduled")).other).toEqual(["reschedule", "swap", "cancel"]);
  });
  it("confirmado não oferece confirmar de novo", () => {
    expect(availableActions(ctx("confirmed")).status).not.toContain("confirm");
  });
  it("chegou: só atendido; atendido: só desfazer", () => {
    expect(availableActions(ctx("checked_in")).status).toEqual(["complete"]);
    expect(availableActions(ctx("completed"))).toEqual({ status: [], other: ["undo"] });
  });
  it("faltou e cancelado só desfazem; remarcado não tem desfazer", () => {
    expect(availableActions(ctx("no_show")).other).toEqual(["undo"]);
    expect(availableActions(ctx("cancelled")).other).toEqual(["undo"]);
    expect(availableActions(ctx("rescheduled"))).toEqual({ status: [], other: [] });
  });
  it("tudo que oferecemos como mudança de status o servidor aceita para a equipe", () => {
    for (const s of ALL_STATUSES) {
      const startTime = NOW - 1;
      const { status } = availableActions(ctx(s, { startTime }));
      for (const action of status as DetailAction[]) {
        const to = STATUS_TARGET[action];
        if (action === "decline" || action === "rebook") continue; // recusar = cancelar (outra porta); marcar de novo abre o fluxo de marcar
        expect(to, action).toBeDefined();
        expect(canTransition(s, to!, "staff", NOW, startTime), `${s} -> ${to}`).toBe(true);
      }
    }
  });
  it("rótulos em PT-BR", () => {
    expect(actionLabel("decline")).toBe("Recusar proposta");
    expect(actionLabel("checkIn")).toBe("Chegou");
  });
});

describe("appointmentHistory", () => {
  it("ordem cronológica, origem e motivo do cancelamento", () => {
    const h = appointmentHistory({ origin: "ai", createdAt: 10, approvedAt: 20, cancelledAt: 30, cancelReason: " cliente viajou " });
    expect(h.map((e) => e.label)).toEqual(["Marcado (IA)", "Aprovado", "Cancelado. Motivo: cliente viajou"]);
  });
  it("só a criação quando nada mais aconteceu; máximo de 6", () => {
    expect(appointmentHistory({ origin: "staff", createdAt: 1 })).toHaveLength(1);
    const all = appointmentHistory({ origin: "staff", createdAt: 1, approvedAt: 2, clientConfirmedAt: 3, checkedInAt: 4, completedAt: 5, noShowAt: 6, cancelledAt: 7 });
    expect(all).toHaveLength(6);
    expect(all[0].at).toBe(2);
  });
});

describe("appointmentHistory com quem fez (A3d)", () => {
  it("criação com o nome de quem marcou; cai na origem quando não há nome", () => {
    expect(appointmentHistory({ origin: "ai", createdAt: 1, createdByName: " Ana " })[0].label).toBe("Marcado por Ana");
    expect(appointmentHistory({ origin: "ai", createdAt: 1, createdByName: "IA" })[0].label).toBe("Marcado por IA");
    expect(appointmentHistory({ origin: "ai", createdAt: 1 })[0].label).toBe("Marcado (IA)");
  });
  it("cada mudança de status leva o ator da auditoria; sem ator, o texto de antes", () => {
    const h = appointmentHistory({
      origin: "staff", createdAt: 1, approvedAt: 2, checkedInAt: 3, completedAt: 4, cancelledAt: 5, cancelReason: "viagem",
      statusActors: [
        { status: "scheduled", at: 2, actorName: "Bia" },
        { status: "completed", at: 4, actorName: "Ana" },
        { status: "cancelled", at: 5, actorName: "Link público" },
      ],
    });
    expect(h.map((e) => e.label)).toEqual([
      "Marcado (Equipe)",
      "Aprovado por Bia",
      "Chegou",
      "Atendimento concluído por Ana",
      "Cancelado por Link público. Motivo: viagem",
    ]);
  });
  it("ignora o 'Desfazer' ao procurar o ator e usa o último ato do status", () => {
    const h = appointmentHistory({
      origin: "staff", createdAt: 1, completedAt: 9,
      statusActors: [
        { status: "completed", at: 3, actorName: "Ana" },
        { status: "completed", at: 5, actorName: "Zé", undo: true },
        { status: "completed", at: 9, actorName: "Bia" },
      ],
    });
    expect(h[1].label).toBe("Atendimento concluído por Bia");
  });
});
