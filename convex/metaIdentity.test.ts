/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
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
