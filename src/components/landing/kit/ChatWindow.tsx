import type { ReactNode } from "react";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ChatWindowProps {
  /** Nome no cabeçalho ("Copiloto HNBCRM", "Marina"). */
  title: string;
  /** Linha de status ("online agora"). Some enquanto `typing`. */
  subtitle?: string;
  /** Mostra "digitando…" no lugar do status. */
  typing?: boolean;
  /** Texto do estado digitando. Padrão: "digitando…". */
  typingLabel?: string;
  /** Avatar à esquerda do nome. Padrão: círculo da IA com faísca. */
  avatar?: ReactNode;
  /** Selo à direita do nome (ex.: `<Badge>`). */
  badge?: ReactNode;
  /** Ação no canto direito do cabeçalho (ex.: botão de pausa da cena). */
  headerAction?: ReactNode;
  /** Mensagens (bolhas). */
  children: ReactNode;
  /** Composer, chips ou qualquer rodapé da janela. */
  composer?: ReactNode;
  /** Nome acessível da janela. Padrão: `Conversa com {title}`. */
  label?: string;
  /**
   * Conversa de verdade (chat do onboarding): a área de mensagens vira
   * `role="log"` com `aria-live="polite"`. Cenas ilustrativas deixam `false`.
   */
  live?: boolean;
  className?: string;
  /** Classes da área de mensagens (altura, rolagem, espaçamento). */
  bodyClassName?: string;
}

/** Avatar padrão da IA (Copiloto/Atendente). */
export function AiAvatar({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-ai-600 text-white", className)}
    >
      <Sparkles className="size-5" />
    </span>
  );
}

/**
 * Moldura de conversa estilo WhatsApp: cabeçalho com avatar, nome e status
 * ("digitando…"), papel de parede do tema (`.chat-wallpaper`) e um slot para o
 * composer. Só apresentação, sem Convex: serve às cenas da landing e ao chat
 * do onboarding.
 */
export function ChatWindow({
  title,
  subtitle,
  typing = false,
  typingLabel = "digitando…",
  avatar,
  badge,
  headerAction,
  children,
  composer,
  label,
  live = false,
  className,
  bodyClassName,
}: ChatWindowProps) {
  const status = typing ? typingLabel : subtitle;
  return (
    <div
      role="group"
      aria-label={label ?? `Conversa com ${title}`}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-card border border-border bg-chat-bg shadow-elevated",
        className
      )}
    >
      <div className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border-subtle bg-chat-header px-3 py-2">
        {avatar ?? <AiAvatar />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-text-primary">{title}</p>
          {status && (
            <p className={cn("truncate text-caption", typing ? "font-medium text-brand-600" : "text-text-muted")}>
              {status}
            </p>
          )}
        </div>
        {badge}
        {headerAction}
      </div>
      <div
        className={cn("chat-wallpaper flex flex-1 flex-col gap-1.5 overflow-y-auto px-3 py-3", bodyClassName)}
        {...(live ? { role: "log", "aria-live": "polite" as const, "aria-relevant": "additions" as const } : {})}
      >
        {children}
      </div>
      {composer && <div className="shrink-0 border-t border-border-subtle bg-composer">{composer}</div>}
    </div>
  );
}
