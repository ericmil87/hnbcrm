import { v } from "convex/values";
import { query, mutation } from "./_generated/server";
import { requireAuth, requirePermission } from "./lib/auth";

// Respostas rápidas do inbox — texto reutilizável inserido via "/" no composer.
// CRUD exige permissão de resposta no inbox; leitura basta ser membro da org.

const SHORTCUT_RE = /^[a-z0-9][a-z0-9-_]{0,23}$/;

function normalizeShortcut(raw: string): string {
  return raw.trim().replace(/^\//, "").toLowerCase();
}

export const list = query({
  args: { organizationId: v.id("organizations") },
  returns: v.array(
    v.object({
      _id: v.id("quickReplies"),
      shortcut: v.string(),
      content: v.string(),
    })
  ),
  handler: async (ctx, args) => {
    await requireAuth(ctx, args.organizationId);
    const replies = await ctx.db
      .query("quickReplies")
      .withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId))
      .collect();
    replies.sort((a, b) => a.shortcut.localeCompare(b.shortcut));
    return replies.map((r) => ({ _id: r._id, shortcut: r.shortcut, content: r.content }));
  },
});

export const create = mutation({
  args: {
    organizationId: v.id("organizations"),
    shortcut: v.string(),
    content: v.string(),
  },
  returns: v.id("quickReplies"),
  handler: async (ctx, args) => {
    const userMember = await requirePermission(ctx, args.organizationId, "inbox", "reply");

    const shortcut = normalizeShortcut(args.shortcut);
    if (!SHORTCUT_RE.test(shortcut)) {
      throw new Error("Atalho inválido — use letras, números, hífen (até 24 caracteres)");
    }
    const content = args.content.trim();
    if (!content || content.length > 2000) {
      throw new Error("Conteúdo obrigatório (até 2000 caracteres)");
    }

    const existing = await ctx.db
      .query("quickReplies")
      .withIndex("by_organization_and_shortcut", (q) =>
        q.eq("organizationId", args.organizationId).eq("shortcut", shortcut)
      )
      .first();
    if (existing) throw new Error(`Já existe uma resposta com o atalho /${shortcut}`);

    const now = Date.now();
    return await ctx.db.insert("quickReplies", {
      organizationId: args.organizationId,
      shortcut,
      content,
      createdBy: userMember._id,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const update = mutation({
  args: {
    quickReplyId: v.id("quickReplies"),
    shortcut: v.optional(v.string()),
    content: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const reply = await ctx.db.get(args.quickReplyId);
    if (!reply) throw new Error("Resposta rápida não encontrada");
    await requirePermission(ctx, reply.organizationId, "inbox", "reply");

    const patch: { shortcut?: string; content?: string; updatedAt: number } = {
      updatedAt: Date.now(),
    };

    if (args.shortcut !== undefined) {
      const shortcut = normalizeShortcut(args.shortcut);
      if (!SHORTCUT_RE.test(shortcut)) {
        throw new Error("Atalho inválido — use letras, números, hífen (até 24 caracteres)");
      }
      if (shortcut !== reply.shortcut) {
        const existing = await ctx.db
          .query("quickReplies")
          .withIndex("by_organization_and_shortcut", (q) =>
            q.eq("organizationId", reply.organizationId).eq("shortcut", shortcut)
          )
          .first();
        if (existing) throw new Error(`Já existe uma resposta com o atalho /${shortcut}`);
      }
      patch.shortcut = shortcut;
    }

    if (args.content !== undefined) {
      const content = args.content.trim();
      if (!content || content.length > 2000) {
        throw new Error("Conteúdo obrigatório (até 2000 caracteres)");
      }
      patch.content = content;
    }

    await ctx.db.patch(args.quickReplyId, patch);
    return null;
  },
});

export const remove = mutation({
  args: { quickReplyId: v.id("quickReplies") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const reply = await ctx.db.get(args.quickReplyId);
    if (!reply) return null;
    await requirePermission(ctx, reply.organizationId, "inbox", "reply");
    await ctx.db.delete(args.quickReplyId);
    return null;
  },
});
