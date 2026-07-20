import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Mic, Trash2, Square, Send, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { AudioPlayer } from "./AudioPlayer";
import type { UploadedFile } from "@/components/ui/FileUploadButton";

interface VoiceRecorderProps {
  organizationId: Id<"organizations">;
  disabled?: boolean;
  /** Notifies the parent so it can hide the text input while recording. */
  onActiveChange?: (active: boolean) => void;
  /** Called with the uploaded voice-note file, ready to send. */
  onRecorded: (file: UploadedFile) => Promise<void> | void;
}

type Mode = "idle" | "recording" | "preview";

// Prefer ogg/opus (what WhatsApp expects); the backend converts as needed. Fall
// back to webm/opus which every evergreen browser records.
function pickMimeType(): { mimeType: string; ext: string } | null {
  const candidates: Array<{ mimeType: string; ext: string }> = [
    { mimeType: "audio/ogg;codecs=opus", ext: "ogg" },
    { mimeType: "audio/webm;codecs=opus", ext: "webm" },
    { mimeType: "audio/webm", ext: "webm" },
  ];
  const MR = typeof MediaRecorder !== "undefined" ? MediaRecorder : null;
  if (!MR) return null;
  for (const c of candidates) {
    if (MR.isTypeSupported(c.mimeType)) return c;
  }
  return { mimeType: "", ext: "webm" };
}

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
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

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const blobRef = useRef<Blob | null>(null);
  const extRef = useRef<string>("webm");
  const timerRef = useRef<number | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const saveFile = useMutation(api.files.saveFile);

  useEffect(() => {
    onActiveChange?.(mode !== "idle");
  }, [mode, onActiveChange]);

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const revokePreview = () => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  };

  // Tear everything down on unmount.
  useEffect(() => {
    return () => {
      clearTimer();
      cleanupStream();
      revokePreview();
    };
  }, []);

  const resetToIdle = () => {
    clearTimer();
    cleanupStream();
    revokePreview();
    chunksRef.current = [];
    blobRef.current = null;
    setPreviewUrl(null);
    setElapsed(0);
    setMode("idle");
  };

  const startRecording = async () => {
    const picked = pickMimeType();
    if (!picked) {
      toast.error("Seu navegador não suporta gravação de áudio");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Gravação de áudio indisponível neste dispositivo");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      extRef.current = picked.ext;
      chunksRef.current = [];

      const recorder = picked.mimeType
        ? new MediaRecorder(stream, { mimeType: picked.mimeType })
        : new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || picked.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        blobRef.current = blob;
        const url = URL.createObjectURL(blob);
        previewUrlRef.current = url;
        setPreviewUrl(url);
        cleanupStream();
        setMode("preview");
      };

      recorder.start();
      setElapsed(0);
      setMode("recording");
      timerRef.current = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    } catch (err) {
      cleanupStream();
      toast.error("Permissão de microfone negada");
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
    if (!blob) return;
    setSending(true);
    try {
      const ext = extRef.current;
      const mimeType = blob.type || (ext === "ogg" ? "audio/ogg" : "audio/webm");
      const name = `nota-de-voz-${Date.now()}.${ext}`;

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

      await onRecorded({ fileId, name, mimeType, size: blob.size });
      resetToIdle();
    } catch (err) {
      console.error("Falha ao enviar nota de voz", err);
      toast.error("Falha ao enviar nota de voz");
    } finally {
      setSending(false);
    }
  };

  if (mode === "idle") {
    return (
      <button
        type="button"
        onClick={startRecording}
        disabled={disabled}
        className={cn(
          "shrink-0 p-2 rounded-full text-text-muted hover:text-brand-500 hover:bg-brand-500/10 transition-colors",
          "disabled:opacity-40 disabled:cursor-not-allowed"
        )}
        aria-label="Gravar nota de voz"
        title="Gravar nota de voz"
      >
        <Mic size={18} />
      </button>
    );
  }

  if (mode === "recording") {
    return (
      <div className="flex-1 flex items-center gap-3 h-10 px-3 bg-surface-sunken border border-border-strong rounded-lg">
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
    <div className="flex-1 flex items-center gap-2 h-auto min-h-10 px-2 py-1.5 bg-surface-sunken border border-border-strong rounded-lg">
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
