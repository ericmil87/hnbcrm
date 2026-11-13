/**
 * Foto de perfil do contato — PORTAS com `ctx` (regras puras em
 * `lib/contactAvatar.ts`, adaptador do gateway em `lib/bridgeAvatar.ts`).
 *
 *  - `maybeScheduleContactAvatar`: porta ÚNICA de agendamento da busca. Chamada de
 *    dentro de mutations existentes (mensagem recebida 1 a 1, conversa aberta).
 *    Caminho quente sem o que fazer = UMA leitura indexada de `contactAvatars`.
 *  - `expireWhatsappAvatar` / `removeWhatsappAvatar`: evento `Picture`.
 *  - `deleteContactAvatarArtifacts`: exclusão do contato (LGPD) pelas portas de
 *    `files` e `fileRefs`.
 *  - `manualAvatarFields`: `avatarUrl` quando a foto manual (`photoFileId`) muda.
 *
 * `contacts` só é escrito quando o valor exibido muda (`whatsappAvatarContactPatch`).
 */
import { internal } from "../_generated/api";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { configTransport } from "./channelTransport";
import { isSessionLostState } from "./channelHealthSignals";
import { deleteBlobIfUnreferenced } from "./fileRefs";
import { deleteFileRow } from "./storageUsage";
import {
  avatarPhoneFor,
  contactAvatarFetchEnabled,
  isAvatarCheckDue,
  planAvatarSlot,
  resolveDisplayedAvatar,
  whatsappAvatarContactPatch,
} from "./contactAvatar";

/** Sessão utilizável: ausente (canal legado) ou `connected`; perdida/desconectada/pareando não busca (mais estrito que os envios, de propósito). */
export function bridgeSessionAllowsAvatar(state: string | null | undefined): boolean {
  if (state === undefined || state === null) return true;
  return state === "connected" && !isSessionLostState(state);
}

/** Canal bridge ativo, da mesma org e com sessão utilizável. */
export function channelAllowsAvatarFetch(
  config: Doc<"channelConfigs"> | null,
  organizationId: Id<"organizations">
): config is Doc<"channelConfigs"> {
  return (
    !!config &&
    config.organizationId === organizationId &&
    config.channel === "whatsapp" &&
    configTransport(config) === "bridge" &&
    config.status === "active" &&
    bridgeSessionAllowsAvatar(config.bridgeSessionState)
  );
}

export type AvatarTrigger = "inbound" | "open";

/**
 * Agenda UMA busca da foto do contato, se couber. Nunca lança por falta de
 * condição: simplesmente não agenda. Devolve `true` quando agendou.
 *
 * `conversation` e `contact` já foram lidos pelo chamador (sem leitura extra).
 * Ordem do mais barato ao mais caro: gates locais → 1 leitura de
 * `contactAvatars` → (só se vencida) canal + cursor do canal.
 */
export async function maybeScheduleContactAvatar(
  ctx: MutationCtx,
  args: {
    contact: Doc<"contacts"> | null | undefined;
    conversation: Doc<"conversations">;
    /** Canal da mensagem (ingest) — senão o da conversa. */
    channelConfigId?: Id<"channelConfigs">;
    /** Mensagem vinda da importação de histórico. */
    importedFromHistory?: boolean;
  }
): Promise<boolean> {
  if (!contactAvatarFetchEnabled()) return false;
  const { contact, conversation } = args;
  if (!contact || contact.organizationId !== conversation.organizationId) return false;
  if (conversation.channel !== "whatsapp" || conversation.kind === "group") return false;
  if (args.importedFromHistory) return false;
  const phone = avatarPhoneFor(contact);
  if (!phone) return false;

  const channelConfigId = args.channelConfigId ?? conversation.channelConfigId;
  if (!channelConfigId) return false;

  const row = await ctx.db
    .query("contactAvatars")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .first();
  const now = Date.now();
  if (row && row.organizationId !== contact.organizationId) return false;
  if (!isAvatarCheckDue(row, now)) return false;

  const config = await ctx.db.get(channelConfigId);
  if (!channelAllowsAvatarFetch(config, contact.organizationId)) return false;

  const pacing = await ctx.db
    .query("channelAvatarPacing")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", channelConfigId))
    .first();
  const slot = planAvatarSlot(pacing, now, Math.random());
  if (!slot) return false;

  if (pacing) {
    await ctx.db.patch(pacing._id, { nextFetchAt: slot.nextFetchAt });
  } else {
    await ctx.db.insert("channelAvatarPacing", {
      organizationId: contact.organizationId,
      channelConfigId,
      nextFetchAt: slot.nextFetchAt,
    });
  }
  if (row) {
    await ctx.db.patch(row._id, { pendingSince: now, channelConfigId });
  } else {
    // Linha de "ainda não conferido": `none` com `checkedAt: 0` até a 1ª resposta.
    await ctx.db.insert("contactAvatars", {
      organizationId: contact.organizationId,
      contactId: contact._id,
      channelConfigId,
      status: "none",
      checkedAt: 0,
      nextCheckAt: 0,
      pendingSince: now,
    });
  }
  await ctx.scheduler.runAt(slot.runAt, internal.contactAvatar.internalFetchContactAvatar, {
    organizationId: contact.organizationId,
    contactId: contact._id,
    channelConfigId,
  });
  return true;
}

