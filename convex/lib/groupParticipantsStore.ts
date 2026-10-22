/**
 * Participantes e linha do tempo das salas de grupo em tabelas próprias
 * (perf Convex I/O, fase 4d).
 *
 * Antes moravam em `groupChats.participants` (até 1.024 itens, 60–90 KB) e
 * `groupChats.timeline` (cap 100), e o doc inteiro era lido a cada mensagem de
 * grupo e regravado a cada membro novo. Agora:
 *
 * - `groupParticipants`: uma linha por membro, chave `key = lid ?? phone`.
 * - `groupTimeline`: uma linha por evento, cap 100 por sala na inserção.
 *
 * **Migração em 2 passos.** Enquanto `group.participantsMigratedAt` está
 * ausente, os arrays legados continuam sendo a FONTE DE LEITURA e todo escritor
 * grava nos dois lugares (dual-write); o backfill copia o legado para as
 * tabelas e o `finish` carimba `participantsMigratedAt` e apaga os arrays (é
 * aí que o doc encolhe). Sala criada depois do deploy já nasce migrada.
 *
 * A leitura decide SÓ por `participantsMigratedAt` (e não por "a tabela tem
 * linhas"): entre o deploy e o backfill, a primeira mensagem de um membro cria
 * UMA linha na tabela enquanto o array ainda tem as outras 500 — ler a tabela
 * nessa janela truncaria a lista.
 *
 * LGPD: a regra de `participantsForStorage` vale igual — sala NÃO acompanhada
 * não guarda participantes; quem chama decide a lista desejada.
 */
import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { participantSearchName } from "./groupMemberSearch";

/** Mesmos tetos de `lib/groupChatCore.ts` (sem import de valor: evita ciclo). */
export const STORE_PARTICIPANTS_CAP = 1024;
export const STORE_TIMELINE_CAP = 100;

export type GroupParticipantRow = NonNullable<Doc<"groupChats">["participants"]>[number];
export type GroupTimelineEntry = NonNullable<Doc<"groupChats">["timeline"]>[number];

type ReadCtx = { db: QueryCtx["db"] };
export type GroupRef = Pick<
  Doc<"groupChats">,
  "_id" | "organizationId" | "participants" | "timeline" | "participantsMigratedAt"
>;

export function isGroupMigrated(group: Pick<Doc<"groupChats">, "participantsMigratedAt">): boolean {
  return group.participantsMigratedAt !== undefined;
}

/** Chave estável do participante (a mesma de `participantKey`). */
export function rowKey(p: { lid?: string; phone?: string }): string | undefined {
  return p.lid ?? p.phone;
}

/** Linha da tabela → shape legado (o que todo leitor e a API já conhecem). */
export function rowToParticipant(row: Doc<"groupParticipants">): GroupParticipantRow {
  return {
    ...(row.lid !== undefined ? { lid: row.lid } : {}),
    ...(row.phone !== undefined ? { phone: row.phone } : {}),
    ...(row.name !== undefined ? { name: row.name } : {}),
    isAdmin: row.isAdmin,
    isSuperAdmin: row.isSuperAdmin,
    ...(row.contactId !== undefined ? { contactId: row.contactId } : {}),
    ...(row.joinedAt !== undefined ? { joinedAt: row.joinedAt } : {}),
    ...(row.leftAt !== undefined ? { leftAt: row.leftAt } : {}),
  };
}

function sameRow(row: Doc<"groupParticipants">, p: GroupParticipantRow, key: string): boolean {
  return (
    row.key === key &&
    row.lid === p.lid &&
    row.phone === p.phone &&
    row.name === p.name &&
    row.isAdmin === (p.isAdmin === true) &&
    row.isSuperAdmin === (p.isSuperAdmin === true) &&
    row.contactId === p.contactId &&
    row.joinedAt === p.joinedAt &&
    row.leftAt === p.leftAt
  );
}

/**
 * A linha precisa ser regravada? Diferente do shape legado (`sameRow`) OU com
 * `searchName` desatualizado. `sameRow` fica só com os campos legados porque é
 * também a comparação do `finish` da migração (`diffParticipantsTable`) — uma
 * linha sem `searchName` não é "divergente" do array.
 */
