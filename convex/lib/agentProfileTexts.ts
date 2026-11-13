/**
 * Textos grandes do agente IA (`systemPrompt` + `knowledge`, 30–40 KB juntos)
 * fora do doc do membro — perf Convex I/O, onda 2.
 *
 * O doc de `teamMembers` do membro IA é lido inteiro em todo lugar que só quer
 * metadados (assignee na lista do Inbox/Kanban/tarefas, `findAttendantFor*` em
 * toda mensagem inbound, elegibilidade/commit/preview a cada turno,
 * `getAiStatus`…). Com o texto na tabela `agentProfileTexts`, esses leitores
 * passam a pagar ~2 KB, e todo patch de metadado (`botGuard`, `followUps`…)
 * deixa de regravar os 35 KB.
 *
 * Dual-read POR MEMBRO: `agentProfile.textsMigratedAt` presente = texto na
 * tabela (nunca no doc); ausente = texto ainda no doc (legado, até a op
 * `opsAgentProfile:internalMigrateAgentTexts` rodar). Toda ESCRITA de texto
 * migra o membro na mesma transação.
 *
 * Este é o ÚNICO módulo (fora das ops de migração em `opsAgentProfile.ts`) que
 * lê ou grava `agentProfile.systemPrompt`/`.knowledge` — `agentTextsPort.test.ts`
 * quebra o build se aparecer outro.
 */
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import {
  KNOWLEDGE_ENVELOPE_LABEL,
  displayKnowledge,
  hasStoredEnvelope,
  isEnvelopedKnowledge,
  knowledgeForPrompt,
  unwrapStoredKnowledge,
} from "./agentKnowledge";
import { wrapUntrusted } from "./promptEnvelope";

export type AgentProfile = NonNullable<Doc<"teamMembers">["agentProfile"]>;

export type AgentTexts = { systemPrompt: string | null; knowledge: string | null };

/**
 * Patch de texto: `undefined` mantém o atual; string (inclusive "") grava.
 * `knowledgeEnvelope: true` marca o conhecimento como gerado pela conversa de
 * configuração (só `applyOnboardingDraftCore` passa); ausente = mantém a marca
 * que o membro já tem (salvar pela tela nunca tira nem põe a marca).
 */
export type AgentTextsPatch = { systemPrompt?: string; knowledge?: string; knowledgeEnvelope?: boolean };

export function isAgentTextsMigrated(member: Pick<Doc<"teamMembers">, "agentProfile">): boolean {
  return member.agentProfile?.textsMigratedAt !== undefined;
}

/** Perfil sem os dois campos de texto (o que fica no doc de um membro migrado). */
export function stripAgentTexts(profile: AgentProfile): AgentProfile {
  const { systemPrompt: _sp, knowledge: _kn, ...rest } = profile;
  return rest as AgentProfile;
}

async function getTextsRow(
  ctx: QueryCtx,
  teamMemberId: Id<"teamMembers">
): Promise<Doc<"agentProfileTexts"> | null> {
  return await ctx.db
    .query("agentProfileTexts")
    .withIndex("by_member", (q) => q.eq("teamMemberId", teamMemberId))
    .unique();
}

/** Texto como está gravado (sem desembrulhar) + se conta como "da conversa". */
async function readRawTexts(
  ctx: QueryCtx,
  member: Pick<Doc<"teamMembers">, "_id" | "agentProfile">
): Promise<AgentTexts & { envelope: boolean }> {
  const profile = member.agentProfile;
  if (!profile) return { systemPrompt: null, knowledge: null, envelope: false };
  if (profile.textsMigratedAt === undefined) {
    const knowledge = profile.knowledge ?? null;
    return { systemPrompt: profile.systemPrompt ?? null, knowledge, envelope: isEnvelopedKnowledge(knowledge, false) };
  }
  const row = await getTextsRow(ctx, member._id);
  const knowledge = row?.knowledge ?? null;
  return {
    systemPrompt: row?.systemPrompt ?? null,
    knowledge,
    envelope: isEnvelopedKnowledge(knowledge, row?.knowledgeEnvelope === true),
  };
}

/**
 * Textos do agente (persona + conhecimento) para EXIBIR e editar. Membro sem
 * perfil = tudo null. O conhecimento sai sem o envelope `<crm_data>` que versões
 * antigas gravavam no texto; texto sem envelope sai idêntico ao gravado.
 */
export async function readAgentTexts(
  ctx: QueryCtx,
  member: Pick<Doc<"teamMembers">, "_id" | "agentProfile">
): Promise<AgentTexts> {
  const raw = await readRawTexts(ctx, member);
  return { systemPrompt: raw.systemPrompt, knowledge: displayKnowledge(raw.knowledge) };
}

