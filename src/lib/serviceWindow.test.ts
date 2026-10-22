import { describe, expect, it } from "vitest";
import { deviceViaLabel, getServiceWindowInfo, isComposerBlockedByWindow } from "./serviceWindow";

const NOW = 1_000_000_000_000;
const H = 3_600_000;
const M = 60_000;

describe("getServiceWindowInfo", () => {
  it("returns null without a window", () => {
    expect(getServiceWindowInfo(null, NOW + H, NOW)).toBeNull();
    expect(getServiceWindowInfo(undefined, NOW + H, NOW)).toBeNull();
  });

  it("template keeps the legacy WhatsApp copy", () => {
    expect(getServiceWindowInfo("template", null, NOW)).toEqual({
      text: "Janela fechada — requer template",
      closed: true,
    });
    expect(getServiceWindowInfo("template", NOW - 1, NOW)?.closed).toBe(true);
    expect(getServiceWindowInfo("template", NOW + 30 * M, NOW)?.text).toBe("Janela fecha em 30min");
    expect(getServiceWindowInfo("template", NOW + 5 * H, NOW)?.text).toBe("Janela fecha em 5h");
  });

  it("wait closed and open", () => {
    expect(getServiceWindowInfo("wait", null, NOW)?.text).toBe(
      "Janela fechada — aguarde o cliente escrever de novo"
    );
    expect(getServiceWindowInfo("wait", NOW + 5 * H + 20 * M, NOW)?.text).toBe("Janela fecha em 5h 20min");
    expect(getServiceWindowInfo("wait", NOW + 2 * H, NOW)?.text).toBe("Janela fecha em 2h");
    expect(getServiceWindowInfo("wait", NOW + 40 * M, NOW)?.text).toBe("Janela fecha em 40min");
    expect(getServiceWindowInfo("wait", NOW + 3 * 24 * H, NOW)?.text).toContain("até 7 dias");
  });
});

describe("isComposerBlockedByWindow", () => {
  it("blocks only wait + closed", () => {
    expect(isComposerBlockedByWindow("wait", null, NOW)).toBe(true);
    expect(isComposerBlockedByWindow("wait", NOW + H, NOW)).toBe(false);
    expect(isComposerBlockedByWindow("template", null, NOW)).toBe(false);
    expect(isComposerBlockedByWindow(null, null, NOW)).toBe(false);
  });
});

describe("deviceViaLabel", () => {
  it("labels by app", () => {
    expect(deviceViaLabel("page_inbox")).toBe("pelo Business Suite");
    expect(deviceViaLabel("other")).toBe("pelo app");
    expect(deviceViaLabel("unknown")).toBe("fora do CRM");
    expect(deviceViaLabel(undefined)).toBe("fora do CRM");
  });
});