function needsWrite(row: Doc<"groupParticipants">, p: GroupParticipantRow, key: string): boolean {
  return !sameRow(row, p, key) || row.searchName !== participantSearchName(p.name);
}

/** Campos gravados a partir do shape legado (ausente = `undefined` no patch). */
function rowFields(p: GroupParticipantRow, key: string, now: number) {
  return {
    key,
    lid: p.lid,
    phone: p.phone,
    name: p.name,
    isAdmin: p.isAdmin === true,
    isSuperAdmin: p.isSuperAdmin === true,
    contactId: p.contactId,
    joinedAt: p.joinedAt,
    leftAt: p.leftAt,
    updatedAt: now,
    searchName: participantSearchName(p.name),
  };
}

/** Linhas cruas da sala (inclui quem saiu), no teto estrutural. */
export async function loadParticipantRows(
  ctx: ReadCtx,
  groupChatId: Id<"groupChats">
): Promise<Doc<"groupParticipants">[]> {
  return await ctx.db
    .query("groupParticipants")
    .withIndex("by_group", (q) => q.eq("groupChatId", groupChatId))
    .take(STORE_PARTICIPANTS_CAP);
}

/**
 * Participantes da sala no shape legado (inclui quem saiu, como o array).
 * Migrada → tabela; senão → array legado.
 */
export async function participantsOf(
  ctx: ReadCtx,
  group: GroupRef,
  opts: { includeLeft?: boolean } = {}
): Promise<GroupParticipantRow[]> {
  const all = isGroupMigrated(group)
    ? (await loadParticipantRows(ctx, group._id)).map(rowToParticipant)
    : (group.participants ?? []);
  return opts.includeLeft === false ? all.filter((p) => p.leftAt === undefined) : all;
}

async function findRow(
  ctx: ReadCtx,
  groupChatId: Id<"groupChats">,
  who: { lid?: string; phone?: string }
): Promise<Doc<"groupParticipants"> | null> {
  if (who.lid) {
    const lid = who.lid;
    const byLid = await ctx.db
      .query("groupParticipants")
      .withIndex("by_group_and_key", (q) => q.eq("groupChatId", groupChatId).eq("key", lid))
      .first();
    if (byLid) return byLid;
  }
  if (who.phone) {
    const phone = who.phone;
    const byPhone = await ctx.db
      .query("groupParticipants")
      .withIndex("by_group_and_phone", (q) => q.eq("groupChatId", groupChatId).eq("phone", phone))
      .first();
    if (byPhone) return byPhone;
  }
  return null;
}

/**
 * Um participante pela chave (LID ou telefone), mesma regra de casamento do
 * merge legado. Migrada → lookup por índice; senão → `find` no array.
 */
export async function findParticipant(
  ctx: ReadCtx,
  group: GroupRef,
  who: { lid?: string; phone?: string }
): Promise<GroupParticipantRow | null> {
  if (!who.lid && !who.phone) return null;
  if (isGroupMigrated(group)) {
    const row = await findRow(ctx, group._id, who);
    return row ? rowToParticipant(row) : null;
  }
  return (
    (group.participants ?? []).find(
      (p) =>
        (who.lid !== undefined && p.lid === who.lid) ||
        (who.phone !== undefined && p.phone === who.phone)
    ) ?? null
  );
}

/**
 * Upsert de UM participante na tabela (o caminho quente do ingest).
 *
 * `merge(prev)` recebe a linha atual no shape legado (ou `null`) e devolve a
 * linha desejada (ou `null` = nada a fazer) — o chamador aplica a MESMA regra
 * de `mergeParticipantWithFlag`. Só grava se mudou. Não mexe no doc da sala.
 */
