import { STAGE_COLORS } from "@/lib/onboardingTemplates";
import type { FunctionArgs } from "convex/server";
import type { api } from "../../convex/_generated/api";
import type { FieldSeed, SegmentTemplate } from "../../convex/lib/onboardingTemplates";

// Regras puras do editor de funil (passo "Seu funil" da configuração inicial e
// painel de Configurações). Mesmas regras de `applyFunnelTemplate`: primeira
// etapa aberta, no máximo uma ganha e uma perdida, 2 a 12 etapas.

export interface FunnelStageDraft {
  /** Identidade estável só no cliente (chave do React); não vai ao servidor. */
  key: string;
  name: string;
  color: string;
  isClosedWon?: boolean;
  isClosedLost?: boolean;
}

export interface FunnelValue {
  boardName: string;
  boardColor?: string;
  stages: FunnelStageDraft[];
}

export const FUNNEL_MIN_STAGES = 2;
export const FUNNEL_MAX_STAGES = 12;
export const FUNNEL_NAME_MAX = 60;

// Prefixo aleatório por sessão: chaves de um rascunho restaurado não colidem com as novas.
const SESSION_PREFIX =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
let keySeq = 0;
export function newStageKey(): string {
  keySeq += 1;
  return `stage-${SESSION_PREFIX}-${keySeq}`;
}

const isClosed = (s: { isClosedWon?: boolean; isClosedLost?: boolean }) =>
  s.isClosedWon === true || s.isClosedLost === true;

export function renameStage(value: FunnelValue, key: string, name: string): FunnelValue {
  return { ...value, stages: value.stages.map((s) => (s.key === key ? { ...s, name } : s)) };
}

export function setBoardName(value: FunnelValue, boardName: string): FunnelValue {
  return { ...value, boardName };
}

export function cycleStageColor(value: FunnelValue, key: string): FunnelValue {
  return {
    ...value,
    stages: value.stages.map((s) => {
      if (s.key !== key) return s;
      const next = (STAGE_COLORS.indexOf(s.color) + 1) % STAGE_COLORS.length;
      return { ...s, color: STAGE_COLORS[next] };
    }),
  };
}

/** Pode subir/descer? A primeira etapa nunca pode ser fechada. */
export function canMoveStage(value: FunnelValue, key: string, direction: -1 | 1): boolean {
  const from = value.stages.findIndex((s) => s.key === key);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= value.stages.length) return false;
  const swapped = [...value.stages];
  [swapped[from], swapped[to]] = [swapped[to], swapped[from]];
  return !isClosed(swapped[0]);
}

export function moveStage(value: FunnelValue, key: string, direction: -1 | 1): FunnelValue {
  if (!canMoveStage(value, key, direction)) return value;
  const from = value.stages.findIndex((s) => s.key === key);
  const stages = [...value.stages];
  [stages[from], stages[from + direction]] = [stages[from + direction], stages[from]];
  return { ...value, stages };
}

export function canAddStage(value: FunnelValue, max = FUNNEL_MAX_STAGES): boolean {
  return value.stages.length < max;
}

/** Nova etapa aberta, antes da primeira etapa fechada (ou no fim). */
export function addStage(
  value: FunnelValue,
  max = FUNNEL_MAX_STAGES,
  key: string = newStageKey(),
): FunnelValue {
  if (!canAddStage(value, max)) return value;
  const firstClosed = value.stages.findIndex(isClosed);
  const at = firstClosed === -1 ? value.stages.length : firstClosed;
  const stages = [...value.stages];
  stages.splice(at, 0, {
    key,
    name: "Nova etapa",
    color: STAGE_COLORS[value.stages.length % STAGE_COLORS.length],
  });
  return { ...value, stages };
}

/** Não remove abaixo do mínimo nem a última etapa aberta. */
export function canRemoveStage(value: FunnelValue, key: string, min = FUNNEL_MIN_STAGES): boolean {
  const stage = value.stages.find((s) => s.key === key);
  if (!stage || value.stages.length <= min) return false;
  if (!isClosed(stage) && value.stages.filter((s) => !isClosed(s)).length <= 1) return false;
  // Remover a primeira aberta deixaria uma fechada na frente.
  const rest = value.stages.filter((s) => s.key !== key);
  return rest.length > 0 && !isClosed(rest[0]);
}

export function removeStage(value: FunnelValue, key: string, min = FUNNEL_MIN_STAGES): FunnelValue {
  if (!canRemoveStage(value, key, min)) return value;
  return { ...value, stages: value.stages.filter((s) => s.key !== key) };
}

