/**
 * Copilot on Telegram — guided onboarding (D24, pure): the five tour cards
 * (card 0 is the `/start` welcome) and the first-time tips. No ctx, no network.
 *
 * Callbacks: `ob:1`…`ob:4` jump to a card, `ob:back` goes to the previous one
 * (from the stored step), `ob:mode:suggest|auto` picks the mode on card 2,
 * `ob:done` finishes. Card 4 reuses `cmd:hoje` / `cmd:repasses`.
 */
import { escapeHtml } from "./telegramFormat";
import type { CardKeyboard } from "./telegramNotifications";

export type OnboardingCard = { text: string; keyboard: CardKeyboard };
export const LAST_STEP = 4;

export type OnboardingCallback =
  | { kind: "step"; step: number }
  | { kind: "back" }
  | { kind: "mode"; mode: "suggest" | "auto" }
  | { kind: "done" };

export function parseOnboardingCallback(data: string | undefined): OnboardingCallback | null {
  if (!data) return null;
  const m = data.match(/^ob:([1-4])$/);
  if (m) return { kind: "step", step: Number(m[1]) };
  if (data === "ob:back") return { kind: "back" };
  if (data === "ob:done") return { kind: "done" };
  const mode = data.match(/^ob:mode:(suggest|auto)$/);
  if (mode) return { kind: "mode", mode: mode[1] as "suggest" | "auto" };
  return null;
}

const next = (step: number) => ({ text: "Próximo →", callback_data: `ob:${step}` });
const back = { text: "←", callback_data: "ob:back" };

/** Card 0: the `/start` welcome. `otherOrgNames` adds the multi-org note. */
export function buildWelcomeCard(args: { memberName: string; orgName: string; otherOrgNames?: string[] }): OnboardingCard {
  let text =
    "👋 <b>Conectado!</b>\n" +
    `${escapeHtml(args.memberName)} · ${escapeHtml(args.orgName)}\n\n` +
    "Sou sua assistente no HNBCRM.\n" +
    "Em 4 passos rápidos você vê como funciona.";
  const others = args.otherOrgNames ?? [];
  if (others.length > 0) {
    text +=
      `\n\nEste Telegram também está conectado a ${others.map((n) => `<b>${escapeHtml(n)}</b>`).join(", ")}.\n` +
      `As notificações de todas chegam aqui.\nOrganização ativa agora: <b>${escapeHtml(args.orgName)}</b>.`;
  }
  return { text, keyboard: [[next(1), { text: "Pular tour", callback_data: "ob:done" }]] };
}

export function buildTourCard(step: number): OnboardingCard {
  switch (step) {
    case 0:
      throw new Error("card 0 depende do membro: use buildWelcomeCard");
    case 1:
      return {
        text:
          "<b>1/4 · O que chega aqui</b>\n\n" +
          "🔔 Repasses da IA\n" +
          "💬 Mensagens das conversas que você atende\n" +
          "📌 Tarefas\n" +
          "☀️🌙 Relatório de manhã e de noite\n" +
          "🔴 Alertas de canal\n\n" +
          "Cada cartão vem com resumo e botões.\n" +
          "<b>Ver tudo</b> abre o histórico.",
        keyboard: [[back, next(2)]],
      };
    case 2:
      return {
        text:
          "<b>2/4 · Dois modos</b>\n" +
          "(troque quando quiser com /modo)\n\n" +
          "💡 <b>Sugestão</b> (recomendado para começar)\n" +
          "Eu proponho, você confirma.\n" +
          "Nada vai para o cliente sem o seu toque.\n\n" +
          "🤖 <b>Automático</b>\n" +
          "Eu decido e executo nas conversas que você colocou em foco.\n" +
          "O que for para o cliente fica 15 s na sua tela para cancelar.\n\n" +
          "Em qualquer modo, <b>repasses e follow-ups travados sempre chegam para você decidir</b>, com uma sugestão pronta.\n\n" +
          "Começar em:",
        keyboard: [
          [
            { text: "💡 Sugestão (recomendado)", callback_data: "ob:mode:suggest" },
            { text: "🤖 Automático", callback_data: "ob:mode:auto" },
          ],
          [back],
        ],
      };
    case 3:
      return {
        text:
          "<b>3/4 · Como falar comigo</b>\n\n" +
          "• Toque nos botões dos cartões\n" +
          "• Responda a um cartão para falar sobre aquela conversa\n" +
          "• Áudio funciona para tudo: instruir a IA, responder, pedir coisas\n" +
          "• Foto e arquivo (PDF, planilha) vão para o WhatsApp do cliente quando você está respondendo\n" +
          '• Sem cartão em foco, pergunte o que quiser sobre o CRM: "leads parados?"',
        keyboard: [[back, next(4)]],
      };
    case 4:
      return {
        text: "<b>4/4 · Teste agora</b>\n\nToque em um:",
        keyboard: [
          [
            { text: "☀️ Ver meu /hoje", callback_data: "cmd:hoje" },
            { text: "🔁 Repasses pendentes", callback_data: "cmd:repasses" },
          ],
          [{ text: "✅ Terminar", callback_data: "ob:done" }],
        ],
      };
    default:
      throw new Error(`card ${step} não existe`);
  }
}

export const ONBOARDING_COPY = {
  done:
    "✅ <b>Pronto!</b>\n" +
    "Quando chegar algo, eu te aviso aqui.\n\n" +
    "Comandos úteis:\n" +
    "/hoje · /repasses · /tarefas · /foco · /modo · /ajuda\n\n" +
    "/tour reabre este guia.",
  modeSet: (mode: "suggest" | "auto") =>
    mode === "auto"
      ? "✅ Começando em 🤖 <b>Automático</b>.\n/modo troca quando quiser."
      : "✅ Começando em 💡 <b>Sugestão</b>.\n/modo troca quando quiser.",
  autoOff:
    "O modo automático está desligado pela sua organização.\nFicou em 💡 <b>Sugestão</b>.",
} as const;

// ---------------------------------------------------------------------------
// First-time tips (D24)
// ---------------------------------------------------------------------------

const TIPS: Record<string, { key: string; text: string }> = {
  handoff_requested: { key: "handoff", text: "toque em Ver tudo para o histórico." },
  new_message: { key: "new_message", text: "responda a este cartão para falar sobre essa conversa." },
  task_assigned: { key: "task", text: "Adiar empurra o lembrete; Concluir fecha a tarefa." },
  task_due_soon: { key: "task", text: "Adiar empurra o lembrete; Concluir fecha a tarefa." },
  task_overdue: { key: "task", text: "Adiar empurra o lembrete; Concluir fecha a tarefa." },
  ai_draft_pending: { key: "draft", text: "Regenerar pede o motivo e gera outro rascunho." },
};

/** The tip (and the key stored in `tipsShown`) for a notification type, or null. */
export function tipFor(type: string): { key: string; text: string } | null {
  return TIPS[type] ?? null;
}

/**
 * "💡 Dica: …" for the first card of each kind, once. Pure: the caller
 * persists the returned `tipsShown`. Unknown types and repeats return no line.
 */
export function appendFirstTimeTip(args: {
  type: string;
  tipsShown?: readonly string[];
}): { line?: string; tipsShown: string[] } {
  const shown = [...(args.tipsShown ?? [])];
  const tip = tipFor(args.type);
  if (!tip || shown.includes(tip.key)) return { tipsShown: shown };
  return { line: `💡 Dica: ${tip.text}`, tipsShown: [...shown, tip.key] };
}
