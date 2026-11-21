/**
 * Agenda v2 — pontuação anti-fragmentação (puro, explicável).
 *
 *   score = wAdj*adjacency - wDead*deadGap - wOpen*openNew + wEarly*earlyFirst
 *           + wBal*balance + wPref*preference
 *
 * Features em [0,1] por recurso do plano; as PARCELAS (`parts`, já com peso e
 * sinal) são somadas entre os recursos. `features` (extra, aditivo ao plano)
 * guarda a soma crua e é o que o modo `restrict` consulta, para que peso 0 não
 * esconda a regra.
 *
 * Vizinho = alocação, bloqueio, compromisso interno ou borda do intervalo
 * aberto (início/fim do expediente). A lacuna "antes" é a distância até o
 * vizinho anterior (ou até a borda de abertura do turno), a "depois" até o
 * seguinte. Alocação que SOBREPÕE o candidato (sala com capacidade > 1) não é
 * vizinho. Gaps usam o BLOCO (com folgas) do candidato.
 *
 * Detalhes escolhidos onde o relatório 04 §5.2 não fixa:
 *  - `earlyFirst` usa o primeiro início e o último fim dos intervalos abertos
 *    do recurso no dia; denominador <= 0 vale 1; resultado limitado a [0,1];
 *  - `balance` só vale para recursos `person` (carga = minutos de bloco
 *    alocados no dia / maior carga entre as pessoas do dia);
 *  - `preference` é calculada uma vez por candidato (não por recurso): vale 1
 *    quando TODAS as preferências informadas casam;
 *  - `openNew` = nenhuma alocação do recurso tocando o dia local.
 */

import type { Interval, ResourceDay, SchedId } from "./schedAvailability";
import type { Candidate } from "./schedCandidates";
import { periodWindow } from "./schedRelativeDates";
import { assertValidTimezone, localDateOf, minutesOfDay } from "./schedTime";

export type SmartWeights = {
  adjacency: number;
  deadGap: number;
  openNewResource: number;
  earlyFirst: number;
  balance: number;
  preference: number;
};
/** 40/50/20/10/0/30. UNIFICAR com o default de `schedSettingsDefaults` (A1). */
export const DEFAULT_WEIGHTS: SmartWeights = {
  adjacency: 40,
  deadGap: 50,
  openNewResource: 20,
  earlyFirst: 10,
  balance: 0,
  preference: 30,
};

export type ScoredCandidate = Candidate & {
  score: number;
  parts: Record<keyof SmartWeights, number>; // parcelas com peso e sinal (deadGap e openNewResource negativas)
  features: Record<keyof SmartWeights, number>; // soma crua das features (não ponderada)
  reasons: string[]; // PT-BR: "logo após outro atendimento"
};

export type SmartMode = "off" | "rank" | "restrict";
export type Audience = "staff" | "ai" | "public";
export type ScorePreference = {
  period?: "morning" | "afternoon" | "evening";
  resourceIds?: SchedId[];
};

const PERIOD_KEY = { morning: "manha", afternoon: "tarde", evening: "noite" } as const;
const MINUTE_MS = 60_000;

type Neighbor = Interval;

function neighborsOf(day: ResourceDay): Neighbor[] {
  return [
    ...day.allocations.map((a) => ({ start: a.blockStart, end: a.blockEnd })),
    ...day.blocks.map((b) => ({ start: b.start, end: b.end })),
  ];
}

