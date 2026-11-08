import { describe, expect, it } from "vitest";
import { detectPlatform, isIosSafari, isStandaloneMode } from "./platform";
import { INSTALL_DISMISS_MS, shouldShowInstallInvite } from "./installInvite";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

describe("detectPlatform", () => {
  it("reconhece iPhone, iPad em modo desktop, Android e desktop", () => {
    expect(detectPlatform({ userAgent: IPHONE })).toBe("ios");
    expect(detectPlatform({ userAgent: IPAD_DESKTOP, platform: "MacIntel", maxTouchPoints: 5 })).toBe("ios");
    expect(detectPlatform({ userAgent: ANDROID })).toBe("android");
    expect(detectPlatform({ userAgent: DESKTOP })).toBe("desktop");
  });
  it("Mac de verdade (sem toque) é desktop", () => {
    expect(detectPlatform({ userAgent: IPAD_DESKTOP, platform: "MacIntel", maxTouchPoints: 0 })).toBe("desktop");
  });
  it("só o Safari do iPhone conta como Safari", () => {
    expect(isIosSafari(IPHONE)).toBe(true);
    expect(isIosSafari(IPHONE_CHROME)).toBe(false);
  });
});

describe("isStandaloneMode", () => {
  it("display-mode ou navigator.standalone", () => {
    expect(isStandaloneMode({ displayModeStandalone: true })).toBe(true);
    expect(isStandaloneMode({ navigatorStandalone: true })).toBe(true);
    expect(isStandaloneMode({})).toBe(false);
    expect(isStandaloneMode({ displayModeStandalone: false, navigatorStandalone: false })).toBe(false);
  });
});

describe("shouldShowInstallInvite", () => {
  const base = { visits: 3, standalone: false, installable: true, dismissedAt: null, now: 1_000_000_000 };
  it("aparece a partir do 3º acesso", () => {
    expect(shouldShowInstallInvite({ ...base, visits: 2 })).toBe(false);
    expect(shouldShowInstallInvite(base)).toBe(true);
  });
  it("nunca em standalone nem sem como instalar", () => {
    expect(shouldShowInstallInvite({ ...base, standalone: true })).toBe(false);
    expect(shouldShowInstallInvite({ ...base, installable: false })).toBe(false);
  });
  it("dispensa vale 30 dias", () => {
    expect(shouldShowInstallInvite({ ...base, dismissedAt: base.now - INSTALL_DISMISS_MS + 1 })).toBe(false);
    expect(shouldShowInstallInvite({ ...base, dismissedAt: base.now - INSTALL_DISMISS_MS })).toBe(true);
  });
});
