import { describe, expect, it } from "vitest";
import { detectPlatform, installHelpKind, isIosSafari, isMacSafari, isStandaloneMode } from "./platform";
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

describe("detecção de navegadores no iOS e ajuda por plataforma", () => {
  const IG = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0 Safari/604.1";
  const FB = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0] Safari/604.1";
  const GSA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/320.0 Mobile/15E148 Safari/604.1";
  const EDGE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/130.0 Mobile/15E148 Safari/605.1.15";
  const FIREFOX = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15";
  const IPAD_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0 Mobile/15E148 Safari/604.1";
  const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Safari/605.1.15";
  const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

  it("navegadores embutidos e alternativos não são o Safari", () => {
    for (const ua of [IG, FB, GSA, EDGE, FIREFOX, IPAD_CHROME]) expect(isIosSafari(ua)).toBe(false);
  });
  it("iPad em modo desktop com Chrome é iOS", () => {
    expect(detectPlatform({ userAgent: IPAD_CHROME, platform: "MacIntel", maxTouchPoints: 5 })).toBe("ios");
  });
  it("Safari do macOS só quando não é Chrome", () => {
    expect(isMacSafari(MAC_SAFARI)).toBe(true);
    expect(isMacSafari(MAC_CHROME)).toBe(false);
  });
  it("installHelpKind", () => {
    const base = { platform: "desktop" as const, userAgent: MAC_CHROME, canPrompt: false, installed: false };
    expect(installHelpKind({ ...base, installed: true })).toBe("installed");
    expect(installHelpKind({ ...base, canPrompt: true })).toBe("prompt");
    expect(installHelpKind({ ...base, platform: "ios", userAgent: IPHONE })).toBe("ios-safari");
    expect(installHelpKind({ ...base, platform: "ios", userAgent: EDGE })).toBe("ios-other");
    expect(installHelpKind({ ...base, platform: "ios", userAgent: IG })).toBe("ios-other");
    expect(installHelpKind({ ...base, platform: "android", userAgent: ANDROID })).toBe("android-menu");
    expect(installHelpKind({ ...base, userAgent: MAC_SAFARI })).toBe("mac-safari");
    expect(installHelpKind(base)).toBe("desktop-menu");
  });
});
