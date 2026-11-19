/**
 * Importar contatos do celular (.vcf) — PR6 de "contatos pessoais".
 *
 * O arquivo é lido e triado NO NAVEGADOR (`src/lib/vcard.ts`,
 * `src/lib/phoneContactsTriage.ts`); aqui só chegam:
 * - `matchPhoneContacts`: telefones/e-mails normalizados de um pedaço da lista,
 *   para a triagem mostrar quem já está no CRM (consulta de leitura, nada é
 *   gravado);
 * - `startPhoneContactsImport`: SÓ as linhas escolhidas (nome, telefones,
 *   e-mails, empresa, cargo e o tipo decidido). O resto do arquivo nunca sai do
 *   aparelho.
 *
 * A execução reusa a infraestrutura do import de CSV: um `importJobs` com
 * `source:"phone_vcf"` (sem `fileId`), trilha de rollback em
 * `importJobBatches` no MESMO formato (o "Desfazer" é o
 * `importRun.internalRunRollback`), um audit por transição de job e um
 * `import.completed` por job — sem activity/audit/webhook por contato (mesma
 * exceção deliberada do import de CSV). As linhas esperam em `importStagedRows`
 * (50 por doc) e cada lote agenda o próximo (`internal.*`).
 *
 * Regras de cada linha:
 * - dedupe por telefone com as variantes do 9º dígito
 *   (`findContactsByPhoneCandidates`) e por e-mail; o mais antigo vence;
 * - contato existente: só preenche o que está vazio (nome só com
 *   `useAgendaNames`), etiqueta `importado-celular` somada;
 * - tipo pela porta única `setContactRelationCore` (`quiet`, sem webhook):
 *   "Lead" = `customer`; fora do comercial arquiva leads abertos;
 * - "Lead" NUNCA cria lead, a não ser com `createLeads` (padrão desligado):
 *   aí cria no funil do atendente (etapa inicial) ou no funil padrão, só se o
 *   contato não tiver lead nenhum;
 * - nunca envia mensagem.
 *
 * RBAC: `contacts:edit`, só humano (a porta única recusa IA). Não exige
 * `settings:manage` (o CSV exige porque importa qualquer coluna e leads): esta
 * porta só cria/completa contatos com campos básicos e é desfazível.
 */
import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./lib/auth";
import { buildSearchText } from "./lib/searchText";
import { normalizeCampaignPhone } from "./lib/phone";
import { resolveDefaultCountry } from "./lib/orgPhone";
import { findContactsByPhoneCandidates } from "./lib/inboundRouting";
import { isOffBusiness, type ContactRelation } from "./lib/contactRelation";
import { assertHumanRelationActor, attendantPipeline, setContactRelationCore } from "./lib/contactRelationOps";
import { leadCreationStagePatch } from "./lib/leadStageMove";
import { IMPORT_BATCH_SIZE, RELATION_RESTORE_KEY } from "./imports";

// ===== Limites =====

/** Linhas escolhidas por importação (a triagem divide acima disso). */
export const MAX_PHONE_IMPORT_ROWS = 5000;
/** Linhas por chamada de `matchPhoneContacts`. */
export const MATCH_CHUNK_ROWS = 100;
const MAX_PHONES_PER_ROW = 5;
const MAX_EMAILS_PER_ROW = 3;
const MAX_TEXT = 120;
/** Etiqueta posta em todo contato criado ou completado por esta importação. */
export const PHONE_IMPORT_TAG = "importado-celular";

const ACTIVE_STATUSES = ["mapping", "previewing", "preview_ready", "running"] as const;

export const PHONE_IMPORT_CHOICES = ["lead", "personal", "team", "supplier", "partner"] as const;
export type PhoneImportChoice = (typeof PHONE_IMPORT_CHOICES)[number];

const choiceValidator = v.union(
  v.literal("lead"),
  v.literal("personal"),
  v.literal("team"),
  v.literal("supplier"),
  v.literal("partner"),
);

const rowValidator = v.object({
  firstName: v.optional(v.string()),
  lastName: v.optional(v.string()),
  phones: v.array(v.string()),
  emails: v.array(v.string()),
  company: v.optional(v.string()),
  title: v.optional(v.string()),
  choice: choiceValidator,
});

