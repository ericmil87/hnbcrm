/// <reference types="vite/client" />
/**
 * Falha de envio do bridge por número com a grafia errada (caso real: contato
 * 5531990001234, conta registrada como 553190001234, `no LID found`):
 * classificação do erro, self-heal UMA vez por mensagem, retry com teto,
 * marcador "sem WhatsApp" + gate dos envios automáticos, aceite do envio manual,
 * "Tentar novamente" manual e a op de reparo. Nenhuma rede real: `fetch` é um
 * wuzapi falso.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { DEFAULT_PERMISSIONS } from "./lib/permissions";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TEST_KEY = btoa("A".repeat(32));
const BASE = "https://wuzapi.example.com";

const WRONG = "5531990001234"; // 13 dígitos (grafia errada)
const REAL = "553190001234"; // 12 dígitos (registrada)
const NO_LID = `error sending message: no LID found for ${WRONG}@s.whatsapp.net from server`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 9, 15, 0));
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

type GwOpts = {
  /** Grafia registrada no WhatsApp (undefined = nenhuma). */
  registered?: string;
  /** Sobrescreve a resposta do envio; recebe o telefone e o nº da tentativa. */
  send?: (phone: string, n: number) => Response | Promise<Response> | null;
  checkDown?: boolean;
};
function gateway(opts: GwOpts = {}) {
  const sends: string[] = [];
  const checks: string[][] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith("/chat/send/text")) {
      sends.push(body.Phone);
      const custom = opts.send?.(body.Phone, sends.length);
      if (custom) return custom;
      if (opts.registered && body.Phone === opts.registered) {
        return json(200, { code: 200, success: true, data: { Id: `3EB0${sends.length}`, Details: "Sent" } });
      }
      return json(500, { code: 500, success: false, error: `error sending message: no LID found for ${body.Phone}@s.whatsapp.net from server` });
    }
    if (url.endsWith("/user/check")) {
      checks.push(body.Phone);
      if (opts.checkDown) return json(500, { code: 500, success: false, error: "gateway down" });
      const first = (body.Phone as string[])[0];
      return json(200, {
        code: 200,
        success: true,
        data: {
          Users: [
            opts.registered
              ? { Query: first, IsInWhatsapp: true, JID: "161495166009388@lid" }
              : { Query: first, IsInWhatsapp: false, JID: "" },
          ],
        },
      });
    }
    const m = url.match(/\/user\/lid\/(\d+)$/);
    if (m) {
      if (opts.registered && m[1] === opts.registered) {
        return json(200, { code: 200, success: true, data: { jid: `${opts.registered}@s.whatsapp.net`, lid: "161495166009388@lid" } });
      }
      return json(404, { code: 404, success: false, error: "LID not found" });
    }
    return json(200, { code: 200, success: true, data: {} });
  });
  return { fn, sends, checks };
}

async function seed(t: TestConvex<typeof schema>, opts: { phone?: string } = {}) {
  const s = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org", slug: "org-heal", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "admin@teste.com" });
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    const viewerUserId = await ctx.db.insert("users", { email: "viewer@teste.com" });
    await ctx.db.insert("teamMembers", {
      organizationId, userId: viewerUserId, name: "Viewer", role: "agent", type: "human", status: "active",
      permissions: { ...DEFAULT_PERMISSIONS.agent, inbox: "view_all" }, createdAt: now, updatedAt: now,
    });
    const aiId = await ctx.db.insert("teamMembers", {
      organizationId, name: "IA", role: "ai", type: "ai", status: "active", createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Vendas", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
    });
    const phone = opts.phone ?? WRONG;
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: "Maria", phone, whatsappNumber: phone, tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Maria", contactId, boardId, stageId, value: 0, currency: "BRL", priority: "medium",
      temperature: "cold", tags: [], customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    // Org de fora (isolamento)
    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Outra", slug: "outra-heal", settings: { timezone: "America/Sao_Paulo", currency: "BRL" }, createdAt: now, updatedAt: now,
    });
    const otherUserId = await ctx.db.insert("users", { email: "outro@teste.com" });
    await ctx.db.insert("teamMembers", {
      organizationId: otherOrgId, userId: otherUserId, name: "Outro", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now,
    });
    return { organizationId, userId, adminId, viewerUserId, aiId, contactId, leadId, otherUserId };
  });
  const configId = await t
    .withIdentity({ subject: `${s.userId}|s1` })
    .action(api.channelConfigs.createChannelConfig, {
      organizationId: s.organizationId,
      channel: "whatsapp",
      provider: "bridge",
      displayName: "Número",
      bridgeBaseUrl: BASE,
      bridgeInstanceId: "inst",
      bridgeToken: "tok",
    });
  await t.run(async (ctx) => ctx.db.patch(configId, { bridgeSessionState: "connected", status: "active" }));
  const conversationId = await t.run(async (ctx) => {
    const now = Date.now();
    return await ctx.db.insert("conversations", {
      organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: configId,
      status: "active", messageCount: 0, createdAt: now, updatedAt: now,
    });
  });
  return { ...s, configId, conversationId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

/** Mensagem humana "automática" (sem aceite): passa pelo mesmo gate do dispatch. */
async function sendAs(t: TestConvex<typeof schema>, s: Seed, memberId: Id<"teamMembers">, content = "Olá!") {
  return await t.mutation(internal.conversations.internalSendMessage, {
    conversationId: s.conversationId,
    content,
    teamMemberId: memberId,
  });
}
/** Envio automático simulado: sem aceite, sem "digitando…" (que travaria o relógio falso). */
async function sendAutomated(t: TestConvex<typeof schema>, s: Seed, memberId: Id<"teamMembers"> = s.adminId) {
  return await t.run(async (ctx) => {
    const messageId = await ctx.db.insert("messages", {
      organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
      senderId: memberId, senderType: "human", content: "Automática", contentType: "text", isInternal: false,
      createdAt: Date.now(),
    });
    const conversation = (await ctx.db.get(s.conversationId))!;
    const { scheduleOutboundDispatch } = await import("./lib/outboundDispatch");
    await scheduleOutboundDispatch(ctx, conversation, messageId);
    return messageId;
  });
}
const drain = async (t: TestConvex<typeof schema>) => {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
};
const msg = (t: TestConvex<typeof schema>, id: Id<"messages">) => t.run((ctx) => ctx.db.get(id));
const contact = (t: TestConvex<typeof schema>, s: Seed) => t.run((ctx) => ctx.db.get(s.contactId));
const admin = (t: TestConvex<typeof schema>, s: Seed) => t.withIdentity({ subject: `${s.userId}|s1` });

describe("self-heal de `no LID found`", () => {
  test("outra grafia confirmada → corrige o contato e reenvia UMA vez ao número certo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ registered: REAL });
    vi.stubGlobal("fetch", gw.fn);

    const id = await sendAs(t, s, s.adminId);
    await drain(t);

    expect(gw.sends).toEqual([WRONG, REAL]);
    expect(gw.checks).toHaveLength(1);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("sent");
    expect(m.metadata?.selfHealAt).toBeTypeOf("number");
    expect(m.metadata?.numberCheck).toBe("corrected");
    const c = (await contact(t, s))!;
    expect(c.whatsappNumber).toBe(REAL);
    expect(c.phone).toBe(REAL);
    expect(c.whatsappCheck).toMatchObject({ phone: REAL, status: "verified" });

    await t.run(async (ctx) => {
      const acts = await ctx.db.query("activities").withIndex("by_lead_and_created", (q) => q.eq("leadId", s.leadId)).collect();
      const note = acts.find((a) => a.content?.includes("Número de WhatsApp corrigido"));
      expect(note).toBeTruthy();
      // telefone nunca inteiro na timeline
      expect(note!.content).not.toContain(WRONG);
      const audits = await ctx.db.query("auditLogs").collect();
      expect(audits.some((a) => a.entityType === "contact" && a.metadata?.via === "bridge_self_heal")).toBe(true);
    });
  });

  test("nunca entra em laço: a grafia corrigida também falha → falha final, 1 checagem só", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // /user/check diz que REAL existe, mas o envio continua dando no LID
    const gw = gateway({
      registered: REAL,
      send: (phone) => json(500, { success: false, error: `error sending message: no LID found for ${phone}@s.whatsapp.net from server` }),
    });
    vi.stubGlobal("fetch", gw.fn);

    const id = await sendAs(t, s, s.adminId);
    await drain(t);

    expect(gw.sends).toEqual([WRONG, REAL]);
    expect(gw.checks).toHaveLength(1);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryErrorKind).toBe("recipient_not_found");
    expect(String(m.metadata?.deliveryError)).not.toContain("no LID");
  });

  test("não está no WhatsApp → falha, marcador no contato, nenhum reenvio", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({});
    vi.stubGlobal("fetch", gw.fn);

    const id = await sendAs(t, s, s.adminId);
    await drain(t);

    expect(gw.sends).toEqual([WRONG]);
    expect(gw.checks).toHaveLength(1);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryErrorKind).toBe("recipient_not_found");
    expect(m.metadata?.numberCheck).toBe("not_on_whatsapp");
    expect(String(m.metadata?.deliveryError)).toContain("não está no WhatsApp");
    expect((await contact(t, s))!.whatsappCheck).toMatchObject({ phone: WRONG, status: "not_on_whatsapp" });
  });

  test("gateway diz que ESTE número existe mas o envio deu no LID → inconclusivo: falha, sem marcador e sem reescrita", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ registered: WRONG, send: (phone) => json(500, { success: false, error: `no LID found for ${phone}@s.whatsapp.net from server` }) });
    vi.stubGlobal("fetch", gw.fn);

    const id = await sendAs(t, s, s.adminId);
    await drain(t);

    expect(gw.sends).toEqual([WRONG]);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.numberCheck).toBe("inconclusive");
    const c = (await contact(t, s))!;
    expect(c.whatsappCheck).toBeUndefined();
    expect(c.whatsappNumber).toBe(WRONG);
  });

  test("telefone devolvido que NÃO é grafia do número perguntado (mapa de LID errado) é recusado: não reescreve nem reenvia", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const OTHER = "5511987654321";
    const gw = gateway({ registered: OTHER });
    // /user/check responde por WRONG, mas /user/lid devolve OUTRO telefone
    const base = gw.fn;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/user/lid/")) return json(200, { success: true, data: { jid: `${OTHER}@s.whatsapp.net` } });
      return base(input, init);
    }));
    const id = await sendAs(t, s, s.adminId);
    await drain(t);
    expect(gw.sends).toEqual([WRONG]);
    expect((await msg(t, id))!.deliveryStatus).toBe("failed");
    const c = (await contact(t, s))!;
    expect(c.whatsappNumber).toBe(WRONG);
    expect(c.whatsappCheck).toBeUndefined();
  });

  test("opt-out guardado na grafia REAL: o self-heal não reenvia e não reescreve o contato", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.insert("optOuts", { organizationId: s.organizationId, phone: REAL, source: "manual", createdAt: Date.now() }));
    const gw = gateway({ registered: REAL });
    vi.stubGlobal("fetch", gw.fn);
    const id = await sendAs(t, s, s.adminId);
    await drain(t);
    expect(gw.sends).toEqual([WRONG]);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(String(m.metadata?.deliveryError)).toContain("opt-out");
    expect((await contact(t, s))!.whatsappNumber).toBe(WRONG);
  });

  test("checagem indisponível → falha como está, sem adivinhar nem marcar o contato", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ registered: REAL, checkDown: true });
    vi.stubGlobal("fetch", gw.fn);

    const id = await sendAs(t, s, s.adminId);
    await drain(t);

    expect(gw.sends).toEqual([WRONG]);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryErrorKind).toBe("recipient_not_found");
    expect(m.metadata?.numberCheck).toBe("unavailable");
    expect((await contact(t, s))!.whatsappNumber).toBe(WRONG);
    expect((await contact(t, s))!.whatsappCheck).toBeUndefined();
  });
});

