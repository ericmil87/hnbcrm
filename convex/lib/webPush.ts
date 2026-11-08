/**
 * Web Push (E1) — parte PURA da porta única: o que vai no push (payload
 * Declarative Web Push + campos do SW clássico), os headers (`TTL`, `Urgency`,
 * `Topic`), a classificação da resposta do serviço de push e a validação da
 * assinatura que o navegador manda.
 *
 * A outra metade é `convex/pushNode.ts` ("use node"): o ÚNICO arquivo que lê
 * chave privada e o assunto VAPID, importa `web-push` e chama o endpoint
 * (guard `pushPort.test.ts`). Sem ctx, sem relógio, sem rede aqui.
 *
 * Payload NUNCA leva telefone, e-mail, mídia nem URL de storage: título/corpo
 * vêm do `notificationCopy` (que já troca nome-telefone por "Contato" e passa
 * trechos por `scrubPii`) e passam de novo por `scrubPii` aqui.
 */
import type { NotificationType } from "./notify";
import { scrubPii, truncateGraphemes, BODY_MAX } from "./notificationCopy";

// ---------------------------------------------------------------------------
// Templates (D1: push só para o acionável)
// ---------------------------------------------------------------------------

/** "attendance" = atendimento (urgente, TTL 4 h); "tasks" = tarefas (normal, TTL 24 h). */
export type PushClass = "attendance" | "tasks" | "channel";
export type PushUrgency = "very-low" | "low" | "normal" | "high";

export type PushTemplate = { klass: PushClass; urgency: PushUrgency; ttlSeconds: number };

const HOUR_S = 3600;
const ATTENDANCE: PushTemplate = { klass: "attendance", urgency: "high", ttlSeconds: 4 * HOUR_S };
const TASKS: PushTemplate = { klass: "tasks", urgency: "normal", ttlSeconds: 24 * HOUR_S };
// Canal caído: tão urgente quanto atendimento, mas continua valendo por um dia.
const CHANNEL: PushTemplate = { klass: "channel", urgency: "high", ttlSeconds: 24 * HOUR_S };

/**
 * Tipo → template de push. Todo tipo do schema está aqui OU em
 * `IGNORED_FOR_PUSH` (paridade em `webPush.test.ts`).
 */
export const PUSH_TEMPLATES: Partial<Record<NotificationType, PushTemplate>> = {
  handoff_requested: ATTENDANCE,
  new_message: ATTENDANCE,
  conversation_transferred: ATTENDANCE,
  task_comment_mention: ATTENDANCE,
  group_mention: ATTENDANCE,
  ai_draft_pending: ATTENDANCE,
  task_assigned: TASKS,
  task_due_soon: TASKS,
  task_overdue: TASKS,
  ai_followup_needs_human: TASKS,
  channel_session_lost: CHANNEL,
};

/** Informativos (sino/e-mail/Telegram conforme preferência) e o lead atribuído (tabela do PLANO, seção 4). */
export const IGNORED_FOR_PUSH: ReadonlySet<NotificationType> = new Set<NotificationType>([
  "handoff_resolved",
  "campaign_completed",
  "campaign_paused",
  "group_joined",
  "group_post_pending",
  "group_post_failed",
  "group_opportunity",
  "group_digest",
  "ai_spend_warning",
  "ai_spend_reached",
  "lead_assigned",
]);

export function pushTemplateOf(type: NotificationType): PushTemplate | null {
  if (IGNORED_FOR_PUSH.has(type)) return null;
  return PUSH_TEMPLATES[type] ?? null;
}

export function hasPushTemplate(type: NotificationType): boolean {
  return pushTemplateOf(type) !== null;
}

// ---------------------------------------------------------------------------
// Limites
// ---------------------------------------------------------------------------

