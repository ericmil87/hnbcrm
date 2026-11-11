import { Tooltip } from "@/components/ui/Tooltip";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Mic, Trash2, Square, Send, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SendDeferredError } from "@/lib/messageDelivery";
import { cn } from "@/lib/utils";
import { AudioPlayer } from "./AudioPlayer";
import type { UploadedFile } from "@/components/ui/FileUploadButton";
import {
  VOICE_MESSAGES,
  pickVoiceRecordingType,
  resolveVoiceUploadFormat,
  voiceNoteFileName,
  voiceStartErrorMessage,
  voiceUploadErrorMessage,
  type VoiceUploadFormat,
} from "@/lib/voiceRecordingFormat";

interface VoiceRecorderProps {
  organizationId: Id<"organizations">;
  disabled?: boolean;
  /** Notifies the parent so it can hide the text input while recording. */
  onActiveChange?: (active: boolean) => void;
  /** Called with the uploaded voice-note file, ready to send. */
  onRecorded: (file: UploadedFile) => Promise<void> | void;
}

type Mode = "idle" | "recording" | "preview";

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** `MediaRecorder.isTypeSupported`, a "nothing supported" stub, or null without MediaRecorder. */
function mediaRecorderTypeCheck(): ((type: string) => boolean) | null {
  if (typeof MediaRecorder === "undefined") return null;
  if (typeof MediaRecorder.isTypeSupported !== "function") return () => false;
  return (type: string) => MediaRecorder.isTypeSupported(type);
}

