/// <reference types="vite/client" />
/**
 * Importação de dados (F3 contatos, F4 leads, F5 rollback).
 *
 * O fluxo se auto-agenda (createImportJob → detect, runPreview → dry-run,
 * confirmImport → execução). Aqui as actions internas também são chamadas
 * diretamente para o teste não depender do timer: elas são idempotentes
 * (detect só roda em `mapping`, dry-run só em `previewing`, a execução tem
 * claim exatamente-uma-vez), então tanto faz quem chega primeiro.
 */
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

/**
 * Chave do cabeçalho dentro do record `mapping` — o Convex só aceita ASCII em
 * nome de campo, então cabeçalho acentuado entra codificado (ver
 * `encodeHeaderKey` em convex/imports.ts).
 */
const k = (header: string) => encodeURIComponent(header);

/** `t.withIdentity()` devolve um handle sem withIdentity/registerComponent. */
type AsUser = ReturnType<TestConvex<typeof schema>["withIdentity"]>;

let t: TestConvex<typeof schema>;

beforeEach(() => {
  t = convexTest(schema, modules);
});

afterEach(async () => {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
});

// ===== Seeds =====

async function seedOrg(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Import",
      slug: "org-import",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });

    const mk = async (name: string, role: "admin" | "agent", email: string) => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name,
        email,
        role,
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return { userId, memberId };
    };

    const admin = await mk("Admin", "admin", "admin@acme.com");
    const ana = await mk("Ana", "agent", "ana@acme.com");

    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Funil Padrão",
      color: "#3b82f6",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const novo = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#64748b", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId, boardId, name: "Qualificado", color: "#22c55e", order: 1,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });

    const parceriasId = await ctx.db.insert("boards", {
      organizationId,
      name: "Parcerias",
      color: "#a855f7",
      isDefault: false,
      order: 1,
      createdAt: now,
      updatedAt: now,
    });
    const prospeccao = await ctx.db.insert("stages", {
      organizationId, boardId: parceriasId, name: "Prospecção", color: "#eab308", order: 0,
      isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });

    return { organizationId, admin, ana, boardId, novo, parceriasId, prospeccao };
  });
}

async function seedCsv(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">,
  uploadedBy: Id<"teamMembers">,
  content: string,
  name = "contatos.csv"
): Promise<Id<"files">> {
  return await t.run(async (ctx) => {
    const storageId = await ctx.storage.store(new Blob([content], { type: "text/csv" }));
    return await ctx.db.insert("files", {
      organizationId,
      storageId,
      name,
      mimeType: "text/csv",
      size: new TextEncoder().encode(content).length,
      fileType: "import_file",
      uploadedBy,
      createdAt: Date.now(),
    });
  });
}

const getJob = async (t: TestConvex<typeof schema>, jobId: Id<"importJobs">) =>
  await t.run(async (ctx) => await ctx.db.get(jobId));

const batchesOf = async (t: TestConvex<typeof schema>, jobId: Id<"importJobs">) =>
  await t.run(async (ctx) =>
    await ctx.db
      .query("importJobBatches")
      .withIndex("by_job", (q) => q.eq("jobId", jobId))
      .collect()
  );

const contactsOf = async (t: TestConvex<typeof schema>, organizationId: Id<"organizations">) =>
  await t.run(async (ctx) =>
    await ctx.db
      .query("contacts")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .collect()
  );

const leadsOf = async (t: TestConvex<typeof schema>, organizationId: Id<"organizations">) =>
  await t.run(async (ctx) =>
    await ctx.db
      .query("leads")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .collect()
  );

// ===== Passos do wizard (idempotentes) =====

async function startJob(
  asAdmin: AsUser,
  s: { organizationId: Id<"organizations">; admin: { memberId: Id<"teamMembers"> } },
  entity: "contacts" | "leads",
  csv: string,
  duplicateStrategy: "skip" | "update" | "create" = "skip",
  fileName = "dados.csv"
): Promise<Id<"importJobs">> {
  const fileId = await seedCsv(t, s.organizationId, s.admin.memberId, csv, fileName);
  const jobId = await asAdmin.mutation(api.imports.createImportJob, {
    organizationId: s.organizationId,
    entity,
    fileId,
    fileName,
    duplicateStrategy,
  });
  await t.finishInProgressScheduledFunctions();
  await t.action(internal.importRun.internalDetectHeaders, { jobId });
  await t.finishInProgressScheduledFunctions();
  return jobId;
}