/** Aparelhos por membro que recebem um aviso (o 11º vínculo derruba o mais antigo). */
export const PUSH_MAX_DEVICES = 10;
/** Tentativas totais por assinatura (1ª + 2 reenvios) em 429/5xx/rede. */
export const PUSH_MAX_ATTEMPTS = 3;
/** Espera antes do reenvio N (1 = depois da 1ª tentativa). */
export const PUSH_RETRY_BACKOFF_MS = [30_000, 120_000, 600_000];
/** Teto de `Retry-After` aceito (o serviço pode pedir horas; o aviso já não valeria). */
export const PUSH_RETRY_AFTER_MAX_MS = 30 * 60_000;
/** Mesma conversa: vibra/toca de novo só se o último toque foi há ≥ 5 min. */
export const PUSH_RENOTIFY_MS = 5 * 60_000;
/** Teto do contador do ícone (`app_badge`). */
export const PUSH_BADGE_CAP = 20;
/** Assinatura parada (sem abrir o app nem receber) há mais do que isto sai na retenção. */
export const PUSH_STALE_DAYS = 60;
/** `lastSeenAt` só é regravado se o anterior tem mais do que isto (I/O). */
export const PUSH_TOUCH_MS = 24 * 60 * 60_000;
/** Timeout por envio na action. */
export const PUSH_FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Assinatura vinda do navegador
// ---------------------------------------------------------------------------

/**
 * Serviços de push conhecidos. O servidor faz POST no endpoint que o cliente
 * manda: sem esta lista, qualquer membro faria o Convex chamar um host
 * arbitrário (SSRF). Chrome/Edge(Android)/Opera/Samsung = FCM; Firefox =
 * Mozilla; Safari/iOS = Apple; Edge desktop = WNS.
 */
const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com",
  "android.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

export const ENDPOINT_MAX = 1024;
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export function isAllowedPushEndpoint(raw: string): boolean {
  if (raw.length > ENDPOINT_MAX) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** p256dh = ponto P-256 não comprimido (65 bytes ≈ 87 chars); auth = 16 bytes (≈ 22 chars). */
export function isValidSubscriptionKeys(p256dh: string, auth: string): boolean {
  return (
    B64URL.test(p256dh) && p256dh.length >= 80 && p256dh.length <= 100 &&
    B64URL.test(auth) && auth.length >= 16 && auth.length <= 32
  );
}

/** Rótulo do aparelho ("Chrome no Android"): texto curto, sem controle nem PII. */
export function cleanUserAgentLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = scrubPii(raw.replace(/[\u0000-\u001f\u007f<>]/g, " ")).replace(/\s+/g, " ").trim();
  return clean ? truncateGraphemes(clean, 60) : undefined;
}

// ---------------------------------------------------------------------------
// Destino, tag e Topic
// ---------------------------------------------------------------------------

export type PushNotificationInput = {
  _id: string;
  type: NotificationType;
  title: string;
  body?: string;
  organizationId: string;
  conversationId?: string;
  handoffId?: string;
  taskId?: string;
  groupChatId?: string;
  channelConfigId?: string;
  metaConnectionId?: string;
  data?: Record<string, unknown>;
};

/**
 * Caminho dentro do app (mesmas rotas do clique do sino em
 * `src/components/notifications/NotificationPanel.tsx`).
 */
export function pushTargetPath(n: PushNotificationInput): string {
  const conversation = n.conversationId ? `/app/entrada?conversation=${n.conversationId}` : null;
  switch (n.type) {
    case "handoff_requested":
      return n.handoffId ? `/app/repasses?handoff=${n.handoffId}` : (conversation ?? "/app/repasses");
    case "new_message":
    case "conversation_transferred":
    case "ai_draft_pending":
      return conversation ?? "/app/entrada";
    case "group_mention":
      return conversation ?? "/app/grupos";
    case "channel_session_lost": {
      const isMeta = Boolean(n.metaConnectionId ?? n.data?.metaConnectionId);
      return `/app/configuracoes?secao=${isMeta ? "instagram" : "channels"}`;
    }
    case "ai_followup_needs_human":
      return n.taskId ? `/app/tarefas?task=${n.taskId}` : (conversation ?? "/app/tarefas");
    default:
      return n.taskId ? `/app/tarefas?task=${n.taskId}` : (conversation ?? "/app/painel");
  }
}

/**
 * `tag` da notificação no aparelho: um aviso por entidade (substitui o
 * anterior). `conversa:{id}` / `repasse:{id}` / `tarefa:{id}` (+ canal/grupo).
 */
