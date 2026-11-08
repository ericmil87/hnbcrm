"use node";
/**
 * Web Push (E1) — o ÚNICO arquivo que lê `VAPID_PRIVATE_KEY`/`VAPID_SUBJECT`,
 * importa `web-push` e fala com o serviço de push (guard `pushPort.test.ts`).
 *
 * `web-push@3.6.7` (fixado; a 4.0.0 saiu em 06/11/2026) só CIFRA e ASSINA:
 * `generateRequestDetails` monta corpo aes128gcm (RFC 8291) + JWT VAPID
 * (RFC 8292) + `TTL`/`Urgency`/`Topic`; o envio é `fetch` com timeout, para a
 * resposta ser classificada aqui (`classifyPushStatus`) e os testes mockarem a
 * rede com `vi.stubGlobal("fetch")`.
 *
 * Nunca loga endpoint, chaves nem payload (o endpoint é capacidade do aparelho).
 */
import { v } from "convex/values";
import webpush from "web-push";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { classifyPushStatus, parseRetryAfter, PUSH_FETCH_TIMEOUT_MS, type PushOutcome } from "./lib/webPush";

type Vapid = { subject: string; publicKey: string; privateKey: string };

function vapidFromEnv(): Vapid | null {
  const subject = process.env.VAPID_SUBJECT?.trim();
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!subject || !publicKey || !privateKey) return null;
  return { subject, publicKey, privateKey };
}

type Target = { subscriptionId: Id<"pushSubscriptions">; endpoint: string; p256dh: string; auth: string };
type Options = { ttlSeconds: number; urgency: "very-low" | "low" | "normal" | "high"; topic: string };

async function sendOne(
  target: Target,
  payload: string,
  vapid: Vapid,
  opts: Options
): Promise<{ outcome: PushOutcome; retryAfterMs?: number }> {
  let details: ReturnType<typeof webpush.generateRequestDetails>;
  try {
    details = webpush.generateRequestDetails(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      payload,
      { vapidDetails: vapid, TTL: opts.ttlSeconds, urgency: opts.urgency, topic: opts.topic }
    );
  } catch {
    // Chave do aparelho corrompida/inválida: não há como cifrar para ela.
    return { outcome: "gone" };
  }
  try {
    const res = await fetch(details.endpoint, {
      method: details.method,
      headers: details.headers as Record<string, string>,
      body: details.body ? new Uint8Array(details.body) : undefined,
      signal: AbortSignal.timeout(PUSH_FETCH_TIMEOUT_MS),
    });
    const outcome = classifyPushStatus(res.status);
    return outcome === "retry"
      ? { outcome, retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), Date.now()) }
      : { outcome };
  } catch {
    // Rede/timeout: tenta de novo mais tarde.
    return { outcome: "retry" };
  }
}

export const internalSendPush = internalAction({
  args: {
    notificationId: v.id("notifications"),
    organizationId: v.id("organizations"),
    type: v.string(),
    attempt: v.number(),
    targets: v.array(
      v.object({
        subscriptionId: v.id("pushSubscriptions"),
        endpoint: v.string(),
        p256dh: v.string(),
        auth: v.string(),
      })
    ),
    payload: v.string(),
    /** Mesmo aviso sem prévia, para o 413 (payload grande demais). */
    fallbackPayload: v.optional(v.string()),
    ttlSeconds: v.number(),
    urgency: v.union(v.literal("very-low"), v.literal("low"), v.literal("normal"), v.literal("high")),
    topic: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const base = {
      notificationId: args.notificationId,
      organizationId: args.organizationId,
      type: args.type,
      attempt: args.attempt,
    };
    const vapid = vapidFromEnv();
    if (!vapid) {
      await ctx.runMutation(internal.push.internalRecordPushResults, { ...base, results: [], notConfigured: true });
      return null;
    }
    const opts = { ttlSeconds: args.ttlSeconds, urgency: args.urgency, topic: args.topic };
    const results = await Promise.all(
      args.targets.map(async (target) => {
        const first = await sendOne(target, args.payload, vapid, opts);
        if (first.outcome !== "too_large") return { subscriptionId: target.subscriptionId, ...first };
        if (!args.fallbackPayload) return { subscriptionId: target.subscriptionId, outcome: "failed" as const };
        const second = await sendOne(target, args.fallbackPayload, vapid, opts);
        return {
          subscriptionId: target.subscriptionId,
          ...(second.outcome === "too_large" ? { outcome: "failed" as const } : second),
          withoutPreview: second.outcome === "sent",
        };
      })
    );
    await ctx.runMutation(internal.push.internalRecordPushResults, { ...base, results });
    return null;
  },
});