async function preview(
  asAdmin: AsUser,
  organizationId: Id<"organizations">,
  jobId: Id<"importJobs">
) {
  await asAdmin.mutation(api.imports.runPreview, { organizationId, jobId });
  await t.finishInProgressScheduledFunctions();
  await t.action(internal.importRun.internalRunDryRun, { jobId });
  await t.finishInProgressScheduledFunctions();
}

async function execute(
  asAdmin: AsUser,
  organizationId: Id<"organizations">,
  jobId: Id<"importJobs">
) {
  await asAdmin.mutation(api.imports.confirmImport, { organizationId, jobId });
  await t.finishInProgressScheduledFunctions();
  await t.action(internal.importRun.internalRunImport, { jobId });
  await t.finishInProgressScheduledFunctions();
}

async function rollback(
  asAdmin: AsUser,
  organizationId: Id<"organizations">,
  jobId: Id<"importJobs">
) {
  await asAdmin.mutation(api.imports.rollbackImport, { organizationId, jobId });
  await t.finishInProgressScheduledFunctions();
  await t.action(internal.importRun.internalRunRollback, { jobId });
  await t.finishInProgressScheduledFunctions();
}

const CONTACTS_CSV = [
  "Nome,Sobrenome,E-mail,Telefone,Empresa,Etiquetas",
  "Maria,Silva,maria@exemplo.com,(11) 98888-7777,Acme,vip;quente",
  "João,Souza,joao@exemplo.com,+55 11 97777-6666,Beta,",
  "Ana,Lima,nao-eh-email,11 96666-5555,Gama,",
].join("\n");

// ===== Wizard de contatos =====