type IncomingRow = {
  firstName?: string;
  lastName?: string;
  phones: string[];
  emails: string[];
  company?: string;
  title?: string;
  choice: PhoneImportChoice;
};

type StagedRow = IncomingRow & { row: number };

/** Tipo de contato gravado para cada escolha da triagem. */
export function relationForChoice(choice: PhoneImportChoice): ContactRelation {
  return choice === "lead" ? "customer" : choice;
}

// ===== Helpers puros =====

function cleanText(value: string | undefined): string | undefined {
  const text = (value ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  return text || undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Telefones re-normalizados com o DDI padrão da org (o cliente não é confiável). */
export function normalizeRowPhones(phones: string[], defaultCountry: string): string[] {
  const out: string[] = [];
  for (const raw of phones.slice(0, MAX_PHONES_PER_ROW * 2)) {
    const normalized = normalizeCampaignPhone(String(raw).slice(0, 40), defaultCountry);
    if (normalized.ok && !out.includes(normalized.phone)) out.push(normalized.phone);
    if (out.length >= MAX_PHONES_PER_ROW) break;
  }
  return out;
}

export function normalizeRowEmails(emails: string[]): string[] {
  const out: string[] = [];
  for (const raw of emails.slice(0, MAX_EMAILS_PER_ROW * 2)) {
    const email = String(raw).trim().toLowerCase().slice(0, 254);
    if (EMAIL_RE.test(email) && !out.includes(email)) out.push(email);
    if (out.length >= MAX_EMAILS_PER_ROW) break;
  }
  return out;
}

function contactDisplayName(contact: Pick<Doc<"contacts">, "firstName" | "lastName">): string | null {
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ") || null;
}

// ===== Helpers de ctx =====

/** Contato existente: telefone (com variantes do 9º dígito) e depois e-mail; o mais antigo vence. */
async function findExistingContact(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  phones: string[],
  emails: string[],
): Promise<Doc<"contacts"> | null> {
  const found: Doc<"contacts">[] = [];
  for (const phone of phones) {
    const matches = await findContactsByPhoneCandidates(ctx, organizationId, phone);
    if (matches[0]) found.push(matches[0]);
  }
  for (const email of emails) {
    const byEmail = await ctx.db
      .query("contacts")
      .withIndex("by_organization_and_email", (q) => q.eq("organizationId", organizationId).eq("email", email))
      .first();
    if (byEmail) found.push(byEmail);
  }
  if (found.length === 0) return null;
  found.sort((x, y) => x._creationTime - y._creationTime || (x._id < y._id ? -1 : 1));
  return found[0];
}

async function requireHumanEditor(ctx: QueryCtx | MutationCtx, organizationId: Id<"organizations">) {
  const member = await requirePermission(ctx, organizationId, "contacts", "edit");
  assertHumanRelationActor(member);
  return member;
}

async function orgDefaultCountry(ctx: QueryCtx | MutationCtx, organizationId: Id<"organizations">): Promise<string> {
  const org = await ctx.db.get(organizationId);
  return resolveDefaultCountry(org?.settings);
}

function lastNameOf(name: string | undefined): string | null {
  const tokens = (name ?? "").trim().split(/\s+/).filter(Boolean);
  return tokens.length >= 2 ? tokens[tokens.length - 1] : null;
}

// ===== Superfície pública =====

/**
 * Contexto da triagem: DDI padrão da org (normalização no navegador) e
 * sobrenomes de quem importa e do dono da org (admin humano mais antigo), para
 * sugerir "Pessoal" a parentes.
 */
export const getPhoneImportContext = query({
  args: { organizationId: v.id("organizations") },
  returns: v.union(
    v.null(),
    v.object({ defaultCountry: v.string(), surnames: v.array(v.string()) }),
  ),
  handler: async (ctx, args) => {
    let member: Doc<"teamMembers">;
    try {
      member = await requireHumanEditor(ctx, args.organizationId);
    } catch {
      return null;
    }
    const humans = await ctx.db
      .query("teamMembers")
      .withIndex("by_organization_and_type", (q) => q.eq("organizationId", args.organizationId).eq("type", "human"))
      .take(200);
    const owner = humans
      .filter((m) => m.role === "admin" && !m.removedAt)
      .sort((a, b) => a._creationTime - b._creationTime)[0];
    const surnames: string[] = [];
    for (const name of [member.name, owner?.name]) {
      const last = lastNameOf(name);
      if (last && !surnames.includes(last)) surnames.push(last);
    }
    return { defaultCountry: await orgDefaultCountry(ctx, args.organizationId), surnames };
  },
});

/**
 * Quem da lista já está no CRM (telefone com variantes do 9º dígito ou
 * e-mail). Leitura só: nada do que chega aqui é gravado.
 */
export const matchPhoneContacts = query({
  args: {
    organizationId: v.id("organizations"),
    rows: v.array(v.object({ key: v.string(), phones: v.array(v.string()), emails: v.array(v.string()) })),
  },
  returns: v.array(
    v.object({
      key: v.string(),
      contactId: v.id("contacts"),
      name: v.union(v.string(), v.null()),
      relation: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireHumanEditor(ctx, args.organizationId);
    if (args.rows.length > MATCH_CHUNK_ROWS) {
      throw new ConvexError(`No máximo ${MATCH_CHUNK_ROWS} contatos por consulta`);
    }
    const defaultCountry = await orgDefaultCountry(ctx, args.organizationId);
    const out: Array<{ key: string; contactId: Id<"contacts">; name: string | null; relation: string | null }> = [];
    for (const row of args.rows) {
      // Teto de leituras por consulta: 3 telefones (× 2 grafias × 2 índices) + 3 e-mails por linha.
      const phones = normalizeRowPhones(row.phones, defaultCountry).slice(0, 3);
      const emails = normalizeRowEmails(row.emails);
      if (phones.length === 0 && emails.length === 0) continue;
      const existing = await findExistingContact(ctx, args.organizationId, phones, emails);
      if (!existing) continue;
      out.push({
        key: row.key,
        contactId: existing._id,
        name: contactDisplayName(existing),
        relation: existing.relation ?? null,
      });
    }
    return out;
  },
});

/**
 * Começa a importação com as linhas escolhidas. Cria o job (`running`), põe as
 * linhas na fila em docs de 50 e agenda o primeiro lote.
 */
export const startPhoneContactsImport = mutation({
  args: {
    organizationId: v.id("organizations"),
    fileName: v.string(),
    createLeads: v.boolean(),
    useAgendaNames: v.optional(v.boolean()),
    rows: v.array(rowValidator),
  },
  returns: v.id("importJobs"),
  handler: async (ctx, args) => {
    const member = await requireHumanEditor(ctx, args.organizationId);
    if (args.rows.length === 0) throw new ConvexError("Escolha ao menos um contato para importar");
    if (args.rows.length > MAX_PHONE_IMPORT_ROWS) {
      throw new ConvexError(
        `Escolha no máximo ${MAX_PHONE_IMPORT_ROWS.toLocaleString("pt-BR")} contatos por importação (recebidos ${args.rows.length.toLocaleString("pt-BR")}). Importe o resto em seguida.`,
      );
    }
    for (const status of ACTIVE_STATUSES) {
      const running = await ctx.db
        .query("importJobs")
        .withIndex("by_organization_and_status", (q) => q.eq("organizationId", args.organizationId).eq("status", status))
        .first();
      if (running) {
        throw new ConvexError(
          "Já existe uma importação em andamento nesta organização — espere ela terminar antes de começar outra.",
        );
      }
    }

    const now = Date.now();
    const fileName = (cleanText(args.fileName) ?? "contatos.vcf").slice(0, 80);
    const jobId = await ctx.db.insert("importJobs", {
      organizationId: args.organizationId,
      requestedBy: member._id,
      status: "running",
      entity: "contacts",
      source: "phone_vcf",
      fileName,
      createLeads: args.createLeads,
      // "update": contato existente é completado (nunca apagado); a coluna
      // fica coerente com o histórico de importações em Configurações › Dados.
      duplicateStrategy: "update",
      matchFields: ["phone", "email"],
      progress: { processed: 0, total: args.rows.length, created: 0, updated: 0, skipped: 0, failed: 0 },
      createdAt: now,
      startedAt: now,
    });

    let chunkIndex = 0;
    for (let start = 0; start < args.rows.length; start += IMPORT_BATCH_SIZE) {
      const rows: StagedRow[] = args.rows.slice(start, start + IMPORT_BATCH_SIZE).map((row, offset) => ({
        row: start + offset + 1,
        firstName: cleanText(row.firstName),
        lastName: cleanText(row.lastName),
        phones: row.phones.slice(0, MAX_PHONES_PER_ROW * 2).map((p) => String(p).slice(0, 40)),
        emails: row.emails.slice(0, MAX_EMAILS_PER_ROW * 2).map((e) => String(e).slice(0, 254)),
        company: cleanText(row.company),
        title: cleanText(row.title),
        choice: row.choice,
      }));
      await ctx.db.insert("importStagedRows", {
        organizationId: args.organizationId,
        jobId,
        chunkIndex,
        rows,
        createdAt: now,
      });
      chunkIndex += 1;
    }

    const counts: Record<string, number> = {};
    for (const row of args.rows) counts[row.choice] = (counts[row.choice] ?? 0) + 1;
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "importJob",
      entityId: jobId,
      action: "create",
      actorId: member._id,
      actorType: "human",
      metadata: {
        entity: "contacts",
        source: "phone_vcf",
        fileName,
        rows: args.rows.length,
        choices: counts,
        createLeads: args.createLeads,
        useAgendaNames: args.useAgendaNames === true,
      },
      description: `Iniciou a importação de contatos do celular (${fileName}) — ${args.rows.length} contato(s) escolhido(s)`,
      severity: "medium",
      createdAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.phoneContactsImport.internalProcessPhoneChunk, {
      jobId,
      chunkIndex: 0,
      useAgendaNames: args.useAgendaNames === true,
    });
    return jobId;
  },
});

/** Estado de uma importação do celular (tela de resultado). */
export const getPhoneContactsImport = query({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("importJobs"),
      status: v.string(),
      fileName: v.string(),
      createLeads: v.boolean(),
      progress: v.object({
        processed: v.number(),
        total: v.number(),
        created: v.number(),
        updated: v.number(),
        skipped: v.number(),
        failed: v.number(),
      }),
      error: v.optional(v.string()),
      finishedAt: v.optional(v.number()),
    }),
  ),
  handler: async (ctx, args) => {
    try {
      await requireHumanEditor(ctx, args.organizationId);
    } catch {
      return null;
    }
    const job = await ctx.db.get(args.jobId);
    if (!job || job.organizationId !== args.organizationId || job.source !== "phone_vcf") return null;
    return {
      _id: job._id,
      status: job.status,
      fileName: job.fileName,
      createLeads: job.createLeads === true,
      progress: job.progress,
      error: job.error,
      finishedAt: job.finishedAt,
    };
  },
});

