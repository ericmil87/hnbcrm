/**
 * Tools de GRUPO do copiloto (F4, §9.4) — executores.
 *
 * Moram aqui, e não em `copilot.ts`, por dois motivos: manter o arquivo do
 * copiloto (que outros agentes tocam) com uma superfície mínima, e poder
 * importar os helpers puros das publicações (`lib/groupPost*`) sem arrastar
 * `convex/groupPosts.ts` para dentro de `copilot.ts` — o que fecharia um ciclo
 * de módulos.
 *
 * Regras que valem para TODAS as funções deste arquivo:
 *  - o RBAC já foi aplicado pelo executor do copiloto (`assertAgentCan` com a
 *    permissão declarada no spec da tool). Aqui só re-validamos a ORG de cada
 *    id que veio do modelo;
 *  - nenhum retorno carrega o doc de `channelConfigs`: o token do gateway mora
 *    lá, e o copiloto fala com um LLM externo. O que sai é montado campo a
 *    campo;
 *  - telefone de membro sai MASCARADO. O modelo não precisa do número inteiro
 *    para responder "quem está no grupo", e a lista de membros é dado de
 *    terceiros (LGPD).
 */
import { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { describeSchedule, validateGroupPostSchedule } from "./groupPostSchedule";
import { MAX_POST_TARGETS, validateGroupPostContent } from "./groupPostCore";
import { computeNextRun, pausePostCore, scheduleGroupPostTick, scheduleOf, wakeAtFor, addPostTimeline, postWebhook } from "./groupPostOps";
import { createLeadFromGroupMemberCore } from "./groupMemberLead";
import { assertAgentCan } from "./agentSecurity";
import { applyOutboundMessageSideEffects } from "./outboundSideEffects";

const GROUP_LIST_CAP = 50;
const MEMBERS_IN_TOOL = 50;
/** Um resumo com menos de 1 h não paga outra inferência. */
const SUMMARY_FRESH_MS = 60 * 60 * 1000;
const GROUP_POST_LIST_CAP = 50;

function maskPhone(phone: string | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length <= 4) return `••${digits}`;
  return `••••${digits.slice(-4)}`;
}

/** Só o que o modelo precisa saber sobre a sala — nunca o doc do canal. */
function groupRow(group: Doc<"groupChats">) {
  return {
    groupChatId: group._id as string,
    subject: group.subject,
    membros: group.participants?.filter((p) => p.leftAt === undefined).length ?? 0,
    acompanhado: group.monitored === true,
    somosAdmin: group.weAreAdmin === true,
    ia: group.ai?.mode ?? "off",
    radar: group.ai?.opportunityRadar === true,
    ultimaMensagemEm: group.lastMessageAt ?? null,
    saiuDoGrupo: group.leftAt !== undefined || group.removedAt !== undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Leitura (roda em query — nada de Date.now())
// ─────────────────────────────────────────────────────────────────────────────

export function isGroupReadTool(name: string): boolean {
  return ["listGroups", "getGroupDetail", "listGroupPosts", "getGroupPostHistory"].includes(name);
}

export async function runGroupReadTool(
  ctx: QueryCtx,
  name: string,
  toolArgs: Record<string, unknown>,
  organizationId: Id<"organizations">
): Promise<Record<string, unknown>> {
  switch (name) {
    case "listGroups": {
      const all = await ctx.db
        .query("groupChats")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .take(200);
      const query = typeof toolArgs.query === "string" ? toolArgs.query.toLowerCase() : null;
      const rows = all
        .filter((g) => g.removedAt === undefined)
        .filter((g) => (toolArgs.onlyMonitored === true ? g.monitored === true : true))
        .filter((g) => (query ? g.subject.toLowerCase().includes(query) : true))
        .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt));
      return {
        groups: rows.slice(0, GROUP_LIST_CAP).map(groupRow),
        total: rows.length,
      };
    }

    case "getGroupDetail": {
      const group = await resolveGroup(ctx, toolArgs.groupChatId, organizationId);
      if (!group) return { error: "Grupo não encontrado" };
      const active = (group.participants ?? []).filter((p) => p.leftAt === undefined);
      return {
        group: {
          ...groupRow(group),
          topico: group.topic ?? null,
          somenteAdminsPostam: group.isAnnounce === true,
          mensagensTemporarias: group.isEphemeral === true,
          instrucoesDaEquipe: group.ai?.extraInstructions ?? null,
          resumo: group.summary ? { at: group.summary.at, texto: group.summary.text } : null,
        },
        members: active.slice(0, MEMBERS_IN_TOOL).map((p) => ({
          chave: p.lid ?? p.phone ?? "",
          nome: p.name ?? null,
          telefone: maskPhone(p.phone),
          admin: p.isAdmin === true || p.isSuperAdmin === true,
          jaEhContato: p.contactId !== undefined,
        })),
        membersTotal: active.length,
      };
    }

    case "listGroupPosts": {
      const status = typeof toolArgs.status === "string" ? toolArgs.status : null;
      const rows = (
        await ctx.db
          .query("groupPosts")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
          .take(GROUP_POST_LIST_CAP)
      ).filter((p) => (status ? p.status === status : true));
      const posts = [];
      for (const post of rows) {
        posts.push({
          groupPostId: post._id as string,
          nome: post.name,
          status: post.status,
          agenda: describeSchedule(scheduleOf(post)),
          conteudo: post.content.kind,
          grupos: post.targets.length,
          proximoDisparo: post.nextRunAt ?? null,
          enviados: post.stats?.sent ?? 0,
          aguardandoAprovacao: post.pending?.status === "pendingApproval",
        });
      }
      return { posts, total: posts.length };
    }

    case "getGroupPostHistory": {
      const post = await resolvePost(ctx, toolArgs.groupPostId, organizationId);
      if (!post) return { error: "Publicação não encontrada" };
      const limit = Math.max(1, Math.min(50, Number(toolArgs.limit) || 20));
      const subjects = new Map<string, string>();
      for (const t of post.targets) {
        const g = await ctx.db.get(t.groupChatId);
        subjects.set(t.groupChatId, g?.subject ?? "grupo removido");
      }
      return {
        post: { groupPostId: post._id as string, nome: post.name, status: post.status },
        history: (post.timeline ?? [])
          .filter((e) => e.kind === "sent" || e.kind === "skipped" || e.kind === "failed")
          .slice(-limit)
          .reverse()
          .map((e) => ({
            at: e.at,
            tipo: e.kind,
            detalhe: e.detail ?? null,
            grupos: (e.sends ?? []).map((s) => subjects.get(s.groupChatId) ?? "grupo removido"),
          })),
      };
    }

    default:
      return { error: `Tool de grupo não implementada: ${name}` };
  }
}

