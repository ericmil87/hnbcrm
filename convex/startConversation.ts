/**
 * "Nova conversa" — um membro da equipe ABRE uma conversa de WhatsApp a partir
 * do inbox (ou da ficha do contato), com um número novo ou um contato que já
 * existe, escolhendo opcionalmente o funil/estágio do lead.
 *
 * Toda conversa 1:1 pendura num lead, então o lead sempre existe ao final;
 * o que é opcional para quem usa é escolher ONDE ele nasce. Contato com lead
 * nesta org → reaproveita o lead (o mesmo critério de `ensureLeadForContact`:
 * o mais recente); lead com conversa de WhatsApp → reaproveita a conversa.
 * Por isso a mutation é idempotente: chamar de novo para o mesmo número só
 * devolve a conversa que já existe (é o que o botão "Abrir conversa" faz).
 *
 * Bridge: ANTES de escrever qualquer coisa, pergunta ao WhatsApp (wuzapi
 * `POST /user/check`, as duas grafias BR numa chamada) se o número existe e
 * adota o JID devolvido como telefone canônico — o mesmo que as campanhas fazem
 * em `checkNumberAndSend`. Sem isso, um celular registrado SEM o 9º dígito
 * virava contato/lead/conversa num número inexistente (bug real de 02/10/2026:
 * "no LID found for 5581981392929@s.whatsapp.net") e a resposta do celular
 * criava um segundo contato. Meta não tem endpoint de checagem: segue o número
 * normalizado. Por isso `startConversation` é uma ACTION (fetch) que delega a
 * escrita à `internalStartConversation`.
 *
 * A primeira mensagem segue o MESMO caminho de saída de `sendMessage`
 * (`applyOutboundMessageSideEffects`: bump de conversa/lead, audit, activity,
 * webhook `message.sent` e dispatch com pacing) — nada de canal paralelo.
 */
import { v, ConvexError } from "convex/values";
import {
  action,
  internalMutation,
  internalQuery,
  query,
  ActionCtx,
  QueryCtx,
  MutationCtx,
  internalAction,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireAuth, requirePermission } from "./lib/auth";
import { hasPermission, resolvePermissions, type Permissions, type Role } from "./lib/permissions";
import { configProvider } from "./channelConfigs";
import { getOrCreateConversation } from "./conversations";
import { findOrCreateContactByPhone } from "./lib/inboundRouting";
import { applyOutboundMessageSideEffects } from "./lib/outboundSideEffects";
import { buildAuditDescription } from "./lib/auditDescription";
import { buildSearchText } from "./lib/searchText";
import { formatPhoneForDisplay } from "./lib/phone";
import { resolveDefaultCountry } from "./lib/orgPhone";
import { decryptSecret } from "./lib/secretCrypto";
import { buildBridgeCheckUserRequest, parseBridgeCheckUserResponse } from "./lib/bridgeSession";
import {
  META_FREE_TEXT_ERROR,
  NOT_ON_WHATSAPP_ERROR,
  OPT_OUT_ERROR_PREFIX,
  canSendFreeTextOnStart,
  cleanNamePart,
  isCanonicalPhone,
  phoneLookupCandidates,
  phoneSpellingVariants,
  pickCanonicalFromCheck,
  resolveStartPhone,
} from "./lib/startConversation";
import type { CheckedWhatsappUser } from "./lib/startConversation";
import { parseUserLidPhone } from "./lib/startConversation";

const TEAM_SOURCE_NAME = "Conversa iniciada pela equipe";
const MAX_CONTENT_CHARS = 4096;
const CHECK_TIMEOUT_MS = 8000;

// ─────────────────────────────────────────────────────────────────────────────
// Lookups compartilhados (prévia e mutation leem o MESMO estado)
// ─────────────────────────────────────────────────────────────────────────────

type Ctx = QueryCtx | MutationCtx;

function memberPermissions(member: Doc<"teamMembers">): Permissions {
  return resolvePermissions(member.role as Role, (member as any).permissions as Permissions | undefined);
}

async function findContactByPhone(
  ctx: Ctx,
  organizationId: Id<"organizations">,
  phone: string
): Promise<Doc<"contacts"> | null> {
  for (const candidate of phoneLookupCandidates(phone)) {
    const row = await ctx.db
      .query("contacts")
      .withIndex("by_organization_and_phone", (q) => q.eq("organizationId", organizationId).eq("phone", candidate))
      .first();
    if (row) return row;
  }
  return null;
}

/** DDI padrão da org (telefone digitado sem código de país). */
async function orgDefaultCountry(ctx: Ctx, organizationId: Id<"organizations">): Promise<string> {
  const org = await ctx.db.get(organizationId);
  return resolveDefaultCountry(org?.settings);
}

async function isOptedOut(ctx: Ctx, organizationId: Id<"organizations">, phone: string): Promise<boolean> {
  for (const candidate of phoneLookupCandidates(phone)) {
    const row = await ctx.db
      .query("optOuts")
      .withIndex("by_organization_and_phone", (q) => q.eq("organizationId", organizationId).eq("phone", candidate))
      .first();
    if (row) return true;
  }
  return false;
}

/** O mesmo critério de `ensureLeadForContact`: o lead mais recente do contato nesta org. */
async function findLeadForContact(
  ctx: Ctx,
  organizationId: Id<"organizations">,
  contactId: Id<"contacts">
): Promise<Doc<"leads"> | null> {
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .order("desc")
    .take(50);
  return leads.find((l) => l.organizationId === organizationId) ?? null;
}

