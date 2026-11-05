/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api } from "./_generated/api";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const GW = "https://gw.example.test";

let gwCalls: { path: string; body: any }[];
let gw: { loggedIn: boolean; pairOk: boolean };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T18:00:00Z"));
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  gwCalls = [];
  gw = { loggedIn: false, pairOk: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      gwCalls.push({ path: url.pathname, body });
      if (url.origin !== GW) return json({ success: true, data: {} });
      if (url.pathname === "/admin/users") return json({ id: 7 });
      if (url.pathname === "/session/status") {
        return json({ success: true, data: { Connected: gw.loggedIn, LoggedIn: gw.loggedIn, Jid: gw.loggedIn ? "5511987654321:1@s.whatsapp.net" : "" } });
      }
      if (url.pathname === "/session/connect") return json({ success: true, data: { details: "ok" } });
      if (url.pathname === "/session/pairphone") {
        return gw.pairOk ? json({ code: 200, success: true, data: { LinkingCode: "ABCD1234" } }) : json({ success: false, error: "x" }, 500);
      }
      if (url.pathname === "/session/qr") return json({ success: true, data: { QRCode: "data:image/png;base64,iVBORw0KGgoAAAA=" } });
      if (url.pathname === "/admin/users") return json({ id: 7 });
      return json({ success: true, data: {} });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function seed(t: TestConvex<typeof schema>, orgSettings: Record<string, unknown> = {}) {
  const enc = await encryptSecret("tok_fake_pair");
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org-pairing",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL", ...orgSettings },
      createdAt: now,
      updatedAt: now,
    });
    const mk = async (email: string, role: "admin" | "agent") => {
      const userId = await ctx.db.insert("users", { email });
      await ctx.db.insert("teamMembers", { organizationId, userId, name: role, role, type: "human", status: "active", createdAt: now, updatedAt: now });
      return userId;
    };
    const adminUserId = await mk("admin@test.hnbcrm.com", "admin");
    const agentUserId = await mk("agent@test.hnbcrm.com", "agent");
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "Bridge",
      status: "active",
      bridgeBaseUrl: GW,
      bridgeInstanceId: "inst_pair",
      bridgeTokenEncrypted: enc,
      createdAt: now,
      updatedAt: now,
    } as never);
    return { organizationId, adminUserId, agentUserId, configId };
  });
}
const as = (t: TestConvex<typeof schema>, userId: unknown) => t.withIdentity({ subject: `${userId}|s1` });
const pairCalls = () => gwCalls.filter((c) => c.path === "/session/pairphone");

