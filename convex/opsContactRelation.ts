/**
 * Ops do tipo de contato (PR1 "Não é cliente / Virar lead"). Só `npx convex
 * run` (nunca UI), `dryRun` padrão TRUE, cursor, saída sem PII (telefone só
 * com os 4 últimos dígitos, sem nomes).
 *
 * - `internalSetRelationByPhones`: aplica um tipo a uma lista de telefones
 *   confirmada (Kenji, AFT…) pela porta única `setContactRelationCore`
 *   (`source:"ops"`, sem audit por contato; um audit por execução real).
 * - `internalMirrorRelationToAiOptOut`: rede de segurança ANTES de qualquer
 *   revert do PR1 — copia "fora do comercial" para `aiOptOut:true` (o código
 *   antigo só conhece o opt-out), para a IA não voltar a falar com a família.
 * - `internalBackfillContactRelationMirror` (PR2): confere/conserta o espelho
 *   `conversations.contactRelation` (filtro por tipo no inbox) contra o tipo do
 *   contato do lead, por org ou na tabela toda. Saída só com contagens e ids.
 *
 *   npx convex run --prod opsContactRelation:internalSetRelationByPhones \
 *     '{"organizationId":"…","items":[{"phone":"5511…","relation":"personal"}]}'
 *   (repita com "dryRun":false depois de conferir o plano)
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { contactRelationValidator, isOffBusiness, type ContactRelation } from "./lib/contactRelation";
import { setContactRelationCore } from "./lib/contactRelationOps";
import { normalizeCampaignPhone } from "./lib/phone";
import { resolveDefaultCountry } from "./lib/orgPhone";
import { findContactsByPhoneCandidates } from "./lib/inboundRouting";
import { getLeadRef } from "./lib/leadRef";
import { relationOfLead } from "./lib/contactRelationGuard";

/** Itens por execução real (cada um pode arquivar leads, cancelar follow-ups…). */
const ITEMS_PER_RUN = 25;
const MAX_ITEMS = 2000;
const DRY_RUN_ITEMS = 500;
const MIRROR_PAGE_DEFAULT = 150;
const MIRROR_PAGE_MAX = 200;

const itemStatusValidator = v.union(
  v.literal("invalid_phone"),
  v.literal("not_found"),
  v.literal("unchanged"),
  v.literal("would_change"),
  v.literal("changed"),
);

function last4(digits: string): string {
  const d = String(digits ?? "").replace(/\D+/g, "");
  return d.length <= 4 ? "****" : `…${d.slice(-4)}`;
}

/** Ator das ops: o membro informado (humano, da org) ou o 1º admin humano ativo. */
async function resolveOpsActor(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  actorMemberId: Id<"teamMembers"> | undefined,
): Promise<Doc<"teamMembers">> {
  if (actorMemberId) {
    const member = await ctx.db.get(actorMemberId);
    if (!member || member.organizationId !== organizationId || member.type === "ai") {
      throw new Error("actorMemberId precisa ser um membro humano desta organização");
    }
    return member;
  }
  const humans = await ctx.db
    .query("teamMembers")
    .withIndex("by_organization_and_type", (q) => q.eq("organizationId", organizationId).eq("type", "human"))
    .take(200);
  const admin = humans.find((m) => m.role === "admin" && m.removedAt === undefined && m.status === "active");
  if (!admin) throw new Error("Nenhum admin humano ativo na organização — informe actorMemberId");
  return admin;
}

