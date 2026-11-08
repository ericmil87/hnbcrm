/**
 * Lógica pura da tela de preferências de aviso (C2): linhas da matriz, pausa e
 * horário de silêncio. A fonte de flags/grupos é o backend (`PREFERENCE_FLAG`,
 * `NOTIFICATION_TYPE_GROUP`); aqui só rótulos e arranjo.
 */
import { formatDateTime, formatTime } from "./format";
import { PREFERENCE_FLAG } from "../../convex/lib/notificationPolicy";
import {
  NOTIFICATION_GROUPS,
  NOTIFICATION_TYPE_GROUP,
  type NotificationGroup,
} from "../../convex/lib/notificationGroups";

export type MatrixChannel = "email" | "telegram" | "push";

export interface FlagRow {
  flag: string;
  label: string;
  desc: string;
  group: NotificationGroup;
  /** Canais externos que fazem sentido para o tipo (o resumo diário só sai por e-mail). */
  channels: readonly MatrixChannel[];
}

const ALL_CHANNELS: readonly MatrixChannel[] = ["email", "telegram", "push"];

export const FLAG_COPY: Record<string, { label: string; desc: string; channels?: readonly MatrixChannel[] }> = {
  handoffRequested: { label: "Pedido de ajuda da IA", desc: "Quando a IA pede ajuda para você ou para a equipe" },
  handoffResolved: { label: "Pedido de ajuda resolvido", desc: "Quando um pedido de ajuda é assumido ou devolvido à IA" },
  aiDraftPending: { label: "Resposta sugerida para revisar", desc: "Quando a IA deixa uma resposta para você revisar em um lead seu" },
  aiFollowupNeedsHuman: { label: "Follow-up da IA precisa de você", desc: "Quando a IA não consegue executar sozinha um follow-up que ela agendou" },
  conversationTransferred: { label: "Conversa transferida para você", desc: "Quando uma conversa é transferida para você ou para o seu departamento" },
  newMessage: { label: "Novas mensagens nas conversas que eu atendo", desc: "Agrupadas, quando a IA não está no comando" },
  leadAssigned: { label: "Lead atribuído", desc: "Quando um lead é atribuído a você" },
  taskAssigned: { label: "Tarefa atribuída", desc: "Quando uma tarefa é atribuída a você" },
  taskCommentMention: { label: "Menção em comentário de tarefa", desc: "Quando alguém te menciona em um comentário" },
  taskDueSoon: { label: "Tarefa vence em breve", desc: "Lembrete antes do vencimento de uma tarefa sua" },
  taskOverdue: { label: "Tarefa atrasada", desc: "Quando uma tarefa atribuída a você está atrasada" },
  groupJoined: { label: "Entrou em um grupo", desc: "Quando o número do WhatsApp passa a fazer parte de um grupo novo" },
  groupMention: { label: "Menção em grupo", desc: "Quando alguém menciona o número da empresa em um grupo acompanhado" },
  groupPostPending: { label: "Publicação aguardando aprovação", desc: "Quando o texto de uma publicação programada precisa da sua aprovação" },
  groupPostFailed: { label: "Falha em publicação programada", desc: "Quando uma publicação programada não consegue enviar" },
  groupOpportunity: { label: "Oportunidade detectada em grupo", desc: "Quando a IA vê uma possível oportunidade de negócio em um grupo" },
  groupDigest: { label: "Resumo do grupo", desc: "Resumo do que aconteceu nos grupos acompanhados" },
  campaignCompleted: { label: "Campanha concluída", desc: "Quando uma campanha de WhatsApp termina de enviar" },
  campaignPaused: { label: "Campanha pausada por segurança", desc: "Quando um limite ou sinal de risco pausa uma campanha" },
  channelSessionLost: { label: "Canal desconectado", desc: "Quando um canal conectado perde a conexão" },
  aiSpendAlert: { label: "Gasto de IA do mês", desc: "Para administradores: perto do teto mensal ou ao atingi-lo" },
  dailyDigest: { label: "Resumo diário", desc: "Resumo das atividades do dia anterior, às 08:00", channels: ["email"] },
};

/** Todas as linhas da matriz, agrupadas na ordem de `NOTIFICATION_GROUPS`. */
export function buildMatrixGroups(): { group: NotificationGroup; rows: FlagRow[] }[] {
  const byGroup = new Map<NotificationGroup, FlagRow[]>(NOTIFICATION_GROUPS.map((g) => [g, []]));
  const seen = new Set<string>();
  const add = (flag: string, group: NotificationGroup) => {
    if (seen.has(flag)) return;
    seen.add(flag);
    const copy = FLAG_COPY[flag];
    byGroup.get(group)?.push({
      flag,
      label: copy?.label ?? flag,
      desc: copy?.desc ?? "",
      group,
      channels: copy?.channels ?? ALL_CHANNELS,
    });
  };
  for (const [type, flag] of Object.entries(PREFERENCE_FLAG)) {
    add(flag, NOTIFICATION_TYPE_GROUP[type] ?? "sistema");
  }
  add("dailyDigest", "sistema");
  return NOTIFICATION_GROUPS.map((group) => ({ group, rows: byGroup.get(group) ?? [] })).filter(
    (g) => g.rows.length > 0,
  );
}

export const PRESET_OPTIONS = [
  { value: "all", label: "Tudo", hint: "Avisa de tudo que acontece, nos canais que você deixar ligados." },
  {
    value: "mine",
    label: "Só o que é comigo",
    hint: "Pedidos e itens seus. Avisos gerais de campanhas, grupos e gastos ficam só no sino.",
  },
  { value: "none", label: "Nada (só o sino)", hint: "Nenhum aviso por e-mail, Telegram ou push. Tudo continua no sino." },
] as const;

/** "Pausado até 14:00" (hoje), "até amanhã 08:00" ou "até 12/11 08:00". Usa o fuso do aparelho. */
export function pausedUntilLabel(pausedUntil: number, now: number): string {
  const until = new Date(pausedUntil);
  const today = new Date(now);
  const hhmm = formatTime(pausedUntil);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((dayStart(until) - dayStart(today)) / 86_400_000);
  if (diffDays === 0) return `Pausado até ${hhmm}`;
  if (diffDays === 1) return `Pausado até amanhã ${hhmm}`;
  return `Pausado até ${formatDateTime(pausedUntil)}`;
}

export function isPaused(pausedUntil: number | null | undefined, now: number): pausedUntil is number {
  return typeof pausedUntil === "number" && pausedUntil > now;
}

export const PAUSE_OPTIONS = [
  { mode: "1h", label: "Por 1 hora" },
  { mode: "4h", label: "Por 4 horas" },
  { mode: "tomorrow", label: "Até amanhã 8 h" },
] as const;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Mesma regra do servidor, para avisar antes de enviar. */
export function validateQuietHours(enabled: boolean, start: string, end: string): string | null {
  if (!HHMM.test(start) || !HHMM.test(end)) return "Horário inválido — use HH:MM";
  if (enabled && start === end) return "O início e o fim do silêncio não podem ser o mesmo horário";
  return null;
}

export function deviceTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "PushManager" in window &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator
  );
}
