/**
 * Leads do próprio HNBCRM (org interna): cadastro novo e pedido de consultoria.
 *
 * A org interna vem da env `HNBCRM_INTERNAL_ORG_ID` (funil opcional em
 * `HNBCRM_INTERNAL_BOARD_ID`). Sem env, env inválida ou org inexistente: nada
 * acontece (DEV seguro). O lead nasce no mesmo formato de `leads.internalCreateLead`
 * (com `leadCreationStagePatch`, `activities` e `auditLogs`), mas SEM webhook e SEM
 * boas-vindas: aqui só o titular (ou o solicitante) é registrado, para contato futuro.
 *
 * Texto de formulário é dado, nunca instrução: entra só como nota/campo, saneado.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { buildAuditDescription } from "./auditDescription";
import { leadCreationStagePatch } from "./leadStageMove";
import { hasEmailShape } from "./emailAddress";
import { normalizeCampaignPhone } from "./phone";
import { resolveDefaultCountry } from "./orgPhone";
import { findContactsByPhoneCandidates } from "./inboundRouting";

export const SIGNUP_MARKER = "hnbcrmSignupOrgId";
export const SUMMARY_MARKER = "hnbcrmSummary";
export const SIGNUP_SOURCE_NAME = "Cadastro";
export const CONTACT_SOURCE_NAME = "Site – contato";
export const SIGNUP_TAG = "cadastro";
export const NEWSLETTER_TAG = "newsletter";
export const NEWSLETTER_SOURCE_NAME = "Site – newsletter";

export const CONTACT_KINDS = ["implantacao", "consultoria", "empresa"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export const CONTACT_KIND_LABEL: Record<ContactKind, string> = {
  implantacao: "Implantação",
  consultoria: "Consultoria",
  empresa: "Plano Empresa",
};

export const CONTACT_LIMITS = {
  body: 8_000,
  name: 80,
  email: 254,
  phone: 30,
  business: 120,
  teamSize: 30,
  need: 1_000,
} as const;

export type InternalTarget = {
  org: Doc<"organizations">;
  actor: Doc<"teamMembers">;
  board: Doc<"boards">;
  stage: Doc<"stages">;
};

/** Texto de formulário: NFKC, sem controle/invisível, espaços colapsados, corte por pontos de código. */
export function cleanFormText(raw: unknown, max: number, multiline = false): string {
  if (typeof raw !== "string") return "";
  let s = raw.normalize("NFKC");
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, "");
  s = multiline ? s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ");
  s = s.trim();
  return Array.from(s).slice(0, max).join("");
}

/** Resolve org interna, ator (admin humano ativo), funil e 1ª etapa. Qualquer falha = null. */
export async function resolveInternalTarget(ctx: MutationCtx): Promise<InternalTarget | null> {
  const rawOrg = process.env.HNBCRM_INTERNAL_ORG_ID?.trim();
  if (!rawOrg) return null;
  const orgId = ctx.db.normalizeId("organizations", rawOrg);
  if (!orgId) return null;
  const org = await ctx.db.get(orgId);
  if (!org) return null;

  // Org interna é pequena (equipe do HNBCRM): itera o índice até achar o 1º admin ativo, sem corte arbitrário.
  let actor: Doc<"teamMembers"> | null = null;
  for await (const m of ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", orgId).eq("type", "human"))) {
    if (m.role === "admin" && m.removedAt === undefined && m.status !== "inactive") {
      actor = m;
      break;
    }
  }
  if (!actor) return null;

  let board: Doc<"boards"> | null = null;
  const rawBoard = process.env.HNBCRM_INTERNAL_BOARD_ID?.trim();
  if (rawBoard) {
    const boardId = ctx.db.normalizeId("boards", rawBoard);
    const candidate = boardId ? await ctx.db.get(boardId) : null;
    if (candidate && candidate.organizationId === orgId && candidate.archivedAt === undefined) board = candidate;
  }
  if (!board) {
    // Funis em ordem: o padrão vivo, senão o primeiro vivo (para ao achar o padrão).
    let firstLive: Doc<"boards"> | null = null;
    for await (const b of ctx.db
      .query("boards")
      .withIndex("by_organization_and_order", (q) => q.eq("organizationId", orgId))) {
      if (b.archivedAt !== undefined) continue;
      if (b.isDefault) {
        board = b;
        break;
      }
      firstLive ??= b;
    }
    board ??= firstLive;
  }
  if (!board) return null;

  const boardId = board._id;
  const stage = await ctx.db
    .query("stages")
    .withIndex("by_board_and_order", (q) => q.eq("boardId", boardId))
    .first();
  if (!stage || stage.organizationId !== orgId) return null;
  return { org, actor, board, stage };
}

