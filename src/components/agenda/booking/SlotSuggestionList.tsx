import { Clock, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { VOCAB } from "@/lib/vocab";
import { shortDateLabel, zonedTimeLabel } from "@/lib/agendaZone";
import { isAdjacentSlot, joinNames, reasonLine, type OfferedSlot } from "@/lib/bookingFlow";

interface SlotButtonProps {
  slot: OfferedSlot;
  tz: string;
  selected: boolean;
  /** Mostra o dia (lista que cobre mais de um dia). */
  showDay: boolean;
  onPick: (slot: OfferedSlot) => void;
}

/** Um horário de um toque: hora, dia, com quem/onde e o selo "Encostado" com o motivo. */
export function SlotButton({ slot, tz, selected, showDay, onPick }: SlotButtonProps) {
  const adjacent = isAdjacentSlot(slot);
  const where = joinNames(slot.resourceNames);
  const why = reasonLine(slot.reasons);
  const time = zonedTimeLabel(slot.startTime, tz);
  return (
    <li>
      <button
        type="button"
        onClick={() => onPick(slot)}
        aria-pressed={selected}
        data-adjacent={adjacent ? "true" : undefined}
        className={cn(
          "flex min-h-14 w-full items-center gap-3 rounded-card border px-3 py-2 text-left transition-colors",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
          selected ? "border-brand-500 bg-brand-500/10" : "border-border bg-surface-raised hover:bg-surface-overlay",
          adjacent && !selected && "border-brand-500/40"
        )}
      >
        <Clock size={16} aria-hidden="true" className="shrink-0 text-text-muted" />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-base font-semibold tabular-nums text-text-primary">{time}</span>
            {showDay && <span className="text-sm text-text-secondary">{shortDateLabel(slot.localDate)}</span>}
            {adjacent && (
              <Badge variant="brand" className="gap-1">
                <Link2 size={12} aria-hidden="true" />
                {VOCAB.scheduling.booking.slot.adjacent}
              </Badge>
            )}
          </span>
          {where && <span className="block truncate text-caption text-text-secondary">{where}</span>}
          {why && <span className="block text-caption text-text-muted">{why}</span>}
        </span>
      </button>
    </li>
  );
}

interface SlotSuggestionListProps {
  suggested: OfferedSlot[];
  others: OfferedSlot[];
  tz: string;
  selectedStart: number | null;
  onPick: (slot: OfferedSlot) => void;
  /** Há mais horários além dos mostrados e ainda não foram pedidos. */
  canExpand: boolean;
  onExpand: () => void;
}

/** Sugestões ranqueadas do servidor, depois "Outros horários" (por hora). */
export function SlotSuggestionList({ suggested, others, tz, selectedStart, onPick, canExpand, onExpand }: SlotSuggestionListProps) {
  const days = new Set([...suggested, ...others].map((s) => s.localDate));
  const showDay = days.size > 1;
  const t = VOCAB.scheduling.booking.slot;
  return (
    <div className="space-y-3">
      {suggested.length > 0 && (
        <section aria-label={t.suggested} className="space-y-2">
          <h3 className="text-caption font-semibold uppercase tracking-wide text-text-muted">{t.suggested}</h3>
          <ul className="space-y-2">
            {suggested.map((s) => (
              <SlotButton key={`${s.startTime}:${s.resourceIds.join(",")}`} slot={s} tz={tz} selected={selectedStart === s.startTime} showDay={showDay} onPick={onPick} />
            ))}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-label={t.others} className="space-y-2">
          <h3 className="text-caption font-semibold uppercase tracking-wide text-text-muted">{t.others}</h3>
          <ul className="space-y-2">
            {others.map((s) => (
              <SlotButton key={`${s.startTime}:${s.resourceIds.join(",")}`} slot={s} tz={tz} selected={selectedStart === s.startTime} showDay={showDay} onPick={onPick} />
            ))}
          </ul>
        </section>
      )}
      {canExpand && (
        <Button type="button" variant="secondary" className="w-full" onClick={onExpand}>
          {t.moreSlots}
        </Button>
      )}
    </div>
  );
}
