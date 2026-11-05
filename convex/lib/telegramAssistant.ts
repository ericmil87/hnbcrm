/**
 * Assistant modes on Telegram (F3, D22/D23). Pure: effective mode, caps,
 * auto-allowed tools, copy. The runners live in `telegramCopilot.ts`; the
 * reversals (undo) and the veto live in `lib/telegramActions.ts`.
 */
import type { Doc } from "../_generated/dataModel";
import { escapeHtml } from "./telegramFormat";

export type AssistantMode = "suggest" | "auto";

/** D22 caps. */
export const AUTO_ACTIONS_PER_HOUR = 20;
export const AUTO_PAUSE_UNDOS = 3;
export const UNDO_WINDOW_MS = 10 * 60 * 1000;
/** D23: countdown 5–120 s, default 15. */
export const AUTO_SEND_MIN_S = 5;
export const AUTO_SEND_MAX_S = 120;
export const AUTO_SEND_DEFAULT_S = 15;

/**
 * The mode that applies NOW: the org can forbid automatic mode
 * (`settings.telegram.allowAutoMode === false`), and 3 undos in an hour pause
 * it (`assistant.autoPausedAt`) until `/modo` turns it on again.
 */
export function effectiveAssistantMode(
  link: Pick<Doc<"telegramLinks">, "assistant">,
  org: Pick<Doc<"organizations">, "settings"> | null | undefined,
): AssistantMode {
  if (org?.settings.telegram?.allowAutoMode === false) return "suggest";
  if (link.assistant.autoPausedAt !== undefined) return "suggest";
  return link.assistant.mode;
}

export function autoSendSeconds(link: Pick<Doc<"telegramLinks">, "assistant">): number {
  const s = link.assistant.autoSendDelaySeconds;
  if (!Number.isFinite(s)) return AUTO_SEND_DEFAULT_S;
  return Math.min(Math.max(Math.round(s), AUTO_SEND_MIN_S), AUTO_SEND_MAX_S);
}

/** Actions left this hour (the window restarts after an hour). */
export function autoActionsLeft(link: Pick<Doc<"telegramLinks">, "assistant">, now: number): number {
  const start = link.assistant.autoHourStart;
  if (start === undefined || now - start >= 60 * 60 * 1000) return AUTO_ACTIONS_PER_HOUR;
  return Math.max(0, AUTO_ACTIONS_PER_HOUR - (link.assistant.autoActionsThisHour ?? 0));
}

/**
 * Write tools the automatic turn may call (D22, from `autoAllowed`). Read
 * tools are always allowed. Destructive tools never. `sendCustomerReply` only
 * when `replyCustomer` is allowed (and it is two-phase anyway).
 *
 * The Atendente IA config tools (`updateAttendantPersona`, `setAttendantMode`,
 * `setAiFeatures`… — `lib/copilotConfigTools.ts`) are NEVER here: configuration
 * changes only happen with the human's confirmation, and the executor also
 * refuses `via:"telegram_auto"` (tested in telegramF3.test.ts).
 */
export function autoWriteTools(link: Pick<Doc<"telegramLinks">, "assistant">): string[] {
  const a = link.assistant.autoAllowed;
  return [
    ...(a.instructAi ? ["instructAttendant", "regenerateAiReply"] : []),
    ...(a.createTask ? ["createTask"] : []),
    ...(a.moveStage ? ["moveLead"] : []),
    // Never `acceptHandoff` (D22 amended 03/11): a handoff is always the human's call.
    ...(a.replyCustomer ? ["sendCustomerReply"] : []),
  ];
}

const AUTO_LABELS: Record<string, string> = {
  instructAttendant: "instruir a IA",
  createTask: "criar tarefa",
  moveLead: "mover etapa",
  acceptHandoff: "aceitar repasse",
};

/** §3.4b: the extra system text of an automatic turn. */
export function autoModeSystemText(tools: string[]): string {
  const allowed = tools.map((t) => AUTO_LABELS[t]).filter(Boolean);
  return [
    "Você está em modo automático. Decida e execute com as ferramentas permitidas:",
    `${allowed.join(", ") || "nenhuma de escrita"}.`,
    "Prefira instruir o Atendente a responder você mesma; toda mensagem ao cliente passa por confirmação do usuário.",
    "Se faltar informação, não invente: não execute nada e explique em uma linha o que sugeriria.",
    "Ao final, resuma em até 3 linhas o contexto do caso (não liste o que fez; isso é registrado à parte).",
  ].join(" ");
}

/** §3.4b "linha 💡 Sugiro": read-only turn that proposes ONE action as a JSON line. */
export const SUGGEST_SYSTEM_TEXT = [
  "Modo sugestão: você só LÊ (ferramentas de leitura). Proponha UMA ação para o usuário aprovar com um toque.",
  'Responda com uma linha começando por SUGESTAO_JSON: seguida de um JSON {"tool":"instructAttendant"|"acceptHandoff"|"regenerateAiReply","args":{...},"resumo":"..."}',
  "(args de instructAttendant: {\"instruction\"}; de regenerateAiReply: {\"reason\"}; de acceptHandoff: {}).",
  '"resumo" = 1 linha em português do que você sugere. Se não tiver uma boa sugestão, responda SUGESTAO_JSON: null.',
].join(" ");

