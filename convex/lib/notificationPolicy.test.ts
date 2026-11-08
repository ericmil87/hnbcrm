import { describe, expect, test } from "vitest";
import {
  ACTIONABLE_TYPES,
  PREFERENCE_FLAG,
  activePausedUntil,
  channelAllows,
  flagOf,
  isInQuietHours,
  isActionable,
  shouldDeliver,
  type PolicyPrefs,
  type QuietHours,
} from "./notificationPolicy";

// 2026-11-04 15:00 UTC = 12:00 em São Paulo (UTC-3) = 07:00 em Tóquio (UTC+9, dia 05 00:00).
const NOW = Date.UTC(2026, 10, 4, 15, 0, 0);
const HOUR = 3_600_000;

describe("shouldDeliver — matriz", () => {
  type Row = {
    name: string;
    type: string;
    channel: "bell" | "email" | "telegram" | "push";
    prefs: PolicyPrefs | null;
    org?: { preset?: "all" | "mine" | "none" } | null;
    legacyMutedUntil?: number;
    want: "deliver" | "hold_paused" | "hold_quiet" | "off";
  };
  const quiet: QuietHours = { enabled: true, start: "21:00", end: "08:00", timeZone: "America/Sao_Paulo" };
  const rows: Row[] = [
    { name: "sem linha = tudo liga (e-mail)", type: "task_assigned", channel: "email", prefs: null, want: "deliver" },
    { name: "sem linha = tudo liga (Telegram)", type: "campaign_completed", channel: "telegram", prefs: null, want: "deliver" },
    { name: "flag antigo false desliga e-mail", type: "task_assigned", channel: "email", prefs: { taskAssigned: false }, want: "off" },
    { name: "flag antigo false desliga Telegram", type: "task_assigned", channel: "telegram", prefs: { taskAssigned: false }, want: "off" },
    { name: "flag antigo false mantém o sino (comportamento de antes, sem campos novos)", type: "task_assigned", channel: "bell", prefs: { taskAssigned: false }, want: "off" },
    { name: "modelo novo: flag antigo false NÃO tira o sino de acionável", type: "task_assigned", channel: "bell", prefs: { taskAssigned: false, preset: "all" }, want: "deliver" },
    { name: "modelo novo: não acionável segue o flag no sino", type: "campaign_completed", channel: "bell", prefs: { campaignCompleted: false, preset: "all" }, want: "off" },
    { name: "preset none: externos off", type: "task_assigned", channel: "telegram", prefs: { preset: "none" }, want: "off" },
    { name: "preset none: sino segue", type: "task_assigned", channel: "bell", prefs: { preset: "none" }, want: "deliver" },
    { name: "preset mine: pessoal passa", type: "task_assigned", channel: "email", prefs: { preset: "mine" }, want: "deliver" },
    { name: "preset mine: campanha fica fora", type: "campaign_completed", channel: "email", prefs: { preset: "mine" }, want: "off" },
    { name: "preset mine: custo de IA fica fora", type: "ai_spend_reached", channel: "telegram", prefs: { preset: "mine" }, want: "off" },
    { name: "canal explícito vence o preset none", type: "task_assigned", channel: "email", prefs: { preset: "none", channels: { email: { taskAssigned: true } } }, want: "deliver" },
    { name: "canal explícito false vence preset all", type: "task_assigned", channel: "email", prefs: { preset: "all", channels: { email: { taskAssigned: false } } }, want: "off" },
    { name: "canal explícito não vaza para outro canal", type: "task_assigned", channel: "telegram", prefs: { channels: { email: { taskAssigned: false } } }, want: "deliver" },
    { name: "padrão da org none vale sem preset do membro", type: "task_assigned", channel: "email", prefs: null, org: { preset: "none" }, want: "off" },
    { name: "preset do membro vence o da org", type: "task_assigned", channel: "email", prefs: { preset: "all" }, org: { preset: "none" }, want: "deliver" },
    { name: "pausa segura Telegram", type: "task_assigned", channel: "telegram", prefs: { pausedUntil: NOW + HOUR }, want: "hold_paused" },
    { name: "pausa segura e-mail", type: "task_assigned", channel: "email", prefs: { pausedUntil: NOW + HOUR }, want: "hold_paused" },
    { name: "pausa segura push", type: "task_assigned", channel: "push", prefs: { pausedUntil: NOW + HOUR }, want: "hold_paused" },
    { name: "pausa não segura o sino", type: "task_assigned", channel: "bell", prefs: { pausedUntil: NOW + HOUR }, want: "deliver" },
    { name: "pausa vencida não segura", type: "task_assigned", channel: "telegram", prefs: { pausedUntil: NOW - 1 }, want: "deliver" },
    { name: "mutedUntil legado segura", type: "task_assigned", channel: "telegram", prefs: null, legacyMutedUntil: NOW + HOUR, want: "hold_paused" },
    { name: "pedido de ajuda fura a pausa", type: "handoff_requested", channel: "telegram", prefs: { pausedUntil: NOW + HOUR }, want: "deliver" },
    { name: "pedido de ajuda fura o mutedUntil legado", type: "handoff_requested", channel: "telegram", prefs: null, legacyMutedUntil: NOW + HOUR, want: "deliver" },
    { name: "urgentBypass false: pedido de ajuda segura", type: "handoff_requested", channel: "email", prefs: { pausedUntil: NOW + HOUR, urgentBypass: false }, want: "hold_paused" },
    { name: "bypass não religa o que está desligado", type: "handoff_requested", channel: "email", prefs: { handoffRequested: false, pausedUntil: NOW + HOUR }, want: "off" },
    { name: "silêncio segura (12h não está em 21h–08h → entrega)", type: "task_assigned", channel: "telegram", prefs: { quietHours: quiet }, want: "deliver" },
    { name: "silêncio segura às 23h locais", type: "task_assigned", channel: "telegram", prefs: { quietHours: { ...quiet, timeZone: "America/Sao_Paulo" } }, want: "deliver" },
    { name: "silêncio desligado não segura", type: "task_assigned", channel: "telegram", prefs: { quietHours: { ...quiet, enabled: false, timeZone: "Asia/Tokyo" } }, want: "deliver" },
    { name: "silêncio ligado em Tóquio (00h) segura", type: "task_assigned", channel: "email", prefs: { quietHours: { ...quiet, timeZone: "Asia/Tokyo" } }, want: "hold_quiet" },
    { name: "silêncio não segura o sino", type: "task_assigned", channel: "bell", prefs: { quietHours: { ...quiet, timeZone: "Asia/Tokyo" } }, want: "deliver" },
    { name: "pedido de ajuda fura o silêncio", type: "handoff_requested", channel: "push", prefs: { quietHours: { ...quiet, timeZone: "Asia/Tokyo" } }, want: "deliver" },
    { name: "pausa tem precedência de rótulo sobre silêncio", type: "task_assigned", channel: "email", prefs: { pausedUntil: NOW + HOUR, quietHours: { ...quiet, timeZone: "Asia/Tokyo" } }, want: "hold_paused" },
    { name: "eventType de e-mail (camelCase) é aceito", type: "taskAssigned", channel: "email", prefs: { taskAssigned: false }, want: "off" },
    { name: "resumo de atrasadas usa o flag taskOverdue", type: "taskOverdueSummary", channel: "email", prefs: { taskOverdue: false }, want: "off" },
    { name: "evento sem flag conhecido (formSubmission) entrega", type: "formSubmission", channel: "email", prefs: { preset: "mine" }, want: "deliver" },
  ];
  test.each(rows)("$name", (row) => {
    expect(
      shouldDeliver({
        type: row.type,
        channel: row.channel,
        prefs: row.prefs,
        orgDefaults: row.org,
        now: NOW,
        legacyMutedUntil: row.legacyMutedUntil,
      })
    ).toBe(row.want);
  });
});

