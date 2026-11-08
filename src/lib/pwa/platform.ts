export type InstallPlatform = "ios" | "android" | "desktop";

export interface PlatformInput {
  userAgent: string;
  /** `navigator.platform` (iPadOS in desktop mode reports "MacIntel"). */
  platform?: string;
  maxTouchPoints?: number;
}

/** iPhone/iPod/iPad (including iPadOS 13+ in "desktop" mode, which presents as a touch Mac), Android, or desktop. */
export function detectPlatform({ userAgent, platform = "", maxTouchPoints = 0 }: PlatformInput): InstallPlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Macintosh|MacIntel/i.test(userAgent + " " + platform) && maxTouchPoints > 1) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "desktop";
}

/** iOS browsers other than Safari (Chrome, Firefox, Edge, Opera, in-app webviews) tag themselves in the UA. */
export function isIosSafari(userAgent: string): boolean {
  if (!/Safari\//i.test(userAgent)) return false;
  return !/CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA\/|FBAN|FBAV|Instagram/i.test(userAgent);
}

export interface StandaloneInput {
  /** `window.matchMedia("(display-mode: standalone)").matches` */
  displayModeStandalone?: boolean;
  /** iOS Safari's non-standard `navigator.standalone` */
  navigatorStandalone?: boolean;
}

export function isStandaloneMode({ displayModeStandalone, navigatorStandalone }: StandaloneInput): boolean {
  return displayModeStandalone === true || navigatorStandalone === true;
}

/** Reads the live browser; SSR/odd environments fall back to "not standalone, desktop". */
export function readStandalone(): boolean {
  if (typeof window === "undefined") return false;
  let displayModeStandalone = false;
  try {
    displayModeStandalone = window.matchMedia?.("(display-mode: standalone)").matches === true;
  } catch {
    /* ignore */
  }
  return isStandaloneMode({
    displayModeStandalone,
    navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone,
  });
}

export function readPlatform(): InstallPlatform {
  if (typeof navigator === "undefined") return "desktop";
  return detectPlatform({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
  });
}
