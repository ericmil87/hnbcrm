/**
 * Worker das publicações programadas em grupos (F3) — um job auto-reagendado
 * POR publicação, molde do `campaignWorker.tick`.
 *
 *   tick (na hora do slot, ou N min antes quando o conteúdo é IA)
 *     ├─ IA e ainda falta gerar → agenda `generate` (action) e volta no slot
 *     ├─ hora do slot → escolhe/recupera o texto e insere uma `messages` por
 *     │                 grupo, com `metadata.groupPost` + `scheduled: true`,
 *     │                 e chama `applyOutboundMessageSideEffects` (audit +
 *     │                 webhook + pacing/dispatch que já existem)
 *     └─ reagenda no próximo slot da agenda
 *
 * Quatro coisas que este worker NUNCA faz, de propósito:
 *
 *  1. **Postar duas vezes o mesmo slot.** `lastSlotKey` é a idempotência; o
 *     `tickToken` fecha o caso do tick zumbi (pausa/retomada no meio).
 *  2. **Postar um slot muito atrasado.** Um tick que chega 3 h depois (canal
 *     congelado, deploy, fila) pula o slot em vez de mandar "bom dia" às 22 h.
 *  3. **Publicar texto de IA sem decisão humana**, a menos que a org tenha
 *     configurado `requiresApproval: false` (exige `campaigns:full`) ou que o
 *     `onMissedApproval` seja `send`.
 *  4. **Insistir com o canal caído.** Sessão desconectada/banida, grupos
 *     desligados no número ou grupo perdido = PAUSA com motivo + notificação
 *     `group_post_failed`. Publicação que falha calada é pior que publicação
 *     que para.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  ActionCtx,
  MutationCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { applyOutboundMessageSideEffects } from "./lib/outboundSideEffects";
import { createNotification } from "./lib/notify";
import { membersWithPermission } from "./lib/groupChatCore";
import { orgAiActive } from "./lib/agentSecurity";
import { chatWithFallback } from "./lib/llm";
import { DEFAULT_MODELS } from "./lib/llm/registry";
import { sanitizeLlmError } from "./lib/llm/sanitize";
import { resolveOrgRoutes, OrgProviderConfig } from "./lib/agentRoutes";
import { buildGroupPostPrompt, cleanGeneratedPost } from "./lib/groupPostPrompt";
import {
  buildCurrentDateTimeBlock,
  shouldIncludeCurrentDateTime,
} from "./lib/promptDateTime";
import {
  addPostTimeline,
  computeNextRun,
  endPostCore,
  pausePostCore,
  postWebhook,
  scheduleGroupPostTick,
  scheduleOf,
  wakeAtFor,
} from "./lib/groupPostOps";
import { slotKey as slotKeyOf } from "./lib/groupPostSchedule";
import {
  AI_RECENT_POSTS_CONTEXT,
  MAX_POST_TEXT_CHARS,
  bumpDailyPostCounter,
  buildPostVars,
  dailyPostCapReached,
  generateAtFor,
  pickLibraryItem,
  renderPostText,
} from "./lib/groupPostCore";

/**
 * Atraso máximo tolerado para ainda disparar um slot. Além disso o slot é
 * PULADO: uma publicação de "bom dia" que chega às 22h por causa de um canal
 * congelado é pior do que não chegar.
 */
const SLOT_GRACE_MS = 60 * 60 * 1000;
/**
 * Backoff antes de pausar por canal em estado TRANSITÓRIO. Uma única checagem
 * de saúde que dá timeout grava `bridgeSessionState: "disconnected"`, e o tick
 * que caísse nessa janela pausava a publicação para sempre (nada a religa
 * quando a sessão volta). Três tentativas cobrem ~22 min de instabilidade;
 * o que sobrevive a isso é queda de verdade e merece a pausa com aviso.
 */
const CHANNEL_RETRY_DELAYS_MS = [2 * 60_000, 5 * 60_000, 15 * 60_000];
/** Teto de tokens/tempo da geração. Texto de grupo é curto; 60 s sobra. */
const GENERATE_TIMEOUT_MS = 60_000;
const GENERATE_MAX_TOKENS = 1200;
const DEFAULT_MAX_CHARS = 600;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function pacingRow(ctx: MutationCtx, channelConfigId: Id<"channelConfigs">) {
  return await ctx.db
    .query("channelPacing")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", channelConfigId))
    .first();
}

/** Quem acompanha uma publicação: quem a criou + quem pode gerenciar campanhas. */
async function watchersOf(
  ctx: MutationCtx,
  post: Doc<"groupPosts">
): Promise<Id<"teamMembers">[]> {
  const members = await membersWithPermission(ctx, post.organizationId, "campaigns", "manage");
  const ids = new Set<Id<"teamMembers">>(members.map((m) => m._id));
  const creator = await ctx.db.get(post.createdBy);
  if (creator && creator.type === "human" && creator.status === "active") ids.add(creator._id);
  return [...ids];
}

/** Notificação in-app + e-mail para quem acompanha a publicação. */
async function notifyWatchers(
  ctx: MutationCtx,
  post: Doc<"groupPosts">,
  args: {
    type: "group_post_pending" | "group_post_failed";
    title: string;
    body?: string;
    emailEvent: "groupPostPending" | "groupPostFailed";
    templateData: Record<string, unknown>;
  }
): Promise<void> {
  for (const memberId of await watchersOf(ctx, post)) {
    await createNotification(ctx, {
      organizationId: post.organizationId,
      memberId,
      type: args.type,
      title: args.title,
      body: args.body,
      groupPostId: post._id,
    });
    await ctx.scheduler.runAfter(0, internal.email.dispatchNotification, {
      organizationId: post.organizationId,
      recipientMemberId: memberId,
      eventType: args.emailEvent,
      templateData: args.templateData,
    });
  }
}

