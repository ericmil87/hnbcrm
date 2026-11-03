/**
 * Copilot on Telegram — F2 commands (pure): command resolution (slash or
 * persistent-keyboard label), callback grammar, list rows/pages and the
 * keyboards. No ctx, no network. Data loading and authorization live in
 * `convex/telegramCommands.ts`; sending in `telegram.ts`.
 *
 * Callback grammar (≤ 64 bytes, disjoint from F1's `CALLBACK_VERBS`):
 *   cmd:<name>            a report/keyboard button acting as the command
 *   pg:<cmd>:<offset>     "Mais 10 →" (offset 10, 20, 30, 40)
 *   fc:<conversationId>   set focus; fc:off clears it
 *   mu:1h|tomorrow|off    mute / resume (all links of the chat)
 *   org:<linkId>          switch the chat's active organization
 */
import { escapeHtml } from "./telegramFormat";
import { parseOnboardingCallback, type OnboardingCallback } from "./telegramOnboarding";
import {
  channelLabel,
  formatMoney,
  initials,
  safeText,
  type CardButton,
  type CardContext,
  type CardKeyboard,
} from "./telegramNotifications";

export const PAGE_SIZE = 10;
/** Handoff rows are full cards (long): 5 per page. */
export const HANDOFF_PAGE_SIZE = 5;
export function pageSizeOf(command: string): number {
  return command === "repasses" ? HANDOFF_PAGE_SIZE : PAGE_SIZE;
}
/** Lists never go past this many rows ("Mais de 50 — abra o CRM"). */
export const LIST_CAP = 50;
/** Rows fetched for a page: the page, one more to know there is more, never beyond cap + 1. */
export function fetchLimit(offset: number, size = PAGE_SIZE): number {
  return Math.min(offset + size + 1, LIST_CAP + 1);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** `setMyCommands` (F2). `/start` is deep-link only and not listed. */
export const TELEGRAM_COMMANDS = [
  { command: "hoje", description: "Resumo do dia" },
  { command: "repasses", description: "Repasses pendentes" },
  { command: "tarefas", description: "Minhas tarefas" },
  { command: "leads", description: "Meus leads" },
  { command: "foco", description: "Escolher a conversa em foco" },
  { command: "novo", description: "Limpar o foco" },
  { command: "pausar", description: "Silenciar notificações" },
  { command: "org", description: "Trocar de organização" },
  { command: "teclado", description: "Mostrar ou ocultar o teclado" },
  { command: "tour", description: "Rever o guia" },
  { command: "ajuda", description: "Como usar o bot" },
  { command: "sair", description: "Desconectar este Telegram" },
] as const;

/** Commands the router dispatches here (`sair`/`start` are handled before). `help` aliases `ajuda`. */
const KNOWN = new Set([
  "hoje", "repasses", "tarefas", "leads", "foco", "novo", "pausar", "org", "teclado", "ajuda", "help", "modo", "tour",
]);

/** Persistent keyboard labels → command. A plain text equal to one is that command. */
export const KEYBOARD_LABELS: Record<string, string> = {
  "📋 Hoje": "hoje",
  "🔁 Repasses": "repasses",
  "✅ Tarefas": "tarefas",
  "⏸ Pausar": "pausar",
};

export const PERSISTENT_KEYBOARD = {
  keyboard: [
    [{ text: "📋 Hoje" }, { text: "🔁 Repasses" }],
    [{ text: "✅ Tarefas" }, { text: "⏸ Pausar" }],
  ],
  resize_keyboard: true as const,
  is_persistent: true as const,
};

/** The command a message means: a known slash command, or a keyboard label. */
export function resolveCommandName(parsed: { command: string } | null, text: string | undefined): string | null {
  if (parsed) {
    const c = parsed.command === "help" ? "ajuda" : parsed.command;
    return KNOWN.has(parsed.command) ? c : null;
  }
  const label = text?.trim();
  return label && KEYBOARD_LABELS[label] ? KEYBOARD_LABELS[label] : null;
}

export type PagedCommand = "repasses" | "tarefas" | "leads" | "foco";
const PAGED = new Set<string>(["repasses", "tarefas", "leads", "foco"]);
const CMD_BUTTONS = new Set(["hoje", "repasses", "tarefas", "leads", "foco", "pausar"]);

export type CommandCallback =
  | { kind: "cmd"; command: string }
  | { kind: "page"; command: PagedCommand; offset: number }
  | { kind: "focus"; conversationId: string }
  | { kind: "focusOff" }
  | { kind: "mute"; mode: "1h" | "tomorrow" | "off" }
  | { kind: "org"; linkId: string }
  | { kind: "onboarding"; cb: OnboardingCallback };

/** Null when `data` is not an F2 callback (it may still be an F1 one). */
export function parseCommandCallback(data: string | undefined): CommandCallback | null {
  if (!data || new TextEncoder().encode(data).length > 64) return null;
  const ob = parseOnboardingCallback(data);
  if (ob) return { kind: "onboarding", cb: ob };
  let m = data.match(/^cmd:([a-z]{2,12})$/);
  if (m) return CMD_BUTTONS.has(m[1]) ? { kind: "cmd", command: m[1] } : null;
  m = data.match(/^pg:([a-z]{2,12}):(\d{1,3})$/);
  if (m) {
    const offset = Number(m[2]);
    if (!PAGED.has(m[1]) || offset % pageSizeOf(m[1]) !== 0 || offset >= LIST_CAP) return null;
    return { kind: "page", command: m[1] as PagedCommand, offset };
  }
  if (data === "fc:off") return { kind: "focusOff" };
  m = data.match(/^fc:([A-Za-z0-9_;-]{1,40})$/);
  if (m) return { kind: "focus", conversationId: m[1] };
  m = data.match(/^mu:(1h|tomorrow|off)$/);
  if (m) return { kind: "mute", mode: m[1] as "1h" | "tomorrow" | "off" };
  m = data.match(/^org:([A-Za-z0-9_;-]{1,40})$/);
  if (m) return { kind: "org", linkId: m[1] };
  return null;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export const CMD_COPY = {
  unknown: "Não conheço esse comando.\n/ajuda lista o que sei fazer.",
  noHandoffs: "Nenhum repasse pendente 🎉",
  noTasks: "Nenhuma tarefa pendente para você 🎉",
  noLeads: "Nenhum lead para mostrar.",
  noConversations: "Você não tem conversas abertas para pôr em foco.",
  focusCleared: "Foco limpo.",
  newConversation: "Foco limpo e conversa nova com o Copiloto.",
  focusGone: "⚠️ Não encontrei essa conversa.\nEla pode ter sido apagada ou não ser sua.",
  muteChoose: "Silenciar notificações por:",
  unmuted: "🔔 Notificações retomadas.",
  singleOrg: (org: string) => `Você só está vinculado a <b>${escapeHtml(org)}</b>.`,
  orgChoose: (org: string) => `Você está em <b>${escapeHtml(org)}</b>.\n\nTrocar para:`,
  orgSwitched: (org: string) => `✅ Organização ativa: <b>${escapeHtml(org)}</b>.`,
  orgGone: "Esse vínculo não está mais ativo.",
  keyboardOn: "⌨️ Teclado ativado.\n/teclado oculta.",
  keyboardOff: "Teclado oculto.\n/teclado mostra de novo.",
  tooMany: "Mais de 50 — abra o CRM.",
} as const;

export function mutedText(until: string): string {
  return `🔕 <b>Silenciado até ${until}.</b>\nRepasses urgentes continuam no CRM.`;
}

export function pageFooter(offset: number, size = PAGE_SIZE): string {
  return `Mostrando 1–${offset + size}.`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "42 min", "3h ⚠️" (> 2 h), "2 d ⚠️". */
export function handoffAge(createdAt: number, now: number): string {
  const min = Math.max(1, Math.floor((now - createdAt) / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return h > 2 ? `${h}h ⚠️` : `${h}h`;
  return `${Math.floor(h / 24)} d ⚠️`;
}

/** "hoje", "há 1 dia", "há N dias". */
export function daysAgo(at: number, now: number): string {
  const d = Math.floor((now - at) / 86_400_000);
  return d <= 0 ? "hoje" : d === 1 ? "há 1 dia" : `há ${d} dias`;
}

/** Display name for a lead/room title in this mode: initials when discreet; never an e-mail. */
export function displayName(discreet: boolean, raw: string | undefined): string {
  const title = raw?.trim() || "Contato";
  return discreet ? initials(title) : title;
}

const moreRow = (command: PagedCommand, offset: number): CardButton[] => [
  { text: `Mais ${pageSizeOf(command)} →`, callback_data: `pg:${command}:${offset + pageSizeOf(command)}` },
];

/** Footer after a page: "Mais 10 →", or the CRM link past the cap. */
export function buildFooter(
  command: PagedCommand,
  offset: number,
  crmUrl: string,
): { text: string; keyboard: CardKeyboard } {
  const size = pageSizeOf(command);
  if (offset + size >= LIST_CAP) {
    return { text: CMD_COPY.tooMany, keyboard: [[{ text: "🔗 Abrir no CRM", url: crmUrl }]] };
  }
  return { text: pageFooter(offset, size), keyboard: [moreRow(command, offset)] };
}

export function countLabel(n: number, singular: string, plural: string): string {
  const shown = n > LIST_CAP ? `${LIST_CAP}+` : String(n);
  return `${shown} ${n === 1 ? singular : plural}`;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type TaskRowInput = { taskId: string; title: string; dueDate?: number };

export function buildTaskRow(card: CardContext, t: TaskRowInput, index: number, formatWhen: (at: number) => string): { text: string; keyboard: CardKeyboard } {
  const title = safeText(card, t.title, 120) || "Tarefa";
  let due = "sem prazo";
  if (t.dueDate !== undefined) {
    due = t.dueDate < card.now ? `⚠️ atrasada desde ${formatWhen(t.dueDate)}` : `⏰ ${formatWhen(t.dueDate)}`;
  }
  return {
    text: `${index}. <b>${title}</b>\n${due}`,
    keyboard: [
      [
        { text: "✅ Concluir", callback_data: `ct:${t.taskId}` },
        { text: "⏰ Adiar 1h", callback_data: `sz1:${t.taskId}` },
      ],
    ],
  };
}

export type LeadRowInput = { leadId: string; title: string; stageName?: string; value?: number; lastActivityAt: number };

/** One message with the page's leads and numbered "🔗" buttons (url), 5 per row. */
export function buildLeadsPage(args: {
  header: string;
  rows: LeadRowInput[];
  offset: number;
  discreet: boolean;
  currency: string;
  now: number;
  appBaseUrl: string;
  hasMore: boolean;
}): { text: string; keyboard: CardKeyboard } {
  const lines = args.rows.map((r, i) => {
    const bits = [`<b>${escapeHtml(displayName(args.discreet, r.title))}</b>`];
    if (r.stageName) bits.push(escapeHtml(r.stageName));
    if (r.value) bits.push(escapeHtml(formatMoney(r.value, args.currency)));
    bits.push(daysAgo(r.lastActivityAt, args.now));
    return `${args.offset + i + 1}. ${bits.join(" · ")}`;
  });
  const buttons: CardButton[] = args.rows.map((r, i) => ({
    text: `🔗 ${args.offset + i + 1}`,
    url: `${args.appBaseUrl}/app/pipeline?lead=${r.leadId}`,
  }));
  const keyboard: CardKeyboard = [];
  for (let i = 0; i < buttons.length; i += 5) keyboard.push(buttons.slice(i, i + 5));
  let text = `${args.header}\n${lines.join("\n")}`;
  if (args.hasMore) {
    if (args.offset + PAGE_SIZE >= LIST_CAP) {
      text += `\n${CMD_COPY.tooMany}`;
      keyboard.push([{ text: "🔗 Abrir no CRM", url: `${args.appBaseUrl}/app/pipeline` }]);
    } else {
      keyboard.push(moreRow("leads", args.offset));
    }
  }
  return { text, keyboard };
}

export type FocusRowInput = { conversationId: string; title: string; channel: string };

/** `/foco` picker: one button per conversation, "Lead · canal". */
export function buildFocusPicker(args: {
  rows: FocusRowInput[];
  offset: number;
  discreet: boolean;
  hasMore: boolean;
  appBaseUrl: string;
}): { text: string; keyboard: CardKeyboard } {
  const keyboard: CardKeyboard = args.rows.map((r) => [
    { text: `${displayName(args.discreet, r.title)} · ${channelLabel(r.channel)}`.slice(0, 60), callback_data: `fc:${r.conversationId}` },
  ]);
  if (args.hasMore) {
    keyboard.push(
      args.offset + PAGE_SIZE >= LIST_CAP
        ? [{ text: "🔗 Abrir no CRM", url: `${args.appBaseUrl}/app/entrada` }]
        : moreRow("foco", args.offset),
    );
  }
  return { text: "Qual conversa fica em foco? (suas conversas abertas)", keyboard };
}

function focusLine(card: Pick<CardContext, "discreet" | "lead" | "conversation">, label: string): string {
  const name = displayName(card.discreet, card.lead?.title);
  const meta = [channelLabel(card.conversation?.channel), card.lead?.stageName].filter(Boolean).map((x) => escapeHtml(x as string));
  return `🎯 ${label} <b>${escapeHtml(name)}</b>\n${meta.join(" · ")}`;
}

export function focusSetText(card: Pick<CardContext, "discreet" | "lead" | "conversation">): string {
  return `${focusLine(card, "Foco:")}\n\nTudo que você me disser agora é sobre essa conversa.\n/novo limpa.`;
}

/** `/foco` with a focus already set: the current one, then the picker. */
export function focusCurrentText(card: Pick<CardContext, "discreet" | "lead" | "conversation">): string {
  return focusLine(card, "Foco atual:");
}

export const MUTE_KEYBOARD: CardKeyboard = [
  [
    { text: "1 hora", callback_data: "mu:1h" },
    { text: "Até amanhã 8h", callback_data: "mu:tomorrow" },
    { text: "Retomar", callback_data: "mu:off" },
  ],
];

export const CLEAR_FOCUS_KEYBOARD: CardKeyboard = [[{ text: "✖ Limpar foco", callback_data: "fc:off" }]];
