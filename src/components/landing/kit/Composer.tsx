import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Mic, Pause, Paperclip, Play, SendHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { autoGrowHeight, isSendKeyFor } from "@/lib/composerRules";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useInView } from "@/hooks/useInView";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { RotatingPlaceholder } from "./RotatingPlaceholder";

export interface ComposerProps {
  /** Texto do campo (controlado). */
  value: string;
  onChange: (value: string) => void;
  /** Recebe o texto sem espaços nas pontas; só é chamado com texto. */
  onSubmit: (text: string) => void;
  /** Placeholder estático: vale no foco, com movimento reduzido e para leitor de tela. */
  placeholder: string;
  /** Frases do placeholder animado (escreve, apaga e troca). Vazio = só o estático. */
  placeholders?: readonly string[];
  /** Nome acessível do campo ("Mensagem para o Copiloto"). */
  label: string;
  /** Toque no clipe. Sem handler, o botão só leva o foco ao campo. */
  onAttach?: () => void;
  /** Toque no microfone. Sem handler, o botão só leva o foco ao campo. */
  onMic?: () => void;
  attachLabel?: string;
  micLabel?: string;
  /** Desliga só o clipe (slot pronto para quando anexos existirem, ex.: onboarding antes do P3.2). */
  attachDisabled?: boolean;
  /** Desliga só o microfone (o botão de enviar, com texto, continua valendo). */
  micDisabled?: boolean;
  sendLabel?: string;
  /** Pulso em sequência no clipe e no microfone enquanto o campo está parado e vazio. Padrão: `true`. */
  pulse?: boolean;
  /** Aviso curto que aparece com o campo em foco. */
  hint?: ReactNode;
  disabled?: boolean;
  maxLength?: number;
  autoFocus?: boolean;
  /** Avisa quando o campo ganha ou perde o foco (a cena pode pausar junto). */
  onFocusChange?: (focused: boolean) => void;
  /** Força o movimento reduzido. Padrão: a preferência do aparelho. */
  reducedMotion?: boolean;
  /**
   * Pausa vinda de fora (ex.: o `ScenePauseButton` do hero, que pausa a cena e
   * o composer juntos). Com a prop definida (`true` ou `false`) quem manda é o
   * chamador e o composer não desenha controle próprio. Sem ela, e havendo
   * movimento (placeholder animado ou pulso), o composer desenha o próprio
   * "Pausar animação / Retomar animação" (WCAG 2.2.2).
   */
  paused?: boolean;
  /** Rótulos do controle próprio de pausa. */
  pauseLabel?: string;
  resumeLabel?: string;
  className?: string;
}

const LINE_HEIGHT = 20;
const PADDING_Y = 24; // py-3

