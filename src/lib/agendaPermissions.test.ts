import { describe, expect, it } from "vitest";
import { canEditCalendarItem, isCalendarItemDraggable } from "./agendaPermissions";

describe("canEditCalendarItem", () => {
  it("só bloqueia com false explícito", () => {
    expect(canEditCalendarItem({ canEdit: false })).toBe(false);
    expect(canEditCalendarItem({ canEdit: true })).toBe(true);
    expect(canEditCalendarItem({})).toBe(true);
    expect(canEditCalendarItem({ canEdit: null })).toBe(true);
    expect(canEditCalendarItem(undefined)).toBe(true);
    expect(canEditCalendarItem(null)).toBe(true);
  });
});

describe("isCalendarItemDraggable", () => {
  it("agendado e permitido (ou sem campo) arrasta", () => {
    expect(isCalendarItemDraggable({ status: "scheduled" })).toBe(true);
    expect(isCalendarItemDraggable({ canEdit: true, status: "scheduled" })).toBe(true);
    expect(isCalendarItemDraggable({})).toBe(true);
  });
  it("sem permissão não arrasta", () => {
    expect(isCalendarItemDraggable({ canEdit: false, status: "scheduled" })).toBe(false);
  });
  it("concluído ou cancelado não arrasta", () => {
    expect(isCalendarItemDraggable({ status: "completed" })).toBe(false);
    expect(isCalendarItemDraggable({ canEdit: true, status: "cancelled" })).toBe(false);
  });
});
