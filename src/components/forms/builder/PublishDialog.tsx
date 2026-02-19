import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/utils";
import { Copy, Check, ExternalLink, Globe, Code2 } from "lucide-react";
import { toast } from "sonner";

interface PublishDialogProps {
  open: boolean;
  onClose: () => void;
  form: {
    _id: string;
    name: string;
    slug: string;
    status: string;
  };
  onPublish: () => Promise<void>;
  onUnpublish: () => Promise<void>;
}

function CopyField({
  label,
  value,
  icon: Icon,
  isCode,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  isCode?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success("Link copiado!");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Nao foi possivel copiar");
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <Icon size={14} className="text-text-muted" aria-hidden="true" />
        <span className="text-[13px] font-medium text-text-secondary">{label}</span>
      </div>
      <div className="flex items-stretch gap-2">
        <div
          className={cn(
            "flex-1 min-w-0 px-3 py-2 rounded-lg border border-border-strong bg-surface-sunken",
            "text-sm text-text-secondary overflow-x-auto",
            isCode && "font-mono text-[12px]"
          )}
        >
          <span className="block whitespace-nowrap">{value}</span>
        </div>
        <button
          onClick={handleCopy}
          aria-label={`Copiar ${label}`}
          className={cn(
            "flex-shrink-0 min-w-[44px] min-h-[44px] px-3 rounded-lg border transition-all duration-150",
            "flex items-center justify-center",
            "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-overlay",
            copied
              ? "border-semantic-success bg-semantic-success/10 text-semantic-success"
              : "border-border-strong bg-surface-raised text-text-secondary hover:border-brand-500 hover:text-brand-500"
          )}
        >
          {copied ? (
            <Check size={16} aria-hidden="true" />
          ) : (
            <Copy size={16} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}

export function PublishDialog({
  open,
  onClose,
  form,
  onPublish,
  onUnpublish,
}: PublishDialogProps) {
  const [isLoading, setIsLoading] = useState(false);

  const isPublished = form.status === "published";
  const publicUrl = `${window.location.origin}/f/${form.slug}`;
  const iframeCode = `<iframe src="${publicUrl}" width="100%" height="600" frameborder="0"></iframe>`;

  const statusVariant =
    form.status === "published"
      ? "success"
      : form.status === "archived"
        ? "warning"
        : "default";

  const statusLabel =
    form.status === "published"
      ? "Publicado"
      : form.status === "archived"
        ? "Arquivado"
        : "Rascunho";

  async function handlePublish() {
    setIsLoading(true);
    try {
      await onPublish();
      toast.success("Formulario publicado com sucesso!");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Erro ao publicar";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleUnpublish() {
    setIsLoading(true);
    try {
      await onUnpublish();
      toast.success("Formulario despublicado");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Erro ao despublicar";
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Publicar Formulario">
      <div className="space-y-6">
        {/* Status card */}
        <div className="flex items-center justify-between py-3 px-4 rounded-lg bg-surface-sunken border border-border">
          <div className="min-w-0 mr-3">
            <p className="text-sm font-semibold text-text-primary truncate">{form.name}</p>
            <p className="text-[12px] text-text-muted mt-0.5 font-mono truncate">
              /f/{form.slug}
            </p>
          </div>
          <Badge variant={statusVariant}>{statusLabel}</Badge>
        </div>

        {/* Draft state */}
        {!isPublished && (
          <div className="space-y-3">
            <div className="flex items-start gap-3 p-4 rounded-lg bg-surface-sunken border border-border">
              <div className="w-2 h-2 rounded-full bg-text-muted mt-1.5 flex-shrink-0" aria-hidden="true" />
              <p className="text-sm text-text-secondary leading-relaxed">
                Este formulario esta em rascunho. Publique para comecar a receber envios — o
                formulario ficara acessivel publicamente via link e incorporacao (iframe).
              </p>
            </div>
            <Button
              variant="primary"
              className="w-full"
              onClick={handlePublish}
              disabled={isLoading}
            >
              <Globe size={16} aria-hidden="true" />
              {isLoading ? "Publicando..." : "Publicar"}
            </Button>
          </div>
        )}

        {/* Published state */}
        {isPublished && (
          <>
            {/* Green status indicator */}
            <div className="flex items-center gap-2.5 px-4 py-3 rounded-lg bg-semantic-success/10 border border-semantic-success/20">
              <div className="w-2 h-2 rounded-full bg-semantic-success flex-shrink-0" aria-hidden="true" />
              <span className="text-sm font-medium text-semantic-success">Formulario publicado</span>
            </div>

            {/* Copy fields */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold text-text-primary">
                Codigos de Incorporacao
              </h3>
              <CopyField
                label="Link publico"
                value={publicUrl}
                icon={ExternalLink}
              />
              <CopyField
                label="Codigo iframe"
                value={iframeCode}
                icon={Code2}
                isCode
              />
            </div>

            {/* Open in new tab */}
            <a
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                "flex items-center justify-center gap-2 w-full py-2.5 rounded-full",
                "text-sm font-medium text-text-secondary border border-border",
                "hover:border-border-strong hover:text-text-primary",
                "transition-colors duration-150 min-h-[44px]",
                "focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2 focus:ring-offset-surface-overlay"
              )}
            >
              <ExternalLink size={14} aria-hidden="true" />
              Abrir formulario
            </a>

            {/* Unpublish */}
            <div className="border-t border-border pt-4">
              <Button
                variant="danger"
                className="w-full"
                onClick={handleUnpublish}
                disabled={isLoading}
              >
                {isLoading ? "Despublicando..." : "Despublicar"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
