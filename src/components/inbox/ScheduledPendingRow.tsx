import { useEffect, useState } from "react";
import { Clock, X } from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Mensagem agendada pendente — linha com contagem regressiva         */
/* ------------------------------------------------------------------ */

export function ScheduledPendingRow({
  item,
  onCancel,
}: {
  item: { _id: string; content: string; scheduledAt: number; createdAt: number };
  onCancel: () => void;
}) {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const total = Math.max(1, item.scheduledAt - item.createdAt);
  const elapsed = Math.min(total, Math.max(0, tick - item.createdAt));
  const progress = (elapsed / total) * 100;
  const remainingMs = Math.max(0, item.scheduledAt - tick);

  const remainingLabel = (() => {
    const s = Math.ceil(remainingMs / 1000);
    if (s <= 0) return "enviando…";
    if (s < 60) return `em ${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `em ${m}min ${String(s % 60).padStart(2, "0")}s`;
    const h = Math.floor(m / 60);
    return `em ${h}h${String(m % 60).padStart(2, "0")}`;
  })();

  return (
    <div className="rounded-lg bg-surface-sunken border border-border overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <Clock size={12} className="shrink-0 text-brand-500" />
        <span className="shrink-0 text-text-secondary tabular-nums">
          {new Date(item.scheduledAt).toLocaleString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        <span className="flex-1 min-w-0 truncate text-text-muted">{item.content}</span>
        <span className="shrink-0 text-brand-500 font-medium tabular-nums">{remainingLabel}</span>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 p-1 rounded-full text-text-muted hover:text-semantic-error hover:bg-surface-raised transition-colors"
          aria-label="Cancelar agendamento"
        >
          <X size={12} />
        </button>
      </div>
      <div className="h-0.5 bg-surface-raised">
        <div
          className="h-full bg-brand-500 transition-[width] duration-1000 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