export function pushTagOf(n: PushNotificationInput): string {
  if (n.type === "handoff_requested" && n.handoffId) return `repasse:${n.handoffId}`;
  if (n.taskId && (n.type.startsWith("task_") || n.type === "ai_followup_needs_human")) return `tarefa:${n.taskId}`;
  if (n.conversationId) return `conversa:${n.conversationId}`;
  if (n.type === "group_mention" && n.groupChatId) return `grupo:${n.groupChatId}`;
  if (n.type === "channel_session_lost") {
    const ch = n.channelConfigId ?? n.metaConnectionId;
    if (ch) return `canal:${ch}`;
  }
  if (n.taskId) return `tarefa:${n.taskId}`;
  return `aviso:${n._id}`;
}

/** Header `Topic` (RFC 8030): ≤ 32 chars do alfabeto base64url. Mesma entidade = substitui push não entregue. */
export function pushTopicOf(tag: string): string {
  const [kind, ...rest] = tag.split(":");
  const id = rest.join("").replace(/[^A-Za-z0-9_-]/g, "");
  const prefix = (kind || "x").slice(0, 1);
  return `${prefix}-${id}`.slice(0, 32);
}

// ---------------------------------------------------------------------------
// Payload
// ---------------------------------------------------------------------------

export const PUSH_PAYLOAD_VERSION = 1;

/** O que o SW clássico (F1) lê em `payload.hnb`; o Declarative usa `payload.notification`. */
export type PushPayload = {
  web_push: 8030;
  notification: {
    title: string;
    body?: string;
    navigate: string;
    lang: "pt-BR";
    dir: "auto";
    tag: string;
    silent: false;
    /** Ignorado onde não há suporte (Declarative/iOS: validar no E2E). */
    renotify: boolean;
    app_badge?: number;
  };
  hnb: {
    v: typeof PUSH_PAYLOAD_VERSION;
    type: NotificationType;
    notificationId: string;
    organizationId: string;
    /** Caminho relativo (`/app/abrir?org=…&to=…`) — o SW resolve contra a própria origem. */
    url: string;
    /** Destino final dentro da org (`/app/entrada?conversation=…`). */
    path: string;
    tag: string;
    renotify: boolean;
    badge?: number;
    actions?: { action: "assumir" | "abrir"; title: string; url: string }[];
  };
};

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;

/** Texto da tela de bloqueio: sem e-mail, telefone nem link (storage/mídia incluídos). */
export function lockScreenText(text: string): string {
  return scrubPii(text.replace(URL_RE, "[link]"));
}

export function openUrlPath(organizationId: string, path: string, extra?: Record<string, string>): string {
  const qs = new URLSearchParams({ org: organizationId, to: path, ...(extra ?? {}) });
  return `/app/abrir?${qs.toString()}`;
}

export function buildPushPayload(args: {
  notification: PushNotificationInput;
  /** `appUrl()` — o `navigate` do Declarative precisa ser absoluto. */
  appBaseUrl: string;
  /** Prévia permitida (membro `showPreview` × org `hidePreviewOnLockScreen` × 413). */
  showPreview: boolean;
  /** Nome da org no título quando o usuário está em mais de uma. */
  orgLabel?: string;
  badge?: number;
  renotify: boolean;
}): PushPayload {
  const n = args.notification;
  const path = pushTargetPath(n);
  const url = openUrlPath(n.organizationId, path);
  const tag = pushTagOf(n);
  const baseTitle = lockScreenText(n.title);
  const title = truncateGraphemes(args.orgLabel ? `${args.orgLabel} · ${baseTitle}` : baseTitle, 120);
  const rawBody = args.showPreview && n.body ? lockScreenText(n.body) : undefined;
  const body = rawBody ? truncateGraphemes(rawBody, BODY_MAX) : undefined;
  const badge = typeof args.badge === "number" ? Math.max(0, Math.min(PUSH_BADGE_CAP, Math.floor(args.badge))) : undefined;
  const actions =
    n.type === "handoff_requested"
      ? [
          { action: "assumir" as const, title: "Assumir", url: openUrlPath(n.organizationId, path, { acao: "assumir" }) },
          { action: "abrir" as const, title: "Abrir", url },
        ]
      : undefined;
  return {
    web_push: 8030,
    notification: {
      title,
      ...(body ? { body } : {}),
      navigate: `${args.appBaseUrl.replace(/\/+$/, "")}${url}`,
      lang: "pt-BR",
      dir: "auto",
      tag,
      silent: false,
      renotify: args.renotify,
      ...(badge !== undefined ? { app_badge: badge } : {}),
    },
    hnb: {
      v: PUSH_PAYLOAD_VERSION,
      type: n.type,
      notificationId: n._id,
      organizationId: n.organizationId,
      url,
      path,
      tag,
      renotify: args.renotify,
      ...(badge !== undefined ? { badge } : {}),
      ...(actions ? { actions } : {}),
    },
  };
}