describe("silêncio", () => {
  const q = (timeZone: string, start = "21:00", end = "08:00"): QuietHours => ({ enabled: true, start, end, timeZone });
  test("atravessa a meia-noite", () => {
    // 2026-11-04 23:30 BRT = 02:30Z do dia 05; 03:00 BRT = 06:00Z; 08:00 BRT = 11:00Z; 20:59 BRT = 23:59Z
    expect(isInQuietHours(Date.UTC(2026, 10, 5, 2, 30), q("America/Sao_Paulo"))).toBe(true);
    expect(isInQuietHours(Date.UTC(2026, 10, 5, 6, 0), q("America/Sao_Paulo"))).toBe(true);
    expect(isInQuietHours(Date.UTC(2026, 10, 5, 10, 59), q("America/Sao_Paulo"))).toBe(true);
    expect(isInQuietHours(Date.UTC(2026, 10, 5, 11, 0), q("America/Sao_Paulo"))).toBe(false); // 08:00 já saiu
    expect(isInQuietHours(Date.UTC(2026, 10, 4, 23, 59), q("America/Sao_Paulo"))).toBe(false); // 20:59
    expect(isInQuietHours(Date.UTC(2026, 10, 5, 0, 0), q("America/Sao_Paulo"))).toBe(true); // 21:00 entrou
  });
  test("o fuso decide: mesmo instante, resultados diferentes", () => {
    const at = Date.UTC(2026, 10, 5, 2, 30); // 23:30 BRT, 11:30 em Tóquio
    expect(isInQuietHours(at, q("America/Sao_Paulo"))).toBe(true);
    expect(isInQuietHours(at, q("Asia/Tokyo"))).toBe(false);
  });
  test("janela no mesmo dia e start == end", () => {
    const noon = Date.UTC(2026, 10, 4, 15, 0); // 12:00 BRT
    expect(isInQuietHours(noon, q("America/Sao_Paulo", "12:00", "14:00"))).toBe(true);
    expect(isInQuietHours(noon, q("America/Sao_Paulo", "13:00", "14:00"))).toBe(false);
    expect(isInQuietHours(noon, q("America/Sao_Paulo", "12:00", "12:00"))).toBe(false);
  });
  test("dados inválidos nunca seguram", () => {
    expect(isInQuietHours(NOW, q("America/Sao_Paulo", "25:00", "08:00"))).toBe(false);
    expect(isInQuietHours(NOW, undefined)).toBe(false);
  });
});

