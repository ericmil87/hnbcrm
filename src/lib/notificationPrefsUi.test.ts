// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KNOWN_FLAGS } from "../../convex/lib/notificationPolicy";
import {
  EMAIL_FLAGS,
  NON_PERSONAL_FLAGS,
  buildMatrixGroups,
  externalChannelsText,
  pauseScopeText,
  presetHint,
  pushAvailability,
  isCustomized,
  isPaused,
  pauseArgs,
  pausedUntilLabel,
  tomorrowEightLocal,
  validateQuietHours,
  FLAG_COPY,
} from "./notificationPrefsUi";

describe("buildMatrixGroups", () => {
  it("cobre todos os flags conhecidos, sem repetir, com rótulo", () => {
    const flags = buildMatrixGroups().flatMap((g) => g.rows.map((r) => r.flag));
    expect([...flags].sort()).toEqual([...KNOWN_FLAGS].sort());
    expect(new Set(flags).size).toBe(flags.length);
    for (const f of flags) expect(FLAG_COPY[f]).toBeDefined();
  });
  it("agrupa pedido de ajuda em Atendimento e tarefa em Tarefas", () => {
    const g = buildMatrixGroups();
    expect(g.find((x) => x.group === "atendimento")?.rows.map((r) => r.flag)).toContain("handoffRequested");
    expect(g.find((x) => x.group === "tarefas")?.rows.map((r) => r.flag)).toContain("taskOverdue");
  });
  it("resumo diário só tem e-mail", () => {
    const row = buildMatrixGroups()
      .flatMap((g) => g.rows)
      .find((r) => r.flag === "dailyDigest");
    expect(row?.channels).toEqual(["email"]);
  });
});

describe("pausedUntilLabel", () => {
  it("hoje, amanhã e outra data", () => {
    const now = new Date(2026, 10, 7, 10, 0).getTime();
    expect(pausedUntilLabel(new Date(2026, 10, 7, 14, 0).getTime(), now)).toBe("Pausado até 14:00");
    expect(pausedUntilLabel(new Date(2026, 10, 8, 8, 0).getTime(), now)).toBe("Pausado até amanhã 08:00");
    expect(pausedUntilLabel(new Date(2026, 10, 12, 8, 0).getTime(), now)).toBe("Pausado até 12/11/2026 08:00");
  });
  it("isPaused ignora pausa vencida", () => {
    expect(isPaused(null, 10)).toBe(false);
    expect(isPaused(5, 10)).toBe(false);
    expect(isPaused(20, 10)).toBe(true);
  });
});

describe("validateQuietHours", () => {
  it("rejeita início igual ao fim quando ligado", () => {
    expect(validateQuietHours(true, "21:00", "21:00")).toMatch(/mesmo horário/);
    expect(validateQuietHours(false, "21:00", "21:00")).toBeNull();
  });
  it("rejeita formato inválido", () => {
    expect(validateQuietHours(true, "25:00", "08:00")).toMatch(/inválido/);
    expect(validateQuietHours(true, "21:00", "08:00")).toBeNull();
  });
});

describe("EMAIL_FLAGS", () => {
  it("bate com os templates de e-mail do backend", () => {
    const src = readFileSync("convex/emailTemplates.ts", "utf8");
    const body = src.slice(src.indexOf("function buildTemplate"));
    const types = [...body.matchAll(/case "(\w+)":/g)].map((m) => m[1]);
    const nonFlags = new Set(["invite", "formSubmission", "formConfirmation", "taskOverdueSummary"]);
    const expected = types.filter((t) => !nonFlags.has(t)).sort();
    expect([...EMAIL_FLAGS].sort()).toEqual(expected);
  });
  it("tipos sem template não têm coluna de e-mail", () => {
    const rows = buildMatrixGroups().flatMap((g) => g.rows);
    for (const f of ["aiFollowupNeedsHuman", "conversationTransferred", "campaignCompleted"]) {
      expect(rows.find((r) => r.flag === f)?.channels).not.toContain("email");
    }
    expect(rows.find((r) => r.flag === "taskOverdue")?.channels).toContain("email");
  });
});

