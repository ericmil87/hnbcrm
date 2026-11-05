import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  THEME_OWNER_KEY,
  THEME_STORAGE_KEY,
  failureAction,
  isAppPath,
  isForeignLocalTheme,
  isUiTheme,
  resolveTheme,
  shouldPushLocalToServer,
  type UiTheme,
} from "@/lib/theme";
import { createDebounced } from "@/lib/debounce";
import { applyTheme, clearStoredTheme, clearTheme, getAppliedTheme, subscribe } from "@/lib/themeDom";

/** Arrow-key bursts in the picker become a single save. */
const SAVE_DEBOUNCE_MS = 400;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(theme: UiTheme, userId: string | undefined) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    if (userId) localStorage.setItem(THEME_OWNER_KEY, userId);
  } catch {
    // storage unavailable (private mode): the account value still applies
  }
}

const SAVE_ERROR =
  "Não foi possível salvar sua preferência de tema. Tente de novo.";

/** Call only in AuthLayout, before any conditional return. */
export function useUiTheme(
  currentMember: { uiTheme?: unknown; userId?: unknown } | null | undefined,
  organizationId: Id<"organizations"> | null,
) {
  const setMyUiTheme = useMutation(api.teamMembers.setMyUiTheme);
  const theme = useSyncExternalStore(subscribe, getAppliedTheme);
  const pushedRef = useRef(false);
  const busyRef = useRef(false); // our own change is scheduled or being saved
  const inFlightRef = useRef(0);
  const lastChoiceRef = useRef<UiTheme | null>(null);
  const mountedRef = useRef(true);
  const server = currentMember?.uiTheme;
  const userId = typeof currentMember?.userId === "string" ? currentMember.userId : undefined;
  const hasMember = !!currentMember;

  // Latest values for the debounced save (it fires after the render that scheduled it).
  const serverRef = useRef<unknown>(server);
  const userIdRef = useRef<string | undefined>(userId);
  const setMyUiThemeRef = useRef(setMyUiTheme);
  useEffect(() => {
    serverRef.current = server;
    userIdRef.current = userId;
    setMyUiThemeRef.current = setMyUiTheme;
  });

  useEffect(() => {
    if (!hasMember || !isAppPath(window.location.pathname)) return;
    // Ignore the server echo while our own change is still being saved (avoids flicker).
    if (busyRef.current && lastChoiceRef.current) return;
    const owner = readStorage(THEME_OWNER_KEY);
    // A device theme left by another account (expired session) is not this user's choice.
    const foreign = isForeignLocalTheme({ owner, userId });
    if (foreign) clearStoredTheme();
    const local = foreign ? null : readStorage(THEME_STORAGE_KEY);
    const resolved = resolveTheme({ server, local });
    applyTheme(resolved);
    if (isUiTheme(server) && (server !== local || owner !== userId)) writeLocal(server, userId);
    if (!pushedRef.current && organizationId && shouldPushLocalToServer({ server, local, owner: foreign ? null : owner, userId })) {
      pushedRef.current = true;
      writeLocal(resolved, userId);
      setMyUiTheme({ organizationId, theme: resolved }).catch(() => {
        pushedRef.current = false;
      });
    }
  }, [hasMember, server, userId, organizationId, setMyUiTheme]);

  const saveRef = useRef(
    createDebounced<{ organizationId: Id<"organizations">; theme: UiTheme }>((arg) => {
      inFlightRef.current += 1;
      setMyUiThemeRef.current(arg)
        .catch(() => {
          const action = failureAction({
            mounted: mountedRef.current,
            lastChoice: lastChoiceRef.current,
            failed: arg.theme,
            pendingSave: saveRef.current.pending(),
          });
          // Unmounted (sign-out / expired session): no toast, no data-theme on a public page, no storage write.
          if (action === "ignore") return;
          toast.error(SAVE_ERROR);
          if (action !== "toast-and-revert") return;
          const saved = serverRef.current;
          applyTheme(resolveTheme({ server: saved, local: saved }));
          if (isUiTheme(saved)) writeLocal(saved, userIdRef.current);
          else clearStoredTheme();
        })
        .finally(() => {
          inFlightRef.current -= 1;
          if (!mountedRef.current) return;
          if (lastChoiceRef.current === arg.theme && inFlightRef.current === 0 && !saveRef.current.pending()) {
            busyRef.current = false;
            // The echo may have been ignored while busy: reapply what the account says.
            const saved = serverRef.current;
            if (isUiTheme(saved) && getAppliedTheme() !== saved) {
              applyTheme(saved);
              writeLocal(saved, userIdRef.current);
            }
          }
        });
    }, SAVE_DEBOUNCE_MS),
  );

  // Leaving /app (unmount) returns to the dark default. Mark unmounted BEFORE the flush so a failing
  // save (no session) cannot touch the DOM, storage or toasts.
  useEffect(() => {
    mountedRef.current = true;
    const save = saveRef.current;
    return () => {
      mountedRef.current = false;
      save.flush();
      clearTheme();
    };
  }, []);

  const setTheme = useCallback(
    (next: UiTheme) => {
      applyTheme(next);
      writeLocal(next, userIdRef.current);
      if (!organizationId) return;
      lastChoiceRef.current = next;
      busyRef.current = true;
      saveRef.current.call({ organizationId, theme: next });
    },
    [organizationId],
  );

  return { theme, setTheme };
}
