import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ModelText } from "../ModelText";

export interface BlockCardProps {
  /** Título curto do cartão (fixo ou do servidor). */
  title: string;
  icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** Nota curta escolhida pelo modelo (saneada no servidor; aqui de novo, como texto puro). */
  note?: string;
  children?: ReactNode;
  className?: string;
}

/** Moldura comum dos blocos ricos dentro da conversa (largura de bolha, tokens de superfície). */
export function BlockCard({ title, icon: Icon, note, children, className }: BlockCardProps) {
  return (
    <section
      aria-label={title}
      className={cn(
        "w-full max-w-md rounded-card border border-border-subtle bg-surface-raised p-3 text-sm text-text-primary shadow-card",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {Icon && <Icon className="size-4 shrink-0 text-brand-600" aria-hidden="true" />}
        <h3 className="min-w-0 truncate text-sm font-semibold">{title}</h3>
      </div>
      {note && <ModelText text={note} className="mt-1 text-caption text-text-secondary" />}
      {children && <div className="mt-2">{children}</div>}
    </section>
  );
}
