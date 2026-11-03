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
} from "./channelConfigs";
import { decryptSecret } from "./lib/secretCrypto";
import { configTransport } from "./lib/channelTransport";
import {
  buildBridgeStatusRequest,
  mapBridgeSessionState,
  parseBridgeStatusResponse,
} from "./lib/bridgeSession";
import { desiredBridgePresence, type BridgeGlobalPresence } from "./lib/bridgeSend";
import { applyBridgePresence } from "./lib/bridgePresence";
import {
  decideCronObservation,
  describeSessionEvent,
  emitChannelSessionLost,
} from "./lib/channelHealthSignals";

/** Teto de canais por execução do cron; o resto segue por cursor + auto-reagendamento. */
export const CHANNEL_HEALTH_PAGE_SIZE = 50;
const PROBE_TIMEOUT_MS = 8_000;
/**
 * Prazo do tick: o limite de uma action é 600 s e o pior caso de uma página é
 * 50 × (sonda 8 s + presença 4 s) = 600 s. Passou daqui, o tick para e
 * reagenda a MESMA página pulando os canais já sondados.
 */
export const CHANNEL_HEALTH_TICK_DEADLINE_MS = 420_000;

// ── Presença global (celular continua tocando) ──────────────────────────────

// Helper comum (não é função Convex): o cron chama inline com o token em mãos.
export { applyBridgePresence };

const presenceValidator = v.union(v.literal("available"), v.literal("unavailable"));

/**
 * Aplica a presença desejada (`desiredBridgePresence`) de UM canal bridge.
 * Agendada depois do pareamento (o Connected do wuzapi anuncia "available" e a
 * nossa tem de chegar depois), no "Testar conexão" e quando o toggle muda. Sai
 * calada se não é bridge, está sem token, não está `active` ou a org é demo.
 */
export const internalBridgeApplyPresence = internalAction({
  args: { configId: v.id("channelConfigs") },
  returns: v.object({
    applied: v.boolean(),
    presence: v.union(presenceValidator, v.null()),
    reason: v.optional(v.string()),
  }),
  handler: async (
    ctx,
    args
  ): Promise<{ applied: boolean; presence: BridgeGlobalPresence | null; reason?: string }> => {
    try {
      const config = await ctx.runQuery(internal.channelConfigs.internalGetConfig, {
        configId: args.configId,
      });
      if (!config || configTransport(config) !== "bridge") {
        return { applied: false, presence: null, reason: "not_bridge" };
      }
      if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) {
        return { applied: false, presence: null, reason: "no_credentials" };
      }
      if (config.status !== "active") {
        return { applied: false, presence: null, reason: "inactive" };
      }
      if (
        await ctx.runQuery(internal.orgModules.internalIsDemoOrg, {
          organizationId: config.organizationId,
        })
      ) {
        return { applied: false, presence: null, reason: "demo" };
      }
      const presence = desiredBridgePresence(config);
      const token = await decryptSecret(config.bridgeTokenEncrypted);
      const res = await applyBridgePresence(config.bridgeBaseUrl, token, presence);
      if (!res.ok) {
        console.warn(`bridge presence: falha ao anunciar ${presence} em ${args.configId}: ${res.error}`);
        return { applied: false, presence, reason: res.error };
      }
      return { applied: true, presence };
    } catch (e) {
      const reason = e instanceof Error ? e.message : "erro";
      console.warn(`bridge presence: falha em ${args.configId}: ${reason}`);
      return { applied: false, presence: null, reason };
    }
  },
});

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
    if (!config || configTransport(config) !== "bridge") return { emitted: false };
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
  // Presença global a reafirmar quando o canal estiver conectado.
  presence: presenceValidator,
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
    const targets: {
      configId: Id<"channelConfigs">;
      baseUrl: string;
      tokenEncrypted: string;
      presence: BridgeGlobalPresence;
    }[] = [];
    const demoCache = new Map<string, boolean>();
    for (const c of page.page) {
      if (configTransport(c) !== "bridge") continue;
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
      targets.push({
        configId: c._id,
        baseUrl: c.bridgeBaseUrl,
        tokenEncrypted: c.bridgeTokenEncrypted,
        presence: desiredBridgePresence(c),
      });
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
    if (!config || configTransport(config) !== "bridge" || config.status === "disabled") {
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
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    // Retomada depois do prazo: quantos alvos desta MESMA página já foram sondados.
    skip: v.optional(v.number()),
  },
  returns: v.object({ checked: v.number(), probeErrors: v.number() }),
  handler: async (ctx, args) => {
    if (cronsDisabled()) return { checked: 0, probeErrors: 0 };
    const startedAt = Date.now();
    const pageCursor = args.cursor ?? null;
    const page = await ctx.runQuery(internal.channelHealth.internalListBridgeChannelsPage, {
      cursor: pageCursor,
      numItems: CHANNEL_HEALTH_PAGE_SIZE,
    });
    const skip = Math.max(0, Math.floor(args.skip ?? 0));
    let checked = 0;
    let probeErrors = 0;
    for (let i = skip; i < page.targets.length; i++) {
      // Prazo: para antes do limite de 600 s da action e reagenda a mesma
      // página a partir deste alvo — nada é descartado nem re-sondado.
      if (Date.now() - startedAt > CHANNEL_HEALTH_TICK_DEADLINE_MS) {
        await ctx.scheduler.runAfter(0, internal.channelHealth.internalChannelHealthTick, {
          cursor: pageCursor,
          skip: i,
        });
        return { checked, probeErrors };
      }
      const target = page.targets[i];
      const configId = target.configId;
      try {
        // O alvo veio da página: sem releitura por canal. A página pode ter
        // sido lida há um tick inteiro (até 50 × (8 s de sonda + 4 s de
        // presença), cortado pelo prazo de 420 s), então quem resolve um
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
          // Reafirma a presença global a cada tick: o wuzapi volta a anunciar
          // "available" a cada reconexão de socket (não assinamos `Connected`),
          // o que silencia o celular do cliente. Best effort — falha não conta
          // como erro de sonda.
          const presence = await applyBridgePresence(target.baseUrl, token, target.presence);
          if (!presence.ok) {
            console.warn(
              `channel health: falha ao anunciar presença ${target.presence} em ${configId}: ${presence.error}`
            );
          }
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
