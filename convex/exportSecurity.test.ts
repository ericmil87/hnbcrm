/// <reference types="vite/client" />
/**
 * Teste de BUILD do export (mesmo espírito do `convex/secretScan.test.ts`):
 * quebra a suíte se um backup gerado carregar campo proibido.
 *
 * Duas frentes:
 *  1. Unidade da denylist (`lib/exportSanitize.ts`) — nomes, caminhos e recursão.
 *  2. Backup real gerado no convex-test, com segredos plantados em TODAS as
 *     tabelas sensíveis: nem os valores nem os nomes de campo podem aparecer no
 *     arquivo, e as tabelas excluídas não podem existir no payload.
 */
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { BACKUP_TABLES } from "./exports";
import {
  EXCLUDED_BACKUP_TABLES,
  findSecretPaths,
  isSecretKey,
  sanitizeDocument,
} from "./lib/exportSanitize";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

/** Valores plantados no seed que NUNCA podem sair no arquivo. */
const PLANTED_SECRETS = [
  "segredo-do-webhook-plantado",
  "hash-da-chave-plantado",
  "token-de-verificacao-plantado",
  "access-token-cifrado-plantado",
  "bridge-token-cifrado-plantado",
  "chave-byo-cifrada-plantada",
];

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

// ===== 1. Denylist (unidade) =====

describe("denylist de sanitização", () => {
  test("reconhece nomes de campo sensíveis em qualquer grafia", () => {
    for (const key of [
      "secret",
      "appSecretEncrypted",
      "accessToken",
      "access_token",
      "Verify-Token",
      "keyHash",
      "apiKeyRef",
      "password",
      "bridgeTokenEncrypted",
    ]) {
      expect(isSecretKey(key), key).toBe(true);
    }
    // Campos legítimos não podem ser confundidos com segredo.
    for (const key of ["name", "handoffKeywords", "labelIds", "monkey", "keywords"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });

  test("remove segredos aninhados e caminhos da denylist", () => {
    const sanitized = sanitizeDocument("organizations", {
      _id: "org1",
      name: "Acme",
      settings: {
        timezone: "America/Sao_Paulo",
        aiConfig: {
          enabled: true,
          providerConfig: {
            mode: "byo",
            byo: { provider: "openai", apiKeyRef: { kind: "orgSecret", id: "secreto" } },
          },
        },
      },
      nested: [{ deep: { accessToken: "xyz", keep: 1 } }],
    });

    expect(sanitized.name).toBe("Acme");
    expect((sanitized.settings as any).timezone).toBe("America/Sao_Paulo");
    expect((sanitized.settings as any).aiConfig.enabled).toBe(true);
    expect((sanitized.settings as any).aiConfig.providerConfig.byo).toBeUndefined();
    expect((sanitized.nested as any)[0].deep.accessToken).toBeUndefined();
    expect((sanitized.nested as any)[0].deep.keep).toBe(1);
    expect(findSecretPaths(sanitized, "organizations")).toEqual([]);
  });

  test("teamMembers perde o vínculo com a tabela de auth", () => {
    const sanitized = sanitizeDocument("teamMembers", {
      _id: "m1",
      name: "Ana",
      userId: "user_123",
      email: "ana@acme.test",
    });
    expect(sanitized.userId).toBeUndefined();
    expect(sanitized.email).toBe("ana@acme.test");
  });

  test("a lista de tabelas do backup não cruza com a de exclusão", () => {
    const overlap = BACKUP_TABLES.filter((table) => EXCLUDED_BACKUP_TABLES.includes(table));
    expect(overlap).toEqual([]);
  });
});

// ===== 2. Backup real =====

async function seedOrgWithSecrets(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const userId = await ctx.db.insert("users", {});
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Segredos",
      slug: "org-segredos",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Admin",
      email: "admin@acme.test",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    const secretId = await ctx.db.insert("orgSecrets", {
      organizationId,
      name: "Chave BYO",
      purpose: "llm-api-key",
      provider: "openai",
      encryptedValue: "chave-byo-cifrada-plantada",
      last4: "1234",
      createdBy: memberId,
      createdAt: now,
      updatedAt: now,
    });

    // Rota BYO no settings da org (o backup traz a org inteira).
    await ctx.db.patch(organizationId, {
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: {
          enabled: true,
          autoAssign: false,
          handoffThreshold: 3,
          providerConfig: {
            mode: "byo",
            byo: {
              provider: "openai",
              apiKeyRef: { kind: "orgSecret", id: secretId },
            },
            zdr: true,
            models: {
              copilot: "modelo-copiloto",
              attendant: "modelo-atendente",
              classify: "modelo-classificacao",
            },
          },
        },
      },
    });

    await ctx.db.insert("webhooks", {
      organizationId,
      name: "Zapier",
      url: "https://exemplo.test/hook",
      events: ["lead.created"],
      secret: "segredo-do-webhook-plantado",
      isActive: true,
      createdAt: now,
    });
    await ctx.db.insert("apiKeys", {
      organizationId,
      teamMemberId: memberId,
      name: "Chave",
      keyHash: "hash-da-chave-plantado",
      isActive: true,
      createdAt: now,
    });
    await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número",
      phoneNumberId: "123",
      verifyToken: "token-de-verificacao-plantado",
      accessTokenEncrypted: "access-token-cifrado-plantado",
      bridgeTokenEncrypted: "bridge-token-cifrado-plantado",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });

    // Dados normais, para o backup não sair vazio.
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Funil",
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
      title: "Negócio",
      contactId,
      boardId,
      stageId,
      value: 10,
      currency: "BRL",
      priority: "low",
      temperature: "cold",
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
    // Metadata de provider com token: o sanitizador precisa alcançar o aninhado.
    await ctx.db.insert("messages", {
      organizationId,
      conversationId,
      leadId,
      direction: "inbound",
      senderType: "contact",
      content: "oi",
      contentType: "text",
      isInternal: false,
      metadata: { provider: { accessToken: "access-token-cifrado-plantado" } },
      createdAt: now,
    });

    return { organizationId, userId };
  });
}

