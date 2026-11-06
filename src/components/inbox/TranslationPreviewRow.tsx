import { useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { AlertCircle, Languages, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { languageDisplayName } from "@/lib/translationRules";
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

/** Botão de texto compacto da faixa: visual de ~24 px, área de toque de 44 px. */
const STRIP_BUTTON =
  "relative inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-caption font-medium text-brand-400 transition-colors hover:bg-brand-500/10 " +
  "before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-['']";

function StripButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={STRIP_BUTTON}>
      {children}
    </button>
  );
}

/**
 * Faixa fina "Espanhol: …" ACIMA do campo do composer (tradução, F3), no
 * estilo da barra de resposta. Apresentacional: o container (`Composer.tsx`)
 * liga a prévia e o envio.
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
  const [expanded, setExpanded] = useState(false);
  const skipReason = view.kind === "skipped" ? view.reason : null;
  const untranslatedButton = (
    <Tooltip content="Envia o texto como você escreveu, só desta vez">
      <StripButton onClick={onUntranslated}>Sem traduzir</StripButton>
    </Tooltip>
  );
  const icon = <Languages size={13} className="shrink-0 text-brand-500" aria-hidden />;

  return (
    <div
      className={cn(
        "mb-1.5 overflow-hidden rounded-xl border-l-4 bg-surface-sunken py-1.5 pl-2.5 pr-1.5 text-caption",
        armed ? "border-brand-500 ring-1 ring-brand-500" : "border-brand-500/60"
      )}
      data-testid="translation-preview"
    >
      {view.kind === "loading" && (
        <div className="flex items-center gap-1.5 text-text-muted" aria-live="polite">
          {icon}
          <span className="skeleton-shimmer min-w-0 flex-1 rounded px-1">Traduzindo…</span>
          {untranslatedButton}
        </div>
      )}

      {view.kind === "skipped" && view.reason === "same_language" && (
        <p className="flex items-center gap-1.5 py-0.5 text-text-secondary" aria-live="polite">
          {icon}
          Já está em {languageDisplayName(view.targetLang, { lower: true })}. Enviando sem traduzir.
        </p>
      )}

      {view.kind === "skipped" && view.reason === "long_text" && (
        <div className="flex items-center gap-1.5 text-text-secondary" aria-live="polite">
          {icon}
          <span className="min-w-0 flex-1">Será traduzido ao enviar.</span>
          {untranslatedButton}
        </div>
      )}

      {view.kind === "error" && (
        <div className="space-y-1">
          <p className="flex items-start gap-1.5 text-semantic-warning" aria-live="polite">
            <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              {strict
                ? `Prévia indisponível: ${view.message} Nada é enviado sem você ver a tradução.`
                : `Prévia indisponível: ${view.message} Ao enviar, tentamos traduzir de novo, e nada sai sem tradução sem você confirmar.`}
            </span>
          </p>
          <div className="flex flex-wrap items-center justify-end gap-1">
            {onRetry && (
              <StripButton onClick={onRetry}>
                <RotateCcw size={12} aria-hidden />
                Tentar de novo
              </StripButton>
            )}
            <StripButton onClick={onUntranslated}>Enviar sem traduzir</StripButton>
          </div>
        </div>
      )}

      {view.kind === "ready" && (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1.5">
            {icon}
            <span className="min-w-0 flex-1 truncate font-medium text-text-secondary">
              <span className="sr-only">Será enviado em </span>
              <span>{languageDisplayName(view.targetLang)}:</span>
            </span>
            {!editing && <StripButton onClick={onEdit}>Editar</StripButton>}
            {untranslatedButton}
          </div>
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
              className="mt-1 w-full resize-y rounded-field border border-border-strong bg-composer-field px-2.5 py-1.5 text-base text-text-primary focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 md:text-sm"
            />
          ) : (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="block w-full text-left"
            >
              <span
                lang={view.targetLang}
                dir="auto"
                className={cn(
                  "block whitespace-pre-wrap break-words text-sm text-text-primary",
                  !expanded && !armed && !strict && "line-clamp-2"
                )}
              >
                {editedText !== undefined && editedText.trim() ? editedText : view.text}
              </span>
            </button>
          )}
          {edited && (
            <div className="flex items-center gap-1">
              <span className="font-medium text-text-primary">Tradução editada por você</span>
              <StripButton onClick={onRestore}>
                <RotateCcw size={12} aria-hidden />
                Usar a tradução automática
              </StripButton>
            </div>
          )}
        </div>
      )}

      <p className="empty:hidden text-text-muted" aria-live="polite">
        {armed && view.kind === "loading" ? (
          <span className="font-medium text-brand-500">Aguarde a tradução para revisar e enviar.</span>
        ) : armed && view.kind === "skipped" && skipReason !== "same_language" && skipReason !== "long_text" ? (
          <span className="font-medium text-brand-500">
            <span className="coarse:inline hidden">Nada a traduzir. Toque em enviar de novo para enviar como está.</span>
            <span className="coarse:hidden">Nada a traduzir. Enter de novo envia como está.</span>
          </span>
        ) : armed && view.kind !== "error" ? (
          <span className="font-medium text-brand-500">
            <span className="coarse:inline hidden">Revise e confirme: toque em enviar de novo.</span>
            <span className="coarse:hidden">Revise e confirme: Enter de novo envia.</span>
          </span>
        ) : view.kind === "ready" ? (
          <span className="hidden md:inline coarse:hidden">Enter envia a versão traduzida · Shift+Enter nova linha</span>
        ) : null}
      </p>
    </div>
  );
}