async function ensureSource(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  name: string,
  now: number,
): Promise<Id<"leadSources">> {
  // Sem índice por nome; as origens da org interna são poucas (dezenas), então itera o índice da org.
  for await (const s of ctx.db.query("leadSources").withIndex("by_organization", (q) => q.eq("organizationId", orgId))) {
    if (s.name.toLowerCase() === name.toLowerCase()) return s._id;
  }
  return await ctx.db.insert("leadSources", {
    organizationId: orgId,
    name,
    type: "other",
    isActive: true,
    createdAt: now,
  });
}

/** Inserção de lead na org interna: sem webhook, sem boas-vindas. */
export async function insertInternalLead(
  ctx: MutationCtx,
  target: InternalTarget,
  args: {
    title: string;
    contactId: Id<"contacts">;
    tags: string[];
    customFields: Record<string, unknown>;
    note?: string;
    via: string;
    /** Origem do lead ("Cadastro" no gancho, "Site – contato" no formulário). */
    sourceName: string;
  },
): Promise<Id<"leads">> {
  const { org, actor, board, stage } = target;
  const now = Date.now();
  const sourceId = await ensureSource(ctx, org._id, args.sourceName, now);
  const leadId = await ctx.db.insert("leads", {
    organizationId: org._id,
    title: args.title,
    contactId: args.contactId,
    boardId: board._id,
    stageId: stage._id,
    value: 0,
    currency: org.settings.currency || "BRL",
    priority: "medium",
    temperature: "cold",
    sourceId,
    tags: args.tags,
    customFields: args.customFields,
    conversationStatus: "new",
    ...leadCreationStagePatch(stage, now),
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.insert("auditLogs", {
    organizationId: org._id,
    entityType: "lead",
    entityId: leadId,
    action: "create",
    actorId: actor._id,
    actorType: "system",
    metadata: { title: args.title, contactId: args.contactId, via: args.via },
    description: buildAuditDescription({ action: "create", entityType: "lead", metadata: { title: args.title } }),
    severity: "medium",
    createdAt: now,
  });
  await ctx.db.insert("activities", {
    organizationId: org._id,
    leadId,
    type: "created",
    actorId: actor._id,
    actorType: "system",
    content: `Lead "${args.title}" criado (${args.via})`,
    createdAt: now,
  });
  if (args.note) await addInternalNote(ctx, target, leadId, args.note);
  return leadId;
}

export async function addInternalNote(
  ctx: MutationCtx,
  target: InternalTarget,
  leadId: Id<"leads">,
  note: string,
): Promise<void> {
  const now = Date.now();
  await ctx.db.insert("activities", {
    organizationId: target.org._id,
    leadId,
    type: "note",
    actorId: target.actor._id,
    actorType: "system",
    content: note,
    createdAt: now,
  });
  await ctx.db.patch(leadId, { lastActivityAt: now, updatedAt: now });
}

// ── Pedido de contato/consultoria (formulário público) ─────────────────────

export type ContactRequest = {
  name: string;
  email: string;
  phone?: string;
  business: string;
  teamSize: string;
  need: string;
  kind: ContactKind;
};

export type ContactParse = { ok: true; value: ContactRequest } | { ok: false; message: string };

/** Valida e saneia o corpo (campo a campo; o JSON é `unknown`). */
export function parseContactRequest(raw: unknown): ContactParse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "Corpo inválido." };
  const b = raw as Record<string, unknown>;
  const kind = b.kind;
  if (typeof kind !== "string" || !(CONTACT_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, message: "Escolha o tipo de pedido." };
  }
  const name = cleanFormText(b.name, CONTACT_LIMITS.name);
  if (name.length < 2) return { ok: false, message: "Informe seu nome." };
  const email = cleanFormText(b.email, CONTACT_LIMITS.email).toLowerCase();
  if (!hasEmailShape(email)) return { ok: false, message: "Informe um e-mail válido." };
  let phone: string | undefined;
  const rawPhone = cleanFormText(b.phone, CONTACT_LIMITS.phone);
  if (rawPhone) {
    const digits = rawPhone.replace(/\D/g, "");
    if (!/^[\d+()\-\s.]+$/.test(rawPhone) || digits.length < 8 || digits.length > 15) {
      return { ok: false, message: "Telefone inválido. Confira o número com DDD." };
    }
    phone = rawPhone;
  }
  const business = cleanFormText(b.business, CONTACT_LIMITS.business);
  const teamSize = cleanFormText(b.teamSize, CONTACT_LIMITS.teamSize);
  const need = cleanFormText(b.need, CONTACT_LIMITS.need, true);
  if (need.length < 5) return { ok: false, message: "Conte em poucas palavras o que você quer resolver." };
  return { ok: true, value: { name, email, ...(phone ? { phone } : {}), business, teamSize, need, kind: kind as ContactKind } };
}

