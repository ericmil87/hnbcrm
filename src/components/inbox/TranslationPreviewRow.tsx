import type { KeyboardEvent, RefObject } from "react";
import { AlertCircle, Languages, Pencil, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { languageDisplayName } from "@/lib/translationRules";
import { Button } from "@/components/ui/Button";
import { Tooltip } from "@/components/ui/Tooltip";
import type { ComposerPreviewView } from "@/components/inbox/useComposerTranslation";

export interface TranslationPreviewRowProps {
  view: ComposerPreviewView;
  editing: boolean;
  editedText?: string;
  /** A tradução editada difere da automática. */
  edited: boolean;
  /** "Revisar antes": o primeiro Enter já mostrou a prévia; o próximo envia. */
  armed?: boolean;
  /** "Revisar antes": nada sai sem prévia pronta (muda o texto do erro e da espera). */
  strict?: boolean;
  /** Erro do provedor: pedir a prévia de novo. */
  onRetry?: () => void;
  onEdit: () => void;
  onEditChange: (value: string) => void;
  onRestore: () => void;
  onUntranslated: () => void;
  /** Enter dentro do campo de edição (o container envia). */
  onEditKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  editRef?: RefObject<HTMLTextAreaElement | null>;
}

/**
 * Linha "Será enviado em espanhol: …" abaixo do campo do composer (tradução,
 * F3). Apresentacional: o container (`Composer.tsx`) liga a prévia e o envio.
 */
export function TranslationPreviewRow({
  view,
  editing,
  editedText,
  edited,
  armed = false,
  strict = false,
  onRetry,
  onEdit,
  onEditChange,
  onRestore,
  onUntranslated,
  onEditKeyDown,
  editRef,
}: TranslationPreviewRowProps) {
  const untranslatedButton = (
    <Tooltip content="Envia o texto como você escreveu, só desta vez">
      <Button type="button" variant="ghost" size="sm" onClick={onUntranslated}>
        Sem traduzir
      </Button>
    </Tooltip>
  );
  const skipReason = view.kind === "skipped" ? view.reason : null;

  return (
    <div
      className={cn(
        "mt-2 rounded-lg border bg-surface-sunken px-3 py-2 text-xs",
        armed ? "border-brand-500" : "border-border"
      )}
      data-testid="translation-preview"
    >
      {view.kind === "loading" && (
        <p className="flex items-center gap-1.5 text-text-muted" aria-live="polite">
          <Languages size={12} className="shrink-0 text-brand-500" aria-hidden />
          <span className="skeleton-shimmer rounded px-1">Traduzindo…</span>
        </p>
      )}

      {view.kind === "skipped" && view.reason === "same_language" && (
        <p className="flex items-center gap-1.5 text-text-secondary" aria-live="polite">
          <Languages size={12} className="shrink-0 text-brand-500" aria-hidden />
          Já está em {languageDisplayName(view.targetLang, { lower: true })}. Enviando sem traduzir.
        </p>
      )}

      {view.kind === "skipped" && view.reason === "long_text" && (
        <p className="flex items-center gap-1.5 text-text-secondary" aria-live="polite">
          <Languages size={12} className="shrink-0 text-brand-500" aria-hidden />
          Será traduzido ao enviar.
        </p>
      )}

      {view.kind === "error" && (
        <div className="space-y-1.5">
          <p className="flex items-start gap-1.5 text-semantic-warning" aria-live="polite">
            <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              {strict
                ? `Prévia indisponível: ${view.message} Nada é enviado sem você ver a tradução.`
                : `Prévia indisponível: ${view.message} Ao enviar, tentamos traduzir de novo, e nada sai sem tradução sem você confirmar.`}
            </span>
          </p>
          <div className="flex flex-wrap items-center justify-end gap-1">
            {onRetry && (
              <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
                <RotateCcw size={14} aria-hidden />
                Tentar de novo
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={onUntranslated}>
              Enviar sem traduzir
            </Button>
          </div>
        </div>
      )}

      {view.kind === "ready" && (
        <div className="space-y-1.5">
          <p className="flex flex-wrap items-center gap-1.5 text-text-secondary">
            <Languages size={12} className="shrink-0 text-brand-500" aria-hidden />
            <span>Será enviado em {languageDisplayName(view.targetLang, { lower: true })}:</span>
            {edited && <span className="font-medium text-text-primary">Tradução editada por você</span>}
          </p>
          {editing ? (
            <textarea
              ref={editRef}
              value={editedText ?? view.text}
              onChange={(e) => onEditChange(e.target.value)}
              onKeyDown={onEditKeyDown}
              lang={view.targetLang}
              dir="auto"
              rows={2}
              aria-label={`Tradução em ${languageDisplayName(view.targetLang, { lower: true })}`}
              className="w-full resize-y rounded-field border border-border-strong bg-composer-field px-2.5 py-1.5 text-base md:text-sm text-text-primary focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
          ) : (
            <p lang={view.targetLang} dir="auto" className="whitespace-pre-wrap break-words text-sm text-text-primary">
              {editedText !== undefined && editedText.trim() ? editedText : view.text}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-1">
            {edited && (
              <Button type="button" variant="ghost" size="sm" onClick={onRestore}>
                <RotateCcw size={14} aria-hidden />
                Usar a tradução automática
              </Button>
            )}
            {!editing && (
              <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
                <Pencil size={14} aria-hidden />
                Editar
              </Button>
            )}
            {untranslatedButton}
          </div>
        </div>
      )}

      {(view.kind === "loading" || skipReason === "long_text") && (
        <div className="mt-1 flex justify-end">{untranslatedButton}</div>
      )}

      <p className="mt-1 text-text-muted" aria-live="polite">
        {armed && view.kind === "loading" ? (
          <span className="font-medium text-brand-500">Aguarde a tradução para revisar e enviar.</span>
        ) : armed && view.kind === "skipped" && skipReason !== "same_language" && skipReason !== "long_text" ? (
          <span className="font-medium text-brand-500">Nada a traduzir. Enter de novo envia como está.</span>
        ) : armed && view.kind !== "error" ? (
          <span className="font-medium text-brand-500">Revise e confirme: Enter de novo envia.</span>
        ) : view.kind === "ready" ? (
          <span className="hidden md:inline">Enter envia a versão traduzida · Shift+Enter nova linha</span>
        ) : null}
      </p>
    </div>
  );
}
