/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { findOrCreateContactByMetaIdentity } from "./lib/metaIdentity";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", modules: { metaMessaging: true } },
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Default",
      color: "#6366f1",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "New",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    const messengerId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "messenger",
      displayName: "Página",
      status: "active",
      messengerPageId: "1000000000000001",
      createdAt: now,
      updatedAt: now,
    });
    const instagramId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "instagram",
      displayName: "@conta",
      status: "active",
      instagramAccountId: "1000000000000003",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, messengerId, instagramId };
  });
}

describe("findOrCreateContactByMetaIdentity", () => {
  test("PSID e IGSID da mesma pessoa viram 2 contatos, nunca com telefone", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { a, b } = await t.run(async (ctx) => ({
      a: await findOrCreateContactByMetaIdentity(ctx, {
        organizationId: s.organizationId,
        channelConfigId: s.messengerId,
        kind: "messenger",
        externalId: "1000000000000002",
        name: "Marina",
      }),
      b: await findOrCreateContactByMetaIdentity(ctx, {
        organizationId: s.organizationId,
        channelConfigId: s.instagramId,
        kind: "instagram",
        externalId: "1000000000000004",
        username: "@marina",
        name: "Marina",
      }),
    }));
    expect(a.contactId).not.toEqual(b.contactId);
    expect(a.created && b.created).toBe(true);
    const docs = await t.run(async (ctx) => [await ctx.db.get(a.contactId), await ctx.db.get(b.contactId)]);
    for (const c of docs) {
      expect(c?.phone).toBeUndefined();
      expect(c?.whatsappNumber).toBeUndefined();
    }
    expect(docs[1]?.instagramUsername).toBe("marina");
    expect(docs[0]?.firstName).toBe("Marina");
  });

  test("nome provisório com 4 últimos dígitos e @username", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const out = await t.run(async (ctx) => {
      const m = await findOrCreateContactByMetaIdentity(ctx, {
        organizationId: s.organizationId,
        channelConfigId: s.messengerId,
        kind: "messenger",
        externalId: "1000000000005678",
      });
      const i = await findOrCreateContactByMetaIdentity(ctx, {
        organizationId: s.organizationId,
        channelConfigId: s.instagramId,
        kind: "instagram",
        externalId: "1000000000009999",
        username: "loja_x",
      });
      return [await ctx.db.get(m.contactId), await ctx.db.get(i.contactId)];
    });
    expect(out[0]?.firstName).toBe("Messenger ····5678");
    expect(out[1]?.firstName).toBe("@loja_x");
  });

  test("segunda chamada reusa contato e identidade; perfil tardio preenche o nome", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const args = {
      organizationId: s.organizationId,
      channelConfigId: s.messengerId,
      kind: "messenger" as const,
      externalId: "1000000000005678",
    };
    const res = await t.run(async (ctx) => {
      const first = await findOrCreateContactByMetaIdentity(ctx, args);
      const second = await findOrCreateContactByMetaIdentity(ctx, { ...args, name: "Marina Souza" });
      return { first, second, contact: await ctx.db.get(first.contactId) };
    });
    expect(res.second.created).toBe(false);
    expect(res.second.contactId).toEqual(res.first.contactId);
    expect(res.second.identityId).toEqual(res.first.identityId);
    expect(res.contact?.firstName).toBe("Marina Souza");
  });

  test("mesma externalId em outro config é outra identidade (chave é config + externalId)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ids = await t.run(async (ctx) => {
      const a = await findOrCreateContactByMetaIdentity(ctx, {
        organizationId: s.organizationId,
        channelConfigId: s.messengerId,
        kind: "messenger",
        externalId: "1000000000005678",
      });
      const b = await findOrCreateContactByMetaIdentity(ctx, {
        organizationId: s.organizationId,
        channelConfigId: s.instagramId,
        kind: "instagram",
        externalId: "1000000000005678",
      });
      return [a.contactId, b.contactId];
    });
    expect(ids[0]).not.toEqual(ids[1]);
  });
});