describe("wizard de contatos", () => {
  test("mapeamento sugerido → dry-run → confirmação → concluído com erros", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const jobId = await startJob(asAdmin, s, "contacts", CONTACTS_CSV);

    // 1. Detecção de cabeçalhos + sugestão
    const detected = await getJob(t, jobId);
    expect(detected?.status).toBe("mapping");
    expect(detected?.detectedHeaders).toEqual([
      "Nome", "Sobrenome", "E-mail", "Telefone", "Empresa", "Etiquetas",
    ]);
    expect(detected?.suggestedMapping?.[k("Nome")]).toBe("firstName");
    expect(detected?.suggestedMapping?.[k("E-mail")]).toBe("email");
    expect(detected?.suggestedMapping?.[k("Telefone")]).toBe("phone");
    expect(detected?.suggestedMapping?.[k("Etiquetas")]).toBe("tags");
    expect(detected?.matchFields).toEqual(["email", "phone"]);

    // 2. Mapeamento ajustado pelo usuário (ignora a empresa)
    await asAdmin.mutation(api.imports.updateMapping, {
      organizationId: s.organizationId,
      jobId,
      mapping: { ...detected!.suggestedMapping!, [k("Empresa")]: "__ignore__" },
    });

    // 3. Dry-run
    await preview(asAdmin, s.organizationId, jobId);
    const previewed = await getJob(t, jobId);
    expect(previewed?.status).toBe("preview_ready");
    expect(previewed?.dryRun?.totalRows).toBe(3);
    expect(previewed?.dryRun?.validRows).toBe(2);
    expect(previewed?.dryRun?.errorRows).toBe(1);
    expect(previewed?.dryRun?.newRows).toBe(2);
    expect(previewed?.dryRun?.sampleErrors[0].row).toBe(3);
    expect(previewed?.dryRun?.preview.length).toBe(3);

    // 4. Execução
    await execute(asAdmin, s.organizationId, jobId);
    const done = await getJob(t, jobId);
    expect(done?.status).toBe("completed_with_errors");
    expect(done?.progress).toMatchObject({
      processed: 3, total: 3, created: 2, updated: 0, skipped: 0, failed: 1,
    });

    const contacts = await contactsOf(t, s.organizationId);
    expect(contacts.length).toBe(2);
    const maria = contacts.find((c) => c.email === "maria@exemplo.com");
    expect(maria?.firstName).toBe("Maria");
    expect(maria?.lastName).toBe("Silva");
    expect(maria?.phone).toBe("11988887777");
    expect(maria?.tags).toEqual(["vip", "quente"]);
    expect(maria?.company).toBeUndefined(); // coluna ignorada no mapeamento

    // Auditoria de cada transição (criação, início e conclusão)
    const audits = await t.run(async (ctx) =>
      await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "importJob").eq("entityId", jobId))
        .collect()
    );
    expect(audits.length).toBe(3);
    expect(audits.every((a) => a.severity === "medium")).toBe(true);
  });

  test("importa campo personalizado (cf:) validado contra as fieldDefinitions", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    await t.run(async (ctx) => {
      await ctx.db.insert("fieldDefinitions", {
        organizationId: s.organizationId,
        name: "Origem do lead",
        key: "origem_lead",
        type: "select",
        entityType: "contact",
        options: ["Indicação", "Site"],
        isRequired: false,
        order: 0,
        createdAt: Date.now(),
      });
    });

    const csv = [
      "Nome,E-mail,Origem do lead",
      "Rita,rita@exemplo.com,Indicação",
      "Téo,teo@exemplo.com,Feira de rua",
    ].join("\n");

    const jobId = await startJob(asAdmin, s, "contacts", csv);
    const detected = await getJob(t, jobId);
    expect(detected?.suggestedMapping?.[k("Origem do lead")]).toBe("cf:origem_lead");

    await preview(asAdmin, s.organizationId, jobId);
    const dry = (await getJob(t, jobId))?.dryRun;
    expect(dry?.validRows).toBe(1);
    expect(dry?.errorRows).toBe(1);
    expect(dry?.sampleErrors[0].message).toMatch(/não é uma opção/);

    await execute(asAdmin, s.organizationId, jobId);
    const contacts = await contactsOf(t, s.organizationId);
    expect(contacts.length).toBe(1);
    expect(contacts[0].customFields).toEqual({ origem_lead: "Indicação" });
  });

  test("dispara os webhooks import.completed e import.rolled_back", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const csv = ["Nome,E-mail", "Rita,rita@exemplo.com"].join("\n");

    const jobId = await startJob(asAdmin, s, "contacts", csv);
    await preview(asAdmin, s.organizationId, jobId);
    await execute(asAdmin, s.organizationId, jobId);
    await rollback(asAdmin, s.organizationId, jobId);

    const events = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((f) => f.name.includes("triggerWebhooks"))
        .map((f) => (f.args[0] as { event: string }).event)
    );
    expect(events).toContain("import.completed");
    expect(events).toContain("import.rolled_back");
  });

  test("updateMapping recusa campo inexistente e coluna fora do arquivo", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const jobId = await startJob(asAdmin, s, "contacts", CONTACTS_CSV);

    await expect(
      asAdmin.mutation(api.imports.updateMapping, {
        organizationId: s.organizationId,
        jobId,
        mapping: { Nome: "campoQueNaoExiste" },
      })
    ).rejects.toThrow(/não existe em contatos/);

    await expect(
      asAdmin.mutation(api.imports.updateMapping, {
        organizationId: s.organizationId,
        jobId,
        mapping: { "Coluna Fantasma": "firstName" },
      })
    ).rejects.toThrow(/não existe no arquivo/);

    await expect(
      asAdmin.mutation(api.imports.updateMapping, {
        organizationId: s.organizationId,
        jobId,
        mapping: { Nome: "cf:inexistente" },
      })
    ).rejects.toThrow(/Campo personalizado/);
  });

  test("getFailedRowsCsv devolve só as linhas com erro e a coluna de erro", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const jobId = await startJob(asAdmin, s, "contacts", CONTACTS_CSV);
    await preview(asAdmin, s.organizationId, jobId);
    await execute(asAdmin, s.organizationId, jobId);

    const csv: string = await asAdmin.action(api.imports.getFailedRowsCsv, {
      organizationId: s.organizationId,
      jobId,
    });
    expect(csv).toContain("erro");
    expect(csv).toContain("Ana");
    expect(csv).toContain("nao-eh-email");
    expect(csv).not.toContain("maria@exemplo.com");
  });
});

// ===== Estratégias de duplicata =====

