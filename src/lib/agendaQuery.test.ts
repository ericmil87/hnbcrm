import { describe, expect, it } from "vitest";
import { calendarQueryKey, serverEventTypeFilter } from "./agendaQuery";

describe("serverEventTypeFilter", () => {
  it("só filtra no servidor com exatamente um tipo", () => {
    expect(serverEventTypeFilter([])).toBeUndefined();
    expect(serverEventTypeFilter(["call"])).toBe("call");
    expect(serverEventTypeFilter(["call", "demo"])).toBeUndefined();
  });
});

describe("calendarQueryKey", () => {
  it("muda com organização, membro e tipo do servidor", () => {
    const k = calendarQueryKey("org1", null, undefined);
    expect(calendarQueryKey("org2", null, undefined)).not.toBe(k);
    expect(calendarQueryKey("org1", "m1", undefined)).not.toBe(k);
    expect(calendarQueryKey("org1", null, "call")).not.toBe(k);
  });
  it("1 tipo → 2 tipos muda a chave (a busca passa a ser sem tipo)", () => {
    const one = calendarQueryKey("o", null, serverEventTypeFilter(["call"]));
    const two = calendarQueryKey("o", null, serverEventTypeFilter(["call", "demo"]));
    expect(one).not.toBe(two);
  });
  it("é estável para os mesmos filtros", () => {
    expect(calendarQueryKey("o", "m", "call")).toBe(calendarQueryKey("o", "m", "call"));
  });
});