export async function upsertParticipant(
  ctx: MutationCtx,
  group: GroupRef,
  who: { lid?: string; phone?: string },
  merge: (prev: GroupParticipantRow | null) => GroupParticipantRow | null,
  now: number
): Promise<{ changed: boolean; inserted: boolean; row: GroupParticipantRow | null }> {
  const existing = await findRow(ctx, group._id, who);
  const prev = existing ? rowToParticipant(existing) : null;
  const next = merge(prev);
  if (!next) return { changed: false, inserted: false, row: prev };
  const key = rowKey(next);
  if (!key) return { changed: false, inserted: false, row: prev };
  if (existing) {
    if (!needsWrite(existing, next, key)) return { changed: false, inserted: false, row: prev };
    await ctx.db.patch(existing._id, rowFields(next, key, now));
    return { changed: true, inserted: false, row: next };
  }
  // Teto estrutural do WhatsApp (o merge legado também recusa o 1.025º).
  // Membro novo é raro; ler as linhas aqui não pesa no ingest comum.
  const count = (await loadParticipantRows(ctx, group._id)).length;
  if (count >= STORE_PARTICIPANTS_CAP) return { changed: false, inserted: false, row: null };
  await ctx.db.insert("groupParticipants", {
    organizationId: group.organizationId,
    groupChatId: group._id,
    ...rowFields(next, key, now),
  });
  return { changed: true, inserted: true, row: next };
}

/**
 * Faz a tabela da sala ficar IGUAL à lista desejada (diff por chave): insere
 * os novos, atualiza os mudados e apaga as linhas que não estão na lista.
 * Usado pela sincronização do gateway (a lista já vem do
 * `mergeParticipantsFromGateway`, com o `leftAt` de quem sumiu), pelos eventos
 * de grupo, pelo backfill e por "parar de acompanhar" (lista vazia = LGPD).
 */
export async function syncParticipantsTable(
  ctx: MutationCtx,
  group: GroupRef,
  desired: GroupParticipantRow[],
  now: number,
  existingRows?: Doc<"groupParticipants">[]
): Promise<{ inserted: number; updated: number; deleted: number }> {
  const rows = existingRows ?? (await loadParticipantRows(ctx, group._id));
  const byKey = new Map<string, Doc<"groupParticipants">>();
  const duplicates: Doc<"groupParticipants">[] = [];
  for (const row of rows) {
    if (byKey.has(row.key)) duplicates.push(row);
    else byKey.set(row.key, row);
  }
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  const kept = new Set<string>();
  for (const p of desired.slice(0, STORE_PARTICIPANTS_CAP)) {
    const key = rowKey(p);
    if (!key || kept.has(key)) continue;
    kept.add(key);
    const row = byKey.get(key);
    if (row) {
      if (needsWrite(row, p, key)) {
        await ctx.db.patch(row._id, rowFields(p, key, now));
        updated++;
      }
    } else {
      await ctx.db.insert("groupParticipants", {
        organizationId: group.organizationId,
        groupChatId: group._id,
        ...rowFields(p, key, now),
      });
      inserted++;
    }
  }
  for (const [key, row] of byKey) {
    if (kept.has(key)) continue;
    await ctx.db.delete(row._id);
    deleted++;
  }
  for (const row of duplicates) {
    await ctx.db.delete(row._id);
    deleted++;
  }
  return { inserted, updated, deleted };
}

/** Marca a saída de um participante (mantém a linha, como o array fazia). */
export async function markLeft(
  ctx: MutationCtx,
  group: GroupRef,
  who: { lid?: string; phone?: string },
  at: number
): Promise<boolean> {
  const res = await upsertParticipant(
    ctx,
    group,
    who,
    (prev) => (prev ? { ...prev, leftAt: at } : null),
    at
  );
  return res.changed;
}

/**
 * Apaga até `budget.left` linhas de uma das tabelas da sala, descontando do
 * orçamento cada escrita. Devolve `true` quando a tabela ficou VAZIA.
 */