describe("backup completo não vaza segredo", () => {
  test("o arquivo gerado não tem campo proibido nem tabela excluída", async () => {
    const s = await seedOrgWithSecrets(t);
    const admin = t.withIdentity({ subject: `${s.userId}|s1` });

    const jobId = await admin.mutation(api.exports.createExportJob, {
      organizationId: s.organizationId,
      format: "json",
      scope: "full_backup",
    });
    await t.action(internal.exports.internalRunExport, { jobId });

    let job = await t.run(async (ctx) => await ctx.db.get(jobId));
    for (let attempt = 0; attempt < 50 && job?.status !== "completed" && job?.status !== "failed"; attempt++) {
      await t.finishInProgressScheduledFunctions();
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = await t.run(async (ctx) => await ctx.db.get(jobId));
    }
    expect(job?.status).toBe("completed");

    const content = await t.run(async (ctx) => {
      const blob = await ctx.storage.get(job!.resultStorageId!);
      return blob ? await blob.text() : "";
    });

    const backup = JSON.parse(content);

    // (a) nenhum caminho proibido sobreviveu à sanitização
    expect(findSecretPaths(backup.entities)).toEqual([]);

    // (b) nenhuma tabela excluída entrou no payload
    const excluded = Object.keys(backup.entities).filter((table) =>
      EXCLUDED_BACKUP_TABLES.includes(table)
    );
    expect(excluded).toEqual([]);

    // (c) nenhum valor secreto plantado aparece no arquivo cru
    const leaked = PLANTED_SECRETS.filter((secret) => content.includes(secret));
    expect(leaked, `Segredo vazou no backup: ${leaked.join(", ")}`).toEqual([]);

    // (d) o backup continua útil (não virou arquivo vazio)
    expect(backup.entities.contacts).toHaveLength(1);
    expect(backup.entities.webhooks[0].name).toBe("Zapier");
    expect(backup.entities.organizations[0].settings.aiConfig.enabled).toBe(true);
  });
});