/** Pausa automática + notificação + webhook. O caminho de toda falha dura. */
async function failAndPause(
  ctx: MutationCtx,
  post: Doc<"groupPosts">,
  now: number,
  reason: string
): Promise<void> {
  await ctx.db.patch(post._id, {
    stats: { ...post.stats, lastError: reason },
    updatedAt: now,
  });
  const fresh = (await ctx.db.get(post._id))!;
  await pausePostCore(ctx, fresh, { now, reason, automatic: true });
  await postWebhook(ctx, post.organizationId, "group.post.failed", {
    groupPostId: post._id,
    name: post.name,
    reason,
  });
  await notifyWatchers(ctx, fresh, {
    type: "group_post_failed",
    title: `Publicação «${post.name}» foi pausada`,
    body: reason,
    emailEvent: "groupPostFailed",
    templateData: {
      postName: post.name,
      postId: post._id,
      reason,
      appUrl: process.env.APP_URL ?? "https://app.hnbcrm.com.br",
    },
  });
}

type ValidTarget = { group: Doc<"groupChats">; conversation: Doc<"conversations"> };
type PostTarget = Doc<"groupPosts">["targets"][number];

/**
 * Quanto tempo um destino pode ficar inválido antes de sair da publicação de
 * vez. Um grupo desmarcado por engano (ou um `syncGroups` que devolveu
 * `{"Groups": null}` e marcou tudo como removido) volta sozinho quando o
 * operador conserta; só a ausência PERSISTENTE apaga a escolha dele.
 */
const TARGET_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Separa os destinos ainda utilizáveis dos que não são (grupo do qual saímos,
 * desmonitorado, apagado). Um grupo perdido não pode pausar a publicação
 * inteira quando os outros 4 continuam valendo.
 *
 * `persist: false` (PRÉVIA) não escreve NADA — nem marca, nem remove, nem
 * grava linha do tempo. "Testar agora" é documentado como leitura pura, e a
 * versão que escrevia apagava destino de verdade no caminho do dryRun.
 */
async function pruneTargets(
  ctx: MutationCtx,
  post: Doc<"groupPosts">,
  now: number,
  opts?: { persist?: boolean }
): Promise<{ valid: ValidTarget[]; dropped: string[]; post: Doc<"groupPosts"> }> {
  const persist = opts?.persist !== false;
  const valid: ValidTarget[] = [];
  const dropped: string[] = [];
  const removed: string[] = [];
  const keep: PostTarget[] = [];
  let changed = false;

  const markMissing = (t: PostTarget, label: string) => {
    const since = t.missingSince ?? now;
    if (now - since > TARGET_GRACE_MS) {
      removed.push(label);
      dropped.push(label);
      changed = true;
      return;
    }
    if (t.missingSince === undefined) {
      dropped.push(label);
      changed = true;
    }
    keep.push({ groupChatId: t.groupChatId, missingSince: since });
  };

  for (const t of post.targets) {
    const group = await ctx.db.get(t.groupChatId);
    if (!group || group.organizationId !== post.organizationId) {
      markMissing(t, "grupo removido");
      continue;
    }
    if (
      !group.monitored ||
      !group.conversationId ||
      group.leftAt !== undefined ||
      group.removedAt !== undefined ||
      group.channelConfigId !== post.channelConfigId
    ) {
      markMissing(t, group.subject);
      continue;
    }
    const conversation = await ctx.db.get(group.conversationId);
    if (!conversation || conversation.organizationId !== post.organizationId) {
      markMissing(t, group.subject);
      continue;
    }
    valid.push({ group, conversation });
    if (t.missingSince !== undefined) changed = true; // voltou: limpa a marca
    keep.push({ groupChatId: group._id });
  }

  if (persist && changed) {
    await ctx.db.patch(post._id, { targets: keep, updatedAt: now });
    const fresh = (await ctx.db.get(post._id))!;
    await addPostTimeline(ctx, fresh, {
      at: now,
      kind: removed.length > 0 ? "target_removed" : "target_missing",
      detail:
        removed.length > 0
          ? `Fora da publicação: ${removed.join(", ")}`
          : `Sem enviar por enquanto (grupo indisponível): ${dropped.join(", ")}`,
    });
  }
  return { valid, dropped, post: persist ? (await ctx.db.get(post._id))! : post };
}

/** Avança para o próximo slot (ou encerra quando a agenda acabou). */
async function advanceToNextSlot(
  ctx: MutationCtx,
  post: Doc<"groupPosts">,
  afterMs: number,
  now: number
): Promise<void> {
  const fresh = (await ctx.db.get(post._id))!;
  if (fresh.status !== "active") return;
  const next = computeNextRun(fresh, afterMs);
  if (next === null) {
    await endPostCore(ctx, fresh, { now, reason: "Agenda concluída" });
    return;
  }
  await ctx.db.patch(fresh._id, { nextRunAt: next.at, nextSlotKey: next.slotKey, updatedAt: now });
  const updated = (await ctx.db.get(fresh._id))!;
  await scheduleGroupPostTick(ctx, updated, wakeAtFor(updated, next.at), now);
}

/** Registra que um slot não foi publicado, sem derrubar a publicação. */
async function recordSkip(
  ctx: MutationCtx,
  post: Doc<"groupPosts">,
  args: { now: number; slotKey: string; reason: string; advanceFrom: number }
): Promise<void> {
  await ctx.db.patch(post._id, {
    stats: { ...post.stats, skipped: post.stats.skipped + 1, lastError: args.reason },
    lastSlotKey: args.slotKey,
    pending: undefined,
    updatedAt: args.now,
  });
  const fresh = (await ctx.db.get(post._id))!;
  await addPostTimeline(ctx, fresh, {
    at: args.now,
    kind: "skipped",
    slotKey: args.slotKey,
    detail: args.reason,
  });
  await advanceToNextSlot(ctx, (await ctx.db.get(post._id))!, args.advanceFrom, args.now);
}

// ─────────────────────────────────────────────────────────────────────────────
// Envio
// ─────────────────────────────────────────────────────────────────────────────

interface ResolvedContent {
  text: string;
  attachments?: Id<"files">[];
  contentType: Doc<"messages">["contentType"];
  itemIndex?: number;
  generated: boolean;
}

/**
 * Insere UMA mensagem por grupo e dispara os side effects compartilhados. O
 * envio real ao WhatsApp é do dispatch de sempre (pacing por número + typing
 * humanizado), agendado lá dentro — este worker só escreve no banco.
 */
