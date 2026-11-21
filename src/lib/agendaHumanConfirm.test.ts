import { describe, expect, it } from "vitest";
import { humanConfirmUndoKind, parsedWhenLabel, suggestionCanAccept, suggestionKind, suggestionReasonText } from "./agendaHumanConfirm";

const NOW = Date.parse("2026-06-12T12:00:00Z");
const H = 3_600_000;

describe("agendaHumanConfirm", () => {
  it("rótulo de dia e hora (parcial também)", () => {
    expect(parsedWhenLabel({ localDate: "2026-06-15", timeMin: 600 })).toBe("seg, 15/06 às 10:00");
    expect(parsedWhenLabel({ localDate: "2026-06-15" })).toBe("seg, 15/06");
    expect(parsedWhenLabel({ timeMin: 605 })).toBe("às 10:05");
    expect(parsedWhenLabel({})).toBe("");
  });

  it("tipo da sugestão pelo ato e pelo motivo", () => {
    expect(suggestionKind({ act: "confirmou", parsed: {} })).toBe("marcar");
    expect(suggestionKind({ act: "confirmou", reason: "aprovar_pendente", parsed: {} })).toBe("aprovar");
    expect(suggestionKind({ act: "remarcou", reason: "substituir_pendente", parsed: {} })).toBe("substituir");
    expect(suggestionKind({ act: "remarcou", reason: "correcao", parsed: {} })).toBe("corrigir");
    expect(suggestionKind({ act: "remarcou", reason: "ato_nao_automatico", parsed: {} })).toBe("remarcar");
    expect(suggestionKind({ act: "cancelou", parsed: {} })).toBe("cancelar");
  });

  it("só aceita com dia e hora (cancelar não precisa)", () => {
    expect(suggestionCanAccept({ act: "confirmou", parsed: { localDate: "2026-06-15", timeMin: 600 } })).toBe(true);
    expect(suggestionCanAccept({ act: "confirmou", parsed: { localDate: "2026-06-15" } })).toBe(false);
    expect(suggestionCanAccept({ act: "cancelou", parsed: {} })).toBe(true);
  });

  it("motivos em português; regra de agendamento tem texto próprio; desconhecido = nada", () => {
    expect(suggestionReasonText("sem_ia")).toMatch(/IA está desligada/);
    expect(suggestionReasonText("regra:OUTSIDE_HOURS")).toMatch(/aviso de regra/);
    expect(suggestionReasonText("inventado")).toBeUndefined();
    expect(suggestionReasonText(undefined)).toBeUndefined();
  });

  it("Desfazer: criado pela confirmação (24 h, sem mudança) ou aprovado pelo sistema; nunca o da equipe", () => {
    const created = { origin: "human_message", status: "scheduled", createdAt: NOW - 2 * H };
    expect(humanConfirmUndoKind(created, NOW)).toBe("created");
    expect(humanConfirmUndoKind({ ...created, createdAt: NOW - 25 * H }, NOW)).toBeNull();
    expect(humanConfirmUndoKind({ ...created, status: "confirmed" }, NOW)).toBeNull();
    expect(humanConfirmUndoKind({ ...created, clientConfirmedAt: NOW - H }, NOW)).toBeNull();
    const approved = { origin: "public", status: "scheduled", createdAt: NOW - 5 * H, approvedAt: NOW - H, statusActors: [{ status: "scheduled", at: NOW - H }] };
    expect(humanConfirmUndoKind(approved, NOW)).toBe("approved");
    expect(humanConfirmUndoKind({ ...approved, statusActors: [{ status: "scheduled", at: NOW - H, actorName: "Maria" }] }, NOW)).toBeNull();
    expect(humanConfirmUndoKind({ ...approved, statusActors: undefined }, NOW)).toBeNull();
    expect(humanConfirmUndoKind({ ...approved, approvedAt: NOW - 30 * H }, NOW)).toBeNull();
    expect(humanConfirmUndoKind({ origin: "staff", status: "scheduled", createdAt: NOW - H }, NOW)).toBeNull();
  });
});
