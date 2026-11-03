import { describe, it, expect } from "vitest";
import { formatCountdown, formatHour, isExpired, telegramDisplayName } from "./telegramLink";

describe("telegramLink", () => {
  it("formats countdown", () => {
    expect(formatCountdown(600_000, 0)).toBe("10:00");
    expect(formatCountdown(65_000, 0)).toBe("1:05");
    expect(formatCountdown(1_000, 5_000)).toBe("0:00");
  });
  it("detects expiry", () => {
    expect(isExpired(1000, 999)).toBe(false);
    expect(isExpired(1000, 1000)).toBe(true);
  });
  it("formats hour", () => {
    expect(formatHour(8)).toBe("08:00");
    expect(formatHour(18)).toBe("18:00");
  });
  it("display name falls back", () => {
    expect(telegramDisplayName({ username: "eric", firstName: "Eric" })).toBe("@eric");
    expect(telegramDisplayName({ firstName: "Eric" })).toBe("Eric");
    expect(telegramDisplayName({})).toBe("sua conta");
  });
});