/** Apaga a foto do WhatsApp guardada (blob + linha de `files`) e zera os campos da linha lateral. */
async function dropStoredWhatsappPhoto(ctx: MutationCtx, row: Doc<"contactAvatars">): Promise<void> {
  if (!row.fileId) return;
  const file = await ctx.db.get(row.fileId);
  if (file && file.organizationId === row.organizationId) {
    await deleteBlobIfUnreferenced(ctx, file);
    await deleteFileRow(ctx, file);
  }
}

/**
 * Tira a foto do WhatsApp do contato (removida/oculta/sem foto): apaga o
 * arquivo, limpa a linha lateral e só escreve no contato se ELA era a exibida.
 * `status`/`nextCheckAt` são decididos pelo chamador.
 */
export async function removeWhatsappAvatar(
  ctx: MutationCtx,
  row: Doc<"contactAvatars">,
  contact: Doc<"contacts"> | null,
  patch: { status: "hidden" | "none"; checkedAt: number; nextCheckAt: number }
): Promise<void> {
  const hadUrl = row.url;
  await dropStoredWhatsappPhoto(ctx, row);
  await ctx.db.patch(row._id, {
    status: patch.status,
    checkedAt: patch.checkedAt,
    nextCheckAt: patch.nextCheckAt,
    pictureId: undefined,
    fileId: undefined,
    storageId: undefined,
    url: undefined,
    failures: undefined,
    pendingSince: undefined,
  });
  if (contact && hadUrl && contact.organizationId === row.organizationId) {
    const effect = whatsappAvatarContactPatch({
      hasManualPhoto: !!contact.photoFileId,
      currentAvatarUrl: contact.avatarUrl,
      newWhatsappUrl: undefined,
    });
    // Só tira se era a do WhatsApp que estava na tela.
    if (effect.write && contact.avatarUrl === hadUrl) {
      await ctx.db.patch(contact._id, { avatarUrl: undefined });
    }
  }
}

/**
 * Evento `Picture` (foto trocada): só marca a linha como vencida. A busca
 * acontece no próximo gatilho (mensagem recebida ou conversa aberta).
 * Sem linha: nada a fazer (a primeira busca já virá sem linha).
 */
export async function expireWhatsappAvatar(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  contactId: Id<"contacts">
): Promise<"expired" | "none"> {
  const row = await ctx.db
    .query("contactAvatars")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .first();
  if (!row || row.organizationId !== organizationId) return "none";
  if (row.nextCheckAt === 0 && row.pendingSince === undefined) return "expired";
  await ctx.db.patch(row._id, { nextCheckAt: 0 });
  return "expired";
}

/** Evento `Picture` com `Remove`: remove já a foto do WhatsApp e marca `none`. */
export async function removeWhatsappAvatarNow(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  contact: Doc<"contacts">,
  now: number,
  nextCheckAt: number
): Promise<"removed" | "none"> {
  const row = await ctx.db
    .query("contactAvatars")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .first();
  if (!row || row.organizationId !== organizationId || contact.organizationId !== organizationId) return "none";
  await removeWhatsappAvatar(ctx, row, contact, { status: "none", checkedAt: now, nextCheckAt });
  return "removed";
}

/**
 * `avatarUrl` a gravar quando a foto MANUAL muda (`photoFileId` novo, ou removido):
 * a manual vence; sem ela, cai para a do WhatsApp guardada (ou `undefined`).
 * Devolve só o campo, para espalhar no `patch`/`insert`.
 */
export async function manualAvatarFields(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    contactId?: Id<"contacts">;
    photoFileId?: Id<"files">;
  }
): Promise<{ avatarUrl: string | undefined }> {
  let manualUrl: string | null = null;
  if (args.photoFileId) {
    const file = await ctx.db.get(args.photoFileId);
    if (file && file.organizationId === args.organizationId) {
      manualUrl = await ctx.storage.getUrl(file.storageId as Id<"_storage">);
    }
  }
  let whatsappUrl: string | undefined;
  if (!manualUrl && args.contactId) {
    const row = await ctx.db
      .query("contactAvatars")
      .withIndex("by_contact", (q) => q.eq("contactId", args.contactId!))
      .first();
    if (row && row.organizationId === args.organizationId) whatsappUrl = row.url;
  }
  return { avatarUrl: resolveDisplayedAvatar({ manualUrl, whatsappUrl }) };
}

/**
 * Linha lateral + foto do WHATSAPP (arquivo e blob) de um contato, por `contactId`
 * (serve à cascata, onde o contato já foi excluído). Devolve as escritas feitas.
 */
export async function deleteContactAvatarRows(
  ctx: MutationCtx,
  contactId: Id<"contacts">
): Promise<number> {
  let writes = 0;
  const rows = await ctx.db
    .query("contactAvatars")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .take(5);
  for (const row of rows) {
    await dropStoredWhatsappPhoto(ctx, row);
    await ctx.db.delete(row._id);
    writes += 2;
  }
  return writes;
}

/**
 * Exclusão do contato: linha lateral + foto do WhatsApp + foto manual
 * (`photoFileId`), pelas portas de `files`/`fileRefs`. Devolve quantas escritas
 * fez (orçamento da cascata).
 */
export async function deleteContactAvatarArtifacts(
  ctx: MutationCtx,
  contact: Pick<Doc<"contacts">, "_id" | "organizationId" | "photoFileId">
): Promise<number> {
  let writes = await deleteContactAvatarRows(ctx, contact._id);
  if (contact.photoFileId) {
    const file = await ctx.db.get(contact.photoFileId);
    if (file && file.organizationId === contact.organizationId) {
      await deleteBlobIfUnreferenced(ctx, file);
      await deleteFileRow(ctx, file);
      writes += 1;
    }
  }
  return writes;
}
