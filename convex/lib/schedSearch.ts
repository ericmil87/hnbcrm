/**
 * Agenda v2 — busca de horários (A3a): candidatos → pontuação → modo inteligente → ofertas.
 * Roda dentro de uma QUERY (sem `Date.now()`: o relógio entra por `now`, arredondado ao minuto pelo
 * chamador) ou de uma mutation. Custo: o de `loadWindow` (schedRead.ts) + 1 leitura do serviço + 1
 * da lista de serviços (para a lacuna mínima útil) + 1 `loadWindow` extra só quando a janela pedida
 * veio vazia e é menor que 7 dias (para achar `firstPossible`).
 *
 * Privacidade: este módulo devolve TUDO (nomes, motivos, pontuação); quem expõe a audiências que não
 * são da equipe (`ai`, `public`) é o wrapper (`scheduling.findSlots`), que corta nomes e motivos.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { MAX_OFFERS, MAX_SEARCH_DAYS } from "./schedConstants";
import { computeDayAvailability, type ResourceDay } from "./schedAvailability";
import { type Candidate, generateCandidates, type ServiceLite } from "./schedCandidates";
import { isValidPartySize, MAX_PARTY_SIZE, MIN_PARTY_SIZE } from "./schedParty";
import { periodWindow } from "./schedRelativeDates";
import { applySmartMode, pickOffers, type ScoredCandidate, scoreCandidate, type SmartMode, type SmartWeights } from "./schedScore";
import { assertSearchWindow, blockCovered, loadWindow, type WindowData } from "./schedRead";
import { type Slot, toSlot } from "./schedViews";
import { addLocalDays, diffLocalDays, type LocalDate, minutesOfDay } from "./schedTime";

type ReadCtx = { db: QueryCtx["db"] };
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export type SlotAudience = "staff" | "ai" | "public";
export type SlotPeriod = "manha" | "tarde" | "noite" | "qualquer";

export type FoundSlot = Slot;

export type SearchSlotsArgs = {
  organizationId: Id<"organizations">;
  serviceId: Id<"schedServices">;
  variantKey?: string;
  fromLocalDate: LocalDate;
  toLocalDate?: LocalDate;
  period?: SlotPeriod;
  /** Restringe o plano: para cada requisito cujo tipo aparece aqui, só esses recursos servem. */
  resourceIds?: Id<"schedResources">[];
  /** Remarcação: as alocações deste agendamento não contam como ocupação. */
  ignoreAppointmentId?: Id<"schedAppointments">;
  audience: SlotAudience;
  now: number;
  /** Quantos horários devolver (default `MAX_OFFERS`; `ai`/`public` nunca passam de `MAX_OFFERS`). Até 50. */
  limit?: number;
  /**
   * Só a prévia da tela de regras (`previewSuggestions`, exige `manage`) liga isto: devolve nomes e motivos
   * mesmo numa audiência que não é a equipe. Qualquer outro chamador (tools da IA, link público) deixa
   * desligado: `searchSlots` SANITIZA por construção (`toSlot`).
   */
  reveal?: boolean;
  /** Pessoas no mesmo horário (1–4; ausente = 1): só horários em que o grupo todo cabe (`schedParty.ts`). */
  partySize?: number;
  /**
   * Hora do dia pedida (minutos desde 00:00). Só AJUDA a achar e ordenar (devolve `wanted`); nunca escolhe nem grava
   * horário: a oferta continua saindo de `slots`, e a escrita só aceita código de oferta.
   */
  wantTimeMin?: number;
  /** Prévia da tela de regras: sobrepõe a configuração salva. */
  override?: { mode?: SmartMode; weights?: SmartWeights; minOffer?: number };
};

export type SearchSlotsResult = {
  slots: FoundSlot[];
  /** Há mais horários distintos além dos devolvidos. */
  hasMore: boolean;
  relaxed: boolean;
  relaxedDays: string[];
  mode: SmartMode;
  /** Só quando `slots` veio vazio: o primeiro horário possível nos 7 dias a partir de `fromLocalDate`. */
  firstPossible: FoundSlot | undefined;
  /** Menor instante que a audiência pode marcar (antecedência mínima aplicada). */
  earliestBookableAt: number;
  /** Os primeiros horários em ordem cronológica (comparação "sem o modo inteligente"). */
  chronological: FoundSlot[];
  truncated: boolean;
  /** `unverifiable`: sem oferta porque um teto de leitura impediu de VERIFICAR (fail-closed), não porque está cheio. */
  reason: "ok" | "service_unavailable" | "no_matching_resource" | "unverifiable";
  /** Quantos horários distintos livres há na janela pedida (depois do modo inteligente), além dos `slots` devolvidos. */
  totalFree: number;
  /** Só com `wantTimeMin`: o horário pedido, se livre na janela (o mais cedo), e os mais próximos dele (até o limite). */
  wanted?: { timeMin: number; slot: FoundSlot | undefined; nearest: FoundSlot[] };
};

