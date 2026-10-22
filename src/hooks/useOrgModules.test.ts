import { describe, expect, it } from "vitest";
import { computeAnyEnabled, type OrgModules } from "./useOrgModules";

const off: OrgModules = {
  units: false,
  departments: false,
  attribution: false,
  central: false,
  demoMode: false,
  metaMessaging: false,
};

describe("computeAnyEnabled", () => {
  it("is false with everything off", () => {
    expect(computeAnyEnabled(off)).toBe(false);
  });

  it("does not light up the Central for metaMessaging or demoMode", () => {
    expect(computeAnyEnabled({ ...off, metaMessaging: true })).toBe(false);
    expect(computeAnyEnabled({ ...off, demoMode: true })).toBe(false);
  });

  it("is true for any Central module", () => {
    for (const key of ["units", "departments", "attribution", "central"] as const) {
      expect(computeAnyEnabled({ ...off, [key]: true })).toBe(true);
    }
  });
});