describe("estratégias de duplicata", () => {
  const DUP_CSV = [
    "Nome,E-mail,Empresa,Etiquetas",
    "Maria Clara,maria@exemplo.com,Acme,nova",
  ].join("\n");

  async function seedMaria(organizationId: Id<"organizations">) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("contacts", {
        organizationId,
        firstName: "Maria",
        email: "maria@exemplo.com",
        company: "Antiga",
        tags: ["antiga"],
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  test("skip mantém o contato existente intacto", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const mariaId = await seedMaria(s.organizationId);

    const jobId = await startJob(asAdmin, s, "contacts", DUP_CSV, "skip");
    await preview(asAdmin, s.organizationId, jobId);
    const previewed = await getJob(t, jobId);
    expect(previewed?.dryRun?.skipRows).toBe(1);
    expect(previewed?.dryRun?.newRows).toBe(0);

    await execute(asAdmin, s.organizationId, jobId);
    const job = await getJob(t, jobId);
    expect(job?.status).toBe("completed");
    expect(job?.progress).toMatchObject({ created: 0, updated: 0, skipped: 1, failed: 0 });

    const maria = await t.run(async (ctx) => await ctx.db.get(mariaId));
    expect(maria?.firstName).toBe("Maria");
    expect(maria?.company).toBe("Antiga");
    expect((await contactsOf(t, s.organizationId)).length).toBe(1);
  });

  test("update atualiza o contato existente e guarda o estado anterior", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const mariaId = await seedMaria(s.organizationId);

    const jobId = await startJob(asAdmin, s, "contacts", DUP_CSV, "update");
    await preview(asAdmin, s.organizationId, jobId);
    expect((await getJob(t, jobId))?.dryRun?.updateRows).toBe(1);

    await execute(asAdmin, s.organizationId, jobId);
    expect((await getJob(t, jobId))?.progress).toMatchObject({
      created: 0, updated: 1, skipped: 0, failed: 0,
    });

    const maria = await t.run(async (ctx) => await ctx.db.get(mariaId));
    expect(maria?.firstName).toBe("Maria Clara");
    expect(maria?.company).toBe("Acme");
    // Etiquetas somam — a importação nunca apaga etiqueta existente.
    expect(maria?.tags?.sort()).toEqual(["antiga", "nova"]);

    const batches = await batchesOf(t, jobId);
    expect(batches.length).toBe(1);
    expect(batches[0].updated.length).toBe(1);
    expect(batches[0].updated[0].before).toMatchObject({
      firstName: "Maria",
      company: "Antiga",
    });
  });

  test("create cria um segundo contato mesmo com e-mail repetido", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    await seedMaria(s.organizationId);

    const jobId = await startJob(asAdmin, s, "contacts", DUP_CSV, "create");
    await preview(asAdmin, s.organizationId, jobId);
    expect((await getJob(t, jobId))?.dryRun?.newRows).toBe(1);

    await execute(asAdmin, s.organizationId, jobId);
    expect((await getJob(t, jobId))?.progress).toMatchObject({ created: 1, updated: 0, skipped: 0 });

    const contacts = await contactsOf(t, s.organizationId);
    expect(contacts.filter((c) => c.email === "maria@exemplo.com").length).toBe(2);
  });
});

// ===== Import de leads =====

describe("import de leads", () => {
  const LEADS_CSV = [
    "Título,Valor,Funil,Estágio,E-mail do contato,Nome do contato,Responsável,Prioridade",
    'Projeto Alfa,"R$ 1.500,50",parcerias,prospecção,cliente@exemplo.com,Cliente Um,ana@acme.com,alta',
    "Projeto Beta,2000,Funil Inexistente,Etapa Inexistente,outro@exemplo.com,Cliente Dois,,",
  ].join("\n");

  test("resolve funil/estágio por nome, cai no padrão e vincula o contato", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const jobId = await startJob(asAdmin, s, "leads", LEADS_CSV, "skip", "leads.csv");
    const detected = await getJob(t, jobId);
    // Cabeçalho acentuado sobrevive: a chave do record vai codificada.
    expect(detected?.detectedHeaders).toContain("Título");
    expect(detected?.suggestedMapping?.[k("Título")]).toBe("title");
    expect(detected?.suggestedMapping?.[k("Funil")]).toBe("boardName");
    expect(detected?.suggestedMapping?.[k("Estágio")]).toBe("stageName");
    expect(detected?.suggestedMapping?.[k("Responsável")]).toBe("assigneeEmail");
    expect(detected?.suggestedMapping?.[k("E-mail do contato")]).toBe("contactEmail");

    await preview(asAdmin, s.organizationId, jobId);
    expect((await getJob(t, jobId))?.dryRun).toMatchObject({
      totalRows: 2, validRows: 2, errorRows: 0, newRows: 2,
    });

    await execute(asAdmin, s.organizationId, jobId);
    expect((await getJob(t, jobId))?.status).toBe("completed");

    const leads = await leadsOf(t, s.organizationId);
    expect(leads.length).toBe(2);

    const alfa = leads.find((l) => l.title === "Projeto Alfa")!;
    expect(alfa.boardId).toBe(s.parceriasId);
    expect(alfa.stageId).toBe(s.prospeccao);
    expect(alfa.value).toBe(1500.5);
    expect(alfa.currency).toBe("BRL");
    expect(alfa.priority).toBe("high");
    expect(alfa.assignedTo).toBe(s.ana.memberId);
    expect(alfa.customFields).toEqual({});

    // Fallback: funil/estágio inexistentes caem no board padrão + 1º estágio
    const beta = leads.find((l) => l.title === "Projeto Beta")!;
    expect(beta.boardId).toBe(s.boardId);
    expect(beta.stageId).toBe(s.novo);
    expect(beta.assignedTo).toBeUndefined();

    const contacts = await contactsOf(t, s.organizationId);
    expect(contacts.length).toBe(2);
    const cliente = contacts.find((c) => c.email === "cliente@exemplo.com")!;
    expect(cliente.firstName).toBe("Cliente Um");
    expect(alfa.contactId).toBe(cliente._id);
  });

  test("reaproveita contato existente em vez de duplicar", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const existingId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("contacts", {
        organizationId: s.organizationId,
        firstName: "Cliente",
        email: "cliente@exemplo.com",
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
    });

    const jobId = await startJob(asAdmin, s, "leads", LEADS_CSV, "skip", "leads.csv");
    await preview(asAdmin, s.organizationId, jobId);
    await execute(asAdmin, s.organizationId, jobId);

    const leads = await leadsOf(t, s.organizationId);
    const alfa = leads.find((l) => l.title === "Projeto Alfa")!;
    expect(alfa.contactId).toBe(existingId);
    expect((await contactsOf(t, s.organizationId)).length).toBe(2); // o existente + o novo
  });
});

