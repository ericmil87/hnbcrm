/// <reference types="vite/client" />
/**
 * PR6 "Importar contatos do celular (VCF)": dedupe por telefone (variantes do
 * 9º dígito) e e-mail, tipo pela porta única, nenhum lead por padrão, "criar
 * lead no funil" no funil do atendente, rollback pela trilha do import, RBAC e
 * nada de webhook por contato.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { normalizeRowEmails, normalizeRowPhones, relationForChoice } from "./phoneContactsImport";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function seed(t: TestConvex<typeof schema>, opts?: { webhook?: boolean }) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Celular",
      slug: "org-celular",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Eva Moreira",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const viewerUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: viewerUserId,
      name: "Vera Leitura",
      role: "agent",
      type: "human",
      status: "active",
      permissions: {
        leads: "edit_own",
        contacts: "view",
        inbox: "reply",
        tasks: "edit_own",
        reports: "view",
        team: "none",
        settings: "none",
        auditLogs: "none",
        apiKeys: "none",
        campaigns: "view",
      },
      createdAt: now,
      updatedAt: now,
    });
    const aiUserId = await ctx.db.insert("users", {});
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Vendas",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    const attendantBoardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Atendimento",
      color: "#22c55e",
      isDefault: false,
      order: 1,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId,
      boardId: attendantBoardId,
      name: "Triagem",
      color: "#22c55e",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    const attendantStageId = await ctx.db.insert("stages", {
      organizationId,
      boardId: attendantBoardId,
      name: "Primeiro contato",
      color: "#22c55e",
      order: 1,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: aiUserId,
      name: "Ana (IA)",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: {
        kind: "attendant",
        mode: "suggest",
        pipelineConfig: { boardId: attendantBoardId, initialStageId: attendantStageId },
      },
      createdAt: now,
      updatedAt: now,
    });
    // Gravado SEM o 9º dígito (como o WhatsApp devolve celulares antigos).
    const oldPhoneContactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "~ Ju",
      phone: "558199887766",
      tags: ["vip"],
      createdAt: now,
      updatedAt: now,
    });
    const oldLeadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Ju",
      contactId: oldPhoneContactId,
      boardId,
      stageId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "warm",
      tags: [],
      customFields: {},
      conversationStatus: "active",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const emailContactId = await ctx.db.insert("contacts", {
      organizationId,
      email: "fornecedor@exemplo.com",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    if (opts?.webhook) {
      await ctx.db.insert("webhooks", {
        organizationId,
        name: "Assinante",
        url: "https://example.test/hook",
        events: ["*"],
        secret: "segredo-de-teste",
        isActive: true,
        createdAt: now,
      });
    }
    return {
      organizationId,
      adminUserId,
      adminId,
      viewerUserId,
      aiUserId,
      boardId,
      stageId,
      attendantBoardId,
      attendantStageId,
      oldPhoneContactId,
      oldLeadId,
      emailContactId,
    };
  });
}

const as = (t: TestConvex<typeof schema>, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

type Row = {
  firstName?: string;
  lastName?: string;
  phones: string[];
  emails: string[];
  company?: string;
  choice: "lead" | "personal" | "team" | "supplier" | "partner";
};

const ROWS: Row[] = [
  { firstName: "Carlos", lastName: "Souza", phones: ["(81) 98888-7777"], emails: [], choice: "lead" as const },
  { firstName: "Juliana", lastName: "Mãe", phones: ["+55 81 99988-7766"], emails: [], choice: "personal" as const },
  { firstName: "Distribuidora", phones: [], emails: ["Fornecedor@Exemplo.com"], company: "Distribuidora X", choice: "supplier" as const },
  { firstName: "Tio", lastName: "Zé", phones: ["81 3222-1111"], emails: [], choice: "personal" as const },
];

async function startAndRun(
  t: TestConvex<typeof schema>,
  s: Awaited<ReturnType<typeof seed>>,
  args?: { createLeads?: boolean; useAgendaNames?: boolean; rows?: Row[] },
) {
  const jobId = await as(t, s.adminUserId).mutation(api.phoneContactsImport.startPhoneContactsImport, {
    organizationId: s.organizationId,
    fileName: "contatos.vcf",
    createLeads: args?.createLeads ?? false,
    useAgendaNames: args?.useAgendaNames,
    rows: args?.rows ?? ROWS,
  });
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return jobId;
}

describe("helpers puros", () => {
  test("telefones re-normalizados com o DDI da org, sem repetição e com teto", () => {
    expect(normalizeRowPhones(["(81) 98888-7777", "5581988887777", "123"], "55")).toEqual(["5581988887777"]);
    expect(normalizeRowPhones(["+1 212 555 1234"], "55")).toEqual(["12125551234"]);
    expect(normalizeRowPhones(Array.from({ length: 9 }, (_, i) => `8198888770${i}`), "55")).toHaveLength(5);
  });
  test("e-mails em minúsculas, inválidos fora", () => {
    expect(normalizeRowEmails(["A@B.com", "a@b.com", "sem-arroba"])).toEqual(["a@b.com"]);
  });
  test("Lead vira cliente confirmado; os outros tipos passam direto", () => {
    expect(relationForChoice("lead")).toBe("customer");
    expect(relationForChoice("team")).toBe("team");
  });
});

describe("importação do celular", () => {
  test("cria/completa contatos, aplica o tipo e NÃO cria lead por padrão", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const jobId = await startAndRun(t, s);

    const state = await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const contacts = await ctx.db
        .query("contacts")
        .withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId))
        .collect();
      const leads = await ctx.db.query("leads").collect();
      const staged = await ctx.db.query("importStagedRows").collect();
      const batches = await ctx.db.query("importJobBatches").collect();
      return { job, contacts, leads, staged, batches };
    });

    expect(state.job?.status).toBe("completed");
    expect(state.job?.progress).toMatchObject({ processed: 4, total: 4, created: 2, updated: 2, failed: 0 });
    expect(state.staged).toHaveLength(0);
    expect(state.batches).toHaveLength(1);
    // 2 existentes + 2 novos (Carlos e Tio Zé); Juliana casou pela variante do 9º dígito.
    expect(state.contacts).toHaveLength(4);
    expect(state.leads).toHaveLength(1); // só o lead que já existia

    const carlos = state.contacts.find((c) => c.firstName === "Carlos")!;
    expect(carlos.phone).toBe("5581988887777");
    expect(carlos.relation).toBe("customer");
    expect(carlos.relationMeta?.source).toBe("import");
    expect(carlos.tags).toEqual(["importado-celular"]);
    expect(carlos.whatsappNumber).toBeUndefined();

    const ju = state.contacts.find((c) => c._id === s.oldPhoneContactId)!;
    expect(ju.relation).toBe("personal");
    expect(ju.phone).toBe("558199887766"); // telefone gravado nunca é reescrito
    expect(ju.firstName).toBe("~ Ju"); // nome existente fica (sem useAgendaNames)
    expect(ju.tags).toEqual(["vip", "importado-celular"]);
    // Porta única: virou Pessoal → lead aberto arquivado.
    expect(state.leads[0].archivedAt).toBeDefined();

    const supplier = state.contacts.find((c) => c._id === s.emailContactId)!;
    expect(supplier.relation).toBe("supplier");
    expect(supplier.company).toBe("Distribuidora X");
    expect(supplier.firstName).toBe("Distribuidora");

    const tio = state.contacts.find((c) => c.firstName === "Tio")!;
    expect(tio.phone).toBe("558132221111");
    expect(tio.relation).toBe("personal");
  });

  test("useAgendaNames troca o nome do contato existente", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await startAndRun(t, s, { useAgendaNames: true, rows: [ROWS[1]] });
    const ju = await t.run(async (ctx) => await ctx.db.get(s.oldPhoneContactId));
    expect(ju?.firstName).toBe("Juliana");
    expect(ju?.lastName).toBe("Mãe");
  });

  test("criar lead no funil: lead no funil do atendente, etapa inicial, só para Lead sem lead", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await startAndRun(t, s, { createLeads: true });
    const leads = await t.run(async (ctx) => await ctx.db.query("leads").collect());
    expect(leads).toHaveLength(2);
    const created = leads.find((l) => l._id !== s.oldLeadId)!;
    expect(created.title).toBe("Carlos Souza");
    expect(created.boardId).toBe(s.attendantBoardId);
    expect(created.stageId).toBe(s.attendantStageId);
    expect(created.archivedAt).toBeUndefined();
  });

  test("linhas repetidas no mesmo envio viram um contato só", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const dup: Row = { firstName: "Bia", phones: ["81 97777-6666"], emails: [], choice: "lead" };
    await startAndRun(t, s, { rows: [dup, { ...dup, phones: ["(81) 7777-6666"] }] });
    const bias = await t.run(async (ctx) =>
      (await ctx.db.query("contacts").collect()).filter((c) => c.firstName === "Bia"),
    );
    expect(bias).toHaveLength(1);
  });

  test("Desfazer apaga os criados e devolve tipo, etiquetas e lead dos existentes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const jobId = await startAndRun(t, s, { createLeads: true });
    await as(t, s.adminUserId).mutation(api.phoneContactsImport.undoPhoneContactsImport, {
      organizationId: s.organizationId,
      jobId,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      contacts: await ctx.db.query("contacts").collect(),
      leads: await ctx.db.query("leads").collect(),
    }));
    expect(state.job?.status).toBe("rolled_back");
    expect(state.contacts).toHaveLength(2);
    const ju = state.contacts.find((c) => c._id === s.oldPhoneContactId)!;
    expect(ju.relation).toBeUndefined();
    expect(ju.tags).toEqual(["vip"]);
    const supplier = state.contacts.find((c) => c._id === s.emailContactId)!;
    expect(supplier.relation).toBeUndefined();
    expect(supplier.company).toBeUndefined();
    expect(state.leads).toHaveLength(1);
    expect(state.leads[0].archivedAt).toBeUndefined();
  });

  test("sem webhook por contato: só a fila do próximo lote é agendada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { webhook: true });
    const jobId = await as(t, s.adminUserId).mutation(api.phoneContactsImport.startPhoneContactsImport, {
      organizationId: s.organizationId,
      fileName: "contatos.vcf",
      createLeads: false,
      rows: ROWS,
    });
    // Cancela o lote agendado e roda o mesmo lote à mão, para inspecionar o que ele agenda.
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    await t.mutation(internal.phoneContactsImport.internalProcessPhoneChunk, { jobId, chunkIndex: 0 });
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((j) => j.state.kind === "pending"),
    );
    const events = pending
      .filter((j) => j.name.includes("triggerWebhooks"))
      .map((j) => (j.args[0] as { event: string }).event);
    // O lead aberto arquivado pela porta única avisa o seu evento; contato nenhum emite.
    expect(events.filter((e) => e.startsWith("contact."))).toEqual([]);
    expect(pending.some((j) => j.name.includes("internalProcessPhoneChunk"))).toBe(true);
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    await t.finishInProgressScheduledFunctions();
  });

  test("uma importação por vez", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const admin = as(t, s.adminUserId);
    await admin.mutation(api.phoneContactsImport.startPhoneContactsImport, {
      organizationId: s.organizationId,
      fileName: "a.vcf",
      createLeads: false,
      rows: [ROWS[0]],
    });
    await expect(
      admin.mutation(api.phoneContactsImport.startPhoneContactsImport, {
        organizationId: s.organizationId,
        fileName: "b.vcf",
        createLeads: false,
        rows: [ROWS[3]],
      }),
    ).rejects.toThrow(/em andamento/);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});

describe("triagem: quem já está no CRM", () => {
  test("acha pela variante do 9º dígito e pelo e-mail, com o tipo atual", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.emailContactId, { relation: "supplier" });
    });
    const out = await as(t, s.adminUserId).query(api.phoneContactsImport.matchPhoneContacts, {
      organizationId: s.organizationId,
      rows: [
        { key: "a", phones: ["(81) 99988-7766"], emails: [] },
        { key: "b", phones: [], emails: ["FORNECEDOR@exemplo.com"] },
        { key: "c", phones: ["81 91234-5678"], emails: [] },
      ],
    });
    expect(out).toEqual([
      { key: "a", contactId: s.oldPhoneContactId, name: "~ Ju", relation: null },
      { key: "b", contactId: s.emailContactId, name: null, relation: "supplier" },
    ]);
  });

  test("contexto: DDI da org e sobrenomes de quem importa e do dono", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ctx = await as(t, s.adminUserId).query(api.phoneContactsImport.getPhoneImportContext, {
      organizationId: s.organizationId,
    });
    expect(ctx).toEqual({ defaultCountry: "55", surnames: ["Moreira"] });
  });
});

describe("RBAC", () => {
  test("sem contacts:edit não importa nem consulta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const viewer = as(t, s.viewerUserId);
    await expect(
      viewer.mutation(api.phoneContactsImport.startPhoneContactsImport, {
        organizationId: s.organizationId,
        fileName: "contatos.vcf",
        createLeads: false,
        rows: [ROWS[0]],
      }),
    ).rejects.toThrow();
    await expect(
      viewer.query(api.phoneContactsImport.matchPhoneContacts, {
        organizationId: s.organizationId,
        rows: [{ key: "a", phones: ["81988887777"], emails: [] }],
      }),
    ).rejects.toThrow();
    expect(
      await viewer.query(api.phoneContactsImport.getPhoneImportContext, { organizationId: s.organizationId }),
    ).toBeNull();
  });

  test("membro IA não importa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      as(t, s.aiUserId).mutation(api.phoneContactsImport.startPhoneContactsImport, {
        organizationId: s.organizationId,
        fileName: "contatos.vcf",
        createLeads: false,
        rows: [ROWS[0]],
      }),
    ).rejects.toThrow(/Só uma pessoa da equipe/);
  });

  test("Desfazer só vale para importação do celular da própria org", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const csvJobId = await t.run(async (ctx) =>
      ctx.db.insert("importJobs", {
        organizationId: s.organizationId,
        requestedBy: s.adminId,
        status: "completed",
        entity: "contacts",
        fileName: "planilha.csv",
        duplicateStrategy: "skip",
        progress: { processed: 0, total: 0, created: 0, updated: 0, skipped: 0, failed: 0 },
        createdAt: Date.now(),
      }),
    );
    await expect(
      as(t, s.adminUserId).mutation(api.phoneContactsImport.undoPhoneContactsImport, {
        organizationId: s.organizationId,
        jobId: csvJobId,
      }),
    ).rejects.toThrow(/não encontrada/);
  });
});
