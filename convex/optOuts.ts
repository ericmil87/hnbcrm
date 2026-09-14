/**
 * Lista de supressão org-wide (opt-out). Quem está aqui NUNCA recebe campanha.
 * Entradas nascem de palavra-chave inbound (SAIR/PARAR…), erro 131050 da Meta,
 * botão manual no contato ou importação. Remover exige `campaigns:full`.
 */
import { v, type ObjectType } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation, QueryCtx, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import {
  authorizeCampaigns,
  resolveActorMember,
  memberHasAny,
  viaMeta,
  type InternalActorArgs,
} from "./lib/campaignAuth";
import { normalizeCampaignPhone } from "./lib/phone";

export const listOptOutsArgs = {
    organizationId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    search: v.optional(v.string()),
  };
export type ListOptOutsArgs = ObjectType<typeof listOptOutsArgs> & InternalActorArgs;
export async function listOptOutsHandler(ctx: QueryCtx, args: ListOptOutsArgs) {
    await authorizeCampaigns(ctx, args.organizationId, "view", args.actorMemberId);
    const search = args.search?.replace(/\D+/g, "");
    if (search) {
      const rows = await ctx.db
        .query("optOuts")
        .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
        .take(2000);
      const page = rows.filter((r) => r.phone.includes(search)).slice(0, args.paginationOpts.numItems);
      return { page, isDone: true, continueCursor: "" };
    }
    return await ctx.db
      .query("optOuts")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .order("desc")
      .paginate(args.paginationOpts);
  }
export const listOptOuts = query({
  args: listOptOutsArgs,
  returns: v.any(),
  handler: listOptOutsHandler,
});

export const isPhoneOptedOut = query({
  args: { organizationId: v.id("organizations"), phone: v.string() },
  returns: v.union(
    v.null(),
    v.object({ _id: v.id("optOuts"), source: v.string(), createdAt: v.number(), reason: v.optional(v.string()) })
  ),
  handler: async (ctx, args) => {
    await requirePermission(ctx, args.organizationId, "campaigns", "view");
    const n = normalizeCampaignPhone(args.phone);
    if (!n.ok) return null;
    const row = await ctx.db
      .query("optOuts")
      .withIndex("by_organization_and_phone", (q) => q.eq("organizationId", args.organizationId).eq("phone", n.phone))
      .first();
    return row ? { _id: row._id, source: row.source, createdAt: row.createdAt, reason: row.reason } : null;
  },
});

/** Contato: está na supressão? (usado pela ficha do contato; gate contacts:view) */
export const isContactOptedOut = query({
  args: { contactId: v.id("contacts") },
  returns: v.union(v.null(), v.object({ _id: v.id("optOuts"), source: v.string(), createdAt: v.number() })),
  handler: async (ctx, args) => {
    const contact = await ctx.db.get(args.contactId);
    if (!contact) return null;
    await requirePermission(ctx, contact.organizationId, "contacts", "view");
    const raw = contact.whatsappNumber ?? contact.phone;
    if (!raw) return null;
    const n = normalizeCampaignPhone(raw);
    if (!n.ok) return null;
    const row = await ctx.db
      .query("optOuts")
      .withIndex("by_organization_and_phone", (q) => q.eq("organizationId", contact.organizationId).eq("phone", n.phone))
      .first();
    return row ? { _id: row._id, source: row.source, createdAt: row.createdAt } : null;
  },
});

export const addOptOutArgs = {
    organizationId: v.id("organizations"),
    phone: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
    reason: v.optional(v.string()),
  };
export type AddOptOutArgs = ObjectType<typeof addOptOutArgs> & InternalActorArgs;
export async function addOptOutHandler(ctx: MutationCtx, args: AddOptOutArgs) {
    // campaigns:manage OU contacts:edit (o botão fica na ficha do contato)
    const member = await resolveActorMember(ctx, args.organizationId, args.actorMemberId);
    if (!memberHasAny(member, [{ category: "campaigns", level: "manage" }, { category: "contacts", level: "edit" }])) {
      throw new Error("Permissão insuficiente");
    }
    let phoneRaw = args.phone;
    let contactId: Id<"contacts"> | undefined = args.contactId;
    if (contactId) {
      const contact = await ctx.db.get(contactId);
      if (!contact || contact.organizationId !== args.organizationId) throw new Error("Contato não encontrado");
      phoneRaw = phoneRaw ?? contact.whatsappNumber ?? contact.phone;
    }
    if (!phoneRaw) throw new Error("Informe o telefone ou um contato com telefone");
    const n = normalizeCampaignPhone(phoneRaw);
    if (!n.ok) throw new Error("Telefone inválido");
    const existing = await ctx.db
      .query("optOuts")
      .withIndex("by_organization_and_phone", (q) => q.eq("organizationId", args.organizationId).eq("phone", n.phone))
      .first();
    if (existing) return existing._id;
    const now = Date.now();
    const id = await ctx.db.insert("optOuts", {
      organizationId: args.organizationId,
      phone: n.phone,
      source: "manual",
      contactId,
      reason: args.reason?.trim() || undefined,
      createdBy: member._id,
      createdAt: now,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "optOut",
      entityId: id,
      action: "create",
      actorId: member._id,
      actorType: "human",
      changes: { after: { phone: n.phone, contactId: contactId ?? null } },
      metadata: { campaign: true, optOut: true, ...viaMeta(args.via) },
      description: `Adicionou ${n.phone} à lista de supressão (não contatar)`,
      severity: "medium",
      createdAt: now,
    });
    await ctx.scheduler.runAfter(0, internal.nodeActions.triggerWebhooks, {
      organizationId: args.organizationId,
      event: "contact.opted_out",
      payload: { phone: n.phone, source: "manual", contactId, by: member._id },
    });
    return id;
  }
export const addOptOut = mutation({
  args: addOptOutArgs,
  returns: v.union(v.id("optOuts"), v.null()),
  handler: addOptOutHandler,
});

export const removeOptOutArgs = { optOutId: v.id("optOuts") };
export type RemoveOptOutArgs = ObjectType<typeof removeOptOutArgs> & InternalActorArgs;
export async function removeOptOutHandler(ctx: MutationCtx, args: RemoveOptOutArgs) {
    const row = await ctx.db.get(args.optOutId);
    if (!row) return null;
    const member = await authorizeCampaigns(ctx, row.organizationId, "full", args.actorMemberId);
    await ctx.db.delete(row._id);
    await ctx.db.insert("auditLogs", {
      organizationId: row.organizationId,
      entityType: "optOut",
      entityId: row._id,
      action: "delete",
      actorId: member._id,
      actorType: "human",
      changes: { before: { phone: row.phone, source: row.source, createdAt: row.createdAt } },
      metadata: { campaign: true, optOut: true, ...viaMeta(args.via) },
      description: `Removeu ${row.phone} da lista de supressão`,
      severity: "high",
      createdAt: Date.now(),
    });
    return null;
  }
export const removeOptOut = mutation({
  args: removeOptOutArgs,
  returns: v.null(),
  handler: removeOptOutHandler,
});