// ===== Rollback =====

describe("rollback", () => {
  test("apaga os criados e reverte os atualizados (inclusive campo que não existia)", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const brunoId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("contacts", {
        organizationId: s.organizationId,
        firstName: "Bruno",
        email: "bruno@exemplo.com",
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
    });

    const csv = [
      "Nome,E-mail,Empresa",
      "Bruno Alves,bruno@exemplo.com,Empresa Nova",
      "Carla,carla@exemplo.com,Carla ME",
    ].join("\n");

    const jobId = await startJob(asAdmin, s, "contacts", csv, "update");
    await preview(asAdmin, s.organizationId, jobId);
    await execute(asAdmin, s.organizationId, jobId);
    expect((await getJob(t, jobId))?.progress).toMatchObject({ created: 1, updated: 1 });
    expect((await contactsOf(t, s.organizationId)).length).toBe(2);

    await rollback(asAdmin, s.organizationId, jobId);

    const job = await getJob(t, jobId);
    expect(job?.status).toBe("rolled_back");

    const contacts = await contactsOf(t, s.organizationId);
    expect(contacts.length).toBe(1);
    const bruno = await t.run(async (ctx) => await ctx.db.get(brunoId));
    expect(bruno?.firstName).toBe("Bruno");
    // Campo que não existia antes é REMOVIDO no rollback (sentinela null).
    expect(bruno?.company).toBeUndefined();

    const audits = await t.run(async (ctx) =>
      await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "importJob").eq("entityId", jobId))
        .collect()
    );
    expect(audits.some((a) => (a.description ?? "").startsWith("Desfez"))).toBe(true);
  });

  test("rollback de leads apaga leads e contatos criados", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const csv = [
      "Título,E-mail do contato,Nome do contato",
      "Negócio Um,um@exemplo.com,Um",
    ].join("\n");

    const jobId = await startJob(asAdmin, s, "leads", csv, "skip", "leads.csv");
    await preview(asAdmin, s.organizationId, jobId);
    await execute(asAdmin, s.organizationId, jobId);
    expect((await leadsOf(t, s.organizationId)).length).toBe(1);

    await rollback(asAdmin, s.organizationId, jobId);
    expect((await leadsOf(t, s.organizationId)).length).toBe(0);
    expect((await contactsOf(t, s.organizationId)).length).toBe(0);
  });

  test("só desfaz importação concluída", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const jobId = await startJob(asAdmin, s, "contacts", CONTACTS_CSV);

    await expect(
      asAdmin.mutation(api.imports.rollbackImport, { organizationId: s.organizationId, jobId })
    ).rejects.toThrow(/importações concluídas/);
  });
});

// ===== Limites, concorrência e RBAC =====

