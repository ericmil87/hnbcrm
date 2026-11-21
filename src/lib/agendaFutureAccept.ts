/**
 * Agenda v2 (B1): fluxo de ACEITE quando uma mudança de configuração afeta agendamentos futuros. PURO.
 *
 * O servidor não bloqueia nem cancela nada: sem `acceptFuture` ele devolve a contagem e não grava
 * (`upsertResource` -> `saved:false`; `archiveResource`/`archiveService` -> `changed:false` com
 * `futureAppointments > 0`). A tela mostra o aviso, o dono aceita e a MESMA chamada segue com
 * `acceptFuture: true`.
 */

export type FutureAccept =
  | { type: "resourceEdit"; name: string; futureOutsideHours: number; overCapacityBy: number; capped: boolean }
  | { type: "resourceArchive"; name: string; futureAppointments: number; servicesAffected: string[] }
  | { type: "serviceArchive"; name: string; futureAppointments: number; capped: boolean };

export interface FutureAcceptCopy {
  title: string;
  lines: string[];
  confirm: string;
}

const horarios = (n: number, capped: boolean) => `${capped ? "pelo menos " : ""}${n} ${n === 1 ? "horário marcado" : "horários marcados"}`;

export function futureAcceptCopy(a: FutureAccept): FutureAcceptCopy {
  const nothingCancelled = "Nada é cancelado: os horários marcados continuam e você ajusta cada um na Agenda.";
  if (a.type === "resourceEdit") {
    const lines: string[] = [];
    if (a.futureOutsideHours > 0) {
      lines.push(`${horarios(a.futureOutsideHours, a.capped)} ficam fora do novo horário de ${a.name}.`);
    }
    if (a.overCapacityBy > 0) {
      lines.push(
        `Em algum momento já há ${a.overCapacityBy} ${a.overCapacityBy === 1 ? "pessoa" : "pessoas"} a mais do que ${a.name} comporta com a nova capacidade.`
      );
    }
    lines.push(nothingCancelled);
    return { title: "Isto afeta horários já marcados", lines, confirm: "Salvar mesmo assim" };
  }
  if (a.type === "resourceArchive") {
    const lines = [
      `${a.name} tem ${horarios(a.futureAppointments, false)}. Eles continuam, mas ninguém novo poderá marcar nesse lugar.`,
    ];
    if (a.servicesAffected.length > 0) {
      lines.push(`Só funcionam com ${a.name} e deixam de poder ser marcados: ${a.servicesAffected.join(", ")}.`);
    }
    lines.push(nothingCancelled);
    return { title: `Arquivar ${a.name}?`, lines, confirm: "Arquivar mesmo assim" };
  }
  return {
    title: `Arquivar ${a.name}?`,
    lines: [
      `Há ${horarios(a.futureAppointments, a.capped)} deste serviço. Eles continuam, mas ninguém novo poderá marcá-lo.`,
      nothingCancelled,
    ],
    confirm: "Arquivar mesmo assim",
  };
}

/** Mensagens de `upsertResource` que pedem aceite. */
export function resourceEditAccept(
  name: string,
  r: { saved: boolean; futureOutsideHours: number; overCapacityBy: number; capped: boolean }
): FutureAccept | null {
  if (r.saved) return null;
  return { type: "resourceEdit", name, futureOutsideHours: r.futureOutsideHours, overCapacityBy: r.overCapacityBy, capped: r.capped };
}

export function resourceArchiveAccept(
  name: string,
  r: { changed: boolean; futureAppointments: number; servicesAffected: string[] }
): FutureAccept | null {
  if (r.changed || r.futureAppointments <= 0) return null;
  return { type: "resourceArchive", name, futureAppointments: r.futureAppointments, servicesAffected: r.servicesAffected };
}

export function serviceArchiveAccept(
  name: string,
  r: { changed: boolean; futureAppointments: number; futureAppointmentsCapped: boolean }
): FutureAccept | null {
  if (r.changed || r.futureAppointments <= 0) return null;
  return { type: "serviceArchive", name, futureAppointments: r.futureAppointments, capped: r.futureAppointmentsCapped };
}

/**
 * Executa a chamada; se o servidor pedir aceite, pergunta (`ask`) e repete com `acceptFuture: true`.
 * Recusar o aviso encerra sem gravar. Só uma repetição: o aceite vale para esta chamada.
 */
export async function runWithFutureAccept<T>(
  run: (acceptFuture: boolean) => Promise<T>,
  needsAccept: (result: T) => FutureAccept | null,
  ask: (info: FutureAccept) => Promise<boolean>
): Promise<{ done: true; result: T } | { done: false }> {
  const first = await run(false);
  const info = needsAccept(first);
  if (!info) return { done: true, result: first };
  if (!(await ask(info))) return { done: false };
  return { done: true, result: await run(true) };
}