describe("retry automático com teto", () => {
  test("transient: 3 envios no total, depois falha com a classe gravada; sem checagem de número", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({
      send: () => json(500, { success: false, error: "failed to get user info for [x] to fill LID cache: info query timed out" }),
    });
    vi.stubGlobal("fetch", gw.fn);

    const id = await sendAs(t, s, s.adminId);
    await drain(t);

    expect(gw.sends).toHaveLength(3);
    expect(gw.checks).toHaveLength(0);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryErrorKind).toBe("transient");
    expect(String(m.metadata?.deliveryError)).toContain("tentativas esgotadas");
    expect(m.metadata?.bridgeRetry).toBeUndefined();
  });

  test("transient que se resolve na 2ª tentativa → enviada, e a falha não vira atividade nem repasse", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({
      send: (phone, n) =>
        n === 1
          ? json(500, { success: false, error: "failed to get user info for [x] to fill LID cache: websocket disconnected" })
          : json(200, { success: true, data: { Id: "3EB0OK" } }),
    });
    vi.stubGlobal("fetch", gw.fn);

    const id = await sendAs(t, s, s.adminId);
    // Antes do atraso do retry: ainda pendente, com o estado de retry visível
    await vi.advanceTimersByTimeAsync(1000);
    await t.finishInProgressScheduledFunctions();
    const pending = (await msg(t, id))!;
    expect(pending.deliveryStatus).toBeUndefined();
    expect(pending.metadata?.bridgeRetry).toMatchObject({ kind: "transient", attempt: 1 });
    await drain(t);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("sent");
    expect(gw.sends).toHaveLength(2);
    await t.run(async (ctx) => {
      const acts = await ctx.db.query("activities").withIndex("by_lead_and_created", (q) => q.eq("leadId", s.leadId)).collect();
      expect(acts.some((a) => a.content?.includes("Falha ao enviar"))).toBe(false);
    });
  });

  test("rate_limited: no máximo UM retry", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ send: () => json(500, { success: false, error: "info query returned status 429: rate-overlimit" }) });
    vi.stubGlobal("fetch", gw.fn);

    const id = await sendAs(t, s, s.adminId);
    await drain(t);

    expect(gw.sends).toHaveLength(2);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryErrorKind).toBe("rate_limited");
  });

  test("sessão e payload inválido (permanent) e erro desconhecido NÃO reenviam", async () => {
    for (const [status, error, kind] of [
      [401, "session not connected", "session"],
      [400, "could not decode payload", "permanent"],
      [418, "algo que nunca vimos", "permanent"],
    ] as const) {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      const gw = gateway({ send: () => json(status, { success: false, error }) });
      vi.stubGlobal("fetch", gw.fn);
      const id = await sendAs(t, s, s.adminId);
      await drain(t);
      expect(gw.sends).toHaveLength(1);
      const m = (await msg(t, id))!;
      expect(m.deliveryStatus).toBe("failed");
      expect(m.metadata?.deliveryErrorKind).toBe(kind);
    }
  });

  test("AMBÍGUO (timeout / 5xx / 200 sem id / EOF) NÃO reenvia sozinho: pode já ter sido entregue", async () => {
    for (const make of [
      () => json(500, { success: false, error: "timed out waiting for message send response" }),
      () => json(504, {}),
      () => json(200, { success: true, data: {} }),
    ]) {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      const gw = gateway({ send: () => make() });
      vi.stubGlobal("fetch", gw.fn);
      const id = await sendAs(t, s, s.adminId);
      await drain(t);
      expect(gw.sends).toHaveLength(1);
      const m = (await msg(t, id))!;
      expect(m.deliveryStatus).toBe("failed");
      expect(m.metadata?.deliveryErrorKind).toBe("ambiguous");
      expect(m.metadata?.bridgeRetry).toBeUndefined();
    }
    // erro de rede do fetch (EOF) também
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ send: () => { throw new Error("unexpected EOF"); } });
    vi.stubGlobal("fetch", gw.fn);
    const id = await sendAs(t, s, s.adminId);
    await drain(t);
    expect(gw.sends).toHaveLength(1);
    expect((await msg(t, id))!.metadata?.deliveryErrorKind).toBe("ambiguous");
  });

  test("welcome: o repasse humano só nasce DEPOIS dos retries, não na 1ª falha transitória", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ send: () => json(500, { success: false, error: 'failed to get user info for [x] to fill LID cache: timed out' }) });
    vi.stubGlobal("fetch", gw.fn);
    const id = await t.run(async (ctx) => {
      const now = Date.now();
      const messageId = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "Oi", contentType: "text", isInternal: false,
        metadata: { inboundWelcome: { leadId: s.leadId } }, createdAt: now,
      });
      const conversation = (await ctx.db.get(s.conversationId))!;
      const { scheduleOutboundDispatch } = await import("./lib/outboundDispatch");
      await scheduleOutboundDispatch(ctx, conversation, messageId);
      return messageId;
    });
    await vi.advanceTimersByTimeAsync(1000);
    await t.finishInProgressScheduledFunctions();
    const handoffsNow = await t.run((ctx) => ctx.db.query("handoffs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(handoffsNow).toHaveLength(0);
    await drain(t);
    expect(gw.sends.length).toBe(3);
    expect((await msg(t, id))!.deliveryStatus).toBe("failed");
    const handoffs = await t.run((ctx) => ctx.db.query("handoffs").withIndex("by_organization", (q) => q.eq("organizationId", s.organizationId)).collect());
    expect(handoffs).toHaveLength(1);
  });
});