async function deleteSideRows(
  ctx: MutationCtx,
  table: "groupParticipants" | "groupTimeline",
  groupChatId: Id<"groupChats">,
  budget: { left: number }
): Promise<boolean> {
  const limit = Math.max(0, budget.left);
  const rows =
    table === "groupParticipants"
      ? await ctx.db
          .query("groupParticipants")
          .withIndex("by_group", (q) => q.eq("groupChatId", groupChatId))
          .take(limit + 1)
      : await ctx.db
          .query("groupTimeline")
          .withIndex("by_group_and_at", (q) => q.eq("groupChatId", groupChatId))
          .take(limit + 1);
  const batch = rows.slice(0, limit);
  for (const row of batch) await ctx.db.delete(row._id);
  budget.left -= batch.length;
  return rows.length <= limit;
}

/**
 * Apaga as linhas de MEMBROS da sala (só `groupParticipants`) até
 * `budget.left` escritas. Devolve `true` quando não sobrou nenhuma — com
 * `false`, quem chama agenda a continuação (perf I/O onda 2: o sync não apaga
 * mais 1.024 linhas por sala numa transação só).
 */
export async function deleteParticipantRows(
  ctx: MutationCtx,
  groupChatId: Id<"groupChats">,
  budget: { left: number }
): Promise<boolean> {
  return await deleteSideRows(ctx, "groupParticipants", groupChatId, budget);
}

/**
 * Cascata de exclusão da sala nas duas tabelas, DENTRO do orçamento de escritas
 * de quem chama (cada linha apagada conta 1). Devolve `true` só quando as duas
 * tabelas da sala estão vazias — aí o chamador pode apagar o doc da sala; com
 * `false`, ele para e se reagenda (uma sala de 1.024 membros sozinha já passa
 * do orçamento de uma execução, e 16 delas estourariam o limite de escritas da
 * transação).
 */
export async function deleteGroupSideTables(
  ctx: MutationCtx,
  groupChatId: Id<"groupChats">,
  budget: { left: number }
): Promise<boolean> {
  if (!(await deleteSideRows(ctx, "groupParticipants", groupChatId, budget))) return false;
  return await deleteSideRows(ctx, "groupTimeline", groupChatId, budget);
}

export function timelineRowToEntry(row: Doc<"groupTimeline">): GroupTimelineEntry {
  return {
    at: row.at,
    type: row.type,
    ...(row.actorJid !== undefined ? { actorJid: row.actorJid } : {}),
    ...(row.data !== undefined ? { data: row.data } : {}),
  };
}

/** Linha do tempo da sala, da mais antiga para a mais nova (shape legado). */
export async function timelineOf(ctx: ReadCtx, group: GroupRef): Promise<GroupTimelineEntry[]> {
  if (!isGroupMigrated(group)) return group.timeline ?? [];
  const rows = await ctx.db
    .query("groupTimeline")
    .withIndex("by_group_and_at", (q) => q.eq("groupChatId", group._id))
    .order("desc")
    .take(STORE_TIMELINE_CAP);
  return rows.reverse().map(timelineRowToEntry);
}

/** Linhas cruas da linha do tempo (backfill/finish/restore). */
export async function loadTimelineRows(
  ctx: ReadCtx,
  groupChatId: Id<"groupChats">
): Promise<Doc<"groupTimeline">[]> {
  return await ctx.db
    .query("groupTimeline")
    .withIndex("by_group_and_at", (q) => q.eq("groupChatId", groupChatId))
    .take(STORE_TIMELINE_CAP * 3);
}

/**
 * Acrescenta eventos à tabela e corta o excedente (cap 100, FIFO — os mais
 * antigos por `at` saem). Não mexe no array legado.
 */
export async function appendTimelineRows(
  ctx: MutationCtx,
  group: Pick<Doc<"groupChats">, "_id" | "organizationId">,
  entries: GroupTimelineEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries.slice(-STORE_TIMELINE_CAP)) {
    await ctx.db.insert("groupTimeline", {
      organizationId: group.organizationId,
      groupChatId: group._id,
      at: entry.at,
      type: entry.type,
      ...(entry.actorJid !== undefined ? { actorJid: entry.actorJid } : {}),
      ...(entry.data !== undefined ? { data: entry.data } : {}),
    });
  }
  // Docs minúsculos: ler até 101 + os recém-inseridos e apagar o excedente.
  const rows = await ctx.db
    .query("groupTimeline")
    .withIndex("by_group_and_at", (q) => q.eq("groupChatId", group._id))
    .take(STORE_TIMELINE_CAP + Math.min(entries.length, STORE_TIMELINE_CAP) + 1);
  const excess = rows.length - STORE_TIMELINE_CAP;
  for (let i = 0; i < excess; i++) await ctx.db.delete(rows[i]._id);
}

