import { useState } from "react";
import { AlertCircle, Languages, Loader2, RefreshCw, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormattedMessageText } from "./FormattedMessageText";
import { uncertainLanguageLabel, type TranslationView } from "@/lib/translationRules";

type ShownView = Exclude<TranslationView, { kind: "none" }>;

export interface MessageTranslationProps {
  view: ShownView;
  /** Texto que trafegou no canal (`message.content`), já filtrado pela bolha. */
  text: string;
  variant: "inbound" | "outbound";
  /** "Mostrar original junto da tradução" (preferência do visualizador). */
  showBoth?: boolean;
  /** Pedido manual de tradução em voo (estado local do thread). */
  busy?: boolean;
  /** Recebida/resposta da IA com falha: `translation.translateMessage`. */
  onRetry?: () => void;
  /** Enviada com falha: `translation.retryOutbound`. */
  onRetryOutbound?: () => void;
  /** Enviada com falha: `translation.sendUntranslated` (pede confirmação). */
  onSendUntranslated?: () => void;
  /** F3, idioma incerto: fixa o idioma da conversa e traduz esta mensagem. */
  onTranslateAs?: (lang: string) => void;
}

/**
 * Texto da bolha com tradução (v0.80): o principal, o rótulo de idioma
 * alternável e os estados (traduzindo, falha, enviada sem tradução). Substitui
 * o `FormattedMessageText` quando a mensagem tem algo de tradução a mostrar.
 */
