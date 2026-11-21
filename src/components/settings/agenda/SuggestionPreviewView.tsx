import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { slotTouchesAnother } from "@/lib/agendaSlots";
import { zonedTimeLabel } from "@/lib/agendaZone";

export interface PreviewSlot {
  startTime: number;
  endTime: number;
  label: string;
  resourceNames: string[];
  reasons: string[];
  /** Formato futuro do servidor (`ADJACENT`). */
  reasonCodes?: string[];
}

interface SuggestionPreviewViewProps {
  loading: boolean;
  suggestions: PreviewSlot[];
  chronological: PreviewSlot[];
  timezone: string;
  /** "Desligado": só a ordem do relógio. */
  off: boolean;
}

function Slots({ title, slots, timezone }: { title: string; slots: PreviewSlot[]; timezone: string }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-text-primary">{title}</p>
      {slots.length === 0 ? (
        <p className="text-sm text-text-muted">Nenhum horário livre neste dia.</p>
      ) : (
        <ul className="space-y-2">
          {slots.map((s) => (
            <li key={`slot:${s.startTime}:${s.resourceNames.join(",")}`} className="rounded-field border border-border p-2.5">
              <p className="flex flex-wrap items-center gap-2 text-sm text-text-primary">
                <span className="font-medium tabular-nums">{zonedTimeLabel(s.startTime, timezone)}</span>
                {s.resourceNames.length > 0 && <span className="text-text-secondary">{s.resourceNames.join(" + ")}</span>}
                {slotTouchesAnother(s) && <Badge variant="success">Encostado</Badge>}
              </p>
              {s.reasons.length > 0 && <p className="mt-0.5 text-sm text-text-muted">{s.reasons.join("; ")}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Prévia do modo inteligente: o que seria oferecido num dia de exemplo, com os horários encostados marcados. */
export function SuggestionPreviewView({ loading, suggestions, chronological, timezone, off }: SuggestionPreviewViewProps) {
  if (loading) return <div className="flex justify-center py-4"><Spinner /></div>;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Slots title={off ? "O que seria oferecido (em ordem de horário)" : "O que seria oferecido primeiro"} slots={off ? chronological : suggestions} timezone={timezone} />
      {!off && <Slots title="Sem a regra (em ordem de horário)" slots={chronological} timezone={timezone} />}
    </div>
  );
}