describe("NON_PERSONAL_FLAGS", () => {
  it("bate com a política do backend", () => {
    const src = readFileSync("convex/lib/notificationPolicy.ts", "utf8");
    const block = src.match(/NON_PERSONAL_FLAGS = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? "";
    const flags = [...block.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort();
    expect([...NON_PERSONAL_FLAGS].sort()).toEqual(flags);
  });
});

describe("isCustomized", () => {
  const rows = buildMatrixGroups().flatMap((g) => g.rows);
  it("sem escolhas por tipo não é personalizado, em cada atalho", () => {
    expect(isCustomized("all", () => true, rows)).toBe(false);
    expect(isCustomized("none", () => false, rows)).toBe(false);
    expect(isCustomized("mine", (_c, f) => !NON_PERSONAL_FLAGS.has(f), rows)).toBe(false);
  });
  it("uma célula diferente do atalho é personalizado", () => {
    expect(isCustomized("all", (c, f) => !(c === "email" && f === "taskOverdue"), rows)).toBe(true);
    expect(isCustomized("none", (c, f) => c === "telegram" && f === "newMessage", rows)).toBe(true);
  });
});

describe("pausa até amanhã 8 h no fuso do aparelho", () => {
  const original = process.env.TZ;
  it("muda com o fuso do aparelho", () => {
    try {
      const now = Date.UTC(2026, 10, 7, 15, 0);
      process.env.TZ = "America/Sao_Paulo";
      const sp = tomorrowEightLocal(now);
      expect(new Date(sp).toISOString()).toBe("2026-11-08T11:00:00.000Z");
      process.env.TZ = "Asia/Tokyo";
      const tk = tomorrowEightLocal(now);
      expect(new Date(tk).toISOString()).toBe("2026-11-08T23:00:00.000Z");
      expect(sp).not.toBe(tk);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
  it("pauseArgs usa custom só para amanhã", () => {
    expect(pauseArgs("1h", 0)).toEqual({ mode: "1h" });
    expect(pauseArgs("4h", 0)).toEqual({ mode: "4h" });
    expect(pauseArgs("tomorrow", Date.UTC(2026, 10, 7, 15, 0)).mode).toBe("custom");
  });
});

describe("externalChannelsText", () => {
  it("só cita avisos no aparelho quando houver push", () => {
    expect(externalChannelsText(false)).not.toMatch(/aparelho/);
    expect(externalChannelsText(true)).toMatch(/avisos no aparelho/);
  });
});

describe("presetHint e pauseScopeText", () => {
  it("o atalho Nada só cita avisos no aparelho com push", () => {
    expect(presetHint("none", false)).toBe("Nenhum aviso por e-mail ou Telegram. Tudo continua no sino.");
    expect(presetHint("none", true)).toContain("avisos no aparelho");
    expect(presetHint("zzz", true)).toBeUndefined();
  });
  it("a pausa cita a exceção do pedido de ajuda urgente só com o bypass ligado", () => {
    expect(pauseScopeText(false, true)).toContain("exceto pedido de ajuda urgente");
    expect(pauseScopeText(false, false)).not.toContain("exceto");
  });
});

describe("pushAvailability", () => {
  const base = { featureOn: true, vapidKey: "k", killSwitch: false, deviceSupported: false, hasLinkedDevice: false };
  it("coluna Push: aparelho com suporte OU aparelho vinculado", () => {
    expect(pushAvailability(base)).toEqual({ pushEnabled: true, pushAvailable: false });
    expect(pushAvailability({ ...base, deviceSupported: true }).pushAvailable).toBe(true);
    expect(pushAvailability({ ...base, hasLinkedDevice: true }).pushAvailable).toBe(true);
  });
  it("kill switch, recurso desligado ou sem chave VAPID desligam tudo", () => {
    for (const off of [{ killSwitch: true }, { featureOn: false }, { vapidKey: null }, { vapidKey: undefined }]) {
      expect(pushAvailability({ ...base, deviceSupported: true, ...off })).toEqual({ pushEnabled: false, pushAvailable: false });
    }
  });
});
