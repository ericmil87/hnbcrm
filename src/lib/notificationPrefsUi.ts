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
  /** O tipo aparece no sino? (o resumo diário só sai por e-mail). */
  bell: boolean;
}

const ALL_CHANNELS: readonly MatrixChannel[] = ["email", "telegram", "push"];

/**
 * Flags com template de e-mail em `buildTemplate` (convex/emailTemplates.ts). Os demais
 * não têm e-mail: a coluna mostra "—". O teste confere a paridade com o arquivo do backend.
 */
export const EMAIL_FLAGS: ReadonlySet<string> = new Set([
  "handoffRequested",
  "handoffResolved",
  "taskOverdue",
  "taskAssigned",
  "taskCommentMention",
  "taskDueSoon",
  "leadAssigned",
  "newMessage",
  "dailyDigest",
  "groupPostPending",
  "groupPostFailed",
  "aiSpendAlert",
  "channelSessionLost",
]);

export const FLAG_COPY: Record<
  string,
  { label: string; desc: string; channels?: readonly MatrixChannel[]; bell?: false }
> = {
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
  dailyDigest: { label: "Resumo diário", desc: "Resumo das atividades do dia anterior, às 08:00", channels: ["email"], bell: false },
};

/** Rótulo do canal na matriz. */
export const CHANNEL_LABEL: Record<MatrixChannel, string> = { email: "E-mail", telegram: "Telegram", push: "No aparelho" };

/** Prazo do e-mail de reserva (aviso sem leitura); texto fixo sob a matriz. */
export const EMAIL_FALLBACK_NOTE =
  "E-mail de pedido de ajuda e menção sai se o aviso continuar sem leitura por 10 min; de tarefas, 30 min.";

/** Frase de pausa/silêncio: o pedido de ajuda urgente fura quando o bypass está ligado. */
export function pauseScopeText(pushEnabled: boolean, urgentBypass: boolean): string {
  return `nada sai por ${externalChannelsText(pushEnabled)}${urgentBypass ? ", exceto pedido de ajuda urgente" : ""}; tudo fica registrado no sino.`;
}

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
      bell: copy?.bell !== false,
      channels: (copy?.channels ?? ALL_CHANNELS).filter((c) => c !== "email" || EMAIL_FLAGS.has(flag)),
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
  { value: "none", label: "Nada (só o sino)", hint: "Nenhum aviso por {canais}. Tudo continua no sino." },
] as const;

/** Dica do atalho; o canal "avisos no aparelho" só é citado quando o deployment tem push. */
export function presetHint(value: string, pushEnabled: boolean): string | undefined {
  const hint = PRESET_OPTIONS.find((o) => o.value === value)?.hint;
  return hint?.replace("{canais}", externalChannelsText(pushEnabled));
}

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

/**
 * Disponibilidade do push na tela de preferências.
 *  - `pushEnabled`: o deployment tem push (recurso ligado, chave VAPID e build sem kill switch). Decide os textos de
 *    pausa/silêncio e o "Ocultar prévia" da organização, que vale para todos os aparelhos (não depende do aparelho do admin).
 *  - `pushAvailable`: `pushEnabled` E este aparelho suporta OU algum aparelho da pessoa já está vinculado. Decide a coluna
 *    Push da matriz e a prévia pessoal.
 */
export function pushAvailability(input: {
  featureOn: boolean;
  vapidKey: string | null | undefined;
  killSwitch: boolean;
  deviceSupported: boolean;
  hasLinkedDevice: boolean;
}): { pushEnabled: boolean; pushAvailable: boolean } {
  const pushEnabled = input.featureOn && !input.killSwitch && typeof input.vapidKey === "string" && input.vapidKey.length > 0;
  return { pushEnabled, pushAvailable: pushEnabled && (input.deviceSupported || input.hasLinkedDevice) };
}

/**
 * Fora de "Só o que é comigo" nos canais externos. Espelha `NON_PERSONAL_FLAGS` de
 * convex/lib/notificationPolicy.ts (o teste confere a paridade lendo o arquivo).
 */
export const NON_PERSONAL_FLAGS: ReadonlySet<string> = new Set([
  "campaignCompleted",
  "campaignPaused",
  "groupJoined",
  "groupPostPending",
  "groupPostFailed",
  "groupOpportunity",
  "groupDigest",
  "aiSpendAlert",
]);

/** O atalho define o valor de base de cada canal externo; qualquer célula diferente é uma escolha por tipo. */
export function isCustomized(
  preset: "all" | "mine" | "none",
  value: (channel: MatrixChannel, flag: string) => boolean,
  rows: readonly FlagRow[],
): boolean {
  for (const row of rows) {
    const base = preset === "all" ? true : preset === "none" ? false : !NON_PERSONAL_FLAGS.has(row.flag);
    for (const channel of row.channels) if (value(channel, row.flag) !== base) return true;
  }
  return false;
}

/** "Até amanhã 8 h" no fuso do APARELHO (o servidor usaria o fuso da organização). */
export function tomorrowEightLocal(now: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 8, 0, 0, 0).getTime();
}

/** Argumentos de `pauseFor` para cada opção do menu, calculados com o relógio do aparelho. */
export function pauseArgs(
  mode: "1h" | "4h" | "tomorrow",
  now: number,
): { mode: "1h" | "4h" } | { mode: "custom"; until: number } {
  if (mode === "tomorrow") return { mode: "custom", until: tomorrowEightLocal(now) };
  return { mode };
}

/** Canais externos citados nos textos de pausa, silêncio e atalhos (avisos no aparelho só quando houver push). */
export function externalChannelsText(pushEnabled: boolean): string {
  return pushEnabled ? "e-mail, Telegram ou avisos no aparelho" : "e-mail ou Telegram";
}
