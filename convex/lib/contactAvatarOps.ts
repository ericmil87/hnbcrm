/**
 * Foto de perfil do contato — PORTAS com `ctx` (regras puras em
 * `lib/contactAvatar.ts`, adaptador do gateway em `lib/bridgeAvatar.ts`).
 *
 *  - `maybeScheduleContactAvatar`: GATILHO (porta única). Chamado de dentro de
 *    mutations existentes (mensagem recebida 1 a 1, conversa aberta com não lidas):
 *    só 1 leitura indexada de `contactAvatars` e, se vencida, agenda
 *    `internalMaybeSchedule` -> `scheduleContactAvatarFetch` (canal, cursor, runAt).
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
import { phoneLookupCandidates } from "./phone";
import { isSessionLostState } from "./channelHealthSignals";
import { deleteBlobIfUnreferenced } from "./fileRefs";
import { deleteFileRow } from "./storageUsage";
import {
  AVATAR_CONFIG_SKIP_BACKOFF_MS,
  AVATAR_NON_BRIDGE_BACKOFF_MS,
  avatarPhoneFor,
  numberChangedPerson,
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

export type AvatarChannelVerdict = "ok" | "foreign" | "non_bridge" | "unusable";

/** Canal serve para buscar foto? `foreign` = outra org (nunca escreve nada). */
export function classifyAvatarChannel(
  config: Doc<"channelConfigs"> | null,
  organizationId: Id<"organizations">
): AvatarChannelVerdict {
  if (!config || config.organizationId !== organizationId) return "foreign";
  if (config.channel !== "whatsapp" || configTransport(config) !== "bridge") return "non_bridge";
  if (config.status !== "active" || !bridgeSessionAllowsAvatar(config.bridgeSessionState)) return "unusable";
  if (!config.bridgeBaseUrl || !config.bridgeTokenEncrypted) return "unusable";
  return "ok";
}

/** Gates locais (sem leitura): kill switch, 1 a 1 de WhatsApp, fora do histórico, telefone de verdade. */
function avatarLocalGates(args: {
  contact: Doc<"contacts"> | null | undefined;
  conversation: Doc<"conversations">;
  importedFromHistory?: boolean;
}): boolean {
  const { contact, conversation } = args;
  if (!contactAvatarFetchEnabled()) return false;
  if (!contact || contact.organizationId !== conversation.organizationId) return false;
  if (conversation.channel !== "whatsapp" || conversation.kind === "group") return false;
  if (args.importedFromHistory) return false;
  return avatarPhoneFor(contact) !== null;
}

/**
 * GATILHO (ingest e abrir conversa) — porta única de agendamento. Roda DENTRO de
 * mutations quentes, então faz o mínimo: gates locais + UMA leitura indexada de
 * `contactAvatars`; se a foto está vencida, agenda `internalMaybeSchedule`, que
 * revalida tudo e mexe no canal e na linha lateral FORA da transação do ingest
 * (o cursor do canal é um doc único: dentro do ingest ele seria disputa de OCC).
 * Nunca lança e nunca lê/escreve o canal nem a linha lateral. Agendar a mais
 * para o mesmo contato é inofensivo (a trava `pendingSince` deduplica lá).
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
  try {
    const { contact, conversation } = args;
    if (!contact || !avatarLocalGates(args)) return false;
    const channelConfigId = args.channelConfigId ?? conversation.channelConfigId;
    if (!channelConfigId) return false;
    const row = await ctx.db
      .query("contactAvatars")
      .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
      .first();
    if (row && row.organizationId !== contact.organizationId) return false;
    if (!isAvatarCheckDue(row, Date.now())) return false;
    await ctx.scheduler.runAfter(0, internal.contactAvatar.internalMaybeSchedule, {
      organizationId: contact.organizationId,
      contactId: contact._id,
      conversationId: conversation._id,
      channelConfigId,
    });
    return true;
  } catch (e) {
    console.warn(`contact avatar: gatilho falhou (${e instanceof Error ? e.name : "erro"})`);
    return false;
  }
}

export type ScheduleOutcome =
  | "scheduled"
  | "ineligible"
  | "not_due"
  | "foreign_channel"
  | "skipped_config"
  | "skipped_non_bridge"
  | "throttled";

/**
 * Agendamento de fato (roda em `internalMaybeSchedule`, mutation própria):
 * revalida contato, conversa, canal e linha; reserva o horário no cursor do
 * canal (teto diário, pausa, fila) e agenda a action em `runAt`. A trava
 * `pendingSince` guarda o horário em que a busca vai RODAR.
 */