async function publishToTargets(
  ctx: MutationCtx,
  args: {
    post: Doc<"groupPosts">;
    targets: ValidTarget[];
    content: ResolvedContent;
    sender: Doc<"teamMembers">;
    slotKey: string;
    now: number;
    manual: boolean;
  }
): Promise<
  Array<{
    groupChatId: Id<"groupChats">;
    conversationId?: Id<"conversations">;
    messageId?: Id<"messages">;
    error?: string;
  }>
> {
  const { post, content, sender, slotKey, now } = args;
  const timezone = scheduleOf(post).timezone;
  const sends: Array<{
    groupChatId: Id<"groupChats">;
    conversationId?: Id<"conversations">;
    messageId?: Id<"messages">;
    error?: string;
  }> = [];

  for (const { group, conversation } of args.targets) {
    try {
      const vars = buildPostVars({ groupName: group.subject, at: now, timezone });
      // Seed por (publicação, slot, grupo): o spintax varia ENTRE grupos e
      // entre dias, mas repetir o mesmo slot escolhe o mesmo texto.
      const text = renderPostText(content.text, vars, `${post._id}:${slotKey}:${group._id}`);
      const body = text || content.text;

      const messageId = await ctx.db.insert("messages", {
        organizationId: post.organizationId,
        conversationId: conversation._id,
        direction: "outbound",
        senderId: sender._id,
        senderType: sender.type === "ai" ? "ai" : "human",
        content: body,
        contentType: content.contentType,
        attachments: content.attachments,
        isInternal: false,
        metadata: {
          groupPost: {
            postId: post._id,
            slotKey,
            ...(content.itemIndex !== undefined ? { itemIndex: content.itemIndex } : {}),
            generated: content.generated,
            ...(args.manual ? { manual: true } : {}),
          },
          // Typing humanizado no bridge (mesmo sinal das campanhas).
          scheduled: true,
        },
        createdAt: now,
      });

      if (content.attachments && content.attachments.length > 0) {
        // `files.messageId` é 1:1 e a mesma linha não pode apontar para N
        // mensagens: só a PRIMEIRA publicação do slot fica com o vínculo. O
        // blob é compartilhado e `lib/fileRefs` já protege o delete.
        for (const fileId of content.attachments) {
          const file = await ctx.db.get(fileId);
          if (file && !file.messageId) await ctx.db.patch(fileId, { messageId });
        }
      }

      await applyOutboundMessageSideEffects(ctx, {
        conversation,
        member: sender,
        messageId,
        now,
        activityContent: `Publicação programada «${post.name}» enviada`,
      });

      sends.push({ groupChatId: group._id, conversationId: conversation._id, messageId });
    } catch (e) {
      sends.push({
        groupChatId: group._id,
        error: (e instanceof Error ? e.message : "Falha ao publicar").slice(0, 200),
      });
    }
  }
  return sends;
}

/** Contabiliza o slot no teto diário do canal. */
async function bumpChannelCounter(
  ctx: MutationCtx,
  post: Doc<"groupPosts">,
  now: number
): Promise<void> {
  const row = await pacingRow(ctx, post.channelConfigId);
  const groupPostDaily = bumpDailyPostCounter(row?.groupPostDaily, now);
  if (row) {
    await ctx.db.patch(row._id, { groupPostDaily });
  } else {
    await ctx.db.insert("channelPacing", {
      organizationId: post.organizationId,
      channelConfigId: post.channelConfigId,
      nextDispatchAt: 0,
      groupPostDaily,
    });
  }
}