/**
 * Textos do agente para os construtores de PROMPT (atendente/simulador,
 * publicações e agente de grupo). Conhecimento da conversa de configuração
 * (marca ou envelope legado) chega já envelopado (`knowledgeForPrompt`); o
 * escrito pela empresa chega exatamente como gravado, como antes.
 */
export async function readAgentTextsForPrompt(
  ctx: QueryCtx,
  member: Pick<Doc<"teamMembers">, "_id" | "agentProfile">
): Promise<AgentTexts> {
  const raw = await readRawTexts(ctx, member);
  return { systemPrompt: raw.systemPrompt, knowledge: knowledgeForPrompt(raw.knowledge, raw.envelope) };
}

/**
 * Op `opsAgentProfile:internalNormalizeStoredKnowledge`: uma página de
 * `agentProfileTexts`, regravando sem envelope o conhecimento que o tem e
 * gravando a marca `knowledgeEnvelope` (o prompt continua envelopado).
 * Fica aqui porque este é o único módulo que mexe nos textos do agente.
 */
export async function normalizeStoredKnowledgePage(
  ctx: MutationCtx,
  args: { cursor: string | null; pageSize: number; dryRun: boolean; now: number }
): Promise<{
  scanned: number;
  withEnvelope: number;
  rewritten: number;
  organizations: number;
  continueCursor: string;
  isDone: boolean;
}> {
  const page = await ctx.db
    .query("agentProfileTexts")
    .paginate({ numItems: args.pageSize, cursor: args.cursor });
  let withEnvelope = 0;
  let rewritten = 0;
  const orgs = new Set<string>();
  for (const row of page.page) {
    if (!hasStoredEnvelope(row.knowledge)) continue;
    withEnvelope++;
    orgs.add(row.organizationId);
    if (args.dryRun) continue;
    await ctx.db.patch(row._id, {
      knowledge: unwrapStoredKnowledge(row.knowledge!),
      knowledgeEnvelope: true,
      updatedAt: args.now,
    });
    rewritten++;
  }
  return {
    scanned: page.page.length,
    withEnvelope,
    rewritten,
    organizations: orgs.size,
    continueCursor: page.continueCursor,
    isDone: page.isDone,
  };
}

/**
 * Upsert da linha de texto. Não mexe no doc do membro.
 * `undefined` no patch mantém o valor da linha.
 */