export async function scheduleContactAvatarFetch(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    contactId: Id<"contacts">;
    conversationId: Id<"conversations">;
    channelConfigId?: Id<"channelConfigs">;
  }
): Promise<ScheduleOutcome> {
  const contact = await ctx.db.get(args.contactId);
  const conversation = await ctx.db.get(args.conversationId);
  if (!contact || !conversation) return "ineligible";
  if (contact.organizationId !== args.organizationId || conversation.organizationId !== args.organizationId) {
    return "ineligible";
  }
  if (!avatarLocalGates({ contact, conversation })) return "ineligible";
  const channelConfigId = args.channelConfigId ?? conversation.channelConfigId;
  if (!channelConfigId) return "ineligible";

  const row = await ctx.db
    .query("contactAvatars")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .first();
  if (row && row.organizationId !== contact.organizationId) return "ineligible";
  const now = Date.now();
  if (!isAvatarCheckDue(row, now)) return "not_due";

  const config = await ctx.db.get(channelConfigId);
  const verdict = classifyAvatarChannel(config, contact.organizationId);
  if (verdict === "foreign") return "foreign_channel";
  if (verdict === "non_bridge" || verdict === "unusable") {
    // Falta persistente: adia a conferência para não reagendar a cada mensagem.
    const nextCheckAt =
      now + (verdict === "non_bridge" ? AVATAR_NON_BRIDGE_BACKOFF_MS : AVATAR_CONFIG_SKIP_BACKOFF_MS);
    if (row) {
      await ctx.db.patch(row._id, { nextCheckAt });
    } else {
      await ctx.db.insert("contactAvatars", {
        organizationId: contact.organizationId,
        contactId: contact._id,
        channelConfigId,
        status: "none",
        checkedAt: 0,
        nextCheckAt,
      });
    }
    return verdict === "non_bridge" ? "skipped_non_bridge" : "skipped_config";
  }

  const pacing = await ctx.db
    .query("channelAvatarPacing")
    .withIndex("by_channel_config", (q) => q.eq("channelConfigId", channelConfigId))
    .first();
  const slot = planAvatarSlot(pacing, now, Math.random());
  if (!slot) return "throttled";

  const pacingPatch = { nextFetchAt: slot.nextFetchAt, day: slot.day, dayCount: slot.dayCount };
  if (pacing) {
    await ctx.db.patch(pacing._id, pacingPatch);
  } else {
    await ctx.db.insert("channelAvatarPacing", {
      organizationId: contact.organizationId,
      channelConfigId,
      ...pacingPatch,
    });
  }
  if (row) {
    await ctx.db.patch(row._id, { pendingSince: slot.runAt, channelConfigId });
  } else {
    // Linha de "ainda não conferido": `none` com `checkedAt: 0` até a 1ª resposta.
    await ctx.db.insert("contactAvatars", {
      organizationId: contact.organizationId,
      contactId: contact._id,
      channelConfigId,
      status: "none",
      checkedAt: 0,
      nextCheckAt: 0,
      pendingSince: slot.runAt,
    });
  }
  await ctx.scheduler.runAt(slot.runAt, internal.contactAvatar.internalFetchContactAvatar, {
    organizationId: contact.organizationId,
    contactId: contact._id,
    channelConfigId,
  });
  return "scheduled";
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

/**
 * Troca do número do contato: se passou a ser de OUTRA pessoa (grafia BR do
 * mesmo número não conta), a foto do WhatsApp guardada é de outro número — apaga
 * linha lateral, arquivo e blob na mesma mutation. Devolve o campo a espalhar no
 * `patch` do contato (`avatarUrl: undefined` só se era a foto do WhatsApp exibida).
 */
export async function avatarFieldsOnNumberChange(
  ctx: MutationCtx,
  contact: Doc<"contacts">,
  changes: Record<string, unknown>
): Promise<{ avatarUrl?: undefined }> {
  if (!("phone" in changes || "whatsappNumber" in changes)) return {};
  const merged = { whatsappNumber: contact.whatsappNumber, phone: contact.phone, ...changes } as {
    whatsappNumber?: string;
    phone?: string;
  };
  if (!numberChangedPerson(contact, merged, phoneLookupCandidates)) return {};
  const row = await ctx.db
    .query("contactAvatars")
    .withIndex("by_contact", (q) => q.eq("contactId", contact._id))
    .first();
  if (!row) return {};
  const shown = row.url !== undefined && contact.avatarUrl === row.url && !contact.photoFileId;
  await deleteContactAvatarRows(ctx, contact._id);
  return shown ? { avatarUrl: undefined } : {};
}