describe("internalRouteMetaInbound", () => {
  test("segunda mensagem reusa contato e lead; backfill de perfil atualiza nome e título do lead", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const first = await t.mutation(internal.metaMessaging.internalRouteMetaInbound, {
      configId: s.messengerId,
      surface: "messenger",
      userId: "1000000000005678",
    });
    expect(first?.needsProfile).toBe(true);
    const second = await t.mutation(internal.metaMessaging.internalRouteMetaInbound, {
      configId: s.messengerId,
      surface: "messenger",
      userId: "1000000000005678",
    });
    expect(second?.leadId).toEqual(first?.leadId);
    expect(second?.contactId).toEqual(first?.contactId);

    const withProfile = await t.mutation(internal.metaMessaging.internalRouteMetaInbound, {
      configId: s.messengerId,
      surface: "messenger",
      userId: "1000000000005678",
      profile: { name: "Marina Souza" },
    });
    expect(withProfile?.needsProfile).toBe(false);
    const docs = await t.run(async (ctx) => ({
      contact: await ctx.db.get(first!.contactId),
      lead: await ctx.db.get(first!.leadId),
      identities: await ctx.db.query("contactChannelIdentities").collect(),
      leads: await ctx.db.query("leads").collect(),
    }));
    expect(docs.contact?.firstName).toBe("Marina Souza");
    expect(docs.lead?.title).toBe("Marina Souza");
    expect(docs.identities).toHaveLength(1);
    expect(docs.leads).toHaveLength(1);
  });

  test("config desativado ou módulo off devolve null", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.instagramId, { status: "disabled" });
    });
    expect(
      await t.mutation(internal.metaMessaging.internalRouteMetaInbound, {
        configId: s.instagramId,
        surface: "instagram",
        userId: "1000000000004444",
      })
    ).toBeNull();
    await t.run(async (ctx) => {
      await ctx.db.patch(s.organizationId, { settings: { timezone: "America/Sao_Paulo", currency: "BRL" } });
    });
    expect(
      await t.mutation(internal.metaMessaging.internalRouteMetaInbound, {
        configId: s.messengerId,
        surface: "messenger",
        userId: "1000000000004444",
      })
    ).toBeNull();
  });
});

describe("contato apagado", () => {
  async function ingestTwice(t: TestConvex<typeof schema>, configId: Id<"channelConfigs">) {
    for (let i = 0; i < 2; i++) {
      await t.mutation(internal.metaMessaging.internalRouteMetaInbound, {
        configId,
        surface: "messenger",
        userId: "1000000000005678",
      });
    }
  }

  test("identidade órfã (linha antiga): 2 mensagens → 1 contato, 1 identidade, 1 lead", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const first = await t.mutation(internal.metaMessaging.internalRouteMetaInbound, {
      configId: s.messengerId,
      surface: "messenger",
      userId: "1000000000005678",
    });
    // Simula contato e lead apagados SEM limpar a identidade (estado deixado pelo bug antigo).
    await t.run(async (ctx) => {
      await ctx.db.delete(first!.leadId);
      await ctx.db.delete(first!.contactId);
    });
    await ingestTwice(t, s.messengerId);
    const data = await t.run(async (ctx) => ({
      contacts: await ctx.db.query("contacts").collect(),
      identities: await ctx.db.query("contactChannelIdentities").collect(),
      leads: await ctx.db.query("leads").collect(),
    }));
    expect(data.contacts).toHaveLength(1);
    expect(data.identities).toHaveLength(1);
    expect(data.identities[0].contactId).toEqual(data.contacts[0]._id);
    expect(data.leads).toHaveLength(1);
  });

  test("deleteContact apaga as identidades; a próxima mensagem cria 1 contato e 1 lead", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const adminUserId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { email: "a@example.test" });
      await ctx.db.insert("teamMembers", {
        organizationId: s.organizationId,
        userId,
        name: "Admin",
        role: "admin",
        type: "human",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return userId;
    });
    const first = await t.mutation(internal.metaMessaging.internalRouteMetaInbound, {
      configId: s.messengerId,
      surface: "messenger",
      userId: "1000000000005678",
    });
    await t.run(async (ctx) => {
      await ctx.db.delete(first!.leadId);
    });
    const asAdmin = t.withIdentity({ subject: `${adminUserId}|s1` });
    await asAdmin.mutation(api.contacts.deleteContact, { contactId: first!.contactId });
    expect(await t.run(async (ctx) => (await ctx.db.query("contactChannelIdentities").collect()).length)).toBe(0);

    await ingestTwice(t, s.messengerId);
    const data = await t.run(async (ctx) => ({
      contacts: await ctx.db.query("contacts").collect(),
      identities: await ctx.db.query("contactChannelIdentities").collect(),
      leads: await ctx.db.query("leads").collect(),
    }));
    expect([data.contacts.length, data.identities.length, data.leads.length]).toEqual([1, 1, 1]);
  });
});
