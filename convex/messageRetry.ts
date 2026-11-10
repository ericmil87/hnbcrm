/**
 * "Tentar novamente" manual de uma mensagem de WhatsApp que falhou na entrega.
 *
 * Fluxo (action porque a checagem do número é rede):
 *   `retryFailedMessage` (action pública)
 *     → `internalPrepareRetry` (query: RBAC `inbox:reply` + todas as guardas)
 *     → `checkBridgeNumber` (só quando o último erro foi `recipient_not_found`
 *        ou o contato está marcado "sem WhatsApp")
 *     → `internalCommitRetry` (mutation: re-roda as guardas, aplica o veredito,
 *        zera o estado de falha, despacha pela PORTA `scheduleOutboundDispatch`,
 *        atividade + auditoria)
 *
 * Regra de proteção das contas: um humano NUNCA reenvia às cegas para número
 * que o WhatsApp já recusou — a checagem manda; sem confirmação, recusa.
 * Teto de 3 reenvios manuais por mensagem; recusa com reenvio em curso.
 */
import { v, type Infer } from "convex/values";
import { action, internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { configProvider } from "./channelConfigs";
import { resolveConversationChannelConfig } from "./lib/channelResolve";
import { isSessionLostState } from "./lib/channelHealthSignals";
import { assertGroupConversationSendable } from "./lib/groupGuard";
import { normalizeCampaignPhone } from "./lib/phone";
import { resolveDefaultCountry } from "./lib/orgPhone";
import { scheduleOutboundDispatch } from "./lib/outboundDispatch";
import { decryptSecret } from "./lib/secretCrypto";
import { checkBridgeNumber } from "./lib/bridgeNumberCheck";
import {
  MAX_MANUAL_RETRIES,
  MAX_NUMBER_CHECKS,
  NUMBER_CHECK_WAIT_MS,
  RETRY_REFUSAL_TEXT,
  manualRetriesOf,
  needsDeliveredAck,
  metadataForRetry,
  type RetryRefusalReason,
} from "./lib/messageRetry";
import {
  applyCanonicalNumberToContact,
  contactOfConversation,
  HUMAN_ACK_REQUIRED_ERROR,
  digitsOf,
  isAutomatedSendBlocked,
  isMarkedNotOnWhatsapp,
  notFoundFailCount,
  isOptedOutAnySpelling,
  isSpellingOfSameNumber,
  reserveWhatsappLookup,
  setWhatsappCheck,
} from "./lib/whatsappCheck";
import { translationOf } from "./lib/translationGate";

const reasonValidator = v.union(
  v.literal("not_found"),
  v.literal("not_failed"),
  v.literal("in_flight"),
  v.literal("limit"),
  v.literal("opt_out"),
  v.literal("not_on_whatsapp"),
  v.literal("check_unavailable"),
  v.literal("not_sendable"),
  v.literal("translation_pending"),
  v.literal("channel_unavailable"),
  v.literal("maybe_delivered"),
  v.literal("check_wait")
);

const refusalValidator = v.object({
  ok: v.literal(false),
  reason: reasonValidator,
  message: v.string(),
  // Só em `check_wait`/`limit` de checagem: quando uma nova checagem é aceita (ms epoch).
  retryAfter: v.optional(v.number()),
});

/** Resultado que a UI renderiza. */
export const retryResultValidator = v.union(
  v.object({ ok: v.literal(true), correctedNumber: v.boolean() }),
  refusalValidator
);

type Refusal = { ok: false; reason: RetryRefusalReason; message: string; retryAfter?: number };
const refuse = (reason: RetryRefusalReason, message?: string, retryAfter?: number): Refusal => ({
  ok: false,
  reason,
  message: message ?? RETRY_REFUSAL_TEXT[reason],
  ...(retryAfter !== undefined ? { retryAfter } : {}),
});

type RetryContext = {
  ok: true;
  member: Doc<"teamMembers">;
  message: Doc<"messages">;
  conversation: Doc<"conversations">;
  contact: Doc<"contacts"> | null;
  toPhone: string | null;
  /** Checagem no gateway exigida antes do reenvio (bridge 1:1). */
  needsCheck: boolean;
  bridge: { baseUrl: string; tokenEncrypted: string } | null;
};

/** Todas as guardas do reenvio; a mesma função roda na query e na mutation. */
async function evaluateRetry(
  ctx: QueryCtx | MutationCtx,
  messageId: Id<"messages">,
  maybeDeliveredAck?: boolean
): Promise<RetryContext | Refusal> {
  const message = await ctx.db.get(messageId);
  if (!message) return refuse("not_found");
  // RBAC: responder ao cliente = `inbox:reply` (mesmo nível de enviar/encaminhar).
  const member = await requirePermission(ctx, message.organizationId, "inbox", "reply");
  const conversation = await ctx.db.get(message.conversationId);
  if (!conversation || conversation.organizationId !== message.organizationId) return refuse("not_found");
  // O aceite de "pode já ter sido entregue" é de uma PESSOA, nunca de membro de IA.
  if (maybeDeliveredAck === true && member.type === "ai") return refuse("maybe_delivered", HUMAN_ACK_REQUIRED_ERROR);

  if (conversation.channel !== "whatsapp" || message.direction !== "outbound" || message.isInternal) {
    return refuse("not_sendable");
  }
  if (message.externalId) return refuse("not_failed");
  if (!message.deliveryStatus) return refuse("in_flight");
  if (message.deliveryStatus !== "failed") return refuse("not_failed");

  // Mensagem de campanha: quem reenvia é a campanha (Meta 131049 volta o destinatário
  // para `pending`; no bridge, "Reenviar falhas" cria OUTRA mensagem). O reenvio da
  // bolha seria o 2º envio.
  const campaignRow = await ctx.db
    .query("campaignRecipients")
    .withIndex("by_message", (q) => q.eq("messageId", message._id))
    .first();
  if (campaignRow || message.metadata?.campaign) {
    return refuse(
      "not_sendable",
      "Esta mensagem é de uma campanha — o reenvio é feito pela tela da campanha (Reenviar falhas), para não duplicar o envio"
    );
  }

  const t = translationOf(message);
  if (t?.role === "outbound" && (t.status === "pending" || t.status === "failed")) {
    return refuse("translation_pending");
  }
  if (manualRetriesOf(message) >= MAX_MANUAL_RETRIES) return refuse("limit");
  // A mensagem pode já ter sido entregue (timeout/5xx/200 sem id): reenviar duplica.
  if (needsDeliveredAck(message.metadata) && maybeDeliveredAck !== true) return refuse("maybe_delivered");

  try {
    await assertGroupConversationSendable(ctx, conversation);
  } catch (e) {
    return refuse("not_sendable", e instanceof Error ? e.message : undefined);
  }

  const isGroup = conversation.kind === "group";
  const contact = await contactOfConversation(ctx, conversation);
  const toPhone = isGroup ? conversation.externalChatId ?? null : contact?.whatsappNumber ?? contact?.phone ?? null;
  if (!toPhone) return refuse("not_sendable", "Contato sem número de telefone — não é possível enviar via WhatsApp");

  if (!isGroup) {
    // Contato sem DDI (`11987654321`) casa com opt-out guardado como `5511987654321`.
    const org = await ctx.db.get(message.organizationId);
    const normalized = normalizeCampaignPhone(toPhone, resolveDefaultCountry(org?.settings));
    if (
      (await isOptedOutAnySpelling(ctx, message.organizationId, toPhone)) ||
      (normalized.ok && (await isOptedOutAnySpelling(ctx, message.organizationId, normalized.phone)))
    ) {
      return refuse("opt_out");
    }
  }

  const config = await resolveConversationChannelConfig(ctx, conversation);
  if (!config || config.status !== "active") return refuse("channel_unavailable");
  const bridge = config.channel === "whatsapp" && configProvider(config) === "bridge";
  if (bridge && (isSessionLostState(config.bridgeSessionState) || config.bridgeSessionState === "disconnected")) {
    return refuse("channel_unavailable");
  }

  const lastKind = message.metadata?.deliveryErrorKind;
  // Contato que o dispatch bloquearia (marcador OU 2+ `no LID` seguidos, só no bridge):
  // sem uma checagem POSITIVA do número a mensagem falharia no gate e gastaria uma
  // tentativa à toa — então a checagem é exigida antes (e o aceite nunca é carimbado
  // pelo retry: quem destrava é a confirmação do gateway, que zera o contador).
  const blocked = !isGroup && bridge && isAutomatedSendBlocked(contact, toPhone);
  const needsCheck = !isGroup && (lastKind === "recipient_not_found" || blocked);
  // Sem gateway para perguntar (Meta) e marcado "sem WhatsApp": não reenvia.
  if (needsCheck && !bridge) return refuse("not_on_whatsapp");
  if (needsCheck && (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted)) return refuse("check_unavailable");

  return {
    ok: true,
    member,
    message,
    conversation,
    contact,
    toPhone,
    needsCheck,
    bridge:
      needsCheck && config.bridgeBaseUrl && config.bridgeTokenEncrypted
        ? { baseUrl: config.bridgeBaseUrl, tokenEncrypted: config.bridgeTokenEncrypted }
        : null,
  };
}

const prepareResultValidator = v.union(
  refusalValidator,
  v.object({
    ok: v.literal(true),
    check: v.union(
      v.null(),
      v.object({ phone: v.string(), baseUrl: v.string(), tokenEncrypted: v.string() })
    ),
  })
);

/**
 * Preparação = MUTATION que RESERVA a consulta ao gateway: `numberChecks` (teto 3)
 * e espera mínima de 10 min entre consultas ficam na mensagem, então cliques
 * repetidos ou simultâneos (OCC no doc da mensagem) nunca fazem duas rodadas de
 * `/user/check` + `/user/lid`. Contato já marcado `not_on_whatsapp` para o número
 * atual há menos de 10 min: recusa sem consultar.
 */
export const internalPrepareRetry = internalMutation({
  args: { messageId: v.id("messages"), maybeDeliveredAck: v.optional(v.boolean()) },
  returns: prepareResultValidator,
  handler: async (ctx, args) => {
    const r = await evaluateRetry(ctx, args.messageId, args.maybeDeliveredAck);
    if (!r.ok) return r;
    if (!r.bridge || !r.toPhone) return { ok: true as const, check: null };

    const now = Date.now();
    const meta = (r.message.metadata ?? {}) as Record<string, any>;
    const marker = r.contact?.whatsappCheck;
    if (marker && isMarkedNotOnWhatsapp(r.contact, r.toPhone) && now - marker.checkedAt < NUMBER_CHECK_WAIT_MS) {
      return refuse("not_on_whatsapp", undefined, marker.checkedAt + NUMBER_CHECK_WAIT_MS);
    }
    const used = typeof meta.numberChecks === "number" ? meta.numberChecks : 0;
    if (used >= MAX_NUMBER_CHECKS) {
      return refuse(
        "limit",
        "Já conferimos este número no WhatsApp várias vezes sem sucesso — confira o número do contato por outro canal"
      );
    }
    const last = typeof meta.lastNumberCheckAt === "number" ? meta.lastNumberCheckAt : undefined;
    if (last !== undefined && now - last < NUMBER_CHECK_WAIT_MS) {
      return refuse("check_wait", undefined, last + NUMBER_CHECK_WAIT_MS);
    }
    // Orçamento POR CONTATO (compartilhado com o self-heal e as boas-vindas):
    // outras mensagens falhas do mesmo contato não somam mais rodadas.
    if (!r.contact) return refuse("check_unavailable");
    const reservation = await reserveWhatsappLookup(ctx, r.contact._id, now);
    if (!reservation.ok) {
      return reservation.reason === "wait"
        ? refuse("check_wait", undefined, reservation.retryAfter)
        : refuse(
            "limit",
            "Este número já foi conferido no WhatsApp o máximo de vezes hoje — tente amanhã ou confirme o número por outro canal",
            reservation.retryAfter
          );
    }
    await ctx.db.patch(r.message._id, {
      metadata: { ...meta, numberChecks: used + 1, lastNumberCheckAt: now },
    });
    return { ok: true as const, check: { phone: digitsOf(r.toPhone), ...r.bridge } };
  },
});

const checkOutcomeValidator = v.union(
  v.object({ status: v.literal("on_whatsapp"), canonicalPhone: v.string() }),
  v.object({ status: v.literal("not_on_whatsapp") }),
  v.object({ status: v.literal("check_failed"), error: v.string() })
);

export const internalCommitRetry = internalMutation({
  args: {
    messageId: v.id("messages"),
    // Número que a action perguntou ao gateway (a mutation confere que não mudou).
    checkedPhone: v.optional(v.string()),
    check: v.optional(checkOutcomeValidator),
    maybeDeliveredAck: v.optional(v.boolean()),
  },
  returns: retryResultValidator,
  handler: async (ctx, args) => {
    const r = await evaluateRetry(ctx, args.messageId, args.maybeDeliveredAck);
    if (!r.ok) return r;
    const now = Date.now();
    let corrected = false;

    if (r.needsCheck) {
      const current = digitsOf(r.toPhone);
      if (!args.check || args.check.status === "check_failed") return refuse("check_unavailable");
      // O número mudou entre a pergunta e agora: a resposta não vale mais.
      if (digitsOf(args.checkedPhone) !== current) return refuse("check_unavailable");
      if (args.check.status === "not_on_whatsapp") {
        if (r.contact) await setWhatsappCheck(ctx, r.contact._id, "not_on_whatsapp", now, current);
        return refuse("not_on_whatsapp");
      }
      const canonical = args.check.canonicalPhone;
      // Telefone devolvido que não é grafia do número perguntado (mapa de LID
      // errado): inconclusivo — não reescreve o contato nem reenvia.
      if (!isSpellingOfSameNumber(current, canonical)) return refuse("check_unavailable");
      // O último envio deu `no LID found` e o gateway agora diz que ESTE mesmo número
      // existe: contraditório (o self-heal trata como `inconclusive`). Não marca
      // `verified` nem reenvia a um JID que o WhatsApp acabou de recusar.
      if (
        canonical === current &&
        (r.message.metadata?.deliveryErrorKind === "recipient_not_found" || notFoundFailCount(r.contact, current) > 0)
      ) {
        return refuse(
          "check_unavailable",
          "O WhatsApp confirma este número, mas o último envio foi recusado — não vamos reenviar agora. Confira o número com o contato por outro canal"
        );
      }
      if (r.contact && canonical !== current) {
        corrected = await applyCanonicalNumberToContact(ctx, r.contact, canonical, {
          now,
          via: "manual_retry",
          actorId: r.member._id,
          actorType: "human",
          ...(r.message.leadId ? { leadId: r.message.leadId } : {}),
        });
      } else if (r.contact) {
        // O gateway confirmou o número atual: libera o marcador.
        await setWhatsappCheck(ctx, r.contact._id, "verified", now, current);
      }
    }

    const retries = manualRetriesOf(r.message) + 1;
    await ctx.db.patch(r.message._id, {
      // Pendente de novo: a UI mostra "enviando" e a guarda de idempotência do
      // dispatcher deixa o reenvio passar.
      deliveryStatus: undefined,
      metadata: {
        ...metadataForRetry(r.message.metadata),
        manualRetries: retries,
        manualRetry: { at: now, by: r.member._id },
      },
    });

    await ctx.db.insert("auditLogs", {
      organizationId: r.message.organizationId,
      entityType: "message",
      entityId: r.message._id,
      action: "update",
      actorId: r.member._id,
      actorType: "human",
      metadata: {
        conversationId: r.conversation._id,
        manualRetry: retries,
        previousErrorKind: r.message.metadata?.deliveryErrorKind,
        numberChecked: r.needsCheck,
        numberCorrected: corrected,
        ...(needsDeliveredAck(r.message.metadata) ? { maybeDeliveredAck: true } : {}),
      },
      description: `Reenvio manual de mensagem com falha de entrega (tentativa ${retries} de ${MAX_MANUAL_RETRIES})`,
      // Aceite de "pode já ter sido entregue" = decisão de risco: severidade alta, como o outro aceite.
      severity: needsDeliveredAck(r.message.metadata) ? "high" : "low",
      createdAt: now,
    });
    if (r.message.leadId) {
      await ctx.db.insert("activities", {
        organizationId: r.message.organizationId,
        leadId: r.message.leadId,
        type: "note",
        actorId: r.member._id,
        actorType: "human",
        content: `Reenvio manual da mensagem no WhatsApp (tentativa ${retries} de ${MAX_MANUAL_RETRIES})`,
        metadata: { conversationId: r.conversation._id, messageId: r.message._id },
        createdAt: now,
      });
    }

    // PORTA única: pacing por conversa + por número (e tradução, se aplicável).
    await scheduleOutboundDispatch(ctx, r.conversation, r.message._id);
    return { ok: true as const, correctedNumber: corrected };
  },
});

/**
 * Botão "Tentar novamente". Devolve `{ok:true, correctedNumber}` ou
 * `{ok:false, reason, message}` (PT-BR, pronto para exibir). Erro de permissão
 * ou de organização LANÇA (mesmo comportamento das demais mutations do inbox).
 */
export const retryFailedMessage = action({
  args: {
    messageId: v.id("messages"),
    // Aceite de que a mensagem pode já ter sido entregue (erro `ambiguous`).
    maybeDeliveredAck: v.optional(v.boolean()),
  },
  returns: retryResultValidator,
  handler: async (ctx, args): Promise<Infer<typeof retryResultValidator>> => {
    const ack = args.maybeDeliveredAck === true ? { maybeDeliveredAck: true } : {};
    const plan: Infer<typeof prepareResultValidator> = await ctx.runMutation(internal.messageRetry.internalPrepareRetry, {
      messageId: args.messageId,
      ...ack,
    });
    if (!plan.ok) return plan;

    let commitArgs: {
      messageId: Id<"messages">;
      checkedPhone?: string;
      check?:
        | { status: "on_whatsapp"; canonicalPhone: string }
        | { status: "not_on_whatsapp" }
        | { status: "check_failed"; error: string };
    } = { messageId: args.messageId };

    if (plan.check) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      let outcome: NonNullable<typeof commitArgs.check>;
      try {
        const token = await decryptSecret(plan.check.tokenEncrypted);
        const res = await checkBridgeNumber({
          baseUrl: plan.check.baseUrl,
          token,
          phone: plan.check.phone,
          signal: controller.signal,
        });
        outcome = !res.ok
          ? { status: "check_failed", error: res.error }
          : res.onWhatsapp
            ? { status: "on_whatsapp", canonicalPhone: res.canonicalPhone }
            : { status: "not_on_whatsapp" };
      } catch (e) {
        outcome = { status: "check_failed", error: e instanceof Error ? e.message.slice(0, 200) : "Erro de rede" };
      } finally {
        clearTimeout(timer);
      }
      commitArgs = { messageId: args.messageId, checkedPhone: plan.check.phone, check: outcome };
    }
    const result: Infer<typeof retryResultValidator> = await ctx.runMutation(
      internal.messageRetry.internalCommitRetry,
      { ...commitArgs, ...ack }
    );
    return result;
  },
});
