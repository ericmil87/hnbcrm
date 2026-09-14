/// <reference types="vite/client" />
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { extractBodyText, extractHeaderFormat, countBodyParams, extractButtons } from "./whatsappTemplates";
import { buildBridgeCheckUserRequest, parseBridgeCheckUserResponse } from "./lib/bridgeSession";
import { estimateCampaignCost, loadPricing, pricePerMessage } from "./lib/whatsappPricing";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function setup() {
  return convexTest(schema, modules);
}
const asUser = (t: TestConvex<typeof schema>, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

async function seed(t: TestConvex<typeof schema>) {
  const base = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", { name: "O", slug: "o", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now });
    const adminUserId = await ctx.db.insert("users", {});
    const agentUserId = await ctx.db.insert("users", {});
    await ctx.db.insert("teamMembers", { organizationId, userId: adminUserId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now });
    await ctx.db.insert("teamMembers", { organizationId, userId: agentUserId, name: "Agente", role: "agent", type: "human", status: "active", createdAt: now, updatedAt: now });
    return { organizationId, adminUserId, agentUserId };
  });
  const configId = await asUser(t, base.adminUserId).action(api.channelConfigs.createChannelConfig, {
    organizationId: base.organizationId, channel: "whatsapp", displayName: "Meta",
    phoneNumberId: "111000111000111", wabaId: "222000222000222", verifyToken: "verify-token",
    appSecret: "fake-app-secret-abcd", accessToken: "EAAFakeAccessToken9876",
  });
  return { ...base, configId };
}

const TPL = (id: string, name: string, status = "APPROVED") => ({
  id, name, status, category: "MARKETING", language: "pt_BR", quality_score: { score: "GREEN" },
  components: [
    { type: "HEADER", format: "IMAGE" },
    { type: "BODY", text: `Oi {{1}}, ${name} com {{2}} de desconto` },
    { type: "BUTTONS", buttons: [{ type: "URL", text: "Ver", url: "https://x.com/{{1}}" }] },
  ],
});

describe("sync de templates da Meta", () => {
  test("pagina, faz upsert por metaId, remove os que sumiram, nunca devolve token", async () => {
    const t = setup();
    const s = await seed(t);
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(url);
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer EAAFakeAccessToken9876");
        if (url.includes("page2")) {
          return new Response(JSON.stringify({ data: [TPL("3", "promo_c", "PENDING")] }), { status: 200 });
        }
        return new Response(JSON.stringify({ data: [TPL("1", "promo_a"), TPL("2", "promo_b")], paging: { next: "https://graph.facebook.com/page2" } }), { status: 200 });
      })
    );
    await expect(asUser(t, s.agentUserId).action(api.whatsappTemplates.syncMetaTemplates, { channelConfigId: s.configId })).rejects.toThrow(/Permissão/);
    const res = await asUser(t, s.adminUserId).action(api.whatsappTemplates.syncMetaTemplates, { channelConfigId: s.configId });
    expect(res).toEqual({ synced: 3, removed: 0, approved: 2 });
    expect(calls).toHaveLength(2);

    const list = await asUser(t, s.agentUserId).query(api.whatsappTemplates.listTemplates, { channelConfigId: s.configId, onlyApproved: true });
    expect(list.map((x: { name: string }) => x.name)).toEqual(["promo_a", "promo_b"]);
    expect(list[0]).toMatchObject({ headerFormat: "IMAGE", bodyParamCount: 2, qualityScore: "GREEN" });
    expect(list[0].buttons[0]).toMatchObject({ type: "URL", dynamic: true });
    expect(JSON.stringify(list)).not.toMatch(/EAAFake|Encrypted/);

    // segunda sync: promo_b sumiu, promo_c aprovado
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [TPL("1", "promo_a"), TPL("3", "promo_c")] }), { status: 200 })));
    const res2 = await asUser(t, s.adminUserId).action(api.whatsappTemplates.syncMetaTemplates, { channelConfigId: s.configId });
    expect(res2).toEqual({ synced: 2, removed: 1, approved: 2 });
    const rows = await t.run((ctx) => ctx.db.query("whatsappTemplates").withIndex("by_channel_config", (q) => q.eq("channelConfigId", s.configId)).collect());
    expect(rows.map((r) => r.name).sort()).toEqual(["promo_a", "promo_c"]);
  });

  test("readMetaTier usa o campo novo do portfólio", async () => {
    const t = setup();
    const s = await seed(t);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toContain("whatsapp_business_manager_messaging_limit");
      return new Response(JSON.stringify({ whatsapp_business_manager_messaging_limit: "TIER_2K", id: "111" }), { status: 200 });
    }));
    const res = await asUser(t, s.adminUserId).action(api.whatsappTemplates.readMetaTier, { channelConfigId: s.configId });
    expect(res).toEqual({ tier: "TIER_2K", limit: 2000 });
  });

  test("helpers puros de componentes", () => {
    const c = TPL("1", "x").components;
    expect(extractBodyText(c)).toBe("Oi {{1}}, x com {{2}} de desconto");
    expect(extractHeaderFormat(c)).toBe("IMAGE");
    expect(countBodyParams(c)).toBe(2);
    expect(extractButtons(c)).toEqual([{ type: "URL", text: "Ver", url: "https://x.com/{{1}}", dynamic: true }]);
    expect(extractBodyText(null)).toBeNull();
  });
});

describe("bridge /user/check (puro)", () => {
  test("request e parse tolerante", () => {
    const req = buildBridgeCheckUserRequest({ baseUrl: "https://w.example.com/", token: "tk", phones: ["5511999990001"] });
    expect(req.url).toBe("https://w.example.com/user/check");
    expect(req.headers.token).toBe("tk");
    expect(JSON.parse(req.body!)).toEqual({ Phone: ["5511999990001"] });
    const ok = parseBridgeCheckUserResponse(true, 200, { code: 200, success: true, data: { Users: [{ Query: "5511999990001", IsInWhatsapp: true, JID: "5511999990001@s.whatsapp.net" }, { Query: "5511999990002", IsInWhatsApp: false }] } });
    expect(ok).toEqual({ ok: true, users: [{ phone: "5511999990001", onWhatsapp: true, jid: "5511999990001@s.whatsapp.net" }, { phone: "5511999990002", onWhatsapp: false }] });
    expect(parseBridgeCheckUserResponse(false, 401, { error: "unauthorized" })).toEqual({ ok: false, error: "unauthorized" });
    expect(parseBridgeCheckUserResponse(true, 200, { success: true, data: {} }).ok).toBe(false);
  });
});

describe("preço", () => {
  test("marketing/utility/serviço e override por env", () => {
    expect(pricePerMessage({ provider: "meta", category: "MARKETING" })).toBe(0.0625);
    expect(pricePerMessage({ provider: "meta", category: "utility" })).toBe(0.0068);
    expect(pricePerMessage({ provider: "meta", category: null })).toBe(0);
    expect(pricePerMessage({ provider: "bridge", category: "MARKETING" })).toBe(0);
    expect(estimateCampaignCost({ provider: "meta", category: "MARKETING", recipients: 100 })).toBe(6.25);
    expect(loadPricing('{"marketing":0.05}').marketing).toBe(0.05);
    expect(loadPricing("{bad").marketing).toBe(0.0625);
  });
});