export const internalSetRelationByPhones = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    items: v.array(v.object({ phone: v.string(), relation: v.union(contactRelationValidator, v.null()) })),
    dryRun: v.optional(v.boolean()),
    /** Índice do próximo item (a execução real se reagenda sozinha). */
    cursor: v.optional(v.number()),
    actorMemberId: v.optional(v.id("teamMembers")),
    /** Padrão: restaurar só ao sair de um tipo fora do comercial (não ressuscita lead arquivado à mão). */
    restoreLead: v.optional(v.boolean()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    processed: v.number(),
    nextCursor: v.union(v.number(), v.null()),
    counts: v.object({
      invalid_phone: v.number(),
      not_found: v.number(),
      unchanged: v.number(),
      would_change: v.number(),
      changed: v.number(),
      archivedLeads: v.number(),
      restoredLeads: v.number(),
    }),
    items: v.array(
      v.object({
        phone: v.string(),
        relation: v.union(contactRelationValidator, v.null()),
        status: itemStatusValidator,
        contacts: v.number(),
      }),
    ),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    if (args.items.length > MAX_ITEMS) throw new Error(`No máximo ${MAX_ITEMS} itens por chamada`);
    const org = await ctx.db.get(args.organizationId);
    if (!org) throw new Error("Organização não encontrada");
    const actor = await resolveOpsActor(ctx, args.organizationId, args.actorMemberId);
    const country = resolveDefaultCountry(org.settings);

    const start = Math.max(0, Math.floor(args.cursor ?? 0));
    // Dry run: lotes maiores (só leituras); real: lotes pequenos que se reagendam.
    const end = Math.min(args.items.length, start + (dryRun ? DRY_RUN_ITEMS : ITEMS_PER_RUN));
    const counts = {
      invalid_phone: 0,
      not_found: 0,
      unchanged: 0,
      would_change: 0,
      changed: 0,
      archivedLeads: 0,
      restoredLeads: 0,
    };
    const out: Array<{
      phone: string;
      relation: ContactRelation | null;
      status: "invalid_phone" | "not_found" | "unchanged" | "would_change" | "changed";
      contacts: number;
    }> = [];

    for (let i = start; i < end; i++) {
      const item = args.items[i]!;
      const normalized = normalizeCampaignPhone(item.phone, country);
      if (!normalized.ok) {
        counts.invalid_phone += 1;
        out.push({ phone: last4(item.phone), relation: item.relation, status: "invalid_phone", contacts: 0 });
        continue;
      }
      // 12/13 dígitos (9º dígito) e `phone`/`whatsappNumber`: o helper único.
      const contacts = await findContactsByPhoneCandidates(ctx, args.organizationId, normalized.phone);
      if (contacts.length === 0) {
        counts.not_found += 1;
        out.push({ phone: last4(normalized.phone), relation: item.relation, status: "not_found", contacts: 0 });
        continue;
      }
      const pending = contacts.filter((c) => (c.relation ?? null) !== item.relation);
      if (pending.length === 0) {
        counts.unchanged += 1;
        out.push({ phone: last4(normalized.phone), relation: item.relation, status: "unchanged", contacts: contacts.length });
        continue;
      }
      if (dryRun) {
        counts.would_change += 1;
        out.push({ phone: last4(normalized.phone), relation: item.relation, status: "would_change", contacts: pending.length });
        continue;
      }
      for (const contact of pending) {
        const result = await setContactRelationCore(ctx, {
          contact,
          relation: item.relation,
          actor,
          source: "ops",
          // Padrão das ops: só desfaz um "não-cliente" (não ressuscita lead arquivado à mão).
          restoreLead: args.restoreLead ?? isOffBusiness(contact.relation),
          quiet: true,
        });
        counts.archivedLeads += result.archivedLeads;
        if (result.restoredLeadId) counts.restoredLeads += 1;
      }
      counts.changed += 1;
      out.push({ phone: last4(normalized.phone), relation: item.relation, status: "changed", contacts: pending.length });
    }

    const nextCursor = end < args.items.length ? end : null;
    if (!dryRun) {
      if (counts.changed > 0) {
        await ctx.db.insert("auditLogs", {
          organizationId: args.organizationId,
          entityType: "organization",
          entityId: args.organizationId,
          action: "update",
          actorId: actor._id,
          actorType: "system",
          metadata: { op: "opsContactRelation.internalSetRelationByPhones", from: start, to: end, ...counts },
          description: `Ops: tipo de contato aplicado por telefone (${counts.changed} número(s), ${counts.archivedLeads} lead(s) arquivado(s))`,
          severity: "medium",
          createdAt: Date.now(),
        });
      }
      if (nextCursor !== null) {
        await ctx.scheduler.runAfter(0, internal.opsContactRelation.internalSetRelationByPhones, {
          ...args,
          dryRun: false,
          cursor: nextCursor,
        });
      }
    }
    return { dryRun, processed: end - start, nextCursor, counts, items: out };
  },
});