/** Escolhe o item da biblioteca e persiste cursor / janela de não-repetição. */
async function resolveLibraryContent(
  ctx: MutationCtx,
  post: Doc<"groupPosts">,
  seed: string,
  now: number
): Promise<ResolvedContent | null> {
  const lib = post.content.library;
  if (!lib || lib.items.length === 0) return null;
  const pick = pickLibraryItem(
    lib.items,
    lib.order,
    lib.cursor,
    lib.recentIndexes,
    lib.noRepeatWindow,
    seed
  );
  if (!pick) return null;
  const item = lib.items[pick.index];

  await ctx.db.patch(post._id, {
    content: {
      ...post.content,
      library: { ...lib, cursor: pick.nextCursor, recentIndexes: pick.nextRecentIndexes },
    },
    updatedAt: now,
  });

  const attachments =
    item.attachmentFileIds && item.attachmentFileIds.length > 0 ? item.attachmentFileIds : undefined;
  let contentType: Doc<"messages">["contentType"] = item.contentType ?? "text";
  let text = item.text;
  if (attachments) {
    const file = await ctx.db.get(attachments[0]);
    const mime = file?.mimeType ?? "";
    if (!item.contentType) {
      contentType = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "file";
    }
    if (!text.trim()) {
      text = contentType === "image" ? "[imagem]" : contentType === "audio" ? "[áudio]" : file?.name ?? "[arquivo]";
    }
  }
  return { text, attachments, contentType, itemIndex: pick.index, generated: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// tick
// ─────────────────────────────────────────────────────────────────────────────

export const tick = internalMutation({
  args: { groupPostId: v.id("groupPosts"), tickToken: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const guarded = await ctx.db.get(args.groupPostId);
    if (!guarded) return null;
    if (guarded.status !== "active") return null;
    if (guarded.tickToken && guarded.tickToken !== args.tickToken) return null; // zumbi

    // O job já está rodando: solta o ponteiro para não cancelar a si mesmo ao
    // reagendar mais abaixo (mesmo cuidado do campaignWorker).
    await ctx.db.patch(guarded._id, { schedulerFnId: undefined });
    let post = (await ctx.db.get(guarded._id))!;
    const schedule = scheduleOf(post);

    // 1. Canal, sessão e interruptor de grupos
    const config = await ctx.db.get(post.channelConfigId);
    if (!config || config.organizationId !== post.organizationId || config.status !== "active") {
      await failAndPause(ctx, post, now, "Número do WhatsApp indisponível ou desativado");
      return null;
    }
    if (config.bridgeGroupsEnabled !== true) {
      await failAndPause(ctx, post, now, "Os grupos foram desligados neste número");
      return null;
    }
    if (config.bridgeSessionState === "banned") {
      await failAndPause(
        ctx,
        post,
        now,
        "Sessão do WhatsApp BANIDA — reconecte o número em Configurações → Canais"
      );
      return null;
    }
    if (config.bridgeSessionState && config.bridgeSessionState !== "connected") {
      // Estado transitório (o health check grava "disconnected" até num
      // timeout): adia com backoff e só pausa depois de insistir.
      const attempt = post.channelRetries ?? 0;
      const delay = CHANNEL_RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        await ctx.db.patch(post._id, { channelRetries: attempt + 1, updatedAt: now });
        const fresh = (await ctx.db.get(post._id))!;
        await addPostTimeline(ctx, fresh, {
          at: now,
          kind: "channel_retry",
          detail: `Sessão do WhatsApp instável — nova tentativa em ${Math.round(delay / 60_000)} min`,
        });
        await scheduleGroupPostTick(ctx, (await ctx.db.get(post._id))!, now + delay, now);
        return null;
      }
      await failAndPause(
        ctx,
        post,
        now,
        "Sessão do WhatsApp desconectada — reconecte o número em Configurações → Canais"
      );
      return null;
    }
    if (post.channelRetries !== undefined) {
      // Canal respondeu: o contador de instabilidade volta a zero.
      await ctx.db.patch(post._id, { channelRetries: undefined, updatedAt: now });
      post = (await ctx.db.get(post._id))!;
    }

    // 2. Canal congelado (131048 / sessão instável): adia, não pausa.
    const pacing = await pacingRow(ctx, post.channelConfigId);
    if (pacing?.campaignFrozenUntil && pacing.campaignFrozenUntil > now) {
      await addPostTimeline(ctx, post, {
        at: now,
        kind: "frozen",
        detail: "Canal congelado — publicação adiada",
      });
      await scheduleGroupPostTick(ctx, (await ctx.db.get(post._id))!, pacing.campaignFrozenUntil, now);
      return null;
    }

    // 3. Destinos ainda válidos
    const pruned = await pruneTargets(ctx, post, now);
    post = pruned.post;
    if (pruned.valid.length === 0) {
      await failAndPause(ctx, post, now, "Nenhum grupo válido — o número saiu dos grupos ou parou de acompanhá-los");
      return null;
    }

    // 4. Qual slot estamos resolvendo. O par (`nextRunAt`, `nextSlotKey`) é
    // gravado por quem agenda; `slotKeyOf` só cobre documento antigo, sem o
    // campo (deduzir a chave do instante jitterado pode dar o slot errado).
    let runAt: number | null = post.nextRunAt ?? null;
    let slot: string | null = runAt !== null ? post.nextSlotKey ?? slotKeyOf(schedule, runAt) : null;
    if (runAt === null || slot === null) {
      const computed = computeNextRun(post, now);
      if (computed === null) {
        await endPostCore(ctx, post, { now, reason: "Agenda concluída" });
        return null;
      }
      runAt = computed.at;
      slot = computed.slotKey;
    }

    // 5. Conteúdo por IA: gerar com antecedência
    const ai = post.content.kind === "ai" ? post.content.ai : undefined;
    const hasPendingForSlot = post.pending?.slotKey === slot;
    if (ai && now < runAt) {
      const genAt = generateAtFor(runAt, ai.generateMinutesBefore);
      if (!hasPendingForSlot && now >= genAt) {
        await ctx.db.patch(post._id, { nextRunAt: runAt, nextSlotKey: slot, updatedAt: now });
        await ctx.scheduler.runAfter(0, internal.groupPostWorker.generate, {
          groupPostId: post._id,
          slotKey: slot,
          runAt,
        });
        await scheduleGroupPostTick(ctx, (await ctx.db.get(post._id))!, runAt, now);
        return null;
      }
      if (!hasPendingForSlot && genAt > now) {
        await ctx.db.patch(post._id, { nextRunAt: runAt, nextSlotKey: slot, updatedAt: now });
        await scheduleGroupPostTick(ctx, (await ctx.db.get(post._id))!, genAt, now);
        return null;
      }
    }

    // 6. Ainda não é hora
    if (now < runAt) {
      await ctx.db.patch(post._id, { nextRunAt: runAt, nextSlotKey: slot, updatedAt: now });
      await scheduleGroupPostTick(ctx, (await ctx.db.get(post._id))!, runAt, now);
      return null;
    }

    // 7. Idempotência — este slot já foi resolvido
    if (post.lastSlotKey === slot) {
      await advanceToNextSlot(ctx, post, Math.max(runAt, now), now);
      return null;
    }

    const advanceFrom = Math.max(runAt, now);

    // 8. Atrasado demais
    if (now - runAt > SLOT_GRACE_MS) {
      await recordSkip(ctx, post, {
        now,
        slotKey: slot,
        reason: "Horário perdido por mais de 1 h — publicação deste horário pulada",
        advanceFrom,
      });
      return null;
    }

    // 9. Teto diário por canal
    if (dailyPostCapReached(pacing?.groupPostDaily, now)) {
      await recordSkip(ctx, post, {
        now,
        slotKey: slot,
        reason: "Teto diário de publicações automáticas neste número atingido",
        advanceFrom,
      });
      return null;
    }

    // 10. Texto do slot
    let content: ResolvedContent | null = null;
    if (post.content.kind === "library") {
      content = await resolveLibraryContent(ctx, post, `${post._id}:${slot}`, now);
      post = (await ctx.db.get(post._id))!;
      if (!content) {
        await failAndPause(ctx, post, now, "A biblioteca de mensagens está vazia");
        return null;
      }
    } else if (ai) {
      const pending = post.pending;
      if (!pending || pending.slotKey !== slot) {
        await recordSkip(ctx, post, {
          now,
          slotKey: slot,
          reason: post.stats.lastError ?? "A IA não gerou o texto a tempo",
          advanceFrom,
        });
        return null;
      }
      if (pending.status === "rejected") {
        await recordSkip(ctx, post, { now, slotKey: slot, reason: "Texto rejeitado pela equipe", advanceFrom });
        return null;
      }
      if (pending.status === "pendingApproval" && ai.onMissedApproval === "skip") {
        await recordSkip(ctx, post, {
          now,
          slotKey: slot,
          reason: "Aprovação não chegou a tempo — publicação pulada",
          advanceFrom,
        });
        return null;
      }
      content = {
        text: pending.editedText ?? pending.text,
        attachments:
          pending.attachmentFileIds && pending.attachmentFileIds.length > 0
            ? pending.attachmentFileIds
            : undefined,
        contentType: "text",
        generated: true,
      };
    }
    if (!content) {
      await failAndPause(ctx, post, now, "Conteúdo da publicação inválido");
      return null;
    }

    // 11. Quem assina o envio
    const sender = await ctx.db.get(post.createdBy);
    if (!sender || sender.organizationId !== post.organizationId || sender.status !== "active") {
      await failAndPause(ctx, post, now, "Quem criou a publicação não está mais ativo na equipe");
      return null;
    }

    // 12. Publica
    const sends = await publishToTargets(ctx, {
      post,
      targets: pruned.valid,
      content,
      sender,
      slotKey: slot,
      now,
      manual: false,
    });
    const okCount = sends.filter((s) => s.messageId).length;

    await ctx.db.patch(post._id, {
      lastSlotKey: slot,
      pending: undefined,
      stats: {
        ...post.stats,
        sent: post.stats.sent + (okCount > 0 ? 1 : 0),
        failed: post.stats.failed + (okCount === 0 ? 1 : 0),
        lastSentAt: okCount > 0 ? now : post.stats.lastSentAt,
        lastError: okCount === sends.length ? undefined : sends.find((s) => s.error)?.error,
      },
      updatedAt: now,
    });
    if (okCount > 0) await bumpChannelCounter(ctx, post, now);

    const after = (await ctx.db.get(post._id))!;
    await addPostTimeline(ctx, after, {
      at: now,
      kind: okCount > 0 ? "sent" : "failed",
      slotKey: slot,
      detail: content.text.slice(0, 200),
      sends,
    });
    await postWebhook(ctx, post.organizationId, okCount > 0 ? "group.post.sent" : "group.post.failed", {
      groupPostId: post._id,
      name: post.name,
      slotKey: slot,
      generated: content.generated,
      groups: sends.length,
      delivered: okCount,
      messageIds: sends.map((s) => s.messageId).filter(Boolean),
    });
    if (okCount === 0) {
      await notifyWatchers(ctx, (await ctx.db.get(post._id))!, {
        type: "group_post_failed",
        title: `Publicação «${post.name}» não foi enviada`,
        body: sends.find((s) => s.error)?.error ?? "Nenhum grupo recebeu a mensagem",
        emailEvent: "groupPostFailed",
        templateData: {
          postName: post.name,
          postId: post._id,
          reason: sends.find((s) => s.error)?.error ?? "Nenhum grupo recebeu a mensagem",
          appUrl: process.env.APP_URL ?? "https://app.hnbcrm.com.br",
        },
      });
    }

    await advanceToNextSlot(ctx, (await ctx.db.get(post._id))!, advanceFrom, now);
    return null;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Geração por IA
// ─────────────────────────────────────────────────────────────────────────────

const generateContextValidator = v.object({
  organizationId: v.id("organizations"),
  aiAllowed: v.boolean(),
  orgName: v.string(),
  agentName: v.string(),
  language: v.string(),
  persona: v.union(v.string(), v.null()),
  knowledge: v.union(v.string(), v.null()),
  instruction: v.string(),
  maxChars: v.number(),
  requiresApproval: v.boolean(),
  groupNames: v.array(v.string()),
  recentPosts: v.array(v.string()),
  timezone: v.string(),
  // Carimbo de data/hora: a flag é a do perfil do ATENDENTE (é a persona dele
  // que escreve aqui). Ausente no perfil = ligado.
  includeCurrentDateTime: v.boolean(),
  model: v.string(),
  strictZdr: v.boolean(),
  providerConfig: v.any(),
  runMemberId: v.union(v.id("teamMembers"), v.null()),
  /**
   * Retrato do `content.ai` no instante da leitura. A geração é uma action de
   * até 60 s; um `update` no meio dela trocava o prompt e a equipe acabava
   * aprovando um texto produzido pela configuração ANTIGA, sem saber.
   */
  contentFingerprint: v.string(),
});

/** Retrato estável do conteúdo de IA (ordem das chaves fixa). */
function aiContentFingerprint(content: Doc<"groupPosts">["content"]): string {
  const ai = content.ai;
  if (!ai) return "";
  return JSON.stringify([
    ai.prompt,
    ai.persona ?? null,
    ai.customPersona ?? null,
    ai.useKnowledge,
    ai.maxChars ?? null,
    ai.requiresApproval,
  ]);
}

export const internalGetGenerateContext = internalQuery({
  args: { groupPostId: v.id("groupPosts"), slotKey: v.string() },
  returns: v.union(generateContextValidator, v.null()),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.groupPostId);
    if (!post || post.content.kind !== "ai" || !post.content.ai) return null;
    // O texto pertence a UM slot: se a agenda mudou entre o agendamento e a
    // execução, não adianta gerar para um horário que não existe mais.
    if (post.pending?.slotKey === args.slotKey) return null;

    const org = await ctx.db.get(post.organizationId);
    if (!org) return null;
    const aiConfig = org.settings.aiConfig;
    const aiAllowed = orgAiActive(org) && aiConfig?.groupAgentEnabled === true;

    // Persona: a do atendente IA da org (reuso deliberado — é a voz que os
    // clientes já conhecem), ou uma escrita à mão na própria publicação.
    const members = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) =>
        q.eq("organizationId", post.organizationId).eq("type", "ai")
      )
      .collect();
    const attendant = members.find(
      (m) => m.status === "active" && m.agentProfile?.kind === "attendant"
    );

    const ai = post.content.ai;
    const useCustom = ai.persona === "custom" && (ai.customPersona ?? "").trim().length > 0;
    const persona = useCustom
      ? ai.customPersona!.trim()
      : attendant?.agentProfile?.systemPrompt ?? null;
    const knowledge = ai.useKnowledge ? attendant?.agentProfile?.knowledge ?? null : null;

    const groupNames: string[] = [];
    for (const t of post.targets) {
      const g = await ctx.db.get(t.groupChatId);
      if (g) groupNames.push(g.subject);
    }

    const recentPosts = (post.timeline ?? [])
      .filter((e) => e.kind === "sent" && e.detail)
      .slice(-AI_RECENT_POSTS_CONTEXT)
      .map((e) => e.detail!.slice(0, 300));

    return {
      organizationId: post.organizationId,
      aiAllowed,
      orgName: org.name,
      agentName: attendant?.name ?? org.name,
      language: attendant?.agentProfile?.language ?? "pt-BR",
      persona,
      knowledge,
      instruction: ai.prompt,
      maxChars: ai.maxChars ?? DEFAULT_MAX_CHARS,
      requiresApproval: ai.requiresApproval,
      groupNames,
      recentPosts,
      timezone: post.schedule.timezone,
      includeCurrentDateTime: shouldIncludeCurrentDateTime(attendant?.agentProfile),
      model:
        aiConfig?.providerConfig?.products?.groupPosts?.model ??
        attendant?.agentProfile?.model ??
        aiConfig?.providerConfig?.models?.attendant ??
        DEFAULT_MODELS.attendant,
      strictZdr: aiConfig?.providerConfig?.strictZdr === true,
      providerConfig: aiConfig?.providerConfig ?? null,
      runMemberId: attendant?._id ?? post.createdBy,
      contentFingerprint: aiContentFingerprint(post.content),
    };
  },
});