/**
 * Composer de verdade, no visual do WhatsApp: campo controlado que cresce com
 * o texto, clipe à esquerda, microfone (vira "Enviar" quando há texto) e
 * placeholder animado. A animação para no foco, com texto, fora da tela, com
 * movimento reduzido e pela pausa (externa via `paused`, ou o controle próprio
 * "Pausar animação" quando não há pausa externa). Enter envia no computador; no
 * toque Enter quebra linha.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  placeholders = [],
  label,
  onAttach,
  onMic,
  attachLabel = "Anexar arquivo",
  micLabel = "Gravar áudio",
  attachDisabled = false,
  micDisabled = false,
  sendLabel = "Enviar",
  pulse = true,
  hint,
  disabled = false,
  maxLength,
  autoFocus,
  onFocusChange,
  reducedMotion,
  paused,
  pauseLabel = "Pausar animação",
  resumeLabel = "Retomar animação",
  className,
}: ComposerProps) {
  const [focused, setFocused] = useState(false);
  const [ownPaused, setOwnPaused] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const coarse = useMediaQuery("(pointer: coarse)");
  const prefersReduced = usePrefersReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;
  const { ref: rootRef, isInView } = useInView<HTMLFormElement>({ once: false });
  const hasText = value.trim().length > 0;
  const idle = !focused && value === "" && !disabled;
  const externalPause = paused !== undefined;
  const stopped = externalPause ? paused : ownPaused;
  const hasMotion = !reduced && (placeholders.length > 0 || pulse);
  // Controle próprio só sem pausa externa e com algo que de fato se mexe.
  const showOwnControl = !externalPause && hasMotion;
  const animating = idle && isInView && !reduced && !stopped && placeholders.length > 0;
  const pulsing = pulse && idle && isInView && !reduced && !stopped;
  const showHint = Boolean(hint) && focused;

  useLayoutEffect(() => {
    const el = fieldRef.current;
    if (!el) return;
    el.style.height = "auto";
    const { height, scrollable } = autoGrowHeight({
      scrollHeight: el.scrollHeight,
      lineHeight: LINE_HEIGHT,
      paddingY: PADDING_Y,
      maxRows: 6,
    });
    el.style.height = `${height}px`;
    el.style.overflowY = scrollable ? "auto" : "hidden";
  }, [value]);

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    onSubmit(text);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (isSendKeyFor(e, coarse)) {
      e.preventDefault();
      submit();
    }
  }

  function setFocus(next: boolean) {
    setFocused(next);
    onFocusChange?.(next);
  }

  const focusField = () => fieldRef.current?.focus();

  return (
    <form ref={rootRef} onSubmit={handleSubmit} className={cn("px-2 py-2", className)}>
      <div className="flex items-end gap-2">
        <div className="relative flex min-h-11 min-w-0 flex-1 items-end rounded-3xl bg-composer-field">
          <button
            type="button"
            onClick={onAttach ?? focusField}
            disabled={disabled || attachDisabled}
            aria-label={attachLabel}
            className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:opacity-50"
          >
            {pulsing && (
              <span
                aria-hidden="true"
                className="absolute inset-1 rounded-full bg-brand-500/30 opacity-0 motion-safe:animate-ring-pulse"
              />
            )}
            <Paperclip className="relative size-5" aria-hidden="true" />
          </button>
          <div className="relative min-w-0 flex-1">
            {animating && (
              <RotatingPlaceholder
                phrases={placeholders}
                staticText={placeholder}
                className="absolute inset-x-0 top-3 truncate whitespace-nowrap pr-3 text-base leading-5 text-text-muted md:text-sm"
              />
            )}
            <textarea
              ref={fieldRef}
              rows={1}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setFocus(true)}
              onBlur={() => setFocus(false)}
              placeholder={placeholder}
              aria-label={label}
              aria-describedby={showHint ? hintId : undefined}
              disabled={disabled}
              maxLength={maxLength}
              autoFocus={autoFocus}
              enterKeyHint="send"
              className={cn(
                "block w-full resize-none bg-transparent py-3 pr-3 text-base leading-5 text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-50 md:text-sm",
                animating && "placeholder:text-transparent"
              )}
            />
          </div>
        </div>
        {hasText ? (
          <button
            type="submit"
            disabled={disabled}
            aria-label={sendLabel}
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-chat-send text-white transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base disabled:opacity-50"
          >
            <SendHorizontal className="size-5" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onMic ?? focusField}
            disabled={disabled || micDisabled}
            aria-label={micLabel}
            className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-chat-send text-white transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base disabled:opacity-50"
          >
            {pulsing && (
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-full bg-chat-send opacity-0 motion-safe:animate-ring-pulse [animation-delay:2s]"
              />
            )}
            <Mic className="relative size-5" aria-hidden="true" />
          </button>
        )}
      </div>
      {(showHint || showOwnControl) && (
        <div className="flex items-start justify-between gap-2 pt-1">
          {showHint ? (
            <p id={hintId} className="min-w-0 px-3 pt-1.5 text-caption text-text-muted">
              {hint}
            </p>
          ) : (
            <span />
          )}
          {showOwnControl && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOwnPaused((p) => !p)}
              className="shrink-0 text-caption"
            >
              {ownPaused ? <Play className="size-3.5" aria-hidden="true" /> : <Pause className="size-3.5" aria-hidden="true" />}
              {ownPaused ? resumeLabel : pauseLabel}
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