function featuresForResource(
  c: Candidate,
  entry: Candidate["plan"][number],
  day: ResourceDay,
  allDays: Map<SchedId, ResourceDay>,
  minUsefulGapMin: number
) {
  const neighbors = neighborsOf(day);
  const overlapping = (n: Neighbor) => n.start < c.blockEnd && c.blockStart < n.end;
  const idle = neighbors.filter((n) => !overlapping(n));

  // Turno aberto que contém o núcleo do candidato (ou o dia aberto inteiro, se nenhum contém).
  const shift =
    day.open.find((o) => o.start <= c.startTime && o.end >= c.endTime) ??
    (day.open.length > 0
      ? { start: day.open[0].start, end: day.open[day.open.length - 1].end }
      : { start: c.blockStart, end: c.blockEnd });

  let prevEdge = shift.start;
  let prevIsNeighbor = false;
  for (const n of idle) {
    if (n.end <= c.blockStart && n.end >= prevEdge) {
      prevEdge = n.end;
      prevIsNeighbor = true;
    }
  }
  let nextEdge = shift.end;
  let nextIsNeighbor = false;
  for (const n of idle) {
    if (n.start >= c.blockEnd && n.start <= nextEdge) {
      nextEdge = n.start;
      nextIsNeighbor = true;
    }
  }
  // Se um vizinho coincide exatamente com a borda do turno, vale como vizinho.
  const gapBefore = Math.max(0, c.blockStart - prevEdge);
  const gapAfter = Math.max(0, nextEdge - c.blockEnd);
  const minGap = minUsefulGapMin * MINUTE_MS;
  const touchBefore = gapBefore === 0;
  const touchAfter = gapAfter === 0;

  const adjacency = ((touchBefore ? 1 : 0) + (touchAfter ? 1 : 0)) / 2;
  const deadGap =
    (gapBefore > 0 && gapBefore < minGap) || (gapAfter > 0 && gapAfter < minGap) ? 1 : 0;
  const openNew = day.allocations.some((a) => a.blockStart < day.bounds.end && a.blockEnd > day.bounds.start)
    ? 0
    : 1;

  let earlyFirst = 1;
  if (day.open.length > 0) {
    const opens = day.open[0].start;
    const closes = day.open[day.open.length - 1].end;
    const dur = c.endTime - c.startTime;
    const denom = closes - opens - dur;
    earlyFirst = denom <= 0 ? 1 : Math.min(1, Math.max(0, 1 - (c.startTime - opens) / denom));
  }

  let balance = 0;
  if (day.resource.kind === "person") {
    const load = (d: ResourceDay) => d.allocations.reduce((s, a) => s + (a.blockEnd - a.blockStart), 0);
    let maxLoad = 0;
    for (const d of allDays.values()) if (d.resource.kind === "person") maxLoad = Math.max(maxLoad, load(d));
    balance = 1 - load(day) / Math.max(1, maxLoad);
  }

  return {
    adjacency,
    deadGap,
    openNew,
    earlyFirst,
    balance,
    touchBefore,
    touchAfter,
    prevIsNeighbor,
    nextIsNeighbor,
    gapBeforeMin: gapBefore / MINUTE_MS,
    gapAfterMin: gapAfter / MINUTE_MS,
    resourceId: entry.resourceId,
  };
}

/** Vizinho = alocação, bloqueio, compromisso interno ou borda do expediente. Calcula em cada recurso do plano e soma. */
export function scoreCandidate(
  c: Candidate,
  day: Map<SchedId, ResourceDay>,
  w: SmartWeights,
  opts: { minUsefulGapMin: number; preference?: ScorePreference; tz?: string }
): ScoredCandidate {
  const features: Record<keyof SmartWeights, number> = {
    adjacency: 0,
    deadGap: 0,
    openNewResource: 0,
    earlyFirst: 0,
    balance: 0,
    preference: 0,
  };
  const reasons: string[] = [];
  const addReason = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  for (const entry of c.plan) {
    const rd = day.get(entry.resourceId);
    if (!rd) continue;
    const f = featuresForResource(c, entry, rd, day, opts.minUsefulGapMin);
    features.adjacency += f.adjacency;
    features.deadGap += f.deadGap;
    features.openNewResource += f.openNew;
    features.earlyFirst += f.earlyFirst;
    features.balance += f.balance;
    if (f.touchBefore) addReason(f.prevIsNeighbor ? "logo após outro atendimento" : "no início do expediente");
    if (f.touchAfter) addReason(f.nextIsNeighbor ? "logo antes de outro atendimento" : "no fim do expediente");
    if (f.deadGap > 0) {
      const g = f.gapBeforeMin > 0 && f.gapBeforeMin < opts.minUsefulGapMin ? f.gapBeforeMin : f.gapAfterMin;
      addReason(`deixa uma lacuna de ${Math.round(g)} min`);
    }
    if (f.openNew > 0) addReason("abre um recurso novo");
  }

  const pref = opts.preference;
  if (pref && (pref.period !== undefined || (pref.resourceIds && pref.resourceIds.length > 0))) {
    let match = true;
    if (pref.period !== undefined) {
      if (opts.tz === undefined) throw new Error("scoreCandidate: `tz` é obrigatório quando há preferência de período.");
      assertValidTimezone(opts.tz);
      const win = periodWindow(PERIOD_KEY[pref.period]);
      const min = minutesOfDay(c.startTime, opts.tz);
      if (!(min >= win.startMin && min < win.endMin)) match = false;
    }
    if (pref.resourceIds && pref.resourceIds.length > 0) {
      if (!c.plan.some((p) => pref.resourceIds!.includes(p.resourceId))) match = false;
    }
    features.preference = match ? 1 : 0;
    if (match) addReason("combina com a preferência do cliente");
  }
  if (w.balance > 0 && features.balance > 0) addReason("equilibra a carga entre a equipe");

  const parts: Record<keyof SmartWeights, number> = {
    adjacency: w.adjacency * features.adjacency,
    deadGap: -w.deadGap * features.deadGap + 0, // `+ 0` evita -0
    openNewResource: -w.openNewResource * features.openNewResource + 0,
    earlyFirst: w.earlyFirst * features.earlyFirst,
    balance: w.balance * features.balance,
    preference: w.preference * features.preference,
  };
  const score =
    parts.adjacency + parts.deadGap + parts.openNewResource + parts.earlyFirst + parts.balance + parts.preference;
  return { ...c, score, parts, features, reasons };
}

