import { describe, expect, test } from "vitest";
import { consumePairingAttempt, PAIRING_WINDOW_MS } from "./pairingQuota";
import { bridgeWebhookUrl } from "./bridgeGateway";

describe("consumePairingAttempt", () => {
  test("3 por hora e recusa a 4ª", () => {
    let row: { hourStart: number; attempts: number } | null = null;
    const left: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = consumePairingAttempt(row, 1000 + i);
      expect(r.allowed).toBe(true);
      left.push(r.attemptsLeft);
      row = r.next;
    }
    expect(left).toEqual([2, 1, 0]);
    const fourth = consumePairingAttempt(row, 5000);
    expect(fourth.allowed).toBe(false);
    expect(fourth.resetsAt).toBe(1000 + PAIRING_WINDOW_MS);
  });

  test("consumePairingAttempt reinicia após 1 h", () => {
    const row = { hourStart: 1000, attempts: 3 };
    expect(consumePairingAttempt(row, 1000 + PAIRING_WINDOW_MS - 1).allowed).toBe(false);
    const r = consumePairingAttempt(row, 1000 + PAIRING_WINDOW_MS);
    expect(r.allowed).toBe(true);
    expect(r.attemptsLeft).toBe(2);
    expect(r.next).toEqual({ hourStart: 1000 + PAIRING_WINDOW_MS, attempts: 1 });
  });
});

describe("bridgeWebhookUrl", () => {
  test("normaliza barra final e usa a rota do bridge", () => {
    expect(bridgeWebhookUrl("https://x.convex.site/")).toBe("https://x.convex.site/webhooks/bridge");
    expect(bridgeWebhookUrl(" https://x.convex.site ")).toBe("https://x.convex.site/webhooks/bridge");
  });
});