/**
 * Faz a linha do tempo da sala na TABELA ficar igual à lista dada (backfill):
 * apaga as linhas atuais e insere `entries` (cap 100). Necessário porque o
 * array legado corta pelo mais antigo INSERIDO e a tabela pelo menor `at` — um
 * evento atrasado com `at` antigo faria as duas divergirem para sempre se o
 * backfill só inserisse o que falta. Devolve quantos eventos gravou.
 */
export async function replaceTimelineRows(
  ctx: MutationCtx,
  group: Pick<Doc<"groupChats">, "_id" | "organizationId">,
  entries: GroupTimelineEntry[],
  existingRows?: Doc<"groupTimeline">[]
): Promise<number> {
  const rows = existingRows ?? (await loadTimelineRows(ctx, group._id));
  for (const row of rows) await ctx.db.delete(row._id);
  const keep = entries.slice(-STORE_TIMELINE_CAP);
  for (const entry of keep) {
    await ctx.db.insert("groupTimeline", {
      organizationId: group.organizationId,
      groupChatId: group._id,
      at: entry.at,
      type: entry.type,
      ...(entry.actorJid !== undefined ? { actorJid: entry.actorJid } : {}),
      ...(entry.data !== undefined ? { data: entry.data } : {}),
    });
  }
  return keep.length;
}

/** Lista legada com os eventos novos, no cap FIFO. */
export function appendLegacyTimeline(
  current: GroupTimelineEntry[] | undefined,
  entries: GroupTimelineEntry[]
): GroupTimelineEntry[] {
  const next = [...(current ?? []), ...entries];
  return next.length > STORE_TIMELINE_CAP ? next.slice(next.length - STORE_TIMELINE_CAP) : next;
}

/**
 * Grava eventos da linha do tempo: tabela sempre; e devolve o patch do array
 * legado (vazio quando a sala já migrou) para o chamador espalhar no MESMO
 * `patch` do doc que ele já ia fazer.
 */
export async function recordTimeline(
  ctx: MutationCtx,
  group: GroupRef,
  entries: GroupTimelineEntry[]
): Promise<{ timeline?: GroupTimelineEntry[] }> {
  await appendTimelineRows(ctx, group, entries);
  if (isGroupMigrated(group)) return {};
  return { timeline: appendLegacyTimeline(group.timeline, entries) };
}

/**
 * Grava a lista desejada de participantes: tabela sempre (diff); e devolve o
 * patch do array legado (vazio quando a sala já migrou).
 */
export async function writeParticipants(
  ctx: MutationCtx,
  group: GroupRef,
  desired: GroupParticipantRow[],
  now: number,
  existingRows?: Doc<"groupParticipants">[]
): Promise<{ participants?: GroupParticipantRow[] }> {
  await syncParticipantsTable(ctx, group, desired, now, existingRows);
  if (isGroupMigrated(group)) return {};
  return { participants: desired };
}

/**
 * Lê a lista ATUAL para um escritor que vai recomputá-la inteira (sync do
 * gateway, eventos de grupo). Devolve também as linhas cruas para o diff não
 * reler a tabela.
 */
export async function participantsForWrite(
  ctx: MutationCtx,
  group: GroupRef
): Promise<{ list: GroupParticipantRow[]; rows: Doc<"groupParticipants">[] }> {
  const rows = await loadParticipantRows(ctx, group._id);
  const list = isGroupMigrated(group) ? rows.map(rowToParticipant) : (group.participants ?? []);
  return { list, rows };
}

