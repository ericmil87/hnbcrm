/**
 * Saúde dos canais bridge (T02): sinais graves do webhook + cron de 15 min.
 *
 * Antes: `LoggedOut`/`TemporaryBan`/`ClientOutdated` eram assinados e descartados
 * pelo parser, e nenhum cron checava a sessão — ban só aparecia quando o cliente
 * reclamava. Toda emissão passa por `lib/channelHealthSignals.ts`.
 */
import { v } from "convex/values";
import { cronsDisabled } from "./lib/cronGuard";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  bridgeFetchJson,
  configProvider,
} from "./channelConfigs";
import { decryptSecret } from "./lib/secretCrypto";
import {
  buildBridgeStatusRequest,
  mapBridgeSessionState,
  parseBridgeStatusResponse,
} from "./lib/bridgeSession";
import {
  decideCronObservation,
  describeSessionEvent,
  emitChannelSessionLost,
} from "./lib/channelHealthSignals";

/** Teto de canais por execução do cron; o resto segue por cursor + auto-reagendamento. */
export const CHANNEL_HEALTH_PAGE_SIZE = 50;
const PROBE_TIMEOUT_MS = 8_000;

// ── Webhook: LoggedOut / TemporaryBan / ClientOutdated ──────────────────────

export const internalRecordSessionEvent = internalMutation({
  args: {
    configId: v.id("channelConfigs"),
    event: v.union(v.literal("LoggedOut"), v.literal("TemporaryBan"), v.literal("ClientOutdated")),
    code: v.optional(v.number()),
    expiresInMs: v.optional(v.number()),
  },
  returns: v.object({ emitted: v.boolean() }),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config || configProvider(config) !== "bridge") return { emitted: false };
    const now = Date.now();
    const described = describeSessionEvent(
      { event: args.event, code: args.code, expiresInMs: args.expiresInMs },
      now
    );
    const emitted = await emitChannelSessionLost(ctx, {
      config,
      state: described.state,
      detail: described.detail,
      expiresAt: described.expiresAt,
      source: "webhook",
      now,
    });
    return { emitted };
  },
});

// ── Cron ────────────────────────────────────────────────────────────────────

const probeTargetValidator = v.object({
  configId: v.id("channelConfigs"),
  baseUrl: v.string(),
  // CIPHERTEXT — só trafega entre esta query interna e a action do cron, que
  // decifra na hora da sonda. Nunca vai a log nem a cliente.
  tokenEncrypted: v.string(),
});

/**
 * Uma página de canais elegíveis, já com o alvo da sonda.
 *
 * Perf Convex I/O (onda 2): pagina o índice `by_bridge_instance` só a partir
 * dos docs COM instância (`gt(undefined)` — na ordem do índice `undefined`
 * vem antes de qualquer valor), em vez da tabela inteira; canal Meta não tem
 * `bridgeInstanceId` e nem entra na leitura. Os filtros que restam são em
 * memória (sem `.filter()` de query): bridge, não desativado, credenciais
 * completas, que já esteve conectado alguma vez (canal esperando o 1º QR não é
 * "queda") e, por último — só para quem passou nos outros —, org que não é
 * demo. Devolve `baseUrl`/`tokenEncrypted` para a action não reler o canal
 * (antes era um `internalGetProbeTarget` por canal).
 */
export const internalListBridgeChannelsPage = internalQuery({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number() },
  returns: v.object({
    targets: v.array(probeTargetValidator),
    nextCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("channelConfigs")
      .withIndex("by_bridge_instance", (q) => q.gt("bridgeInstanceId", undefined))
      .paginate({ cursor: args.cursor, numItems: args.numItems });
    const targets: { configId: Id<"channelConfigs">; baseUrl: string; tokenEncrypted: string }[] = [];
    const demoCache = new Map<string, boolean>();
    for (const c of page.page) {
      if (configProvider(c) !== "bridge") continue;
      if (c.status === "disabled") continue;
      if (!c.bridgeBaseUrl || !c.bridgeTokenEncrypted) continue;
      if (c.bridgeConnectedAt === undefined && c.bridgeSessionState !== "connected") continue;
      let demo = demoCache.get(c.organizationId);
      if (demo === undefined) {
        const org = await ctx.db.get(c.organizationId);
        demo = (org?.settings as { demoMode?: boolean } | undefined)?.demoMode === true;
        demoCache.set(c.organizationId, demo);
      }
      if (demo) continue;
      targets.push({ configId: c._id, baseUrl: c.bridgeBaseUrl, tokenEncrypted: c.bridgeTokenEncrypted });
    }
    return { targets, nextCursor: page.isDone ? null : page.continueCursor, isDone: page.isDone };
  },
});

/**
 * Observação "fora do ar" do cron. Marca na 1ª vez, alerta quando persiste entre
 * execuções (duas seguidas), e depois nunca repete. Não sobrescreve um estado
 * grave já gravado pelo webhook (`logged_out` não vira "disconnected").
 */
