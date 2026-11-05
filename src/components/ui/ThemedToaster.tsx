import { useSyncExternalStore } from "react";
import { Toaster } from "sonner";
import { toasterTheme } from "@/lib/theme";
import { getAppliedTheme, subscribe } from "@/lib/themeDom";

export function ThemedToaster() {
  const theme = useSyncExternalStore(subscribe, getAppliedTheme);
  return <Toaster theme={toasterTheme(theme)} />;
}