const EMPTY = (earliest: number, mode: SmartMode, reason: SearchSlotsResult["reason"]): SearchSlotsResult => ({
  slots: [],
  hasMore: false,
  relaxed: false,
  relaxedDays: [],
  mode,
  firstPossible: undefined,
  earliestBookableAt: earliest,
  chronological: [],
  truncated: false,
  reason,
  totalFree: 0,
});

const PERIOD_PREF = { manha: "morning", tarde: "afternoon", noite: "evening" } as const;

function datesBetween(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = from; diffLocalDays(d, to) >= 0; d = addLocalDays(d, 1)) out.push(d);
  return out;
}

/** Instante mínimo/máximo que a audiência pode marcar. Equipe: sem antecedência mínima (marca "agora"). */
export function bookableRange(
  audience: SlotAudience,
  now: number,
  service: Pick<Doc<"schedServices">, "minNoticeMin" | "maxAdvanceDays">,
  settings: { minNoticeMin: number; maxAdvanceDays: number }
): { earliest: number; latest: number } {
  const noticeMin = audience === "staff" ? 0 : (service.minNoticeMin ?? settings.minNoticeMin);
  const advanceDays = service.maxAdvanceDays ?? settings.maxAdvanceDays;
  return { earliest: now + noticeMin * MINUTE_MS, latest: now + advanceDays * DAY_MS };
}

/** Restringe os requisitos do serviço aos recursos escolhidos (por tipo). `null` = impossível. */
function restrictRequirements(
  service: Doc<"schedServices">,
  chosen: Doc<"schedResources">[]
): ServiceLite["requirements"] | null {
  const out: ServiceLite["requirements"] = [];
  for (const req of service.requirements) {
    const ofKind = chosen.filter((r) => r.kind === req.kind).map((r) => r._id);
    if (ofKind.length === 0) {
      out.push(req);
      continue;
    }
    const base = req.resourceIds && req.resourceIds.length > 0 ? req.resourceIds : null;
    const ids = base ? ofKind.filter((id) => base.includes(id)) : ofKind;
    if (ids.length === 0) return null;
    out.push({ ...req, resourceIds: ids });
  }
  return out;
}

type DayWork = { date: LocalDate; day: Map<string, ResourceDay>; scored: ScoredCandidate[] };
type ScoreOutcome = { days: DayWork[]; dropped: number; skippedDays: number };

/**
 * FAIL-CLOSED: dia cuja exceção não foi lida por inteiro não gera candidato; candidato cujo bloco sai do que
 * foi lido das alocações de QUALQUER recurso do plano é descartado. `dropped`/`skippedDays` alimentam `reason`.
 */
function scoreDays(
  data: WindowData,
  resources: WindowData["resources"],
  dates: LocalDate[],
  input: {
    service: ServiceLite;
    variantKey?: string;
    earliest: number;
    latest: number;
    period: SlotPeriod | undefined;
    resourceIds?: Id<"schedResources">[];
    ignoreAppointmentId?: Id<"schedAppointments">;
    weights: SmartWeights;
    minUsefulGapMin: number;
    partySize?: number;
  }
): ScoreOutcome {
  const win = input.period && input.period !== "qualquer" ? periodWindow(input.period) : null;
  const preference = {
    period: input.period && input.period !== "qualquer" ? PERIOD_PREF[input.period] : undefined,
    resourceIds: input.resourceIds,
  };
  const out: DayWork[] = [];
  let dropped = 0;
  let skippedDays = 0;
  for (const date of dates) {
    if (data.exceptionsCompleteBefore !== null && date >= data.exceptionsCompleteBefore) {
      skippedDays++;
      continue;
    }
    const day = computeDayAvailability({
      date,
      tz: data.tz,
      resources,
      exceptions: data.exceptions,
      allocations: data.allocations,
      internalEvents: data.internalEvents,
      ignoreAppointmentId: input.ignoreAppointmentId,
    });
    let cands: Candidate[] = generateCandidates({
      date,
      tz: data.tz,
      gridMinutes: data.settings.gridMinutes,
      service: input.service,
      variantKey: input.variantKey,
      day,
      earliest: input.earliest,
      latest: input.latest,
      preferredResourceIds: input.resourceIds,
      partySize: input.partySize,
    });
    if (win) {
      cands = cands.filter((c) => {
        const m = minutesOfDay(c.startTime, data.tz);
        return m >= win.startMin && m < win.endMin;
      });
    }
    const covered = cands.filter((c) => c.plan.every((p) => blockCovered(data, p.resourceId, c.blockStart, c.blockEnd)));
    dropped += cands.length - covered.length;
    const scored = covered.map((c) =>
      scoreCandidate(c, day, input.weights, { minUsefulGapMin: input.minUsefulGapMin, preference, tz: data.tz })
    );
    out.push({ date, day, scored });
  }
  return { days: out, dropped, skippedDays };
}

