/**
 * Reserva da busca de foto do contato do Instagram/Messenger. Mesma tabela
 * (`contactAvatars`) e mesmo teto diário por canal (`channelAvatarPacing`) do
 * WhatsApp; sem fila/intervalo (a Graph não é o gateway), mas respeita a pausa do
 * canal e o teto de `AVATAR_DAILY_CAP_PER_CHANNEL`. Ver lib/metaAvatarOps.ts.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import {
  AVATAR_CONFIG_SKIP_BACKOFF_MS,
  contactAvatarFetchEnabled,
  isAvatarCheckDue,
  planMetaAvatarSlot,
} from "./lib/contactAvatar";

export const internalReserveMetaAvatar = internalMutation({
  args: {
    organizationId: v.id("organizations"),
    contactId: v.id("contacts"),
    channelConfigId: v.id("channelConfigs"),
    source: v.union(v.literal("instagram"), v.literal("messenger")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!contactAvatarFetchEnabled()) return false;
    const contact = await ctx.db.get(args.contactId);
    if (!contact || contact.organizationId !== args.organizationId) return false;
    const config = await ctx.db.get(args.channelConfigId);
    if (
      !config ||
      config.organizationId !== args.organizationId ||
      config.channel !== args.source ||
      config.status !== "active"
    ) {
      return false;
    }
    const now = Date.now();
    const row = await ctx.db
      .query("contactAvatars")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId))
      .first();
    if (row && row.organizationId !== args.organizationId) return false;
    // Vencida (ou sem linha); foto `ok` de outro canal ainda válida não vence.
    if (!isAvatarCheckDue(row, now)) return false;

    const pacing = await ctx.db
      .query("channelAvatarPacing")
      .withIndex("by_channel_config", (q) => q.eq("channelConfigId", args.channelConfigId))
      .first();
    const slot = planMetaAvatarSlot(pacing, now);
    if (!slot) {
      // Teto/pausa: não repete a cada mensagem (1 h, como "canal indisponível").
      if (row) await ctx.db.patch(row._id, { nextCheckAt: Math.max(row.nextCheckAt, now + AVATAR_CONFIG_SKIP_BACKOFF_MS) });
      return false;
    }
    const pacingPatch = { day: slot.day, dayCount: slot.dayCount };
    if (pacing) {
      await ctx.db.patch(pacing._id, pacingPatch);
    } else {
      await ctx.db.insert("channelAvatarPacing", {
        organizationId: args.organizationId,
        channelConfigId: args.channelConfigId,
        nextFetchAt: now,
        ...pacingPatch,
      });
    }
    if (row) {
      await ctx.db.patch(row._id, { pendingSince: now, channelConfigId: args.channelConfigId });
    } else {
      await ctx.db.insert("contactAvatars", {
        organizationId: args.organizationId,
        contactId: args.contactId,
        channelConfigId: args.channelConfigId,
        status: "none",
        checkedAt: 0,
        nextCheckAt: 0,
        pendingSince: now,
        source: args.source,
      });
    }
    return true;
  },
});