export type Suggestion = { tool: "instructAttendant" | "acceptHandoff" | "regenerateAiReply"; args: Record<string, string>; resumo: string };

export function parseSuggestion(text: string): Suggestion | null {
  const m = text.match(/SUGESTAO_JSON:\s*(\{[\s\S]*\}|null)/);
  if (!m || m[1] === "null") return null;
  try {
    const raw = JSON.parse(m[1]!) as { tool?: unknown; args?: unknown; resumo?: unknown };
    if (raw.tool !== "instructAttendant" && raw.tool !== "acceptHandoff" && raw.tool !== "regenerateAiReply") return null;
    const resumo = typeof raw.resumo === "string" ? raw.resumo.trim().slice(0, 300) : "";
    if (!resumo) return null;
    const args: Record<string, string> = {};
    const a = (raw.args ?? {}) as Record<string, unknown>;
    if (raw.tool === "instructAttendant") {
      if (typeof a.instruction !== "string" || !a.instruction.trim()) return null;
      args.instruction = a.instruction.trim().slice(0, 2000);
    }
    if (raw.tool === "regenerateAiReply") {
      if (typeof a.reason !== "string" || !a.reason.trim()) return null;
      args.reason = a.reason.trim().slice(0, 2000);
    }
    return { tool: raw.tool, args, resumo };
  } catch {
    return null;
  }
}

export const STEP_LABELS: Record<string, string> = {
  instruct: "Instruí a IA",
  accept_handoff: "Aceitei o repasse",
  create_task: "Criei a tarefa",
  move_stage: "Movi a etapa",
  complete_task: "Concluí a tarefa",
  snooze_task: "Adiei a tarefa",
  regenerate: "Pedi uma nova versão do rascunho",
};

/**
 * D22 amended (incident 03/11 in PROD): the automatic turn runs ONLY for a
 * customer message in the conversation the member put in focus. Handoffs and
 * stuck follow-ups always reach the human (card + read-only "💡 Sugiro").
 */
export const AUTO_TURN_TRIGGERS = new Set(["new_message"]);
export const SUGGEST_TRIGGERS = new Set(["handoff_requested", "ai_followup_needs_human"]);

/** The automatic mode in one line (/modo, md:auto, onboarding card 2). */
export function autoModeDescription(seconds: number): string {
  return (
    `🤖 Automático: eu decido e executo nas conversas que você colocou em foco; o que for para o cliente fica ${seconds} s na sua tela para cancelar. ` +
    "Repasses e follow-ups travados sempre chegam para você decidir, com uma sugestão pronta."
  );
}

export const MODE_COPY = {
  current: (mode: AssistantMode, seconds: number) =>
    mode === "auto" ? `Modo atual: 🤖 Automático.\n${autoModeDescription(seconds)}` : "Modo atual: 💡 Sugestão.",
  autoForbidden: (org: string) =>
    `Modo atual: 💡 Sugestão. O modo automático está desligado na ${escapeHtml(org)} (um admin liga em Configurações → Telegram).`,
  paused: "⏸ O modo automático está pausado (3 desfazeres na última hora). Toque em 🤖 Automático para religar.",
  autoOn: (tools: string[], replyCustomer: boolean, seconds: number) =>
    [
      `Modo automático ligado.\n${autoModeDescription(seconds)}`,
      `Posso: ${tools.map((t) => AUTO_LABELS[t]).filter(Boolean).join(", ") || "só ler"}.`,
      replyCustomer
        ? `Mensagens ao cliente ficam ${seconds} s na sua tela para cancelar.`
        : "NÃO respondo ao cliente por conta própria (ligue em Configurações → Telegram se quiser).",
      "Tudo que eu fizer vem com Desfazer por 10 min. /modo volta para Sugestão.",
    ].join("\n"),
  suggestOn: "💡 Modo sugestão. Eu proponho, você confirma: nada vai para o cliente sem o seu toque. /modo troca de novo.",
  pausedByUndos:
    "⏸ Voltei para o modo Sugestão: você desfez 3 ações na última hora, então prefiro propor em vez de agir. /modo liga o automático de novo quando quiser.",
} as const;

/**
 * D23: the countdown ("sends unless vetoed") applies ONLY to a draft this
 * member asked for from the bot (instruct / regenerate, `requestedVia`
 * telegram*). Drafts the attendant wrote on its own for a customer message
 * always get the normal Enviar · Regenerar · Descartar card.
 */
export function draftAutoSendable(aiDraft: unknown, memberId: string): boolean {
  if (!aiDraft || typeof aiDraft !== "object") return false;
  const d = aiDraft as { requestedVia?: unknown; instructedBy?: unknown; status?: unknown };
  return (d.requestedVia === "telegram" || d.requestedVia === "telegram_auto") && d.instructedBy === memberId;
}

/** D20/D23 (0.77.2): the line that closes a Telegram-requested AI reply once it is sent. */
export const AI_BACK_IN_CHARGE =
  "✅ O Atendente voltou a conduzir a conversa. Se precisar de você de novo, o repasse chega aqui.";

/** A draft asked from the bot (instruct/regenerate): its sent record carries `AI_BACK_IN_CHARGE`. */
export function isTelegramRequestedDraft(aiDraft: unknown): boolean {
  const via = (aiDraft as { requestedVia?: unknown } | undefined)?.requestedVia;
  return via === "telegram" || via === "telegram_auto";
}
