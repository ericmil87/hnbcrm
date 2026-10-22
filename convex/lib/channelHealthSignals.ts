/**
 * Sinais de saúde do canal (T02) — ponto ÚNICO de emissão de "o número perdeu a
 * sessão". Dois produtores o usam: o webhook do bridge (`LoggedOut`,
 * `TemporaryBan`, `ClientOutdated`) e o cron de saúde (`channelHealth.ts`).
 *
 * Parte pura (decisão e texto) + `emitChannelSessionLost`, que recebe o ctx de
 * uma mutation. Quem chama decide SE é uma transição; o emissor ainda tem uma
 * trava de dedupe própria (`bridgeSessionAlertedAt`), então repetição de
 * webhook (o `LoggedOut` volta a cada reconexão) nunca notifica duas vezes.
 */
import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc } from "../_generated/dataModel";
import { createNotification } from "./notify";
import { pauseCampaignsForChannel } from "./campaignHooks";
import { pausePostCore } from "./groupPostOps";
import { isMembershipRevoked } from "./auth";
import { hasPermission, resolvePermissions, type Role } from "./permissions";
import { scheduleWebhookEvent } from "./webhookDispatch";
import { maskExternalId } from "./metaIdentity";

/**
 * Humanos com `settings:manage` que ainda fazem parte da org. Variante local
 * (não `membersWithPermission` dos grupos): aqui "busy" também recebe — só a
 * remoção corta o aviso.
 */
async function channelAdmins(ctx: MutationCtx, organizationId: Doc<"organizations">["_id"]) {
  const members = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) =>
      q.eq("organizationId", organizationId).eq("type", "human")
    )
    .collect();
  return members
    .filter(
      (m) =>
        !isMembershipRevoked(m) &&
        hasPermission(resolvePermissions(m.role as Role, m.permissions ?? undefined), "settings", "manage")
    )
    .slice(0, 25);
}

/** Estados "perdidos": o número NÃO envia nem recebe até alguém agir. */
const SESSION_LOST_STATES: readonly string[] = [
  "banned",
  "logged_out",
  "temporarily_banned",
  "outdated",
];

export function isSessionLostState(state: string | null | undefined): boolean {
  return !!state && SESSION_LOST_STATES.includes(state);
}

/** Quanto tempo o canal precisa ficar fora do ar, entre duas execuções do cron, para virar alerta. */
export const UNHEALTHY_PERSIST_MS = 10 * 60 * 1000;

// ── Texto dos eventos do whatsmeow ──────────────────────────────────────────

const TEMP_BAN_REASONS: Record<number, string> = {
  101: "enviou mensagens para gente demais",
  102: "foi bloqueado por muitos usuários",
  103: "criou grupos demais",
  104: "enviou a mesma mensagem muitas vezes",
  106: "usou lista de transmissão em excesso",
};

export type SessionEventInput = {
  event: "LoggedOut" | "TemporaryBan" | "ClientOutdated";
  code?: number;
  expiresInMs?: number;
};

export type DescribedSessionEvent = {
  state: "logged_out" | "temporarily_banned" | "outdated";
  detail: string;
  /** Epoch ms em que o banimento temporário expira (só TemporaryBan com duração). */
  expiresAt?: number;
};

