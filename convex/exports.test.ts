/// <reference types="vite/client" />
/**
 * Export de dados (F1 CSV por entidade + F2 backup completo JSON).
 *
 * A action `internalRunExport` é chamada DIRETO nos testes (o job também se
 * auto-agenda em `createExportJob`; o agendamento pendente é cancelado no
 * afterEach e, se rodasse, viraria no-op porque `internalStartJob` só aceita
 * job `queued`).
 */
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { parseCsv } from "./lib/csv";
import { BACKUP_TABLES } from "./exports";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

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
      name: "Org Export",
      slug: "org-export",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });

    const mk = async (name: string, email: string, role: "admin" | "agent") => {
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

    const admin = await mk("Admin", "admin@acme.test", "admin");
    const ana = await mk("Ana", "ana@acme.test", "agent");

    return { organizationId, admin, ana };
  });
}

function asAdmin(t: TestConvex<typeof schema>, userId: Id<"users">) {
  return t.withIdentity({ subject: `${userId}|s1` });
}

async function seedContacts(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("fieldDefinitions", {
      organizationId,
      name: "Setor",
      key: "setor",
      type: "text",
      entityType: "contact",
      isRequired: false,
      order: 0,
      createdAt: now,
    });

    const jose = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "José",
      lastName: "Antônio",
      email: "jose@exemplo.com",
      phone: "5511999990001",
      company: 'Padaria "do Zé", Ltda',
      tags: ["vip", "teste"],
      customFields: { setor: "Educação" },
      createdAt: now,
      updatedAt: now,
    });
    const maria = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Maria",
      email: "maria@exemplo.com",
      tags: [],
      createdAt: now + 1,
      updatedAt: now + 1,
    });

    return { jose, maria };
  });
}

/**
 * Roda o job até o fim e devolve o doc atualizado + o conteúdo do blob.
 * A action é chamada direto; se o agendamento de `createExportJob` tiver
 * disparado antes (timer real do convex-test), a chamada direta vira no-op e o
 * laço espera o agendado terminar — só uma execução acontece nos dois casos.
 */