describe("marcador `sem WhatsApp`: gate dos automáticos e aceite do manual", () => {
  async function markNotOnWhatsapp(t: TestConvex<typeof schema>, s: Seed, phone = WRONG) {
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappCheck: { phone, status: "not_on_whatsapp", checkedAt: Date.now() } }));
  }

  test("envio automático (IA) a contato marcado: falha visível, sem rede", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markNotOnWhatsapp(t, s);
    const gw = gateway({ registered: WRONG });
    vi.stubGlobal("fetch", gw.fn);

    const id = await sendAutomated(t, s);
    await drain(t);

    expect(gw.fn).not.toHaveBeenCalled();
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryErrorKind).toBe("recipient_not_found");
    await t.run(async (ctx) => {
      const acts = await ctx.db.query("activities").withIndex("by_lead_and_created", (q) => q.eq("leadId", s.leadId)).collect();
      expect(acts.some((a) => a.content?.includes("Falha ao enviar"))).toBe(true);
    });
  });

  test("marcador de OUTRO número (contato editado) não bloqueia", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markNotOnWhatsapp(t, s, "5531900000000");
    const gw = gateway({ registered: WRONG });
    vi.stubGlobal("fetch", gw.fn);
    const id = await sendAutomated(t, s);
    await drain(t);
    expect((await msg(t, id))!.deliveryStatus).toBe("sent");
  });

  test("envio manual: sem aceite recusa com NOT_ON_WHATSAPP; com aceite envia e audita", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markNotOnWhatsapp(t, s);
    const gw = gateway({ registered: WRONG });
    vi.stubGlobal("fetch", gw.fn);

    await expect(
      admin(t, s).mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: "oi" })
    ).rejects.toThrow(/NOT_ON_WHATSAPP:/);
    expect(
      await t.run((ctx) => ctx.db.query("messages").withIndex("by_conversation", (q) => q.eq("conversationId", s.conversationId)).collect())
    ).toHaveLength(0);

    const id = await admin(t, s).mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId,
      content: "oi",
      notOnWhatsappAck: true,
    });
    await drain(t);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("sent");
    expect(m.metadata?.notOnWhatsappAck).toMatchObject({ by: s.adminId });
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((a) => a.entityId === id && a.metadata?.notOnWhatsappAck === true && a.severity === "high" && a.metadata?.via === "app")).toBe(true);
  });

  test("encaminhar para contato marcado também exige o aceite; nota interna nunca", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markNotOnWhatsapp(t, s);
    vi.stubGlobal("fetch", gateway({ registered: WRONG }).fn);
    const source = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "texto", contentType: "text", isInternal: false, createdAt: Date.now(),
      })
    );
    await expect(
      admin(t, s).mutation(api.conversations.forwardMessage, { messageId: source, targetConversationId: s.conversationId })
    ).rejects.toThrow(/NOT_ON_WHATSAPP:/);
    await admin(t, s).mutation(api.conversations.forwardMessage, {
      messageId: source, targetConversationId: s.conversationId, notOnWhatsappAck: true,
    });
    await admin(t, s).mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId, content: "nota", isInternal: true,
    });
  });

  test("mensagem recebida do contato e edição do número derrubam o marcador", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await markNotOnWhatsapp(t, s);
    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: s.configId,
      content: "oi, sou eu", externalId: "wamid.IN1", skipAiEnqueue: true,
    });
    expect((await contact(t, s))!.whatsappCheck).toBeUndefined();

    await markNotOnWhatsapp(t, s);
    // Só trocar a grafia (13 → 12 dígitos) NÃO derruba "sem WhatsApp": o gateway
    // perguntou as duas de uma vez.
    await admin(t, s).mutation(api.contacts.updateContact, { contactId: s.contactId, whatsappNumber: REAL });
    expect((await contact(t, s))!.whatsappCheck).toMatchObject({ status: "not_on_whatsapp", phone: WRONG });
    // Número DIFERENTE: pergunta nova.
    await admin(t, s).mutation(api.contacts.updateContact, { contactId: s.contactId, whatsappNumber: "5511987654321" });
    expect((await contact(t, s))!.whatsappCheck).toBeUndefined();
  });
});

