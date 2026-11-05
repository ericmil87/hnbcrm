import { describe, expect, it } from "vitest";
import { TIMEZONES, timezoneLabel, timezoneOptions } from "./timezones";

describe("timezones", () => {
  it("mantém os ids IANA que já eram persistidos", () => {
    const ids = TIMEZONES.map((tz) => tz.value);
    for (const id of [
      "UTC", "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
      "America/Sao_Paulo", "Europe/London", "Europe/Berlin", "Asia/Tokyo",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("não tem ids repetidos nem rótulos em inglês", () => {
    expect(new Set(TIMEZONES.map((tz) => tz.value)).size).toBe(TIMEZONES.length);
    for (const tz of TIMEZONES) {
      expect(tz.label).not.toMatch(/\b(Time|London|Berlin|Tokyo)\b/);
    }
  });

  it("timezoneLabel devolve o nome em português ou o id", () => {
    expect(timezoneLabel("America/Sao_Paulo")).toBe("São Paulo (Brasília)");
    expect(timezoneLabel("Europe/London")).toBe("Londres");
    expect(timezoneLabel("Africa/Cairo")).toBe("Africa/Cairo");
  });

  it("timezoneOptions preserva um fuso salvo fora da lista", () => {
    expect(timezoneOptions().length).toBe(TIMEZONES.length);
    expect(timezoneOptions("America/Sao_Paulo").length).toBe(TIMEZONES.length);
    const withExtra = timezoneOptions("Africa/Cairo");
    expect(withExtra[0]).toEqual({ value: "Africa/Cairo", label: "Africa/Cairo" });
    expect(withExtra.length).toBe(TIMEZONES.length + 1);
  });
});
