/**
 * Passo 2 — quando publicar. Tudo no FUSO escolhido aqui: os horários, os dias
 * e as datas de início/fim. O resumo e os próximos disparos saem dos mesmos
 * módulos puros que o worker usa, então o que a tela promete é o que o
 * servidor vai fazer.
 */
import { useState } from "react";
import { CalendarClock, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import type { PostDraft } from "./wizardState";
import { schedulePayload } from "./wizardState";
import {
  DAY_PRESETS,
  WEEKDAYS,
  formatDateTime,
  nextRuns,
  scheduleSummary,
  timezoneOptions,
} from "./postUtils";

const MAX_TIMES = 10;
const SELECT_CLASS =
  "w-full h-10 rounded-lg border border-border bg-surface-raised px-3 text-base md:text-sm text-text-primary";

interface StepScheduleProps {
  draft: PostDraft;
  setDraft: (updater: (prev: PostDraft) => PostDraft) => void;
  orgTimezone?: string;
  now: number;
}

export function StepSchedule({ draft, setDraft, orgTimezone, now }: StepScheduleProps) {
  const [newTime, setNewTime] = useState("12:00");
  const options = timezoneOptions(orgTimezone, draft.timezone);
  const schedule = schedulePayload(draft);
  const upcoming = nextRuns(schedule, now, 3);

  const addTime = () => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(newTime)) return;
    setDraft((prev) =>
      prev.times.includes(newTime) || prev.times.length >= MAX_TIMES
        ? prev
        : { ...prev, times: [...prev.times, newTime].sort() }
    );
  };

  const toggleDay = (day: number) =>
    setDraft((prev) => ({
      ...prev,
      days: prev.days.includes(day)
        ? prev.days.filter((d) => d !== day)
        : [...prev.days, day].sort((a, b) => a - b),
    }));

  return (
    <div className="space-y-5">
      <div>
        <label className="mb-1.5 block text-[13px] font-medium text-text-secondary" htmlFor="post-tz">
          Fuso horário
        </label>
        <select
          id="post-tz"
          className={SELECT_CLASS}
          value={draft.timezone}
          onChange={(e) => setDraft((prev) => ({ ...prev, timezone: e.target.value }))}
        >
          {options.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-text-primary">
          Horários <span className="font-normal text-text-muted">({draft.times.length}/{MAX_TIMES})</span>
        </h3>
        <div className="flex flex-wrap gap-2">
          {draft.times.map((time) => (
            <span
              key={time}
              className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface-raised px-3 py-1 text-sm tabular-nums text-text-primary"
            >
              {time}
              <button
                type="button"
                aria-label={`Remover ${time}`}
                className="text-text-muted transition-colors hover:text-semantic-error"
                onClick={() => setDraft((prev) => ({ ...prev, times: prev.times.filter((t) => t !== time) }))}
              >
                <X size={13} />
              </button>
            </span>
          ))}
          {draft.times.length === 0 && (
            <span className="text-sm text-semantic-error">Adicione pelo menos um horário</span>
          )}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            type="time"
            value={newTime}
            onChange={(e) => setNewTime(e.target.value)}
            className="h-10 rounded-lg border border-border bg-surface-raised px-3 text-base md:text-sm text-text-primary"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={addTime}
            disabled={draft.times.length >= MAX_TIMES || draft.times.includes(newTime)}
          >
            <Plus size={14} />
            Adicionar
          </Button>
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-medium text-text-primary">Dias da semana</h3>
        <div className="flex flex-wrap gap-1.5">
          {WEEKDAYS.map((day) => {
            const on = draft.days.includes(day.value);
            return (
              <button
                key={day.value}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(day.value)}
                className={cn(
                  "h-9 w-12 rounded-full border text-sm font-medium transition-colors",
                  on
                    ? "border-brand-500 bg-brand-500/15 text-brand-400"
                    : "border-border-strong bg-surface-raised text-text-secondary hover:text-text-primary"
                )}
              >
                {day.short}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {DAY_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => setDraft((prev) => ({ ...prev, days: [...preset.days] }))}
              className="rounded-full border border-border px-2.5 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-brand-500 hover:text-brand-400"
            >
              {preset.label}
            </button>
          ))}
        </div>
        {draft.days.length === 0 && (
          <p className="mt-1.5 text-sm text-semantic-error">Escolha pelo menos um dia</p>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-text-secondary" htmlFor="post-start">
            Começa em (opcional)
          </label>
          <input
            id="post-start"
            type="date"
            value={draft.startDate}
            onChange={(e) => setDraft((prev) => ({ ...prev, startDate: e.target.value }))}
            className={SELECT_CLASS}
          />
        </div>
        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-text-secondary" htmlFor="post-end">
            Termina em (opcional)
          </label>
          <input
            id="post-end"
            type="date"
            value={draft.endDate}
            onChange={(e) => setDraft((prev) => ({ ...prev, endDate: e.target.value }))}
            className={SELECT_CLASS}
          />
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-[13px] font-medium text-text-secondary" htmlFor="post-jitter">
          Variação aleatória: até {draft.jitterMinutes} min depois do horário
        </label>
        <input
          id="post-jitter"
          type="range"
          min={0}
          max={30}
          step={1}
          value={draft.jitterMinutes}
          onChange={(e) => setDraft((prev) => ({ ...prev, jitterMinutes: Number(e.target.value) }))}
          className="w-full accent-brand-500"
        />
        <p className="mt-1 text-xs text-text-muted">
          Postar 12:00:00 cravado todo dia parece robô. Alguns minutos de folga deixam a publicação
          com cara de gente.
        </p>
      </div>

      <div className="rounded-card border border-border bg-surface-raised p-3.5">
        <div className="flex items-start gap-2">
          <CalendarClock size={16} className="mt-0.5 shrink-0 text-brand-500" />
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-text-primary">{scheduleSummary(schedule)}</p>
            {upcoming.length > 0 ? (
              <ul className="space-y-0.5 text-xs text-text-muted">
                {upcoming.map((at, i) => (
                  <li key={at} className="tabular-nums">
                    {i === 0 ? "Próximo: " : "Depois: "}
                    {formatDateTime(at, draft.timezone)}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-semantic-warning">
                Essa agenda não tem nenhum horário futuro — revise as datas.
              </p>
            )}
            {draft.jitterMinutes > 0 && (
              <p className="text-[11px] text-text-muted">
                Horários aproximados: a variação só é sorteada na hora, por publicação.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
