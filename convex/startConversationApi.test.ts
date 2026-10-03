/// <reference types="vite/client" />
/**
 * REST "nova conversa" (`GET /api/v1/conversations/channels` e
 * `POST /api/v1/conversations/start`): o MESMO núcleo da UI
 * (`startConversation.ts`), com o ator vindo da API key.
 *
 * Trava: (1) a lista de canais é allowlist — nenhum token/URL/instância sai;
 * (2) no bridge o número passa pelo gateway (`/user/check` + `/user/lid`) e a
 * grafia canônica é adotada; (3) Meta recusa texto livre; (4) opt-out = 409 e
 * só passa com `optOutAck`; (5) RBAC: a chave de quem só tem `inbox:view_own`
 * lista canais mas não inicia conversa. Nenhuma mensagem real sai.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";
import { phoneLookupCandidates } from "./lib/startConversation";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const NOW = Date.UTC(2026, 9, 2, 15, 0);
const TEST_KEY = btoa("A".repeat(32));

const AGENT_KEY = "hnb_test_start_agent_1";
const VIEWER_KEY = "hnb_test_start_viewer_2";
const NOCONTACT_KEY = "hnb_test_start_nocontact_3";

/** wuzapi fake: só as grafias em `registered` têm conta (o /user/lid responde só a real). */
function wuzapi(registered: string[]) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(String(url));
      const lid = /\/user\/lid\/(\d+)$/.exec(String(url));
      if (lid) {
        const ok = registered.includes(lid[1]);
        return new Response(
          JSON.stringify(ok ? { code: 200, success: true, data: { jid: `${lid[1]}@s.whatsapp.net`, lid: "1800@lid" } } : { code: 404, success: false, error: "LID not found" }),
          { status: ok ? 200 : 404, headers: { "Content-Type": "application/json" } }
        );
      }
      const body = init?.body ? JSON.parse(String(init.body)) : { Phone: [] };
      // Como o gateway real de 03/10: "sim" para as duas grafias, com LID.
      const users = (body.Phone as string[]).map((q) => {
        const hit = registered.find((r) => phoneLookupCandidates(q).includes(r));
        return hit ? { Query: q, IsInWhatsapp: true, JID: "1800@lid" } : { Query: q, IsInWhatsapp: false, JID: "" };
      });
      return new Response(JSON.stringify({ code: 200, success: true, data: { Users: users } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return urls;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  wuzapi(["558181392929", "5585999994444", "5585988887777"]);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function seed(t: TestConvex<typeof schema>) {
  const bridgeToken = await encryptSecret("fake-bridge-token");
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org", slug: "org-start-api",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now, updatedAt: now,
    });
    const mk = async (name: string, permissions?: any) => {
      const userId = await ctx.db.insert("users", {});
      return await ctx.db.insert("teamMembers", {
        organizationId, userId, name, role: "agent", type: "human", status: "active",
        ...(permissions ? { permissions } : {}),
        createdAt: now, updatedAt: now,
      });
    };
    const agentId = await mk("Agente");
    const viewerId = await mk("Leitor", {
      leads: "view_all", contacts: "view", inbox: "view_own", tasks: "view_all", reports: "view",
      team: "none", settings: "none", auditLogs: "none", apiKeys: "none", campaigns: "view",
    });
    const noContactId = await mk("Sem contatos", {
      leads: "edit_own", contacts: "view", inbox: "reply", tasks: "view_all", reports: "view",
      team: "none", settings: "none", auditLogs: "none", apiKeys: "none", campaigns: "view",
    });
    for (const [key, member] of [[AGENT_KEY, agentId], [VIEWER_KEY, viewerId], [NOCONTACT_KEY, noContactId]] as const) {
      await ctx.db.insert("apiKeys", {
        organizationId, teamMemberId: member, name: key, keyHash: await sha256Hex(key), isActive: true, createdAt: now,
      });
    }
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    await ctx.db.insert("stages", { organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    const bridgeId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge", displayName: "Bridge", status: "active",
      bridgeBaseUrl: "https://wuzapi.example.com", bridgeInstanceId: "inst_secret_id", bridgeTokenEncrypted: bridgeToken,
      bridgeTokenLast4: "oken", bridgeSessionState: "connected", bridgePhone: "5585911112222",
      createdAt: now, updatedAt: now,
    } as any);
    const metaId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Oficial", status: "active",
      phoneNumberId: "pn_1", accessTokenEncrypted: "enc:tok", accessTokenLast4: "1234", appSecretEncrypted: "enc:app",
      verifyToken: "vt", displayPhoneNumber: "+55 85 3333-4444", createdAt: now, updatedAt: now,
    } as any);
    await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge", displayName: "Desligado", status: "disabled", createdAt: now, updatedAt: now,
    } as any);
    return { organizationId, agentId, bridgeId, metaId };
  });
}

async function call(t: TestConvex<typeof schema>, key: string, method: "GET" | "POST", path: string, body?: unknown) {
  const res = await t.fetch(path, {
    method,
    headers: { "X-API-Key": key, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, json };
}

describe("GET /api/v1/conversations/channels", () => {
  test("devolve só os números ativos, com a allowlist de campos", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const { status, json } = await call(t, AGENT_KEY, "GET", "/api/v1/conversations/channels");
    expect(status).toBe(200);
    expect(json.channels).toHaveLength(2);
    const bridge = json.channels.find((c: any) => c.provider === "bridge");
    expect(bridge).toEqual({
      id: s.bridgeId, provider: "bridge", displayName: "Bridge",
      phoneDisplay: expect.any(String), connected: true, sessionState: "connected",
    });
    const meta = json.channels.find((c: any) => c.provider === "meta");
    expect(Object.keys(meta).sort()).toEqual(["connected", "displayName", "id", "phoneDisplay", "provider"]);
    const raw = JSON.stringify(json);
    for (const leak of ["wuzapi.example.com", "inst_secret_id", "enc:tok", "pn_1", "Token", "vt\""]) {
      expect(raw).not.toContain(leak);
    }
  });

  test("chave só com inbox:view_own lista (200) mas não inicia (403)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    expect((await call(t, VIEWER_KEY, "GET", "/api/v1/conversations/channels")).status).toBe(200);
    const res = await call(t, VIEWER_KEY, "POST", "/api/v1/conversations/start", { channelConfigId: s.bridgeId, phone: "85 99999-4444" });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("Permissão insuficiente");
    const n = await t.run(async (ctx) => (await ctx.db.query("contacts").collect()).length);
    expect(n).toBe(0);
  });
});