export function VoiceRecorder({
  organizationId,
  disabled,
  onActiveChange,
  onRecorded,
}: VoiceRecorderProps) {
  const [mode, setMode] = useState<Mode>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // getUserMedia pending (permission prompt): blocks a second tap.
  const [starting, setStarting] = useState(false);

  const mountedRef = useRef(true);
  const startingRef = useRef(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  // Upload format resolved from the REAL recording when it stops.
  const formatRef = useRef<VoiceUploadFormat | null>(null);
  const uploadedRef = useRef<{ blob: Blob; file: UploadedFile } | null>(null);
  const timerRef = useRef<number | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);

  useEffect(() => {
    onActiveChange?.(mode !== "idle");
  }, [mode, onActiveChange]);

  const stopTracks = (stream: MediaStream | null) => {
    stream?.getTracks().forEach((t) => t.stop());
  };

  const cleanupStream = () => {
    stopTracks(streamRef.current);
    streamRef.current = null;
  };

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // Releases everything the recorder holds, WITHOUT touching React state (safe
  // on unmount): handlers detached first so a late `stop` cannot reopen the
  // preview, recorder stopped if active, microphone tracks stopped, preview
  // URL revoked.
  const teardown = () => {
    clearTimer();
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
          // already stopped
        }
      }
    }
    cleanupStream();
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    chunksRef.current = [];
    blobRef.current = null;
    formatRef.current = null;
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      teardown();
    };
    // teardown only reads refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetToIdle = () => {
    teardown();
    setPreviewUrl(null);
    setElapsed(0);
    setMode("idle");
  };

  const startRecording = async () => {
    if (startingRef.current || recorderRef.current) return;
    const picked = pickVoiceRecordingType(mediaRecorderTypeCheck());
    if (!picked.ok) {
      toast.error(VOICE_MESSAGES.noMediaRecorder);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error(VOICE_MESSAGES.noGetUserMedia);
      return;
    }

    startingRef.current = true;
    setStarting(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      startingRef.current = false;
      if (!mountedRef.current) return;
      setStarting(false);
      console.error("Microfone indisponível para a nota de voz.", err);
      toast.error(voiceStartErrorMessage(err));
      return;
    }
    startingRef.current = false;
    // Unmounted while the permission prompt was open: release the mic and leave.
    if (!mountedRef.current) {
      stopTracks(stream);
      return;
    }
    setStarting(false);

    try {
      streamRef.current = stream;
      chunksRef.current = [];
      formatRef.current = null;

      let recorder: MediaRecorder;
      let requested = picked.mimeType;
      try {
        recorder = requested ? new MediaRecorder(stream, { mimeType: requested }) : new MediaRecorder(stream);
      } catch {
        // Some Safari versions report a type as supported and then refuse it:
        // fall back to the browser default and let the real type decide.
        requested = "";
        recorder = new MediaRecorder(stream);
      }
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onerror = (e) => {
        console.error("A gravação da nota de voz falhou.", e);
        toast.error(VOICE_MESSAGES.recordingFailed);
        resetToIdle();
      };
      recorder.onstop = async () => {
        cleanupStream();
        // Real type of the recording (Safari may ignore the requested one).
        const realType = recorder.mimeType || chunksRef.current[0]?.type || requested;
        const blob = new Blob(chunksRef.current, realType ? { type: realType } : undefined);
        let head = new Uint8Array();
        try {
          head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
        } catch {
          // fall back to the labels
        }
        // Canceled or unmounted while reading the header.
        if (!mountedRef.current || recorderRef.current !== recorder) return;

        const format = resolveVoiceUploadFormat({
          head,
          size: blob.size,
          recorderMimeType: recorder.mimeType,
          blobType: blob.type,
          requestedMimeType: requested,
        });
        if (!format.ok) {
          console.error("Formato de nota de voz não suportado.", format.detectedType, blob.size);
          toast.error(voiceUploadErrorMessage(format.error));
          resetToIdle();
          return;
        }
        formatRef.current = format;
        blobRef.current = blob;
        const url = URL.createObjectURL(blob);
        previewUrlRef.current = url;
        setPreviewUrl(url);
        setMode("preview");
      };

      recorder.start();
      setElapsed(0);
      setMode("recording");
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch (err) {
      console.error("Não foi possível iniciar a gravação da nota de voz.", err);
      resetToIdle();
      toast.error(voiceStartErrorMessage(err));
    }
  };

  const stopRecording = () => {
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  };

  const handleSend = async () => {
    const blob = blobRef.current;
    const format = formatRef.current;
    if (!blob || !format) return;
    setSending(true);
    try {
      // Format resolved from the real recording in `onstop`
      // (Safari records mp4/AAC → audio/mp4 + .m4a).
      const mimeType = format.mimeType;
      const name = voiceNoteFileName(format, Date.now());

      // Reenvio da mesma gravação (ex.: depois de cancelar um diálogo): reusa o arquivo já enviado.
      let file = uploadedRef.current?.blob === blob ? uploadedRef.current.file : null;
      if (!file) {
        const uploadUrl = await generateUploadUrl({ organizationId });
        const response = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": mimeType },
          body: blob,
        });
        if (!response.ok) throw new Error("upload failed");
        const { storageId } = await response.json();

        const fileId = await saveFile({
          organizationId,
          storageId,
          name,
          mimeType,
          size: blob.size,
          fileType: "message_attachment",
        });
        file = { fileId, name, mimeType, size: blob.size };
        uploadedRef.current = { blob, file };
      }

      await onRecorded(file);
      if (mountedRef.current) resetToIdle();
    } catch (err) {
      // O envio ficou pendente de um diálogo de confirmação: a gravação continua na prévia.
      if (err instanceof SendDeferredError) return;
      console.error("Não foi possível enviar a nota de voz.", err);
      toast.error("Não foi possível enviar a nota de voz.");
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  if (mode === "idle") {
    return (
      <Tooltip content="Gravar nota de voz">
        <button
          type="button"
          onClick={startRecording}
          disabled={disabled || starting}
          aria-busy={starting || undefined}
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition-colors hover:bg-brand-700",
            "disabled:opacity-40 disabled:cursor-not-allowed"
          )}
          aria-label="Gravar nota de voz"
        >
          {starting ? <Loader2 size={20} className="animate-spin" /> : <Mic size={20} />}
        </button>
      </Tooltip>
    );
  }

  if (mode === "recording") {
    return (
      <div className="flex-1 flex items-center gap-3 h-11 px-3 bg-surface-sunken border border-border-strong rounded-3xl">
        <span className="relative flex h-2.5 w-2.5 shrink-0">
          <span className="absolute inline-flex h-full w-full rounded-full bg-semantic-error opacity-75 animate-ping" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-semantic-error" />
        </span>
        <span className="text-sm text-text-secondary tabular-nums flex-1">
          Gravando… {formatTimer(elapsed)}
        </span>
        <button
          type="button"
          onClick={resetToIdle}
          className="shrink-0 p-1.5 rounded-full text-text-muted hover:text-semantic-error hover:bg-surface-raised transition-colors"
          aria-label="Cancelar gravação"
        >
          <Trash2 size={18} />
        </button>
        <button
          type="button"
          onClick={stopRecording}
          className="shrink-0 flex items-center justify-center h-9 w-9 rounded-full bg-brand-600 text-white hover:bg-brand-700 transition-colors"
          aria-label="Parar gravação"
        >
          <Square size={16} fill="currentColor" />
        </button>
      </div>
    );
  }

  // preview
  return (
    <div className="flex-1 flex items-center gap-2 h-auto min-h-11 px-2 py-1.5 bg-surface-sunken border border-border-strong rounded-3xl">
      <button
        type="button"
        onClick={resetToIdle}
        disabled={sending}
        className="shrink-0 p-1.5 rounded-full text-text-muted hover:text-semantic-error hover:bg-surface-raised transition-colors disabled:opacity-40"
        aria-label="Descartar nota de voz"
      >
        <Trash2 size={18} />
      </button>
      {previewUrl && <AudioPlayer src={previewUrl} variant="inbound" isVoiceNote className="flex-1" />}
      <button
        type="button"
        onClick={handleSend}
        disabled={sending}
        className="shrink-0 flex items-center justify-center h-9 w-9 rounded-full bg-brand-600 text-white hover:bg-brand-700 transition-colors disabled:opacity-50"
        aria-label="Enviar nota de voz"
      >
        {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
      </button>
    </div>
  );
}