describe("Tentar novamente (retryFailedMessage)", () => {
  async function failedMessage(
    t: TestConvex<typeof schema>,
    s: Seed,
    metadata: Record<string, unknown> = {},
    extra: Record<string, unknown> = {}
  ) {
    return await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "Olá", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata: { deliveryError: "x", deliveryErrorKind: "transient", ...metadata },
        createdAt: Date.now(), ...extra,
      })
    );
  }
  const retry = (t: TestConvex<typeof schema>, s: Seed, messageId: Id<"messages">) =>
    admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId });

  test("sucesso (falha transitória): volta a pendente, reenvia pelo dispatch, audita e conta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: REAL });
    const gw = gateway({ registered: REAL });
    vi.stubGlobal("fetch", gw.fn);
    const id = await failedMessage(t, s);

    const r = await retry(t, s, id);
    expect(r).toEqual({ ok: true, correctedNumber: false });
    const pending = (await msg(t, id))!;
    expect(pending.deliveryStatus).toBeUndefined();
    expect(pending.metadata?.deliveryError).toBeUndefined();
    expect(pending.metadata?.manualRetries).toBe(1);
    expect(gw.checks).toHaveLength(0); // erro transitório não pergunta ao gateway

    await drain(t);
    expect((await msg(t, id))!.deliveryStatus).toBe("sent");
    expect(gw.sends).toEqual([REAL]);
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((a) => a.entityId === id && a.metadata?.manualRetry === 1 && a.actorId === s.adminId)).toBe(true);
    const acts = await t.run((ctx) => ctx.db.query("activities").withIndex("by_lead_and_created", (q) => q.eq("leadId", s.leadId)).collect());
    expect(acts.some((a) => a.content?.includes("Reenvio manual"))).toBe(true);
  });

  test("recipient_not_found com outra grafia no gateway: corrige o número e reenvia ao certo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ registered: REAL });
    vi.stubGlobal("fetch", gw.fn);
    const id = await failedMessage(t, s, { deliveryErrorKind: "recipient_not_found", selfHealAt: 1 });

    expect(await retry(t, s, id)).toEqual({ ok: true, correctedNumber: true });
    await drain(t);
    expect(gw.checks).toHaveLength(1);
    expect(gw.sends).toEqual([REAL]);
    expect((await contact(t, s))!.whatsappNumber).toBe(REAL);
    expect((await msg(t, id))!.deliveryStatus).toBe("sent");
  });

  test("recipient_not_found e o gateway diz que não existe: recusa, marca o contato, nada sai", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({});
    vi.stubGlobal("fetch", gw.fn);
    const id = await failedMessage(t, s, { deliveryErrorKind: "recipient_not_found" });

    const r = await retry(t, s, id);
    expect(r).toMatchObject({ ok: false, reason: "not_on_whatsapp" });
    expect((r as { message: string }).message).toContain("não está no WhatsApp");
    expect((await contact(t, s))!.whatsappCheck?.status).toBe("not_on_whatsapp");
    await drain(t);
    expect(gw.sends).toHaveLength(0);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.manualRetries).toBeUndefined();
  });

  test("contato marcado 'sem WhatsApp' (mesmo com erro antigo transitório): refaz a checagem; sem confirmação não reenvia", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappCheck: { phone: WRONG, status: "not_on_whatsapp", checkedAt: Date.now() - 20 * 60_000 } }));
    const down = gateway({ registered: REAL, checkDown: true });
    vi.stubGlobal("fetch", down.fn);
    const id = await failedMessage(t, s);
    expect(await retry(t, s, id)).toMatchObject({ ok: false, reason: "check_unavailable" });
    expect(down.sends).toHaveLength(0);

    // Dentro da espera mínima: nem tenta consultar de novo
    expect(await retry(t, s, id)).toMatchObject({ ok: false, reason: "check_wait" });
    expect(down.checks).toHaveLength(1);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    // Gateway de volta e confirma outra grafia: corrige e libera
    const up = gateway({ registered: REAL });
    vi.stubGlobal("fetch", up.fn);
    expect(await retry(t, s, id)).toEqual({ ok: true, correctedNumber: true });
    await drain(t);
    expect(up.sends).toEqual([REAL]);
  });

  test("AMBÍGUO exige o aceite de 'pode já ter sido entregue'; com aceite reenvia e audita", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: REAL });
    const gw = gateway({ registered: REAL });
    vi.stubGlobal("fetch", gw.fn);
    const id = await failedMessage(t, s, { deliveryErrorKind: "ambiguous" });
    const mid = await failedMessage(t, s, { deliveryErrorKind: "permanent", deliveryError: "Falha no envio pelo bridge: Gateway não retornou o id da mensagem" });

    for (const m of [id, mid]) {
      const r = await retry(t, s, m);
      expect(r).toMatchObject({ ok: false, reason: "maybe_delivered" });
      expect((await msg(t, m))!.deliveryStatus).toBe("failed");
    }
    const list = (await admin(t, s).query(api.conversations.getMessages, { conversationId: s.conversationId })) as any[];
    expect(list.find((m) => m._id === id).deliveryRetry.requiresDeliveredAck).toBe(true);
    expect(gw.sends).toHaveLength(0);

    const ok = await admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId: id, maybeDeliveredAck: true });
    expect(ok).toMatchObject({ ok: true });
    await drain(t);
    expect(gw.sends).toEqual([REAL]);
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.some((a) => a.entityId === id && a.metadata?.maybeDeliveredAck === true)).toBe(true);
  });

  test("consultas ao gateway têm teto e espera: cliques repetidos ou simultâneos não repetem /user/check", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ checkDown: true });
    vi.stubGlobal("fetch", gw.fn);
    const id = await failedMessage(t, s, { deliveryErrorKind: "recipient_not_found" });

    // Dois cliques ao mesmo tempo: uma só consulta
    const [a, b] = await Promise.all([retry(t, s, id), retry(t, s, id)]);
    const reasons = [a, b].map((r) => (r.ok ? "ok" : r.reason)).sort();
    expect(reasons).toEqual(["check_unavailable", "check_wait"]);
    expect(gw.checks).toHaveLength(1);
    const waiting = (await retry(t, s, id)) as { ok: false; retryAfter?: number };
    expect(waiting.retryAfter).toBeGreaterThan(Date.now());
    expect(gw.checks).toHaveLength(1);

    // Passada a espera, mais duas consultas e acabou o teto
    for (let i = 0; i < 2; i++) {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(await retry(t, s, id)).toMatchObject({ ok: false, reason: "check_unavailable" });
    }
    expect(gw.checks).toHaveLength(3);
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await retry(t, s, id)).toMatchObject({ ok: false, reason: "limit" });
    expect(gw.checks).toHaveLength(3);
    const list = (await admin(t, s).query(api.conversations.getMessages, { conversationId: s.conversationId })) as any[];
    expect(list.find((m) => m._id === id).deliveryRetry).toMatchObject({ canRetry: false, numberChecks: 3, maxNumberChecks: 3 });
  });

  test("contato marcado há menos de 10 min: recusa sem nenhuma chamada ao gateway", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappCheck: { phone: WRONG, status: "not_on_whatsapp", checkedAt: Date.now() - 60_000 } }));
    const gw = gateway({ registered: REAL });
    vi.stubGlobal("fetch", gw.fn);
    const id = await failedMessage(t, s, { deliveryErrorKind: "recipient_not_found" });
    expect(await retry(t, s, id)).toMatchObject({ ok: false, reason: "not_on_whatsapp" });
    expect(gw.fn).not.toHaveBeenCalled();
  });

  test("recusas: not_failed, in_flight, limit, opt_out, not_sendable (nota interna / entrada)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: REAL });
    vi.stubGlobal("fetch", gateway({ registered: REAL }).fn);

    const sent = await failedMessage(t, s, {}, { deliveryStatus: "sent", externalId: "wamid.X" });
    expect(await retry(t, s, sent)).toMatchObject({ ok: false, reason: "not_failed" });

    const pending = await failedMessage(t, s, {}, { deliveryStatus: undefined });
    expect(await retry(t, s, pending)).toMatchObject({ ok: false, reason: "in_flight" });

    const capped = await failedMessage(t, s, { manualRetries: 3 });
    expect(await retry(t, s, capped)).toMatchObject({ ok: false, reason: "limit" });

    const note = await failedMessage(t, s, {}, { isInternal: true, direction: "internal" });
    expect(await retry(t, s, note)).toMatchObject({ ok: false, reason: "not_sendable" });

    const ok = await failedMessage(t, s);
    await t.run((ctx) => ctx.db.insert("optOuts", { organizationId: s.organizationId, phone: REAL, source: "manual", createdAt: Date.now() }));
    expect(await retry(t, s, ok)).toMatchObject({ ok: false, reason: "opt_out" });
  });

  test("teto: depois de 3 reenvios manuais, o 4º é recusado e a contagem sobe só quando reenvia", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: REAL });
    const gw = gateway({ send: () => json(400, { success: false, error: "could not decode payload" }) });
    vi.stubGlobal("fetch", gw.fn);
    const id = await failedMessage(t, s, { deliveryErrorKind: "permanent", deliveryPreSend: true });
    for (let i = 1; i <= 3; i++) {
      expect(await retry(t, s, id)).toMatchObject({ ok: true });
      await drain(t);
      expect((await msg(t, id))!.deliveryStatus).toBe("failed");
      expect((await msg(t, id))!.metadata?.manualRetries).toBe(i);
    }
    expect(await retry(t, s, id)).toMatchObject({ ok: false, reason: "limit" });
    expect(gw.sends).toHaveLength(3);
  });

  test("canal desconectado → channel_unavailable (não gasta tentativa)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: REAL });
    await t.run((ctx) => ctx.db.patch(s.configId, { bridgeSessionState: "logged_out" }));
    const id = await failedMessage(t, s);
    expect(await retry(t, s, id)).toMatchObject({ ok: false, reason: "channel_unavailable" });
    expect((await msg(t, id))!.metadata?.manualRetries).toBeUndefined();
  });

  test("RBAC: sem inbox:reply lança; membro de OUTRA org lança; mensagem inexistente → not_found", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: REAL });
    vi.stubGlobal("fetch", gateway({ registered: REAL }).fn);
    const id = await failedMessage(t, s);

    await expect(
      t.withIdentity({ subject: `${s.viewerUserId}|s1` }).action(api.messageRetry.retryFailedMessage, { messageId: id })
    ).rejects.toThrow(/Permissão insuficiente/);
    await expect(
      t.withIdentity({ subject: `${s.otherUserId}|s1` }).action(api.messageRetry.retryFailedMessage, { messageId: id })
    ).rejects.toThrow();
    await expect(t.action(api.messageRetry.retryFailedMessage, { messageId: id })).rejects.toThrow();
    expect((await msg(t, id))!.deliveryStatus).toBe("failed");

    const gone = await t.run(async (ctx) => {
      const tmp = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, direction: "outbound", senderType: "human",
        content: "x", contentType: "text", isInternal: false, createdAt: Date.now(),
      });
      await ctx.db.delete(tmp);
      return tmp;
    });
    expect(await retry(t, s, gone)).toMatchObject({ ok: false, reason: "not_found" });
  });

  test("getMessages expõe `deliveryRetry` para a UI decidir o botão", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await failedMessage(t, s, { deliveryErrorKind: "recipient_not_found", manualRetries: 1 });
    const list = (await admin(t, s).query(api.conversations.getMessages, { conversationId: s.conversationId })) as any[];
    const row = list.find((m) => m._id === id);
    expect(row.deliveryRetry).toMatchObject({
      canRetry: true, requiresCheck: true, manualRetries: 1, maxManualRetries: 3, errorKind: "recipient_not_found", autoRetrying: false,
    });
  });
});