async function findWhatsappConversation(ctx: Ctx, leadId: Id<"leads">): Promise<Doc<"conversations"> | null> {
  return await ctx.db
    .query("conversations")
    .withIndex("by_lead_and_channel", (q) => q.eq("leadId", leadId).eq("channel", "whatsapp"))
    .first();
}

async function activeBoards(ctx: Ctx, organizationId: Id<"organizations">): Promise<Doc<"boards">[]> {
  const boards = await ctx.db
    .query("boards")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .collect();
  return boards
    .filter((b) => b.archivedAt === undefined && b.deletionStartedAt === undefined)
    .sort((a, b) => a.order - b.order);
}

async function boardStages(ctx: Ctx, boardId: Id<"boards">): Promise<Doc<"stages">[]> {
  return await ctx.db
    .query("stages")
    .withIndex("by_board_and_order", (q) => q.eq("boardId", boardId))
    .take(100);
}

/** Telefone do contato para o envio (o dispatch lê `whatsappNumber ?? phone`). */
function contactRawPhone(contact: Doc<"contacts">): string | undefined {
  return contact.whatsappNumber ?? contact.phone ?? undefined;
}

function contactDisplayName(contact: Doc<"contacts">): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Canais que dá para usar (sem exigir settings:view)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Números de WhatsApp ativos da org, para o modal "Nova conversa". Basta ser
 * membro: o agente não tem `settings:view` (o que `getChannelConfigs` exige) e
 * mesmo assim precisa escolher por qual número falar. Por isso a forma devolvida
 * é uma ALLOWLIST estrita — nenhum token, segredo, URL de gateway ou id de
 * instância sai daqui (nem mascarado).
 */
