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
import { NO_LEAD_POWER_ROW_ERROR, normalizeRowEmails, normalizeRowPhones, relationForChoice } from "./phoneContactsImport";
import { STALE_IMPORT_MS } from "./lib/importJobOps";

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
    // Papel padrão de agente: contacts:edit, leads:edit_own.
    const agentUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: agentUserId,
      name: "Ana Agente",
      role: "agent",
      type: "human",
      status: "active",
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
      agentUserId,
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
      { key: "a", contactId: s.oldPhoneContactId, name: "~ Ju", relation: null, hasOpenLead: true },
      { key: "b", contactId: s.emailContactId, name: null, relation: "supplier", hasOpenLead: false },
    ]);
  });

  test("contexto: DDI da org e sobrenomes de quem importa e do dono", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ctx = await as(t, s.adminUserId).query(api.phoneContactsImport.getPhoneImportContext, {
      organizationId: s.organizationId,
    });
    expect(ctx).toEqual({ defaultCountry: "55", surnames: ["Moreira"], canChangeLeads: true });
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

describe("RBAC de lead (papel padrão de agente)", () => {
  test("agente não liga Criar lead no funil", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(
      as(t, s.agentUserId).mutation(api.phoneContactsImport.startPhoneContactsImport, {
        organizationId: s.organizationId,
        fileName: "contatos.vcf",
        createLeads: true,
        rows: [ROWS[0]],
      }),
    ).rejects.toThrow(/editar todos os leads/);
  });

  test("agente completa o contato com lead aberto, mas não muda o tipo; contato sem lead muda", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ctxOut = await as(t, s.agentUserId).query(api.phoneContactsImport.getPhoneImportContext, {
      organizationId: s.organizationId,
    });
    expect(ctxOut?.canChangeLeads).toBe(false);
    const jobId = await as(t, s.agentUserId).mutation(api.phoneContactsImport.startPhoneContactsImport, {
      organizationId: s.organizationId,
      fileName: "contatos.vcf",
      createLeads: false,
      rows: [ROWS[1], ROWS[2]],
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      ju: await ctx.db.get(s.oldPhoneContactId),
      supplier: await ctx.db.get(s.emailContactId),
      lead: await ctx.db.get(s.oldLeadId),
      batch: (await ctx.db.query("importJobBatches").collect())[0],
    }));
    expect(state.ju?.relation).toBeUndefined();
    expect(state.ju?.tags).toContain("importado-celular");
    expect(state.lead?.archivedAt).toBeUndefined();
    expect(state.supplier?.relation).toBe("supplier");
    expect(state.batch.errors).toEqual([{ row: 1, message: NO_LEAD_POWER_ROW_ERROR }]);
    expect(state.job?.status).toBe("completed");
  });

  test("contexto e match dizem quem tem lead aberto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const out = await as(t, s.adminUserId).query(api.phoneContactsImport.matchPhoneContacts, {
      organizationId: s.organizationId,
      rows: [{ key: "a", phones: ["81999887766"], emails: [] }],
    });
    expect(out[0].hasOpenLead).toBe(true);
  });
});