describe("ops: reparo de números `no LID found`", () => {
  async function failedNoLid(t: TestConvex<typeof schema>, s: Seed) {
    return await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "Olá", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata: { deliveryError: `Falha no envio pelo bridge: ${NO_LID}` }, createdAt: Date.now(),
      })
    );
  }

  test("dryRun (padrão) só LISTA candidatos: nenhuma consulta ao gateway, telefone mascarado, nada gravado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ registered: REAL });
    vi.stubGlobal("fetch", gw.fn);
    await failedNoLid(t, s);

    const out = await t.action(internal.opsBridgeNumbers.internalRepairNoLidNumbers, { organizationId: s.organizationId });
    expect(out.dryRun).toBe(true);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ outcome: "not_checked", messages: 1 });
    expect(gw.fn).not.toHaveBeenCalled();
    expect(JSON.stringify(out)).not.toContain(WRONG);
    expect((await contact(t, s))!.whatsappNumber).toBe(WRONG);

    // lookup:true consulta, mas continua sem gravar nem reenviar
    const p = t.action(internal.opsBridgeNumbers.internalRepairNoLidNumbers, { organizationId: s.organizationId, lookup: true });
    await vi.runAllTimersAsync();
    const looked = await p;
    expect(looked.rows[0]).toMatchObject({ outcome: "on_whatsapp_other_spelling" });
    expect(JSON.stringify(looked)).not.toContain(REAL);
    expect(gw.sends).toHaveLength(0);
    expect((await contact(t, s))!.whatsappNumber).toBe(WRONG);
  });

  test("contato já marcado/verificado para o número atual não é consultado de novo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappCheck: { phone: WRONG, status: "not_on_whatsapp", checkedAt: Date.now() } }));
    await failedNoLid(t, s);
    vi.stubGlobal("fetch", gateway({ registered: REAL }).fn);
    const out = await t.action(internal.opsBridgeNumbers.internalRepairNoLidNumbers, { organizationId: s.organizationId });
    expect(out.rows).toHaveLength(0);
  });

  test("dryRun:false corrige o número (ou marca sem WhatsApp), audita uma vez e NÃO reenvia", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ registered: REAL });
    vi.stubGlobal("fetch", gw.fn);
    const id = await failedNoLid(t, s);

    const p = t.action(internal.opsBridgeNumbers.internalRepairNoLidNumbers, { organizationId: s.organizationId, dryRun: false });
    await vi.runAllTimersAsync();
    const out = await p;
    expect(out.rows[0].applied).toBe("corrected");
    expect((await contact(t, s))!.whatsappNumber).toBe(REAL);
    expect(gw.sends).toHaveLength(0);
    expect((await msg(t, id))!.deliveryStatus).toBe("failed");
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.filter((a) => a.metadata?.op === "opsBridgeNumbers:internalRepairNoLidNumbers")).toHaveLength(1);

    // Outro contato, sem WhatsApp: marcador
    const t2 = convexTest(schema, modules);
    const s2 = await seed(t2);
    vi.stubGlobal("fetch", gateway({}).fn);
    await failedNoLid(t2, s2);
    const p2 = t2.action(internal.opsBridgeNumbers.internalRepairNoLidNumbers, { organizationId: s2.organizationId, dryRun: false });
    await vi.runAllTimersAsync();
    expect((await p2).rows[0].applied).toBe("marked");
    expect((await contact(t2, s2))!.whatsappCheck?.status).toBe("not_on_whatsapp");
  });
});

describe("ops: redispatch de saída travada respeita o retry automático", () => {
  test("mensagem esperando retry (bridgeRetry) ou no meio do self-heal não é redispatchada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ registered: WRONG });
    vi.stubGlobal("fetch", gw.fn);
    const mk = (metadata?: Record<string, unknown>) =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
          senderId: s.adminId, senderType: "human", content: "x", contentType: "text", isInternal: false,
          ...(metadata ? { metadata } : {}), createdAt: Date.now(),
        })
      );
    const retrying = await mk({ bridgeRetry: { kind: "transient", attempt: 1, nextAt: Date.now() + 60_000 } });
    const healing = await mk({ selfHealAt: Date.now() });
    const plain = await mk();
    const out = await t.mutation(internal.opsMigration.internalRedispatchStuckOutbound, { sinceMs: 3_600_000, dryRun: false });
    const action = (id: Id<"messages">) => out.find((r) => r.messageId === id)?.action;
    expect(action(retrying)).toBe("skipped_in_retry");
    expect(action(healing)).toBe("skipped_in_retry");
    expect(action(plain)).toBe("redispatched");
  });
});

describe("canônico fora das grafias do número (pure)", () => {
  test("isSpellingOfSameNumber só aceita as grafias BR do próprio número", async () => {
    const { isSpellingOfSameNumber } = await import("./lib/whatsappCheck");
    expect(isSpellingOfSameNumber(WRONG, REAL)).toBe(true);
    expect(isSpellingOfSameNumber(REAL, WRONG)).toBe(true);
    expect(isSpellingOfSameNumber(WRONG, WRONG)).toBe(true);
    expect(isSpellingOfSameNumber(WRONG, "5511987654321")).toBe(false);
    expect(isSpellingOfSameNumber(WRONG, "161495166009388")).toBe(false);
    expect(isSpellingOfSameNumber("15550000001", "15550000002")).toBe(false);
  });
});

describe("B1: reenvio manual só sem aceite quando a falha é provadamente anterior ao envio", () => {
  const failedWith = (t: TestConvex<typeof schema>, s: Seed, metadata: Record<string, unknown>) =>
    t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "Olá", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata, createdAt: Date.now(),
      })
    );

  test("sem classe gravada (legado / Meta 5xx / rede) pede o aceite, inclusive 'context deadline exceeded' e 'fetch failed'", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: REAL });
    vi.stubGlobal("fetch", gateway({ registered: REAL }).fn);
    for (const deliveryError of ["Falha no envio pelo bridge: context deadline exceeded", "fetch failed", "Falha no envio (HTTP 502)"]) {
      const id = await failedWith(t, s, { deliveryError });
      const r = await admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId: id });
      expect(r).toMatchObject({ ok: false, reason: "maybe_delivered" });
    }
  });

  test("recusa local, 4xx do gateway e 4xx da Meta (pré-envio) NÃO pedem aceite", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: REAL });
    vi.stubGlobal("fetch", gateway({ registered: REAL }).fn);
    for (const meta of [
      { deliveryError: "Anexo indisponível", deliveryErrorKind: "permanent", deliveryPreSend: true },
      { deliveryError: "Fora da janela (131026)", deliveryErrorCode: 131026, deliveryPreSend: true },
      { deliveryError: "x", deliveryErrorKind: "transient" },
    ]) {
      const id = await failedWith(t, s, meta);
      const r = await admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId: id });
      expect(r).toMatchObject({ ok: true });
    }
  });

  test("integração: 200 com id em grafia desconhecida e desconexão pós-envio ficam `ambiguous` (não session/permanent)", async () => {
    for (const [status, body, error] of [
      [200, { success: true, data: { Details: "Sent", MessageId: "3EB0X" } }, "Sent"],
      [500, { success: false, error: "websocket disconnected before message send returned response" }, "disconnected"],
    ] as const) {
      const t = convexTest(schema, modules);
      const s = await seed(t);
      const gw = gateway({ send: () => json(status, body) });
      vi.stubGlobal("fetch", gw.fn);
      const id = await sendAs(t, s, s.adminId);
      await drain(t);
      expect(gw.sends).toHaveLength(1);
      const m = (await msg(t, id))!;
      expect(m.metadata?.deliveryErrorKind, error).toBe("ambiguous");
      expect(m.metadata?.deliveryPreSend).toBeUndefined();
    }
  });

  test("4xx do gateway é gravado como pré-envio (sem aceite no reenvio)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ send: () => json(400, { success: false, error: "could not decode payload" }) });
    vi.stubGlobal("fetch", gw.fn);
    const id = await sendAs(t, s, s.adminId);
    await drain(t);
    const m = (await msg(t, id))!;
    expect(m.metadata).toMatchObject({ deliveryErrorKind: "permanent", deliveryPreSend: true });
  });
});

describe("B2: orçamento de consultas POR CONTATO", () => {
  const failedNotFound = (t: TestConvex<typeof schema>, s: Seed) =>
    t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "Olá", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata: { deliveryErrorKind: "recipient_not_found", deliveryError: "x" }, createdAt: Date.now(),
      })
    );
  const retry = (t: TestConvex<typeof schema>, s: Seed, messageId: Id<"messages">) =>
    admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId });

  test("10 mensagens falhas do mesmo contato, em paralelo: UMA rodada de consulta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ checkDown: true });
    vi.stubGlobal("fetch", gw.fn);
    const ids = [];
    for (let i = 0; i < 10; i++) ids.push(await failedNotFound(t, s));
    const results = await Promise.all(ids.map((id) => retry(t, s, id)));
    expect(gw.checks).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "check_wait")).toHaveLength(9);
  });

  test("ao longo do tempo: no máximo 3 consultas por dia por número, mesmo com mensagens diferentes", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ checkDown: true });
    vi.stubGlobal("fetch", gw.fn);
    const reasons: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await failedNotFound(t, s);
      const r = await retry(t, s, id);
      reasons.push(r.ok ? "ok" : r.reason);
      vi.setSystemTime(Date.now() + 11 * 60_000);
    }
    expect(gw.checks).toHaveLength(3);
    expect(reasons.slice(0, 3)).toEqual(["check_unavailable", "check_unavailable", "check_unavailable"]);
    expect(reasons.slice(3)).toEqual(["limit", "limit", "limit"]);
  });

  test("várias falhas no LID do mesmo contato: o 1º self-heal consulta e marca; as demais falham sem consultar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({});
    vi.stubGlobal("fetch", gw.fn);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await sendAs(t, s, s.adminId, `m${i}`));
    await drain(t);
    expect(gw.checks).toHaveLength(1);
    for (const id of ids) expect((await msg(t, id))!.deliveryStatus).toBe("failed");
  });

  test("envio manual COM aceite a contato marcado: falha de no LID não dispara nova consulta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappCheck: { phone: WRONG, status: "not_on_whatsapp", checkedAt: Date.now() - 3 * 3600_000 } }));
    const gw = gateway({});
    vi.stubGlobal("fetch", gw.fn);
    const id = await admin(t, s).mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId, content: "oi", notOnWhatsappAck: true,
    });
    await drain(t);
    expect(gw.sends).toEqual([WRONG]); // tentou (o humano aceitou)
    expect(gw.checks).toHaveLength(0); // mas sem rodada de consultas
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.numberCheck).toBe("not_on_whatsapp");
  });
});

