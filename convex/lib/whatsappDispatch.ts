/**
 * Outbound WhatsApp dispatch scheduling — pacing em DOIS níveis (v4.1 P2).
 *
 * Nível 1 (por conversa/destinatário): a Meta impõe ~1 msg/6s por par (erro
 * 131056). Cursor `conversations.nextDispatchAt`, com margem (6,5s).
 *
 * Nível 2 (por NÚMERO/canal): anti-burst — N conversas do mesmo canal nunca
 * despacham juntas. Cursor OCC em `channelPacing` (doc próprio de propósito:
 * um cursor quente em channelConfigs re-executaria as queries da UI de Canais
 * a cada envio). Canal ocioso → cursor no passado → envio IMEDIATO; o pacing
 * só morde em rajada.
 *
 *   slot = max(now, cursorDaConversa, cursorDoCanal)
 *
 * Intervalos do canal:
 *  - Meta: 1s + jitter 0–2s. NÃO é exigência da Meta (80 mps comportaria) —
 *    é prudência de quality rating contra picos idênticos a blast de spam.
 *  - Bridge (não-oficial): NENHUM número aqui é limite oficial — são
 *    estimativas de engenharia calibráveis (a comunidade diverge de 1-5s a
 *    15-45s). Conversa REATIVA (inbound do cliente nas últimas 24h): 4s +
 *    jitter 0–6s. Envio FRIO (sem inbound recente — bulk/agendada): 8s +
 *    jitter 0–7s, faixa 8–15s (benchmark Letalk, único concorrente com pacing
 *    documentado). O risco de ban concentra em contato frio, não em resposta.
 *
 * Humanização (só bridge + envios de IA/agendados): o typing delay é somado ao
 * AVANÇO do cursor aqui no claim (não só aguardado na action) — senão dois
 * envios consecutivos chegariam mais próximos que o intervalo prometido.
 */
import { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { resolveConversationChannelConfig, providerOf } from "./channelResolve";

export const PAIR_RATE_INTERVAL_MS = 6500; // Meta: 1 msg/6s por destinatário (131056) + margem

const META_CHANNEL_GAP_MS = 1000;
const META_CHANNEL_JITTER_MS = 2000;
const BRIDGE_REACTIVE_GAP_MS = 4000;
const BRIDGE_REACTIVE_JITTER_MS = 6000;
const BRIDGE_COLD_GAP_MS = 8000;
const BRIDGE_COLD_JITTER_MS = 7000;
const REACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Digitação simulada (bridge, IA/agendadas): humano real seria ~267ms/char
// (modelo WPM 45±15 do baileys-antiban); 55ms/char + teto de 8s é o compromisso
// deliberado entre realismo e latência de atendimento.
const TYPING_BASE_MS = 1500;
const TYPING_PER_CHAR_MS = 55;
const TYPING_MAX_MS = 8000;

/**
 * Delay de "digitando…" para um envio humanizado no bridge. 0 = sem delay
 * (envio manual nunca ganha atraso artificial — a digitação humana já é o
 * pacing). Pura, para teste.
 */
export function computeTypingDelayMs(message: {
  senderType: "contact" | "human" | "ai";
  contentType: "text" | "image" | "file" | "audio";
  content: string;
  metadata?: Record<string, unknown>;
}): number {
  const humanized =
    message.senderType === "ai" || message.metadata?.scheduled === true;
  if (!humanized) return 0;
  if (message.contentType !== "text") return TYPING_BASE_MS;
  return Math.min(TYPING_BASE_MS + message.content.length * TYPING_PER_CHAR_MS, TYPING_MAX_MS);
}

function channelGapMs(provider: "meta" | "bridge", reactive: boolean): number {
  if (provider === "meta") {
    return META_CHANNEL_GAP_MS + Math.random() * META_CHANNEL_JITTER_MS;
  }
  return reactive
    ? BRIDGE_REACTIVE_GAP_MS + Math.random() * BRIDGE_REACTIVE_JITTER_MS
    : BRIDGE_COLD_GAP_MS + Math.random() * BRIDGE_COLD_JITTER_MS;
}

/**
 * Reivindica o próximo slot no cursor do CANAL e avança o cursor. Claims
 * concorrentes leem+escrevem o mesmo doc → o OCC do Convex serializa (mesmo
 * padrão do aiPacing). `floorMs` empurra o cursor para >= o valor antes do
 * claim (throttling por número: 130429/80007 atrasam a fila inteira do canal).
 */
export async function claimChannelSlot(
  ctx: MutationCtx,
  args: {
    config: Doc<"channelConfigs">;
    conversation: Doc<"conversations">;
    earliestAt: number;
    now: number;
    extraAdvanceMs?: number;
    floorMs?: number;
    countSend?: boolean;
  }
): Promise<number> {
  const provider = providerOf(args.config) ?? "meta";
  const reactive =
    (args.conversation.lastInboundAt ?? 0) + REACTIVE_WINDOW_MS > args.now;

  const row = await ctx.db
    .query("channelPacing")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.config._id))
    .first();
  let cursor = row?.nextDispatchAt ?? 0;
  if (args.floorMs !== undefined) cursor = Math.max(cursor, args.floorMs);

  const slot = Math.max(args.earliestAt, cursor);
  const nextAt =
    slot + Math.round(channelGapMs(provider, reactive)) + (args.extraAdvanceMs ?? 0);

  // Métrica-only (sem enforcement): envios do dia UTC p/ calibrar futuro warm-up.
  const day = new Date(args.now).toISOString().slice(0, 10);
  const dailyCount = args.countSend
    ? {
        day,
        sent: row?.dailyCount?.day === day ? row.dailyCount.sent + 1 : 1,
      }
    : row?.dailyCount;

  if (row) {
    await ctx.db.patch(row._id, { nextDispatchAt: nextAt, dailyCount });
  } else {
    await ctx.db.insert("channelPacing", {
      organizationId: args.config.organizationId,
      channelConfigId: args.config._id,
      nextDispatchAt: nextAt,
      dailyCount,
    });
  }
  return slot;
}

export async function scheduleWhatsappDispatch(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
  messageId: Id<"messages">
): Promise<void> {
  const now = Date.now();
  const config = await resolveConversationChannelConfig(ctx, conversation);

  let typingDelayMs = 0;
  if (config && providerOf(config) === "bridge") {
    const message = await ctx.db.get(messageId);
    if (message) typingDelayMs = computeTypingDelayMs(message);
  }

  const earliestAt = Math.max(now, conversation.nextDispatchAt ?? 0);
  const slot = config
    ? await claimChannelSlot(ctx, {
        config,
        conversation,
        earliestAt,
        now,
        extraAdvanceMs: typingDelayMs,
        countSend: true,
      })
    : earliestAt; // sem config resolvível: só o pacing por-conversa (comportamento antigo)

  await ctx.db.patch(conversation._id, { nextDispatchAt: slot + PAIR_RATE_INTERVAL_MS });
  await ctx.scheduler.runAfter(slot - now, internal.whatsapp.internalDispatchMessage, {
    messageId,
    ...(typingDelayMs > 0 ? { typingDelayMs } : {}),
  });
}
