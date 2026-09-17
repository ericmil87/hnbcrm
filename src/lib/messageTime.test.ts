import { describe, expect, it } from "vitest";
import { formatMessageTimestamp } from "./messageTime";

describe("formatMessageTimestamp", () => {
  const now = new Date(2026, 8, 17, 15, 30); // 17/09/2026 15:30 local

  it("mensagem de hoje mostra 'Hoje HH:MM'", () => {
    expect(formatMessageTimestamp(new Date(2026, 8, 17, 9, 5).getTime(), now)).toBe("Hoje 09:05");
  });

  it("mensagem de ontem mostra a data curta + hora", () => {
    expect(formatMessageTimestamp(new Date(2026, 8, 16, 23, 59).getTime(), now)).toBe("16/09/26 23:59");
  });

  it("mensagem de outro ano mostra o ano com 2 dígitos", () => {
    expect(formatMessageTimestamp(new Date(2025, 0, 2, 8, 0).getTime(), now)).toBe("02/01/25 08:00");
  });
});
