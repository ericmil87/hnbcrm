import { stageProgress } from "@/lib/onboardingChat";

export interface StageProgressProps {
  /** Etapa do servidor (`interview`, `materials`…) ou `account` antes da conta/org. */
  stage: string | null | undefined;
}

/** Barra fina de progresso por etapa, logo abaixo do cabeçalho da conversa. */
export function StageProgress({ stage }: StageProgressProps) {
  const p = stageProgress(stage);
  return (
    <div className="shrink-0 bg-chat-header px-3 pb-2">
      <div className="flex items-center justify-between gap-2 pb-1 text-caption text-text-muted">
        <span className="truncate">{p.label}</span>
        <span className="tabular-nums">
          {p.index}/{p.total}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Progresso da configuração"
        aria-valuemin={1}
        aria-valuemax={p.total}
        aria-valuenow={p.index}
        aria-valuetext={p.valueText}
        className="h-1 w-full overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className="h-full rounded-full bg-brand-600 motion-safe:transition-[width] motion-safe:duration-500"
          style={{ width: `${Math.round(p.ratio * 100)}%` }}
        />
      </div>
    </div>
  );
}