describe("lotes, travas e desfazer", () => {
  test("mais de um lote: 60 linhas em 3 lotes de 25", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({
      firstName: `Contato ${i}`,
      phones: [`8198${String(i).padStart(7, "0")}`],
      emails: [],
      choice: i % 2 ? "lead" : "personal",
    }));
    const jobId = await startAndRun(t, s, { rows });
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      batches: await ctx.db.query("importJobBatches").collect(),
      staged: await ctx.db.query("importStagedRows").collect(),
    }));
    expect(state.job?.status).toBe("completed");
    expect(state.job?.progress).toMatchObject({ processed: 60, created: 60, failed: 0 });
    expect(state.job?.heartbeatAt).toBeDefined();
    expect(state.batches.map((b) => b.batchIndex).sort()).toEqual([0, 1, 2]);
    expect(state.staged).toHaveLength(0);
  });

  test("job travado é encerrado no próximo início (fila apagada) e pode ser desfeito", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const stuckId = await t.run(async (ctx) => {
      const old = Date.now() - STALE_IMPORT_MS - 60_000;
      const id = await ctx.db.insert("importJobs", {
        organizationId: s.organizationId,
        requestedBy: s.adminId,
        status: "running",
        entity: "contacts",
        source: "phone_vcf",
        fileName: "velho.vcf",
        duplicateStrategy: "update",
        progress: { processed: 25, total: 50, created: 0, updated: 0, skipped: 0, failed: 0 },
        createdAt: old,
        startedAt: old,
        heartbeatAt: old,
      });
      await ctx.db.insert("importStagedRows", {
        organizationId: s.organizationId,
        jobId: id,
        chunkIndex: 1,
        rows: [{ row: 26, phones: ["81988880000"], emails: [], choice: "lead" }],
        createdAt: old,
      });
      return id;
    });
    await startAndRun(t, s, { rows: [ROWS[0]] });
    const stuck = await t.run(async (ctx) => ({
      job: await ctx.db.get(stuckId),
      staged: await ctx.db.query("importStagedRows").collect(),
    }));
    expect(stuck.job?.status).toBe("failed");
    expect(stuck.job?.error).toMatch(/parou de responder/);
    expect(stuck.staged).toHaveLength(0);
    // `failed` depois de começar pode ser desfeito.
    await as(t, s.adminUserId).mutation(api.phoneContactsImport.undoPhoneContactsImport, {
      organizationId: s.organizationId,
      jobId: stuckId,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run(async (ctx) => ctx.db.get(stuckId)))?.status).toBe("rolled_back");
  });

  test("admin cancela job travado; job em andamento recente não", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const make = (beat: number) =>
      t.run(async (ctx) =>
        ctx.db.insert("importJobs", {
          organizationId: s.organizationId,
          requestedBy: s.adminId,
          status: "running",
          entity: "contacts",
          source: "phone_vcf",
          fileName: "x.vcf",
          duplicateStrategy: "update",
          progress: { processed: 0, total: 1, created: 0, updated: 0, skipped: 0, failed: 0 },
          createdAt: beat,
          startedAt: beat,
          heartbeatAt: beat,
        }),
      );
    const fresh = await make(Date.now());
    await expect(
      as(t, s.adminUserId).mutation(api.imports.cancelImport, { organizationId: s.organizationId, jobId: fresh }),
    ).rejects.toThrow(/15 minutos/);
    await t.run(async (ctx) => ctx.db.patch(fresh, { status: "completed" }));
    const stuck = await make(Date.now() - STALE_IMPORT_MS - 1);
    await as(t, s.adminUserId).mutation(api.imports.cancelImport, { organizationId: s.organizationId, jobId: stuck });
    expect((await t.run(async (ctx) => ctx.db.get(stuck)))?.status).toBe("failed");
  });

  test("lote de job encerrado apaga a fila restante", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const jobId = await as(t, s.adminUserId).mutation(api.phoneContactsImport.startPhoneContactsImport, {
      organizationId: s.organizationId,
      fileName: "contatos.vcf",
      createLeads: false,
      rows: Array.from({ length: 30 }, (_, i): Row => ({ phones: [`8197${String(i).padStart(7, "0")}`], emails: [], choice: "lead" })),
    });
    await t.run(async (ctx) => ctx.db.patch(jobId, { status: "failed" }));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const left = await t.run(async (ctx) => ({
      staged: await ctx.db.query("importStagedRows").collect(),
      contacts: (await ctx.db.query("contacts").collect()).length,
    }));
    expect(left.staged).toHaveLength(0);
    expect(left.contacts).toBe(2); // só os do seed
  });

  test("Desfazer não roda duas vezes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const jobId = await startAndRun(t, s, { rows: [ROWS[0]] });
    const admin = as(t, s.adminUserId);
    await admin.mutation(api.phoneContactsImport.undoPhoneContactsImport, { organizationId: s.organizationId, jobId });
    expect((await t.run(async (ctx) => ctx.db.get(jobId)))?.status).toBe("rolling_back");
    await expect(
      admin.mutation(api.phoneContactsImport.undoPhoneContactsImport, { organizationId: s.organizationId, jobId }),
    ).rejects.toThrow(/já está sendo desfeita/);
    await expect(
      admin.mutation(api.imports.rollbackImport, { organizationId: s.organizationId, jobId }),
    ).rejects.toThrow(/já está sendo desfeita/);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await t.run(async (ctx) => ctx.db.get(jobId)))?.status).toBe("rolled_back");
  });

  test("Desfazer apaga o lead criado pela porta de exclusão, com conversa e mensagens", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const jobId = await startAndRun(t, s, { createLeads: true, rows: [ROWS[0]] });
    const conversationId = await t.run(async (ctx) => {
      const lead = (await ctx.db.query("leads").collect()).find((l) => l._id !== s.oldLeadId)!;
      const id = await ctx.db.insert("conversations", {
        organizationId: s.organizationId,
        leadId: lead._id,
        channel: "whatsapp",
        status: "active",
        messageCount: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId: id,
        direction: "inbound",
        senderType: "contact",
        content: "Oi",
        contentType: "text",
        isInternal: false,
        createdAt: Date.now(),
      } as never);
      return id;
    });
    await as(t, s.adminUserId).mutation(api.phoneContactsImport.undoPhoneContactsImport, {
      organizationId: s.organizationId,
      jobId,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => ({
      leads: await ctx.db.query("leads").collect(),
      conversation: await ctx.db.get(conversationId),
      messages: await ctx.db.query("messages").collect(),
      audits: (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityType === "lead" && a.action === "delete"),
    }));
    expect(state.leads.map((l) => l._id)).toEqual([s.oldLeadId]);
    expect(state.conversation).toBeNull();
    expect(state.messages).toHaveLength(0);
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0].description).toMatch(/ao desfazer a importação/);
  });
});

