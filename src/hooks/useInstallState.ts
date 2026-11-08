import { useSyncExternalStore } from "react";
import { getInstallState, subscribeInstallState, startInstallCapture } from "@/lib/pwa/installStore";
import { isIosSafari, readPlatform, type InstallPlatform } from "@/lib/pwa/platform";

export interface InstallInfo {
  platform: InstallPlatform;
  /** Already running as an installed app (or installed during this session). */
  installed: boolean;
  /** The browser offered the native install dialog (Android/desktop Chromium). */
  canPrompt: boolean;
  /** iPhone/iPad in Safari: install is manual (Share > Add to Home Screen). */
  iosManual: boolean;
}

startInstallCapture();

/** Device install state for the invite banner and Settings › Este aparelho. */
export function useInstallState(): InstallInfo {
  const { canPrompt, installed } = useSyncExternalStore(subscribeInstallState, getInstallState, getInstallState);
  const platform = readPlatform();
  const iosManual = platform === "ios" && !installed && isIosSafari(navigator.userAgent);
  return { platform, installed, canPrompt, iosManual };
}
