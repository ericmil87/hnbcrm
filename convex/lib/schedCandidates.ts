/**
 * Agenda v2 — geração de horários candidatos de um dia (puro).
 *
 * Para cada início da grade (minutos de hora LOCAL ancorados na meia-noite
 * local — abertura às 08:10 com passo 30 começa em 08:30), tenta montar um
 * plano de recursos que atenda todos os requisitos do serviço: papel mais
 * escasso primeiro, retrocesso curto, até `maxPerStart` planos por início.
 *
 * Decisões desta implementação (o plano não fixa):
 *  - o NÚCLEO do serviço precisa caber num intervalo aberto (menos bloqueios e
 *    compromissos internos); folgas podem passar do expediente;
 *  - `basis: "block"` (padrão) exige que o BLOCO não ultrapasse a capacidade
 *    (folga conta; é o que IA e link público veem); `basis: "core"` exige só o
 *    núcleo (visão da equipe, que pode furar folga mas nunca capacidade);
 *  - um recurso atende no máximo um papel por plano.
 */

import {
  type AllocationLite,
  type Interval,
  peakUnits,
  type ResourceDay,
  type ResourceLite,
  type SchedId,
  usableIntervals,
} from "./schedAvailability";
import { atLocalMinutes, type LocalDate } from "./schedTime";

export type ServiceRequirementLite = {
  role: string;
  kind: "person" | "room" | "equipment";
  resourceIds?: SchedId[]; // ausente/vazio = qualquer ativo do kind (e da tag)
  tag?: string;
  units?: number; // ausente = 1
  exclusive?: boolean; // true = ocupa a capacidade inteira do recurso
};
export type ServiceLite = {
  _id: SchedId;
  name: string;
  durationMin: number;
  variants?: Array<{ key: string; name: string; durationMin: number }>;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  requirements: ServiceRequirementLite[];
  slotIntervalMin?: number;
};
export type Candidate = {
  startTime: number;
  endTime: number;
  blockStart: number;
  blockEnd: number;
  plan: Array<{ role: string; resourceId: SchedId; units: number }>;
};

const MINUTE_MS = 60_000;
/** Teto de bloco do plano (`MAX_BLOCK_MIN`, A1). UNIFICAR com `schedConstants`. */
const DEFAULT_MAX_BLOCK_MIN = 480;
const DEFAULT_MAX_PER_START = 3;

/** Duração efetiva em minutos (variante, se houver). Lança se `variantKey` não existe. */
export function durationFor(service: Pick<ServiceLite, "durationMin" | "variants">, variantKey?: string): number {
  if (variantKey === undefined) return service.durationMin;
  const v = service.variants?.find((x) => x.key === variantKey);
  if (!v) throw new Error(`Variação de serviço desconhecida: "${variantKey}".`);
  return v.durationMin;
}

export function requirementMatches(resource: ResourceLite, req: ServiceRequirementLite): boolean {
  if (!resource.active || resource.kind !== req.kind) return false;
  if (req.resourceIds && req.resourceIds.length > 0 && !req.resourceIds.includes(resource._id)) return false;
  if (req.tag !== undefined && !(resource.tags ?? []).includes(req.tag)) return false;
  return true;
}

/** Unidades que o requisito consome no recurso (`exclusive` = capacidade inteira). */
export function unitsFor(req: ServiceRequirementLite, resource: Pick<ResourceLite, "capacity">): number {
  return req.exclusive ? resource.capacity : (req.units ?? 1);
}

function coveredBy(intervals: Interval[], start: number, end: number): boolean {
  return intervals.some((iv) => iv.start <= start && iv.end >= end);
}

function resourceFits(
  day: ResourceDay,
  usable: Interval[],
  req: ServiceRequirementLite,
  c: Pick<Candidate, "startTime" | "endTime" | "blockStart" | "blockEnd">,
  basis: "core" | "block"
): boolean {
  if (day.closed) return false;
  const units = unitsFor(req, day.resource);
  if (units > day.resource.capacity) return false;
  if (!coveredBy(usable, c.startTime, c.endTime)) return false;
  const rows: AllocationLite[] = day.allocations;
  const peak =
    basis === "core"
      ? peakUnits(rows, c.startTime, c.endTime, "core")
      : peakUnits(rows, c.blockStart, c.blockEnd, "block");
  return peak + units <= day.resource.capacity;
}