describe("CSV: desfazer com Tipo de contato", () => {
  async function csvJob(t: TestConvex<typeof schema>, s: Awaited<ReturnType<typeof seed>>, entity: "contacts" | "leads", mapping: Record<string, string>) {
    return await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(new Blob(["x"]));
      const fileId = await ctx.db.insert("files", {
        organizationId: s.organizationId,
        name: "planilha.csv",
        mimeType: "text/csv",
        size: 10,
        storageId,
        fileType: "import_file",
        uploadedBy: s.adminId,
        createdAt: Date.now(),
      } as never);
      return await ctx.db.insert("importJobs", {
        fileId,
        organizationId: s.organizationId,
        entity,
        status: "running",
        fileName: "planilha.csv",
        mapping,
        duplicateStrategy: "update",
        requestedBy: s.adminId,
        progress: { processed: 0, created: 0, updated: 0, skipped: 0, failed: 0, total: 1 },
        createdAt: Date.now(),
      } as never);
    });
  }

  test("voltar contato sem lead para sem tipo não cria lead", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const jobId = await csvJob(t, s, "contacts", { email: "email", tipo: "relation" });
    await t.mutation(internal.imports.internalProcessBatch, {
      jobId,
      batchIndex: 0,
      headers: ["email", "tipo"],
      rows: [{ row: 1, cells: ["fornecedor@exemplo.com", "Fornecedor"] }],
    });
    const batch = await t.run(async (ctx) => (await ctx.db.query("importJobBatches").collect())[0]);
    expect(batch.updated[0].before).toMatchObject({ relation: null, relationRestoreLeadIds: [] });
    await t.mutation(internal.imports.internalRollbackBatch, { jobId, batchId: batch._id });
    const after = await t.run(async (ctx) => ({
      contact: await ctx.db.get(s.emailContactId),
      leads: await ctx.db.query("leads").withIndex("by_contact", (q) => q.eq("contactId", s.emailContactId)).collect(),
    }));
    expect(after.contact?.relation).toBeUndefined();
    expect(after.contact).not.toHaveProperty("relationRestoreLeadIds");
    expect(after.leads).toHaveLength(0);
  });

  test("lead importado por CSV sai pela porta de exclusão no desfazer", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const jobId = await csvJob(t, s, "leads", { titulo: "title", telefone: "contactPhone" });
    await t.mutation(internal.imports.internalProcessBatch, {
      jobId,
      batchIndex: 0,
      headers: ["titulo", "telefone"],
      rows: [{ row: 1, cells: ["Negócio novo", "5581911112222"] }],
    });
    await t.run(async (ctx) => ctx.db.patch(jobId, { status: "rolling_back" }));
    await t.action(internal.importRun.internalRunRollback, { jobId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      leads: (await ctx.db.query("leads").collect()).map((l) => l.title),
      audits: (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityType === "lead" && a.action === "delete"),
    }));
    expect(state.job?.status).toBe("rolled_back");
    expect(state.leads).toEqual(["Ju"]);
    expect(state.audits).toHaveLength(1);
  });
});
