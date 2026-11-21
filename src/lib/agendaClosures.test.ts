import { describe, expect, it } from "vitest";
import { closureRows } from "./agendaClosures";

describe("closureRows", () => {
  it("ordena por data e descreve escopo, modo, horários e motivo", () => {
    const rows = closureRows(
      [
        { _id: "b", localDate: "2026-12-25", mode: "closed", reasonCode: "holiday", reason: "Natal" },
        { _id: "a", localDate: "2026-11-30", mode: "custom", resourceId: "r1", intervals: [{ startMin: 540, endMin: 720 }] },
        { _id: "c", localDate: "2026-12-01", mode: "block", resourceKind: "room", intervals: [{ startMin: 600, endMin: 660 }] },
      ] as never,
      [{ _id: "r1", name: "Sala 1" }]
    );
    expect(rows.map((r) => r.id)).toEqual(["a", "c", "b"]);
    expect(rows[0]).toMatchObject({ scope: "Sala 1", mode: "Horário especial", intervals: "09:00–12:00" });
    expect(rows[1].scope).toBe("Todas as salas");
    expect(rows[2]).toMatchObject({ scope: "Toda a agenda", mode: "Fechado", reason: "Feriado: Natal" });
  });
});
