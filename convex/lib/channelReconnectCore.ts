/**
 * Reconnect core of a bridge (wuzapi) WhatsApp channel — v0.78, no session.
 *
 * The body of `channelConfigs.getBridgeQrCode` (status → connect → qr → on
 * loggedIn: phone + `internalRecordHealthCheck(connected)` with
 * `claimBridgePhone` + presence at +2 s/+30 s), extracted so the Telegram flow
 * (`telegramReconnect.ts`, authorized in `lib/telegramActions.ts`) and the web
 * action share ONE path. Callers authorize before calling; this never checks
 * `ctx.auth`. The instance token is decrypted only here and never returned;
 * the QR / linking code are returned to the caller and never persisted or logged.
 *
 * `phase:"start"` issues a QR (`mode:"qr"`) or a pairing code (`mode:"code"`,
 * `POST /session/pairphone` with the channel's phone digits). `phase:"poll"`
 * only reads `/session/status` (and, in QR mode, the current QR) — a poll must
 * never request a new code.
 */
import { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { decryptSecret } from "./secretCrypto";
import { BRIDGE_PRESENCE_AFTER_CONNECT_MS, bridgeFetchJson, resolveBridgePhone } from "./bridgeGateway";
import {
  buildBridgeConnectRequest,
  buildBridgePairPhoneRequest,
  buildBridgeQrRequest,
  buildBridgeStatusRequest,
  mapBridgeSessionState,
  parseBridgePairPhoneResponse,
  parseBridgeQrResponse,
  parseBridgeStatusResponse,
  type BridgeSessionState,
} from "./bridgeSession";

/** Only these lost states are fixed by pairing again (banned/outdated/temporarily_banned are not). */
export const RECONNECTABLE_STATES: readonly BridgeSessionState[] = ["logged_out", "disconnected"];
export function isReconnectableState(state: string | undefined): boolean {
  return state !== undefined && (RECONNECTABLE_STATES as readonly string[]).includes(state);
}

/**
 * A pairing already under way (`qr`/`connecting`, written by a previous attempt's
 * QR step): a new attempt or "Tentar de novo" must be accepted, or an expired QR
 * attempt would lock the channel. The card still offers the button only for the
 * lost states above.
 */
export function canStartReconnect(state: string | undefined): boolean {
  return isReconnectableState(state) || state === "qr" || state === "connecting";
}

export type ReconnectStep = {
  state: "connected" | "qr" | "code" | "waiting" | "error";
  /** The `bridgeSessionState` this step observed (the web action returns it as before). */
  sessionState: BridgeSessionState;
  qrCode?: string;
  linkingCode?: string;
  displayPhoneNumber?: string;
  displacedFrom?: string[];
  /** `"sem_telefone"` = code mode without the channel's phone (callers fall back to QR). */
  error?: string;
};

export const NO_PHONE_ERROR = "sem_telefone";
const STATUS_TIMEOUT_MS = 10_000;

export async function runBridgeReconnectStep(
  ctx: ActionCtx,
  args: {
    /** Only the fields used here (the Telegram run carries no more than this). */
    config: Pick<Doc<"channelConfigs">, "_id" | "bridgeBaseUrl" | "bridgeTokenEncrypted" | "bridgeInstanceId">;
    mode: "qr" | "code";
    phase?: "start" | "poll";
    /** Code mode: the channel's number, digits only (`channelConfigs.bridgePhone`). */
    phoneDigits?: string;
  },
): Promise<ReconnectStep> {
  const { config } = args;
  const phase = args.phase ?? "start";
  const configId: Id<"channelConfigs"> = config._id;
  if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) {
    return { state: "error", sessionState: "disconnected", error: "Configuração bridge incompleta — reconfigure o canal" };
  }

  // Devolve os nomes das contas que perderam o número para este pareamento.
  const record = async (state: BridgeSessionState, ok: boolean, healthDetail: string, phone?: string): Promise<string[]> =>
    await ctx.runMutation(internal.channelConfigs.internalRecordHealthCheck, {
      configId,
      ok,
      displayPhoneNumber: phone ? `+${phone}` : undefined,
      bridgePhone: phone,
      healthDetail,
      bridgeSessionState: state,
    });

  // O handler `Connected` do wuzapi anuncia "available" (silencia o celular);
  // a nossa presença precisa chegar DEPOIS dele.
  const scheduleApplyPresence = async () => {
    for (const delayMs of BRIDGE_PRESENCE_AFTER_CONNECT_MS) {
      await ctx.scheduler.runAfter(delayMs, internal.channelHealth.internalBridgeApplyPresence, { configId });
    }
  };

  const connected = async (baseUrl: string, jid: string | undefined): Promise<ReconnectStep> => {
    const mapped = mapBridgeSessionState({ connected: true, loggedIn: true, jid });
    // Pareamento concluído: é AQUI que a exclusividade precisa valer (claimBridgePhone no record).
    const phone = await resolveBridgePhone({ fromStatusJid: jid, baseUrl, instanceId: config.bridgeInstanceId });
    const displaced = await record("connected", true, phone ? `Conectado como +${phone}` : mapped.healthDetail, phone);
    await scheduleApplyPresence();
    return {
      state: "connected",
      sessionState: "connected",
      ...(phone ? { displayPhoneNumber: `+${phone}` } : {}),
      ...(displaced.length > 0 ? { displacedFrom: displaced } : {}),
    };
  };

  try {
    const token = await decryptSecret(config.bridgeTokenEncrypted);
    const baseUrl = config.bridgeBaseUrl;

    // Already paired + online? Nothing to scan — reflect "connected".
    const probe = await bridgeFetchJson(buildBridgeStatusRequest({ baseUrl, token }), { timeoutMs: STATUS_TIMEOUT_MS });
    const status = parseBridgeStatusResponse(probe.httpOk, probe.status, probe.body);
    const probedJid = status.ok ? status.jid : undefined;
    if (status.ok && status.loggedIn && status.connected) return await connected(baseUrl, status.jid);

    if (phase === "poll") {
      if (args.mode === "code") return { state: "waiting", sessionState: "connecting" };
      const qrProbe = await bridgeFetchJson(buildBridgeQrRequest({ baseUrl, token }));
      const qr = parseBridgeQrResponse(qrProbe.httpOk, qrProbe.status, qrProbe.body);
      if (qr.ok && qr.loggedIn && !qr.qrCode) return await connected(baseUrl, probedJid);
      if (qr.ok && qr.qrCode) return { state: "qr", sessionState: "qr", qrCode: qr.qrCode };
      return { state: "waiting", sessionState: "connecting" };
    }

    if (args.mode === "code") {
      const digits = (args.phoneDigits ?? "").replace(/\D/g, "");
      if (digits.length < 10) return { state: "error", sessionState: "disconnected", error: NO_PHONE_ERROR };
      // The pairphone handler does not check IsConnected: bring the socket up first.
      if (!(status.ok && status.connected)) {
        await bridgeFetchJson(buildBridgeConnectRequest({ baseUrl, token })).catch(() => undefined);
      }
      const res = await bridgeFetchJson(buildBridgePairPhoneRequest(baseUrl, token, digits));
      const parsed = parseBridgePairPhoneResponse(res.body);
      // "already paired" race: logged in between the status probe and pairphone.
      if (parsed.loggedIn && !parsed.linkingCode) return await connected(baseUrl, probedJid);
      if (!res.httpOk || !parsed.linkingCode) {
        return { state: "error", sessionState: "disconnected", error: parsed.error ?? `HTTP ${res.status}` };
      }
      return { state: "code", sessionState: "connecting", linkingCode: parsed.linkingCode };
    }

    // QR (also the web action): bring the session up so a QR is issued, then fetch it.
    // A connect failure is non-fatal — the QR endpoint may still work.
    await bridgeFetchJson(buildBridgeConnectRequest({ baseUrl, token })).catch(() => undefined);
    const qrProbe = await bridgeFetchJson(buildBridgeQrRequest({ baseUrl, token }));
    const qr = parseBridgeQrResponse(qrProbe.httpOk, qrProbe.status, qrProbe.body);
    if (!qr.ok) {
      await record("disconnected", false, qr.error);
      return { state: "error", sessionState: "disconnected", error: qr.error };
    }
    // The instance may have logged in between the two calls.
    if (qr.loggedIn && !qr.qrCode) return await connected(baseUrl, probedJid);
    const mapped = mapBridgeSessionState({ connected: false, loggedIn: false, hasQr: !!qr.qrCode });
    await record(mapped.state, false, mapped.healthDetail);
    return {
      state: qr.qrCode ? "qr" : "waiting",
      sessionState: mapped.state,
      ...(qr.qrCode ? { qrCode: qr.qrCode } : { error: mapped.healthDetail }),
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : "Falha ao obter o QR do gateway";
    if (phase === "poll") return { state: "waiting", sessionState: "connecting" };
    // Review v0.78 #8: a network error says nothing about the session — in code mode
    // (Telegram) the alerted `logged_out` must not become `disconnected`. The web QR
    // path keeps its historic behaviour.
    if (args.mode === "qr") await record("disconnected", false, error);
    return { state: "error", sessionState: "disconnected", error };
  }
}
