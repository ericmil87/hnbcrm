/**
 * Agenda v2 (densa): texto dos blocos da grade (PURO). O que cabe num bloco depende da ALTURA em px, na ordem de
 * prioridade do Google Agenda: cliente (negrito), horário, serviço, lugar. Bloco curto (até 30 min na escala padrão)
 * vira uma linha só "11:00 Cliente · Serviço". Tudo no fuso da org.
 */
import { appointmentLabel, type GridAppointment } from "./agendaGrid";
import { minutesLabel, zonedMinutes } from "./agendaZone";
import { statusMeta } from "./agendaStatus";

export type BlockRow = "title" | "time" | "service" | "place";

export interface BlockPlan {
  /** Uma linha só ("11:00 Cliente · Serviço"). */
  compact: boolean;
  /** Linhas empilhadas, em ordem de prioridade (vazio quando `compact`). */
  rows: BlockRow[];
}

const ROW_PX = 15;
const PAD_PX = 6;
/** Abaixo disto (30 min a 56 px/h = 28 px) o bloco só comporta uma linha. */
export const COMPACT_MAX_PX = 34;
const ROW_ORDER: readonly BlockRow[] = ["title", "time", "service", "place"];

/** Quais linhas cabem num bloco de `heightPx` (altura já descontada a folga entre blocos). */
export function planBlock(heightPx: number): BlockPlan {
  const h = Number.isFinite(heightPx) ? heightPx : 0;
  const fit = Math.floor((h - PAD_PX) / ROW_PX);
  if (h < COMPACT_MAX_PX || fit < 2) return { compact: true, rows: [] };
  return { compact: false, rows: ROW_ORDER.slice(0, Math.min(fit, ROW_ORDER.length)) };
}

/** "11:00 – 11:50" (travessão, como no Google). */
export function timeRangeLabel(startMs: number, endMs: number, tz: string): string {
  const s = zonedMinutes(startMs, tz);
  const e = zonedMinutes(Math.max(endMs, startMs), tz);
  return `${minutesLabel(s)} – ${minutesLabel(e)}`;
}

/** Nomes dos recursos alocados, sem o da coluna ("Sala 1, Dra. Ana" -> o que a coluna não diz). */
export function placeText(a: Pick<GridAppointment, "resources">, exceptResourceId?: string | null): string {
  return a.resources
    .filter((r) => r.allocated && r.resourceId !== exceptResourceId)
    .map((r) => r.name)
    .join(", ");
}

export type StatusFlag = "pending" | "expired" | "confirmed" | "checked_in" | "done" | "no_show" | "ai" | "conflict";

/** Ícones pequenos de estado do bloco: situação, origem IA e conflito. Ordem estável. */
export function statusFlags(a: Pick<GridAppointment, "status" | "origin" | "resources">, expired: boolean): StatusFlag[] {
  const out: StatusFlag[] = [];
  if (expired) out.push("expired");
  else if (a.status === "pending_approval") out.push("pending");
  else if (a.status === "confirmed") out.push("confirmed");
  else if (a.status === "checked_in") out.push("checked_in");
  else if (a.status === "completed") out.push("done");
  else if (a.status === "no_show") out.push("no_show");
  if (a.origin === "ai" || a.origin === "waitlist") out.push("ai");
  if (a.resources.some((r) => !r.allocated)) out.push("conflict");
  return out;
}

/** Linha única dos blocos curtos e do mês: "11:00 Cliente · Serviço" (sem o serviço quando `service` é vazio). */
export function compactText(startMin: number, title: string, service?: string): string {
  return `${minutesLabel(startMin)} ${title}${service ? ` · ${service}` : ""}`;
}

/** Texto completo do `title`/tooltip nativo e do leitor de tela. */
export function appointmentTooltip(a: GridAppointment, tz: string, expired: boolean, expiredLabel: string): string {
  const range = timeRangeLabel(a.startTime, a.endTime, tz);
  const status = expired ? expiredLabel : statusMeta(a.status).label;
  return [appointmentLabel(a), range, a.serviceName, placeText(a), status].filter(Boolean).join(" · ");
}

export interface QuickStatusAction {
  to: "confirmed" | "checked_in";
}

/** Ação rápida do cartão do passar do mouse: Marcado -> Confirmar, Confirmado -> Chegou; o resto abre o painel. */
export function quickStatusAction(status: string, expired: boolean): QuickStatusAction | null {
  if (expired) return null;
  if (status === "scheduled") return { to: "confirmed" };
  if (status === "confirmed") return { to: "checked_in" };
  return null;
}