describe("POST /api/v1/conversations/start", () => {
  test("bridge: checa no gateway, adota a grafia real e cria contato/lead/conversa/mensagem", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const urls = wuzapi(["558181392929"]);
    const { status, json } = await call(t, AGENT_KEY, "POST", "/api/v1/conversations/start", {
      channelConfigId: s.bridgeId, phone: "(81) 98139-2929", firstName: "Rejane", content: "Olá! Tudo bem?",
    });
    expect(status).toBe(201);
    expect(json).toMatchObject({
      success: true, verified: true, canonicalPhone: "558181392929",
      createdContact: true, createdLead: true, createdConversation: true,
      unarchived: false, channelSwitched: false, phoneChanged: false,
    });
    expect(json.messageId).toBeTruthy();
    expect(urls.some((u) => u.endsWith("/user/check"))).toBe(true);
    expect(urls.some((u) => u.includes("/user/lid/"))).toBe(true);
    const state = await t.run(async (ctx) => ({
      contact: await ctx.db.get(json.contactId),
      lead: await ctx.db.get(json.leadId),
      message: await ctx.db.get(json.messageId),
    }));
    expect((state.contact as any).phone).toBe("558181392929");
    expect((state.contact as any).firstName).toBe("Rejane");
    expect((state.lead as any).assignedTo).toBe(s.agentId);
    expect((state.message as any)).toMatchObject({ direction: "outbound", senderId: s.agentId, content: "Olá! Tudo bem?" });

    // Idempotente: de novo, reaproveita tudo.
    const again = await call(t, AGENT_KEY, "POST", "/api/v1/conversations/start", { channelConfigId: s.bridgeId, phone: "81 8139-2929" });
    expect(again.status).toBe(201);
    expect(again.json).toMatchObject({ conversationId: json.conversationId, createdContact: false, createdLead: false, createdConversation: false });
  });

  test("Meta + content → 400 sem gravar nada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const res = await call(t, AGENT_KEY, "POST", "/api/v1/conversations/start", { channelConfigId: s.metaId, phone: "85 98888-7777", content: "oi" });
    expect(res.status).toBe(400);
    expect(res.json.code).toBe(400);
    expect(res.json.error).toMatch(/template/i);
    expect(await t.run(async (ctx) => (await ctx.db.query("contacts").collect()).length)).toBe(0);
  });

  test("opt-out → 409 com optOut:true; com optOutAck → 201", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("optOuts", { organizationId: s.organizationId, phone: "5585999994444", source: "manual", createdAt: Date.now() } as any);
    });
    const first = await call(t, AGENT_KEY, "POST", "/api/v1/conversations/start", { channelConfigId: s.bridgeId, phone: "85 99999-4444" });
    expect(first.status).toBe(409);
    expect(first.json).toMatchObject({ code: 409, optOut: true });
    expect(first.json.error).not.toMatch(/^OPT_OUT/);
    expect(first.json.error).toMatch(/não receber mensagens/);
    const ok = await call(t, AGENT_KEY, "POST", "/api/v1/conversations/start", { channelConfigId: s.bridgeId, phone: "85 99999-4444", optOutAck: true });
    expect(ok.status).toBe(201);
    expect(ok.json.success).toBe(true);
  });

  test("telefone inválido e número sem WhatsApp → 400 com a mensagem PT-BR", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const bad = await call(t, AGENT_KEY, "POST", "/api/v1/conversations/start", { channelConfigId: s.bridgeId, phone: "123" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toMatch(/telefone/i);
    const none = await call(t, AGENT_KEY, "POST", "/api/v1/conversations/start", { channelConfigId: s.bridgeId, phone: "85 97777-0000" });
    expect(none.status).toBe(400);
    expect(none.json.error).toBe("Este número não tem WhatsApp — confira os dígitos");
    const missing = await call(t, AGENT_KEY, "POST", "/api/v1/conversations/start", { phone: "85 99999-4444" });
    expect(missing.status).toBe(400);
  });

  test("membro sem contacts:edit não cria contato novo (403)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const res = await call(t, NOCONTACT_KEY, "POST", "/api/v1/conversations/start", { channelConfigId: s.bridgeId, phone: "85 99999-4444" });
    expect(res.status).toBe(403);
    expect(res.json.error).toBe("Permissão insuficiente para criar contatos");
  });

  test("chave com permissões próprias mais restritas que o membro vale como teto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const key = (await ctx.db.query("apiKeys").collect()).find((k) => k.name === AGENT_KEY)!;
      await ctx.db.patch(key._id, {
        permissions: {
          leads: "edit_own", contacts: "view", inbox: "reply", tasks: "view_all", reports: "view",
          team: "none", settings: "none", auditLogs: "none", apiKeys: "none", campaigns: "view",
        },
      } as any);
    });
    const res = await call(t, AGENT_KEY, "POST", "/api/v1/conversations/start", { channelConfigId: s.bridgeId, phone: "85 99999-4444" });
    expect(res.status).toBe(403);
  });
});