function byPreference(preferred: Set<SchedId>) {
  return (a: ResourceLite, b: ResourceLite): number => {
    const pa = preferred.has(a._id) ? 0 : 1;
    const pb = preferred.has(b._id) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
  };
}

/** Passo em minutos de hora local; para cada início tenta montar o plano (papel mais escasso primeiro, retrocesso curto). */
export function generateCandidates(input: {
  date: LocalDate;
  tz: string;
  gridMinutes: number;
  service: ServiceLite;
  variantKey?: string;
  day: Map<SchedId, ResourceDay>;
  earliest: number;
  latest: number; // antecedência mínima e janela máxima já resolvidas pela origem
  preferredResourceIds?: SchedId[];
  maxPerStart?: number; // planos alternativos por início; default 3
  basis?: "core" | "block"; // default "block"
  maxBlockMin?: number; // default 480
}): Candidate[] {
  const { date, tz, service, day, earliest, latest } = input;
  const step = service.slotIntervalMin ?? input.gridMinutes;
  if (!Number.isInteger(step) || step < 1 || step > 1440) throw new Error("Passo da grade inválido.");
  const maxPerStart = Math.max(1, input.maxPerStart ?? DEFAULT_MAX_PER_START);
  const basis = input.basis ?? "block";
  const maxBlockMin = input.maxBlockMin ?? DEFAULT_MAX_BLOCK_MIN;
  const durationMin = durationFor(service, input.variantKey);
  const blockMin = durationMin + service.bufferBeforeMin + service.bufferAfterMin;
  if (durationMin <= 0 || blockMin > maxBlockMin) return [];
  if (service.requirements.length === 0) return [];
  const preferred = new Set(input.preferredResourceIds ?? []);
  const resources = [...day.values()].map((d) => d.resource).sort(byPreference(preferred));

  const usableByResource = new Map<SchedId, Interval[]>();
  for (const [id, rd] of day) usableByResource.set(id, usableIntervals(rd));

  const out: Candidate[] = [];
  const seenStarts = new Set<number>();
  for (let m = 0; m < 1440; m += step) {
    const startTime = atLocalMinutes(date, m, tz);
    if (seenStarts.has(startTime)) continue; // hora inexistente/duplicada colapsa no mesmo instante
    seenStarts.add(startTime);
    if (startTime < earliest || startTime > latest) continue;
    const c = {
      startTime,
      endTime: startTime + durationMin * MINUTE_MS,
      blockStart: startTime - service.bufferBeforeMin * MINUTE_MS,
      blockEnd: startTime + (durationMin + service.bufferAfterMin) * MINUTE_MS,
    };

    // Elegíveis por requisito neste início.
    const eligible: ResourceLite[][] = service.requirements.map((req) =>
      resources.filter((r) => {
        if (!requirementMatches(r, req)) return false;
        return resourceFits(day.get(r._id)!, usableByResource.get(r._id)!, req, c, basis);
      })
    );
    if (eligible.some((list) => list.length === 0)) continue;

    // Papel mais escasso primeiro (empate: ordem declarada); DFS com retrocesso.
    const order = service.requirements
      .map((_, i) => i)
      .sort((a, b) => eligible[a].length - eligible[b].length || a - b);
    const chosen: Array<ResourceLite | undefined> = service.requirements.map(() => undefined);
    const used = new Set<SchedId>();
    const plans: Candidate["plan"][] = [];
    const dfs = (depth: number): void => {
      if (plans.length >= maxPerStart) return;
      if (depth === order.length) {
        plans.push(
          service.requirements.map((req, i) => ({
            role: req.role,
            resourceId: chosen[i]!._id,
            units: unitsFor(req, chosen[i]!),
          }))
        );
        return;
      }
      const idx = order[depth];
      for (const r of eligible[idx]) {
        if (used.has(r._id)) continue;
        used.add(r._id);
        chosen[idx] = r;
        dfs(depth + 1);
        chosen[idx] = undefined;
        used.delete(r._id);
        if (plans.length >= maxPerStart) return;
      }
    };
    dfs(0);
    for (const plan of plans) out.push({ ...c, plan });
  }
  return out;
}