/** "Desfazer importação": apaga o que foi criado e devolve o que foi alterado (mesmo rollback do CSV). */
export const undoPhoneContactsImport = mutation({
  args: { organizationId: v.id("organizations"), jobId: v.id("importJobs") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const member = await requireHumanEditor(ctx, args.organizationId);
    const job = await ctx.db.get(args.jobId);
    if (!job || job.organizationId !== args.organizationId || job.source !== "phone_vcf") {
      throw new ConvexError("Importação não encontrada");
    }
    if (job.status !== "completed" && job.status !== "completed_with_errors") {
      throw new ConvexError("Só é possível desfazer uma importação concluída");
    }
    await ctx.db.insert("auditLogs", {
      organizationId: args.organizationId,
      entityType: "importJob",
      entityId: job._id,
      action: "update",
      actorId: member._id,
      actorType: "human",
      metadata: { entity: "contacts", source: "phone_vcf", fileName: job.fileName },
      description: `Pediu para desfazer a importação de contatos do celular (${job.fileName})`,
      severity: "medium",
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.importRun.internalRunRollback, { jobId: job._id });
    return null;
  },
});

// ===== Execução (internal) =====

type LeadPipelineCache = {
  board: Doc<"boards">;
  stage: Doc<"stages">;
  currency: string;
} | null;

/** Funil do atendente (etapa inicial) ou funil padrão + 1ª etapa; null = org sem funil. */
async function resolveLeadPipeline(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<LeadPipelineCache> {
  const preferred = await attendantPipeline(ctx, organizationId);
  const boards = (
    await ctx.db
      .query("boards")
      .withIndex("by_organization_and_order", (q) => q.eq("organizationId", organizationId))
      .take(200)
  ).filter((b) => b.archivedAt === undefined);
  const board =
    (preferred?.boardId ? boards.find((b) => b._id === preferred.boardId) : undefined) ??
    boards.find((b) => b.isDefault) ??
    boards[0];
  if (!board) return null;
  const stages = await ctx.db
    .query("stages")
    .withIndex("by_board_and_order", (q) => q.eq("boardId", board._id))
    .take(200);
  const stage =
    (preferred?.initialStageId ? stages.find((s) => s._id === preferred.initialStageId) : undefined) ?? stages[0];
  if (!stage) return null;
  const org = await ctx.db.get(organizationId);
  return { board, stage, currency: org?.settings.currency ?? "BRL" };
}

/**
 * Processa um doc da fila: cria/completa contatos, aplica o tipo pela porta
 * única, cria lead só com `createLeads`, grava a trilha do rollback e agenda
 * o próximo lote (ou o fim pelo `imports.internalFinishImport`).
 */
export const internalProcessPhoneChunk = internalMutation({
  args: { jobId: v.id("importJobs"), chunkIndex: v.number(), useAgendaNames: v.optional(v.boolean()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const staged = await ctx.db
      .query("importStagedRows")
      .withIndex("by_job_and_chunk", (q) => q.eq("jobId", args.jobId).eq("chunkIndex", args.chunkIndex))
      .first();

    if (!job || job.status !== "running" || job.source !== "phone_vcf") {
      // Job encerrado por fora: a fila restante não serve mais para nada.
      const leftovers = await ctx.db
        .query("importStagedRows")
        .withIndex("by_job_and_chunk", (q) => q.eq("jobId", args.jobId))
        .take(200);
      for (const doc of leftovers) await ctx.db.delete(doc._id);
      return null;
    }
    if (!staged) {
      await ctx.scheduler.runAfter(0, internal.imports.internalFinishImport, { jobId: args.jobId });
      return null;
    }

    const organizationId = job.organizationId;
    const actor = await ctx.db.get(job.requestedBy);
    const actorOk = Boolean(actor && actor.organizationId === organizationId && actor.type !== "ai" && !actor.removedAt);
    const defaultCountry = await orgDefaultCountry(ctx, organizationId);
    const now = Date.now();

    const createdIds: string[] = [];
    const updated: Array<{ id: string; before: Record<string, unknown> }> = [];
    const errors: Array<{ row: number; message: string }> = [];
    let created = 0;
    let updatedCount = 0;
    let skipped = 0;
    let failed = 0;
    let pipeline: LeadPipelineCache | undefined;

    for (const item of staged.rows) {
      try {
        if (!actorOk || !actor) throw new Error("Quem pediu a importação não pode mais editar contatos");
        const phones = normalizeRowPhones(item.phones, defaultCountry);
        const emails = normalizeRowEmails(item.emails);
        if (phones.length === 0 && emails.length === 0) {
          failed++;
          errors.push({ row: item.row, message: "Sem telefone ou e-mail válido" });
          continue;
        }
        const relation = relationForChoice(item.choice);
        let contact = await findExistingContact(ctx, organizationId, phones, emails);
        const before: Record<string, unknown> = {};
        let isNew = false;

        if (contact) {
          const patch: Record<string, unknown> = {};
          const setField = (field: keyof Doc<"contacts">, next: unknown) => {
            const current = (contact as Record<string, unknown>)[field];
            if (next === undefined || current === next) return;
            before[field] = current === undefined ? null : current;
            patch[field] = next;
          };
          const hasName = Boolean(contact.firstName || contact.lastName);
          if (item.firstName || item.lastName) {
            if (!hasName || args.useAgendaNames) {
              setField("firstName", item.firstName);
              setField("lastName", item.lastName);
            }
          }
          if (!contact.email && emails[0]) setField("email", emails[0]);
          if (!contact.phone && phones[0]) setField("phone", phones[0]);
          if (!contact.company && item.company) setField("company", item.company);
          if (!contact.title && item.title) setField("title", item.title);
          if (!contact.tags.includes(PHONE_IMPORT_TAG)) {
            before.tags = contact.tags;
            patch.tags = [...contact.tags, PHONE_IMPORT_TAG];
          }
          if (Object.keys(patch).length > 0) {
            const merged = { ...contact, ...patch } as Record<string, unknown>;
            patch.searchText = buildSearchText(merged as Parameters<typeof buildSearchText>[0]) || undefined;
            patch.updatedAt = now;
            await ctx.db.patch(contact._id, patch as Partial<Doc<"contacts">>);
          }
        } else {
          const doc = {
            organizationId,
            firstName: item.firstName,
            lastName: item.lastName,
            phone: phones[0],
            email: emails[0],
            company: item.company,
            title: item.title,
            tags: [PHONE_IMPORT_TAG],
            createdAt: now,
            updatedAt: now,
          };
          const contactId = await ctx.db.insert("contacts", {
            ...doc,
            searchText: buildSearchText(doc) || undefined,
          });
          createdIds.push(contactId);
          isNew = true;
          contact = (await ctx.db.get(contactId))!;
        }

        // Tipo pela porta única (arquiva leads se virou não-cliente; espelho nas conversas).
        const previous = contact.relation ?? null;
        if (previous !== relation) {
          const result = await setContactRelationCore(ctx, {
            contact,
            relation,
            actor,
            source: "import",
            quiet: true,
            webhook: false,
            // "Lead" com "criar lead no funil" desfaz um não-cliente (traz o lead de volta).
            restoreLead: job.createLeads === true && relation === "customer" && isOffBusiness(previous),
          });
          if (!isNew) {
            before.relation = previous;
            before[RELATION_RESTORE_KEY] = result.archivedLeadIds;
          }
        }

        if (job.createLeads === true && relation === "customer") {
          const existingLead = await ctx.db
            .query("leads")
            .withIndex("by_contact", (q) => q.eq("contactId", contact!._id))
            .first();
          if (!existingLead) {
            if (pipeline === undefined) pipeline = await resolveLeadPipeline(ctx, organizationId);
            if (pipeline) {
              const fresh = (await ctx.db.get(contact._id)) ?? contact;
              const title =
                contactDisplayName(fresh) ?? fresh.company ?? fresh.phone ?? fresh.email ?? "Contato do celular";
              const leadId = await ctx.db.insert("leads", {
                organizationId,
                title,
                contactId: contact._id,
                boardId: pipeline.board._id,
                stageId: pipeline.stage._id,
                value: 0,
                currency: pipeline.currency,
                priority: "medium",
                temperature: "cold",
                tags: [PHONE_IMPORT_TAG],
                customFields: {},
                conversationStatus: "new",
                ...leadCreationStagePatch(pipeline.stage, now),
                lastActivityAt: now,
                createdAt: now,
                updatedAt: now,
              });
              createdIds.push(leadId);
            } else {
              errors.push({ row: item.row, message: "Contato importado sem lead: nenhum funil configurado" });
            }
          }
        }

        if (isNew) created++;
        else {
          if (Object.keys(before).length > 0) updated.push({ id: contact._id, before });
          else skipped++;
          updatedCount += Object.keys(before).length > 0 ? 1 : 0;
        }
      } catch (e: unknown) {
        failed++;
        errors.push({ row: item.row, message: e instanceof Error ? e.message : String(e) });
      }
    }

    await ctx.db.insert("importJobBatches", {
      organizationId,
      jobId: args.jobId,
      batchIndex: args.chunkIndex,
      createdIds,
      updated,
      errors,
      createdAt: now,
    });
    await ctx.db.delete(staged._id);

    const fresh = (await ctx.db.get(args.jobId))!;
    await ctx.db.patch(args.jobId, {
      progress: {
        processed: fresh.progress.processed + staged.rows.length,
        total: Math.max(fresh.progress.total, fresh.progress.processed + staged.rows.length),
        created: fresh.progress.created + created,
        updated: fresh.progress.updated + updatedCount,
        skipped: fresh.progress.skipped + skipped,
        failed: fresh.progress.failed + failed,
      },
    });

    await ctx.scheduler.runAfter(0, internal.phoneContactsImport.internalProcessPhoneChunk, {
      jobId: args.jobId,
      chunkIndex: args.chunkIndex + 1,
      useAgendaNames: args.useAgendaNames,
    });
    return null;
  },
});
