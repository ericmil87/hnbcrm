import { useState } from "react";
import { Copy, Plus, Trash2, UtensilsCrossed } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import {
  addShift, copyDayTo, removeShift, setShift, splitWithLunch, WEEKDAY_NAMES, WEEKDAYS_MON_FRI, WEEK_DISPLAY_ORDER, WEEK_GENERAL_ERROR,
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
                    className="min-h-11 w-28 rounded-field border border-border-strong bg-surface-raised px-2 text-base text-text-primary md:text-sm"
                  />
                  <span className="text-text-muted" aria-hidden="true">às</span>
                  <input
                    type="time"
                    aria-label={`${WEEKDAY_NAMES[day]}, fim do turno ${i + 1}`}
                    value={s.end}
                    disabled={disabled}
                    onChange={(e) => onChange(setShift(value, day, i, { end: e.target.value }))}
                    className="min-h-11 w-28 rounded-field border border-border-strong bg-surface-raised px-2 text-base text-text-primary md:text-sm"
                  />
                  <Button iconOnly size="sm" variant="ghost" aria-label={`Remover turno ${i + 1} de ${WEEKDAY_NAMES[day]}`} disabled={disabled} onClick={() => onChange(removeShift(value, day, i))}>
                    <Trash2 size={16} aria-hidden="true" />
                  </Button>
                </div>
              ))}
              {errors[day] && <p role="alert" className="text-sm text-semantic-error">{errors[day]}</p>}
            </li>
          );
        })}
      </ul>

      <Modal open={copyFrom !== null} onClose={() => setCopyFrom(null)} title={copyFrom === null ? undefined : `Copiar horário de ${WEEKDAY_NAMES[copyFrom]}`}>
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">Escolha os dias que passam a ter o mesmo horário. O que eles já tinham é substituído.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => setTargets([...WEEKDAYS_MON_FRI].filter((d) => d !== copyFrom))}>Segunda a sexta</Button>
            <Button size="sm" variant="secondary" onClick={() => setTargets(WEEK_DISPLAY_ORDER.filter((d) => d !== copyFrom))}>Todos os dias</Button>
          </div>
          <div role="group" aria-label="Dias de destino" className="grid grid-cols-2 gap-2">
            {WEEK_DISPLAY_ORDER.filter((d) => d !== copyFrom).map((d) => (
              <label key={`copy:${d}`} className="flex min-h-11 items-center gap-2 rounded-field border border-border px-3 text-sm text-text-primary">
                <input type="checkbox" checked={targets.includes(d)} onChange={() => toggle(d)} />
                {WEEKDAY_NAMES[d]}
              </label>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setCopyFrom(null)}>Cancelar</Button>
            <Button
              className="flex-1"
              disabled={targets.length === 0}
              onClick={() => {
                if (copyFrom !== null) onChange(copyDayTo(value, copyFrom, targets));
                setCopyFrom(null);
              }}
            >
              Copiar
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
