/**
 * Estado do wizard de publicação. O rascunho vive achatado (um campo por
 * controle) e só vira `schedule`/`content` na hora de salvar — biblioteca e IA
 * ficam LADO A LADO no rascunho para que alternar o tipo de conteúdo não jogue
 * fora o que já foi escrito no outro.
 */
import type { Id } from "../../../../convex/_generated/dataModel";
import type {
  GroupPostAi,
  GroupPostContent,
  GroupPostDetailDoc,
  GroupPostLibrary,
  GroupPostSchedule,
} from "./types";
import { dateInputToEpoch, dateInputValue } from "./postUtils";

export const WIZARD_STEPS = ["targets", "schedule", "content"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const WIZARD_STEP_LABELS: Record<WizardStep, string> = {
  targets: "Destinos",
  schedule: "Agenda",
  content: "Conteúdo",
};

export interface PostDraft {
  name: string;
  groupChatIds: Id<"groupChats">[];
  // Agenda
  timezone: string;
  times: string[];
  days: number[];
  /** "YYYY-MM-DD" no fuso da agenda, "" = sem limite. */
  startDate: string;
  endDate: string;
  jitterMinutes: number;
  // Conteúdo
  kind: "library" | "ai";
  library: GroupPostLibrary;
  ai: GroupPostAi;
}

export const DEFAULT_AI: GroupPostAi = {
  prompt: "",
  persona: "attendant",
  customPersona: "",
  useKnowledge: true,
  generateMinutesBefore: 60,
  requiresApproval: true,
  onMissedApproval: "skip",
};

export function emptyDraft(timezone: string): PostDraft {
  return {
    name: "",
    groupChatIds: [],
    timezone,
    times: ["09:00"],
    days: [1, 2, 3, 4, 5],
    startDate: "",
    endDate: "",
    jitterMinutes: 0,
    kind: "library",
    library: { items: [{ text: "" }], order: "sequential" },
    ai: { ...DEFAULT_AI },
  };
}

export function draftFromPost(post: GroupPostDetailDoc): PostDraft {
  const tz = post.schedule.timezone;
  return {
    name: post.name,
    groupChatIds: post.targets.map((t) => t.groupChatId),
    timezone: tz,
    times: [...post.schedule.times],
    days: [...post.schedule.days],
    startDate: dateInputValue(post.schedule.startAt, tz),
    endDate: dateInputValue(post.schedule.endAt, tz),
    jitterMinutes: post.schedule.jitterMinutes ?? 0,
    kind: post.content.kind,
    library: post.content.library
      ? { ...post.content.library, items: post.content.library.items.map((i) => ({ ...i })) }
      : { items: [{ text: "" }], order: "sequential" },
    ai: post.content.ai ? { ...DEFAULT_AI, ...post.content.ai } : { ...DEFAULT_AI },
  };
}

export function schedulePayload(draft: PostDraft): GroupPostSchedule {
  const schedule: GroupPostSchedule = {
    timezone: draft.timezone,
    times: [...draft.times].sort(),
    days: [...draft.days].sort((a, b) => a - b),
  };
  // Início = 00:00 do dia escolhido; fim = 23:59 — no fuso DA AGENDA, não no do
  // navegador: quem programa para "até 31/12" quer o dia inteiro lá, não aqui.
  const start = draft.startDate ? dateInputToEpoch(draft.startDate, draft.timezone, 0, 0) : undefined;
  const end = draft.endDate ? dateInputToEpoch(draft.endDate, draft.timezone, 23, 59) : undefined;
  if (start !== undefined) schedule.startAt = start;
  if (end !== undefined) schedule.endAt = end;
  if (draft.jitterMinutes > 0) schedule.jitterMinutes = draft.jitterMinutes;
  return schedule;
}

export function contentPayload(draft: PostDraft): GroupPostContent {
  if (draft.kind === "ai") {
    const ai: GroupPostAi = {
      prompt: draft.ai.prompt.trim(),
      persona: draft.ai.persona ?? "attendant",
      useKnowledge: draft.ai.useKnowledge,
      generateMinutesBefore: draft.ai.generateMinutesBefore,
      requiresApproval: draft.ai.requiresApproval,
      onMissedApproval: draft.ai.onMissedApproval,
    };
    if (ai.persona === "custom") ai.customPersona = (draft.ai.customPersona ?? "").trim();
    if (draft.ai.maxChars !== undefined) ai.maxChars = draft.ai.maxChars;
    return { kind: "ai", ai };
  }
  const library: GroupPostLibrary = {
    items: draft.library.items.map((item) => {
      const next: GroupPostLibrary["items"][number] = { text: item.text };
      if (item.attachmentFileIds && item.attachmentFileIds.length > 0) {
        next.attachmentFileIds = item.attachmentFileIds;
      }
      if (item.contentType) next.contentType = item.contentType;
      return next;
    }),
    order: draft.library.order,
  };
  if (draft.library.order === "random" && (draft.library.noRepeatWindow ?? 0) > 0) {
    // Clampado ao total - 1: apagar mensagens depois de configurar a janela
    // deixaria um valor que o servidor recusa, e o erro só apareceria ao salvar.
    library.noRepeatWindow = Math.min(
      draft.library.noRepeatWindow as number,
      Math.max(0, library.items.length - 1)
    );
  }
  // Cursor e índices recentes são estado do worker: preservá-los faz a edição
  // de um texto não reiniciar a sequência do zero. `pickLibraryItem` já
  // tolera cursor fora da faixa quando a biblioteca encolhe.
  if (draft.library.cursor !== undefined) library.cursor = draft.library.cursor;
  if (draft.library.recentIndexes !== undefined) library.recentIndexes = draft.library.recentIndexes;
  return { kind: "library", library };
}