describe("B3: mensagem de campanha não tem 'Tentar novamente'", () => {
  test("metadata.campaign: recusa not_sendable e a UI não mostra o botão", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: REAL });
    vi.stubGlobal("fetch", gateway({ registered: REAL }).fn);
    const id = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "Promo", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata: { deliveryErrorKind: "transient", campaign: { campaignId: "x", recipientId: "y" } },
        createdAt: Date.now(),
      })
    );
    const r = await admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId: id });
    expect(r).toMatchObject({ ok: false, reason: "not_sendable" });
    expect((r as { message: string }).message).toContain("campanha");
    const list = (await admin(t, s).query(api.conversations.getMessages, { conversationId: s.conversationId })) as any[];
    expect(list.find((m) => m._id === id).deliveryRetry.canRetry).toBe(false);
  });
});

describe("stuck-outbound: estado de retry velho não protege", () => {
  test("bridgeRetry/selfHealAt fora da janela de graça → volta a ser redispatchado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    vi.stubGlobal("fetch", gateway({ registered: WRONG }).fn);
    const old = Date.now() - 2 * 3600_000;
    const mk = (metadata: Record<string, unknown>) =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
          senderId: s.adminId, senderType: "human", content: "x", contentType: "text", isInternal: false, metadata,
          createdAt: Date.now(),
        })
      );
    const staleRetry = await mk({ bridgeRetry: { kind: "transient", attempt: 1, nextAt: old } });
    const staleHeal = await mk({ selfHealAt: old });
    const out = await t.mutation(internal.opsMigration.internalRedispatchStuckOutbound, { sinceMs: 3_600_000, dryRun: false });
    expect(out.find((r) => r.messageId === staleRetry)?.action).toBe("redispatched");
    expect(out.find((r) => r.messageId === staleHeal)?.action).toBe("redispatched");
  });
});

describe("opt-out com contato sem DDI", () => {
  test("contato `11987654321` e opt-out `5511987654321`: o reenvio manual recusa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: "11987654321" });
    await t.run((ctx) => ctx.db.insert("optOuts", { organizationId: s.organizationId, phone: "5511987654321", source: "manual", createdAt: Date.now() }));
    vi.stubGlobal("fetch", gateway({}).fn);
    const id = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "Olá", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata: { deliveryErrorKind: "transient" }, createdAt: Date.now(),
      })
    );
    const r = await admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId: id });
    expect(r).toMatchObject({ ok: false, reason: "opt_out" });
  });
});

describe("B2: marcador e orçamento valem para as DUAS grafias do número", () => {
  const retry = (t: TestConvex<typeof schema>, s: Seed, messageId: Id<"messages">) =>
    admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId });
  const failedNotFound = (t: TestConvex<typeof schema>, s: Seed) =>
    t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "Olá", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata: { deliveryErrorKind: "recipient_not_found", deliveryError: "x" }, createdAt: Date.now(),
      })
    );

  test("editar 13 → 12 dígitos mantém o marcador: manual pede aceite e automático continua bloqueado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({});
    vi.stubGlobal("fetch", gw.fn);
    await sendAs(t, s, s.adminId);
    await drain(t);
    expect((await contact(t, s))!.whatsappCheck?.status).toBe("not_on_whatsapp");

    await admin(t, s).mutation(api.contacts.updateContact, { contactId: s.contactId, whatsappNumber: REAL, phone: REAL });
    await expect(
      admin(t, s).mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: "oi" })
    ).rejects.toThrow(/NOT_ON_WHATSAPP:/);
    const before = gw.sends.length;
    await sendAutomated(t, s);
    await drain(t);
    expect(gw.sends).toHaveLength(before); // o automático não sai para a outra grafia
  });

  test("A → B → A e 13 ↔ 12 dígitos não devolvem o orçamento: no máximo 3 consultas por dia no contato", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ checkDown: true });
    vi.stubGlobal("fetch", gw.fn);
    const numbers = [WRONG, REAL, WRONG, REAL, WRONG, REAL];
    for (const n of numbers) {
      await t.run((ctx) => ctx.db.patch(s.contactId, { phone: n, whatsappNumber: n }));
      const id = await failedNotFound(t, s);
      await retry(t, s, id);
      vi.setSystemTime(Date.now() + 11 * 60_000);
    }
    expect(gw.checks).toHaveLength(3);
  });

  test("troca de grafia logo após uma consulta respeita os 10 minutos", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ checkDown: true });
    vi.stubGlobal("fetch", gw.fn);
    await retry(t, s, await failedNotFound(t, s));
    await t.run((ctx) => ctx.db.patch(s.contactId, { phone: REAL, whatsappNumber: REAL }));
    const r = await retry(t, s, await failedNotFound(t, s));
    expect(r).toMatchObject({ ok: false, reason: "check_wait" });
    expect(gw.checks).toHaveLength(1);
  });
});

describe("item 1: retry com 'o gateway diz que existe' para o MESMO número que falhou", () => {
  test("recusa (check_unavailable), sem marcador verified e sem reenvio", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ registered: WRONG });
    vi.stubGlobal("fetch", gw.fn);
    const id = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "x", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata: { deliveryErrorKind: "recipient_not_found" }, createdAt: Date.now(),
      })
    );
    const r = await admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId: id });
    expect(r).toMatchObject({ ok: false, reason: "check_unavailable" });
    expect(gw.sends).toHaveLength(0);
    expect((await contact(t, s))!.whatsappCheck).toBeUndefined();
  });
});

describe("item 3: recipient_not_found seguidos sem marcador", () => {
  test("depois da 2ª falha o automático para; envio manual pede aceite; uma resposta do contato libera", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // checagem fora do ar: nunca marca
    const gw = gateway({ checkDown: true });
    vi.stubGlobal("fetch", gw.fn);
    for (let i = 0; i < 2; i++) {
      await sendAutomated(t, s);
      await drain(t);
      vi.setSystemTime(Date.now() + 11 * 60_000);
    }
    expect((await contact(t, s))!.whatsappCheck).toBeUndefined();
    expect((await contact(t, s))!.whatsappFails?.count).toBe(2);
    const sends = gw.sends.length;
    const blocked = await sendAutomated(t, s);
    await drain(t);
    expect(gw.sends).toHaveLength(sends);
    const m = (await msg(t, blocked))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryErrorKind).toBe("recipient_not_found");

    await expect(
      admin(t, s).mutation(api.conversations.sendMessage, { conversationId: s.conversationId, content: "oi" })
    ).rejects.toThrow(/NOT_ON_WHATSAPP:/);

    await t.mutation(internal.conversations.internalReceiveMessage, {
      organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: s.configId,
      content: "oi", externalId: "wamid.IN2", skipAiEnqueue: true,
    });
    expect((await contact(t, s))!.whatsappFails).toBeUndefined();
  });

  test("envio aceito pelo gateway zera o contador", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappFails: { phone: WRONG, count: 1, at: Date.now() } }));
    vi.stubGlobal("fetch", gateway({ registered: WRONG }).fn);
    await sendAs(t, s, s.adminId);
    await drain(t);
    expect((await contact(t, s))!.whatsappFails).toBeUndefined();
  });
});

