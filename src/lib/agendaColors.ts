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
  /** Fundo tingido + borda esquerda forte (classe do bloco). */
  block: string;
  /** Ponto colorido (linhas do mês, legenda). */
  dot: string;
  /** Proposta aguardando aprovação: hachurado por cima da tinta mais clara. */
  hatch?: boolean;
}

/** Hachura das propostas (tokens: o amarelo de aviso). */
export const PENDING_HATCH =
  "repeating-linear-gradient(135deg, rgb(var(--rgb-semantic-warning) / 0.2) 0 2px, transparent 2px 8px)";

// 10 tons (`--rgb-cal-1..10`, um conjunto por tema). Classes literais para o Tailwind enxergá-las.
const PALETTE: readonly Tone[] = [
  { block: "border-l-4 border-cal-1 bg-cal-1/25", dot: "bg-cal-1" },
  { block: "border-l-4 border-cal-2 bg-cal-2/25", dot: "bg-cal-2" },
  { block: "border-l-4 border-cal-3 bg-cal-3/25", dot: "bg-cal-3" },
  { block: "border-l-4 border-cal-4 bg-cal-4/25", dot: "bg-cal-4" },
  { block: "border-l-4 border-cal-5 bg-cal-5/25", dot: "bg-cal-5" },
  { block: "border-l-4 border-cal-6 bg-cal-6/25", dot: "bg-cal-6" },
  { block: "border-l-4 border-cal-7 bg-cal-7/25", dot: "bg-cal-7" },
  { block: "border-l-4 border-cal-8 bg-cal-8/25", dot: "bg-cal-8" },
  { block: "border-l-4 border-cal-9 bg-cal-9/25", dot: "bg-cal-9" },
  { block: "border-l-4 border-cal-10 bg-cal-10/25", dot: "bg-cal-10" },
];

/** Sem recurso alocado ou serviço fora da configuração: tom neutro (nunca a cor de outro item). */
export const NEUTRAL_TONE: Tone = { block: "border-l-4 border-border-strong bg-surface-overlay", dot: "bg-border-strong" };

/** Cor por situação (esquema padrão): fundo tingido e borda esquerda forte, também nos 4 temas. */
const STATUS_BLOCK: Record<string, string> = {
  pending_approval: "border-l-4 border-dashed border-semantic-warning bg-semantic-warning/10",
  scheduled: "border-l-4 border-semantic-info bg-semantic-info/25",
  confirmed: "border-l-4 border-semantic-success bg-semantic-success/25",
  checked_in: "border-l-4 border-brand-500 bg-brand-500/25",
  completed: "border-l-4 border-border-strong bg-surface-overlay",
  no_show: "border-l-4 border-semantic-error bg-semantic-error/25",
};

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

const neutral = (pending: boolean): Tone => ({ ...NEUTRAL_TONE, block: NEUTRAL_TONE.block + (pending ? " border-dashed" : ""), hatch: pending });

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
  const pending = a.status === "pending_approval";
  // Proposta: tinta mais clara, borda tracejada e hachurado.
  const tint = (block: string) => (pending ? block.replace("/25", "/10") + " border-dashed" : block);
  if (ctx.scheme === "status") {
    return { block: STATUS_BLOCK[a.status] ?? statusMeta(a.status).blockClassName, dot: STATUS_DOT[a.status] ?? "bg-semantic-info", hatch: pending };
  }
  if (ctx.scheme === "servico") {
    if (!a.serviceId || !ctx.serviceOrder.includes(a.serviceId)) return neutral(pending);
    const t = toneAt(toneIndexOf(ctx.serviceOrder, a.serviceId));
    return { block: tint(t.block), dot: t.dot, hatch: pending };
  }
  // Recurso: o primeiro alocado na ordem da configuração (o que aparece primeiro nos filtros).
  const ids = a.resources.filter((r) => r.allocated && ctx.resourceOrder.includes(r.resourceId as string)).map((r) => r.resourceId as string);
  if (ids.length === 0) return neutral(pending);
  const first = ids.sort((x, y) => toneIndexOf(ctx.resourceOrder, x) - toneIndexOf(ctx.resourceOrder, y))[0];
  const t = toneAt(toneIndexOf(ctx.resourceOrder, first));
  return { block: tint(t.block), dot: t.dot, hatch: pending };
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
