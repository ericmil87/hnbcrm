import { describe, expect, it } from "vitest";
import { bookingContextParts, bookingSheetExtraProps, rebookTarget } from "./agendaBooking";

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