describe("item 4/7/8/9: nextAt real, metadados velhos, Meta e retryAfter", () => {
  test("bridgeRetry.nextAt vem do slot REAL agendado (pacing), não de now + delay", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // cursor do canal já empurrado para 1 h à frente
    await t.run((ctx) => ctx.db.insert("channelPacing", { organizationId: s.organizationId, channelConfigId: s.configId, nextDispatchAt: Date.now() + 3_600_000 }));
    const gw = gateway({ send: () => json(500, { success: false, error: "failed to get user info for [x] to fill LID cache: timed out" }) });
    vi.stubGlobal("fetch", gw.fn);
    const id = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "x", contentType: "text", isInternal: false, createdAt: Date.now(),
      })
    );
    await t.action(internal.whatsapp.internalDispatchMessage, { messageId: id });
    const m = (await msg(t, id))!;
    const nextAt = (m.metadata?.bridgeRetry as { nextAt: number }).nextAt;
    expect(nextAt).toBeGreaterThan(Date.now() + 3_000_000);
  });

  test("nova falha apaga classe/código/pré-envio velhos (flag antigo não dispensa o aceite depois)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const id = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "x", contentType: "text", isInternal: false,
        metadata: { deliveryErrorKind: "permanent", deliveryPreSend: true, deliveryErrorCode: 131026 }, createdAt: Date.now(),
      })
    );
    await t.mutation(internal.whatsapp.internalMarkDispatchFailed, { messageId: id, detail: "algo sem classe" });
    const m = (await msg(t, id))!;
    expect(m.metadata?.deliveryErrorKind).toBeUndefined();
    expect(m.metadata?.deliveryPreSend).toBeUndefined();
    expect(m.metadata?.deliveryErrorCode).toBeUndefined();
    const { needsDeliveredAck } = await import("./lib/messageRetry");
    expect(needsDeliveredAck(m.metadata)).toBe(true);
  });

  test("retryAfter só aparece quando o reenvio exigiria consulta (requiresCheck)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const mk = (kind: string) =>
      t.run((ctx) =>
        ctx.db.insert("messages", {
          organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
          senderId: s.adminId, senderType: "human", content: "x", contentType: "text", isInternal: false,
          deliveryStatus: "failed", metadata: { deliveryErrorKind: kind, lastNumberCheckAt: Date.now(), numberChecks: 1 }, createdAt: Date.now(),
        })
      );
    const transient = await mk("transient");
    const notFound = await mk("recipient_not_found");
    const list = (await admin(t, s).query(api.conversations.getMessages, { conversationId: s.conversationId })) as any[];
    expect(list.find((m) => m._id === transient).deliveryRetry.retryAfter).toBeUndefined();
    expect(list.find((m) => m._id === notFound).deliveryRetry.retryAfter).toBeGreaterThan(Date.now());
  });
});

describe("item 5/6: aceite só de pessoa", () => {
  test("membro de IA não dá notOnWhatsappAck nem maybeDeliveredAck", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappCheck: { phone: WRONG, status: "not_on_whatsapp", checkedAt: Date.now() - 3 * 3600_000 } }));
    vi.stubGlobal("fetch", gateway({ registered: WRONG }).fn);
    await expect(
      t.mutation(internal.conversations.internalSendMessage, {
        conversationId: s.conversationId, content: "oi", teamMemberId: s.aiId, notOnWhatsappAck: true,
      })
    ).rejects.toThrow(/Somente uma pessoa/);
    // humano com o mesmo aceite passa (a regra é do TIPO do membro)
    await expect(
      t.mutation(internal.conversations.internalSendMessage, {
        conversationId: s.conversationId, content: "oi", teamMemberId: s.adminId, notOnWhatsappAck: true,
      })
    ).resolves.toBeTruthy();
  });

  test("aceite de reenvio possivelmente entregue audita com severidade alta", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: REAL });
    vi.stubGlobal("fetch", gateway({ registered: REAL }).fn);
    const id = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "x", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata: { deliveryErrorKind: "ambiguous" }, createdAt: Date.now(),
      })
    );
    await admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId: id, maybeDeliveredAck: true });
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.find((a) => a.entityId === id && a.metadata?.maybeDeliveredAck === true)?.severity).toBe("high");
  });
});

describe("item 2: ops respeita o orçamento e para no 1º check_failed", () => {
  test("gateway fora do ar: 1 consulta e a página para; contato sem vaga é pulado", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ checkDown: true });
    vi.stubGlobal("fetch", gw.fn);
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "x", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata: { deliveryErrorKind: "recipient_not_found" }, createdAt: Date.now(),
      })
    );
    const run = async () => {
      const p = t.action(internal.opsBridgeNumbers.internalRepairNoLidNumbers, { organizationId: s.organizationId, dryRun: false });
      await vi.runAllTimersAsync();
      return await p;
    };
    const first = await run();
    expect(first.rows[0].outcome).toBe("check_failed");
    expect(gw.checks).toHaveLength(1);
    // mesmo contato logo depois: sem vaga no orçamento do contato
    const second = await run();
    expect(second.rows[0].outcome).toBe("skipped_budget");
    expect(gw.checks).toHaveLength(1);
  });
});

describe("item 10: Nova conversa responde do marcador recente, sem gateway", () => {
  test("contato marcado há < 10 min (qualquer grafia): not_on_whatsapp sem chamar o gateway", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappCheck: { phone: WRONG, status: "not_on_whatsapp", checkedAt: Date.now() - 60_000 } }));
    const gw = gateway({ registered: REAL });
    vi.stubGlobal("fetch", gw.fn);
    const r = await admin(t, s).action(api.startConversation.checkWhatsappNumber, {
      organizationId: s.organizationId, channelConfigId: s.configId, phone: REAL,
    });
    expect(r).toMatchObject({ status: "not_on_whatsapp", fromMarker: true });
    expect(gw.fn).not.toHaveBeenCalled();
    // passada a janela, volta a consultar
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const again = await admin(t, s).action(api.startConversation.checkWhatsappNumber, {
      organizationId: s.organizationId, channelConfigId: s.configId, phone: REAL,
    });
    expect(again.status).toBe("on_whatsapp");
    expect(gw.checks).toHaveLength(1);
  });
});

describe("contador whatsappFails: não bloqueia contato saudável (rodada 4)", () => {
  const retry = (t: TestConvex<typeof schema>, s: Seed, messageId: Id<"messages">) =>
    admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId });

  test("sequência: 2 falhas sem marcador → depois de >10 min o retry confirma a outra grafia, corrige, zera o contador e ENVIA", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const down = gateway({ registered: REAL, checkDown: true });
    vi.stubGlobal("fetch", down.fn);
    const first = await sendAs(t, s, s.adminId, "primeira");
    await drain(t); // no LID + checagem fora do ar → contador 1
    const second = await sendAutomated(t, s);
    await drain(t); // sem vaga no orçamento → contador 2
    expect((await contact(t, s))!.whatsappFails?.count).toBe(2);
    expect((await contact(t, s))!.whatsappCheck).toBeUndefined();
    expect((await msg(t, second))!.deliveryStatus).toBe("failed");

    vi.setSystemTime(Date.now() + 11 * 60_000);
    const up = gateway({ registered: REAL });
    vi.stubGlobal("fetch", up.fn);
    const r = await retry(t, s, first);
    expect(r).toEqual({ ok: true, correctedNumber: true });
    await drain(t);
    expect(up.sends).toEqual([REAL]);
    expect((await msg(t, first))!.deliveryStatus).toBe("sent");
    const c = (await contact(t, s))!;
    expect(c.whatsappFails).toBeUndefined();
    expect(c.whatsappNumber).toBe(REAL);
  });

  test("retry SEM checagem positiva em contato bloqueado pelo contador: recusa antes, sem gastar tentativa nem despachar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappFails: { phone: WRONG, count: 2, at: Date.now() } }));
    const gw = gateway({ checkDown: true });
    vi.stubGlobal("fetch", gw.fn);
    const id = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "x", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata: { deliveryErrorKind: "transient" }, createdAt: Date.now(),
      })
    );
    const r = await retry(t, s, id);
    expect(r).toMatchObject({ ok: false, reason: "check_unavailable" });
    await drain(t);
    expect(gw.sends).toHaveLength(0);
    const m = (await msg(t, id))!;
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.manualRetries).toBeUndefined();
    expect(m.metadata?.notOnWhatsappAck).toBeUndefined();
  });

  test("editar só a grafia zera o contador (o `no LID` era daquele JID)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappFails: { phone: WRONG, count: 2, at: Date.now() } }));
    await admin(t, s).mutation(api.contacts.updateContact, { contactId: s.contactId, whatsappNumber: REAL });
    expect((await contact(t, s))!.whatsappFails).toBeUndefined();
  });

  test("a correção do self-heal zera o contador", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappFails: { phone: WRONG, count: 1, at: Date.now() } }));
    const gw = gateway({ registered: REAL });
    vi.stubGlobal("fetch", gw.fn);
    const id = await sendAs(t, s, s.adminId);
    await drain(t);
    expect((await msg(t, id))!.deliveryStatus).toBe("sent");
    expect((await contact(t, s))!.whatsappFails).toBeUndefined();
  });

  test("com o contador em 2+ e nada marcado, o self-heal AINDA consulta (envio manual com aceite) e corrige", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappFails: { phone: WRONG, count: 2, at: Date.now() } }));
    const gw = gateway({ registered: REAL });
    vi.stubGlobal("fetch", gw.fn);
    const id = await admin(t, s).mutation(api.conversations.sendMessage, {
      conversationId: s.conversationId, content: "oi", notOnWhatsappAck: true,
    });
    await drain(t);
    expect(gw.checks).toHaveLength(1);
    expect(gw.sends).toEqual([WRONG, REAL]);
    expect((await msg(t, id))!.deliveryStatus).toBe("sent");
    expect((await contact(t, s))!.whatsappFails).toBeUndefined();
  });

  test("falha recusada pelo próprio gate NÃO incrementa o contador", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappFails: { phone: WRONG, count: 2, at: Date.now() } }));
    vi.stubGlobal("fetch", gateway({ registered: REAL }).fn);
    for (let i = 0; i < 3; i++) {
      const id = await sendAutomated(t, s);
      await drain(t);
      expect((await msg(t, id))!.deliveryStatus).toBe("failed");
    }
    expect((await contact(t, s))!.whatsappFails?.count).toBe(2);
  });
});