async function runJob(t: TestConvex<typeof schema>, jobId: Id<"exportJobs">) {
  await t.action(internal.exports.internalRunExport, { jobId });

  for (let attempt = 0; attempt < 50; attempt++) {
    await t.finishInProgressScheduledFunctions();
    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    if (job && (job.status === "completed" || job.status === "failed")) {
      const content = await t.run(async (ctx) => {
        if (!job.resultStorageId) return null;
        const blob = await ctx.storage.get(job.resultStorageId);
        return blob ? await blob.text() : null;
      });
      return { job, content };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error("O job de export não finalizou");
}

// ===== CSV por entidade =====

describe("export CSV por entidade", () => {
  test("exporta contatos ponta a ponta com BOM, acentos e custom fields", async () => {
    const s = await seedOrg(t);
    await seedContacts(t, s.organizationId);
    const admin = asAdmin(t, s.admin.userId);

    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "contacts",
    });

    const { job, content } = await runJob(t, jobId);

    expect(job.status).toBe("completed");
    expect(job.rowCount).toBe(2);
    expect(job.resultFileName).toMatch(/^hnbcrm-contatos-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(job.resultSize).toBeGreaterThan(0);
    expect(job.error).toBeUndefined();

    expect(content).not.toBeNull();
    // `Blob.text()` remove o BOM na decodificação — a checagem é nos bytes crus.
    const hasBom = await t.run(async (ctx) => {
      const blob = await ctx.storage.get(job.resultStorageId!);
      const bytes = new Uint8Array(await blob!.arrayBuffer());
      return bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    });
    expect(hasBom, "o CSV precisa começar com BOM UTF-8").toBe(true);

    const parsed = parseCsv(content!);
    expect(parsed.headers).toContain("cf_setor");
    expect(parsed.rows).toHaveLength(2);

    const jose = parsed.rows.find((r) => r.email === "jose@exemplo.com")!;
    expect(jose.firstName).toBe("José");
    expect(jose.lastName).toBe("Antônio");
    expect(jose.tags).toBe("vip;teste");
    expect(jose.cf_setor).toBe("Educação");
    // Escape RFC 4180: vírgula e aspas dentro do campo sobrevivem ao round-trip.
    expect(jose.company).toBe('Padaria "do Zé", Ltda');
    expect(jose.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const url = await admin.query(api.exports.getExportDownloadUrl, {
      organizationId: s.organizationId,
      jobId,
    });
    expect(typeof url).toBe("string");
  });

  test("pagina além de 500 registros sem perder nem duplicar linhas", async () => {
    const s = await seedOrg(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let i = 0; i < 520; i++) {
        await ctx.db.insert("contacts", {
          organizationId: s.organizationId,
          firstName: `Contato ${i}`,
          email: `contato${i}@exemplo.com`,
          tags: [],
          createdAt: now + i,
          updatedAt: now + i,
        });
      }
    });

    const admin = asAdmin(t, s.admin.userId);
    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "contacts",
    });

    const { job, content } = await runJob(t, jobId);
    expect(job.status).toBe("completed");
    expect(job.rowCount).toBe(520);

    const parsed = parseCsv(content!);
    expect(parsed.rows).toHaveLength(520);
    const emails = new Set(parsed.rows.map((r) => r.email));
    expect(emails.size).toBe(520);
    expect(emails.has("contato0@exemplo.com")).toBe(true);
    expect(emails.has("contato519@exemplo.com")).toBe(true);
  });

  test("exporta leads desnormalizando contato, funil, estágio, responsável e origem", async () => {
    const s = await seedOrg(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      const boardId = await ctx.db.insert("boards", {
        organizationId: s.organizationId,
        name: "Funil Principal",
        color: "#2563eb",
        isDefault: true,
        order: 0,
        createdAt: now,
        updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId: s.organizationId,
        boardId,
        name: "Qualificação",
        color: "#22c55e",
        order: 0,
        isClosedWon: false,
        isClosedLost: false,
        createdAt: now,
        updatedAt: now,
      });
      const sourceId = await ctx.db.insert("leadSources", {
        organizationId: s.organizationId,
        name: "Indicação",
        type: "referral",
        isActive: true,
        createdAt: now,
      });
      const contactId = await ctx.db.insert("contacts", {
        organizationId: s.organizationId,
        firstName: "João",
        lastName: "Silva",
        email: "joao@exemplo.com",
        phone: "5511988887777",
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("leads", {
        organizationId: s.organizationId,
        title: "Projeto de energia solar",
        contactId,
        boardId,
        stageId,
        assignedTo: s.admin.memberId,
        sourceId,
        value: 1500.5,
        currency: "BRL",
        priority: "high",
        temperature: "warm",
        tags: ["solar"],
        customFields: {},
        qualification: { score: 75 },
        conversationStatus: "active",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    const admin = asAdmin(t, s.admin.userId);
    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "leads",
    });

    const { job, content } = await runJob(t, jobId);
    expect(job.status).toBe("completed");

    const row = parseCsv(content!).rows[0];
    expect(row.title).toBe("Projeto de energia solar");
    expect(row.contactName).toBe("João Silva");
    expect(row.contactEmail).toBe("joao@exemplo.com");
    expect(row.contactPhone).toBe("5511988887777");
    expect(row.boardName).toBe("Funil Principal");
    expect(row.stageName).toBe("Qualificação");
    expect(row.assignedToName).toBe("Admin");
    expect(row.assigneeEmail).toBe("admin@acme.test");
    expect(row.sourceName).toBe("Indicação");
    expect(row.value).toBe("1500.5");
    expect(row.qualificationScore).toBe("75");
  });

  test("exporta tarefas com projeto, coluna, etiquetas e responsáveis", async () => {
    const s = await seedOrg(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      const projectId = await ctx.db.insert("taskProjects", {
        organizationId: s.organizationId,
        name: "Projeto Alfa",
        order: 0,
        createdBy: s.admin.memberId,
        createdAt: now,
        updatedAt: now,
      });
      const columnId = await ctx.db.insert("taskColumns", {
        organizationId: s.organizationId,
        projectId,
        name: "A fazer",
        order: 0,
        createdAt: now,
        updatedAt: now,
      });
      const labelId = await ctx.db.insert("taskLabels", {
        organizationId: s.organizationId,
        name: "Urgente",
        color: "#ef4444",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("tasks", {
        organizationId: s.organizationId,
        title: "Ligar para o cliente",
        type: "task",
        status: "pending",
        priority: "high",
        projectId,
        columnId,
        labelIds: [labelId],
        assigneeIds: [s.admin.memberId, s.ana.memberId],
        assignedTo: s.admin.memberId,
        createdBy: s.admin.memberId,
        dueDate: Date.UTC(2026, 7, 30, 12, 0, 0),
        createdAt: now,
        updatedAt: now,
      });
    });

    const admin = asAdmin(t, s.admin.userId);
    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "tasks",
    });

    const { job, content } = await runJob(t, jobId);
    expect(job.status).toBe("completed");

    const row = parseCsv(content!).rows[0];
    expect(row.title).toBe("Ligar para o cliente");
    expect(row.projectName).toBe("Projeto Alfa");
    expect(row.columnName).toBe("A fazer");
    expect(row.labels).toBe("Urgente");
    expect(row.assigneeEmails).toBe("admin@acme.test;ana@acme.test");
    expect(row.createdByName).toBe("Admin");
    expect(row.dueDate).toBe("2026-08-30T12:00:00.000Z");
  });

  test("respeita o subconjunto de colunas pedido no job", async () => {
    const s = await seedOrg(t);
    await seedContacts(t, s.organizationId);
    const admin = asAdmin(t, s.admin.userId);

    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "contacts",
      columns: ["email", "firstName", "coluna_inexistente"],
    });

    const { content } = await runJob(t, jobId);
    // Ordem canônica preservada, colunas desconhecidas ignoradas.
    expect(parseCsv(content!).headers).toEqual(["firstName", "email"]);
  });

  test("neutraliza fórmula plantada em campo de contato (CSV formula injection)", async () => {
    const s = await seedOrg(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("contacts", {
        organizationId: s.organizationId,
        firstName: '=HYPERLINK("http://mal.example","x")',
        email: "vitima@exemplo.com",
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
    });
    const admin = asAdmin(t, s.admin.userId);

    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "contacts",
    });

    const { job, content } = await runJob(t, jobId);
    expect(job.status).toBe("completed");

    const row = parseCsv(content!).rows[0];
    // O escape prefixa `'`: ao abrir no Excel/Sheets a célula vira texto puro
    // em vez de executar a fórmula.
    expect(row.firstName).toBe('\'=HYPERLINK("http://mal.example","x")');
  });
});

