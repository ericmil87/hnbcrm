/**
 * Agenda v2 (E1) — buracos da agenda: janelas livres de cada recurso entre atendimentos (puro, sem `ctx`).
 *
 * Entrada em UTC ms; o fuso só entra para dar os minutos locais de cada janela (`startMin`/`endMin`) e para o
 * chamador montar rótulos. Recurso com capacidade > 1 só fica "ocupado" quando o número de agendamentos
 * sobrepostos alcança a capacidade (cada agendamento conta 1 unidade: aproximação da tela, que também não lê as
 * unidades reais). O bloco ocupado é o `blockStart/blockEnd` (com folgas): folga não é horário aproveitável.
 */
import { minutesOfDay } from "./schedTime";

export type GapInterval = { start: number; end: number };
export type GapResource = {
  resourceId: string;
  resourceName: string;
  kind: "person" | "room" | "equipment";
  capacity: number;
  /** Intervalos abertos já com exceções e bloqueios descontados. */
  open: GapInterval[];
  /** Blocos ocupados por agendamentos ativos (um item por agendamento). */
  busy: GapInterval[];
};
/**
 * `between`: livre com atendimento antes E depois (o buraco que dá para encaixar);
 * `before_first` / `after_last`: sobra no começo / no fim do expediente; `empty`: nenhum atendimento no trecho.
 */
export type GapPosition = "between" | "before_first" | "after_last" | "empty";
export type Gap = {
  resourceId: string;
  resourceName: string;
  kind: GapResource["kind"];
  start: number;
  end: number;
  minutes: number;
  startMin: number;
  endMin: number;
  position: GapPosition;
};

const MINUTE_MS = 60_000;

/** Une intervalos sobrepostos ou encostados (ordenados). */
function merge(list: GapInterval[]): GapInterval[] {
  const sorted = list.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const out: GapInterval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ ...iv });
  }
  return out;
}

/** Trechos em que `busy` alcança `capacity` simultâneos (varredura por eventos). */
export function saturatedIntervals(busy: GapInterval[], capacity: number): GapInterval[] {
  const cap = Math.max(1, Math.floor(capacity));
  const events: Array<{ at: number; delta: number }> = [];
  for (const b of busy) {
    if (b.end <= b.start) continue;
    events.push({ at: b.start, delta: 1 }, { at: b.end, delta: -1 });
  }
  // fim antes do início no mesmo instante: encostar não conta como sobrepor.
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  const out: GapInterval[] = [];
  let load = 0;
  let from: number | null = null;
  for (const ev of events) {
    const before = load;
    load += ev.delta;
    if (before < cap && load >= cap) from = ev.at;
    else if (before >= cap && load < cap && from !== null) {
      out.push({ start: from, end: ev.at });
      from = null;
    }
  }
  return merge(out);
}

function subtract(open: GapInterval[], taken: GapInterval[]): GapInterval[] {
  const out: GapInterval[] = [];
  for (const o of merge(open)) {
    let cursor = o.start;
    for (const t of taken) {
      if (t.end <= cursor) continue;
      if (t.start >= o.end) break;
      if (t.start > cursor) out.push({ start: cursor, end: Math.min(t.start, o.end) });
      cursor = Math.max(cursor, t.end);
      if (cursor >= o.end) break;
    }
    if (cursor < o.end) out.push({ start: cursor, end: o.end });
  }
  return out;
}

/**
 * Janelas livres de cada recurso com pelo menos `minMinutes`. `notBefore` corta o passado (um buraco que já começou
 * vira "de agora em diante"). Ordem: início, depois nome do recurso. `position` diz se o buraco está entre dois
 * atendimentos (o que a equipe quer encaixar) ou na ponta do expediente.
 */
export function computeGaps(input: {
  resources: readonly GapResource[];
  tz: string;
  minMinutes: number;
  notBefore?: number;
}): Gap[] {
  const min = Math.max(1, Math.floor(input.minMinutes));
  const out: Gap[] = [];
  for (const r of input.resources) {
    const taken = saturatedIntervals(r.busy, r.capacity);
    const free = subtract(r.open, taken);
    for (const f of free) {
      const start = Math.max(f.start, input.notBefore ?? -Infinity);
      if (f.end - start < min * MINUTE_MS) continue;
      const openSpan = merge(r.open).find((o) => o.start <= f.start && f.end <= o.end);
      const hadBefore = taken.some((t) => t.end <= f.start && (!openSpan || t.end >= openSpan.start));
      const hadAfter = taken.some((t) => t.start >= f.end && (!openSpan || t.start <= openSpan.end));
      const position: GapPosition = hadBefore && hadAfter ? "between" : hadBefore ? "after_last" : hadAfter ? "before_first" : "empty";
      out.push({
        resourceId: r.resourceId,
        resourceName: r.resourceName,
        kind: r.kind,
        start,
        end: f.end,
        minutes: Math.round((f.end - start) / MINUTE_MS),
        startMin: minutesOfDay(start, input.tz),
        // fim exatamente na meia-noite local seguinte = 1440, não 0
        endMin: minutesOfDay(f.end, input.tz) === 0 && f.end > start ? 1440 : minutesOfDay(f.end, input.tz),
        position,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.resourceName.localeCompare(b.resourceName));
}
