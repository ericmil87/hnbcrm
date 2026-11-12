/// <reference types="vite/client" />
/**
 * `files.discardUnsavedUpload`: apaga o blob de um upload cujo `saveFile` falhou,
 * mas nunca um blob que tenha linha em `files` (de qualquer org).
 */
import { describe, expect, it } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { insertFileRow } from "./lib/storageUsage";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

async function seed(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mkOrg = async (slug: string) =>
      ctx.db.insert("organizations", {
        name: slug,
        slug,
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now,
        updatedAt: now,
      });
    const orgA = await mkOrg("org-a");
    const orgB = await mkOrg("org-b");
    const userId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", {
      organizationId: orgA,
      userId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const blob = async () => (await ctx.storage.store(new Blob(["x"]))) as string;
    return { orgA, orgB, userId, orphan: await blob(), savedInA: await blob(), savedInB: await blob() };
  });
}

async function addRow(t: ReturnType<typeof convexTest>, organizationId: Id<"organizations">, storageId: string) {
  await t.run(async (ctx) => {
    await insertFileRow(ctx, {
      organizationId,
      storageId,
      name: "a.pdf",
      mimeType: "application/pdf",
      size: 1,
      fileType: "message_attachment",
      createdAt: Date.now(),
    });
  });
}

const exists = (t: ReturnType<typeof convexTest>, storageId: string) =>
  t.run(async (ctx) => (await ctx.storage.getUrl(storageId as Id<"_storage">)) !== null);

describe("files.discardUnsavedUpload", () => {
  it("apaga o blob sem linha em files", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const asUser = t.withIdentity({ subject: `${s.userId}|s1` });
    expect(await asUser.mutation(api.files.discardUnsavedUpload, { organizationId: s.orgA, storageId: s.orphan })).toBe(true);
    expect(await exists(t, s.orphan)).toBe(false);
  });

  it("não apaga se já existe linha em files (mesma org nem outra org)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addRow(t, s.orgA, s.savedInA);
    await addRow(t, s.orgB, s.savedInB);
    const asUser = t.withIdentity({ subject: `${s.userId}|s1` });
    expect(await asUser.mutation(api.files.discardUnsavedUpload, { organizationId: s.orgA, storageId: s.savedInA })).toBe(false);
    expect(await asUser.mutation(api.files.discardUnsavedUpload, { organizationId: s.orgA, storageId: s.savedInB })).toBe(false);
    expect(await exists(t, s.savedInA)).toBe(true);
    expect(await exists(t, s.savedInB)).toBe(true);
  });

  it("exige membro da org e login", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await expect(t.mutation(api.files.discardUnsavedUpload, { organizationId: s.orgA, storageId: s.orphan })).rejects.toThrow();
    const asUser = t.withIdentity({ subject: `${s.userId}|s1` });
    await expect(asUser.mutation(api.files.discardUnsavedUpload, { organizationId: s.orgB, storageId: s.orphan })).rejects.toThrow();
    expect(await exists(t, s.orphan)).toBe(true);
  });
});
