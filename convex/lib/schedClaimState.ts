/**
 * Agenda v2 (D2) — monta o `ClaimState` do `schedClaimGuard` a partir do que o atendente sabe no turno. PURO.
 *
 * Uma só montagem para a produção e o simulador (a regra do guard não pode divergir entre os dois). O que entra além de
 * E/R/O (agendamentos do contato, reserva da rodada, ofertas): se um repasse foi criado, as horas fixas do CONHECIMENTO da
 * org e os nomes dos recursos (para barrar "terça às 14h com o Léo" quando a oferta não nomeou o Léo).
 */
import { type ClaimState, knownTime, resourceKey } from "./schedClaimGuard";
import type { SchedCurrentOffer, SchedDecided, SchedUpcoming } from "./schedAttendantTools";
import { extractAiTimes } from "./schedTimeText";

/** Hora do dia (minutos) de cada horário que o CONHECIMENTO cita (turmas, funcionamento). Faixas ("das 8 às 18h") não entram. */
export function knowledgeTimesOf(knowledge: string | null | undefined): number[] {
  if (!knowledge) return [];
  return [...new Set(extractAiTimes(knowledge.slice(0, 30_000)).map((m) => m.timeMin))].slice(0, 200);
}

export type ClaimTurnState = {
  booked: ReadonlyArray<{ startTime: number; status: "pending" | "scheduled" }>;
  offered: ReadonlyArray<number>;
  /** Horários que o servidor NOMEOU nesta rodada de tools (profissional pedido e honrado). */
  named: ReadonlyArray<{ startTime: number; professional: string }>;
};

export function buildClaimState(input: {
  now: number;
  tz: string;
  upcoming: readonly SchedUpcoming[];
  /** Decisões recentes (recusado, vencido, cancelado): horário conhecido que NÃO está marcado. */
  decided?: readonly SchedDecided[];
  offers: readonly SchedCurrentOffer[];
  turn: ClaimTurnState;
  serviceNames: readonly string[];
  guardNames: readonly string[];
  knowledgeTimes: readonly number[];
  handoff: boolean;
}): ClaimState {
  const { tz } = input;
  // Nome ligado a um horário: o das ofertas vigentes e o das desta rodada (a reserva herda o nome da oferta).
  const namedAt = new Map<number, string[]>();
  const addNamed = (startTime: number, professional: string | undefined) => {
    if (!professional) return;
    const list = namedAt.get(startTime) ?? [];
    list.push(resourceKey(professional));
    namedAt.set(startTime, list);
  };
  for (const o of input.offers) addNamed(o.startTime, o.professional);
  for (const n of input.turn.named) addNamed(n.startTime, n.professional);
  const withNames = (startTime: number) => {
    const resources = namedAt.get(startTime);
    return { ...knownTime(startTime, tz), ...(resources ? { resources } : {}) };
  };
  return {
    now: input.now,
    tz,
    existing: input.upcoming.map((u) => ({
      ...knownTime(u.startTime, tz),
      ...(u.resourceNames && u.resourceNames.length > 0 ? { resources: u.resourceNames.map(resourceKey) } : {}),
      status: u.status === "pending_approval" ? ("pending" as const) : ("scheduled" as const),
    })),
    booked: input.turn.booked.map((b) => ({ ...withNames(b.startTime), status: b.status })),
    offered: [...input.offers.map((o) => o.startTime), ...input.turn.offered].map(withNames),
    serviceNames: [...input.serviceNames],
    resourceNames: [...input.guardNames],
    ...((input.decided?.length ?? 0) > 0 ? { decided: input.decided!.map((d) => ({ ...knownTime(d.startTime, tz), kind: d.kind })) } : {}),
    ...(input.handoff ? { handoff: true } : {}),
    ...(input.knowledgeTimes.length > 0 ? { knowledgeTimes: [...input.knowledgeTimes] } : {}),
  };
}