export const internalMirrorRelationToAiOptOut = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    offBusiness: v.number(),
    alreadyOptOut: v.number(),
    wouldSet: v.number(),
    set: v.number(),
    nextCursor: v.union(v.string(), v.null()),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const raw = Number.isFinite(args.pageSize) ? Math.floor(args.pageSize!) : MIRROR_PAGE_DEFAULT;
    const pageSize = Math.min(MIRROR_PAGE_MAX, Math.max(1, raw));
    const page = await ctx.db
      .query("contacts")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .paginate({ numItems: pageSize, cursor: args.cursor ?? null });
    let offBusiness = 0;
    let alreadyOptOut = 0;
    let wouldSet = 0;
    let set = 0;
    const now = Date.now();
    for (const contact of page.page) {
      if (!isOffBusiness(contact.relation)) continue;
      offBusiness += 1;
      if (contact.aiOptOut === true) {
        alreadyOptOut += 1;
        continue;
      }
      if (dryRun) {
        wouldSet += 1;
        continue;
      }
      await ctx.db.patch(contact._id, { aiOptOut: true, updatedAt: now });
      set += 1;
    }
    if (!dryRun) {
      if (set > 0) {
        await ctx.db.insert("auditLogs", {
          organizationId: args.organizationId,
          entityType: "organization",
          entityId: args.organizationId,
          action: "update",
          actorType: "system",
          metadata: { op: "opsContactRelation.internalMirrorRelationToAiOptOut", set },
          description: `Ops: ${set} contato(s) fora do comercial ganharam opt-out de IA (rede de segurança do tipo de contato)`,
          severity: "medium",
          createdAt: now,
        });
      }
      if (!page.isDone) {
        await ctx.scheduler.runAfter(0, internal.opsContactRelation.internalMirrorRelationToAiOptOut, {
          organizationId: args.organizationId,
          dryRun: false,
          cursor: page.continueCursor,
          pageSize,
        });
      }
    }
    return {
      dryRun,
      scanned: page.page.length,
      offBusiness,
      alreadyOptOut,
      wouldSet,
      set,
      nextCursor: page.isDone ? null : page.continueCursor,
      isDone: page.isDone,
    };
  },
});

const BACKFILL_MIRROR_PAGE_DEFAULT = 150;
const BACKFILL_MIRROR_PAGE_MAX = 150;
const BACKFILL_MIRROR_SAMPLE = 20;

const mirrorTotalsValidator = v.object({
  scanned: v.number(),
  mismatched: v.number(),
  written: v.number(),
  pages: v.number(),
});

/**
 * Espelho `conversations.contactRelation` = tipo do contato do lead da conversa
 * (grupo e conversa sem lead/contato = ausente). A porta única já grava o
 * espelho; este op confere e conserta divergências (conversa criada por um
 * caminho antigo, lead que trocou de contato antes do PR1…). Idempotente:
 * a 2ª execução não escreve.
 *
 * `organizationId` ausente = tabela toda. `dryRun` padrão TRUE (uma página, só
 * conta; `countAll:true` encadeia sem escrever). Real: ≤150 escritas por
 * execução e se reagenda pelo cursor.
 *
 *   npx convex run --prod opsContactRelation:internalBackfillContactRelationMirror '{"organizationId":"…","countAll":true}'
 *   npx convex run --prod opsContactRelation:internalBackfillContactRelationMirror '{"organizationId":"…","dryRun":false}'
 */
