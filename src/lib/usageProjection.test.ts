import { describe, expect, it } from "vitest";
import {
  CYCLE_CLOSE_TEXT,
  daysLeftInMonthUtc,
  describeUsage,
  meterState,
  monthKeyUtc,
  projectUsage,
  usagePercent,
} from "./usageProjection";

const at = (iso: string) => Date.parse(iso);

describe("usageProjection", () => {
  it("projeta linearmente (metade do mes dobra)", () => {
    expect(projectUsage(100, "2026-11", at("2026-11-16T00:00:00Z"))).toBe(200);
  });
  it("mes encerrado devolve o usado", () => {
    expect(projectUsage(100, "2026-11", at("2026-12-02T00:00:00Z"))).toBe(100);
  });
  it("estados do medidor", () => {
    expect(meterState(79, 100)).toBe("ok");
    expect(meterState(80, 100)).toBe("warn80");
    expect(meterState(99, 100)).toBe("warn80");
    expect(meterState(100, 100)).toBe("limit100");
    expect(meterState(5000, null)).toBe("ok");
    expect(usagePercent(250, 1000)).toBe(25);
    expect(usagePercent(1, null)).toBeNull();
  });
  it("dias restantes e chave do mes em UTC", () => {
    expect(daysLeftInMonthUtc(at("2026-11-09T12:00:00Z"))).toBe(22);
    expect(daysLeftInMonthUtc(at("2026-11-30T23:00:00Z"))).toBe(1);
    expect(daysLeftInMonthUtc(at("2026-02-01T00:00:00Z"))).toBe(28);
    expect(monthKeyUtc(at("2026-12-31T23:59:00Z"))).toBe("2026-12");
  });
  it("describeUsage junta tudo", () => {
    const v = describeUsage({ used: 400, included: 1000, monthKey: "2026-11", now: at("2026-11-16T00:00:00Z") });
    expect(v.state).toBe("ok");
    expect(v.projected).toBe(800);
    expect(v.projectedState).toBe("warn80");
    expect(v.cycleCloseText).toBe(CYCLE_CLOSE_TEXT);
    expect(CYCLE_CLOSE_TEXT).toContain("21h do último dia");
  });
});
