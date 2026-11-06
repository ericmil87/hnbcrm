import { useEffect, useState } from "react";
import { Clock, Languages, X } from "lucide-react";
import { formatDateTimeShort } from "@/lib/format";

/* ------------------------------------------------------------------ */
/*  Mensagem agendada pendente — linha com contagem regressiva         */
/* ------------------------------------------------------------------ */

export function ScheduledPendingRow({
  item,
  onCancel,
  languageNote,
}: {
  item: {
    _id: string;
    content: string;
    scheduledAt: number;
    createdAt: number;
    /** F3: agendada já traduzida — `content` é o que sai, isto é o que a equipe escreveu. */
    authoredText?: string;
    targetLang?: string;
  };
  onCancel: () => void;
  /** Tradução automática: "será enviada em espanhol". */
  languageNote?: string | null;
}) {
  const [tick, setTick] = useState(() => Date.now());
  const [showAuthored, setShowAuthored] = useState(false);
  const hasBoth = !!item.authoredText && item.authoredText !== item.content;
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
          {formatDateTimeShort(item.scheduledAt, tick)}
        </span>
        <span
          className="flex-1 min-w-0 truncate text-text-muted"
          lang={hasBoth && !showAuthored ? item.targetLang : undefined}
          dir="auto"
        >
          {hasBoth && showAuthored ? item.authoredText : item.content}
        </span>
        {hasBoth && (
          <button
            type="button"
            onClick={() => setShowAuthored((v) => !v)}
            aria-pressed={showAuthored}
            className="shrink-0 rounded-full px-1.5 py-0.5 coarse:min-h-11 text-brand-500 hover:underline"
          >
            {showAuthored ? "Ver o que será enviado" : "Você escreveu"}
          </button>
        )}
        {languageNote && (
          <span className="inline-flex shrink-0 items-center gap-1 text-text-secondary">
            <Languages size={12} aria-hidden />
            <span className="sr-only sm:not-sr-only">{languageNote}</span>
          </span>
        )}
        <span className="shrink-0 text-brand-500 font-medium tabular-nums">{remainingLabel}</span>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 flex items-center justify-center p-1 coarse:min-h-11 coarse:min-w-11 rounded-full text-text-muted hover:text-semantic-error hover:bg-surface-raised transition-colors"
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