/** Funil sugerido do segmento, com chaves novas. */
export function fromTemplate(template: SegmentTemplate): FunnelValue {
  return {
    boardName: template.funnel.boardName,
    boardColor: template.funnel.boardColor,
    stages: template.funnel.stages.map((s) => ({
      key: newStageKey(),
      name: s.name,
      color: s.color,
      ...(s.isClosedWon ? { isClosedWon: true } : {}),
      ...(s.isClosedLost ? { isClosedLost: true } : {}),
    })),
  };
}

/** Funil já salvo (quadro + etapas), com chaves novas; etapas na ordem de `order`. */
export function fromBoard(
  board: { name: string; color?: string },
  stages: ReadonlyArray<{ name: string; color: string; order: number; isClosedWon?: boolean; isClosedLost?: boolean }>,
): FunnelValue {
  return {
    boardName: board.name,
    ...(board.color ? { boardColor: board.color } : {}),
    stages: [...stages]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({
        key: newStageKey(),
        name: s.name,
        color: s.color,
        ...(s.isClosedWon ? { isClosedWon: true } : {}),
        ...(s.isClosedLost ? { isClosedLost: true } : {}),
      })),
  };
}

/** Mesmo funil (nome, cor e etapas), ignorando as chaves do cliente. */
export function sameFunnel(a: FunnelValue, b: FunnelValue): boolean {
  const norm = (v: FunnelValue) =>
    JSON.stringify([
      v.boardName.trim(),
      v.boardColor ?? null,
      v.stages.map((s) => [s.name.trim(), s.color, !!s.isClosedWon, !!s.isClosedLost]),
    ]);
  return norm(a) === norm(b);
}

export interface FunnelErrors {
  boardName?: string;
  /** Erros por chave de etapa. */
  stages: Record<string, string>;
  /** Erros do funil como um todo. */
  form?: string;
}

export function validateFunnel(
  value: FunnelValue,
  { min = FUNNEL_MIN_STAGES, max = FUNNEL_MAX_STAGES }: { min?: number; max?: number } = {},
): { ok: boolean; errors: FunnelErrors } {
  const errors: FunnelErrors = { stages: {} };
  const boardName = value.boardName.trim();
  if (boardName.length < 1) errors.boardName = "Dê um nome ao funil";
  else if (boardName.length > FUNNEL_NAME_MAX) errors.boardName = "O nome do funil aceita até 60 caracteres";

  for (const s of value.stages) {
    const name = s.name.trim();
    if (name.length < 1) errors.stages[s.key] = "Dê um nome à etapa";
    else if (name.length > FUNNEL_NAME_MAX) errors.stages[s.key] = "O nome da etapa aceita até 60 caracteres";
    else if (s.isClosedWon && s.isClosedLost) errors.stages[s.key] = "Uma etapa não pode ser ganha e perdida ao mesmo tempo";
  }

  if (value.stages.length < min) errors.form = `O funil precisa de pelo menos ${min} etapas`;
  else if (value.stages.length > max) errors.form = `O funil aceita no máximo ${max} etapas`;
  else if (value.stages[0] && isClosed(value.stages[0])) errors.form = "A primeira etapa precisa ser uma etapa aberta";
  else if (
    value.stages.filter((s) => s.isClosedWon).length > 1 ||
    value.stages.filter((s) => s.isClosedLost).length > 1
  ) {
    errors.form = "O funil aceita no máximo uma etapa ganha e uma perdida";
  }

  const ok = !errors.boardName && !errors.form && Object.keys(errors.stages).length === 0;
  return { ok, errors };
}

/** Shape de `api.onboarding.applyFunnelTemplate` (sem `organizationId`). */
export interface ApplyFunnelTemplateArgs {
  boardName: string;
  boardColor?: string;
  stages: Array<{ name: string; color: string; isClosedWon?: boolean; isClosedLost?: boolean }>;
  fields?: Array<{
    key: string;
    name: string;
    type: "text" | "number" | "boolean" | "date" | "select" | "multiselect";
    options?: string[];
  }>;
}

export function toApplyFunnelTemplateArgs(value: FunnelValue, fields?: FieldSeed[]): ApplyFunnelTemplateArgs {
  const args = {
    boardName: value.boardName.trim(),
    ...(value.boardColor ? { boardColor: value.boardColor } : {}),
    stages: value.stages.map((s) => ({
      name: s.name.trim(),
      color: s.color,
      ...(s.isClosedWon ? { isClosedWon: true } : {}),
      ...(s.isClosedLost ? { isClosedLost: true } : {}),
    })),
    ...(fields && fields.length > 0
      ? {
          fields: fields.map((f) => ({
            key: f.key,
            name: f.label,
            type: f.type,
            ...(f.options ? { options: f.options } : {}),
          })),
        }
      : {}),
  } satisfies Omit<FunctionArgs<typeof api.onboarding.applyFunnelTemplate>, "organizationId">;
  return args;
}
