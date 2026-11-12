import { Check } from "lucide-react";
import type { ProgressView } from "@/lib/onboardingChat";
import { cn } from "@/lib/utils";

export interface StageProgressProps {
  progress: ProgressView;
}

/**
 * Progresso em 6 etapas, em português e que nunca regride (quem calcula é
 * `chatProgress`): um segmento por etapa, a etapa atual por extenso ("Etapa 2 de
 * 6: Funil") e, de `sm` para cima, o nome de cada etapa sob o segmento. Antes da
 * conta ou da organização mostra "Crie a sua conta".
 */
export function StageProgress({ progress: p }: StageProgressProps) {
  const heading = p.index === 0 ? p.label : p.complete ? "Configuração concluída" : `Etapa ${p.index} de ${p.total}: ${p.label}`;
  return (
    <div className="shrink-0 bg-chat-header px-3 pb-2">
      <p className="pb-1 text-caption font-medium text-text-secondary">{heading}</p>
      <div
        role="progressbar"
        aria-label="Progresso da configuração"
        aria-valuemin={0}
        aria-valuemax={p.total}
        aria-valuenow={p.complete ? p.total : p.index}
        aria-valuetext={p.valueText}
      >
        <ol className="grid grid-cols-6 gap-1">
          {p.steps.map((s) => (
            <li key={s.id} className="min-w-0" aria-current={s.state === "current" ? "step" : undefined}>
              <div
                className={cn(
                  "h-1.5 rounded-full motion-safe:transition-colors motion-safe:duration-500",
                  s.state === "todo" ? "bg-surface-sunken" : "bg-brand-600",
                  s.state === "current" && "bg-brand-600/60"
                )}
              />
              <span
                className={cn(
                  "mt-1 hidden items-center gap-0.5 truncate text-micro sm:flex",
                  s.state === "current" ? "font-semibold text-text-primary" : "text-text-muted"
                )}
              >
                {s.state === "done" && <Check className="size-3 shrink-0" aria-hidden="true" />}
                <span className="truncate">{s.label}</span>
              </span>
              <span className="sr-only">
                {s.label}: {s.state === "done" ? "feito" : s.state === "current" ? "etapa atual" : "a fazer"}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
