/**
 * Publicações programadas em grupos de WhatsApp — superfície do app (F3, D7/D8).
 *
 * "Todo dia às 12h o Guardião posta no grupo XYZ." Uma publicação junta:
 *   destinos (grupos monitorados do MESMO canal) + agenda (horários/dias/fuso)
 *   + conteúdo (biblioteca de mensagens prontas OU geração por IA)
 *   + política de aprovação.
 *
 * Este arquivo é só o CRUD e as decisões humanas (ativar, pausar, aprovar,
 * enviar agora). Quem dispara é `convex/groupPostWorker.ts`, um job
 * auto-reagendado por publicação — nunca um cron global, porque pausar uma
 * publicação não pode depender de filtrar um cron que roda para todas.
 *
 * RBAC (D11 + refinamento da F3), categoria `campaigns`:
 *   - `view`   → listar e abrir
 *   - `manage` → criar, editar, pausar, retomar, aprovar/rejeitar o pendente,
 *                e a PRÉVIA do "enviar agora"
 *   - `full`   → ativar, encerrar, excluir, enviar agora DE VERDADE e
 *                configurar "sem aprovação" (a IA publica sozinha no grupo do
 *                cliente, e isso não tem undo)
 *
 * Três validações existem para a publicação não falhar só na hora H:
 *   1. todos os destinos são do mesmo canal, monitorados e com conversa;
 *   2. biblioteca com pelo menos um item;
 *   3. conteúdo `ai` exige `orgAiActive` E `aiConfig.groupAgentEnabled`.
 */