/** Evento → estado gravado + texto curto PT-BR. Puro (`now` entra por argumento). */
export function describeSessionEvent(ev: SessionEventInput, now: number): DescribedSessionEvent {
  if (ev.event === "TemporaryBan") {
    const why = ev.code !== undefined ? TEMP_BAN_REASONS[ev.code] : undefined;
    const expiresAt = ev.expiresInMs ? now + ev.expiresInMs : undefined;
    const hours = ev.expiresInMs ? Math.max(1, Math.round(ev.expiresInMs / 3_600_000)) : undefined;
    return {
      state: "temporarily_banned",
      detail:
        `Número com banimento TEMPORÁRIO do WhatsApp${why ? ` (${why})` : ""}` +
        (hours ? ` — libera em cerca de ${hours} h.` : ".") +
        " Pare os envios até liberar.",
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
  if (ev.event === "ClientOutdated") {
    return {
      state: "outdated",
      detail:
        "O gateway do WhatsApp está desatualizado e o WhatsApp recusou a conexão — avise o suporte para atualizar o gateway.",
    };
  }
  return {
    state: "logged_out",
    detail:
      ev.code === 403
        ? "O aparelho principal do número foi removido — reconecte escaneando o QR."
        : "O número foi desconectado no aparelho (WhatsApp deslogado) — reconecte escaneando o QR.",
  };
}

/** `+55 ••• ••8753` — só os 4 últimos dígitos. Vazio quando não há número (self-hosted). */
export function maskPhoneDisplay(raw: string | null | undefined): string {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 6) return "";
  return `••••${digits.slice(-4)}`;
}

// ── Decisão do cron (puro) ──────────────────────────────────────────────────

export type CronObservationDecision =
  | { action: "clear" } // conectado: zera marcadores
  | { action: "mark" } // 1ª vez fora do ar: só marca, não notifica
  | { action: "alert" } // persistiu entre execuções: notifica UMA vez
  | { action: "none" }; // já alertado / já em estado perdido

/**
 * `Disconnected` transitório (o socket cai e volta) NÃO é grave: só vira alerta
 * se o canal for visto fora do ar em duas execuções seguidas do cron
 * (`unhealthySince` já gravado e velho o bastante). Repetição depois do alerta
 * não notifica de novo.
 */
export function decideCronObservation(args: {
  connected: boolean;
  storedState: string | null | undefined;
  unhealthySince: number | undefined;
  alertedAt: number | undefined;
  now: number;
}): CronObservationDecision {
  if (args.connected) return { action: "clear" };
  // O webhook já registrou um estado específico e alertou: não rebaixar nem repetir.
  if (isSessionLostState(args.storedState) || args.alertedAt !== undefined) return { action: "none" };
  if (args.unhealthySince === undefined) return { action: "mark" };
  if (args.now - args.unhealthySince >= UNHEALTHY_PERSIST_MS) return { action: "alert" };
  return { action: "none" };
}

// ── Emissor ─────────────────────────────────────────────────────────────────

export type EmitChannelSessionLostArgs = {
  config: Doc<"channelConfigs">;
  /** Valor gravado em `bridgeSessionState`. */
  state: "logged_out" | "temporarily_banned" | "outdated" | "disconnected" | "banned";
  detail: string;
  expiresAt?: number;
  source: "webhook" | "cron";
  now: number;
};

/**
 * Grava o estado e dispara TODOS os efeitos de "perdi a sessão", numa transação:
 * patch do canal, pausa de campanhas e publicações de grupo, auditoria `high`,
 * sino para quem tem `settings:manage` e webhook `channel.session_lost`.
 * Devolve `false` (sem efeitos além do detalhe) quando é repetição do mesmo estado.
 *
 * Não grava `activities`: a tabela exige `leadId` e canal não tem lead — a
 * trilha é o audit log.
 *
 * T10: opsAlerts pluga aqui (um único ponto para o alerta de operação).
 */
export async function emitChannelSessionLost(
  ctx: MutationCtx,
  args: EmitChannelSessionLostArgs
): Promise<boolean> {
  const { config, now } = args;
  const repeated =
    config.bridgeSessionState === args.state && config.bridgeSessionAlertedAt !== undefined;
  if (repeated) {
    await ctx.db.patch(config._id, {
      bridgeSessionDetail: args.detail,
      ...(args.expiresAt ? { bridgeSessionExpiresAt: args.expiresAt } : {}),
      updatedAt: now,
    });
    return false;
  }

  await ctx.db.patch(config._id, {
    bridgeSessionState: args.state,
    bridgeSessionDetail: args.detail,
    bridgeSessionExpiresAt: args.expiresAt,
    bridgeSessionAlertedAt: now,
    // NÃO mexe em `status`: o webhook de entrada descarta canal que não esteja
    // "active", e o socket pode voltar sozinho — as mensagens do cliente não
    // podem sumir. Quem trava envio é `bridgeSessionState`.
    healthDetail: args.detail,
    updatedAt: now,
  });

  // Campanhas: MESMO caminho do `claimBridgePhone` (v0.56).
  const pausedCampaigns = await pauseCampaignsForChannel(ctx, config._id, args.detail, now);

  // Publicações de grupo ativas neste canal (o worker só pausaria no próximo
  // disparo; aqui é na hora, e com o motivo certo).
  const posts = await ctx.db
    .query("groupPosts")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", config._id))
    .collect();
  let pausedPosts = 0;
  for (const post of posts) {
    if (post.status !== "active") continue;
    await pausePostCore(ctx, post, { now, reason: args.detail, automatic: true });
    pausedPosts++;
  }

  const phoneDisplay = maskPhoneDisplay(config.bridgePhone ?? config.displayPhoneNumber);

  await ctx.db.insert("auditLogs", {
    organizationId: config.organizationId,
    entityType: "channelConfig",
    entityId: config._id,
    action: "update",
    actorType: "system",
    changes: {
      before: { bridgeSessionState: config.bridgeSessionState ?? null },
      after: { bridgeSessionState: args.state },
    },
    metadata: {
      name: config.displayName,
      source: args.source,
      pausedCampaigns,
      pausedGroupPosts: pausedPosts,
    },
    description: `Canal '${config.displayName}' perdeu a sessão — ${args.detail}`,
    severity: "high",
    createdAt: now,
  });

  const members = await channelAdmins(ctx, config.organizationId);
  const org = members.length > 0 ? await ctx.db.get(config.organizationId) : null;
  for (const m of members) {
    await createNotification(ctx, {
      organizationId: config.organizationId,
      memberId: m._id,
      type: "channel_session_lost",
      title: `WhatsApp "${config.displayName}" perdeu a conexão`,
      body: args.detail,
      data: { channelConfigId: config._id, state: args.state },
    });
    // E-mail pelo MESMO gatilho do sino (o dedupe por `bridgeSessionAlertedAt`
    // acima vale para os dois). A preferência `channelSessionLost` é checada no
    // `dispatchNotification`. Sem token/URL/instância no payload.
    await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
      organizationId: config.organizationId,
      recipientMemberId: m._id,
      eventType: "channelSessionLost",
      templateData: {
        orgName: org?.name ?? "",
        channelName: config.displayName,
        phoneDisplay,
        state: args.state,
        detail: args.detail,
        expiresAt: args.expiresAt,
        pausedCampaigns,
        pausedGroupPosts: pausedPosts,
      },
    });
  }

  await scheduleWebhookEvent(ctx, {
    organizationId: config.organizationId,
    event: "channel.session_lost",
    payload: {
      channelConfigId: config._id,
      provider: "bridge",
      state: args.state,
      detail: args.detail,
      phoneDisplay,
    },
  });

  return true;
}

