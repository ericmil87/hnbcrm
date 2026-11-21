import { describe, expect, it } from "vitest";
import { bookingContextParts, bookingSheetExtraProps } from "./agendaBooking";

describe("agendaBooking", () => {
  it("a hora ainda não vai para a folha (ponto único, hoje vazio)", () => {
    expect(bookingSheetExtraProps(870)).toEqual({ initialTimeMin: 870 });
    expect(bookingSheetExtraProps(undefined)).toEqual({});
  });
  it("contexto sem hora", () => {
    expect(bookingContextParts("qui, 26/11", "Sala 2")).toBe("qui, 26/11 · Sala 2");
    expect(bookingContextParts("qui, 26/11", undefined)).toBe("qui, 26/11");
  });
});
