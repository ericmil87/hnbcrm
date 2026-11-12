import { useCallback, useEffect, useRef, useState } from "react";
import {
  VOICE_MESSAGES,
  pickVoiceRecordingType,
  resolveVoiceUploadFormat,
  voiceNoteFileName,
  voiceStartErrorMessage,
  voiceUploadErrorMessage,
  type VoiceUploadFormat,
} from "@/lib/voiceRecordingFormat";
import { VOICE_MAX_SECONDS } from "@/lib/onboardingAttachments";

export type VoicePhase = "idle" | "starting" | "recording" | "preview";

export interface VoiceTake {
  blob: Blob;
  format: VoiceUploadFormat;
  name: string;
  url: string;
}

export interface UseVoiceCaptureResult {
  phase: VoicePhase;
  elapsed: number;
  take: VoiceTake | null;
  /** Mensagem PT-BR do último problema (permissão negada, sem microfone, formato...). */
  error: string | null;
  start: () => void;
  stop: () => void;
  discard: () => void;
}

/** `MediaRecorder.isTypeSupported`, um stub "nada suportado" ou null sem MediaRecorder. */
function typeCheck(): ((type: string) => boolean) | null {
  if (typeof MediaRecorder === "undefined") return null;
  if (typeof MediaRecorder.isTypeSupported !== "function") return () => false;
  return (type: string) => MediaRecorder.isTypeSupported(type);
}

/**
 * Captura de voz do onboarding. Mesma lógica de formato do inbox
 * (`voiceRecordingFormat`: escolha do tipo pedido, formato REAL pelos bytes —
 * Safari grava mp4/AAC —, mensagens de erro), sem upload: devolve o `take`
 * (blob + formato + URL de prévia) e quem chama sobe. Para sozinho em
 * `VOICE_MAX_SECONDS`. Libera microfone e URL ao desmontar.
 */
export function useVoiceCapture(): UseVoiceCaptureResult {
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [take, setTake] = useState<VoiceTake | null>(null);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const urlRef = useRef<string | null>(null);

  const release = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // já parou
        }
      }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    chunksRef.current = [];
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      release();
    };
  }, [release]);

  const reset = useCallback(
    (message: string | null) => {
      release();
      setTake(null);
      setElapsed(0);
      setPhase("idle");
      setError(message);
    },
    [release]
  );

  const stop = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }, []);

  const start = useCallback(() => {
    if (busyRef.current || recorderRef.current) return;
    setError(null);
    const picked = pickVoiceRecordingType(typeCheck());
    if (!picked.ok) {
      setError(VOICE_MESSAGES.noMediaRecorder);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(VOICE_MESSAGES.noGetUserMedia);
      return;
    }
    busyRef.current = true;
    setPhase("starting");
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        busyRef.current = false;
        if (mountedRef.current) {
          setPhase("idle");
          setError(voiceStartErrorMessage(err));
        }
        return;
      }
      busyRef.current = false;
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      try {
        streamRef.current = stream;
        chunksRef.current = [];
        let requested = picked.mimeType;
        let recorder: MediaRecorder;
        try {
          recorder = requested ? new MediaRecorder(stream, { mimeType: requested }) : new MediaRecorder(stream);
        } catch {
          // Safari: diz que suporta e depois recusa. Usa o padrão do navegador.
          requested = "";
          recorder = new MediaRecorder(stream);
        }
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onerror = () => reset(VOICE_MESSAGES.recordingFailed);
        recorder.onstop = async () => {
          streamRef.current?.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          // Tipo REAL gravado (o Safari pode ignorar o pedido).
          const realType = recorder.mimeType || chunksRef.current[0]?.type || requested;
          const blob = new Blob(chunksRef.current, realType ? { type: realType } : undefined);
          let head = new Uint8Array();
          try {
            head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
          } catch {
            // cai para os rótulos
          }
          if (!mountedRef.current || recorderRef.current !== recorder) return;
          const format = resolveVoiceUploadFormat({
            head,
            size: blob.size,
            recorderMimeType: recorder.mimeType,
            blobType: blob.type,
            requestedMimeType: requested,
          });
          if (!format.ok) {
            reset(voiceUploadErrorMessage(format.error));
            return;
          }
          const url = URL.createObjectURL(blob);
          urlRef.current = url;
          recorderRef.current = null;
          setTake({ blob, format, name: voiceNoteFileName(format, Date.now()), url });
          setPhase("preview");
        };
        recorder.start();
        setElapsed(0);
        setPhase("recording");
        timerRef.current = window.setInterval(() => {
          setElapsed((s) => {
            if (s + 1 >= VOICE_MAX_SECONDS) queueMicrotask(stop);
            return s + 1;
          });
        }, 1000);
      } catch (err) {
        reset(voiceStartErrorMessage(err));
      }
    })();
  }, [reset, stop]);

  const discard = useCallback(() => reset(null), [reset]);

  return { phase, elapsed, take, error, start, stop, discard };
}