function planKey(c: Candidate): string {
  return c.plan.map((p) => p.resourceId).join("|");
}

/** Cronológico; empate por plano (determinístico). */
function compareChrono(a: Candidate, b: Candidate): number {
  if (a.startTime !== b.startTime) return a.startTime - b.startTime;
  const ka = planKey(a);
  const kb = planKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Maior pontuação primeiro; empate: mais cedo, depois plano. */
function compareRank(a: ScoredCandidate, b: ScoredCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  return compareChrono(a, b);
}

function distinctStarts(list: Candidate[]): number {
  return new Set(list.map((c) => c.startTime)).size;
}

/**
 * off = cronológico; rank = por pontuação; restrict = só deadGap 0 e adjacency > 0,
 * com fallback para rank se sobrar menos que minOffer (horários distintos).
 * Equipe nunca recebe "restrict" (vira rank).
 */
export function applySmartMode(
  cands: ScoredCandidate[],
  mode: SmartMode,
  minOffer: number,
  audience: Audience
): { list: ScoredCandidate[]; relaxed: boolean } {
  const effective: SmartMode = mode === "restrict" && audience === "staff" ? "rank" : mode;
  if (effective === "off") return { list: [...cands].sort(compareChrono), relaxed: false };
  const ranked = [...cands].sort(compareRank);
  if (effective === "rank") return { list: ranked, relaxed: false };
  const strict = ranked.filter((c) => c.features.deadGap === 0 && c.features.adjacency > 0);
  if (distinctStarts(strict) >= minOffer) return { list: strict, relaxed: false };
  return { list: ranked, relaxed: true };
}

type Period = "manha" | "tarde" | "noite";
function periodOf(ms: number, tz: string): Period {
  const m = minutesOfDay(ms, tz);
  return m < 720 ? "manha" : m < 1080 ? "tarde" : "noite";
}

/**
 * Escolhe até `max` ofertas variadas, todas de início distinto: a melhor, uma
 * de outro período, uma de outro dia (cada uma cai para a melhor restante se
 * não houver variação). Devolve na ordem de escolha (melhor primeiro).
 */
export function pickOffers(ranked: ScoredCandidate[], max: number, tz: string): ScoredCandidate[] {
  assertValidTimezone(tz);
  if (max <= 0 || ranked.length === 0) return [];
  const picks: ScoredCandidate[] = [];
  const taken = new Set<number>();
  const take = (c: ScoredCandidate | undefined): boolean => {
    if (!c || taken.has(c.startTime)) return false;
    picks.push(c);
    taken.add(c.startTime);
    return true;
  };
  const rest = () => ranked.filter((c) => !taken.has(c.startTime));

  take(ranked[0]);
  if (picks.length < max) {
    const periods = new Set(picks.map((p) => periodOf(p.startTime, tz)));
    take(rest().find((c) => !periods.has(periodOf(c.startTime, tz))) ?? rest()[0]);
  }
  if (picks.length < max) {
    const days = new Set(picks.map((p) => localDateOf(p.startTime, tz)));
    take(rest().find((c) => !days.has(localDateOf(c.startTime, tz))) ?? rest()[0]);
  }
  while (picks.length < max) {
    if (!take(rest()[0])) break;
  }
  return picks;
}
