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

/**
 * VAPID do deployment, VALIDADO uma vez antes de qualquer envio: assunto sem
 * `mailto:`/`https:`, chave com `=` ou de tamanho errado faria
 * `generateRequestDetails` lançar para TODA assinatura — e isso nunca pode
 * ser tratado como problema do aparelho. Inválido = `null` (nada sai, nada é
 * apagado). O log leva só o nome do erro (a mensagem do web-push cita o assunto).
 */
function vapidFromEnv(): Vapid | null {
  const subject = process.env.VAPID_SUBJECT?.trim();
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!subject || !publicKey || !privateKey) return null;
  try {
    webpush.getVapidHeaders("https://fcm.googleapis.com", subject, publicKey, privateKey, "aes128gcm");
  } catch (e) {
    console.error(JSON.stringify({ event: "pushVapidInvalid", error: e instanceof Error ? e.name : "unknown" }));
    return null;
  }
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
    // Nunca "gone": o VAPID já foi validado, mas qualquer outra falha local de
    // cifra não prova que a assinatura morreu (só 404/410 do serviço provam).
    return { outcome: "failed" };
  }
  try {
    const res = await fetch(details.endpoint, {
      method: details.method,
      // `TTL` vem como número do web-push; `Content-Length` fica com o fetch.
      headers: Object.fromEntries(
        Object.entries(details.headers)
          .filter(([k]) => k.toLowerCase() !== "content-length")
          .map(([k, val]) => [k, String(val)])
      ),
      body: details.body ? new Uint8Array(details.body) : undefined,
      signal: AbortSignal.timeout(PUSH_FETCH_TIMEOUT_MS),
      // Serviço de push não redireciona; um 3xx não é seguido (classifica como "failed").
      redirect: "manual",
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

/**
 * Recebe SÓ ids (nada de endpoint, chave ou texto nos args agendados): alvos e
 * payload vêm de `push.internalGetPushSendPlan` na hora do envio.
 */
export const internalSendPush = internalAction({
  args: {
    notificationId: v.id("notifications"),
    subscriptionIds: v.array(v.id("pushSubscriptions")),
    attempt: v.number(),
    /** Reenvio sem prévia (reservado; o 413 já reenvia sem prévia na mesma execução). */
    noPreview: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const plan = await ctx.runQuery(internal.push.internalGetPushSendPlan, {
      notificationId: args.notificationId,
      subscriptionIds: args.subscriptionIds,
      ...(args.noPreview ? { noPreview: true } : {}),
    });
    if (plan.skip === "gone") return null;
    const base = {
      notificationId: args.notificationId,
      organizationId: plan.organizationId,
      type: plan.type,
      attempt: args.attempt,
    };
    if (plan.skip === "read") {
      await ctx.runMutation(internal.push.internalRecordPushResults, { ...base, results: [], suppressedRead: true });
      return null;
    }
    const vapid = vapidFromEnv();
    if (!vapid) {
      await ctx.runMutation(internal.push.internalRecordPushResults, { ...base, results: [], notConfigured: true });
      return null;
    }
    const opts = { ttlSeconds: plan.ttlSeconds, urgency: plan.urgency, topic: plan.topic };
    const fallbackPayload = plan.fallbackPayload;
    const results = await Promise.all(
      plan.targets.map(async (target) => {
        const first = await sendOne(target, plan.payload, vapid, opts);
        if (first.outcome !== "too_large") return { subscriptionId: target.subscriptionId, ...first };
        if (!fallbackPayload) return { subscriptionId: target.subscriptionId, outcome: "failed" as const };
        const second = await sendOne(target, fallbackPayload, vapid, opts);
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