// ── Meta Messaging (Instagram/Messenger): credencial degradada (F4, D8) ─────

export type EmitChannelDegradedArgs = {
  connection: Doc<"metaConnections">;
  /** Configs da conexão (messenger e/ou instagram), já lidos por `by_meta_connection`. */
  configs: Doc<"channelConfigs">[];
  state: "reauth_required" | "data_access_expiring" | "revoked";
  detail: string;
  /** Quem detectou (só vale para `reauth_required`): decide se o cron pode recuperar sozinho. */
  source?: "health" | "send" | "test" | "subscribe";
  /** Campos extras do audit (ex.: origem do callback, ids mascarados). Nunca segredos. */
  auditExtra?: Record<string, unknown>;
  now: number;
};

/**
 * Generalização de `emitChannelSessionLost` para a CONEXÃO da Meta. Grava o
 * estado da conexão (nunca o `status` dos configs: o ingest segue) e dispara
 * audit `high`, sino (mesmo tipo/preferência `channel_session_lost`), e-mail e
 * webhook `channel.session_lost` (um por config, ids mascarados, sem token; só em
 * `reauth_required`, o aviso "expirando" não gera webhook).
 * Campanhas e publicações de grupo são só de WhatsApp: nada a pausar.
 *
 * Dedupe por `authAlertedAt`: `reauth_required` repetido não notifica de novo;
 * `data_access_expiring` avisa uma vez até a Meta renovar (o tick limpa o marcador).
 * Devolve `false` quando é repetição.
 */