export const internalStorePending = internalMutation({
  args: {
    groupPostId: v.id("groupPosts"),
    slotKey: v.string(),
    runAt: v.number(),
    text: v.string(),
    model: v.optional(v.string()),
    provider: v.optional(v.string()),
    autoApprove: v.boolean(),
    contentFingerprint: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.groupPostId);
    if (!post || post.status !== "active") return null;
    if (post.pending?.slotKey === args.slotKey) return null; // corrida: já tem
    // O conteúdo mudou durante a geração: este texto veio do prompt ANTIGO e
    // não pode virar um pendente que a equipe aprova achando que é o novo.
    if (
      args.contentFingerprint !== undefined &&
      args.contentFingerprint !== aiContentFingerprint(post.content)
    ) {
      await addPostTimeline(ctx, post, {
        at: Date.now(),
        kind: "generate_failed",
        slotKey: args.slotKey,
        detail: "O conteúdo foi editado durante a geração — o texto antigo foi descartado",
      });
      return null;
    }

    const now = Date.now();
    await ctx.db.patch(post._id, {
      pending: {
        text: args.text,
        generatedAt: now,
        dueAt: args.runAt,
        slotKey: args.slotKey,
        status: args.autoApprove ? "approved" : "pendingApproval",
        model: args.model,
        provider: args.provider,
      },
      stats: { ...post.stats, lastError: undefined },
      updatedAt: now,
    });
    const fresh = (await ctx.db.get(post._id))!;
    await addPostTimeline(ctx, fresh, {
      at: now,
      kind: args.autoApprove ? "generated" : "pending",
      slotKey: args.slotKey,
      detail: args.text.slice(0, 200),
    });

    await postWebhook(ctx, post.organizationId, "group.post.pending", {
      groupPostId: post._id,
      name: post.name,
      slotKey: args.slotKey,
      dueAt: args.runAt,
      requiresApproval: !args.autoApprove,
      text: args.text,
    });

    if (args.autoApprove) return null;

    const groupNames: string[] = [];
    for (const t of post.targets) {
      const g = await ctx.db.get(t.groupChatId);
      if (g) groupNames.push(g.subject);
    }
    const scheduledFor = new Date(args.runAt).toLocaleString("pt-BR", {
      timeZone: post.schedule.timezone,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    await notifyWatchers(ctx, (await ctx.db.get(post._id))!, {
      type: "group_post_pending",
      title: `Aprovar publicação «${post.name}»`,
      body: args.text.slice(0, 160),
      emailEvent: "groupPostPending",
      templateData: {
        postName: post.name,
        postId: post._id,
        groups: groupNames.join(", "),
        scheduledFor,
        text: args.text,
        missedBehavior: post.content.ai?.onMissedApproval ?? "skip",
        appUrl: process.env.APP_URL ?? "https://app.hnbcrm.com.br",
      },
    });
    return null;
  },
});

export const internalRecordGenerateFailure = internalMutation({
  args: { groupPostId: v.id("groupPosts"), slotKey: v.string(), error: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.groupPostId);
    if (!post) return null;
    const now = Date.now();
    const reason = args.error.slice(0, 300);
    await ctx.db.patch(post._id, {
      stats: { ...post.stats, lastError: reason },
      updatedAt: now,
    });
    const fresh = (await ctx.db.get(post._id))!;
    await addPostTimeline(ctx, fresh, {
      at: now,
      kind: "generate_failed",
      slotKey: args.slotKey,
      detail: reason,
    });
    // Falha de LLM NÃO pausa a publicação: o próximo slot pode dar certo. Mas
    // avisa, porque o slot de hoje não vai sair.
    await postWebhook(ctx, post.organizationId, "group.post.failed", {
      groupPostId: post._id,
      name: post.name,
      slotKey: args.slotKey,
      reason,
      stage: "generate",
    });
    await notifyWatchers(ctx, fresh, {
      type: "group_post_failed",
      title: `A IA não conseguiu escrever a publicação «${post.name}»`,
      body: reason,
      emailEvent: "groupPostFailed",
      templateData: {
        postName: post.name,
        postId: post._id,
        reason,
        appUrl: process.env.APP_URL ?? "https://app.hnbcrm.com.br",
      },
    });
    return null;
  },
});