// ===== Backup completo =====

describe("backup completo JSON", () => {
  async function seedBackupData(
    t: TestConvex<typeof schema>,
    s: { organizationId: Id<"organizations">; admin: { memberId: Id<"teamMembers"> } }
  ) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = s.organizationId;

      const boardId = await ctx.db.insert("boards", {
        organizationId,
        name: "Funil Principal",
        color: "#2563eb",
        isDefault: true,
        order: 0,
        createdAt: now,
        updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId,
        boardId,
        name: "Novo",
        color: "#22c55e",
        order: 0,
        isClosedWon: false,
        isClosedLost: false,
        createdAt: now,
        updatedAt: now,
      });
      const contactId = await ctx.db.insert("contacts", {
        organizationId,
        firstName: "Cliente",
        email: "cliente@exemplo.com",
        tags: [],
        createdAt: now,
        updatedAt: now,
      });
      const leadId = await ctx.db.insert("leads", {
        organizationId,
        title: "Negócio 1",
        contactId,
        boardId,
        stageId,
        value: 100,
        currency: "BRL",
        priority: "medium",
        temperature: "warm",
        tags: [],
        customFields: {},
        conversationStatus: "new",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      });
      const conversationId = await ctx.db.insert("conversations", {
        organizationId,
        leadId,
        channel: "whatsapp",
        status: "active",
        messageCount: 1,
        createdAt: now,
        updatedAt: now,
      });
      const fileId = await ctx.db.insert("files", {
        organizationId,
        storageId: "kg2fake000",
        name: "audio.ogg",
        mimeType: "audio/ogg",
        size: 10,
        fileType: "message_attachment",
        createdAt: now,
      });
      await ctx.db.insert("messages", {
        organizationId,
        conversationId,
        leadId,
        direction: "inbound",
        senderType: "contact",
        content: "oi",
        contentType: "audio",
        attachments: [fileId],
        transcriptText: "olá, tudo bem?",
        isInternal: false,
        createdAt: now,
      });

      // Segredos que NÃO podem sair do backup.
      await ctx.db.insert("webhooks", {
        organizationId,
        name: "Zapier",
        url: "https://exemplo.test/hook",
        events: ["lead.created"],
        secret: "segredo-de-teste-do-webhook",
        isActive: true,
        createdAt: now,
      });
      await ctx.db.insert("channelConfigs", {
        organizationId,
        channel: "whatsapp",
        provider: "meta",
        displayName: "Número principal",
        phoneNumberId: "123",
        verifyToken: "token-de-verificacao-falso",
        accessTokenEncrypted: "cifrado-falso",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("apiKeys", {
        organizationId,
        teamMemberId: s.admin.memberId,
        name: "Chave de teste",
        keyHash: "hash-falso-da-chave",
        isActive: true,
        createdAt: now,
      });

      return { fileId };
    });
  }

  test("gera o formato versionado, na ordem das tabelas e sem segredos", async () => {
    const s = await seedOrg(t);
    const seeded = await seedBackupData(t, s);
    const admin = asAdmin(t, s.admin.userId);

    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "json",
      scope: "full_backup",
    });

    const { job, content } = await runJob(t, jobId);
    expect(job.status).toBe("completed");
    expect(job.resultFileName).toMatch(/^hnbcrm-backup-\d{4}-\d{2}-\d{2}\.json$/);

    const backup = JSON.parse(content!);
    expect(backup.format).toBe("hnbcrm-backup");
    expect(backup.version).toBe(1);
    expect(backup.organizationId).toBe(s.organizationId);
    expect(typeof backup.exportedAt).toBe("number");
    expect(Object.keys(backup.entities)).toEqual([...BACKUP_TABLES]);

    // Só a própria organização, sem userId dos membros.
    expect(backup.entities.organizations).toHaveLength(1);
    expect(backup.entities.organizations[0].name).toBe("Org Export");
    expect(backup.entities.teamMembers).toHaveLength(2);
    for (const member of backup.entities.teamMembers) {
      expect(member.userId).toBeUndefined();
      expect(member.name).toBeTruthy();
    }

    // Conteúdo esperado presente.
    expect(backup.entities.stages).toHaveLength(1);
    expect(backup.entities.leads[0].title).toBe("Negócio 1");
    expect(backup.entities.messages[0].transcriptText).toBe("olá, tudo bem?");
    expect(backup.entities.messages[0].attachments).toEqual([seeded.fileId]);

    // Segredos fora: webhook sem secret e tabelas excluídas ausentes.
    expect(backup.entities.webhooks).toHaveLength(1);
    expect(backup.entities.webhooks[0].name).toBe("Zapier");
    expect(backup.entities.webhooks[0].secret).toBeUndefined();
    expect(backup.entities.channelConfigs).toBeUndefined();
    expect(backup.entities.apiKeys).toBeUndefined();
    expect(backup.entities.auditLogs).toBeUndefined();
    expect(content).not.toContain("segredo-de-teste-do-webhook");
    expect(content).not.toContain("hash-falso-da-chave");
    expect(content).not.toContain("token-de-verificacao-falso");
  });

  test("audita o backup completo com severidade alta", async () => {
    const s = await seedOrg(t);
    const admin = asAdmin(t, s.admin.userId);
    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "json",
      scope: "full_backup",
    });
    await runJob(t, jobId);

    const logs = await t.run(async (ctx) =>
      await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "exportJob").eq("entityId", jobId))
        .collect()
    );
    expect(logs).toHaveLength(2);
    expect(logs.map((l) => l.action).sort()).toEqual(["create", "update"]);
    expect(logs.every((l) => l.severity === "high")).toBe(true);
  });

  test("audita export por entidade com severidade média", async () => {
    const s = await seedOrg(t);
    await seedContacts(t, s.organizationId);
    const admin = asAdmin(t, s.admin.userId);
    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "contacts",
    });
    await runJob(t, jobId);

    const logs = await t.run(async (ctx) =>
      await ctx.db
        .query("auditLogs")
        .withIndex("by_entity", (q) => q.eq("entityType", "exportJob").eq("entityId", jobId))
        .collect()
    );
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.severity === "medium")).toBe(true);
  });
});