export const listSendableWhatsappChannels = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(
    v.object({
      _id: v.id("channelConfigs"),
      provider: v.union(v.literal("meta"), v.literal("bridge")),
      displayName: v.string(),
      phoneDisplay: v.union(v.string(), v.null()),
      connected: v.boolean(),
      sessionState: v.union(v.string(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    const configs = await ctx.db
      .query("channelConfigs")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .take(50);
    return configs
      .filter((c) => c.channel === "whatsapp" && c.status === "active")
      .map((c) => {
        const provider = configProvider(c);
        const phone = c.bridgePhone
          ? formatPhoneForDisplay(c.bridgePhone)
          : c.displayPhoneNumber ?? null;
        return {
          _id: c._id,
          provider,
          displayName: c.displayName,
          phoneDisplay: phone || null,
          // Meta: `status: "active"` já é o resultado do health check da Cloud
          // API. Bridge: só "connected" na sessão whatsmeow entrega mensagem.
          connected: provider === "meta" ? true : c.bridgeSessionState === "connected",
          sessionState: provider === "bridge" ? c.bridgeSessionState ?? null : null,
        };
      });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Checagem do número no WhatsApp (bridge)
// ─────────────────────────────────────────────────────────────────────────────

const startContextReturns = v.object({
  provider: v.union(v.literal("meta"), v.literal("bridge")),
  phoneToCheck: v.string(),
  // Grafias do número que JÁ são contato na org — desempate quando o gateway
  // confirma as duas e só devolve LID (ver `pickCanonicalFromCheck`).
  knownPhones: v.array(v.string()),
  bridge: v.optional(
    v.object({
      baseUrl: v.optional(v.string()),
      tokenEncrypted: v.optional(v.string()),
      sessionState: v.optional(v.string()),
    })
  ),
});

type StartContext = {
  provider: "meta" | "bridge";
  phoneToCheck: string;
  knownPhones: string[];
  bridge?: { baseUrl?: string; tokenEncrypted?: string; sessionState?: string };
};

/**
 * Canal + telefone a checar. INTERNA: devolve o token cifrado do gateway — só
 * a action o lê, nunca um cliente. Lança os mesmos erros PT-BR da mutation
 * (canal de outra org/inativo, telefone inválido, contato sem telefone).
 */
export const internalStartContext = internalQuery({
  args: {
    organizationId: v.id("organizations"),
    channelConfigId: v.id("channelConfigs"),
    phone: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
  },
  returns: startContextReturns,
  handler: async (ctx, args): Promise<StartContext> => {
    await requirePermission(ctx, args.organizationId, "inbox", "reply");
    const channel = await ctx.db.get(args.channelConfigId);
    if (!channel || channel.organizationId !== args.organizationId || channel.channel !== "whatsapp") {
      throw new ConvexError("Número de WhatsApp não encontrado nesta organização");
    }
    if (channel.status !== "active") {
      throw new ConvexError(`O número «${channel.displayName}» não está ativo — escolha outro ou reconecte em Configurações → Canais`);
    }
    const defaultCountry = await orgDefaultCountry(ctx, args.organizationId);
    let raw: string | undefined = args.phone;
    if (args.contactId) {
      const c = await ctx.db.get(args.contactId);
      if (!c || c.organizationId !== args.organizationId) throw new ConvexError("Contato não encontrado");
      raw = contactRawPhone(c) ?? args.phone;
      if (!raw) throw new ConvexError("Este contato não tem telefone — informe um número");
    }
    const r = resolveStartPhone(raw, defaultCountry);
    if (!r.ok) throw new ConvexError(r.error);
    const provider = configProvider(channel);
    const knownPhones: string[] = [];
    for (const candidate of phoneLookupCandidates(r.phone)) {
      const row = await ctx.db
        .query("contacts")
        .withIndex("by_organization_and_phone", (q) => q.eq("organizationId", args.organizationId).eq("phone", candidate))
        .first();
      if (row) knownPhones.push(candidate);
    }
    return {
      provider,
      phoneToCheck: r.phone,
      knownPhones,
      ...(provider === "bridge"
        ? {
            bridge: {
              ...(channel.bridgeBaseUrl ? { baseUrl: channel.bridgeBaseUrl } : {}),
              ...(channel.bridgeTokenEncrypted ? { tokenEncrypted: channel.bridgeTokenEncrypted } : {}),
              ...(channel.bridgeSessionState ? { sessionState: channel.bridgeSessionState } : {}),
            },
          }
        : {}),
    };
  },
});

type NumberCheck =
  | { status: "on_whatsapp"; canonicalPhone: string; phoneDisplay: string; changed: boolean; ambiguous?: boolean; lid?: string; checked?: CheckedWhatsappUser[] }
  | { status: "not_on_whatsapp"; phone: string; checked?: CheckedWhatsappUser[] }
  | { status: "unverified"; reason: "meta" | "bridge_offline" | "gateway_error"; phone: string; detail?: string };

const checkedUsersValidator = v.array(
  v.object({ phone: v.string(), onWhatsapp: v.boolean(), jid: v.optional(v.string()) })
);

const numberCheckReturns = v.union(
  v.object({
    status: v.literal("on_whatsapp"),
    canonicalPhone: v.string(),
    phoneDisplay: v.string(),
    changed: v.boolean(),
    ambiguous: v.optional(v.boolean()),
    lid: v.optional(v.string()),
    // Diagnóstico: o que o gateway respondeu para cada grafia perguntada.
    checked: v.optional(checkedUsersValidator),
  }),
  v.object({ status: v.literal("not_on_whatsapp"), phone: v.string(), checked: v.optional(checkedUsersValidator) }),
  v.object({
    status: v.literal("unverified"),
    reason: v.union(v.literal("meta"), v.literal("bridge_offline"), v.literal("gateway_error")),
    phone: v.string(),
    detail: v.optional(v.string()),
  })
);

/**
 * Pergunta ao gateway (POST /user/check) pelas duas grafias do número. Nunca
 * lança por problema do gateway: indisponível = `unverified` e quem chama
 * decide (o início segue sem confirmação; só o "não tem WhatsApp" barra).
 */
function trimBase(u: string): string {
  return u.replace(/\/+$/, "");
}

async function runBridgeNumberCheck(context: StartContext): Promise<NumberCheck> {
  const phone = context.phoneToCheck;
  if (context.provider !== "bridge") return { status: "unverified", reason: "meta", phone };
  const bridge = context.bridge;
  if (!bridge?.baseUrl || !bridge.tokenEncrypted || bridge.sessionState !== "connected") {
    return { status: "unverified", reason: "bridge_offline", phone };
  }
  const candidates = phoneSpellingVariants(phone);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const token = await decryptSecret(bridge.tokenEncrypted);
    const req = buildBridgeCheckUserRequest({ baseUrl: bridge.baseUrl, token, phones: candidates });
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    const parsed = parseBridgeCheckUserResponse(res.ok, res.status, body);
    if (!parsed.ok) return { status: "unverified", reason: "gateway_error", phone, detail: parsed.error.slice(0, 200) };
    if (parsed.users.length === 0) {
      return { status: "unverified", reason: "gateway_error", phone, detail: "Resposta sem usuários" };
    }
    let pick = pickCanonicalFromCheck(parsed.users, candidates, context.knownPhones);
    const checked = parsed.users.map((u) => ({ phone: u.phone, onWhatsapp: u.onWhatsapp, ...(u.jid ? { jid: u.jid } : {}) }));
    if (!pick.onWhatsapp) return { status: "not_on_whatsapp", phone, checked };
    // 2ª etapa (medido em prod, 03/10/2026): o /user/check responde UM usuário
    // só, com LID, para as duas grafias BR — não dá para saber qual é a
    // registrada. `GET /user/lid/{p}` devolve o JID de TELEFONE só para a
    // grafia real (404 para a errada). Só roda quando não veio JID de telefone
    // e há mais de uma grafia possível; qualquer falha mantém a 1ª etapa.
    if (!pick.jid && candidates.length > 1) {
      const confirmedByLid: string[] = [];
      for (const p of candidates) {
        try {
          const res = await fetch(`${trimBase(bridge.baseUrl)}/user/lid/${p}`, { method: "GET", headers: { token }, signal: controller.signal });
          const body = await res.json().catch(() => ({}));
          const real = parseUserLidPhone(res.ok, body);
          if (real) confirmedByLid.push(real);
        } catch {
          /* mantém a 1ª etapa */
        }
      }
      const unique = Array.from(new Set(confirmedByLid));
      if (unique.length === 1) {
        pick = { ...pick, canonicalPhone: unique[0], ambiguous: undefined };
      } else if (unique.length > 1) {
        const known = unique.find((u) => context.knownPhones.includes(u));
        pick = { ...pick, canonicalPhone: known ?? unique[0], ambiguous: true };
      }
    }
    const canonicalPhone = pick.canonicalPhone ?? phone;
    return {
      status: "on_whatsapp",
      canonicalPhone,
      phoneDisplay: formatPhoneForDisplay(canonicalPhone),
      changed: canonicalPhone !== phone,
      checked,
      ...(pick.ambiguous ? { ambiguous: true } : {}),
      ...(pick.lid ? { lid: pick.lid } : {}),
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      status: "unverified",
      reason: "gateway_error",
      phone,
      detail: aborted ? "Tempo esgotado" : e instanceof Error ? e.message.slice(0, 200) : "Erro de rede",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function loadStartContext(
  ctx: ActionCtx,
  args: {
    organizationId: Id<"organizations">;
    channelConfigId: Id<"channelConfigs">;
    phone?: string;
    contactId?: Id<"contacts">;
  }
): Promise<StartContext> {
  return await ctx.runQuery(internal.startConversation.internalStartContext, {
    organizationId: args.organizationId,
    channelConfigId: args.channelConfigId,
    ...(args.phone !== undefined ? { phone: args.phone } : {}),
    ...(args.contactId ? { contactId: args.contactId } : {}),
  });
}

/**
 * O número (digitado ou do contato) tem WhatsApp? No bridge pergunta ao
 * gateway e devolve o telefone CANÔNICO (para celular BR antigo, sem o 9).
 * Meta não tem como checar → `unverified/meta`.
 */
export const checkWhatsappNumber = action({
  args: {
    organizationId: v.id("organizations"),
    channelConfigId: v.id("channelConfigs"),
    phone: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
  },
  returns: numberCheckReturns,
  handler: async (ctx, args): Promise<NumberCheck> => {
    const context = await loadStartContext(ctx, args);
    return await runBridgeNumberCheck(context);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Prévia
// ─────────────────────────────────────────────────────────────────────────────

const previewReturns = v.object({
  phone: v.union(v.string(), v.null()),
  phoneDisplay: v.union(v.string(), v.null()),
  phoneValid: v.boolean(),
  phoneError: v.union(v.string(), v.null()),
  contact: v.union(
    v.null(),
    v.object({ id: v.id("contacts"), name: v.string(), phone: v.union(v.string(), v.null()) })
  ),
  lead: v.union(
    v.null(),
    v.object({
      id: v.id("leads"),
      title: v.string(),
      boardName: v.union(v.string(), v.null()),
      stageName: v.union(v.string(), v.null()),
      archived: v.boolean(),
    })
  ),
  conversation: v.union(
    v.null(),
    v.object({
      id: v.id("conversations"),
      archived: v.boolean(),
      channelConfigId: v.union(v.id("channelConfigs"), v.null()),
    })
  ),
  optedOut: v.boolean(),
  defaultBoard: v.union(
    v.null(),
    v.object({
      id: v.id("boards"),
      name: v.string(),
      stages: v.array(v.object({ id: v.id("stages"), name: v.string() })),
    })
  ),
  canCreateContact: v.boolean(),
  canCreateLead: v.boolean(),
});

/**
 * O que acontece se eu iniciar a conversa com este número/contato? Mostra no
 * modal "este número já é o contato X / já tem o lead Y / já tem conversa".
 * Lê exatamente o que a mutation vai ler (mesmos helpers).
 */
export const previewStartConversation = query({
  args: {
    organizationId: v.id("organizations"),
    phone: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
    /** `phone` já veio do gateway (checkWhatsappNumber): não re-normalizar (re-poria o 9). */
    phoneIsCanonical: v.optional(v.boolean()),
  },
  returns: previewReturns,
  handler: async (ctx, args) => {
    const member = await requirePermission(ctx, args.organizationId, "inbox", "reply");
    const perms = memberPermissions(member);
    const defaultCountry = await orgDefaultCountry(ctx, args.organizationId);

    let contact: Doc<"contacts"> | null = null;
    let phone: string | null = null;
    let phoneError: string | null = null;

    if (args.contactId) {
      const c = await ctx.db.get(args.contactId);
      // Prévia NÃO lança para contato inexistente/de outra org: ela roda num
      // useQuery alimentado por deep-link (`?nova=<id>`), e um throw ali
      // derrubaria a tela inteira. A mutation, essa sim, recusa.
      contact = c && c.organizationId === args.organizationId ? c : null;
      const raw = contact ? contactRawPhone(contact) ?? args.phone : undefined;
      if (!contact) {
        phoneError = "Contato não encontrado";
      } else if (raw) {
        const r = resolveStartPhone(raw, defaultCountry);
        if (r.ok) phone = r.phone;
        else phoneError = r.error;
      } else {
        phoneError = "Este contato não tem telefone — informe um número";
      }
    } else if (args.phoneIsCanonical && isCanonicalPhone(args.phone)) {
      phone = args.phone;
      contact = await findContactByPhone(ctx, args.organizationId, phone);
    } else {
      const r = resolveStartPhone(args.phone, defaultCountry);
      if (r.ok) {
        phone = r.phone;
        contact = await findContactByPhone(ctx, args.organizationId, phone);
      } else {
        phoneError = r.error;
      }
    }

    const lead = contact ? await findLeadForContact(ctx, args.organizationId, contact._id) : null;
    const conversation = lead ? await findWhatsappConversation(ctx, lead._id) : null;

    let leadInfo: {
      id: Id<"leads">;
      title: string;
      boardName: string | null;
      stageName: string | null;
      archived: boolean;
    } | null = null;
    if (lead) {
      const board = await ctx.db.get(lead.boardId);
      const stage = await ctx.db.get(lead.stageId);
      leadInfo = {
        id: lead._id,
        title: lead.title,
        boardName: board?.name ?? null,
        stageName: stage?.name ?? null,
        archived: lead.archivedAt !== undefined,
      };
    }

    let defaultBoard = null;
    if (!lead) {
      const boards = await activeBoards(ctx, args.organizationId);
      const board = boards.find((b) => b.isDefault) ?? boards[0];
      if (board) {
        const stages = await boardStages(ctx, board._id);
        defaultBoard = {
          id: board._id,
          name: board.name,
          stages: stages.map((s) => ({ id: s._id, name: s.name })),
        };
      }
    }

    return {
      phone,
      phoneDisplay: phone ? formatPhoneForDisplay(phone) : null,
      phoneValid: phone !== null,
      phoneError,
      contact: contact
        ? {
            id: contact._id,
            name: contactDisplayName(contact),
            phone: contactRawPhone(contact) ? formatPhoneForDisplay(contactRawPhone(contact)!) : null,
          }
        : null,
      lead: leadInfo,
      conversation: conversation
        ? {
            id: conversation._id,
            archived: conversation.archivedAt !== undefined,
            channelConfigId: conversation.channelConfigId ?? null,
          }
        : null,
      optedOut: phone ? await isOptedOut(ctx, args.organizationId, phone) : false,
      defaultBoard,
      canCreateContact: hasPermission(perms, "contacts", "edit"),
      canCreateLead: hasPermission(perms, "leads", "edit_own"),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Mutation
// ─────────────────────────────────────────────────────────────────────────────

async function findOrCreateTeamSource(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  now: number
): Promise<Id<"leadSources">> {
  const sources = await ctx.db
    .query("leadSources")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .collect();
  const existing = sources.find((s) => s.name === TEAM_SOURCE_NAME);
  if (existing) return existing._id;
  return await ctx.db.insert("leadSources", {
    organizationId,
    name: TEAM_SOURCE_NAME,
    type: "phone",
    isActive: true,
    createdAt: now,
  });
}

/** Board/estágio ESCOLHIDOS pelo usuário: inválido é erro, nunca fallback mudo. */
async function resolveTargetPipeline(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  boardId: Id<"boards"> | undefined,
  stageId: Id<"stages"> | undefined
): Promise<{ board: Doc<"boards">; stage: Doc<"stages"> }> {
  let board: Doc<"boards"> | null = null;
  if (boardId) {
    board = await ctx.db.get(boardId);
    if (!board || board.organizationId !== organizationId) throw new ConvexError("Funil não encontrado");
    if (board.archivedAt !== undefined || board.deletionStartedAt !== undefined) {
      throw new ConvexError(`O funil «${board.name}» está arquivado — escolha outro`);
    }
  } else if (stageId) {
    const stage = await ctx.db.get(stageId);
    if (!stage || stage.organizationId !== organizationId) throw new ConvexError("Estágio não encontrado");
    board = await ctx.db.get(stage.boardId);
    if (!board || board.archivedAt !== undefined || board.deletionStartedAt !== undefined) {
      throw new ConvexError("O funil deste estágio está arquivado — escolha outro");
    }
  } else {
    const boards = await activeBoards(ctx, organizationId);
    board = boards.find((b) => b.isDefault) ?? boards[0] ?? null;
    if (!board) throw new ConvexError("Nenhum funil ativo — crie um funil antes de iniciar conversas");
  }

  const stages = await boardStages(ctx, board._id);
  if (stageId) {
    const stage = stages.find((s) => s._id === stageId);
    if (!stage) throw new ConvexError(`O estágio escolhido não pertence ao funil «${board.name}»`);
    return { board, stage };
  }
  if (!stages[0]) throw new ConvexError(`O funil «${board.name}» não tem estágios`);
  return { board, stage: stages[0] };
}

const startArgs = {
  organizationId: v.id("organizations"),
  channelConfigId: v.id("channelConfigs"),
  phone: v.optional(v.string()),
  contactId: v.optional(v.id("contacts")),
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  boardId: v.optional(v.id("boards")),
  stageId: v.optional(v.id("stages")),
  content: v.optional(v.string()),
  optOutAck: v.optional(v.boolean()),
};

const internalStartReturns = {
  conversationId: v.id("conversations"),
  leadId: v.id("leads"),
  contactId: v.id("contacts"),
  createdContact: v.boolean(),
  createdLead: v.boolean(),
  createdConversation: v.boolean(),
  unarchived: v.boolean(),
  channelSwitched: v.boolean(),
  messageId: v.optional(v.id("messages")),
  canonicalPhone: v.string(),
  phoneChanged: v.boolean(),
};

type InternalStartResult = {
  conversationId: Id<"conversations">;
  leadId: Id<"leads">;
  contactId: Id<"contacts">;
  createdContact: boolean;
  createdLead: boolean;
  createdConversation: boolean;
  unarchived: boolean;
  channelSwitched: boolean;
  messageId?: Id<"messages">;
  canonicalPhone: string;
  phoneChanged: boolean;
};

/**
 * A escrita (contato → lead → conversa → 1ª mensagem). Chamada pela action
 * `startConversation` depois da checagem no gateway; a identidade do usuário
 * propaga pelo `ctx.runMutation`, então o RBAC continua valendo aqui.
 *
 * `phoneIsCanonical: true` = `phone` é o número que o WHATSAPP confirmou (JID):
 * só valida dígitos e NÃO re-normaliza (re-normalizar re-poria o 9 — o bug).
 * Nesse caso o contato escolhido/encontrado cujo número gravado diverge é
 * corrigido para o canônico (o gravado era inalcançável).
 */
export const internalStartConversation = internalMutation({
  args: { ...startArgs, phoneIsCanonical: v.optional(v.boolean()) },
  returns: v.object(internalStartReturns),
  handler: async (ctx, args): Promise<InternalStartResult> => {
    const member = await requirePermission(ctx, args.organizationId, "inbox", "reply");
    const perms = memberPermissions(member);
    const actorType = member.type === "ai" ? "ai" : "human";
    const now = Date.now();

    // 1. Canal
    const channel = await ctx.db.get(args.channelConfigId);
    if (!channel || channel.organizationId !== args.organizationId || channel.channel !== "whatsapp") {
      throw new ConvexError("Número de WhatsApp não encontrado nesta organização");
    }
    if (channel.status !== "active") {
      throw new ConvexError(`O número «${channel.displayName}» não está ativo — escolha outro ou reconecte em Configurações → Canais`);
    }
    const provider = configProvider(channel);

    // 2. Mensagem: validada ANTES de escrever qualquer coisa (servidor não
    //    confia na UI — Meta não aceita texto livre fora da janela de 24 h).
    const content = (args.content ?? "").trim();
    if (content && !canSendFreeTextOnStart(provider)) throw new ConvexError(META_FREE_TEXT_ERROR);
    if (content.length > MAX_CONTENT_CHARS) {
      throw new ConvexError(`Mensagem longa demais (máx. ${MAX_CONTENT_CHARS} caracteres)`);
    }

    // 3. Telefone + contato
    const canonical = args.phoneIsCanonical === true;
    if (canonical && !isCanonicalPhone(args.phone)) throw new ConvexError("Telefone inválido — confira os dígitos");
    const defaultCountry = await orgDefaultCountry(ctx, args.organizationId);
    let contact: Doc<"contacts"> | null = null;
    let switchedFromContactId: Id<"contacts"> | undefined;
    let phone: string;
    if (args.contactId) {
      const c = await ctx.db.get(args.contactId);
      if (!c || c.organizationId !== args.organizationId) throw new ConvexError("Contato não encontrado");
      contact = c;
      if (canonical) {
        phone = args.phone!;
        // O WhatsApp confirmou outra grafia e JÁ existe um contato com ela
        // (caso real de 02/10: o bug criou 5581981392929 e o ingest criou
        // 558181392929). Usar o contato canônico evita dois contatos com o
        // mesmo telefone; o escolhido fica como está, para a equipe excluir.
        const canonicalOwner = await ctx.db
          .query("contacts")
          .withIndex("by_organization_and_phone", (q) => q.eq("organizationId", args.organizationId).eq("phone", phone))
          .first();
        if (canonicalOwner && canonicalOwner._id !== c._id) {
          switchedFromContactId = c._id;
          contact = canonicalOwner;
        }
      } else {
        const raw = contactRawPhone(c) ?? args.phone;
        if (!raw) throw new ConvexError("Este contato não tem telefone — informe um número");
        const r = resolveStartPhone(raw, defaultCountry);
        if (!r.ok) throw new ConvexError(r.error);
        phone = r.phone;
      }
    } else if (canonical) {
      phone = args.phone!;
      contact = await findContactByPhone(ctx, args.organizationId, phone);
    } else {
      const r = resolveStartPhone(args.phone, defaultCountry);
      if (!r.ok) throw new ConvexError(r.error);
      phone = r.phone;
      contact = await findContactByPhone(ctx, args.organizationId, phone);
    }

    // 4. Supressão: avisar, não travar — mas o aceite é explícito e auditado.
    const optedOut = await isOptedOut(ctx, args.organizationId, phone);
    if (optedOut && args.optOutAck !== true) {
      throw new ConvexError(
        `${OPT_OUT_ERROR_PREFIX} Este número pediu para não receber mensagens. Confirme que quer continuar mesmo assim.`
      );
    }

    // 5. Contato (cria só com permissão de contatos, como `createContact`)
    let createdContact = false;
    let previousPhone: string | undefined;
    if (!contact) {
      if (!hasPermission(perms, "contacts", "edit")) {
        throw new ConvexError("Permissão insuficiente para criar contatos");
      }
      const contactId = await findOrCreateContactByPhone(ctx, {
        organizationId: args.organizationId,
        phone,
        firstName: cleanNamePart(args.firstName),
        lastName: cleanNamePart(args.lastName),
      });
      contact = (await ctx.db.get(contactId))!;
      createdContact = true;
      await ctx.db.insert("auditLogs", {
        organizationId: args.organizationId,
        entityType: "contact",
        entityId: contactId,
        action: "create",
        actorId: member._id,
        actorType,
        metadata: { phone, via: "start_conversation" },
        description: buildAuditDescription({ action: "create", entityType: "contact", metadata: {} }),
        severity: "low",
        createdAt: now,
      });
    } else {
      // Contato escolhido sem telefone (ou com telefone formatado à mão): grava
      // o número normalizado no campo que o dispatch lê, sem mexer no resto.
      const patch: Partial<Doc<"contacts">> = {};
      if (canonical) {
        // O WhatsApp confirmou OUTRA grafia: o número gravado era inalcançável.
        // `whatsappNumber` é o que o dispatch lê; `phone` só é trocado quando é
        // o MESMO número noutra grafia (não apaga um fixo cadastrado à parte).
        const digits = (raw: string | undefined) => (raw ?? "").replace(/\D+/g, "");
        const spellings = phoneLookupCandidates(phone);
        const dispatchDigits = digits(contactRawPhone(contact));
        if (dispatchDigits && dispatchDigits !== phone) previousPhone = dispatchDigits;
        if (digits(contact.whatsappNumber) !== phone) patch.whatsappNumber = phone;
        const phoneDigits = digits(contact.phone);
        if (!phoneDigits || (phoneDigits !== phone && (spellings.includes(phoneDigits) || phoneDigits === dispatchDigits))) {
          patch.phone = phone;
        }
      } else {
        if (!contact.phone) patch.phone = phone;
        if (!contact.whatsappNumber) patch.whatsappNumber = phone;
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(contact._id, { ...patch, searchText: buildSearchText({ ...contact, ...patch }), updatedAt: now });
        contact = (await ctx.db.get(contact._id))!;
      }
    }

    // 6. Lead: reaproveita o mais recente; senão cria no funil escolhido.
    let lead = await findLeadForContact(ctx, args.organizationId, contact._id);
    let createdLead = false;
    if (!lead) {
      if (!hasPermission(perms, "leads", "edit_own")) {
        throw new ConvexError("Permissão insuficiente para criar leads");
      }
      const { board, stage } = await resolveTargetPipeline(ctx, args.organizationId, args.boardId, args.stageId);
      const org = await ctx.db.get(args.organizationId);
      const title = contactDisplayName(contact) || formatPhoneForDisplay(phone);
      const sourceId = await findOrCreateTeamSource(ctx, args.organizationId, now);
      // Dono = quem iniciou, NUNCA o atendente IA — mesmo com
      // `aiConfig.autoAssign` ligado. Quem abre a conversa de propósito é dono
      // dela; entregar o lead à IA faria o atendente responder por cima de uma
      // abordagem que a pessoa acabou de começar.
      const leadId = await ctx.db.insert("leads", {
        organizationId: args.organizationId,
        title,
        contactId: contact._id,
        boardId: board._id,
        stageId: stage._id,
        assignedTo: member._id,
        value: 0,
        currency: org?.settings.currency || "USD",
        priority: "medium",
        temperature: "cold",
        sourceId,
        tags: [],
        customFields: {},
        conversationStatus: "new",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
      lead = (await ctx.db.get(leadId))!;
      createdLead = true;
      await ctx.db.insert("auditLogs", {
        organizationId: args.organizationId,
        entityType: "lead",
        entityId: leadId,
        action: "create",
        actorId: member._id,
        actorType,
        metadata: { title, contactId: contact._id, source: "start_conversation" },
        description: buildAuditDescription({ action: "create", entityType: "lead", metadata: { title, contactId: contact._id } }),
        severity: "medium",
        createdAt: now,
      });
      await ctx.db.insert("activities", {
        organizationId: args.organizationId,
        leadId,
        type: "created",
        actorId: member._id,
        actorType,
        content: `Lead "${title}" criado ao iniciar conversa no WhatsApp`,
        metadata: { contactId: contact._id, via: "start_conversation" },
        createdAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
        organizationId: args.organizationId,
        event: "lead.created",
        payload: { leadId, title, contactId: contact._id, boardId: board._id, stageId: stage._id },
      });
    }

    // 7. Conversa
    const existing = await findWhatsappConversation(ctx, lead._id);
    const conversationId = await getOrCreateConversation(ctx, {
      organizationId: args.organizationId,
      leadId: lead._id,
      channel: "whatsapp",
      channelConfigId: args.channelConfigId,
    });
    const createdConversation = existing === null;
    let conversation = (await ctx.db.get(conversationId))!;
    const convPatch: Partial<Doc<"conversations">> = {};
    // Igual às campanhas: a conversa passa a sair pelo número escolhido.
    const channelSwitched = !createdConversation && conversation.channelConfigId !== args.channelConfigId;
    if (conversation.channelConfigId !== args.channelConfigId) convPatch.channelConfigId = args.channelConfigId;
    const unarchived = conversation.archivedAt !== undefined;
    if (unarchived) convPatch.archivedAt = undefined;
    if (Object.keys(convPatch).length > 0) {
      await ctx.db.patch(conversationId, { ...convPatch, updatedAt: now });
      conversation = (await ctx.db.get(conversationId))!;
    }

    // 8. Registro: activity no lead + audit da conversa (high com aceite de opt-out)
    await ctx.db.insert("activities", {
      organizationId: args.organizationId,
      leadId: lead._id,
      type: "note",
      actorId: member._id,
      actorType,
      content: createdConversation
        ? `Conversa iniciada pela equipe via WhatsApp (${channel.displayName})`
        : `Conversa reaberta pela equipe via WhatsApp (${channel.displayName})`,
      metadata: { conversationId, channelConfigId: args.channelConfigId, via: "start_conversation" },
      createdAt: now,
    });
    const auditMetadata = {
      leadId: lead._id,
      contactId: contact._id,
      channelConfigId: args.channelConfigId,
      provider,
      createdContact,
      createdLead,
      createdConversation,
      channelSwitched,
      unarchived,
      ...(optedOut ? { optOutAcknowledged: true } : {}),
      ...(previousPhone ? { previousPhone, phone } : {}),
      ...(switchedFromContactId ? { switchedFromContactId } : {}),
    };
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "conversation",
      entityId: conversationId,
      action: createdConversation ? "create" : "update",
      actorId: member._id,
      actorType,
      metadata: auditMetadata,
      description: optedOut
        ? `Iniciou conversa no WhatsApp com número em opt-out (aceite explícito)`
        : createdConversation
          ? `Iniciou conversa no WhatsApp (${channel.displayName})`
          : `Reabriu conversa no WhatsApp (${channel.displayName})`,
      severity: optedOut ? "high" : "low",
      createdAt: now,
    });

    // 9. Primeira mensagem (só bridge) — mesmo caminho de saída do sendMessage.
    let messageId: Id<"messages"> | undefined;
    if (content) {
      messageId = await ctx.db.insert("messages", {
        organizationId: args.organizationId,
        conversationId,
        leadId: lead._id,
        direction: "outbound",
        senderId: member._id,
        senderType: actorType,
        content,
        contentType: "text",
        isInternal: false,
        createdAt: now,
      });
      await applyOutboundMessageSideEffects(ctx, {
        conversation,
        member,
        messageId,
        now,
        activityContent: `Message sent via ${conversation.channel}`,
      });
    }

    return {
      conversationId,
      leadId: lead._id,
      contactId: contact._id,
      createdContact,
      createdLead,
      createdConversation,
      unarchived,
      channelSwitched,
      ...(messageId ? { messageId } : {}),
      canonicalPhone: phone,
      phoneChanged: previousPhone !== undefined,
    };
  },
});

/**
 * Inicia (ou reabre) a conversa. No bridge, checa o número no WhatsApp ANTES de
 * qualquer escrita: "não tem WhatsApp" em todas as grafias → erro sem gravar
 * nada; no WhatsApp → grava o número canônico (JID); checagem indisponível →
 * segue com o número normalizado e devolve `verified: false`.
 */
export const startConversation = action({
  args: startArgs,
  returns: v.object({
    ...internalStartReturns,
    verified: v.boolean(),
    verifyReason: v.optional(v.union(v.literal("meta"), v.literal("bridge_offline"), v.literal("gateway_error"))),
  }),
  handler: async (
    ctx,
    args
  ): Promise<InternalStartResult & { verified: boolean; verifyReason?: "meta" | "bridge_offline" | "gateway_error" }> => {
    const context = await loadStartContext(ctx, args);
    const check = await runBridgeNumberCheck(context);
    if (check.status === "not_on_whatsapp") throw new ConvexError(NOT_ON_WHATSAPP_ERROR);
    const result: InternalStartResult = await ctx.runMutation(internal.startConversation.internalStartConversation, {
      ...args,
      // Verificado: o número do WhatsApp manda. Sem verificação: o caminho de
      // sempre (normaliza o digitado / usa o do contato), sem tocar no contato.
      ...(check.status === "on_whatsapp" ? { phone: check.canonicalPhone, phoneIsCanonical: true } : {}),
    });
    return {
      ...result,
      verified: check.status === "on_whatsapp",
      ...(check.status === "unverified" ? { verifyReason: check.reason } : {}),
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Ops: sonda crua do gateway para um telefone (diagnóstico de grafia/LID)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Devolve as respostas CRUAS do wuzapi para um telefone: `POST /user/check`
 * (uma chamada por grafia e uma com as duas), `POST /user/info` e
 * `GET /user/lid/{phone}`. Só ops (`npx convex run --prod …`), nunca UI —
 * serve para medir o que o gateway sabe de um número antes de mexer na regra
 * de canonicalização. Não escreve nada.
 */
export const internalProbeGatewayNumber = internalAction({
  args: { channelConfigId: v.id("channelConfigs"), phone: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const ch = await ctx.runQuery(internal.startConversation.internalProbeChannel, { channelConfigId: args.channelConfigId });
    if (!ch) return { error: "canal sem bridge" };
    const token = await decryptSecret(ch.tokenEncrypted);
    const base = ch.baseUrl.replace(/\/+$/, "");
    const headers = { "Content-Type": "application/json", token };
    const call = async (method: string, path: string, body?: unknown) => {
      try {
        const res = await fetch(`${base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        const text = await res.text();
        let json: unknown = text;
        try { json = JSON.parse(text); } catch { /* texto cru */ }
        return { status: res.status, body: json };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    };
    const variants = phoneSpellingVariants(args.phone);
    const out: Record<string, unknown> = { variants };
    for (const p of variants) out[`check:${p}`] = await call("POST", "/user/check", { Phone: [p] });
    out["check:both"] = await call("POST", "/user/check", { Phone: variants });
    for (const p of variants) out[`info:${p}`] = await call("POST", "/user/info", { Phone: [p] });
    for (const p of variants) out[`lid:${p}`] = await call("GET", `/user/lid/${p}`);
    return out;
  },
});

export const internalProbeChannel = internalQuery({
  args: { channelConfigId: v.id("channelConfigs") },
  returns: v.union(v.null(), v.object({ baseUrl: v.string(), tokenEncrypted: v.string() })),
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.channelConfigId);
    if (!c?.bridgeBaseUrl || !c.bridgeTokenEncrypted) return null;
    return { baseUrl: c.bridgeBaseUrl, tokenEncrypted: c.bridgeTokenEncrypted };
  },
});
