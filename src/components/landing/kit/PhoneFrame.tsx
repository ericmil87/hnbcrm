import type { ReactNode } from "react";
import { BatteryMedium, Signal, Wifi } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PhoneFrameProps {
  /** Relógio da barra de status ("23:14"). */
  time?: string;
  /** Conteúdo da tela. A tela é `relative` e corta o que passa: camadas absolutas entram e saem sem mudar a altura. */
  children: ReactNode;
  /** Nome acessível. Padrão: "Celular". */
  label?: string;
  className?: string;
  /** Classes da área da tela. */
  screenClassName?: string;
}

/**
 * Moldura de celular para cenas: borda, barra de status com relógio e uma tela
 * de altura fixa (a do pai). Só desenho, sem interação.
 */
export function PhoneFrame({ time, children, label = "Celular", className, screenClassName }: PhoneFrameProps) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-[1.75rem] border-4 border-border-strong bg-surface-base shadow-elevated",
        className
      )}
    >
      <div className="flex h-7 shrink-0 items-center justify-between px-4 text-micro font-semibold tabular-nums text-text-secondary">
        <span>{time}</span>
        <span aria-hidden="true" className="flex items-center gap-1">
          <Signal className="size-3.5" />
          <Wifi className="size-3.5" />
          <BatteryMedium className="size-4" />
        </span>
      </div>
      <div className={cn("relative min-h-0 flex-1 overflow-hidden", screenClassName)}>{children}</div>
    </div>
  );
}