describe("limites, concorrência e RBAC", () => {
  test("arquivo acima de 10.000 linhas falha com erro amigável", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });

    const lines = ["Nome,E-mail"];
    for (let i = 0; i < 11_000; i++) lines.push(`Pessoa ${i},pessoa${i}@exemplo.com`);
    const jobId = await startJob(asAdmin, s, "contacts", lines.join("\n"), "skip", "grande.csv");

    const job = await getJob(t, jobId);
    expect(job?.status).toBe("failed");
    expect(job?.error).toMatch(/limite por importação é 10\.000/);
  });

  test("recusa uma segunda importação ativa e libera após o cancelamento", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const jobId = await startJob(asAdmin, s, "contacts", CONTACTS_CSV);

    const outroArquivo = await seedCsv(t, s.organizationId, s.admin.memberId, CONTACTS_CSV);
    await expect(
      asAdmin.mutation(api.imports.createImportJob, {
        organizationId: s.organizationId,
        entity: "contacts",
        fileId: outroArquivo,
        fileName: "outro.csv",
        duplicateStrategy: "skip",
      })
    ).rejects.toThrow(/já existe uma importação em andamento/i);

    await asAdmin.mutation(api.imports.cancelImport, { organizationId: s.organizationId, jobId });
    expect((await getJob(t, jobId))?.status).toBe("canceled");

    const segundoId = await asAdmin.mutation(api.imports.createImportJob, {
      organizationId: s.organizationId,
      entity: "contacts",
      fileId: outroArquivo,
      fileName: "outro.csv",
      duplicateStrategy: "skip",
    });
    expect(segundoId).toBeTruthy();
  });

  test("recusa arquivo que não é CSV", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const fileId = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["{}"], { type: "application/json" }));
      return await ctx.db.insert("files", {
        organizationId: s.organizationId,
        storageId,
        name: "dados.json",
        mimeType: "application/json",
        size: 2,
        fileType: "import_file",
        createdAt: Date.now(),
      });
    });

    await expect(
      asAdmin.mutation(api.imports.createImportJob, {
        organizationId: s.organizationId,
        entity: "contacts",
        fileId,
        fileName: "dados.json",
        duplicateStrategy: "skip",
      })
    ).rejects.toThrow(/precisa ser um CSV/);
  });

  test("membro agent não cria nem lista importações", async () => {
    const s = await seedOrg(t);
    const asAgent = t.withIdentity({ subject: `${s.ana.userId}|s1` });
    const fileId = await seedCsv(t, s.organizationId, s.ana.memberId, CONTACTS_CSV);

    await expect(
      asAgent.mutation(api.imports.createImportJob, {
        organizationId: s.organizationId,
        entity: "contacts",
        fileId,
        fileName: "dados.csv",
        duplicateStrategy: "skip",
      })
    ).rejects.toThrow(/Permissão insuficiente/);

    await expect(
      asAgent.query(api.imports.getImportJobs, { organizationId: s.organizationId })
    ).rejects.toThrow(/Permissão insuficiente/);
  });

  test("job de outra organização responde Not authorized", async () => {
    const a = await seedOrg(t);
    const outraOrg = await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Outra",
        slug: "outra-org",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId, name: "Chefe", email: "chefe@outra.com",
        role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
      });
      return { organizationId, userId, memberId };
    });

    const asOutroAdmin = t.withIdentity({ subject: `${outraOrg.userId}|s1` });
    const jobId = await startJob(
      asOutroAdmin,
      { organizationId: outraOrg.organizationId, admin: { memberId: outraOrg.memberId } },
      "contacts",
      CONTACTS_CSV
    );

    const asAdminA = t.withIdentity({ subject: `${a.admin.userId}|s1` });
    await expect(
      asAdminA.query(api.imports.getImportJob, { organizationId: a.organizationId, jobId })
    ).rejects.toThrow(/Not authorized/);
    await expect(
      asAdminA.mutation(api.imports.cancelImport, { organizationId: a.organizationId, jobId })
    ).rejects.toThrow(/Not authorized/);
  });

  test("confirmImport exige dry-run pronto", async () => {
    const s = await seedOrg(t);
    const asAdmin = t.withIdentity({ subject: `${s.admin.userId}|s1` });
    const jobId = await startJob(asAdmin, s, "contacts", CONTACTS_CSV);

    await expect(
      asAdmin.mutation(api.imports.confirmImport, { organizationId: s.organizationId, jobId })
    ).rejects.toThrow(/pré-visualização/);
  });
});
