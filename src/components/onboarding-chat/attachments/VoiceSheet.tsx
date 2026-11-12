import { useState } from "react";
import { Mic, Send, Square, Trash2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { validateVoiceSize, VOICE_MAX_SECONDS } from "@/lib/onboardingAttachments";
import type { AttachmentDraft } from "@/lib/onboardingAttachments";
import { useVoiceCapture } from "./useVoiceCapture";
import type { SubmitAttachmentResult, UploadPhase } from "./AttachmentSheet";

export interface VoiceSheetProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (draft: AttachmentDraft) => Promise<SubmitAttachmentResult>;
  phase: UploadPhase;
}

function timer(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function VoiceBody({ onClose, onSubmit, phase, onSendingChange }: Omit<VoiceSheetProps, "open"> & { onSendingChange: (sending: boolean) => void }) {
  const { phase: rec, elapsed, take, error, start, stop, discard } = useVoiceCapture();
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const busy = sending || phase !== null;
  const size = take ? validateVoiceSize(take.blob.size) : null;
  const shownError = sendError ?? error ?? (size && !size.ok ? size.message : null);

  const send = async () => {
    if (!take || !size?.ok) return;
    setSending(true);
    onSendingChange(true);
    setSendError(null);
    const result = await onSubmit({ kind: "audio", file: take.blob, name: take.name, mimeType: take.format.mimeType });
    setSending(false);
    onSendingChange(false);
    if (result.ok) onClose();
    else setSendError(result.message);
  };

  return (
    <div className="space-y-3">
      {rec === "idle" || rec === "starting" ? (
        <>
          <p className="text-sm text-text-secondary">
            Conte sobre o seu negócio falando. Dá para gravar até {VOICE_MAX_SECONDS / 60} minutos (2 MB). Você ouve antes de enviar.
          </p>
          <Button type="button" size="lg" className="w-full" onClick={start} loading={rec === "starting"}>
            <Mic className="size-5" aria-hidden="true" />
            Começar a gravar
          </Button>
        </>
      ) : rec === "recording" ? (
        <div className="flex min-h-11 items-center gap-3 rounded-card border border-border bg-surface-sunken px-3 py-2">
          <span className="relative flex size-2.5 shrink-0" aria-hidden="true">
            <span className="absolute inline-flex size-full rounded-full bg-semantic-error opacity-75 motion-safe:animate-ping" />
            <span className="relative inline-flex size-2.5 rounded-full bg-semantic-error" />
          </span>
          <span className="flex-1 text-sm tabular-nums text-text-primary" role="timer" aria-label="Tempo de gravação">
            Gravando… {timer(elapsed)}
          </span>
          <Button type="button" variant="ghost" iconOnly aria-label="Descartar gravação" onClick={discard}>
            <Trash2 className="size-5" aria-hidden="true" />
          </Button>
          <Button type="button" iconOnly aria-label="Parar gravação" onClick={stop}>
            <Square className="size-4" fill="currentColor" aria-hidden="true" />
          </Button>
        </div>
      ) : (
        take && (
          <div className="space-y-3">
            <audio controls src={take.url} className="w-full" aria-label="Prévia da gravação" />
            <div className="flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" disabled={busy} onClick={discard}>
                <Trash2 className="size-4" aria-hidden="true" />
                Gravar de novo
              </Button>
              <Button type="button" className="flex-1" loading={sending} disabled={!size?.ok || busy} onClick={() => void send()}>
                <Send className="size-4" aria-hidden="true" />
                Enviar áudio
              </Button>
            </div>
          </div>
        )
      )}
      <div aria-live="polite">
        {phase && <p className="text-sm text-text-secondary">{phase === "uploading" ? "Enviando o áudio…" : "Quase pronto…"}</p>}
      </div>
      {shownError && (
        <p role="alert" className="text-sm text-semantic-error">
          {shownError}
        </p>
      )}
    </div>
  );
}

/** Folha do microfone: grava, ouve a prévia e envia como anexo `audio` (≤ 2 MB). */
export function VoiceSheet({ open, onClose, onSubmit, phase }: VoiceSheetProps) {
  // Fechar descarta a gravação: o corpo desmonta e o hook solta microfone e URL.
  // Enquanto envia, fechar é ignorado (o áudio já está subindo).
  const [sending, setSending] = useState(false);
  const guardedClose = () => {
    if (!sending && phase === null) onClose();
  };
  return (
    <Modal open={open} onClose={guardedClose} title="Gravar áudio">
      {open && <VoiceBody onClose={onClose} onSubmit={onSubmit} phase={phase} onSendingChange={setSending} />}
    </Modal>
  );
}