/** Assinatura de um evento da linha do tempo (dedupe do backfill). */
export function timelineSignature(e: GroupTimelineEntry): string {
  return JSON.stringify([e.at, e.type, e.actorJid ?? null, e.data ?? null]);
}

/**
 * A tabela bate com a lista desejada? Mesmo conjunto de chaves e cada linha
 * igual campo a campo. Devolve as chaves divergentes (cap 10) para o relatório
 * do `finish`.
 */
export function diffParticipantsTable(
  rows: Doc<"groupParticipants">[],
  desired: GroupParticipantRow[]
): { ok: boolean; missing: number; extra: number; changed: number; sample: string[] } {
  const byKey = new Map<string, Doc<"groupParticipants">>();
  let extra = 0;
  for (const row of rows) {
    if (byKey.has(row.key)) extra++;
    else byKey.set(row.key, row);
  }
  let missing = 0;
  let changed = 0;
  const sample: string[] = [];
  const seen = new Set<string>();
  for (const p of desired) {
    const key = rowKey(p);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const row = byKey.get(key);
    if (!row) {
      missing++;
      if (sample.length < 10) sample.push(`faltando:${key.slice(-6)}`);
    } else if (!sameRow(row, p, key)) {
      changed++;
      if (sample.length < 10) sample.push(`diferente:${key.slice(-6)}`);
    }
  }
  for (const key of byKey.keys()) {
    if (!seen.has(key)) {
      extra++;
      if (sample.length < 10) sample.push(`sobrando:${key.slice(-6)}`);
    }
  }
  return { ok: missing === 0 && extra === 0 && changed === 0, missing, extra, changed, sample };
}

/** Dedupe por chave mantendo a 1ª ocorrência (o array legado pode repetir). */
export function dedupeParticipants(list: GroupParticipantRow[]): GroupParticipantRow[] {
  const seen = new Set<string>();
  const out: GroupParticipantRow[] = [];
  for (const p of list) {
    const key = rowKey(p);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.slice(0, STORE_PARTICIPANTS_CAP);
}

/**
 * Membros ATIVOS da sala sem listar ninguém: sala migrada usa
 * `participantsCount` (mantido por todo escritor); a não migrada conta o
 * array legado, como antes (lista vazia = 0).
 */
export function activeMemberCountOf(
  group: Pick<Doc<"groupChats">, "participants" | "participantsCount" | "participantsMigratedAt">
): number {
  if (isGroupMigrated(group)) return group.participantsCount ?? 0;
  return group.participants?.filter((p) => p.leftAt === undefined).length ?? 0;
}

/** Participante pela chave exata `lid ?? phone` (a que a UI/API manda). */
export async function findParticipantByKey(
  ctx: ReadCtx,
  group: GroupRef,
  key: string
): Promise<GroupParticipantRow | null> {
  if (isGroupMigrated(group)) {
    const row = await ctx.db
      .query("groupParticipants")
      .withIndex("by_group_and_key", (q) => q.eq("groupChatId", group._id).eq("key", key))
      .first();
    return row ? rowToParticipant(row) : null;
  }
  return (group.participants ?? []).find((p) => rowKey(p) === key) ?? null;
}

/**
 * Atualiza campos de UM participante (pela chave): a linha da tabela, e o
 * array legado quando a sala ainda não migrou (devolvido como patch).
 */
export async function patchParticipantByKey(
  ctx: MutationCtx,
  group: GroupRef,
  key: string,
  fields: Partial<GroupParticipantRow>,
  now: number
): Promise<{ participants?: GroupParticipantRow[] }> {
  const row = await ctx.db
    .query("groupParticipants")
    .withIndex("by_group_and_key", (q) => q.eq("groupChatId", group._id).eq("key", key))
    .first();
  if (row) {
    const next = { ...rowToParticipant(row), ...fields };
    if (needsWrite(row, next, key)) await ctx.db.patch(row._id, rowFields(next, key, now));
  }
  if (isGroupMigrated(group)) return {};
  return {
    participants: (group.participants ?? []).map((p) =>
      rowKey(p) === key ? { ...p, ...fields } : p
    ),
  };
}
