import { useRef, useEffect, useCallback } from "react";

interface PartialCaptureConfig {
  formSlug: string;
  siteUrl: string;
  totalFields: number;
  enabled: boolean;
}

interface PartialCaptureReturn {
  sessionId: string | null;
  onFieldBlur: (fieldId: string, value: string) => void;
  onStepChange: (step: number) => void;
}

const DEBOUNCE_MS = 2000;
const PERIODIC_SAVE_MS = 45_000;

function getOrCreateSessionId(slug: string): string {
  const key = `hnbcrm_session_${slug}`;
  let id = sessionStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
  }
  return id;
}

export function usePartialCapture({
  formSlug,
  siteUrl,
  totalFields,
  enabled,
}: PartialCaptureConfig): PartialCaptureReturn {
  const sessionIdRef = useRef<string | null>(null);
  const completedFieldsRef = useRef<Set<string>>(new Set());
  const dataRef = useRef<Record<string, string>>({});
  const currentStepRef = useRef<number>(0);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const periodicTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastSavedRef = useRef<string>("");
  const hasMountedRef = useRef(false);

  // Initialize session on mount
  useEffect(() => {
    if (!enabled || !formSlug) return;
    sessionIdRef.current = getOrCreateSessionId(formSlug);
    hasMountedRef.current = true;
  }, [enabled, formSlug]);

  const buildPayload = useCallback(() => {
    return {
      slug: formSlug,
      sessionId: sessionIdRef.current,
      data: { ...dataRef.current },
      completedFieldIds: Array.from(completedFieldsRef.current),
      currentStep: currentStepRef.current,
      totalFields,
    };
  }, [formSlug, totalFields]);

  const save = useCallback(
    (useSendBeacon = false) => {
      if (!enabled || !sessionIdRef.current || completedFieldsRef.current.size === 0) return;

      const payload = buildPayload();
      const payloadStr = JSON.stringify(payload);

      // Skip if nothing changed
      if (payloadStr === lastSavedRef.current) return;
      lastSavedRef.current = payloadStr;

      const url = `${siteUrl}/api/v1/forms/public/partial`;

      if (useSendBeacon && navigator.sendBeacon) {
        const blob = new Blob([payloadStr], { type: "application/json" });
        navigator.sendBeacon(url, blob);
      } else {
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payloadStr,
          keepalive: true,
        }).catch(() => {
          // Silent fail — partial capture is best-effort
        });
      }
    },
    [enabled, siteUrl, buildPayload]
  );

  // Debounced save after field interactions
  const scheduleSave = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      save();
    }, DEBOUNCE_MS);
  }, [save]);

  // Field blur handler
  const onFieldBlur = useCallback(
    (fieldId: string, value: string) => {
      if (!enabled) return;
      const trimmed = typeof value === "string" ? value.trim() : "";
      if (trimmed) {
        completedFieldsRef.current.add(fieldId);
        dataRef.current[fieldId] = value;
      } else {
        completedFieldsRef.current.delete(fieldId);
        delete dataRef.current[fieldId];
      }
      scheduleSave();
    },
    [enabled, scheduleSave]
  );

  // Step change handler — immediate save
  const onStepChange = useCallback(
    (step: number) => {
      if (!enabled) return;
      currentStepRef.current = step;
      // Clear debounce and save immediately
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      save();
    },
    [enabled, save]
  );

  // beforeunload — send beacon
  useEffect(() => {
    if (!enabled) return;

    function handleBeforeUnload() {
      save(true);
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [enabled, save]);

  // Periodic save every 45s
  useEffect(() => {
    if (!enabled) return;

    periodicTimerRef.current = setInterval(() => {
      save();
    }, PERIODIC_SAVE_MS);

    return () => {
      if (periodicTimerRef.current) {
        clearInterval(periodicTimerRef.current);
      }
    };
  }, [enabled, save]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (periodicTimerRef.current) clearInterval(periodicTimerRef.current);
    };
  }, []);

  return {
    sessionId: enabled ? sessionIdRef.current : null,
    onFieldBlur,
    onStepChange,
  };
}