async function upsertTextsRow(
  ctx: MutationCtx,
  member: Pick<Doc<"teamMembers">, "_id" | "organizationId">,
  texts: { systemPrompt: string | undefined; knowledge: string | undefined; knowledgeEnvelope: boolean },
  now: number
): Promise<void> {
  // Nunca grava o envelope no texto: o conhecimento da conversa leva a MARCA, e
  // a leitura para o prompt envelopa. Texto sem envelope fica idêntico.
  const knowledge = texts.knowledge === undefined ? undefined : unwrapStoredKnowledge(texts.knowledge);
  // Sem marca = campo ausente (a linha de quem nunca usou a conversa não muda de forma).
  const knowledgeEnvelope = texts.knowledgeEnvelope ? true : undefined;
  const row = await getTextsRow(ctx, member._id);
  if (row) {
    if (row.organizationId !== member.organizationId) {
      throw new Error("Texto do agente pertence a outra organização");
    }
    await ctx.db.patch(row._id, {
      systemPrompt: texts.systemPrompt,
      knowledge,
      knowledgeEnvelope,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("agentProfileTexts", {
      organizationId: member.organizationId,
      teamMemberId: member._id,
      systemPrompt: texts.systemPrompt,
      knowledge,
      ...(knowledgeEnvelope ? { knowledgeEnvelope } : {}),
      updatedAt: now,
    });
  }
}

/**
 * Grava os textos do agente e devolve o `agentProfile` que deve ficar no doc
 * (sem os textos, com `textsMigratedAt`).
 *
 * - `opts.profile`: o perfil que o chamador vai gravar (ex.: `updateAgentProfile`
 *   já mesclou os metadados). O helper tira os textos dele e grava o doc.
 *   Ausente = o perfil atual do membro.
 * - Membro legado (texto no doc): migra na MESMA transação — os campos que o
 *   patch não traz vêm do doc, a linha nasce com os dois, e o doc perde os dois.
 * - O doc só é regravado quando precisa (migrar ou `opts.profile` informado);
 *   trocar só o texto de um membro já migrado escreve SÓ a linha.
 */
export async function writeAgentTexts(
  ctx: MutationCtx,
  member: Doc<"teamMembers">,
  patch: AgentTextsPatch,
  opts: { profile?: AgentProfile; now?: number } = {}
): Promise<AgentProfile> {
  const profile = member.agentProfile;
  if (!profile) throw new Error("Membro não é um agente de IA com perfil");
  const now = opts.now ?? Date.now();
  const current = await readRawTexts(ctx, member);
  await upsertTextsRow(
    ctx,
    member,
    {
      systemPrompt: patch.systemPrompt ?? current.systemPrompt ?? undefined,
      knowledge: patch.knowledge ?? current.knowledge ?? undefined,
      // A marca do membro se mantém (salvar pela tela, Copiloto, ops); só a
      // aplicação da conversa a põe. Texto colado com o envelope legado também conta.
      knowledgeEnvelope:
        patch.knowledgeEnvelope === true ||
        current.envelope ||
        (patch.knowledge !== undefined && hasStoredEnvelope(patch.knowledge)),
    },
    now
  );
  const base = opts.profile ?? profile;
  const nextProfile: AgentProfile = {
    ...stripAgentTexts(base),
    textsMigratedAt: profile.textsMigratedAt ?? now,
  };
  if (profile.textsMigratedAt === undefined || opts.profile !== undefined) {
    await ctx.db.patch(member._id, { agentProfile: nextProfile, updatedAt: now });
  }
  return nextProfile;
}

/**
 * Cria a linha de texto de um membro RECÉM-inserido já migrado (o insert do
 * membro levou `textsMigratedAt` e nenhum texto). Usado por `seedAttendant`.
 */
export async function insertAgentTextsForNewMember(
  ctx: MutationCtx,
  member: { _id: Id<"teamMembers">; organizationId: Id<"organizations"> },
  texts: AgentTextsPatch,
  now: number
): Promise<void> {
  await upsertTextsRow(
    ctx,
    member,
    {
      systemPrompt: texts.systemPrompt,
      knowledge: texts.knowledge,
      knowledgeEnvelope: texts.knowledgeEnvelope === true || hasStoredEnvelope(texts.knowledge),
    },
    now
  );
}

/**
 * Migração de UM membro (op `internalMigrateAgentTexts`): copia o texto do doc
 * para a linha e limpa o doc. Idempotente — membro já migrado devolve false.
 * Se a linha já existir (migração interrompida/restore), o texto do DOC vence.
 */
export async function migrateMemberTexts(
  ctx: MutationCtx,
  member: Doc<"teamMembers">,
  now: number
): Promise<boolean> {
  const profile = member.agentProfile;
  if (!profile || profile.textsMigratedAt !== undefined) return false;
  await upsertTextsRow(
    ctx,
    member,
    {
      systemPrompt: profile.systemPrompt,
      knowledge: profile.knowledge,
      knowledgeEnvelope: hasStoredEnvelope(profile.knowledge),
    },
    now
  );
  await ctx.db.patch(member._id, {
    agentProfile: { ...stripAgentTexts(profile), textsMigratedAt: now },
    updatedAt: now,
  });
  return true;
}

/**
 * Rollback de UM membro (op `internalRestoreAgentTextsToDoc`): devolve o texto
 * da linha ao doc, apaga a linha e remove `textsMigratedAt`. Idempotente.
 */
export async function restoreMemberTextsToDoc(
  ctx: MutationCtx,
  member: Doc<"teamMembers">,
  now: number
): Promise<boolean> {
  const profile = member.agentProfile;
  if (!profile || profile.textsMigratedAt === undefined) return false;
  const row = await getTextsRow(ctx, member._id);
  const { textsMigratedAt: _m, ...rest } = stripAgentTexts(profile);
  await ctx.db.patch(member._id, {
    agentProfile: {
      ...(rest as AgentProfile),
      ...(row?.systemPrompt !== undefined ? { systemPrompt: row.systemPrompt } : {}),
      // O doc não tem a marca: conhecimento da conversa volta com o envelope no
      // texto (a forma legada, que a leitura reconhece).
      ...(row?.knowledge !== undefined
        ? {
            knowledge:
              row.knowledgeEnvelope === true && row.knowledge.trim()
                ? wrapUntrusted(KNOWLEDGE_ENVELOPE_LABEL, row.knowledge)
                : row.knowledge,
          }
        : {}),
    },
    updatedAt: now,
  });
  if (row) await ctx.db.delete(row._id);
  return true;
}