export function MessageTranslation({
  view,
  text,
  variant,
  showBoth = false,
  busy = false,
  onRetry,
  onRetryOutbound,
  onSendUntranslated,
  onTranslateAs,
}: MessageTranslationProps) {
  const outbound = variant === "outbound";
  const muted = outbound ? "text-bubble-out-fg/85" : "text-text-muted";
  const link = outbound ? "text-bubble-out-fg hover:opacity-90" : "text-bubble-in-link hover:opacity-80";
  const [toggled, setToggled] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const body = (value: string, lang?: string, className?: string) => (
    <div lang={lang} dir="auto">
      <FormattedMessageText text={value} variant={variant} className={cn("text-sm", className)} />
    </div>
  );

  if (view.kind === "translated") {
    const secondaryFirst = !showBoth && toggled;
    const primaryText = secondaryFirst ? view.secondary : view.primary;
    const primaryLang = secondaryFirst ? view.secondaryLang : view.primaryLang;
    const label = secondaryFirst ? view.secondaryLabel : view.label;
    const action = showBoth ? null : secondaryFirst ? view.showPrimaryLabel : view.showSecondaryLabel;
    return (
      <div className="flex flex-col gap-1" aria-live="polite">
        {body(primaryText, primaryLang)}
        {showBoth && (
          <div className={cn("border-l-2 pl-2", outbound ? "border-bubble-out-fg/30" : "border-border")}>
            {body(view.secondary, view.secondaryLang, muted)}
          </div>
        )}
        {action ? (
          <button
            type="button"
            onClick={() => setToggled((v) => !v)}
            aria-pressed={toggled}
            className={cn(
              "-mx-1 flex min-h-11 items-center gap-1.5 rounded-md px-1 text-left text-caption md:min-h-6",
              muted
            )}
          >
            <Languages size={12} className="shrink-0" aria-hidden />
            <span>{label}</span>
            <span aria-hidden>·</span>
            <span className={cn("font-medium", link)}>{action}</span>
          </button>
        ) : (
          <p className={cn("flex items-center gap-1.5 text-caption", muted)}>
            <Languages size={12} className="shrink-0" aria-hidden />
            {view.label}
          </p>
        )}
      </div>
    );
  }

  if (view.kind === "translating") {
    return (
      <div className="flex flex-col gap-1" aria-live="polite">
        {body(text, undefined, outbound ? undefined : "text-text-secondary")}
        <p className={cn("flex items-center gap-1.5 text-xs italic", muted)}>
          <Languages size={12} className="shrink-0" aria-hidden />
          <span className="skeleton-shimmer rounded px-1">Traduzindo…</span>
        </p>
      </div>
    );
  }

  if (view.kind === "failed") {
    return (
      <div className="flex flex-col gap-1" aria-live="polite">
        {body(text)}
        <p className={cn("flex flex-wrap items-center gap-x-2 text-xs", outbound ? "text-bubble-out-fg/85" : "text-semantic-error")}>
          <span>Não foi possível traduzir.</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={busy}
              className={cn("inline-flex min-h-11 items-center gap-1 text-caption font-medium md:min-h-6", link)}
            >
              {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />}
              Tentar de novo
            </button>
          )}
        </p>
      </div>
    );
  }

  if (view.kind === "uncertain") {
    return (
      <div className="flex flex-col gap-1">
        {body(text)}
        {onTranslateAs ? (
          <button
            type="button"
            onClick={() => onTranslateAs(view.lang)}
            disabled={busy}
            className={cn(
              "-mx-1 flex min-h-11 items-center gap-1.5 rounded-md px-1 text-left text-caption md:min-h-6",
              muted
            )}
          >
            {busy ? (
              <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden />
            ) : (
              <Languages size={12} className="shrink-0" aria-hidden />
            )}
            <span className={cn("font-medium", link)}>{uncertainLanguageLabel(view.lang)}</span>
          </button>
        ) : (
          <p className={cn("flex items-center gap-1.5 text-caption", muted)}>
            <Languages size={12} className="shrink-0" aria-hidden />
            Idioma incerto
          </p>
        )}
      </div>
    );
  }

  if (view.kind === "outbound_pending") {
    return (
      <div className="flex flex-col gap-1" aria-live="polite">
        {body(text)}
        <p className={cn("flex items-center gap-1.5 text-xs italic", muted)}>
          <Loader2 size={12} className="shrink-0 animate-spin" aria-hidden />
          Traduzindo e enviando…
        </p>
      </div>
    );
  }

  if (view.kind === "outbound_failed") {
    return (
      <div className="flex flex-col gap-1.5" aria-live="polite">
        {body(text)}
        <div className="flex flex-col gap-1.5 rounded-md bg-bubble-out-fg/10 px-2 py-1.5">
          <p className="flex items-start gap-1.5 text-xs text-bubble-out-fg">
            <AlertCircle size={13} className="mt-0.5 shrink-0" aria-hidden />
            <span>
              {view.tooLong
                ? "Mensagem longa demais para traduzir. A mensagem não foi enviada."
                : "Não consegui traduzir agora. A mensagem não foi enviada."}
            </span>
          </p>
          <div className="flex flex-wrap gap-1.5">
            {/* Longa demais: tentar de novo falharia igual; só "Enviar sem traduzir". */}
            {onRetryOutbound && !view.tooLong && (
              <Button type="button" size="sm" variant="secondary" onClick={onRetryOutbound} loading={busy}>
                <RefreshCw size={14} aria-hidden />
                Tentar de novo
              </Button>
            )}
            {onSendUntranslated && (
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmOpen(true)} disabled={busy}
                className="text-bubble-out-fg hover:bg-bubble-out-fg/10">
                <Send size={14} aria-hidden />
                Enviar sem traduzir
              </Button>
            )}
          </div>
        </div>
        <ConfirmDialog
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            onSendUntranslated?.();
          }}
          title="Enviar sem traduzir?"
          description="O lead vai receber o texto exatamente como você escreveu, sem tradução."
          confirmLabel="Enviar sem traduzir"
          cancelLabel="Cancelar"
        />
      </div>
    );
  }

  // outbound_skipped
  return (
    <div className="flex flex-col gap-1">
      {body(text)}
      <p className={cn("flex items-center gap-1.5 text-caption", muted)}>
        <Languages size={12} className="shrink-0" aria-hidden />
        Enviado sem tradução
      </p>
    </div>
  );
}
