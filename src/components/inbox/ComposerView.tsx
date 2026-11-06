import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { Clock, Reply, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { isSendKey } from "@/lib/composerRules";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { MentionTextarea } from "@/components/ui/MentionTextarea";
import { Tooltip } from "@/components/ui/Tooltip";

export interface ComposerScheduleState {
  open: boolean;
  /** Valor de um `datetime-local`. */
  value: string;
  onToggle: () => void;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export interface ComposerViewProps {
  variant?: "page" | "embedded";
  text: string;
  onTextChange: (value: string) => void;
  isInternal: boolean;
  onInternalChange: (value: boolean) => void;
  /** Mostra o "Nota interna" (feature `internalNote`). */
  showInternalToggle?: boolean;
  placeholder: string;
  /** Janela fechada (Instagram/Messenger): campo, anexo e envio travados. */
  blocked?: boolean;
  /** Há texto ou anexo para enviar. */
  canSend: boolean;
  sending?: boolean;
  onSend: () => void;
  /** Dropdowns de "/" e "@" consomem as setas/Enter antes do envio; true = consumido. */
  onKeyDownBefore?: (e: KeyboardEvent) => boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  teamMembers: {
    _id: string;
    name: string;
    type: "human" | "ai";
    role: string;
    email?: string;
  }[];
  /** Banner de janela de serviço acima do campo (no Inbox ele fica no cabeçalho). */
  windowInfo?: { text: string; closed: boolean } | null;
  replyBar?: { author: string; preview: string; onCancel: () => void } | null;
  /** "WhatsApp: apenas o primeiro anexo será enviado". */
  attachmentNotice?: string | null;
  textCounter?: { label: string; parts: number; over: boolean } | null;
  /** Esconde campo, anexo e emoji enquanto a gravação de voz está ativa. */
  hideField?: boolean;
  // Slots: peças com Convex ficam no container; a view só as posiciona.
  pendingRows?: ReactNode;
  dropdowns?: ReactNode;
  attachButton?: ReactNode;
  emojiButton?: ReactNode;
  schedule?: ComposerScheduleState | null;
  /** Gravador de voz: quando presente, substitui o botão de enviar. */
  voice?: ReactNode;
  /** Chip de idioma da conversa (tradução automática), à direita de "Nota interna". */
  languageControl?: ReactNode;
  /** Prévia da tradução ("Será enviado em espanhol: …"), abaixo do campo. */
  translationPreview?: ReactNode;
  /** Rótulo do botão enquanto envia (ex.: "Traduzindo…" com a prévia em voo). */
  sendingLabel?: string | null;
  /**
   * Campo só leitura (ex.: Enter esperando a prévia da tradução): o que fosse
   * digitado nesse intervalo seria apagado quando o envio termina.
   */
  fieldReadOnly?: boolean;
}

/**
 * Composer de Conversas, apresentacional: texto, nota interna, citação,
 * contador do canal, janela de serviço, agendamento e envio. Não conhece Convex
 * nem URL (o container `Composer.tsx` liga os dados).
 */
export function ComposerView({
  variant = "page",
  text,
  onTextChange,
  isInternal,
  onInternalChange,
  showInternalToggle = true,
  placeholder,
  blocked = false,
  canSend,
  sending = false,
  onSend,
  onKeyDownBefore,
  inputRef,
  teamMembers,
  windowInfo,
  replyBar,
  attachmentNotice,
  textCounter,
  hideField = false,
  pendingRows,
  dropdowns,
  attachButton,
  emojiButton,
  schedule,
  voice,
  languageControl,
  translationPreview,
  sendingLabel,
  fieldReadOnly = false,
}: ComposerViewProps) {
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSend && !blocked && !sending) onSend();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (onKeyDownBefore?.(e)) return;
    // Ctrl/Cmd+Enter é um Enter comum (envia). "Sem traduzir" é só o botão da prévia.
    if (isSendKey(e)) {
      e.preventDefault();
      if (canSend && !blocked && !sending) onSend();
    }
  };

  const sendLabel = sending && sendingLabel ? sendingLabel : isInternal ? "Adicionar nota" : "Enviar";

  return (
    <form onSubmit={submit} className="shrink-0 border-t border-border bg-composer">
      <div className={cn("w-full p-4", variant === "page" && "max-w-4xl mx-auto")}>
        {windowInfo && (
          <p
            className={cn(
              "flex items-center gap-1 mb-2 text-xs",
              windowInfo.closed ? "text-semantic-warning" : "text-text-secondary"
            )}
          >
            <Clock className="h-3.5 w-3.5 shrink-0" />
            {windowInfo.text}
          </p>
        )}
        {(showInternalToggle || (languageControl && !isInternal)) && (
          <div className="flex flex-wrap items-center gap-2 mb-2">
            {showInternalToggle && (
              <Checkbox
                checked={isInternal}
                onChange={(e) => onInternalChange(e.target.checked)}
                label="Nota interna"
              />
            )}
            {isInternal && <Badge variant="warning">Visível apenas para membros da equipe</Badge>}
            {/* Nota interna nunca é traduzida: o chip some com ela. */}
            {!isInternal && languageControl}
          </div>
        )}

        {replyBar && !isInternal && (
          <div className="flex items-center gap-2 mb-2 pl-2 pr-1 py-1.5 border-l-2 border-brand-500 bg-surface-sunken rounded-r-lg">
            <Reply size={15} className="shrink-0 text-brand-400" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-brand-400">Respondendo {replyBar.author}</p>
              <p className="text-xs text-text-secondary truncate">{replyBar.preview}</p>
            </div>
            <button
              type="button"
              onClick={replyBar.onCancel}
              className="shrink-0 flex h-9 w-9 coarse:h-11 coarse:w-11 items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-surface-raised transition-colors"
              aria-label="Cancelar resposta"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {pendingRows}
        {attachmentNotice && <p className="text-xs text-text-muted mb-2">{attachmentNotice}</p>}

        <div className="relative flex gap-2 items-end">
          {dropdowns}
          {!hideField && (
            <>
              {attachButton}
              {emojiButton}
              <MentionTextarea
                inputRef={inputRef}
                value={text}
                onChange={onTextChange}
                onKeyDown={handleKeyDown}
                teamMembers={teamMembers}
                mentionEnabled={isInternal}
                disabled={blocked}
                readOnly={fieldReadOnly}
                placeholder={placeholder}
                rows={1}
                className={cn(
                  "bg-composer-field",
                  isInternal
                    ? "border-semantic-warning/30 focus:border-semantic-warning focus:ring-semantic-warning/20"
                    : "border-border-strong focus:border-brand-500 focus:ring-brand-500/20"
                )}
              />
            </>
          )}

          {schedule && (
            <div className="relative shrink-0">
              <Tooltip content="Agendar mensagem">
                <button
                  type="button"
                  onClick={schedule.onToggle}
                  className={cn(
                    "flex h-10 w-10 coarse:h-11 coarse:w-11 items-center justify-center rounded-full text-text-muted hover:text-brand-500 hover:bg-brand-500/10 transition-colors",
                    schedule.open && "text-brand-500 bg-brand-500/10"
                  )}
                  aria-label="Agendar mensagem"
                  aria-expanded={schedule.open}
                >
                  <Clock size={18} />
                </button>
              </Tooltip>
              {schedule.open && (
                <div className="absolute bottom-full right-0 mb-2 z-40 w-64 p-3 bg-surface-overlay border border-border rounded-xl shadow-elevated space-y-2.5">
                  <p className="text-xs font-medium text-text-primary">Enviar em</p>
                  <input
                    type="datetime-local"
                    value={schedule.value}
                    onChange={(e) => schedule.onChange(e.target.value)}
                    aria-label="Data e hora do envio"
                    className="w-full h-9 px-2.5 rounded-lg text-base md:text-sm bg-surface-sunken border border-border-strong text-text-primary focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500"
                  />
                  <div className="flex justify-end gap-2">
                    {/* type="button" obrigatório: dentro do form, o default
                        "submit" dispararia o envio imediato junto do agendamento */}
                    <Button type="button" variant="ghost" size="sm" onClick={schedule.onClose}>
                      Cancelar
                    </Button>
                    <Button type="button" size="sm" onClick={schedule.onSubmit}>
                      Agendar
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {voice ? (
            voice
          ) : (
            <Button
              type="submit"
              disabled={blocked || sending || !canSend}
              variant={isInternal ? "secondary" : "primary"}
              size="md"
              className={cn(
                "shrink-0",
                isInternal && "bg-semantic-warning hover:bg-semantic-warning/90 text-surface-base"
              )}
              aria-label={sendLabel}
            >
              <Send size={16} />
              <span className="hidden sm:inline">{sendLabel}</span>
            </Button>
          )}
        </div>

        {!hideField && !isInternal && translationPreview}

        {textCounter && (
          <p
            className={cn(
              "mt-1 text-right text-xs tabular-nums",
              textCounter.over ? "text-semantic-warning" : "text-text-muted"
            )}
            aria-live="polite"
          >
            {textCounter.label}
            {textCounter.over && ` — a mensagem será enviada em cerca de ${textCounter.parts} partes`}
          </p>
        )}
      </div>
    </form>
  );
}
