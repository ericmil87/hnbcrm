/// <reference types="vite/client" />
/**
 * Meta Messaging F0.2: transporte por canal (fail-closed), `configProvider`
 * WA-only, resolução de canal estrita para conversas não-WhatsApp e a porta
 * única de envio (`scheduleOutboundDispatch`).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import schema from "./schema";
import { configProvider } from "./channelConfigs";
import {
  CHANNEL_TRANSPORTS,
  configTransport,
  isWhatsappTransport,
} from "./lib/channelTransport";
import { resolveConversationChannelConfig, transportOf } from "./lib/channelResolve";
import { channelProviderOf } from "./lib/conversationListFields";
import { scheduleOutboundDispatch } from "./lib/outboundDispatch";
import { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

describe("configTransport", () => {
  test.each([
    [{ channel: "whatsapp" }, "meta"],
    [{ channel: "whatsapp", provider: null }, "meta"],
    [{ channel: "whatsapp", provider: "meta" as const }, "meta"],
    [{ channel: "whatsapp", provider: "bridge" as const }, "bridge"],
    [{ channel: "instagram" }, "instagram"],
    [{ channel: "messenger" }, "messenger"],
    // channel decide ANTES do provider
    [{ channel: "instagram", provider: "bridge" as const }, "instagram"],
  ])("%j → %s", (config, expected) => {
    expect(configTransport(config)).toBe(expected);
  });

  test.each(["telegram", "", "email", "WhatsApp"])("channel %j lança (fail-closed)", (channel) => {
    expect(() => configTransport({ channel })).toThrow(/channel desconhecido/);
  });

  test("lista e predicado WhatsApp", () => {
    expect([...CHANNEL_TRANSPORTS].sort()).toEqual(["bridge", "instagram", "messenger", "meta"]);
    expect(CHANNEL_TRANSPORTS.filter(isWhatsappTransport)).toEqual(["meta", "bridge"]);
  });
});

describe("configProvider (WhatsApp-only)", () => {
  test("linha legada sem channel continua meta; bridge continua bridge", () => {
    expect(configProvider({})).toBe("meta");
    expect(configProvider({ provider: null })).toBe("meta");
    expect(configProvider({ channel: "whatsapp", provider: "bridge" })).toBe("bridge");
    expect(configProvider({ channel: "whatsapp" })).toBe("meta");
  });

  test.each(["instagram", "messenger", "telegram"])("channel %s lança", (channel) => {
    expect(() => configProvider({ channel })).toThrow(/config não é WhatsApp/);
  });
});

describe("channelProviderOf (denormalização da lista)", () => {
  test("WhatsApp inalterado; Instagram e Messenger gravam o próprio transporte (F0.3)", () => {
    expect(channelProviderOf(null)).toBeUndefined();
    expect(channelProviderOf({ provider: "bridge" })).toBe("bridge");
    expect(channelProviderOf({ channel: "whatsapp" })).toBe("meta");
    expect(channelProviderOf({ channel: "instagram" })).toBe("instagram");
    expect(channelProviderOf({ channel: "messenger" })).toBe("messenger");
  });
});

async function seedOrg(t: TestConvex<typeof schema>, slug: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: `Org ${slug}`,
      slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: `Número ${slug}`,
      phoneNumberId: `pn-${slug}`,
      verifyToken: `vt-${slug}`,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, configId };
  });
}

async function insertConversation(
  t: TestConvex<typeof schema>,
  organizationId: Id<"organizations">,
  channel: "whatsapp" | "internal" | "webchat" | "instagram" | "messenger",
  channelConfigId?: Id<"channelConfigs">
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("conversations", {
      organizationId,
      channel,
      ...(channelConfigId ? { channelConfigId } : {}),
      status: "active",
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
  });
}

describe("resolveConversationChannelConfig estrito por canal", () => {
  test("WhatsApp sem channelConfigId mantém o fallback (meta ativo)", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seedOrg(t, "a");
    const convId = await insertConversation(t, organizationId, "whatsapp");
    const resolved = await t.run(async (ctx) =>
      resolveConversationChannelConfig(ctx, (await ctx.db.get(convId))!)
    );
    expect(resolved?._id).toEqual(configId);
    expect(transportOf(resolved)).toBe("meta");
  });

  test("conversa não-WhatsApp sem channelConfigId → null, mesmo com WhatsApp ativo na org", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seedOrg(t, "a");
    const convId = await insertConversation(t, organizationId, "internal");
    const resolved = await t.run(async (ctx) =>
      resolveConversationChannelConfig(ctx, (await ctx.db.get(convId))!)
    );
    expect(resolved).toBeNull();
    expect(transportOf(resolved)).toBeNull();
  });

  test("conversa não-WhatsApp só resolve config da mesma org E do mesmo canal", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seedOrg(t, "a");
    const { igId, msgId } = await t.run(async (ctx) => {
      const now = Date.now();
      const igId = await ctx.db.insert("channelConfigs", {
        organizationId, channel: "instagram", displayName: "ig", status: "active", instagramAccountId: "ig1", createdAt: now, updatedAt: now,
      });
      const msgId = await ctx.db.insert("channelConfigs", {
        organizationId, channel: "messenger", displayName: "msg", status: "active", messengerPageId: "pg1", createdAt: now, updatedAt: now,
      });
      return { igId, msgId };
    });
    const resolve = async (channel: "webchat" | "instagram", cfg: Id<"channelConfigs">) => {
      const convId = await insertConversation(t, organizationId, channel, cfg);
      return await t.run(async (ctx) => resolveConversationChannelConfig(ctx, (await ctx.db.get(convId))!));
    };
    expect((await resolve("instagram", igId))?._id).toEqual(igId);
    expect(await resolve("instagram", msgId)).toBeNull(); // superfície errada
    expect(await resolve("instagram", configId)).toBeNull(); // config de WhatsApp
    expect(await resolve("webchat", configId)).toBeNull();
  });

  test("channelConfigId de OUTRA org → null (sem fallback)", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOrg(t, "a");
    const b = await seedOrg(t, "b");
    const convId = await insertConversation(t, a.organizationId, "internal", b.configId);
    const resolved = await t.run(async (ctx) =>
      resolveConversationChannelConfig(ctx, (await ctx.db.get(convId))!)
    );
    expect(resolved).toBeNull();
  });

  test("channelConfigId apagado → null para conversa não-WhatsApp", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seedOrg(t, "a");
    const convId = await insertConversation(t, organizationId, "internal", configId);
    await t.run(async (ctx) => ctx.db.delete(configId));
    const resolved = await t.run(async (ctx) =>
      resolveConversationChannelConfig(ctx, (await ctx.db.get(convId))!)
    );
    expect(resolved).toBeNull();
  });
});

describe("scheduleOutboundDispatch (porta única)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function insertOutbound(
    t: TestConvex<typeof schema>,
    organizationId: Id<"organizations">,
    conversationId: Id<"conversations">
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId,
        conversationId,
        direction: "outbound",
        senderType: "human",
        content: "oi",
        contentType: "text",
        isInternal: false,
        createdAt: Date.now(),
      })
    );
  }

  async function scheduledNames(t: TestConvex<typeof schema>) {
    return await t.run(async (ctx) => {
      const jobs = await ctx.db.system.query("_scheduled_functions").collect();
      return jobs.map((j) => j.name);
    });
  }

  async function cancelPendingJobs(t: TestConvex<typeof schema>) {
    await t.run(async (ctx) => {
      const jobs = await ctx.db.system.query("_scheduled_functions").collect();
      for (const j of jobs) {
        if (j.state.kind === "pending") await ctx.scheduler.cancel(j._id);
      }
    });
    await t.finishInProgressScheduledFunctions();
  }

  test("WhatsApp agenda o dispatcher do WhatsApp", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seedOrg(t, "a");
    const convId = await insertConversation(t, organizationId, "whatsapp");
    const messageId = await insertOutbound(t, organizationId, convId);
    await t.run(async (ctx) =>
      scheduleOutboundDispatch(ctx, (await ctx.db.get(convId))!, messageId)
    );
    expect(await scheduledNames(t)).toEqual(["whatsapp:internalDispatchMessage"]);
    await cancelPendingJobs(t);
  });

  test("outro canal é no-op nesta fase (nunca cai no WhatsApp)", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seedOrg(t, "a");
    const convId = await insertConversation(t, organizationId, "internal", configId);
    const messageId = await insertOutbound(t, organizationId, convId);
    await t.run(async (ctx) =>
      scheduleOutboundDispatch(ctx, (await ctx.db.get(convId))!, messageId)
    );
    expect(await scheduledNames(t)).toEqual([]);
  });
});
