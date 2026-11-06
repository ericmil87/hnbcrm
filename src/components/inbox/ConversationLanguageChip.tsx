import { useRef, useState } from "react";
import { Check, ChevronDown, Languages } from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/Checkbox";
import { Modal } from "@/components/ui/Modal";
import { Popover } from "@/components/ui/Popover";
import { Tooltip } from "@/components/ui/Tooltip";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import {
  languageChipLabel,
  languageDisplayName,
  selectableLanguages,
  type ConversationLanguageState,
} from "@/lib/translationRules";

/** Escolha do seletor → `translation.setConversationLanguage`. */
export type LanguageChoice =
  | { mode: "auto"; applyToContact?: false }
  | { mode: "manual"; lang: string; applyToContact?: boolean }
  | { mode: "off"; applyToContact?: false };

export interface LanguageOptionsProps {
  state: ConversationLanguageState;
  teamLanguage: string;
  onSelect: (choice: LanguageChoice) => void;
  /** Preferência do visualizador "mostrar original junto". */
  showBoth: boolean;
  onShowBothChange: (value: boolean) => void;
  /** A conversa tem contato: habilita "Aplicar ao contato". */
  hasContact?: boolean;
}

/** Lista de idiomas da conversa (Popover do chip e diálogo do menu ⋮). */
export function LanguageOptions({
  state,
  teamLanguage,
  onSelect,
  showBoth,
  onShowBothChange,
  hasContact = false,
}: LanguageOptionsProps) {
  const [applyToContact, setApplyToContact] = useState(false);
  const selected = state.mode === "off" ? "off" : state.mode === "manual" ? state.lang ?? "auto" : "auto";
  const detected = state.lang && state.mode !== "manual" ? languageDisplayName(state.lang, { lower: true }) : null;

  const option = (key: string, label: string, hint: string | null, choice: LanguageChoice) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={selected === key}
      onClick={() => onSelect(choice)}
      className={cn(
        "flex w-full min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors md:min-h-9",
        selected === key ? "bg-brand-500/10 text-text-primary" : "text-text-secondary hover:bg-surface-raised"
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {selected === key && <Check size={14} className="text-brand-500" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {hint && <span className="block text-caption text-text-muted">{hint}</span>}
      </span>
    </button>
  );

  return (
    <div className="flex flex-col gap-2">
      <p className="px-3 pt-1 text-xs font-medium text-text-muted">Idioma da conversa</p>
      <div role="radiogroup" aria-label="Idioma da conversa" className="max-h-72 overflow-y-auto">
        {option(
          "auto",
          "Automático (idioma do lead)",
          detected ? `Detectado: ${detected}` : null,
          { mode: "auto" }
        )}
        {selectableLanguages(teamLanguage).map((l) =>
          option(l.code, l.name, null, { mode: "manual", lang: l.code, applyToContact: hasContact && applyToContact })
        )}
        {option("off", `${languageDisplayName(teamLanguage)} (não traduzir)`, null, { mode: "off" })}
      </div>
      <div className="flex flex-col gap-2 border-t border-border px-3 pt-2 pb-1">
        {hasContact && (
          <Checkbox
            id="translation-apply-contact"
            checked={applyToContact}
            onChange={(e) => setApplyToContact(e.target.checked)}
            label="Aplicar ao contato"
            description="Vale também para as próximas conversas dele."
          />
        )}
        <Checkbox
          id="translation-show-both"
          checked={showBoth}
          onChange={(e) => onShowBothChange(e.target.checked)}
          label="Mostrar original junto da tradução"
          description="Só neste aparelho."
        />
      </div>
    </div>
  );
}

export interface ConversationLanguageChipProps extends LanguageOptionsProps {
  /** `composer`: faixa de "Nota interna"; `header`: pílula do cabeçalho. */
  variant?: "composer" | "header";
  /** Sem `inbox:reply`: a pílula só informa. */
  readOnly?: boolean;
  /** Ao fechar (o composer devolve o foco ao campo de texto). */
  onClosed?: () => void;
}

/** Pílula "⟦Languages⟧ ES · auto ▾" com o seletor de idioma da conversa. */
export function ConversationLanguageChip({
  variant = "composer",
  readOnly = false,
  onClosed,
  ...options
}: ConversationLanguageChipProps) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const label = languageChipLabel(options.state, options.teamLanguage);
  if (!label) return null;

  const pill = cn(
    "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium tabular-nums coarse:min-h-11",
    label.tone === "active" ? "bg-brand-500/10 text-brand-400" : "bg-surface-sunken text-text-secondary"
  );

  if (readOnly) {
    return (
      <span className={pill} role="status" aria-label={label.full}>
        <Languages size={12} aria-hidden />
        {label.short}
      </span>
    );
  }

  const close = () => {
    setOpen(false);
    onClosed?.();
  };

  return (
    <>
      <Tooltip content={label.full}>
        <button
          ref={anchor}
          type="button"
          onClick={() => (open ? close() : setOpen(true))}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${label.full}. Trocar idioma`}
          className={cn(pill, "transition-colors hover:bg-brand-500/20", variant === "composer" && "ml-auto")}
        >
          <Languages size={12} aria-hidden />
          {label.short}
          <ChevronDown size={12} aria-hidden />
        </button>
      </Tooltip>
      <Popover
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : close())}
        anchor={anchor}
        side={variant === "composer" ? "top" : "bottom"}
        align="end"
        sheet={isMobile}
        role="dialog"
        aria-label="Idioma da conversa"
        className={cn("py-2", !isMobile && "w-72")}
      >
        <LanguageOptions
          {...options}
          onSelect={(choice) => {
            options.onSelect(choice);
            close();
          }}
        />
      </Popover>
    </>
  );
}

export interface ConversationLanguageDialogProps extends LanguageOptionsProps {
  open: boolean;
  onClose: () => void;
}

/** O mesmo seletor num diálogo (menu ⋮ "Idioma da conversa…" e aviso da conversa). */
export function ConversationLanguageDialog({ open, onClose, ...options }: ConversationLanguageDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title="Idioma da conversa">
      <LanguageOptions
        {...options}
        onSelect={(choice) => {
          options.onSelect(choice);
          onClose();
        }}
      />
    </Modal>
  );
}
