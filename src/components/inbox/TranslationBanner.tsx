import { useEffect } from "react";
import { Link } from "react-router";
import { Languages, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { TranslationBannerKind } from "@/lib/translationRules";

/** Tempo até o aviso automático sumir (o idioma segue no cabeçalho e no chip). */
export const AUTO_BANNER_HIDE_MS = 8_000;

export interface TranslationBannerProps {
  kind: TranslationBannerKind;
  /** Nome do idioma no meio da frase ("espanhol"). */
  languageName: string;
  /** Idioma da equipe como rótulo ("pt-BR"). */
  teamLabel: string;
  /** Sem `inbox:reply` não há botões de escolha. */
  canChoose: boolean;
  /** Link de Configurações → Tradução automática (aviso de descoberta). */
  settingsHref?: string;
  onUndo?: () => void;
  onAccept?: () => void;
  onDecline?: () => void;
  onPickLanguage?: () => void;
  onNeverForContact?: () => void;
  onDismiss: () => void;
}

/**
 * Aviso no topo da conversa (v0.80): idioma detectado e traduzindo (some em
 * 8 s), pergunta do modo "perguntar" e o convite para ligar o módulo.
 */
export function TranslationBanner({
  kind,
  languageName,
  teamLabel,
  canChoose,
  settingsHref,
  onUndo,
  onAccept,
  onDecline,
  onPickLanguage,
  onNeverForContact,
  onDismiss,
}: TranslationBannerProps) {
  useEffect(() => {
    if (kind !== "auto") return;
    const timer = setTimeout(onDismiss, AUTO_BANNER_HIDE_MS);
    return () => clearTimeout(timer);
  }, [kind, onDismiss]);

  const text =
    kind === "auto"
      ? `Conversa em ${languageName}: traduzindo para ${teamLabel}.`
      : kind === "ask"
        ? `Este lead parece falar ${languageName}. Traduzir esta conversa?`
        : "Este contato pode falar outro idioma. Ativar tradução automática?";

  return (
    <div
      role="status"
      aria-live="polite"
      className="shrink-0 border-b border-border bg-surface-raised px-4 py-2 motion-safe:animate-fade-in"
    >
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-2 sm:flex-row sm:items-center">
        <p className="flex min-w-0 flex-1 items-start gap-2 text-sm text-text-secondary">
          <Languages size={16} className="mt-0.5 shrink-0 text-brand-500" aria-hidden />
          <span>{text}</span>
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {kind === "auto" && canChoose && (
            <>
              <Button size="sm" variant="secondary" onClick={onUndo}>
                Desfazer
              </Button>
              <Button size="sm" variant="ghost" onClick={onPickLanguage}>
                Idioma
              </Button>
              <Button size="sm" variant="ghost" onClick={onNeverForContact}>
                Não traduzir este contato
              </Button>
            </>
          )}
          {kind === "ask" && canChoose && (
            <>
              <Button size="sm" onClick={onAccept}>
                Sim, traduzir
              </Button>
              <Button size="sm" variant="secondary" onClick={onDecline}>
                Não
              </Button>
              <Button size="sm" variant="ghost" onClick={onPickLanguage}>
                Outro idioma
              </Button>
            </>
          )}
          {kind === "discover" && settingsHref && (
            <Link
              to={settingsHref}
              className="inline-flex min-h-11 items-center rounded-full bg-brand-600 px-3 text-sm font-medium text-white transition-colors hover:bg-brand-700 md:min-h-8"
            >
              Ver tradução automática
            </Link>
          )}
          {kind !== "ask" && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Fechar aviso"
              className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted transition-colors hover:bg-surface-overlay hover:text-text-primary coarse:h-11 coarse:w-11"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