/**
 * `renotify` (vibrar de novo): 1ª mensagem da conversa, ou ≥ 5 min desde o
 * último toque. O estado mora em `data.pushRenotify`, gravado pelo próprio
 * `createNotification` no patch do agrupamento (zero escrita extra).
 */
export function renotifyOf(data: Record<string, unknown> | undefined): boolean {
  return data?.pushRenotify !== false;
}

export function nextRenotifyState(
  prev: Record<string, unknown> | undefined,
  now: number
): { pushRenotify: boolean; pushRenotifyAt: number } {
  const last = typeof prev?.pushRenotifyAt === "number" ? prev.pushRenotifyAt : undefined;
  if (last === undefined || now - last >= PUSH_RENOTIFY_MS) return { pushRenotify: true, pushRenotifyAt: now };
  return { pushRenotify: false, pushRenotifyAt: last };
}

/** Patch silencioso: mantém o estado de renotify como estava (campos ausentes ficam ausentes). */
export function carriedRenotifyState(prev: Record<string, unknown> | undefined): Partial<{ pushRenotify: boolean; pushRenotifyAt: number }> {
  return {
    ...(typeof prev?.pushRenotify === "boolean" ? { pushRenotify: prev.pushRenotify } : {}),
    ...(typeof prev?.pushRenotifyAt === "number" ? { pushRenotifyAt: prev.pushRenotifyAt } : {}),
  };
}

export function pushRequestOptions(type: NotificationType, tag: string): { ttlSeconds: number; urgency: PushUrgency; topic: string } | null {
  const t = pushTemplateOf(type);
  if (!t) return null;
  return { ttlSeconds: t.ttlSeconds, urgency: t.urgency, topic: pushTopicOf(tag) };
}

// ---------------------------------------------------------------------------
// Resposta do serviço de push
// ---------------------------------------------------------------------------

export type PushOutcome =
  | "sent"
  | "gone" // 404/410: assinatura morta → apagar
  | "too_large" // 413: reenviar sem prévia
  | "retry" // 429/5xx/rede: reagendar (≤ 3×)
  | "failed"; // 400/401/403/outros: desiste (VAPID errado, payload inválido)

export function classifyPushStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 404 || status === 410) return "gone";
  if (status === 413) return "too_large";
  if (status === 429 || status >= 500) return "retry";
  return "failed";
}

/** `Retry-After` em segundos ou data HTTP → ms, limitado; ausente/inválido = undefined. */
export function parseRetryAfter(header: string | null | undefined, now: number): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, PUSH_RETRY_AFTER_MAX_MS);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, Math.min(at - now, PUSH_RETRY_AFTER_MAX_MS));
  return undefined;
}

/** Espera do reenvio depois da tentativa `attempt` (1-based); null = acabou. */
export function retryDelayMs(attempt: number, retryAfterMs?: number): number | null {
  if (attempt >= PUSH_MAX_ATTEMPTS) return null;
  const base = PUSH_RETRY_BACKOFF_MS[Math.min(attempt - 1, PUSH_RETRY_BACKOFF_MS.length - 1)];
  return Math.max(base, retryAfterMs ?? 0);
}

/** Dia UTC (`YYYY-MM-DD`) do contador de entrega. */
export function statsDayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Fragmento 0–7 do contador, estável por notificação. */
export function statsShardOf(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 8;
}
