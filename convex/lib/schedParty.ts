/**
 * Agenda v2 (A3d) — regra de GRUPO (várias pessoas no mesmo horário, p.ex. casal na sala dupla). PURO.
 *
 * É a regra ÚNICA de "quanto cada pessoa pede de cada requisito do serviço", usada pela BUSCA
 * (`schedCandidates.generateCandidates` com `partySize`) e pela PORTA (`schedBookingOps.bookPartyCore`):
 *
 *  - PESSOA (`kind: "person"`): UM profissional por pessoa. N pessoas = N profissionais DISTINTOS, cada um com
 *    as unidades do requisito livres no horário.
 *  - SALA e EQUIPAMENTO: UM MESMO recurso comporta todas as pessoas ao mesmo tempo: capacidade − ocupação
 *    ≥ unidades × N. `exclusive` (capacidade inteira) nunca comporta mais de uma pessoa.
 *
 * Na porta, `bookPartyCore` aloca uma pessoa por vez pela checagem de capacidade de sempre; o que esta regra
 * decide lá é ONDE o acompanhante tenta primeiro (a mesma sala/equipamento da pessoa principal: `sharedResourceIds`).
 * Se esse recurso não couber, o fallback de sempre ainda procura outro plano (a busca é mais estrita do que a porta,
 * nunca mais frouxa: todo horário oferecido para N pessoas é marcável).
 */

export const MIN_PARTY_SIZE = 1;
export const MAX_PARTY_SIZE = 4;
/** Acompanhantes além da pessoa principal. */
export const MAX_PARTY_COMPANIONS = MAX_PARTY_SIZE - 1;
/** Teto de passos do pareamento de profissionais (fail-closed: estourou = o horário não é oferecido). */
const MATCH_STEP_CAP = 5_000;

export type PartyKind = "person" | "room" | "equipment";
export type PartyRequirement = { kind: PartyKind; units?: number; exclusive?: boolean };

/** Tamanho do grupo válido (inteiro de 1 a 4). */
export function isValidPartySize(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= MIN_PARTY_SIZE && n <= MAX_PARTY_SIZE;
}

/** Quanto UM requisito pede de UM recurso para `partySize` pessoas, e de quantos recursos distintos. */
export function partyDemand(
  req: PartyRequirement,
  capacity: number,
  partySize: number
): { unitsOnResource: number; distinctResources: number } {
  const perPerson = req.exclusive ? capacity : (req.units ?? 1);
  if (req.kind === "person") return { unitsOnResource: perPerson, distinctResources: partySize };
  return { unitsOnResource: perPerson * partySize, distinctResources: 1 };
}

/** O requisito é atendido por UM recurso compartilhado entre todas as pessoas (sala, equipamento)? */
export function isSharedRequirement(req: Pick<PartyRequirement, "kind">): boolean {
  return req.kind !== "person";
}

/** Recursos que a pessoa principal ocupa e que os acompanhantes tentam PRIMEIRO (sala e equipamento). */
export function sharedResourceIds(
  items: ReadonlyArray<{ req: Pick<PartyRequirement, "kind">; resourceId: string }>
): string[] {
  return items.filter((i) => isSharedRequirement(i.req)).map((i) => i.resourceId);
}

/**
 * Cada requisito de pessoa (um grupo de profissionais elegíveis) precisa de `partySize` profissionais, e o
 * mesmo profissional não serve a dois lugares. Pareamento por retrocesso (grupos pequenos); estourar o teto de
 * passos devolve `false` (fail-closed).
 */
export function canStaffParty(eligibleByRequirement: ReadonlyArray<ReadonlyArray<string>>, partySize: number): boolean {
  const groups = eligibleByRequirement;
  if (groups.some((g) => g.length < partySize)) return false;
  const total = new Set(groups.flat()).size;
  if (total < groups.length * partySize) return false;
  // Grupos mais escassos primeiro; cada grupo escolhe `partySize` profissionais livres (combinação).
  const order = [...groups].sort((a, b) => a.length - b.length);
  let steps = 0;
  const used = new Set<string>();
  const place = (gi: number): boolean => {
    if (gi === order.length) return true;
    const pool = order[gi];
    const pick = (from: number, count: number): boolean => {
      if (count === partySize) return place(gi + 1);
      for (let i = from; i < pool.length; i++) {
        if (++steps > MATCH_STEP_CAP) return false;
        if (used.has(pool[i])) continue;
        used.add(pool[i]);
        if (pick(i + 1, count + 1)) return true;
        used.delete(pool[i]);
      }
      return false;
    };
    return pick(0, 0);
  };
  return place(0);
}
