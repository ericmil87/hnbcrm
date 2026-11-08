// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KNOWN_FLAGS } from "../../convex/lib/notificationPolicy";
import { EMAIL_FLAGS, buildMatrixGroups, isPaused, pausedUntilLabel, validateQuietHours, FLAG_COPY } from "./notificationPrefsUi";

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
