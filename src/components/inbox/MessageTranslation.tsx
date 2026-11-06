import { useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, Languages, Loader2, RefreshCw, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { FormattedMessageText } from "./FormattedMessageText";
import { uncertainLanguageLabel, type TranslationView } from "@/lib/translationRules";
import { translationCaption } from "@/lib/translationCaption";

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
  /** Classe do texto da mensagem (a bolha define o tamanho). */
  textClassName?: string;
  /**
   * Vai no fim da última linha (a bolha põe ali o espaçador da hora, para a
   * hora e os tiques ficarem na mesma linha do rodapé, como no WhatsApp).
   */
  trailing?: ReactNode;
}

/** Alvo de toque de 44px no celular sem aumentar a linha de 16px. */
const HIT = "relative after:absolute after:-inset-x-1 after:-inset-y-3.5 after:content-[''] md:after:-inset-y-1";

/**
 * Texto da bolha com tradução (v0.80): o principal, um rodapé de uma linha
 * (`Languages` + "Traduzido do inglês · Ver original") e os estados
 * (traduzindo, falha, enviada sem tradução). Substitui o `FormattedMessageText`
 * quando a mensagem tem algo de tradução a mostrar.
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
  textClassName = "text-sm",
  trailing,
}: MessageTranslationProps) {
  const outbound = variant === "outbound";
  const muted = outbound ? "text-bubble-out-fg/85" : "text-text-muted";
  const link = outbound ? "text-bubble-out-fg underline-offset-2 hover:underline" : "text-bubble-in-link hover:opacity-80";
  const [toggled, setToggled] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const body = (value: string, lang?: string, className?: string) => (
    <div lang={lang} dir="auto">
      <FormattedMessageText text={value} variant={variant} className={cn(textClassName, className)} />
    </div>
  );

  /** Rodapé de uma linha: ícone + conteúdo inline + espaçador da hora. */
  const caption = (content: ReactNode, className?: string) => (
    <div className={cn("mt-0.5 text-caption", muted, className)}>
      {content}
      {trailing}
    </div>
  );
  const icon = <Languages size={12} className="mr-1 inline-block shrink-0 align-[-2px]" aria-hidden />;

  if (view.kind === "translated") {
    const secondaryFirst = !showBoth && toggled;
    const primaryText = secondaryFirst ? view.secondary : view.primary;
    const primaryLang = secondaryFirst ? view.secondaryLang : view.primaryLang;
    const { label, action } = translationCaption(view, { showingSecondary: toggled, showBoth });
    return (
      <div className="flex flex-col" aria-live="polite">
        {body(primaryText, primaryLang)}
        {showBoth && (
          <div className={cn("mt-1 border-l-2 pl-2", outbound ? "border-bubble-out-fg/30" : "border-border")}>
            {body(view.secondary, view.secondaryLang, muted)}
          </div>
        )}
        {caption(
          action ? (
            <button
              type="button"
              onClick={() => setToggled((v) => !v)}
              aria-pressed={toggled}
              className={cn("rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500", HIT)}
            >
              {icon}
              <span>{label}</span>
              <span aria-hidden> · </span>
              <span className={cn("font-medium", link)}>{action}</span>
            </button>
          ) : (
            <span>
              {icon}
              {label}
            </span>
          )
        )}
      </div>
    );
  }

  if (view.kind === "translating") {
    return (
      <div className="flex flex-col" aria-live="polite">
        {body(text, undefined, outbound ? undefined : "text-text-secondary")}
        {caption(
          <span className="italic">
            {icon}
            <span className="skeleton-shimmer rounded px-1">Traduzindo…</span>
          </span>
        )}
      </div>
    );
  }

  if (view.kind === "failed") {
    return (
      <div className="flex flex-col" aria-live="polite">
        {body(text)}
        {caption(
          <>
            <span>Não foi possível traduzir.</span>
            {onRetry && (
              <>
                {" "}
                <button
                  type="button"
                  onClick={onRetry}
                  disabled={busy}
                  className={cn("inline-flex items-center gap-1 font-medium align-bottom", HIT, link)}
                >
                  {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <RefreshCw size={12} aria-hidden />}
                  Tentar de novo
                </button>
              </>
            )}
          </>,
          outbound ? "text-bubble-out-fg/85" : "text-semantic-error"
        )}
      </div>
    );
  }

  if (view.kind === "uncertain") {
    return (
      <div className="flex flex-col">
        {body(text)}
        {caption(
          onTranslateAs ? (
            <button
              type="button"
              onClick={() => onTranslateAs(view.lang)}
              disabled={busy}
              className={cn("rounded-sm text-left", HIT)}
            >
              {busy ? <Loader2 size={12} className="mr-1 inline-block animate-spin align-[-2px]" aria-hidden /> : icon}
              <span className={cn("font-medium", link)}>{uncertainLanguageLabel(view.lang)}</span>
            </button>
          ) : (
            <span>
              {icon}
              Idioma incerto
            </span>
          )
        )}
      </div>
    );
  }

  if (view.kind === "outbound_pending") {
    return (
      <div className="flex flex-col" aria-live="polite">
        {body(text)}
        {caption(
          <span className="italic">
            <Loader2 size={12} className="mr-1 inline-block animate-spin align-[-2px]" aria-hidden />
            Traduzindo e enviando…
          </span>
        )}
      </div>
    );
  }

  if (view.kind === "outbound_failed") {
    return (
      <div className="flex flex-col gap-1.5" aria-live="polite">
        {body(text)}
        <div className="flex flex-col gap-1.5 rounded-md bg-bubble-out-fg/10 px-2 py-1.5">
          <p className="flex items-start gap-1.5 text-caption text-bubble-out-fg">
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
        {trailing && <div className="text-right text-caption">{trailing}</div>}
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
    <div className="flex flex-col">
      {body(text)}
      {caption(
        <span>
          {icon}
          Enviado sem tradução
        </span>
      )}
    </div>
  );
}
