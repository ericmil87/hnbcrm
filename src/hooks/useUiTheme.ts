import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  THEME_STORAGE_KEY,
  isAppPath,
  isUiTheme,
  resolveTheme,
  shouldPushLocalToServer,
  type UiTheme,
} from "@/lib/theme";
import { applyTheme, clearTheme, getAppliedTheme, subscribe } from "@/lib/themeDom";

function readLocal(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLocal(theme: UiTheme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage unavailable (private mode): the account value still applies
  }
}

const SAVE_ERROR =
  "Não foi possível salvar sua preferência de tema. Tente de novo.";

/** Call only in AuthLayout, before any conditional return. */
export function useUiTheme(
  currentMember: { uiTheme?: unknown } | null | undefined,
  organizationId: Id<"organizations"> | null,
) {
  const setMyUiTheme = useMutation(api.teamMembers.setMyUiTheme);
  const theme = useSyncExternalStore(subscribe, getAppliedTheme);
  const pushedRef = useRef(false);
  const pendingRef = useRef(0); // in-flight setTheme mutations
  const lastChoiceRef = useRef<UiTheme | null>(null);
  const server = currentMember?.uiTheme;
  const hasMember = !!currentMember;

  useEffect(() => {
    if (!hasMember || !isAppPath(window.location.pathname)) return;
    const local = readLocal();
    // Ignore the server echo while our own change is still being saved (avoids flicker).
    if (pendingRef.current > 0 && lastChoiceRef.current) return;
    const resolved = resolveTheme({ server, local });
    applyTheme(resolved);
    if (isUiTheme(server) && server !== local) writeLocal(server);
    if (!pushedRef.current && organizationId && shouldPushLocalToServer({ server, local })) {
      pushedRef.current = true;
      setMyUiTheme({ organizationId, theme: resolved }).catch(() => {
        pushedRef.current = false;
      });
    }
  }, [hasMember, server, organizationId, setMyUiTheme]);

  // Leaving /app (unmount) returns to the dark default.
  useEffect(() => () => clearTheme(), []);

  const setTheme = useCallback(
    (next: UiTheme) => {
      applyTheme(next);
      writeLocal(next);
      if (!organizationId) return;
      lastChoiceRef.current = next;
      pendingRef.current += 1;
      setMyUiTheme({ organizationId, theme: next })
        .catch(() => {
          toast.error(SAVE_ERROR);
        })
        .finally(() => {
          pendingRef.current -= 1;
        });
    },
    [organizationId, setMyUiTheme],
  );

  return { theme, setTheme };
}
