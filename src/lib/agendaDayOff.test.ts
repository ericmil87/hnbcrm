import { describe, expect, it } from "vitest";
import { resourcesOffInWindow } from "./agendaDayOff";

// 2026-12-14 é segunda-feira (weekday 1).
const eric = { _id: "eric", kind: "person", weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday })) };
const ana = { _id: "ana", kind: "person", weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday })) };
const sala = { _id: "sala", kind: "room", weekly: [] };

describe("resourcesOffInWindow", () => {
  it("fechamento do dia inteiro do recurso", () => {
    const off = resourcesOffInWindow([eric, ana], [{ localDate: "2026-12-14", mode: "closed", resourceId: "eric" }], "2026-12-14", "2026-12-14");
    expect([...off]).toEqual(["eric"]);
  });
  it("fechamento por tipo e da agenda inteira", () => {
    expect([...resourcesOffInWindow([eric, sala], [{ localDate: "2026-12-14", mode: "closed", resourceKind: "person" }], "2026-12-14", "2026-12-14")]).toEqual(["eric"]);
    expect(resourcesOffInWindow([eric, sala], [{ localDate: "2026-12-14", mode: "closed" }], "2026-12-14", "2026-12-14").size).toBe(2);
  });
  it("sem expediente no dia da semana é folga; sala sem expediente cadastrado não é", () => {
    const off = resourcesOffInWindow([eric, sala], [], "2026-12-13", "2026-12-13"); // domingo
    expect([...off]).toEqual(["eric"]);
  });
  it("horário especial ou extra no dia reabre o recurso", () => {
    const off = resourcesOffInWindow([eric], [{ localDate: "2026-12-13", mode: "extra", resourceId: "eric", intervals: [{}] }], "2026-12-13", "2026-12-13");
    expect(off.size).toBe(0);
  });
  it("bloqueio parcial (com horários) não é folga", () => {
    expect(resourcesOffInWindow([eric], [{ localDate: "2026-12-14", mode: "closed", resourceId: "eric", intervals: [{}] }], "2026-12-14", "2026-12-14").size).toBe(0);
    expect(resourcesOffInWindow([eric], [{ localDate: "2026-12-14", mode: "block", resourceId: "eric", intervals: [{}] }], "2026-12-14", "2026-12-14").size).toBe(0);
  });
  it("janela de vários dias: só é folga se for em todos", () => {
    const c = [{ localDate: "2026-12-14", mode: "closed", resourceId: "eric" }];
    expect(resourcesOffInWindow([eric], c, "2026-12-14", "2026-12-15").size).toBe(0);
    const both = [...c, { localDate: "2026-12-15", mode: "closed", resourceId: "eric" }];
    expect(resourcesOffInWindow([eric], both, "2026-12-14", "2026-12-15").size).toBe(1);
  });
});