/** Nota do lead: o texto do solicitante entra rotulado, como dado. */
export function buildContactNote(r: ContactRequest): string {
  return [
    `Pedido de ${CONTACT_KIND_LABEL[r.kind]} pelo site (para entrarmos em contato).`,
    r.business ? `Negócio: ${r.business}` : null,
    r.teamSize ? `Equipe: ${r.teamSize}` : null,
    `O que quer resolver: ${r.need}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Contato do solicitante, SÓ por e-mail. Contato existente NÃO é alterado (a rota é pública:
 * quem digita um e-mail alheio não pode mexer no cadastro dele). Telefone nunca é usado para
 * buscar; vai ao contato só quando ele é NOVO (normalizado) e, no caso de existente, o chamador
 * o registra na nota.
 */
export async function findOrCreateInternalContact(
  ctx: MutationCtx,
  target: InternalTarget,
  c: { name: string; email: string; phone?: string; company?: string },
): Promise<{ contactId: Id<"contacts">; created: boolean; phoneStored: boolean }> {
  const orgId = target.org._id;
  const existing = await ctx.db
    .query("contacts")
    .withIndex("by_organization_and_email", (q) => q.eq("organizationId", orgId).eq("email", c.email))
    .first();
  if (existing) return { contactId: existing._id, created: false, phoneStored: false };
  const norm = c.phone ? normalizeCampaignPhone(c.phone, resolveDefaultCountry(target.org.settings)) : null;
  // Número que já é de OUTRO contato da org interna não vai para o contato novo (ficaria um
  // duplicado disputando as mensagens do número); o chamador deixa o telefone só na nota.
  const phoneTaken = norm?.ok ? (await findContactsByPhoneCandidates(ctx, orgId, norm.phone)).length > 0 : false;
  const storePhone = norm?.ok === true && !phoneTaken;
  const contactId = await ctx.runMutation(internal.contacts.internalCreateContact, {
    organizationId: orgId,
    teamMemberId: target.actor._id,
    firstName: c.name,
    email: c.email,
    ...(c.company ? { company: c.company } : {}),
    ...(norm?.ok && storePhone ? { phone: norm.phone, whatsappNumber: norm.phone } : {}),
    auditAsSystem: true,
  });
  return { contactId, created: true, phoneStored: storePhone };
}

// ── Newsletter (inscrição pública) ─────────────────────────────────────────

export const NEWSLETTER_LIMITS = { body: 2_000, name: 80, email: 254, source: 40 } as const;

export type NewsletterSignup = { email: string; name: string };
export type NewsletterParse = { ok: true; value: NewsletterSignup } | { ok: false; message: string };

/** E-mail obrigatório (normalizado) e nome opcional, ambos saneados: texto de formulário é dado. */
export function parseNewsletterSignup(raw: { email?: unknown; name?: unknown } | null | undefined): NewsletterParse {
  if (!raw || typeof raw !== "object") return { ok: false, message: "Corpo inválido." };
  const email = cleanFormText(raw.email, NEWSLETTER_LIMITS.email).toLowerCase();
  if (!hasEmailShape(email)) return { ok: false, message: "Informe um e-mail válido." };
  const name = cleanFormText(raw.name, NEWSLETTER_LIMITS.name);
  return { ok: true, value: { email, name } };
}
