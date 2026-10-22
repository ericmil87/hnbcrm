/// <reference types="vite/client" />
/**
 * F5: Instagram/Messenger na REST. `GET /conversations/channels` lista WhatsApp
 * (iniciável) + contas Meta (`canStart:false`) sem ids de Página/IG; `/start` e
 * `/send-template` recusam Meta com texto PT-BR; `/receive` aceita Meta só com
 * `contactId` + `channelConfigId` da org; `GET /conversations` filtra por conta.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const KEY = "hnb_test_meta_rest_1";
const PAGE_ID = "1000000000000001";
const IG_ID = "1784000000000002";
const NO_START = "Instagram e Messenger não permitem iniciar conversa nem templates; a pessoa precisa escrever primeiro.";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 20, 12, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seed(t: TestConvex<typeof schema>, opts?: { metaModule?: boolean }) {
  const keyHash = await sha256Hex(KEY);
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mkOrg = async (slug: string, modules?: Record<string, boolean>) =>
      await ctx.db.insert("organizations", {
        name: slug,
        slug,
        settings: { timezone: "America/Sao_Paulo", currency: "BRL", ...(modules ? { modules } : {}) },
        createdAt: now,
        updatedAt: now,
      });
    const organizationId = await mkOrg("org-rest", { metaMessaging: opts?.metaModule ?? true });
    const otherOrgId = await mkOrg("org-outra", { metaMessaging: true });
    const userId = await ctx.db.insert("users", {});
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Agente", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("apiKeys", {
      organizationId, teamMemberId: memberId, name: "k", keyHash, isActive: true, createdAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const waId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Oficial", status: "active",
      phoneNumberId: "pn_1", accessTokenEncrypted: "enc:tok", accessTokenLast4: "1234", appSecretEncrypted: "enc:app",
      verifyToken: "vt", displayPhoneNumber: "+55 85 3333-4444", createdAt: now, updatedAt: now,
    } as any);
    const connectionId = await ctx.db.insert("metaConnections", {
      organizationId, authMethod: "facebook_login", tokenKind: "page", tokenEncrypted: "enc-token", tokenLast4: "oken",
      pageId: PAGE_ID, pageName: "Loja Teste", igAccountId: IG_ID, igUsername: "lojateste", scopes: [], authState: "ok",
      connectedByMemberId: memberId, createdAt: now, updatedAt: now,
    });
    const messengerId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "messenger", displayName: "Loja Teste", status: "active", metaConnectionId: connectionId,
      messengerPageId: PAGE_ID, metaAccountLabel: "Loja Teste", createdAt: now, updatedAt: now,
    });
    const instagramId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "instagram", displayName: "Loja Teste", status: "active", metaConnectionId: connectionId,
      instagramAccountId: IG_ID, metaAccountHandle: "@lojateste", createdAt: now, updatedAt: now,
    });
    // Conta desativada não aparece.
    await ctx.db.insert("channelConfigs", {
      organizationId, channel: "instagram", displayName: "Velha", status: "disabled", createdAt: now, updatedAt: now,
    });
    const foreignConnId = await ctx.db.insert("metaConnections", {
      organizationId: otherOrgId, authMethod: "facebook_login", tokenKind: "page", tokenEncrypted: "enc-token", tokenLast4: "oken",
      pageId: "1000000000000099", pageName: "Outra", scopes: [], authState: "ok",
      connectedByMemberId: memberId, createdAt: now, updatedAt: now,
    });
    const foreignMessengerId = await ctx.db.insert("channelConfigs", {
      organizationId: otherOrgId, channel: "messenger", displayName: "Outra", status: "active", metaConnectionId: foreignConnId,
      messengerPageId: "1000000000000099", createdAt: now, updatedAt: now,
    });
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Cliente", tags: [], createdAt: now, updatedAt: now,
    } as any);
    return { organizationId, waId, messengerId, instagramId, foreignMessengerId, contactId };
  });
}

async function call(t: TestConvex<typeof schema>, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await t.fetch(path, {
    method,
    headers: { "X-API-Key": KEY, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

async function cancelPendingJobs(t: TestConvex<typeof schema>) {
  await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    for (const job of jobs) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
}

describe("GET /api/v1/conversations/channels", () => {
  test("lista WhatsApp + Meta com os campos novos, sem ids completos", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { status, json } = await call(t, "GET", "/api/v1/conversations/channels");
    expect(status).toBe(200);
    expect(json.channels).toHaveLength(3);
    const wa = json.channels.find((c: any) => c.channel === "whatsapp");
    expect(wa).toMatchObject({ id: s.waId, provider: "meta", canStart: true, transport: "meta", connected: true });
    const ig = json.channels.find((c: any) => c.channel === "instagram");
    expect(ig).toEqual({
      id: s.instagramId, channel: "instagram", transport: "instagram", accountLabel: "@lojateste", handle: "@lojateste",
      canStart: false, displayName: "@lojateste", connected: true,
    });
    const ms = json.channels.find((c: any) => c.channel === "messenger");
    expect(ms).toMatchObject({ id: s.messengerId, transport: "messenger", accountLabel: "Loja Teste", canStart: false });
    expect(ms.provider).toBeUndefined();
    const raw = JSON.stringify(json);
    for (const leak of [PAGE_ID, IG_ID, "enc-token", "enc:tok", "pn_1", "1000000000000099"]) {
      expect(raw).not.toContain(leak);
    }
  });

  test("módulo desligado: só WhatsApp", async () => {
    const t = convexTest(schema, modules);
    await seed(t, { metaModule: false });
    const { json } = await call(t, "GET", "/api/v1/conversations/channels");
    expect(json.channels.map((c: any) => c.channel)).toEqual(["whatsapp"]);
  });
});

describe("POST /start e /send-template com Meta", () => {
  test("/start com canal Meta: 400 explícito", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    for (const channelConfigId of [s.messengerId, s.instagramId]) {
      const res = await call(t, "POST", "/api/v1/conversations/start", { channelConfigId, contactId: s.contactId });
      expect(res.status).toBe(400);
      expect(res.json.error).toContain(NO_START);
    }
    const n = await t.run(async (ctx) => (await ctx.db.query("conversations").collect()).length);
    expect(n).toBe(0);
  });

  test("/send-template numa conversa Meta: 400 explícito", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const conversationId = await t.run(async (ctx) =>
      await ctx.db.insert("conversations", {
        organizationId: s.organizationId, channel: "messenger", channelConfigId: s.messengerId, status: "active", messageCount: 0,
        createdAt: Date.now(), updatedAt: Date.now(),
      } as any)
    );
    const res = await call(t, "POST", "/api/v1/conversations/send-template", {
      conversationId, templateName: "x", languageCode: "pt_BR",
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toContain(NO_START);
  });
});

describe("POST /receive com Meta", () => {
  test("só com contactId + channelConfigId da org; cria a conversa na conta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ok = await call(t, "POST", "/api/v1/conversations/receive", {
      channel: "messenger", channelConfigId: s.messengerId, contactId: s.contactId, content: "Oi!",
    });
    expect(ok.status).toBe(201);
    const conv = await t.run(async (ctx) => (await ctx.db.query("conversations").collect())[0]);
    expect(conv).toMatchObject({ channel: "messenger", channelConfigId: s.messengerId });
    await cancelPendingJobs(t);
  });

  test("recusa contactPhone, falta de channelConfigId, config de outra org ou de outro canal", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const base = { channel: "messenger", content: "Oi!" };
    const phone = await call(t, "POST", "/api/v1/conversations/receive", { ...base, channelConfigId: s.messengerId, contactPhone: "+5585999994444" });
    expect(phone.status).toBe(400);
    const noCfg = await call(t, "POST", "/api/v1/conversations/receive", { ...base, contactId: s.contactId });
    expect(noCfg.status).toBe(400);
    const foreign = await call(t, "POST", "/api/v1/conversations/receive", { ...base, contactId: s.contactId, channelConfigId: s.foreignMessengerId });
    expect(foreign.status).toBe(400);
    const wrongChannel = await call(t, "POST", "/api/v1/conversations/receive", { ...base, contactId: s.contactId, channelConfigId: s.instagramId });
    expect(wrongChannel.status).toBe(400);
    const n = await t.run(async (ctx) => (await ctx.db.query("conversations").collect()).length);
    expect(n).toBe(0);
  });
});

describe("GET /api/v1/conversations?channelConfigId=", () => {
  test("filtra pela conta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      for (const [channel, channelConfigId] of [
        ["messenger", s.messengerId], ["messenger", s.messengerId], ["instagram", s.instagramId], ["whatsapp", s.waId],
      ] as const) {
        await ctx.db.insert("conversations", { organizationId: s.organizationId, channel, channelConfigId, status: "active", messageCount: 0, createdAt: now, updatedAt: now } as any);
      }
    });
    const all = await call(t, "GET", "/api/v1/conversations");
    expect(all.json.conversations).toHaveLength(4);
    const ms = await call(t, "GET", `/api/v1/conversations?channelConfigId=${s.messengerId}`);
    expect(ms.status).toBe(200);
    expect(ms.json.conversations).toHaveLength(2);
    expect(ms.json.conversations.every((c: any) => c.channelConfigId === s.messengerId)).toBe(true);
    const ig = await call(t, "GET", `/api/v1/conversations?channel=instagram`);
    expect(ig.json.conversations).toHaveLength(1);
    const bad = await call(t, "GET", "/api/v1/conversations?channel=sms");
    expect(bad.status).toBe(400);
  });
});
