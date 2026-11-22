import { describe, expect, it } from "vitest";
import { bookingContextParts, bookingSheetExtraProps, rebookTarget, rescheduleDefaults } from "./agendaBooking";

describe("agendaBooking", () => {
  it("a hora ainda não vai para a folha (ponto único, hoje vazio)", () => {
    expect(bookingSheetExtraProps(870)).toEqual({ initialTimeMin: 870 });
    expect(bookingSheetExtraProps(undefined)).toEqual({});
  });
  it("contexto sem hora", () => {
    expect(bookingContextParts("qui, 26/11", "Sala 2")).toBe("qui, 26/11 · Sala 2");
    expect(bookingContextParts("qui, 26/11", undefined)).toBe("qui, 26/11");
  });
  it("marcar de novo: mesmo cliente e serviço; sem serviço ou sem cliente, nada", () => {
    expect(rebookTarget({ serviceId: "s1", variantKey: "60", contactId: "c1", leadId: "l1", contactName: " Maria " })).toEqual({
      who: { contactId: "c1", leadId: "l1", name: "Maria" },
      service: { serviceId: "s1", variantKey: "60" },
    });
    expect(rebookTarget({ serviceId: "s1", conversationId: "v1" })).toEqual({ who: { conversationId: "v1" }, service: { serviceId: "s1" } });
    expect(rebookTarget({ contactId: "c1" })).toBeNull();
    expect(rebookTarget({ serviceId: "s1", guestName: "Convidado" })).toBeNull();
  });
});

describe("rescheduleDefaults", () => {
  const TZ = "America/Sao_Paulo";
  const at = (day: number, h: number) => Date.UTC(2026, 11, day, h + 3);
  const resources = [
    { _id: "s1", kind: "room" },
    { _id: "p1", kind: "person" },
    { _id: "p2", kind: "person" },
  ];
  it("abre no dia do agendamento futuro, com sala e profissional atuais fixados", () => {
    const out = rescheduleDefaults({ startTime: at(14, 10), now: at(10, 9), tz: TZ, resourceIds: ["s1", "p1"], resources });
    expect(out).toEqual({ date: "2026-12-14", pinned: { room: "s1", person: "p1" } });
  });
  it("o dia local vem do fuso da org (23h em São Paulo ainda é o mesmo dia)", () => {
    expect(rescheduleDefaults({ startTime: at(14, 23), now: at(10, 9), tz: TZ, resourceIds: [], resources }).date).toBe("2026-12-14");
  });
  it("já passou: abre em hoje; sem horário: hoje", () => {
    expect(rescheduleDefaults({ startTime: at(1, 10), now: at(10, 9), tz: TZ, resourceIds: [], resources }).date).toBe("2026-12-10");
    expect(rescheduleDefaults({ startTime: undefined, now: at(10, 9), tz: TZ, resourceIds: undefined, resources }).date).toBe("2026-12-10");
  });
  it("mesmo dia de hoje conta como futuro; um por tipo; recurso desconhecido é ignorado", () => {
    const out = rescheduleDefaults({ startTime: at(10, 15), now: at(10, 9), tz: TZ, resourceIds: ["p1", "p2", "x"], resources });
    expect(out).toEqual({ date: "2026-12-10", pinned: { person: "p1" } });
  });
});
