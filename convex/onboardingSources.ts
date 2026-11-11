/**
 * Apoio do runtime padrão para `onboardingExtract.ts` ("use node" não pode
 * exportar queries): checagem de posse do blob enviado no onboarding.
 */
import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { Id } from "./_generated/dataModel";

/**
 * O blob só é lido se alguma linha de `files` DA ORG aponta para ele
 * (fail-closed: blob sem linha, ou só de outra org, é recusado). Devolve o
 * tamanho e o tipo do `_storage` para recusar antes de baixar.
 */
export const internalGetOwnedBlobInfo = internalQuery({
  args: { organizationId: v.id("organizations"), storageId: v.id("_storage") },
  returns: v.union(
    v.null(),
    v.object({ size: v.number(), contentType: v.union(v.string(), v.null()) })
  ),
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("files")
      .withIndex("by_storage_id", (q) => q.eq("storageId", args.storageId))
      .take(20);
    if (!rows.some((r) => r.organizationId === args.organizationId)) return null;
    const meta = await ctx.db.system.get(args.storageId as Id<"_storage">);
    if (!meta) return null;
    return { size: meta.size, contentType: meta.contentType ?? null };
  },
});
