import { useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { FileText, Globe, ImageIcon, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  ATTACHMENT_ACCEPT,
  validateAttachmentFile,
  validateAttachmentUrl,
  type AttachmentDraft,
} from "@/lib/onboardingAttachments";

export type SubmitAttachmentResult = { ok: true } | { ok: false; message: string };

/** Fase do envio de arquivo (`null` = nada em andamento). */
export type UploadPhase = "uploading" | "saving" | null;

export interface AttachmentSheetProps {
  open: boolean;
  onClose: () => void;
  /** Sobe (se preciso) e começa o turno. `ok:false` mantém a folha aberta com a mensagem. */
  onSubmit: (draft: AttachmentDraft) => Promise<SubmitAttachmentResult>;
  phase: UploadPhase;
}

type Step = "menu" | "url";

const PHASE_TEXT: Record<Exclude<UploadPhase, null>, string> = {
  uploading: "Enviando o arquivo…",
  saving: "Quase pronto…",
};

const OPTION_CLASS =
  "flex min-h-11 w-full items-center gap-3 rounded-field border border-border-subtle bg-surface-raised px-3 py-2 text-left text-sm font-medium text-text-primary hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50";

/**
 * Folha do clipe do chat de onboarding: "Link do site ou Instagram", "PDF" e
 * "Imagem/flyer". Valida endereço, tipo e tamanho antes de qualquer envio;
 * o resto (upload, turno) é de quem recebe `onSubmit`. Um anexo por turno.
 */
export function AttachmentSheet({ open, onClose, onSubmit, phase }: AttachmentSheetProps) {
  const [step, setStep] = useState<Step>("menu");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pdfRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const busy = submitting || phase !== null;

  const close = () => {
    if (busy) return;
    setStep("menu");
    setUrl("");
    setError(null);
    onClose();
  };

  const submit = async (draft: AttachmentDraft) => {
    setSubmitting(true);
    setError(null);
    const result = await onSubmit(draft);
    setSubmitting(false);
    if (result.ok) {
      setStep("menu");
      setUrl("");
      onClose();
    } else {
      setError(result.message);
    }
  };

  const onUrlSubmit = (e: FormEvent) => {
    e.preventDefault();
    const check = validateAttachmentUrl(url);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    void submit({ kind: "url", url: check.url });
  };

  const onFile = (kind: "pdf" | "image") => (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const check = validateAttachmentFile(kind, file);
    if (!check.ok) {
      setError(check.message);
      return;
    }
    void submit({ kind, file, name: file.name, mimeType: check.mimeType });
  };

  return (
    <Modal open={open} onClose={close} title={step === "url" ? "Link do site ou Instagram" : "Enviar material"}>
      <div className="space-y-3">
        {step === "menu" ? (
          <>
            <p className="text-sm text-text-secondary">Um material por mensagem. O Copiloto lê e usa para montar o seu CRM.</p>
            <button type="button" className={OPTION_CLASS} disabled={busy} onClick={() => { setError(null); setStep("url"); }}>
              <Globe className="size-5 shrink-0 text-brand-600" aria-hidden="true" />
              Link do site ou Instagram
            </button>
            <button type="button" className={OPTION_CLASS} disabled={busy} onClick={() => pdfRef.current?.click()}>
              <FileText className="size-5 shrink-0 text-brand-600" aria-hidden="true" />
              <span className="min-w-0 flex-1">PDF</span>
              <span className="text-caption text-text-muted">até 20 MB</span>
            </button>
            <button type="button" className={OPTION_CLASS} disabled={busy} onClick={() => imageRef.current?.click()}>
              <ImageIcon className="size-5 shrink-0 text-brand-600" aria-hidden="true" />
              <span className="min-w-0 flex-1">Imagem/flyer</span>
              <span className="text-caption text-text-muted">até 5 MB</span>
            </button>
            <input ref={pdfRef} type="file" accept={ATTACHMENT_ACCEPT.pdf} className="sr-only" tabIndex={-1} aria-label="Escolher PDF" onChange={onFile("pdf")} />
            <input ref={imageRef} type="file" accept={ATTACHMENT_ACCEPT.image} className="sr-only" tabIndex={-1} aria-label="Escolher imagem" onChange={onFile("image")} />
          </>
        ) : (
          <form onSubmit={onUrlSubmit} className="space-y-3" noValidate>
            <Input
              id="onboarding-attach-url"
              label="Endereço (https://…)"
              type="url"
              inputMode="url"
              autoComplete="url"
              autoFocus
              placeholder="https://www.minhaloja.com.br"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setError(null); }}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "onboarding-attach-error" : undefined}
            />
            <div className="flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" disabled={busy} onClick={() => { setError(null); setStep("menu"); }}>
                Voltar
              </Button>
              <Button type="submit" className="flex-1" loading={submitting}>
                Enviar link
              </Button>
            </div>
          </form>
        )}
        <div aria-live="polite" className="min-h-0 text-sm">
          {phase && (
            <p className="flex items-center gap-2 text-text-secondary">
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              {PHASE_TEXT[phase]}
            </p>
          )}
        </div>
        {error && (
          <p id="onboarding-attach-error" role="alert" className="text-sm text-semantic-error">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