describe("D: marcador e contador são do BRIDGE", () => {
  test("canal Meta: nem bloqueio automático nem aviso manual, e a entrega NÃO zera o contador do bridge", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const metaConfigId = await admin(t, s).action(api.channelConfigs.createChannelConfig, {
      organizationId: s.organizationId, channel: "whatsapp", displayName: "Meta", phoneNumberId: "111000111000111",
      wabaId: "222000222000222", verifyToken: "tok", appSecret: "secret-abcd", accessToken: "EAAFake",
    });
    const metaConv = await t.run((ctx) =>
      ctx.db.insert("conversations", {
        organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: metaConfigId,
        status: "active", messageCount: 0, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    await t.run((ctx) =>
      ctx.db.patch(s.contactId, {
        whatsappCheck: { phone: WRONG, status: "not_on_whatsapp", checkedAt: Date.now() - 3 * 3600_000 },
        whatsappFails: { phone: WRONG, count: 2, at: Date.now() },
      })
    );
    const fetchMock = vi.fn(async () => json(200, { messages: [{ id: "wamid.META1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    // manual sem aceite: permitido (Meta)
    const id = await admin(t, s).mutation(api.conversations.sendMessage, { conversationId: metaConv, content: "oi" });
    await drain(t);
    expect((await msg(t, id))!.deliveryStatus).toBe("sent");
    expect(fetchMock).toHaveBeenCalled();
    // automático (sem aceite): também sai
    const auto = await t.run(async (ctx) => {
      const mid = await ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: metaConv, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "auto", contentType: "text", isInternal: false, createdAt: Date.now(),
      });
      const { scheduleOutboundDispatch } = await import("./lib/outboundDispatch");
      await scheduleOutboundDispatch(ctx, (await ctx.db.get(metaConv))!, mid);
      return mid;
    });
    await drain(t);
    expect((await msg(t, auto))!.deliveryStatus).toBe("sent");
    const c = (await contact(t, s))!;
    expect(c.whatsappFails?.count).toBe(2); // entrega pela Meta não zera o contador do bridge
    expect(c.whatsappCheck?.status).toBe("not_on_whatsapp");
  });
});

describe("C: Nova conversa passa pelo orçamento do contato", () => {
  test("número morto COM contato: no máximo 3 consultas por dia; as demais respondem do marcador", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({});
    vi.stubGlobal("fetch", gw.fn);
    for (let i = 0; i < 5; i++) {
      await expect(
        admin(t, s).action(api.startConversation.startConversation, {
          organizationId: s.organizationId, channelConfigId: s.configId, contactId: s.contactId,
        })
      ).rejects.toThrow(/não tem WhatsApp/);
      vi.setSystemTime(Date.now() + 11 * 60_000);
    }
    expect(gw.checks).toHaveLength(3);
  });

  test("conferir + iniciar na mesma interação não gasta duas vagas do dia", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({ registered: WRONG });
    vi.stubGlobal("fetch", gw.fn);
    await admin(t, s).action(api.startConversation.checkWhatsappNumber, {
      organizationId: s.organizationId, channelConfigId: s.configId, contactId: s.contactId,
    });
    const res = await admin(t, s).action(api.startConversation.startConversation, {
      organizationId: s.organizationId, channelConfigId: s.configId, contactId: s.contactId,
    });
    expect(res.verified).toBe(true);
    expect(gw.checks).toHaveLength(2);
    expect((await contact(t, s))!.whatsappLookup?.count).toBe(2); // a rajada CONTA no teto diário
  });
});

describe("E: 'existe' para o mesmo número que deu no LID não rearma o contador", () => {
  test("mensagem C `transient`: o retry NÃO confirma o número recusado duas vezes (sem verified, sem zerar, sem reenvio)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    vi.stubGlobal("fetch", gateway({ registered: REAL, checkDown: true }).fn);
    await sendAs(t, s, s.adminId, "A");
    await drain(t);
    await sendAutomated(t, s);
    await drain(t);
    expect((await contact(t, s))!.whatsappFails?.count).toBe(2);

    const c = await t.run((ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId, direction: "outbound",
        senderId: s.adminId, senderType: "human", content: "C", contentType: "text", isInternal: false,
        deliveryStatus: "failed", metadata: { deliveryErrorKind: "transient" }, createdAt: Date.now(),
      })
    );
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const gw = gateway({ registered: WRONG }); // o gateway diz que ESTE número existe
    vi.stubGlobal("fetch", gw.fn);
    const r = await admin(t, s).action(api.messageRetry.retryFailedMessage, { messageId: c });
    expect(r).toMatchObject({ ok: false, reason: "check_unavailable" });
    await drain(t);
    expect(gw.sends).toHaveLength(0);
    const ct = (await contact(t, s))!;
    expect(ct.whatsappFails?.count).toBe(2);
    expect(ct.whatsappCheck).toBeUndefined();
    // o próximo automático continua parando no gate
    const next = await sendAutomated(t, s);
    await drain(t);
    expect((await msg(t, next))!.deliveryStatus).toBe("failed");
    expect(gw.sends).toHaveLength(0);
  });

  test("setWhatsappCheck(verified) não grava nem zera com contador > 0 (boas-vindas/campanha/Nova conversa)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappFails: { phone: WRONG, count: 2, at: Date.now() } }));
    const { setWhatsappCheck } = await import("./lib/whatsappCheck");
    await t.run((ctx) => setWhatsappCheck(ctx, s.contactId, "verified", Date.now()));
    const ct = (await contact(t, s))!;
    expect(ct.whatsappCheck).toBeUndefined();
    expect(ct.whatsappFails?.count).toBe(2);
    // sem contador, grava normalmente
    await t.run((ctx) => ctx.db.patch(s.contactId, { whatsappFails: undefined }));
    await t.run((ctx) => setWhatsappCheck(ctx, s.contactId, "verified", Date.now()));
    expect((await contact(t, s))!.whatsappCheck?.status).toBe("verified");
  });
});

describe("G: teto diário verdadeiro (rajada inclusa)", () => {
  test("no máximo 3 consultas por dia mesmo com conferir + iniciar", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const gw = gateway({});
    vi.stubGlobal("fetch", gw.fn);
    // 1ª interação: conferir + iniciar = 2 consultas (rajada); 2ª interação: só 1 cabe
    for (let i = 0; i < 4; i++) {
      await admin(t, s).action(api.startConversation.checkWhatsappNumber, {
        organizationId: s.organizationId, channelConfigId: s.configId, contactId: s.contactId,
      });
      await admin(t, s).action(api.startConversation.checkWhatsappNumber, {
        organizationId: s.organizationId, channelConfigId: s.configId, contactId: s.contactId,
      });
      vi.setSystemTime(Date.now() + 11 * 60_000);
    }
    expect(gw.checks.length).toBeLessThanOrEqual(3);
    expect(gw.checks.length).toBe(3);
  });
});