export const internalBackfillContactRelationMirror = internalMutation({
  args: {
    organizationId: v.optional(v.id("organizations")),
    dryRun: v.optional(v.boolean()),
    countAll: v.optional(v.boolean()),
    cursor: v.optional(v.union(v.string(), v.null())),
    pageSize: v.optional(v.number()),
    totals: v.optional(mirrorTotalsValidator),
  },
  returns: v.object({
    dryRun: v.boolean(),
    scanned: v.number(),
    mismatched: v.number(),
    written: v.number(),
    /** Conversas divergentes desta página (ids e tipos, sem PII). */
    sample: v.array(
      v.object({
        conversationId: v.id("conversations"),
        mirror: v.union(contactRelationValidator, v.null()),
        expected: v.union(contactRelationValidator, v.null()),
      }),
    ),
    isDone: v.boolean(),
    continueCursor: v.union(v.string(), v.null()),
    scheduledNext: v.boolean(),
    totals: mirrorTotalsValidator,
  }),
  handler: async (ctx, args) => {
    const dryRun = args.dryRun !== false;
    const raw = Number.isFinite(args.pageSize) ? Math.floor(args.pageSize!) : BACKFILL_MIRROR_PAGE_DEFAULT;
    const pageSize = Math.min(BACKFILL_MIRROR_PAGE_MAX, Math.max(1, raw));
    const organizationId = args.organizationId;
    const page = organizationId
      ? await ctx.db
          .query("conversations")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
          .paginate({ numItems: pageSize, cursor: args.cursor ?? null })
      : await ctx.db.query("conversations").paginate({ numItems: pageSize, cursor: args.cursor ?? null });

    let mismatched = 0;
    let written = 0;
    const sample: Array<{
      conversationId: Id<"conversations">;
      mirror: ContactRelation | null;
      expected: ContactRelation | null;
    }> = [];
    for (const conversation of page.page) {
      let expected: ContactRelation | undefined;
      if (conversation.kind !== "group") {
        const lead = await getLeadRef(ctx.db, conversation.leadId);
        expected =
          lead && lead.organizationId === conversation.organizationId
            ? await relationOfLead(ctx.db, lead)
            : undefined;
      }
      if (conversation.contactRelation === expected) continue;
      mismatched += 1;
      if (sample.length < BACKFILL_MIRROR_SAMPLE) {
        sample.push({
          conversationId: conversation._id,
          mirror: conversation.contactRelation ?? null,
          expected: expected ?? null,
        });
      }
      if (!dryRun) {
        // Só o espelho: sem `updatedAt` (não reordena nada, não é ação de ninguém).
        await ctx.db.patch(conversation._id, { contactRelation: expected });
        written += 1;
      }
    }

    const prev = args.totals ?? { scanned: 0, mismatched: 0, written: 0, pages: 0 };
    const totals = {
      scanned: prev.scanned + page.page.length,
      mismatched: prev.mismatched + mismatched,
      written: prev.written + written,
      pages: prev.pages + 1,
    };
    const chain = !page.isDone && (!dryRun || args.countAll === true);
    if (chain) {
      await ctx.scheduler.runAfter(0, internal.opsContactRelation.internalBackfillContactRelationMirror, {
        ...(organizationId ? { organizationId } : {}),
        dryRun,
        ...(args.countAll ? { countAll: true } : {}),
        cursor: page.continueCursor,
        pageSize,
        totals,
      });
    }
    if (page.isDone && (!dryRun || args.countAll)) {
      console.log(JSON.stringify({ op: "backfillContactRelationMirror", dryRun, ...totals }));
      if (!dryRun && totals.written > 0 && organizationId) {
        // Um audit por job (nunca por linha), só quando houve conserto numa org.
        await ctx.db.insert("auditLogs", {
          organizationId,
          entityType: "organization",
          entityId: organizationId,
          action: "update",
          actorType: "system",
          metadata: { op: "opsContactRelation.internalBackfillContactRelationMirror", ...totals },
          description: `Ops: espelho do tipo de contato corrigido em ${totals.written} conversa(s)`,
          severity: "low",
          createdAt: Date.now(),
        });
      }
    }
    return {
      dryRun,
      scanned: page.page.length,
      mismatched,
      written,
      sample,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
      scheduledNext: chain,
      totals,
    };
  },
});
