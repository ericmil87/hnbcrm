/**
 * Identidade do cliente no Instagram/Messenger (D3). PSID/IGSID NÃO são
 * telefone: a chave real é `(channelConfigId, externalId)` em
 * `contactChannelIdentities`, e o contato criado nunca recebe
 * `phone`/`whatsappNumber`. Mesma pessoa no IG e no Messenger = dois contatos.
 */
import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { buildSearchText } from "./searchText";

export function maskExternalId(id: string): string {
  return `····${id.slice(-4)}`;
}

export function fallbackMetaName(kind: "instagram" | "messenger", externalId: string): string {
  return `${kind === "instagram" ? "Instagram" : "Messenger"} ${maskExternalId(externalId)}`;
}

function cleanUsername(u: string | undefined): string | undefined {
  const t = u?.trim().replace(/^@+/, "");
  return t ? t : undefined;
}

export async function findOrCreateContactByMetaIdentity(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    channelConfigId: Id<"channelConfigs">;
    kind: "instagram" | "messenger";
    externalId: string;
    username?: string;
    name?: string;
  }
): Promise<{ contactId: Id<"contacts">; identityId: Id<"contactChannelIdentities">; created: boolean }> {
  const username = cleanUsername(args.username);
  const name = args.name?.trim() || undefined;
  const now = Date.now();

  const identity = await ctx.db
    .query("contactChannelIdentities")
    .withIndex("by_channel_config_and_external_id", (q) =>
      q.eq("channelConfigId", args.channelConfigId).eq("externalId", args.externalId)
    )
    .first();

  if (identity && identity.organizationId === args.organizationId) {
    const contact = await ctx.db.get(identity.contactId);
    if (!contact) {
      // Contato apagado (as identidades também são apagadas, mas linhas antigas
      // podem ter sobrado): reaproveita a MESMA identidade com um contato novo, em vez
      // de inserir uma segunda com a mesma chave.
      const displayName =
        name ?? (username ? `@${username}` : fallbackMetaName(args.kind, args.externalId));
      const contactId = await ctx.db.insert("contacts", {
        organizationId: args.organizationId,
        firstName: displayName,
        ...(args.kind === "instagram" && username ? { instagramUsername: username } : {}),
        tags: [],
        searchText: [buildSearchText({ firstName: displayName }), username].filter(Boolean).join(" ") || undefined,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.patch(identity._id, {
        contactId,
        ...(username ? { username } : {}),
        ...(name ? { displayName: name } : {}),
        profileFetchedAt: name || username ? now : undefined,
      });
      return { contactId, identityId: identity._id, created: true };
    }
    if (contact.organizationId === args.organizationId) {
      // Backfill: perfil que chegou depois do primeiro contato.
      const placeholder = fallbackMetaName(args.kind, args.externalId);
      const currentName = [contact.firstName, contact.lastName].filter(Boolean).join(" ");
      const patch: Record<string, unknown> = {};
      if (name && (!currentName || currentName === placeholder)) {
        patch.firstName = name;
        patch.lastName = undefined;
      }
      if (args.kind === "instagram" && username && contact.instagramUsername !== username) {
        patch.instagramUsername = username;
      }
      if (Object.keys(patch).length > 0) {
        const next = { ...contact, ...patch } as typeof contact;
        await ctx.db.patch(contact._id, {
          ...patch,
          searchText:
            [buildSearchText(next), next.instagramUsername].filter(Boolean).join(" ") || undefined,
          updatedAt: now,
        });
      }
      const identityPatch: Record<string, unknown> = {};
      if (name && identity.displayName !== name) identityPatch.displayName = name;
      if (username && identity.username !== username) identityPatch.username = username;
      if ((name || username) && identity.profileFetchedAt === undefined) identityPatch.profileFetchedAt = now;
      if (Object.keys(identityPatch).length > 0) await ctx.db.patch(identity._id, identityPatch);
      return { contactId: contact._id, identityId: identity._id, created: false };
    }
  }

  const displayName =
    name ?? (username ? `@${username}` : fallbackMetaName(args.kind, args.externalId));
  const searchText = [buildSearchText({ firstName: displayName }), username].filter(Boolean).join(" ");
  const contactId = await ctx.db.insert("contacts", {
    organizationId: args.organizationId,
    firstName: displayName,
    ...(args.kind === "instagram" && username ? { instagramUsername: username } : {}),
    tags: [],
    searchText: searchText || undefined,
    createdAt: now,
    updatedAt: now,
  });
  const identityId = await ctx.db.insert("contactChannelIdentities", {
    organizationId: args.organizationId,
    contactId,
    channelConfigId: args.channelConfigId,
    kind: args.kind,
    externalId: args.externalId,
    ...(username ? { username } : {}),
    ...(name ? { displayName: name } : {}),
    ...(name || username ? { profileFetchedAt: now } : {}),
    createdAt: now,
  });
  return { contactId, identityId, created: true };
}

/**
 * Apaga as identidades Instagram/Messenger de um contato. Todo caminho que apaga
 * contato chama isto (contacts.ts, lib/leadCascade.ts, imports.ts).
 */
export async function deleteMetaIdentitiesForContact(
  ctx: { db: MutationCtx["db"] },
  contactId: Id<"contacts">
): Promise<void> {
  const rows = await ctx.db
    .query("contactChannelIdentities")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .take(100);
  for (const row of rows) await ctx.db.delete(row._id);
}