export const internalApplyUnhealthyObservation = internalMutation({
  args: {
    configId: v.id("channelConfigs"),
    healthDetail: v.string(),
    // Estado sondado: "banned" é preservado; o resto cai em "disconnected".
    probedState: v.optional(v.string()),
  },
  returns: v.object({ action: v.string() }),
  handler: async (ctx, args) => {
    const config = await ctx.db.get(args.configId);
    if (!config || configProvider(config) !== "bridge" || config.status === "disabled") {
      return { action: "none" };
    }
    const now = Date.now();
    const decision = decideCronObservation({
      connected: false,
      storedState: config.bridgeSessionState,
      unhealthySince: config.bridgeUnhealthySince,
      alertedAt: config.bridgeSessionAlertedAt,
      now,
    });
    if (decision.action === "mark") {
      await ctx.db.patch(config._id, {
        bridgeUnhealthySince: now,
        lastHealthCheckAt: now,
        updatedAt: now,
      });
    } else if (decision.action === "alert") {
      await emitChannelSessionLost(ctx, {
        config,
        state: args.probedState === "banned" ? "banned" : "disconnected",
        detail: `${args.healthDetail} — fora do ar desde ${new Date(
          config.bridgeUnhealthySince ?? now
        ).toISOString()}.`,
        source: "cron",
        now,
      });
      await ctx.db.patch(config._id, { lastHealthCheckAt: now });
    }
    return { action: decision.action };
  },
});

/**
 * Cron "channel health" (15 min): sonda `GET /session/status` de cada canal
 * bridge elegível (MESMO builder/parser da health check manual), grava o
 * resultado e notifica só na TRANSIÇÃO. Falha de rede/HTTP do gateway NÃO conta
 * como número caído (seria um falso alarme em massa numa queda do gateway —
 * isso é assunto da Sentinela, T10). Meta: pulado.
 */
export const internalChannelHealthTick = internalAction({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ checked: v.number(), probeErrors: v.number() }),
  handler: async (ctx, args) => {
    if (cronsDisabled()) return { checked: 0, probeErrors: 0 };
    const page = await ctx.runQuery(internal.channelHealth.internalListBridgeChannelsPage, {
      cursor: args.cursor ?? null,
      numItems: CHANNEL_HEALTH_PAGE_SIZE,
    });
    let checked = 0;
    let probeErrors = 0;
    for (const target of page.targets) {
      const configId = target.configId;
      try {
        // O alvo veio da página: sem releitura por canal. A página pode ter
        // sido lida há um tick inteiro (até 50 × 8 s), então quem resolve um
        // canal desativado nesse meio-tempo são as MUTATIONS, que releem o doc:
        // `internalApplyUnhealthyObservation` sai sem nada com `disabled`, e
        // `internalRecordHealthCheck` sai sem gravar com `skipIfDisabled` (e,
        // em qualquer caminho, canal desativado nunca chama `claimBridgePhone`
        // — senão a sonda de um canal recém-deslocado, antes do logout,
        // desativaria o rival legítimo).
        const token = await decryptSecret(target.tokenEncrypted);
        const probe = await bridgeFetchJson(
          buildBridgeStatusRequest({ baseUrl: target.baseUrl, token }),
          { timeoutMs: PROBE_TIMEOUT_MS }
        );
        const status = parseBridgeStatusResponse(probe.httpOk, probe.status, probe.body);
        if (!status.ok) {
          probeErrors++;
          continue;
        }
        const mapped = mapBridgeSessionState({
          connected: status.connected,
          loggedIn: status.loggedIn,
          jid: status.jid,
        });
        if (mapped.state === "connected") {
          // Também limpa os marcadores de queda (ver internalRecordHealthCheck).
          await ctx.runMutation(internal.channelConfigs.internalRecordHealthCheck, {
            configId,
            ok: true,
            healthDetail: mapped.healthDetail,
            bridgeSessionState: "connected",
            skipIfDisabled: true,
            ...(mapped.phone ? { bridgePhone: mapped.phone, displayPhoneNumber: `+${mapped.phone}` } : {}),
          });
        } else {
          await ctx.runMutation(internal.channelHealth.internalApplyUnhealthyObservation, {
            configId,
            healthDetail: mapped.healthDetail,
            probedState: mapped.state,
          });
        }
        checked++;
      } catch (e) {
        probeErrors++;
        console.warn(
          `channel health: falha ao sondar ${configId}: ${e instanceof Error ? e.message : "erro"}`
        );
      }
    }
    if (!page.isDone && page.nextCursor) {
      await ctx.scheduler.runAfter(0, internal.channelHealth.internalChannelHealthTick, {
        cursor: page.nextCursor,
      });
    }
    return { checked, probeErrors };
  },
});
