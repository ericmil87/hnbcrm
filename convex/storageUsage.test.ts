/// <reference types="vite/client" />
/**
 * Contador agregado de armazenamento (`orgStorageUsage`, perf Convex I/O,
 * onda 2). Prova que:
 *  - a 1ª checagem de quota inicializa o contador a partir de `files` (lazy
 *    init, sem backfill obrigatório);
 *  - mídia inbound e upload somam; exclusão desconta (nunca negativo);
 *  - a quota recusa no teto lendo o CONTADOR (não a soma de `files`);
 *  - `internalRebuildStorageUsage` bate com o real (dryRun não grava);
 *  - nenhum `insert("files"` fora de `lib/storageUsage.ts`.
 */
import { expect, test, describe } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { FILE_QUOTAS } from "./lib/fileQuotas";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Storage",
      slug: `org-storage-${Math.random().toString(36).slice(2)}`,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const teamMemberId = await ctx.db.insert("teamMembers", {
      organizationId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, teamMemberId };
  });
}

async function usage(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) => {
    const row = await ctx.db
      .query("orgStorageUsage")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .unique();
    return row ? { bytes: row.bytes, count: row.count } : null;
  });
}

async function storeBlob(t: TestConvex<typeof schema>) {
  return await t.run(
    async (ctx) => await ctx.storage.store(new Blob([new Uint8Array([1, 2, 3]) as BlobPart]))
  );
}

async function rawFile(t: TestConvex<typeof schema>, organizationId: Id<"organizations">, size: number) {
  return await t.run(async (ctx) =>
    ctx.db.insert("files", {
      organizationId,
      storageId: `legado-${Math.random()}`,
      name: "legado.pdf",
      mimeType: "application/pdf",
      size,
      fileType: "other",
      createdAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
    })
  );
}

describe("orgStorageUsage", () => {
  test("lazy init na 1ª mídia inbound e incremento a partir daí", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    await rawFile(t, organizationId, 5000); // legado, antes do contador existir
    expect(await usage(t, organizationId)).toBeNull();

    const r1 = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId, storageId: await storeBlob(t), name: "a.jpg", mimeType: "image/jpeg", size: 1000,
    });
    expect(r1.ok).toBe(true);
    expect(await usage(t, organizationId)).toEqual({ bytes: 6000, count: 2 });

    await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId, storageId: await storeBlob(t), name: "b.jpg", mimeType: "image/jpeg", size: 250,
    });
    expect(await usage(t, organizationId)).toEqual({ bytes: 6250, count: 3 });
  });

  test("upload (internalSaveFile) soma e exclusão desconta", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, teamMemberId } = await seed(t);
    const fileId = await t.mutation(internal.files.internalSaveFile, {
      organizationId, teamMemberId, storageId: await storeBlob(t),
      name: "doc.pdf", mimeType: "application/pdf", size: 4000, fileType: "other",
    });
    expect(await usage(t, organizationId)).toEqual({ bytes: 4000, count: 1 });

    await t.mutation(internal.files.internalDeleteFile, { fileId, organizationId, teamMemberId });
    expect(await usage(t, organizationId)).toEqual({ bytes: 0, count: 0 });
  });

  test("exclusão nunca deixa o contador negativo", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, teamMemberId } = await seed(t);
    const fileId = await rawFile(t, organizationId, 9000);
    // Contador inicializado errado (menor que o real) — o delete satura em 0.
    await t.run(async (ctx) =>
      ctx.db.insert("orgStorageUsage", { organizationId, bytes: 100, count: 0, updatedAt: Date.now() })
    );
    await t.mutation(internal.files.internalDeleteFile, { fileId, organizationId, teamMemberId });
    expect(await usage(t, organizationId)).toEqual({ bytes: 0, count: 0 });
  });

  test("quota recusa no teto lendo o contador", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, teamMemberId } = await seed(t);
    // Nenhuma linha em `files`: só o contador diz que a org está cheia.
    await t.run(async (ctx) =>
      ctx.db.insert("orgStorageUsage", {
        organizationId, bytes: FILE_QUOTAS.free.totalStorage - 100, count: 1, updatedAt: Date.now(),
      })
    );
    const saved = await t.mutation(internal.whatsapp.internalSaveInboundAttachment, {
      organizationId, storageId: await storeBlob(t), name: "c.jpg", mimeType: "image/jpeg", size: 500,
    });
    expect(saved.ok).toBe(false);
    if (!saved.ok) expect(saved.reason).toContain("cota de armazenamento");
    await expect(
      t.mutation(internal.files.internalSaveFile, {
        organizationId, teamMemberId, storageId: await storeBlob(t),
        name: "d.pdf", mimeType: "application/pdf", size: 500, fileType: "other",
      })
    ).rejects.toThrow("Cota de armazenamento excedida");
  });

  test("rebuild bate com o real; dryRun não grava", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    const other = await seed(t);
    await rawFile(t, organizationId, 700);
    await rawFile(t, organizationId, 300);
    await rawFile(t, other.organizationId, 50);
    // Contador divergente (escritor esquecido).
    await t.run(async (ctx) =>
      ctx.db.insert("orgStorageUsage", { organizationId, bytes: 1, count: 9, updatedAt: Date.now() })
    );

    const dry = await t.mutation(internal.files.internalRebuildStorageUsage, { dryRun: true });
    expect(dry.isDone).toBe(true);
    expect(dry.changedCount).toBe(2);
    expect(await usage(t, organizationId)).toEqual({ bytes: 1, count: 9 });
    expect(await usage(t, other.organizationId)).toBeNull();

    await t.mutation(internal.files.internalRebuildStorageUsage, { dryRun: false });
    expect(await usage(t, organizationId)).toEqual({ bytes: 1000, count: 2 });
    expect(await usage(t, other.organizationId)).toEqual({ bytes: 50, count: 1 });

    const again = await t.mutation(internal.files.internalRebuildStorageUsage, {
      organizationId, dryRun: true,
    });
    expect(again.changedCount).toBe(0);
  });
});

describe("porta única de insert em files", () => {
  test('nenhum insert("files" fora de lib/storageUsage.ts', () => {
    const root = __dirname;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (name === "_generated" || name === "__fixtures__") continue;
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        if (full.endsWith(join("lib", "storageUsage.ts"))) continue;
        if (/insert\(\s*["']files["']/.test(readFileSync(full, "utf8"))) offenders.push(full.slice(root.length + 1));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