describe("startBridgePairing / pollBridgePairing", () => {
  test("código: normaliza número e chama pairphone", async () => {
    const t = convexTest(schema, modules);
    const { adminUserId, configId } = await seed(t);
    const res = await as(t, adminUserId).action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "(11) 98765-4321" });
    expect(res.state).toBe("code");
    expect(res.linkingCode).toBe("ABCD-1234");
    expect(res.attemptsLeft).toBe(2);
    expect(pairCalls()).toHaveLength(1);
    expect(JSON.stringify(pairCalls()[0]!.body)).toContain("5511987654321");
    // Código nunca vai para o doc do canal nem para a auditoria.
    const dump = await t.run(async (ctx) => JSON.stringify([await ctx.db.get(configId), await ctx.db.query("auditLogs").collect()]));
    expect(dump).not.toContain("ABCD");
    expect(dump).not.toContain("5511987654321");
    expect(dump).toContain("channel.pairing_requested");
  });

  test("código: número curto devolve erro sem chamar gateway", async () => {
    const t = convexTest(schema, modules);
    const { adminUserId, configId } = await seed(t);
    const res = await as(t, adminUserId).action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "12345" });
    expect(res.state).toBe("error");
    expect(res.error).toContain("Número inválido");
    expect(gwCalls).toHaveLength(0);
  });

  test("código: quarta tentativa na hora é recusada", async () => {
    const t = convexTest(schema, modules);
    const { adminUserId, configId } = await seed(t);
    const a = as(t, adminUserId);
    for (let i = 0; i < 3; i++) {
      const r = await a.action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "11987654321" });
      expect(r.state).toBe("code");
    }
    const qr = await a.action(api.channelConfigs.startBridgePairing, { configId, mode: "qr" });
    expect(qr.state).toBe("qr"); // QR não consome cota
    const fourth = await a.action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "11987654321" });
    expect(fourth.state).toBe("error");
    expect(fourth.error).toBe("Limite de 3 códigos por hora. Tente de novo às 16:00.");
    expect(pairCalls()).toHaveLength(3);
  });

  test("cota é compartilhada com o Telegram", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, adminUserId, configId } = await seed(t);
    const rowId = await t.run((ctx) =>
      ctx.db.insert("telegramReconnects", {
        organizationId,
        channelConfigId: configId,
        hourStart: Date.now(),
        attempts: 2,
        token: "tg-token",
        chatId: 77,
        updatedAt: Date.now(),
      }),
    );
    const a = as(t, adminUserId);
    expect((await a.action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "11987654321" })).state).toBe("code");
    expect((await a.action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "11987654321" })).state).toBe("error");
    const row = await t.run((ctx) => ctx.db.get(rowId));
    expect(row!.attempts).toBe(3);
    expect(row!.token).toBe("tg-token");
    expect(row!.chatId).toBe(77);
  });

  test("falha do gateway devolve a tentativa", async () => {
    const t = convexTest(schema, modules);
    const { adminUserId, configId } = await seed(t);
    const a = as(t, adminUserId);
    gw.pairOk = false;
    const bad = await a.action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "11987654321" });
    expect(bad.state).toBe("error");
    expect(bad.attemptsLeft).toBe(3);
    gw.pairOk = true;
    const ok = await a.action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "11987654321" });
    expect(ok.attemptsLeft).toBe(2);
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.filter((x) => (x.metadata as any)?.event === "channel.pairing_requested")).toHaveLength(1);
  });

  test("canal já conectado não gasta cota; banido e Telegram em curso são recusados", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, adminUserId, configId } = await seed(t);
    const a = as(t, adminUserId);
    gw.loggedIn = true;
    const c = await a.action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "11987654321" });
    expect(c.state).toBe("connected");
    const row = await t.run((ctx) => ctx.db.query("telegramReconnects").first());
    expect(row!.attempts).toBe(0);
    expect(pairCalls()).toHaveLength(0);
    gw.loggedIn = false;
    await t.run((ctx) => ctx.db.patch(configId, { bridgeSessionState: "banned" } as never));
    const banned = await a.action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "11987654321" });
    expect(banned.state).toBe("error");
    await t.run((ctx) => ctx.db.patch(configId, { bridgeSessionState: "logged_out" } as never));
    await t.run((ctx) => ctx.db.patch(row!._id, { token: "tg", until: Date.now() + 60_000 }));
    const busy = await a.action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "11987654321" });
    expect(busy.error).toContain("Telegram");
    expect(pairCalls()).toHaveLength(0);
    void organizationId;
  });

  test("poll nunca pede código novo", async () => {
    const t = convexTest(schema, modules);
    const { adminUserId, configId } = await seed(t);
    const res = await as(t, adminUserId).action(api.channelConfigs.pollBridgePairing, { configId, mode: "code" });
    expect(res.state).toBe("code");
    expect(res.linkingCode).toBeUndefined();
    expect(pairCalls()).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("telegramReconnects").collect())).toHaveLength(0);
  });

  test("conectado grava bridgePhone e claim", async () => {
    const t = convexTest(schema, modules);
    const { adminUserId, configId } = await seed(t);
    gw.loggedIn = true;
    const res = await as(t, adminUserId).action(api.channelConfigs.pollBridgePairing, { configId, mode: "code" });
    expect(res.state).toBe("connected");
    expect(res.displayPhoneNumber).toBe("+5511987654321");
    const cfg = await t.run((ctx) => ctx.db.get(configId));
    expect(cfg!.bridgePhone).toBe("5511987654321");
    expect(cfg!.bridgeSessionState).toBe("connected");
    vi.runAllTimers();
  });

  test("membro sem settings:manage é recusado", async () => {
    const t = convexTest(schema, modules);
    const { agentUserId, configId } = await seed(t);
    await expect(
      as(t, agentUserId).action(api.channelConfigs.startBridgePairing, { configId, mode: "code", phone: "11987654321" }),
    ).rejects.toThrow();
    await expect(as(t, agentUserId).action(api.channelConfigs.pollBridgePairing, { configId, mode: "qr" })).rejects.toThrow();
    expect(gwCalls).toHaveLength(0);
  });
});

describe("provisionBridgeChannel sem webhookUrl", () => {
  test("provision sem webhookUrl usa CONVEX_SITE_URL", async () => {
    vi.stubEnv("WA_BRIDGE_HMAC_SECRET", "fake-hmac-secret-with-at-least-32-chars!");
    vi.stubEnv("CONVEX_SITE_URL", "https://deploy.convex.site/");
    const t = convexTest(schema, modules);
    const { organizationId, adminUserId } = await seed(t);
    const a = as(t, adminUserId);
    const args = { organizationId, displayName: "P", bridgeBaseUrl: GW, adminToken: "admin_fake" };
    await a.action(api.channelConfigs.provisionBridgeChannel, args);
    const prov = gwCalls.find((c) => c.path === "/admin/users")!;
    expect(prov.body.webhook).toBe("https://deploy.convex.site/webhooks/bridge");
    vi.stubEnv("CONVEX_SITE_URL", "");
    await expect(a.action(api.channelConfigs.provisionBridgeChannel, args)).rejects.toThrow(/CONVEX_SITE_URL/);
  });
});