describe("pausa", () => {
  test("expira: antes segura, no instante exato e depois não", () => {
    const prefs = { pausedUntil: NOW + 1000 };
    expect(activePausedUntil(prefs, undefined, NOW)).toBe(NOW + 1000);
    expect(activePausedUntil(prefs, undefined, NOW + 1000)).toBeUndefined();
    expect(activePausedUntil(prefs, undefined, NOW + 5000)).toBeUndefined();
  });
  test("usa a maior entre pausedUntil e mutedUntil legado", () => {
    expect(activePausedUntil({ pausedUntil: NOW + 10 }, NOW + 500, NOW)).toBe(NOW + 500);
  });
});

describe("acionáveis", () => {
  test("lista da seção 4 do PLANO", () => {
    expect([...ACTIONABLE_TYPES].sort()).toEqual(
      [
        "handoff_requested", "new_message", "conversation_transferred", "task_comment_mention", "group_mention",
        "ai_draft_pending", "task_assigned", "task_due_soon", "task_overdue", "lead_assigned",
        "channel_session_lost", "ai_followup_needs_human",
      ].sort()
    );
  });
  test("todo tipo acionável tem flag e o sino do modelo novo nunca desliga", () => {
    for (const type of ACTIONABLE_TYPES) {
      const flag = PREFERENCE_FLAG[type];
      expect(isActionable(type)).toBe(true);
      expect(channelAllows(flag, "bell", { preset: "none", [flag]: false }, null)).toBe(true);
    }
  });
  test("flagOf converte tipo, evento e alias", () => {
    expect(flagOf("ai_spend_reached")).toBe("aiSpendAlert");
    expect(flagOf("taskOverdueSummary")).toBe("taskOverdue");
    expect(flagOf("dailyDigest")).toBe("dailyDigest");
  });
});
