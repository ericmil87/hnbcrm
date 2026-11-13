/**
 * Foto do contato do Instagram/Messenger — PORTA com `ctx` (action). Reaproveita a
 * chamada de perfil que o ingest já faz (`needsProfile`) ou a refaz UMA vez por
 * contato por semana (linha lateral vencida, teto diário por conexão em
 * `internalReserveMetaAvatar`). Download com as mesmas validações do WhatsApp
 * (`downloadAvatarImage`: https, host da Meta, redirect manual, corpo com teto,
 * tipo pelos bytes) e MESMO destino: `contactAvatars` + `internalApplyContactAvatar`.
 * Nunca lança nem loga URL/id.
 */
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { ActionCtx } from "../_generated/server";
import { decryptSecret } from "./secretCrypto";
import { profileEndpoint } from "./metaGraph";
import { downloadAvatarImage } from "./avatarFetch";
import { isAllowedMetaAvatarUrl, profilePicOf } from "./metaAvatar";
import { META_AVATAR_MAX_BYTES } from "./contactAvatar";

export type MetaSurface = "messenger" | "instagram";
export type MetaProfile = { ok: boolean; name?: string; username?: string; picUrl?: string };

/** Perfil do remetente na Graph (UMA chamada: nome, usuário e `profile_pic`). Nunca lança. */
export async function fetchMetaProfile(
  conn: Doc<"metaConnections"> | null,
  surface: MetaSurface,
  userId: string
): Promise<MetaProfile> {
  if (!conn || conn.authState === "revoked" || !conn.tokenEncrypted) return { ok: false };
  try {
    const token = await decryptSecret(conn.tokenEncrypted);
    const url = profileEndpoint(
      { authMethod: conn.authMethod, surface, pageId: conn.pageId, igAccountId: conn.igAccountId },
      userId,
      surface
    );
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(4000) });
    const parsed: unknown = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false };
    const b = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    const s = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim() : undefined);
    const picUrl = profilePicOf(b);
    if (surface === "instagram") return { ok: true, name: s(b.name), username: s(b.username), picUrl };
    const name = [s(b.first_name), s(b.last_name)].filter(Boolean).join(" ");
    return { ok: true, name: name || undefined, picUrl };
  } catch {
    return { ok: false }; // segue sem nome/foto (§13 item 9)
  }
}

/**
 * Renova a foto do contato. `profile` já buscado (primeiro contato) evita a 2ª
 * chamada à Graph; sem ele, esta função faz a chamada. Sem `profile_pic` = `none`
 * (30 dias); host fora da allowlist, download recusado ou acima de 500 KB = `error`
 * (recuo 1 h, 6 h, 24 h, 7 dias).
 */
export async function refreshMetaContactAvatar(
  ctx: ActionCtx,
  args: {
    organizationId: Id<"organizations">;
    contactId: Id<"contacts">;
    channelConfigId: Id<"channelConfigs">;
    surface: MetaSurface;
    userId: string;
    connection: Doc<"metaConnections"> | null;
    profile?: MetaProfile;
  }
): Promise<void> {
  const key = {
    organizationId: args.organizationId,
    contactId: args.contactId,
    channelConfigId: args.channelConfigId,
  };
  const record = async (outcome: "none" | "error") => {
    try {
      await ctx.runMutation(internal.contactAvatar.internalRecordAvatarCheck, { ...key, outcome, source: args.surface });
    } catch {
      /* a linha vence sozinha em 10 min (pendingSince) */
    }
  };
  let storedId: Id<"_storage"> | null = null;
  try {
    const go = await ctx.runMutation(internal.metaAvatar.internalReserveMetaAvatar, { ...key, source: args.surface });
    if (!go) return;
    const profile = args.profile ?? (await fetchMetaProfile(args.connection, args.surface, args.userId));
    if (!profile.ok) return await record("error");
    if (!profile.picUrl) return await record("none");
    if (!isAllowedMetaAvatarUrl(profile.picUrl)) return await record("error");
    const image = await downloadAvatarImage(profile.picUrl, {
      allowUrl: isAllowedMetaAvatarUrl,
      maxBytes: META_AVATAR_MAX_BYTES,
    });
    if (!image) return await record("error");
    storedId = await ctx.storage.store(new Blob([image.bytes], { type: image.mime }));
    await ctx.runMutation(internal.contactAvatar.internalApplyContactAvatar, {
      ...key,
      storageId: storedId,
      mimeType: image.mime,
      size: image.size,
      source: args.surface,
    });
    storedId = null; // a mutation assumiu o blob (guarda ou apaga)
  } catch (e) {
    console.warn(`meta avatar: falha (${e instanceof Error ? e.name : "erro"})`);
    if (storedId) await ctx.storage.delete(storedId).catch(() => undefined);
    await record("error");
  }
}