export async function searchSlots(ctx: ReadCtx, args: SearchSlotsArgs): Promise<SearchSlotsResult> {
  if (args.partySize !== undefined && !isValidPartySize(args.partySize)) {
    throw new ConvexError(`O número de pessoas deve ser de ${MIN_PARTY_SIZE} a ${MAX_PARTY_SIZE}.`);
  }
  const to = args.toLocalDate ?? args.fromLocalDate;
  assertSearchWindow(args.fromLocalDate, to);
  const limit = Math.max(1, Math.min(50, Math.trunc(args.limit ?? MAX_OFFERS)));
  const effLimit = args.audience === "staff" ? limit : Math.min(limit, MAX_OFFERS);

  const service = await ctx.db.get(args.serviceId);
  const serviceOk =
    service !== null &&
    service.organizationId === args.organizationId &&
    service.active &&
    (args.audience !== "ai" || service.aiBookable !== false) &&
    (args.audience !== "public" || service.publicBookable === true);
  if (!serviceOk) return EMPTY(args.now, "rank", "service_unavailable");
  if (args.variantKey !== undefined && !service.variants?.some((v) => v.key === args.variantKey)) {
    throw new ConvexError("Variação de serviço desconhecida.");
  }

  const data = await loadWindow(ctx, {
    organizationId: args.organizationId,
    fromLocalDate: args.fromLocalDate,
    toLocalDate: to,
  });
  const mode: SmartMode = args.override?.mode ?? service.smartMode ?? data.settings.smart.mode;
  // FAIL-CLOSED: recurso cujos compromissos internos não foram lidos por inteiro não é oferecido.
  const bad = new Set<string>(data.unverifiedResourceIds);
  const usable = data.resources.filter((r) => !bad.has(r._id));
  const { earliest, latest } = bookableRange(args.audience, args.now, service, data.settings);

  let requirements: ServiceLite["requirements"] = service.requirements;
  if (args.resourceIds && args.resourceIds.length > 0) {
    const wanted = new Set<string>(args.resourceIds);
    const chosen = usable.filter((r) => wanted.has(r._id));
    const restricted = chosen.length === 0 ? null : restrictRequirements(service, chosen);
    if (restricted === null) return EMPTY(earliest, mode, "no_matching_resource");
    requirements = restricted;
  }
  const lite: ServiceLite = {
    _id: service._id,
    name: service.name,
    durationMin: service.durationMin,
    variants: service.variants,
    bufferBeforeMin: service.bufferBeforeMin,
    bufferAfterMin: service.bufferAfterMin,
    requirements,
    slotIntervalMin: service.slotIntervalMin,
  };

  let minUsefulGapMin = data.settings.smart.minUsefulGapMin;
  if (minUsefulGapMin === undefined) {
    const services = await ctx.db
      .query("schedServices")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(101);
    const durations = services.filter((s) => s.active).map((s) => s.durationMin);
    minUsefulGapMin = durations.length > 0 ? Math.min(...durations) : service.durationMin;
  }
  const weights = args.override?.weights ?? data.settings.smart.weights;
  const minOffer = args.override?.minOffer ?? data.settings.smart.minOffer;
  const common = {
    service: lite,
    variantKey: args.variantKey,
    earliest,
    latest,
    // A hora pedida VENCE o período ("manhã" + 14:00 não pode dar 14h indisponível): com `wantTimeMin` o período não filtra.
    period: args.wantTimeMin !== undefined ? undefined : args.period,
    resourceIds: args.resourceIds,
    ignoreAppointmentId: args.ignoreAppointmentId,
    weights,
    minUsefulGapMin,
    partySize: args.partySize,
  };

  const resourceNames = new Map<string, string>(data.resources.map((r) => [r._id, r.name]));
  const reveal = args.audience === "staff" || args.reveal === true;
  const asSlot = (c: ScoredCandidate): FoundSlot => toSlot(c, { now: args.now, tz: data.tz, resourceNames, reveal });

  const first = scoreDays(data, usable, datesBetween(args.fromLocalDate, to), common);
  let unverifiable = first.dropped > 0 || first.skippedDays > 0 || usable.length < data.resources.length;
  const all = first.days.flatMap((d) => d.scored);
  // Com hora pedida a busca roda SEM período (a hora exata vence "manhã"), mas as ofertas e as alternativas mais próximas continuam dentro do
  // período pedido: "de manhã, às 14h" com 14h indisponível oferece manhãs, não a tarde inteira.
  const periodWin = args.wantTimeMin !== undefined && args.period && args.period !== "qualquer" ? periodWindow(args.period) : null;
  const inPeriod = (c: ScoredCandidate) => {
    if (!periodWin) return true;
    const m = minutesOfDay(c.startTime, data.tz);
    return m >= periodWin.startMin && m < periodWin.endMin;
  };
  const smart = applySmartMode(all.filter(inPeriod), mode, minOffer, args.audience, data.tz);
  const distinct = dedupeByStart(smart.list);
  const picked = effLimit <= MAX_OFFERS ? pickOffers(distinct, effLimit, data.tz) : distinct.slice(0, effLimit);
  const slots = picked.map(asSlot);
  let wanted: SearchSlotsResult["wanted"];
  if (args.wantTimeMin !== undefined) {
    const at = (c: ScoredCandidate) => minutesOfDay(c.startTime, data.tz);
    // O horário PEDIDO vale se está livre (candidato válido pelas regras), mesmo que o modo "restrict" o escondesse das ofertas
    // padrão: o modo orienta o que a IA propõe sozinha, não recusa quem pediu aquela hora; a reserva segue pelas mesmas regras da
    // porta e a equipe ainda aprova. As alternativas ("mais próximas") respeitam o modo.
    const exact = dedupeByStart(applySmartMode(all, "off", minOffer, args.audience, data.tz).list).filter((c) => at(c) === args.wantTimeMin)[0];
    const closest = [...distinct]
      .sort((a, b) => Math.abs(at(a) - args.wantTimeMin!) - Math.abs(at(b) - args.wantTimeMin!) || a.startTime - b.startTime)
      .slice(0, effLimit);
    wanted = { timeMin: args.wantTimeMin, slot: exact ? asSlot(exact) : undefined, nearest: closest.map(asSlot) };
  }
  const chronological = dedupeByStart(applySmartMode(all, "off", minOffer, args.audience, data.tz).list)
    .slice(0, MAX_OFFERS)
    .map(asSlot);

  let truncated = data.truncated;
  let firstPossible: FoundSlot | undefined;
  if (slots.length === 0) {
    const span = diffLocalDays(args.fromLocalDate, to) + 1;
    if (span < MAX_SEARCH_DAYS) {
      const extFrom = addLocalDays(to, 1);
      const extTo = addLocalDays(args.fromLocalDate, MAX_SEARCH_DAYS - 1);
      const ext = await loadWindow(ctx, { organizationId: args.organizationId, fromLocalDate: extFrom, toLocalDate: extTo });
      truncated = truncated || ext.truncated;
      const extBad = new Set<string>(ext.unverifiedResourceIds);
      const extUsable = ext.resources.filter((r) => !extBad.has(r._id));
      const extOut = scoreDays(ext, extUsable, datesBetween(extFrom, extTo), { ...common, period: undefined });
      unverifiable = unverifiable || extOut.dropped > 0 || extOut.skippedDays > 0 || extUsable.length < ext.resources.length;
      const firstExt = dedupeByStart(applySmartMode(extOut.days.flatMap((d) => d.scored), "off", minOffer, args.audience, ext.tz).list)[0];
      if (firstExt) firstPossible = asSlot(firstExt);
    }
  }

  return {
    slots,
    hasMore: distinct.length > slots.length,
    relaxed: smart.relaxed,
    relaxedDays: smart.relaxedDays,
    mode,
    firstPossible,
    earliestBookableAt: earliest,
    chronological,
    truncated,
    reason: slots.length === 0 && unverifiable ? "unverifiable" : "ok",
    // a hora pedida e livre conta mesmo quando o modo `restrict` a escondeu das ofertas padrão
    totalFree: distinct.length + (wanted?.slot && !distinct.some((c) => c.startTime === wanted!.slot!.startTime) ? 1 : 0),
    ...(wanted ? { wanted } : {}),
  };
}

function dedupeByStart(list: ScoredCandidate[]): ScoredCandidate[] {
  const seen = new Set<number>();
  const out: ScoredCandidate[] = [];
  for (const c of list) {
    if (seen.has(c.startTime)) continue;
    seen.add(c.startTime);
    out.push(c);
  }
  return out;
}