// ===== Regras de negócio =====

describe("regras do job de export", () => {
  test("rejeita uma segunda exportação enquanto há outra ativa", async () => {
    const s = await seedOrg(t);
    const admin = asAdmin(t, s.admin.userId);

    await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "contacts",
    });

    await expect(
      admin.mutation(api.exports.createExportJob, {
        organizationId: s.organizationId,
        format: "csv",
        scope: "entity",
        entity: "leads",
      })
    ).rejects.toThrow(/já existe uma exportação em andamento/i);
  });

  test("libera a fila quando o job ativo está travado há mais de 30 minutos", async () => {
    const s = await seedOrg(t);
    const admin = asAdmin(t, s.admin.userId);

    const stale = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "contacts",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(stale, { createdAt: Date.now() - 60 * 60 * 1000 });
    });

    const fresh = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "leads",
    });
    expect(fresh).toBeDefined();

    const staleJob = await t.run(async (ctx) => await ctx.db.get(stale));
    expect(staleJob?.status).toBe("failed");
  });

  test("exige entidade no escopo entity e formatos coerentes", async () => {
    const s = await seedOrg(t);
    const admin = asAdmin(t, s.admin.userId);

    await expect(
      admin.mutation(api.exports.createExportJob, {
        organizationId: s.organizationId,
        format: "csv",
        scope: "entity",
      })
    ).rejects.toThrow(/informe a entidade/i);

    await expect(
      admin.mutation(api.exports.createExportJob, {
        organizationId: s.organizationId,
        format: "csv",
        scope: "full_backup",
      })
    ).rejects.toThrow(/só em JSON/i);

    await expect(
      admin.mutation(api.exports.createExportJob, {
        organizationId: s.organizationId,
        format: "json",
        scope: "entity",
        entity: "contacts",
      })
    ).rejects.toThrow(/só em CSV/i);
  });

  test("membro agent não cria nem lista exportações", async () => {
    const s = await seedOrg(t);
    const ana = t.withIdentity({ subject: `${s.ana.userId}|s1` });

    await expect(
      ana.mutation(api.exports.createExportJob, {
        organizationId: s.organizationId,
        format: "csv",
        scope: "entity",
        entity: "contacts",
      })
    ).rejects.toThrow(/permissão insuficiente/i);

    await expect(
      ana.query(api.exports.getExportJobs, { organizationId: s.organizationId })
    ).rejects.toThrow(/permissão insuficiente/i);
  });

  test("job de outra organização não é visível nem baixável", async () => {
    const s = await seedOrg(t);
    const admin = asAdmin(t, s.admin.userId);
    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "contacts",
    });
    await runJob(t, jobId);

    // Segunda org com o MESMO usuário como admin.
    const otherOrg = await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Outra Org",
        slug: "outra-org",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("teamMembers", {
        organizationId,
        userId: s.admin.userId,
        name: "Admin",
        email: "admin@acme.test",
        role: "admin",
        type: "human",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return organizationId;
    });

    expect(
      await admin.query(api.exports.getExportJob, { organizationId: otherOrg, jobId })
    ).toBeNull();
    expect(
      await admin.query(api.exports.getExportDownloadUrl, { organizationId: otherOrg, jobId })
    ).toBeNull();
    const jobs = await admin.query(api.exports.getExportJobs, { organizationId: otherOrg });
    expect(jobs).toHaveLength(0);
  });

  test("não devolve link de download enquanto o job não terminou", async () => {
    const s = await seedOrg(t);
    const admin = asAdmin(t, s.admin.userId);
    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "contacts",
    });

    expect(
      await admin.query(api.exports.getExportDownloadUrl, {
        organizationId: s.organizationId,
        jobId,
      })
    ).toBeNull();
  });

  test("o cron apaga o blob dos exports vencidos e mantém o histórico", async () => {
    const s = await seedOrg(t);
    await seedContacts(t, s.organizationId);
    const admin = asAdmin(t, s.admin.userId);

    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "contacts",
    });
    const { job } = await runJob(t, jobId);
    const storageId = job.resultStorageId!;
    expect(storageId).toBeDefined();

    // Nada a limpar enquanto está dentro da validade.
    expect(await t.mutation(internal.exports.internalCleanupExpired, {})).toEqual({ deleted: 0 });

    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, { expiresAt: Date.now() - 1000 });
    });

    expect(await t.mutation(internal.exports.internalCleanupExpired, {})).toEqual({ deleted: 1 });

    const after = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(after?.status).toBe("completed");
    expect(after?.resultStorageId).toBeUndefined();
    expect(after?.resultFileName).toBeTruthy();

    expect(
      await admin.query(api.exports.getExportDownloadUrl, {
        organizationId: s.organizationId,
        jobId,
      })
    ).toBeNull();
  });

  // Nenhum webhook é cadastrado de propósito: o disparo real faria `fetch` de
  // verdade no ambiente de teste. Basta conferir o evento agendado.
  test("dispara webhook export.completed com o resumo do arquivo", async () => {
    const s = await seedOrg(t);
    await seedContacts(t, s.organizationId);
    const admin = asAdmin(t, s.admin.userId);
    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "csv",
      scope: "entity",
      entity: "contacts",
    });
    await runJob(t, jobId);

    const scheduled = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) =>
        f.name.includes("triggerWebhooks")
      )
    );
    const payload = scheduled.at(-1)?.args?.[0] as any;
    expect(payload?.event).toBe("export.completed");
    expect(payload?.payload?.rowCount).toBe(2);
    expect(payload?.payload?.entity).toBe("contacts");
    expect(payload?.payload?.fileName).toMatch(/\.csv$/);
  });
});
