import type { ComponentType, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";
import { ModelText } from "../ModelText";

export interface BlockCardProps {
  /** Título curto do cartão (fixo ou do servidor). */
  title: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** "Para que serve": uma frase de apoio logo abaixo do título (texto fixo do servidor/app). */
  purpose?: string;
  /** Selo ao lado do título (ex.: "Aprovado", "Falta conferir"). */
  badge?: ReactNode;
  /** Nota curta escolhida pelo modelo (saneada no servidor; aqui de novo, como texto puro). */
  note?: string;
  children?: ReactNode;
  /** Ações padronizadas do cartão (botão principal + secundário), depois do conteúdo. */
  footer?: ReactNode;
  className?: string;
  /** Ref da moldura (rolagem até o cartão quando ele abre um editor). */
  cardRef?: Ref<HTMLElement>;
}

/** Moldura comum dos blocos ricos dentro da conversa (largura de bolha, tokens de superfície). */
export function BlockCard({ title, icon: Icon, purpose, badge, note, children, footer, className, cardRef }: BlockCardProps) {
  return (
    <section
      ref={cardRef}
      aria-label={title}
      className={cn(
        "w-full max-w-md rounded-card border border-border-subtle bg-surface-raised p-3 text-sm text-text-primary shadow-card",
        className
      )}
    >
      <div className="flex items-start gap-2">
        {Icon && <Icon className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden="true" />}
        <h3 className="min-w-0 flex-1 break-words text-sm font-semibold">{title}</h3>
        {badge && <div className="shrink-0">{badge}</div>}
      </div>
      {purpose && <p className="mt-0.5 text-caption text-text-secondary">{purpose}</p>}
      {note && <ModelText text={note} className="mt-1 text-caption text-text-secondary" />}
      {children && <div className="mt-2">{children}</div>}
      {footer && <div className="mt-3 flex flex-wrap items-center gap-2">{footer}</div>}
    </section>
  );
}
