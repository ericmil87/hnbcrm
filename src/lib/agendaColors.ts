/**
 * Agenda v2 (densa): cores dos blocos (PURO). Só tokens de tema (legíveis nos 4 temas). Três esquemas:
 * "status" (padrão: a situação do horário), "recurso" (uma cor por sala/profissional) e "servico" (uma cor por serviço).
 * As classes são literais completas para o Tailwind enxergá-las.
 */
import { statusMeta } from "./agendaStatus";
import { VOCAB } from "./vocab";
import type { GridAppointment } from "./agendaGrid";

export const COLOR_SCHEMES = ["status", "recurso", "servico"] as const;
export type ColorScheme = (typeof COLOR_SCHEMES)[number];

export interface Tone {
  /** Fundo suave + borda esquerda forte (classe do bloco). */
  block: string;
  /** Ponto colorido (linhas do mês, legenda). */
  dot: string;
}

const PALETTE: readonly Tone[] = [
  { block: "border-l-4 border-semantic-info bg-semantic-info/15", dot: "bg-semantic-info" },
  { block: "border-l-4 border-ai-500 bg-ai-500/15", dot: "bg-ai-500" },
  { block: "border-l-4 border-semantic-warning bg-semantic-warning/15", dot: "bg-semantic-warning" },
  { block: "border-l-4 border-brand-500 bg-brand-500/15", dot: "bg-brand-500" },
  { block: "border-l-4 border-semantic-success bg-semantic-success/15", dot: "bg-semantic-success" },
  { block: "border-l-4 border-semantic-error bg-semantic-error/15", dot: "bg-semantic-error" },
];

export const PALETTE_SIZE = PALETTE.length;

/** Cor de uma posição da lista (volta ao começo depois da última). */
export function toneAt(index: number): Tone {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/** Posição estável de `id` na lista ordenada (a da configuração); desconhecido = 0. */
export function toneIndexOf(orderedIds: readonly string[], id: string | undefined): number {
  if (!id) return 0;
  const i = orderedIds.indexOf(id);
  return i < 0 ? 0 : i;
}

const STATUS_DOT: Record<string, string> = {
  pending_approval: "bg-semantic-warning",
  scheduled: "bg-semantic-info",
  confirmed: "bg-semantic-success",
  checked_in: "bg-brand-500",
  completed: "bg-border-strong",
  no_show: "bg-semantic-error",
};

export interface ToneContext {
  scheme: ColorScheme;
  /** Ids de recursos e de serviços na ordem da configuração. */
  resourceOrder: readonly string[];
  serviceOrder: readonly string[];
}

/** Classe do bloco e ponto de um agendamento no esquema escolhido. Proposta (aguardando) fica sempre tracejada. */
export function appointmentTone(
  a: Pick<GridAppointment, "status" | "resources"> & { serviceId?: string },
  ctx: ToneContext
): Tone {
  const dashed = a.status === "pending_approval" ? " border-dashed" : "";
  if (ctx.scheme === "status") {
    return { block: statusMeta(a.status).blockClassName, dot: STATUS_DOT[a.status] ?? "bg-semantic-info" };
  }
  if (ctx.scheme === "servico") {
    const t = toneAt(toneIndexOf(ctx.serviceOrder, a.serviceId));
    return { block: t.block + dashed, dot: t.dot };
  }
  // Recurso: o primeiro alocado na ordem da configuração (o que aparece primeiro nos filtros).
  const ids = a.resources.filter((r) => r.allocated).map((r) => r.resourceId as string);
  const first = ids.sort((x, y) => toneIndexOf(ctx.resourceOrder, x) - toneIndexOf(ctx.resourceOrder, y))[0];
  const t = toneAt(toneIndexOf(ctx.resourceOrder, first));
  return { block: t.block + dashed, dot: t.dot };
}

/** Legenda das cores: o que cada cor quer dizer no esquema escolhido (itens na ordem da configuração). */
export function colorLegend(
  scheme: ColorScheme,
  resources: ReadonlyArray<{ _id: string; name: string }>,
  services: ReadonlyArray<{ _id: string; name: string }>
): Array<{ id: string; label: string; dot: string }> {
  if (scheme === "status") {
    return (["scheduled", "confirmed", "checked_in", "pending_approval", "completed"] as const).map((st) => ({
      id: st,
      label: VOCAB.scheduling.status[st],
      dot: STATUS_DOT[st],
    }));
  }
  const list = scheme === "recurso" ? resources : services;
  return list.map((x, i) => ({ id: x._id, label: x.name, dot: toneAt(i).dot }));
}