import { v, type ObjectType } from "convex/values";
import { action, internalQuery, mutation, query, MutationCtx, QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { authorizeGroups, type InternalActorArgs } from "./lib/groupAuth";
import { buildAuditDescription } from "./lib/auditDescription";
import { orgAiActive } from "./lib/agentSecurity";
import {
  groupPostContentValidator,
  groupPostScheduleValidator,
} from "./schema";
import { MAX_POST_TARGETS, validateGroupPostContent } from "./lib/groupPostCore";
import { describeSchedule, slotKey, validateGroupPostSchedule } from "./lib/groupPostSchedule";
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers locais. O que o worker também usa (agendamento, linha do tempo,
// pausa, encerramento) mora em `lib/groupPostOps.ts` — os dois arquivos
// importarem um ao outro fecharia um ciclo de módulos.
// ─────────────────────────────────────────────────────────────────────────────

const LIST_CAP = 100;

/**
 * Valida os destinos: 1..MAX_POST_TARGETS grupos DA MESMA ORG, do MESMO canal,
 * monitorados, com conversa e sem ter saído. Devolve o canal resolvido.
 *
 * Grupo sem conversa não tem para onde mandar a mensagem, e grupo não
 * monitorado nunca teve conversa criada — recusar aqui é o que evita a
 * publicação que só descobre o problema no primeiro disparo.
 */
async function resolveTargets(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  groupChatIds: Id<"groupChats">[]
): Promise<{ channelConfigId: Id<"channelConfigs">; groups: Doc<"groupChats">[] }> {
  const unique = Array.from(new Set(groupChatIds));
  if (unique.length === 0) throw new Error("Escolha pelo menos um grupo");
  if (unique.length > MAX_POST_TARGETS) {
    throw new Error(`Uma publicação aceita no máximo ${MAX_POST_TARGETS} grupos`);
  }

  const groups: Doc<"groupChats">[] = [];
  for (const id of unique) {
    const group = await ctx.db.get(id);
    if (!group || group.organizationId !== organizationId) {
      throw new Error("Grupo não encontrado nesta organização");
    }
    if (!group.monitored || !group.conversationId) {
      throw new Error(`Acompanhe o grupo «${group.subject}» antes de programar publicações nele`);
    }
    if (group.leftAt !== undefined || group.removedAt !== undefined) {
      throw new Error(`O número não faz mais parte do grupo «${group.subject}»`);
    }
    groups.push(group);
  }

  const channelConfigId = groups[0].channelConfigId;
  if (groups.some((g) => g.channelConfigId !== channelConfigId)) {
    throw new Error("Todos os grupos de uma publicação devem ser do mesmo número");
  }
  const config = await ctx.db.get(channelConfigId);
  if (!config || config.organizationId !== organizationId) {
    throw new Error("Número do WhatsApp não encontrado");
  }
  if (config.bridgeGroupsEnabled !== true) {
    throw new Error("Ative os grupos neste número antes de programar publicações");
  }
  return { channelConfigId, groups };
}

/** Gate do conteúdo `ai`: IA da org ativa + interruptor do agente de grupo. */
async function assertAiContentAllowed(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  content: { kind: string }
): Promise<void> {
  if (content.kind !== "ai") return;
  const org = await ctx.db.get(organizationId);
  if (!orgAiActive(org)) {
    throw new Error("Ative a IA da organização (Configurações → IA) para gerar publicações");
  }
  if (org?.settings.aiConfig?.groupAgentEnabled !== true) {
    throw new Error("Ative a IA em grupos (Configurações → IA) para gerar publicações");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura
// ─────────────────────────────────────────────────────────────────────────────

/** Publicações da org, mais recentes primeiro. Gate `campaigns:view`. */
export const listArgs = {
  organizationId: v.id("organizations"),
  status: v.optional(
    v.union(v.literal("draft"), v.literal("active"), v.literal("paused"), v.literal("ended"))
  ),
  channelConfigId: v.optional(v.id("channelConfigs")),
};
export type ListArgs = ObjectType<typeof listArgs> & InternalActorArgs;
export async function listHandler(ctx: QueryCtx, args: ListArgs) {
    await authorizeGroups(ctx, args.organizationId, "campaigns", "view", args.actorMemberId);

    const rows = args.status
      ? await ctx.db
          .query("groupPosts")
          .withIndex("by_organization_and_status", (q) =>
            q.eq("organizationId", args.organizationId).eq("status", args.status!)
          )
          .take(LIST_CAP)
      : await ctx.db
          .query("groupPosts")
          .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
          .take(LIST_CAP);

    const filtered = args.channelConfigId
      ? rows.filter((p) => p.channelConfigId === args.channelConfigId)
      : rows;

    // Nome dos grupos para a linha da lista — sem a lista de participantes.
    const subjects = new Map<string, string>();
    for (const post of filtered) {
      for (const t of post.targets) {
        if (subjects.has(t.groupChatId)) continue;
        const g = await ctx.db.get(t.groupChatId);
        subjects.set(t.groupChatId, g?.subject ?? "grupo removido");
      }
    }

    return filtered
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ timeline, ...post }) => ({
        ...post,
        scheduleText: describeSchedule(scheduleOf(post as Doc<"groupPosts">)),
        targetNames: post.targets.map((t) => subjects.get(t.groupChatId) ?? "grupo removido"),
        pendingApproval: post.pending?.status === "pendingApproval" ? post.pending : undefined,
      }));
  }
export const list = query({
  args: listArgs,
  returns: v.any(),
  handler: listHandler,
});

/** Uma publicação, com destinos enriquecidos. Gate `campaigns:view`. */
export const getArgs = { groupPostId: v.id("groupPosts") };
export type GetArgs = ObjectType<typeof getArgs> & InternalActorArgs;
export async function getHandler(ctx: QueryCtx, args: GetArgs) {
    const post = await ctx.db.get(args.groupPostId);
    if (!post) return null;
    await authorizeGroups(ctx, post.organizationId, "campaigns", "view", args.actorMemberId);

    const targets = [];
    for (const t of post.targets) {
      const g = await ctx.db.get(t.groupChatId);
      targets.push({
        groupChatId: t.groupChatId,
        subject: g?.subject ?? "grupo removido",
        jid: g?.jid,
        conversationId: g?.conversationId,
        monitored: g?.monitored ?? false,
        left: g ? g.leftAt !== undefined || g.removedAt !== undefined : true,
      });
    }
    const config = await ctx.db.get(post.channelConfigId);
    return {
      ...post,
      scheduleText: describeSchedule(scheduleOf(post)),
      targets,
      channel: config
        ? {
            _id: config._id,
            displayName: config.displayName,
            sessionState: config.bridgeSessionState,
            groupsEnabled: config.bridgeGroupsEnabled === true,
            status: config.status,
          }
        : null,
    };
  }
export const get = query({
  args: getArgs,
  returns: v.any(),
  handler: getHandler,
});

/**
 * Histórico de envios: as entradas `kind: "sent"` da linha do tempo, da mais
 * recente para a mais antiga, com o nome do grupo e o id da mensagem (o link
 * para o inbox). Não há índice por `metadata.groupPost` em `messages` e criar
 * um custaria um índice novo numa tabela enorme para uma tela de consulta —
 * a linha do tempo (cap 100) é a fonte.
 */
export const getHistory = query({
  args: { groupPostId: v.id("groupPosts"), limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.groupPostId);
    if (!post) return [];
    await requirePermission(ctx, post.organizationId, "campaigns", "view");

    const subjects = new Map<string, string>();
    for (const t of post.targets) {
      const g = await ctx.db.get(t.groupChatId);
      subjects.set(t.groupChatId, g?.subject ?? "grupo removido");
    }

    const limit = Math.max(1, Math.min(100, args.limit ?? 50));
    return (post.timeline ?? [])
      .filter((e) => e.kind === "sent" || e.kind === "skipped" || e.kind === "failed")
      .slice(-limit)
      .reverse()
      .map((e) => ({
        at: e.at,
        kind: e.kind,
        detail: e.detail,
        slotKey: e.slotKey,
        sends: (e.sends ?? []).map((s) => ({
          ...s,
          subject: subjects.get(s.groupChatId) ?? "grupo removido",
        })),
      }));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Escrita
// ─────────────────────────────────────────────────────────────────────────────

export const createArgs = {
  organizationId: v.id("organizations"),
  name: v.string(),
  groupChatIds: v.array(v.id("groupChats")),
  schedule: groupPostScheduleValidator,
  content: groupPostContentValidator,
};
export type CreateArgs = ObjectType<typeof createArgs> & InternalActorArgs;
export async function createHandler(ctx: MutationCtx, args: CreateArgs) {
    const member = await authorizeGroups(
      ctx,
      args.organizationId,
      "campaigns",
      "manage",
      args.actorMemberId
    );

    const name = args.name.trim();
    if (!name) throw new Error("Dê um nome à publicação");

    const schedule = validateGroupPostSchedule(args.schedule);
    if (!schedule.ok) throw new Error(schedule.error);
    const content = validateGroupPostContent(args.content);
    if (!content.ok) throw new Error(content.error);
    await assertAiContentAllowed(ctx, args.organizationId, args.content);

    // "Sem aprovação" = a IA publica sozinha no grupo do cliente. Configurar
    // isso é decisão de `campaigns:full`, mesmo que criar seja de `manage`.
    if (args.content.kind === "ai" && args.content.ai?.requiresApproval === false) {
      await authorizeGroups(ctx, args.organizationId, "campaigns", "full", args.actorMemberId);
    }

    const { channelConfigId } = await resolveTargets(ctx, args.organizationId, args.groupChatIds);
    await assertAttachmentsInOrg(ctx, args.organizationId, args.content);

    const now = Date.now();
    const postId = await ctx.db.insert("groupPosts", {
      organizationId: args.organizationId,
      name,
      status: "draft",
      channelConfigId,
      targets: Array.from(new Set(args.groupChatIds)).map((groupChatId) => ({ groupChatId })),
      schedule: schedule.value,
      content: args.content,
      stats: { sent: 0, skipped: 0, failed: 0 },
      timeline: [{ at: now, kind: "created", actorId: member._id, detail: name }],
      createdBy: member._id,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "groupPost",
      entityId: postId,
      action: "create",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      metadata: {
        name,
        kind: args.content.kind,
        groups: args.groupChatIds.length,
        schedule: describeSchedule(schedule.value),
        requiresApproval: args.content.ai?.requiresApproval,
      },
      description: `Publicação programada '${name}' criada`,
      severity: args.content.ai?.requiresApproval === false ? "high" : "low",
      createdAt: now,
    });

    return postId;
  }
export const create = mutation({
  args: createArgs,
  returns: v.id("groupPosts"),
  handler: createHandler,
});

/**
 * Edita a publicação. Em `active` o `nextRunAt` é recalculado e o tick
 * reagendado na hora — o contrário (esperar o próximo tick) deixaria a
 * publicação disparando pela agenda antiga até o horário velho chegar.
 */
export const updateArgs = {
  groupPostId: v.id("groupPosts"),
  name: v.optional(v.string()),
  groupChatIds: v.optional(v.array(v.id("groupChats"))),
  schedule: v.optional(groupPostScheduleValidator),
  content: v.optional(groupPostContentValidator),
};
export type UpdateArgs = ObjectType<typeof updateArgs> & InternalActorArgs;
export async function updateHandler(ctx: MutationCtx, args: UpdateArgs) {
    const post = await ctx.db.get(args.groupPostId);
    if (!post) throw new Error("Publicação não encontrada");
    const member = await authorizeGroups(
      ctx,
      post.organizationId,
      "campaigns",
      "manage",
      args.actorMemberId
    );
    if (post.status === "ended") throw new Error("Publicação encerrada não pode ser editada");

    const now = Date.now();
    const patch: Partial<Doc<"groupPosts">> = { updatedAt: now };

    if (args.name !== undefined) {
      const name = args.name.trim();
      if (!name) throw new Error("Dê um nome à publicação");
      patch.name = name;
    }

    if (args.schedule !== undefined) {
      const schedule = validateGroupPostSchedule(args.schedule);
      if (!schedule.ok) throw new Error(schedule.error);
      patch.schedule = schedule.value;
    }

    if (args.content !== undefined) {
      const content = validateGroupPostContent(args.content);
      if (!content.ok) throw new Error(content.error);
      await assertAiContentAllowed(ctx, post.organizationId, args.content);
      if (args.content.kind === "ai" && args.content.ai?.requiresApproval === false) {
        await authorizeGroups(ctx, post.organizationId, "campaigns", "full", args.actorMemberId);
      }
      await assertAttachmentsInOrg(ctx, post.organizationId, args.content);
      patch.content = args.content;
      // Texto pendente pertence ao conteúdo ANTIGO — mudar o conteúdo o invalida.
      patch.pending = undefined;
    }

    if (args.groupChatIds !== undefined) {
      const { channelConfigId } = await resolveTargets(ctx, post.organizationId, args.groupChatIds);
      patch.channelConfigId = channelConfigId;
      patch.targets = Array.from(new Set(args.groupChatIds)).map((groupChatId) => ({ groupChatId }));
    }

    await ctx.db.patch(post._id, patch);
    const fresh = (await ctx.db.get(post._id))!;

    if (fresh.status === "active") {
      // Slot JÁ vencido e ainda não resolvido (canal congelado, tick atrasado):
      // recalcular às cegas cancelava o tique em voo e o disparo de hoje sumia
      // sem `skipped` e sem linha do tempo. Se a agenda não mudou, o slot é
      // PRESERVADO e o tique volta agora (o worker reavalia congelamento e
      // tolerância de atraso); se mudou, ele deixa de existir e fica
      // REGISTRADO como pulado.
      const owedRunAt = post.nextRunAt;
      const owedSlot =
        owedRunAt !== undefined
          ? post.nextSlotKey ?? slotKey(scheduleOf(post), owedRunAt)
          : undefined;
      const owed =
        owedRunAt !== undefined &&
        owedSlot !== undefined &&
        owedRunAt <= now &&
        post.lastSlotKey !== owedSlot;

      if (owed && args.schedule === undefined) {
        await ctx.db.patch(fresh._id, { nextRunAt: owedRunAt, nextSlotKey: owedSlot });
        await scheduleGroupPostTick(ctx, (await ctx.db.get(fresh._id))!, now, now);
      } else {
        if (owed) {
          const reason = "Horário perdido: a agenda foi editada antes do disparo";
          await ctx.db.patch(fresh._id, {
            stats: { ...fresh.stats, skipped: fresh.stats.skipped + 1, lastError: reason },
            lastSlotKey: owedSlot,
          });
          await addPostTimeline(ctx, (await ctx.db.get(fresh._id))!, {
            at: now,
            kind: "skipped",
            slotKey: owedSlot,
            detail: reason,
            actorId: member._id,
          });
        }
        const current = (await ctx.db.get(fresh._id))!;
        const next = computeNextRun(current, now);
        if (next === null) {
          await endPostCore(ctx, current, {
            now,
            actorId: member._id,
            reason: "Agenda sem próximos horários",
          });
        } else {
          await ctx.db.patch(current._id, { nextRunAt: next.at, nextSlotKey: next.slotKey });
          await scheduleGroupPostTick(
            ctx,
            (await ctx.db.get(current._id))!,
            wakeAtFor(current, next.at),
            now
          );
        }
      }
    }

    await addPostTimeline(ctx, (await ctx.db.get(post._id))!, {
      at: now,
      kind: "updated",
      actorId: member._id,
    });

    await ctx.db.insert("auditLogs", {
      organizationId: post.organizationId,
      entityType: "groupPost",
      entityId: post._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      metadata: { name: fresh.name },
      description: buildAuditDescription({
        action: "update",
        entityType: "groupPost",
        metadata: { name: fresh.name },
      }),
      severity: "low",
      createdAt: now,
    });
    return null;
  }
export const update = mutation({
  args: updateArgs,
  returns: v.null(),
  handler: updateHandler,
});

export const activateArgs = { groupPostId: v.id("groupPosts") };
export type ActivateArgs = ObjectType<typeof activateArgs> & InternalActorArgs;
export async function activateHandler(ctx: MutationCtx, args: ActivateArgs) {
    const post = await ctx.db.get(args.groupPostId);
    if (!post) throw new Error("Publicação não encontrada");
    // RETOMAR uma publicação que já foi ativada (e portanto já passou por
    // `campaigns:full`) é o par do `pause`, que é `manage`: sem isso um blip
    // da sessão pausava a agenda e só um admin conseguia religá-la. A PRIMEIRA
    // ativação — o momento em que o CRM passa a escrever sozinho numa sala de
    // gente real — continua exigindo `campaigns:full`.
    const resuming = post.status === "paused" && post.startedAt !== undefined;
    const member = await authorizeGroups(
      ctx,
      post.organizationId,
      "campaigns",
      resuming ? "manage" : "full",
      args.actorMemberId
    );
    if (post.status === "active") return null;
    if (post.status === "ended") throw new Error("Publicação encerrada — duplique para reativar");

    // Re-checa tudo o que pode ter mudado desde a criação (grupo abandonado,
    // canal desligado, IA desativada). Ativar é o momento de descobrir.
    await resolveTargets(
      ctx,
      post.organizationId,
      post.targets.map((t) => t.groupChatId)
    );
    await assertAiContentAllowed(ctx, post.organizationId, post.content);
    const contentCheck = validateGroupPostContent(post.content);
    if (!contentCheck.ok) throw new Error(contentCheck.error);

    const now = Date.now();
    const next = computeNextRun(post, now);
    if (next === null) {
      // A busca olha no máximo 400 dias à frente: `startAt` em 2028 devolve
      // `null` sem que a agenda tenha "acabado". Dizer só "não tem horário
      // futuro" mandava o operador procurar erro onde não havia.
      throw new Error(
        "A agenda não tem nenhum horário nos próximos 400 dias — confira as datas de início e fim"
      );
    }

    await ctx.db.patch(post._id, {
      status: "active",
      nextRunAt: next.at,
      nextSlotKey: next.slotKey,
      channelRetries: undefined,
      pausedReason: undefined,
      pausedBy: undefined,
      startedAt: post.startedAt ?? now,
      updatedAt: now,
    });
    const fresh = (await ctx.db.get(post._id))!;
    await scheduleGroupPostTick(ctx, fresh, wakeAtFor(fresh, next.at), now);
    await addPostTimeline(ctx, (await ctx.db.get(post._id))!, {
      at: now,
      kind: "activated",
      actorId: member._id,
      detail: describeSchedule(scheduleOf(fresh)),
    });

    await ctx.db.insert("auditLogs", {
      organizationId: post.organizationId,
      entityType: "groupPost",
      entityId: post._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      changes: { before: { status: post.status }, after: { status: "active" } },
      metadata: {
        name: post.name,
        groups: post.targets.length,
        schedule: describeSchedule(scheduleOf(fresh)),
        kind: post.content.kind,
      },
      // `high`: a partir daqui o CRM escreve sozinho num grupo de gente real.
      description: `Publicação programada '${post.name}' ativada`,
      severity: "high",
      createdAt: now,
    });

    await postWebhook(ctx, post.organizationId, "group.post.activated", {
      groupPostId: post._id,
      name: post.name,
      nextRunAt: next.at,
      groups: post.targets.length,
    });
    return null;
  }
export const activate = mutation({
  args: activateArgs,
  returns: v.null(),
  handler: activateHandler,
});

export const pauseArgs = { groupPostId: v.id("groupPosts"), reason: v.optional(v.string()) };
export type PauseArgs = ObjectType<typeof pauseArgs> & InternalActorArgs;
export async function pauseHandler(ctx: MutationCtx, args: PauseArgs) {
    const post = await ctx.db.get(args.groupPostId);
    if (!post) throw new Error("Publicação não encontrada");
    const member = await authorizeGroups(
      ctx,
      post.organizationId,
      "campaigns",
      "manage",
      args.actorMemberId
    );
    if (post.status !== "active") throw new Error("Só uma publicação ativa pode ser pausada");
    await pausePostCore(ctx, post, {
      now: Date.now(),
      reason: (args.reason ?? "").trim() || "Pausada manualmente",
      actorId: member._id,
      automatic: false,
    });
    return null;
  }
export const pause = mutation({
  args: pauseArgs,
  returns: v.null(),
  handler: pauseHandler,
});

export const end = mutation({
  args: { groupPostId: v.id("groupPosts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.groupPostId);
    if (!post) throw new Error("Publicação não encontrada");
    const member = await requirePermission(ctx, post.organizationId, "campaigns", "full");
    await endPostCore(ctx, post, { now: Date.now(), actorId: member._id, reason: "Encerrada manualmente" });
    return null;
  },
});

/** Exclusão definitiva. Só rascunho ou encerrada — ativa/pausada, encerre antes. */
export const remove = mutation({
  args: { groupPostId: v.id("groupPosts") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.groupPostId);
    if (!post) throw new Error("Publicação não encontrada");
    const member = await requirePermission(ctx, post.organizationId, "campaigns", "full");
    if (post.status !== "draft" && post.status !== "ended") {
      throw new Error("Encerre a publicação antes de excluí-la");
    }
    const now = Date.now();
    if (post.schedulerFnId) {
      try {
        await ctx.scheduler.cancel(post.schedulerFnId as Id<"_scheduled_functions">);
      } catch {
        // já rodou
      }
    }
    await ctx.db.insert("auditLogs", {
      organizationId: post.organizationId,
      entityType: "groupPost",
      entityId: post._id,
      action: "delete",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      changes: { before: { name: post.name, status: post.status, stats: post.stats } },
      metadata: { name: post.name },
      description: `Publicação programada '${post.name}' excluída`,
      severity: "medium",
      createdAt: now,
    });
    await ctx.db.delete(post._id);
    return null;
  },
});

// ── Aprovação do texto gerado pela IA ──

export const approvePendingArgs = {
  groupPostId: v.id("groupPosts"),
  editedText: v.optional(v.string()),
};
export type ApprovePendingArgs = ObjectType<typeof approvePendingArgs> & InternalActorArgs;
export async function approvePendingHandler(ctx: MutationCtx, args: ApprovePendingArgs) {
    const post = await ctx.db.get(args.groupPostId);
    if (!post) throw new Error("Publicação não encontrada");
    const member = await authorizeGroups(
      ctx,
      post.organizationId,
      "campaigns",
      "manage",
      args.actorMemberId
    );
    if (!post.pending || post.pending.status !== "pendingApproval") {
      throw new Error("Não há texto esperando aprovação");
    }
    const edited = args.editedText?.trim();
    const now = Date.now();
    await ctx.db.patch(post._id, {
      pending: {
        ...post.pending,
        status: "approved",
        approvedBy: member._id,
        ...(edited ? { editedText: edited } : {}),
      },
      updatedAt: now,
    });
    await addPostTimeline(ctx, (await ctx.db.get(post._id))!, {
      at: now,
      kind: "approved",
      actorId: member._id,
      slotKey: post.pending.slotKey,
      detail: edited ? "aprovado com edição" : "aprovado",
    });
    await ctx.db.insert("auditLogs", {
      organizationId: post.organizationId,
      entityType: "groupPost",
      entityId: post._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      metadata: { name: post.name, slotKey: post.pending.slotKey, edited: !!edited },
      description: `Texto da publicação '${post.name}' aprovado`,
      severity: "medium",
      createdAt: now,
    });
    return null;
  }
export const approvePending = mutation({
  args: approvePendingArgs,
  returns: v.null(),
  handler: approvePendingHandler,
});

export const rejectPendingArgs = {
  groupPostId: v.id("groupPosts"),
  reason: v.optional(v.string()),
};
export type RejectPendingArgs = ObjectType<typeof rejectPendingArgs> & InternalActorArgs;
export async function rejectPendingHandler(ctx: MutationCtx, args: RejectPendingArgs) {
    const post = await ctx.db.get(args.groupPostId);
    if (!post) throw new Error("Publicação não encontrada");
    const member = await authorizeGroups(
      ctx,
      post.organizationId,
      "campaigns",
      "manage",
      args.actorMemberId
    );
    if (!post.pending || post.pending.status !== "pendingApproval") {
      throw new Error("Não há texto esperando aprovação");
    }
    const now = Date.now();
    await ctx.db.patch(post._id, {
      pending: { ...post.pending, status: "rejected", approvedBy: member._id },
      updatedAt: now,
    });
    await addPostTimeline(ctx, (await ctx.db.get(post._id))!, {
      at: now,
      kind: "rejected",
      actorId: member._id,
      slotKey: post.pending.slotKey,
      detail: args.reason?.trim() || undefined,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: post.organizationId,
      entityType: "groupPost",
      entityId: post._id,
      action: "update",
      actorId: member._id,
      actorType: member.type === "ai" ? "ai" : "human",
      metadata: { name: post.name, slotKey: post.pending.slotKey, reason: args.reason },
      description: `Texto da publicação '${post.name}' rejeitado`,
      severity: "medium",
      createdAt: now,
    });
    return null;
  }
export const rejectPending = mutation({
  args: rejectPendingArgs,
  returns: v.null(),
  handler: rejectPendingHandler,
});

// ── "Enviar agora" (teste) ──

/**
 * Dispara a publicação FORA da agenda. `dryRun` devolve só o texto que sairia
 * (gate `campaigns:manage`); o envio de verdade exige `campaigns:full`, porque
 * manda mensagem para gente real num grupo.
 *
 * É uma action porque o conteúdo `ai` precisa chamar o LLM. Os tetos por canal,
 * o congelamento e o estado da sessão valem igual ao disparo programado — a
 * única coisa que "enviar agora" pula é o relógio.
 */
export const sendNow = action({
  args: { groupPostId: v.id("groupPosts"), dryRun: v.optional(v.boolean()) },
  returns: v.any(),
  handler: async (ctx, args): Promise<any> => {
    return await ctx.runAction(internal.groupPostWorker.internalSendNow, {
      groupPostId: args.groupPostId,
      dryRun: args.dryRun === true,
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Internos
// ─────────────────────────────────────────────────────────────────────────────

/** Anexos da biblioteca têm que ser da org (mesma guarda de `sendMessage`). */
async function assertAttachmentsInOrg(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  content: { library?: { items: Array<{ attachmentFileIds?: Id<"files">[] }> } }
): Promise<void> {
  for (const item of content.library?.items ?? []) {
    for (const fileId of item.attachmentFileIds ?? []) {
      const file = await ctx.db.get(fileId);
      if (!file || file.organizationId !== organizationId) {
        throw new Error("Anexo inválido para esta organização");
      }
    }
  }
}

/**
 * RBAC do "enviar agora", avaliado dentro de uma query para a action poder
 * chamá-la com a identidade do usuário. Devolve o membro que assina o envio.
 */
export const internalAssertCanSendNow = internalQuery({
  args: { groupPostId: v.id("groupPosts"), dryRun: v.boolean() },
  returns: v.object({ memberId: v.id("teamMembers"), organizationId: v.id("organizations") }),
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.groupPostId);
    if (!post) throw new Error("Publicação não encontrada");
    const member = await requirePermission(
      ctx,
      post.organizationId,
      "campaigns",
      args.dryRun ? "manage" : "full"
    );
    return { memberId: member._id, organizationId: post.organizationId };
  },
});