async function resolveGroup(
  ctx: QueryCtx | MutationCtx,
  raw: unknown,
  organizationId: Id<"organizations">
): Promise<Doc<"groupChats"> | null> {
  if (typeof raw !== "string") return null;
  const group = await ctx.db.get(raw as Id<"groupChats">).catch(() => null);
  if (!group || group.organizationId !== organizationId) return null;
  return group;
}

async function resolvePost(
  ctx: QueryCtx | MutationCtx,
  raw: unknown,
  organizationId: Id<"organizations">
): Promise<Doc<"groupPosts"> | null> {
  if (typeof raw !== "string") return null;
  const post = await ctx.db.get(raw as Id<"groupPosts">).catch(() => null);
  if (!post || post.organizationId !== organizationId) return null;
  return post;
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrita
// ─────────────────────────────────────────────────────────────────────────────

export function isGroupWriteTool(name: string): boolean {
  return [
    "getGroupSummary",
    "createGroupPostDraft",
    "pauseGroupPost",
    "activateGroupPost",
    "sendGroupMessage",
    "createLeadFromGroupMember",
  ].includes(name);
}

export async function runGroupWriteTool(
  ctx: MutationCtx,
  name: string,
  toolArgs: Record<string, unknown>,
  scope: {
    organizationId: Id<"organizations">;
    member: Doc<"teamMembers">;
    threadId?: Id<"copilotThreads">;
    pendingActionTtlMs: number;
  }
): Promise<Record<string, unknown>> {
  const { organizationId, member } = scope;
  const now = Date.now();

  switch (name) {
    case "getGroupSummary": {
      const group = await resolveGroup(ctx, toolArgs.groupChatId, organizationId);
      if (!group) return { error: "Grupo não encontrado" };
      const org = await ctx.db.get(organizationId);
      if (org?.settings.aiConfig?.groupAgentEnabled !== true) {
        return { error: "A IA em grupos está desativada nesta organização" };
      }
      const hours = Number(toolArgs.hours) === 168 ? 168 : 24;
      const fresh =
        group.summary &&
        group.summary.at > now - SUMMARY_FRESH_MS &&
        (group.summary.hours ?? 24) === hours;
      if (fresh) {
        return {
          status: "resumo_pronto",
          summary: group.summary!.text,
          at: group.summary!.at,
          hours,
          ageMinutes: Math.round((now - group.summary!.at) / 60_000),
        };
      }
      if (!group.monitored || !group.conversationId) {
        return { error: "O grupo não está sendo acompanhado — não há mensagens para resumir" };
      }
      // Gerar é uma chamada de LLM: sai da transação, agendada.
      await ctx.scheduler.runAfter(0, internal.groupAgent.internalGenerateSummary, {
        groupChatId: group._id,
        hours,
      });
      return {
        status: "gerando",
        hours,
        ...(group.summary
          ? {
              summary: group.summary.text,
              at: group.summary.at,
              ageMinutes: Math.round((now - group.summary.at) / 60_000),
            }
          : {}),
      };
    }

    case "createGroupPostDraft": {
      const name_ = typeof toolArgs.name === "string" ? toolArgs.name.trim() : "";
      if (!name_) return { error: "name é obrigatório" };
      const ids = Array.isArray(toolArgs.groupChatIds) ? toolArgs.groupChatIds : [];
      const messages = Array.isArray(toolArgs.messages)
        ? toolArgs.messages.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
        : [];
      if (messages.length === 0) return { error: "Informe pelo menos uma mensagem" };

      const groups: Doc<"groupChats">[] = [];
      for (const raw of Array.from(new Set(ids))) {
        const group = await resolveGroup(ctx, raw, organizationId);
        if (!group) return { error: "Grupo não encontrado nesta organização" };
        if (!group.monitored || !group.conversationId) {
          return { error: `Acompanhe o grupo «${group.subject}» antes de programar publicações` };
        }
        if (group.leftAt !== undefined || group.removedAt !== undefined) {
          return { error: `O número não faz mais parte do grupo «${group.subject}»` };
        }
        groups.push(group);
      }
      if (groups.length === 0) return { error: "Escolha pelo menos um grupo" };
      if (groups.length > MAX_POST_TARGETS) {
        return { error: `Uma publicação aceita no máximo ${MAX_POST_TARGETS} grupos` };
      }
      const channelConfigId = groups[0].channelConfigId;
      if (groups.some((g) => g.channelConfigId !== channelConfigId)) {
        return { error: "Todos os grupos de uma publicação devem ser do mesmo número" };
      }
      const config = await ctx.db.get(channelConfigId);
      if (config?.bridgeGroupsEnabled !== true) {
        return { error: "Ative os grupos neste número antes de programar publicações" };
      }

      const org = await ctx.db.get(organizationId);
      const schedule = validateGroupPostSchedule({
        timezone:
          typeof toolArgs.timezone === "string" && toolArgs.timezone
            ? toolArgs.timezone
            : (org?.settings.timezone ?? "America/Sao_Paulo"),
        times: Array.isArray(toolArgs.times)
          ? toolArgs.times.filter((t): t is string => typeof t === "string")
          : [],
        // `days` vazio = todos os dias. O validador exige a lista explícita, e
        // pedir os sete dias em linguagem natural ("todo dia às 12h") é o caso
        // mais comum de todos.
        days:
          Array.isArray(toolArgs.days) && toolArgs.days.length > 0
            ? toolArgs.days.filter((d): d is number => typeof d === "number")
            : [1, 2, 3, 4, 5, 6, 7],
      });
      if (!schedule.ok) return { error: schedule.error };

      const content = {
        kind: "library" as const,
        library: {
          items: messages.map((text) => ({ text: text.slice(0, 4000), contentType: "text" as const })),
          order: toolArgs.order === "random" ? ("random" as const) : ("sequential" as const),
        },
      };
      const contentCheck = validateGroupPostContent(content);
      if (!contentCheck.ok) return { error: contentCheck.error };

      const postId = await ctx.db.insert("groupPosts", {
        organizationId,
        name: name_,
        status: "draft",
        channelConfigId,
        targets: groups.map((g) => ({ groupChatId: g._id })),
        schedule: schedule.value,
        content,
        stats: { sent: 0, skipped: 0, failed: 0 },
        timeline: [{ at: now, kind: "created", actorId: member._id, detail: name_ }],
        createdBy: member._id,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("auditLogs", {
        organizationId,
        entityType: "groupPost",
        entityId: postId,
        action: "create",
        actorId: member._id,
        actorType: "human",
        metadata: { name: name_, groups: groups.length, via: "copilot" },
        description: `Publicação programada '${name_}' criada (via Copiloto)`,
        severity: "low",
        createdAt: now,
      });
      return {
        status: "rascunho_criado",
        groupPostId: postId,
        name: name_,
        schedule: describeSchedule(schedule.value),
        groups: groups.length,
        next: "O rascunho não dispara nada. Peça a ativação (ela exige confirmação humana) ou ative em /app/grupos.",
      };
    }

    case "pauseGroupPost": {
      const post = await resolvePost(ctx, toolArgs.groupPostId, organizationId);
      if (!post) return { error: "Publicação não encontrada" };
      if (post.status !== "active") {
        return { error: `A publicação está em "${post.status}" e não pode ser pausada` };
      }
      await pausePostCore(ctx, post, {
        now,
        reason: typeof toolArgs.reason === "string" && toolArgs.reason.trim()
          ? toolArgs.reason.trim()
          : "Pausada via Copiloto",
        actorId: member._id,
        automatic: false,
      });
      return { status: "pausada", groupPostId: post._id };
    }

    case "activateGroupPost": {
      // TWO-PHASE: a partir da ativação o CRM escreve SOZINHO num grupo de
      // gente real, todo dia. Isso não sai de um pedido em linguagem natural.
      const post = await resolvePost(ctx, toolArgs.groupPostId, organizationId);
      if (!post) return { error: "Publicação não encontrada" };
      if (post.status === "active") return { error: "A publicação já está ativa" };
      if (post.status === "ended") return { error: "Publicação encerrada — duplique para reativar" };
      const preview = `Ativar a publicação «${post.name}» — ${describeSchedule(scheduleOf(post))}, em ${post.targets.length} grupo(s). A partir daí o CRM publica sozinho.`;
      const pendingActionId = await ctx.db.insert("pendingActions", {
        organizationId,
        requestedBy: member._id,
        threadId: scope.threadId,
        tool: "activateGroupPost",
        args: { groupPostId: post._id },
        preview,
        status: "pending",
        expiresAt: now + scope.pendingActionTtlMs,
        createdAt: now,
      });
      return { status: "confirmacao_necessaria", pendingActionId, preview };
    }

    case "sendGroupMessage": {
      // TWO-PHASE: publicar num grupo alcança dezenas de pessoas de fora da
      // empresa de uma vez, e não tem undo.
      const group = await resolveGroup(ctx, toolArgs.groupChatId, organizationId);
      if (!group) return { error: "Grupo não encontrado" };
      if (!group.monitored || !group.conversationId) {
        return { error: "Acompanhe o grupo antes de publicar nele" };
      }
      const text = typeof toolArgs.text === "string" ? toolArgs.text.trim() : "";
      if (!text) return { error: "text é obrigatório" };
      if (text.length > 4000) return { error: "Mensagem longa demais (máx. 4000 caracteres)" };
      const members = group.participants?.filter((p) => p.leftAt === undefined).length ?? 0;
      const preview = `Publicar no grupo «${group.subject}» (${members} membros): "${text.slice(0, 160)}${text.length > 160 ? "…" : ""}"`;
      const pendingActionId = await ctx.db.insert("pendingActions", {
        organizationId,
        requestedBy: member._id,
        threadId: scope.threadId,
        tool: "sendGroupMessage",
        args: { groupChatId: group._id, text },
        preview,
        status: "pending",
        expiresAt: now + scope.pendingActionTtlMs,
        createdAt: now,
      });
      return { status: "confirmacao_necessaria", pendingActionId, preview };
    }

    case "createLeadFromGroupMember": {
      const group = await resolveGroup(ctx, toolArgs.groupChatId, organizationId);
      if (!group) return { error: "Grupo não encontrado" };
      const key = typeof toolArgs.participantKey === "string" ? toolArgs.participantKey : "";
      if (!key) return { error: "participantKey é obrigatório" };
      // A spec da tool declara UMA permissão (`leads:edit_own`) e é ela que o
      // executor do copiloto checa — mas o núcleo cria um CONTATO
      // (`findOrCreateContactByPhone`). A mutation equivalente da tela exige as
      // DUAS (`groupChats.createLeadFromMember`), e um membro com o override
      // explícito `contacts: "view"` + `leads: "edit_own"` conseguia criar
      // contato pelo copiloto (review de segurança nº 2). Espelhamos a tela.
      await assertAgentCan(ctx, member._id, "contacts", "edit");
      try {
        const result = await createLeadFromGroupMemberCore(ctx, {
          group,
          participantKey: key,
          actorId: member._id,
          actorType: "human",
          via: "Copiloto",
        });
        return {
          status: result.created ? "lead_criado" : "lead_existente",
          leadId: result.leadId,
          contactId: result.contactId,
          conversationId: result.conversationId,
          created: result.created,
        };
      } catch (e) {
        return { error: e instanceof Error ? e.message : "Falha ao criar o lead" };
      }
    }

    default:
      return { error: `Tool de grupo não implementada: ${name}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirmação das ações two-phase
// ─────────────────────────────────────────────────────────────────────────────

export function isGroupPendingTool(tool: string): boolean {
  return tool === "sendGroupMessage" || tool === "activateGroupPost";
}

/**
 * Executa a ação proposta DEPOIS do clique humano. A permissão é re-checada
 * pelo chamador (`copilot.confirmPendingAction`) no momento da confirmação — o
 * papel do usuário pode ter mudado desde a proposta.
 */
export async function confirmGroupPendingAction(
  ctx: MutationCtx,
  pending: Doc<"pendingActions">,
  member: Doc<"teamMembers">
): Promise<void> {
  const now = Date.now();
  if (pending.tool === "sendGroupMessage") {
    const groupChatId = pending.args.groupChatId as Id<"groupChats">;
    const group = await ctx.db.get(groupChatId);
    if (!group || group.organizationId !== pending.organizationId) {
      throw new Error("Grupo não existe mais");
    }
    if (!group.monitored || !group.conversationId) {
      throw new Error("O grupo não está mais sendo acompanhado");
    }
    const conversation = await ctx.db.get(group.conversationId);
    if (!conversation) throw new Error("Conversa do grupo não encontrada");
    const text = String(pending.args.text ?? "").trim();
    if (!text) throw new Error("Mensagem vazia");

    const messageId = await ctx.db.insert("messages", {
      organizationId: pending.organizationId,
      conversationId: conversation._id,
      direction: "outbound",
      senderId: member._id,
      senderType: member.type === "ai" ? "ai" : "human",
      content: text,
      contentType: "text",
      isInternal: false,
      metadata: { via: "copilot" },
      createdAt: now,
    });
    await applyOutboundMessageSideEffects(ctx, {
      conversation,
      member,
      messageId,
      now,
      activityContent: `Mensagem publicada no grupo por ${member.name} (via Copiloto)`,
    });
    return;
  }

  if (pending.tool === "activateGroupPost") {
    const groupPostId = pending.args.groupPostId as Id<"groupPosts">;
    const post = await ctx.db.get(groupPostId);
    if (!post || post.organizationId !== pending.organizationId) {
      throw new Error("Publicação não existe mais");
    }
    if (post.status === "ended") throw new Error("Publicação encerrada");
    // Re-valida os destinos: entre a proposta e o clique alguém pode ter
    // parado de acompanhar um grupo, ou o número pode ter saído dele.
    for (const target of post.targets) {
      const group = await ctx.db.get(target.groupChatId);
      if (!group || group.organizationId !== post.organizationId) {
        throw new Error("Um dos grupos da publicação não existe mais");
      }
      if (!group.monitored || !group.conversationId) {
        throw new Error(`O grupo «${group.subject}» não está mais sendo acompanhado`);
      }
      if (group.leftAt !== undefined || group.removedAt !== undefined) {
        throw new Error(`O número não faz mais parte do grupo «${group.subject}»`);
      }
    }
    const config = await ctx.db.get(post.channelConfigId);
    if (config?.bridgeGroupsEnabled !== true) {
      throw new Error("Os grupos estão desligados neste número");
    }
    const next = computeNextRun(post, now);
    if (next === null) throw new Error("A agenda não tem nenhum horário futuro — ajuste as datas");

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
      actorType: "human",
      changes: { before: { status: post.status }, after: { status: "active" } },
      metadata: { name: post.name, groups: post.targets.length, via: "copilot" },
      // `high`: a partir daqui o CRM escreve sozinho num grupo de gente real.
      description: `Publicação programada '${post.name}' ativada (proposta via Copiloto, confirmada)`,
      severity: "high",
      createdAt: now,
    });
    await postWebhook(ctx, post.organizationId, "group.post.activated", {
      groupPostId: post._id,
      name: post.name,
      nextRunAt: next.at,
      groups: post.targets.length,
    });
    return;
  }

  throw new Error(`Ação de grupo desconhecida: ${pending.tool}`);
}
