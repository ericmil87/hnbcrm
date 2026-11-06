import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import { Clock, Ellipsis, Loader2, MessageSquareText, Send, StickyNote, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { composerMaxRows, isSendKeyFor } from "@/lib/composerRules";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { Button } from "@/components/ui/Button";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { MentionTextarea } from "@/components/ui/MentionTextarea";

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
  /** Chip de idioma da conversa (tradução automática), dentro da pílula à direita do texto. */
  languageControl?: ReactNode;
  /** Prévia da tradução ("Espanhol: …"), faixa fina ACIMA do campo. */
  translationPreview?: ReactNode;
  /** Rótulo do botão enquanto envia (ex.: "Traduzindo…" com a prévia em voo). */
  sendingLabel?: string | null;
  /**
   * Campo só leitura (ex.: Enter esperando a prévia da tradução): o que fosse
   * digitado nesse intervalo seria apagado quando o envio termina.
   */
  fieldReadOnly?: boolean;
  /** Item "Respostas rápidas" do menu "Mais opções" (só quando o recurso está ligado). */
  onOpenQuickReplies?: () => void;
}

/**
 * Composer de Conversas, apresentacional, no formato do WhatsApp: [anexo] ·
 * pílula (emoji + campo que cresce + idioma + menu) · [enviar/microfone].
 * Nota interna, agendar e respostas rápidas moram no menu "Mais opções".
 * Não conhece Convex nem URL (o container `Composer.tsx` liga os dados).
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
  onOpenQuickReplies,
}: ComposerViewProps) {
  const coarse = useMediaQuery("(pointer: coarse)");
  const isDesktop = useMediaQuery("(min-width: 768px)");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (canSend && !blocked && !sending) onSend();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (onKeyDownBefore?.(e)) return;
    // Desktop: Enter envia (Ctrl/Cmd+Enter é um Enter comum). Toque: Enter quebra a linha.
    // "Sem traduzir" é só o botão da prévia.
    if (isSendKeyFor(e, coarse)) {
      e.preventDefault();
      if (canSend && !blocked && !sending) onSend();
    }
  };

  const sendLabel = sending && sendingLabel ? sendingLabel : isInternal ? "Adicionar nota" : "Enviar";

  const menuItems: MenuItem[] = [];
  if (showInternalToggle) {
    menuItems.push({
      id: "internal",
      label: isInternal ? "Voltar para mensagem ao cliente" : "Nota interna",
      icon: <StickyNote size={16} aria-hidden />,
      onSelect: () => onInternalChange(!isInternal),
    });
  }
  if (schedule) {
    menuItems.push({
      id: "schedule",
      label: "Agendar mensagem",
      icon: <Clock size={16} aria-hidden />,
      onSelect: schedule.onToggle,
    });
  }
  if (onOpenQuickReplies && !isInternal) {
    menuItems.push({
      id: "quick",
      label: "Respostas rápidas",
      icon: <MessageSquareText size={16} aria-hidden />,
      onSelect: onOpenQuickReplies,
    });
  }

  const showNoteBar = isInternal && showInternalToggle;

  return (
    <form onSubmit={submit} className="shrink-0 border-t border-border-subtle bg-composer pb-safe">
      <div className={cn("w-full px-2 py-1.5", variant === "page" && "mx-auto max-w-4xl")}>
        {windowInfo && (
          <p
            className={cn(
              "mb-1 flex items-center gap-1 px-1 text-caption",
              windowInfo.closed ? "text-semantic-warning" : "text-text-secondary"
            )}
          >
            <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {windowInfo.text}
          </p>
        )}

        {showNoteBar && (
          <div className="mb-1 flex items-center gap-1.5 pl-2 text-caption text-bubble-note-label">
            <StickyNote size={13} className="shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Nota interna · visível só para a equipe</span>
            <button
              type="button"
              onClick={() => onInternalChange(false)}
              className="-my-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-raised hover:text-text-primary coarse:h-11 coarse:w-11"
              aria-label="Desativar nota interna"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {replyBar && !isInternal && (
          <div className="mb-1.5 flex items-stretch overflow-hidden rounded-xl bg-surface-sunken">
            <span className="w-1 shrink-0 bg-brand-500" aria-hidden />
            <div className="min-w-0 flex-1 px-2.5 py-1.5">
              <p className="truncate text-caption font-semibold text-brand-400">Respondendo {replyBar.author}</p>
              <p className="truncate text-caption text-text-secondary">{replyBar.preview}</p>
            </div>
            <button
              type="button"
              onClick={replyBar.onCancel}
              className="flex h-11 w-11 shrink-0 items-center justify-center self-center text-text-muted transition-colors hover:text-text-primary"
              aria-label="Cancelar resposta"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {pendingRows}

        {!hideField && !isInternal && translationPreview}

        {attachmentNotice && <p className="mb-1 px-1 text-caption text-text-muted">{attachmentNotice}</p>}

        <div className="relative flex items-end gap-1.5">
          {dropdowns}
          {!hideField && (
            <>
              {attachButton}
              <div
                data-testid="composer-pill"
                className={cn(
                  "flex min-h-11 min-w-0 flex-1 items-end rounded-3xl border pl-1 pr-1 transition-colors",
                  isInternal
                    ? "border-bubble-note-border bg-bubble-note focus-within:border-semantic-warning"
                    : "border-border-strong bg-composer-field focus-within:border-brand-500"
                )}
              >
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
                  autoGrow
                  maxRows={composerMaxRows(isDesktop)}
                  className="rounded-none border-0 bg-transparent px-1.5 py-2.5 text-base leading-6 focus:border-0 focus:ring-0 md:text-sm"
                />
                {/* Nota interna nunca é traduzida: o chip some com ela. */}
                {!isInternal && languageControl && (
                  <div className="flex shrink-0 items-center self-end [&_.lucide-chevron-down]:hidden md:[&_.lucide-chevron-down]:block">
                    {languageControl}
                  </div>
                )}
                {menuItems.length > 0 && (
                  <Menu
                    ariaLabel="Mais opções"
                    items={menuItems}
                    trigger={(triggerProps, { open }) => (
                      <button
                        type="button"
                        {...triggerProps}
                        className={cn(
                          "flex h-11 w-9 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors hover:text-brand-500",
                          open && "text-brand-500"
                        )}
                        aria-label="Mais opções"
                      >
                        <Ellipsis size={20} />
                      </button>
                    )}
                  />
                )}
              </div>
            </>
          )}

          {schedule?.open && (
            <div className="absolute bottom-full right-0 z-40 mb-2 w-64 space-y-2.5 rounded-xl border border-border bg-surface-overlay p-3 shadow-elevated">
              <p className="text-xs font-medium text-text-primary">Enviar em</p>
              <input
                type="datetime-local"
                value={schedule.value}
                onChange={(e) => schedule.onChange(e.target.value)}
                aria-label="Data e hora do envio"
                className="h-11 w-full rounded-lg border border-border-strong bg-surface-sunken px-2.5 text-base text-text-primary focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 md:h-9 md:text-sm"
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

          {voice ? (
            voice
          ) : (
            <button
              type="submit"
              disabled={blocked || sending || !canSend}
              aria-busy={sending || undefined}
              className={cn(
                "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40",
                isInternal
                  ? "bg-semantic-warning text-surface-base hover:bg-semantic-warning/90"
                  : "bg-brand-600 text-white hover:bg-brand-700"
              )}
              aria-label={sendLabel}
            >
              {sending ? <Loader2 size={18} className="animate-spin" aria-hidden /> : <Send size={18} aria-hidden />}
            </button>
          )}
        </div>

        {textCounter && (
          <p
            className={cn(
              "mt-1 px-1 text-right text-caption tabular-nums",
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