/** Gera o texto de UM slot. Falha aqui nunca envia nada — só registra e avisa. */
export const generate = internalAction({
  args: { groupPostId: v.id("groupPosts"), slotKey: v.string(), runAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const setup = await ctx.runQuery(internal.groupPostWorker.internalGetGenerateContext, {
      groupPostId: args.groupPostId,
      slotKey: args.slotKey,
    });
    if (!setup) return null;

    if (!setup.aiAllowed) {
      await ctx.runMutation(internal.groupPostWorker.internalRecordGenerateFailure, {
        groupPostId: args.groupPostId,
        slotKey: args.slotKey,
        error: "A IA em grupos está desativada nesta organização",
      });
      return null;
    }

    const text = await generatePostText(ctx, setup);
    if (!text.ok) {
      await ctx.runMutation(internal.groupPostWorker.internalRecordGenerateFailure, {
        groupPostId: args.groupPostId,
        slotKey: args.slotKey,
        error: text.error,
      });
      return null;
    }

    await ctx.runMutation(internal.groupPostWorker.internalStorePending, {
      groupPostId: args.groupPostId,
      slotKey: args.slotKey,
      runAt: args.runAt,
      text: text.text,
      model: text.model,
      provider: text.provider,
      autoApprove: setup.requiresApproval === false,
      contentFingerprint: setup.contentFingerprint,
    });
    return null;
  },
});

