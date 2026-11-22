import { useState } from "react";
import { Copy, Plus, Trash2, UtensilsCrossed } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  addShift, copyDayTo, END_OF_DAY, removeShift, setShift, splitWithLunch, WEEKDAY_NAMES, WEEKDAYS_MON_FRI, WEEK_DISPLAY_ORDER, WEEK_GENERAL_ERROR,
  type WeekForm,
} from "@/lib/agendaWeek";

interface WeeklyHoursEditorProps {
  value: WeekForm;
  onChange: (next: WeekForm) => void;
  /** Mensagens por dia (`weekErrors`). */
  errors?: Record<number, string>;
  disabled?: boolean;
}

/** Editor de horário semanal: turnos por dia, dois turnos com almoço e "copiar para outros dias". Controlado, sem Convex. */
export function WeeklyHoursEditor({ value, onChange, errors = {}, disabled }: WeeklyHoursEditorProps) {
  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  const [targets, setTargets] = useState<number[]>([]);

  const openCopy = (day: number) => {
    setCopyFrom(day);
    setTargets([]);
  };
  const toggle = (d: number) => setTargets((t) => (t.includes(d) ? t.filter((x) => x !== d) : [...t, d]));

  return (
    <div className="space-y-2">
      {errors[WEEK_GENERAL_ERROR] && <p role="alert" className="text-sm text-semantic-error">{errors[WEEK_GENERAL_ERROR]}</p>}
      <ul className="divide-y divide-border rounded-card border border-border">
        {WEEK_DISPLAY_ORDER.map((day) => {
          const shifts = value[day] ?? [];
          return (
            <li key={`day:${day}`} className="space-y-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-text-primary">{WEEKDAY_NAMES[day]}</p>
                <div className="flex flex-wrap gap-1">
                  {shifts.length === 1 && (
                    <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(splitWithLunch(value, day))}>
                      <UtensilsCrossed size={14} aria-hidden="true" /> Pausa para almoço
                    </Button>
                  )}
                  {shifts.length > 0 && (
                    <Button size="sm" variant="ghost" disabled={disabled} onClick={() => openCopy(day)} aria-label={`Copiar horário de ${WEEKDAY_NAMES[day]} para outros dias`}>
                      <Copy size={14} aria-hidden="true" /> Copiar
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(addShift(value, day))} aria-label={`Adicionar turno em ${WEEKDAY_NAMES[day]}`}>
                    <Plus size={14} aria-hidden="true" /> Turno
                  </Button>
                </div>
              </div>
              {shifts.length === 0 && <p className="text-sm text-text-muted">Fechado</p>}
              {shifts.map((s, i) => (
                <div key={`shift:${day}:${i}`} className="flex items-center gap-2">
                  <input
                    type="time"
                    aria-label={`${WEEKDAY_NAMES[day]}, início do turno ${i + 1}`}
                    value={s.start}
                    disabled={disabled}
                    onChange={(e) => onChange(setShift(value, day, i, { start: e.target.value }))}
                    className="min-h-11 w-32 rounded-field border border-border-strong bg-surface-raised px-2 text-base text-text-primary md:text-sm"
                  />
                  <span className="text-text-muted" aria-hidden="true">às</span>
                  {s.end === END_OF_DAY ? (
                    <Button
                      variant="secondary"
                      className="w-32 tabular-nums"
                      disabled={disabled}
                      aria-label={`${WEEKDAY_NAMES[day]}, fim do turno ${i + 1}: 24:00 (meia-noite). Tocar para escolher outra hora`}
                      onClick={() => onChange(setShift(value, day, i, { end: "23:59" }))}
                    >
                      24:00
                    </Button>
                  ) : (
                    <input
                      type="time"
                      aria-label={`${WEEKDAY_NAMES[day]}, fim do turno ${i + 1}`}
                      value={s.end}
                      disabled={disabled}
                      onChange={(e) => onChange(setShift(value, day, i, { end: e.target.value }))}
                      className="min-h-11 w-32 rounded-field border border-border-strong bg-surface-raised px-2 text-base text-text-primary md:text-sm"
                    />
                  )}
                  <Button iconOnly size="sm" variant="ghost" aria-label={`Remover turno ${i + 1} de ${WEEKDAY_NAMES[day]}`} disabled={disabled} onClick={() => onChange(removeShift(value, day, i))}>
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </div>
              ))}
              {errors[day] && <p role="alert" className="text-sm text-semantic-error">{errors[day]}</p>}
              {copyFrom === day && (
                <div
                  role="group"
                  aria-label={`Copiar horário de ${WEEKDAY_NAMES[day]}`}
                  onKeyDown={(e) => {
                    // Esc fecha só esta escolha: a folha ou o assistente por baixo escutam o mesmo evento no documento.
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setCopyFrom(null);
                    }
                  }}
                  className="space-y-3 rounded-card border border-brand-500/40 bg-surface-sunken p-3"
                >
                  <p className="text-sm text-text-secondary">Copiar para quais dias? O que eles já tinham é substituído.</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setTargets([...WEEKDAYS_MON_FRI].filter((d) => d !== day))}>Segunda a sexta</Button>
                    <Button size="sm" variant="secondary" onClick={() => setTargets(WEEK_DISPLAY_ORDER.filter((d) => d !== day))}>Todos os dias</Button>
                  </div>
                  <div role="group" aria-label="Dias de destino" className="grid grid-cols-2 gap-2">
                    {WEEK_DISPLAY_ORDER.filter((d) => d !== day).map((d) => (
                      <label key={`copy:${d}`} className="flex min-h-11 items-center gap-2 rounded-field border border-border px-3 text-sm text-text-primary">
                        <input type="checkbox" checked={targets.includes(d)} onChange={() => toggle(d)} />
                        {WEEKDAY_NAMES[d]}
                      </label>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" className="flex-1" onClick={() => setCopyFrom(null)}>Cancelar</Button>
                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={targets.length === 0}
                      onClick={() => {
                        onChange(copyDayTo(value, day, targets));
                        setCopyFrom(null);
                      }}
                    >
                      Copiar
                    </Button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
