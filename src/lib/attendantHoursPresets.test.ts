import { describe, expect, it } from "vitest";
import { HOURS_PRESETS, applyHoursPreset, matchHoursPreset } from "./attendantHoursPresets";

describe("attendantHoursPresets", () => {
  it("Sempre é 24 h e Comercial é seg–sex 8–18", () => {
    expect(HOURS_PRESETS[0].value.allDay).toBe(true);
    expect(HOURS_PRESETS[1].value).toMatchObject({ allDay: false, startHour: 8, endHour: 18, days: [1, 2, 3, 4, 5] });
  });
  it("preserva o fuso da organização", () => {
    expect(applyHoursPreset(HOURS_PRESETS[1], { startHour: 9, endHour: 20, timezone: "America/Manaus" }).timezone).toBe("America/Manaus");
    expect(applyHoursPreset(HOURS_PRESETS[1], { startHour: 9, endHour: 20 })).not.toHaveProperty("timezone");
  });
  it("reconhece o preset atual ou cai em custom", () => {
    expect(matchHoursPreset(HOURS_PRESETS, { allDay: true, startHour: 9, endHour: 18 })).toBe("always");
    expect(matchHoursPreset(HOURS_PRESETS, { allDay: false, startHour: 8, endHour: 18, days: [5, 4, 3, 2, 1] })).toBe("business");
    expect(matchHoursPreset(HOURS_PRESETS, { allDay: false, startHour: 8, endHour: 18 })).toBe("custom");
    expect(matchHoursPreset(HOURS_PRESETS, { allDay: false, startHour: 9, endHour: 18, days: [1, 2, 3, 4, 5] })).toBe("custom");
  });
});