export async function emitChannelDegraded(ctx: MutationCtx, args: EmitChannelDegradedArgs): Promise<boolean> {
  const { connection: conn, now } = args;
  // `revoked` (desautorização na Meta) sempre avisa: quem chama já pulou conexões revogadas.
  const repeated =
    args.state !== "revoked" &&
    conn.authAlertedAt !== undefined &&
    (args.state === "reauth_required" ? conn.authState === "reauth_required" : true);
  if (repeated) {
    // Texto atualizado sem reanunciar; um aviso "expirando" não rebaixa um reauth.
    if (args.state === "reauth_required") {
      await ctx.db.patch(conn._id, { authDetail: args.detail, updatedAt: now });
    }
    return false;
  }

  await ctx.db.patch(conn._id, {
    ...(args.state === "reauth_required"
      ? { authState: "reauth_required" as const, authSource: args.source ?? ("send" as const) }
      : {}),
    ...(args.state === "revoked" ? { authState: "revoked" as const, authSource: "deauthorize" as const } : {}),
    authDetail: args.state === "data_access_expiring" ? "data_access_expiring" : args.detail,
    authAlertedAt: now,
    updatedAt: now,
  });

  const pageName = conn.pageName ?? "Página";
  const label = `${pageName}${conn.igUsername ? ` / @${conn.igUsername}` : ""}`;
  const title =
    args.state === "revoked"
      ? `A autorização da Página ${label} foi removida`
      : args.state === "reauth_required"
      ? `Página ${label} precisa ser reconectada`
      : `Reconecte ${label} para manter o acesso`;

  await ctx.db.insert("auditLogs", {
    organizationId: conn.organizationId,
    entityType: "metaConnection",
    entityId: conn._id,
    action: "update",
    actorType: "system",
    changes: {
      before: { authState: conn.authState },
      after: {
        authState: args.state === "reauth_required" || args.state === "revoked" ? args.state : conn.authState,
      },
    },
    metadata: { fields: ["authState", "authDetail"], state: args.state, detail: args.detail, ...(args.auditExtra ?? {}) },
    description:
      args.state === "revoked"
        ? `A autorização da Página "${pageName}" (Instagram/Messenger) foi removida no Facebook`
        : args.state === "reauth_required"
        ? `A Página "${pageName}" (Instagram/Messenger) precisa ser reconectada`
        : `O acesso da Página "${pageName}" (Instagram/Messenger) está perto de expirar`,
    severity: "high",
    createdAt: now,
  });

  const members = await channelAdmins(ctx, conn.organizationId);
  const org = members.length > 0 ? await ctx.db.get(conn.organizationId) : null;
  for (const m of members) {
    await createNotification(ctx, {
      organizationId: conn.organizationId,
      memberId: m._id,
      type: "channel_session_lost",
      title,
      body: args.state !== "data_access_expiring" ? args.detail : "Reconecte a conta para manter o acesso às mensagens.",
      data: { metaConnectionId: conn._id, state: args.state },
    });
    await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
      organizationId: conn.organizationId,
      recipientMemberId: m._id,
      eventType: "channelSessionLost",
      templateData: {
        orgName: org?.name ?? "",
        channelName: label,
        provider: "meta_messaging",
        state: args.state,
        detail: args.state !== "data_access_expiring" ? args.detail : undefined,
      },
    });
  }

  // "Expirando" é aviso, não perda: sem webhook `channel.session_lost`.
  if (args.state === "data_access_expiring") return true;
  for (const config of args.configs) {
    if (config.channel !== "instagram" && config.channel !== "messenger") continue;
    const accountId = config.channel === "instagram" ? config.instagramAccountId : config.messengerPageId;
    await scheduleWebhookEvent(ctx, {
      organizationId: conn.organizationId,
      event: "channel.session_lost",
      payload: {
        channelConfigId: config._id,
        provider: config.channel,
        state: args.state,
        detail: args.detail,
        accountMasked: accountId ? maskExternalId(accountId) : "",
      },
    });
  }
  return true;
}