type GenerateSetup = {
  organizationId: Id<"organizations">;
  orgName: string;
  agentName: string;
  language: string;
  persona: string | null;
  knowledge: string | null;
  instruction: string;
  maxChars: number;
  groupNames: string[];
  recentPosts: string[];
  timezone: string;
  includeCurrentDateTime: boolean;
  model: string;
  providerConfig: OrgProviderConfig | null;
  runMemberId: Id<"teamMembers"> | null;
};

type GenerateResult =
  | { ok: true; text: string; model?: string; provider?: string }
  | { ok: false; error: string };

/** Chamada de LLM da publicação: 1 request, sem tools, saída = texto puro. */
async function generatePostText(ctx: ActionCtx, setup: GenerateSetup): Promise<GenerateResult> {
  let routes;
  try {
    routes = await resolveOrgRoutes(
      ctx,
      setup.organizationId,
      setup.providerConfig,
      setup.model,
      "groupPosts"
    );
  } catch (e) {
    return { ok: false, error: sanitizeLlmError(e instanceof Error ? e.message : String(e)) };
  }
  if (routes.length === 0) {
    return { ok: false, error: "Nenhuma rota de IA disponível para esta organização" };
  }

  const now = Date.now();
  const vars = buildPostVars({ groupName: "", at: now, timezone: setup.timezone });
  const maxChars = Math.max(50, Math.min(MAX_POST_TEXT_CHARS, setup.maxChars));
  const prompt = buildGroupPostPrompt({
    agentName: setup.agentName,
    orgName: setup.orgName,
    language: setup.language,
    persona: setup.persona,
    knowledge: setup.knowledge,
    instruction: setup.instruction,
    maxChars,
    groupNames: setup.groupNames,
    recentPosts: setup.recentPosts,
    dateText: vars.data,
    weekdayText: vars.dia_semana,
    // O fuso é o da AGENDA da publicação (é nele que o horário foi marcado).
    dateTimeBlock: setup.includeCurrentDateTime
      ? buildCurrentDateTimeBlock(now, setup.timezone)
      : null,
  });

  const runId = setup.runMemberId
    ? await ctx.runMutation(internal.agentRuns.internalStartRun, {
        organizationId: setup.organizationId,
        memberId: setup.runMemberId,
        kind: "group_post" as const,
        model: setup.model,
      })
    : null;

  try {
    const resp = await chatWithFallback(
      routes,
      {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        temperature: 0.7,
        maxTokens: GENERATE_MAX_TOKENS,
      },
      { timeoutMs: GENERATE_TIMEOUT_MS }
    );
    const text = cleanGeneratedPost(resp.message.content, maxChars);
    if (!text) {
      if (runId) {
        await ctx.runMutation(internal.agentRuns.internalFinishRun, {
          runId,
          status: "error",
          requestCount: 1,
          error: "Modelo devolveu texto vazio",
        });
      }
      return { ok: false, error: "A IA devolveu um texto vazio" };
    }
    if (runId) {
      await ctx.runMutation(internal.agentRuns.internalFinishRun, {
        runId,
        status: "done",
        provider: resp.usedRoute.providerId,
        model: resp.usedRoute.canonicalModel,
        requestCount: 1,
        promptTokens: resp.usage?.promptTokens,
        completionTokens: resp.usage?.completionTokens,
        cachedPromptTokens: resp.usage?.cachedPromptTokens,
      });
    }
    return {
      ok: true,
      text,
      model: resp.usedRoute.canonicalModel,
      provider: resp.usedRoute.providerId,
    };
  } catch (e) {
    const error = sanitizeLlmError(e instanceof Error ? e.message : String(e));
    if (runId) {
      await ctx.runMutation(internal.agentRuns.internalFinishRun, {
        runId,
        status: "error",
        requestCount: 1,
        error,
      });
    }
    return { ok: false, error };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// "Enviar agora" (teste)
// ─────────────────────────────────────────────────────────────────────────────

export const internalSendNow = internalAction({
  args: { groupPostId: v.id("groupPosts"), dryRun: v.boolean() },
  returns: v.any(),
  handler: async (ctx, args): Promise<any> => {
    // RBAC com a identidade do chamador (manage para prévia, full para enviar).
    await ctx.runQuery(internal.groupPosts.internalAssertCanSendNow, {
      groupPostId: args.groupPostId,
      dryRun: args.dryRun,
    });

    // Conteúdo por IA precisa do LLM antes de qualquer escrita.
    let overrideText: string | undefined;
    const setup = await ctx.runQuery(internal.groupPostWorker.internalGetGenerateContext, {
      groupPostId: args.groupPostId,
      slotKey: "__send_now__",
    });
    if (setup) {
      if (!setup.aiAllowed) {
        throw new Error("A IA em grupos está desativada nesta organização");
      }
      const generated = await generatePostText(ctx, setup);
      if (!generated.ok) throw new Error(generated.error);
      overrideText = generated.text;
    }

    return await ctx.runMutation(internal.groupPostWorker.internalExecuteSendNow, {
      groupPostId: args.groupPostId,
      dryRun: args.dryRun,
      overrideText,
    });
  },
});

export const internalExecuteSendNow = internalMutation({
  args: {
    groupPostId: v.id("groupPosts"),
    dryRun: v.boolean(),
    overrideText: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const now = Date.now();
    let post = await ctx.db.get(args.groupPostId);
    if (!post) throw new Error("Publicação não encontrada");

    // PRÉVIA não escreve: nem o cursor da biblioteca, nem os destinos.
    const pruned = await pruneTargets(ctx, post, now, { persist: !args.dryRun });
    post = pruned.post;
    if (pruned.valid.length === 0) throw new Error("Nenhum grupo válido nesta publicação");

    const slot = `manual-${now}`;
    let content: ResolvedContent | null = null;
    if (args.overrideText !== undefined) {
      content = { text: args.overrideText, contentType: "text", generated: true };
    } else if (post.content.kind === "library") {
      // A PRÉVIA não pode mexer no cursor: ver o texto não é publicar.
      const lib = post.content.library;
      if (!lib || lib.items.length === 0) throw new Error("A biblioteca de mensagens está vazia");
      if (args.dryRun) {
        const pick = pickLibraryItem(
          lib.items,
          lib.order,
          lib.cursor,
          lib.recentIndexes,
          lib.noRepeatWindow,
          `${post._id}:${slot}`
        )!;
        const item = lib.items[pick.index];
        content = {
          text: item.text,
          attachments: item.attachmentFileIds,
          contentType: item.contentType ?? "text",
          itemIndex: pick.index,
          generated: false,
        };
      } else {
        content = await resolveLibraryContent(ctx, post, `${post._id}:${slot}`, now);
        post = (await ctx.db.get(post._id))!;
      }
    }
    if (!content) throw new Error("Conteúdo da publicação inválido");

    const timezone = scheduleOf(post).timezone;
    const previews = pruned.valid.map(({ group }) => ({
      groupChatId: group._id,
      subject: group.subject,
      text: renderPostText(
        content!.text,
        buildPostVars({ groupName: group.subject, at: now, timezone }),
        `${post!._id}:${slot}:${group._id}`
      ),
    }));

    if (args.dryRun) {
      return { dryRun: true, text: content.text, previews };
    }

    // Envio de verdade: os MESMOS portões do disparo programado, menos o relógio.
    // A org do canal é revalidada como no `tick`: as duas portas escrevem no
    // mesmo gateway e uma delas confiar no `channelConfigId` gravado é o tipo
    // de divergência que sobrevive a um refactor futuro.
    const config = await ctx.db.get(post.channelConfigId);
    if (
      !config ||
      config.organizationId !== post.organizationId ||
      config.status !== "active" ||
      config.bridgeGroupsEnabled !== true
    ) {
      throw new Error("Número indisponível ou com grupos desligados");
    }
    if (config.bridgeSessionState && config.bridgeSessionState !== "connected") {
      throw new Error("Sessão do WhatsApp desconectada — reconecte o número");
    }
    const pacing = await pacingRow(ctx, post.channelConfigId);
    if (pacing?.campaignFrozenUntil && pacing.campaignFrozenUntil > now) {
      throw new Error("Canal congelado no momento — tente de novo mais tarde");
    }
    if (dailyPostCapReached(pacing?.groupPostDaily, now)) {
      throw new Error("Teto diário de publicações automáticas neste número atingido");
    }

    const sender = await ctx.db.get(post.createdBy);
    if (!sender || sender.organizationId !== post.organizationId) {
      throw new Error("Quem criou a publicação não está mais ativo na equipe");
    }

    const sends = await publishToTargets(ctx, {
      post,
      targets: pruned.valid,
      content,
      sender,
      slotKey: slot,
      now,
      manual: true,
    });
    const okCount = sends.filter((s) => s.messageId).length;

    await ctx.db.patch(post._id, {
      stats: {
        ...post.stats,
        sent: post.stats.sent + (okCount > 0 ? 1 : 0),
        failed: post.stats.failed + (okCount === 0 ? 1 : 0),
        lastSentAt: okCount > 0 ? now : post.stats.lastSentAt,
      },
      updatedAt: now,
    });
    if (okCount > 0) await bumpChannelCounter(ctx, post, now);

    await addPostTimeline(ctx, (await ctx.db.get(post._id))!, {
      at: now,
      kind: okCount > 0 ? "sent" : "failed",
      slotKey: slot,
      detail: `[envio manual] ${content.text.slice(0, 180)}`,
      sends,
    });
    await postWebhook(ctx, post.organizationId, okCount > 0 ? "group.post.sent" : "group.post.failed", {
      groupPostId: post._id,
      name: post.name,
      slotKey: slot,
      manual: true,
      groups: sends.length,
      delivered: okCount,
      messageIds: sends.map((s) => s.messageId).filter(Boolean),
    });

    return { dryRun: false, text: content.text, previews, delivered: okCount, sends };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Watchdog
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rede de segurança horária: publicação ATIVA cujo `nextRunAt` já passou faz
 * mais de 15 min e que não tem tick em voo perdeu o agendamento (exceção não
 * capturada, cancelamento externo). Diferente de uma campanha, uma publicação
 * vive meses — parar calada em março e ninguém notar até junho é o modo de
 * falha mais provável deste recurso.
 */
export const internalWatchdog = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query("groupPosts")
      .withIndex("by_status_and_next_run", (q) =>
        q.eq("status", "active").lt("nextRunAt", now - 15 * 60 * 1000)
      )
      .take(50);
    for (const post of stale) {
      // Reagendar é seguro mesmo se o job antigo ainda existir: o
      // `scheduleGroupPostTick` cancela o anterior e o tick é idempotente por
      // slot (`lastSlotKey`). Melhor reagendar à toa do que ficar parado.
      //
      // A LINHA DO TEMPO, porém, sai no máximo uma vez por dia: ela tem cap de
      // 100 (FIFO) e é a única fonte do histórico de envios. Um laço de alguns
      // dias escrevendo de hora em hora apagava justamente o que a aba
      // "Histórico" existe para mostrar.
      const lastWatchdog = [...(post.timeline ?? [])]
        .reverse()
        .find((e) => e.kind === "watchdog");
      if (!lastWatchdog || now - lastWatchdog.at > 24 * 60 * 60 * 1000) {
        await addPostTimeline(ctx, post, {
          at: now,
          kind: "watchdog",
          detail: "Agendamento perdido — publicação reativada",
        });
      }
      await scheduleGroupPostTick(ctx, (await ctx.db.get(post._id))!, now, now);
    }
    return null;
  },
});
