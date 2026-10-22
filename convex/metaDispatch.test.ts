/// <reference types="vite/client" />
/**
 * Envio Instagram/Messenger (Meta Messaging F1): porta → janela → pacing →
 * `metaMessaging.internalDispatchMessage` → Send API (fetch stubado).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";
import { scheduleOutboundDispatch } from "./lib/outboundDispatch";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const PAGE_ID = "1000000000000001";
const IG_ID = "1000000000000003";
const PSID = "1000000000000002";
const IGSID = "1000000000000004";
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  vi.stubEnv("META_MESSAGING_APP_ID", "fake-app-id");
  vi.stubEnv("META_MESSAGING_APP_SECRET", "fake-meta-app-secret");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed(
  t: TestConvex<typeof schema>,
  opts: { demo?: boolean; lastInboundAgoMs?: number | null; withWhatsapp?: boolean } = {}
) {
  const token = await encryptSecret("fake-page-token");
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        modules: { metaMessaging: true },
        ...(opts.demo ? { demoMode: true } : {}),
      },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "a@example.test" });
    const memberId = await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
      name: "Ana",
      role: "admin",
      type: "human",
      status: "active",
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
    const stageId = await ctx.db.insert("stages", {
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
    const connectionId = await ctx.db.insert("metaConnections", {
      organizationId,
      authMethod: "facebook_login",
      tokenKind: "page",
      tokenEncrypted: token,
      tokenLast4: "oken",
      pageId: PAGE_ID,
      pageName: "Página",
      igAccountId: IG_ID,
      scopes: [],
      authState: "ok",
      connectedByMemberId: memberId,
      createdAt: now,
      updatedAt: now,
    });
    const messengerId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "messenger",
      displayName: "Página",
      status: "active",
      metaConnectionId: connectionId,
      messengerPageId: PAGE_ID,
      createdAt: now,
      updatedAt: now,
    });
    const instagramId = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "instagram",
      displayName: "@conta",
      status: "active",
      metaConnectionId: connectionId,
      instagramAccountId: IG_ID,
      createdAt: now,
      updatedAt: now,
    });
    const waId = opts.withWhatsapp
      ? await ctx.db.insert("channelConfigs", {
          organizationId,
          channel: "whatsapp",
          provider: "meta",
          displayName: "WhatsApp",
          status: "active",
          phoneNumberId: "fake-phone-number-id",
          createdAt: now,
          updatedAt: now,
        })
      : null;
    // Mesmo contato com identidade nos DOIS configs: o destino é a do config da conversa.
    const contactId = await ctx.db.insert("contacts", {
      organizationId,
      firstName: "Marina",
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    for (const [channelConfigId, kind, externalId] of [
      [messengerId, "messenger", PSID],
      [instagramId, "instagram", IGSID],
    ] as const) {
      await ctx.db.insert("contactChannelIdentities", {
        organizationId,
        contactId,
        channelConfigId,
        kind,
        externalId,
        createdAt: now,
      });
    }
    const leadId = await ctx.db.insert("leads", {
      organizationId,
      title: "Marina",
      contactId,
      boardId,
      stageId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "cold",
      tags: [],
      customFields: {},
      conversationStatus: "new",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const ago = opts.lastInboundAgoMs === undefined ? 60_000 : opts.lastInboundAgoMs;
    const conv = async (channel: "instagram" | "messenger", configId: Id<"channelConfigs">) =>
      await ctx.db.insert("conversations", {
        organizationId,
        leadId,
        channel,
        channelConfigId: configId,
        channelProvider: channel,
        status: "active",
        messageCount: 1,
        ...(ago !== null ? { lastInboundAt: now - ago } : {}),
        createdAt: now,
        updatedAt: now,
      });
    const igConv = await conv("instagram", instagramId);
    const msConv = await conv("messenger", messengerId);
    return {
      organizationId,
      userId,
      memberId,
      connectionId,
      messengerId,
      instagramId,
      waId,
      contactId,
      leadId,
      igConv,
      msConv,
    };
  });
}

type GraphCall = { url: string; auth: string; body: Record<string, any> };

function graph(responses: Array<{ status: number; body: unknown }>) {
  const calls: GraphCall[] = [];
  let i = 0;
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      auth: (init?.headers as Record<string, string>).Authorization,
      body: JSON.parse(String(init?.body)),
    });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), { status: r.status });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}
const ok = (mid: string) => ({ status: 200, body: { recipient_id: "x", message_id: mid } });
const metaErr = (status: number, code: number, subcode?: number) => ({
  status,
  body: { error: { code, ...(subcode ? { error_subcode: subcode } : {}), message: "erro" } },
});

async function send(t: TestConvex<typeof schema>, s: Seed, conversationId: Id<"conversations">, content: string) {
  return await t
    .withIdentity({ subject: `${s.userId}|s1` })
    .mutation(api.conversations.sendMessage, { conversationId, content });
}

async function getMessage(t: TestConvex<typeof schema>, id: Id<"messages">) {
  return await t.run(async (ctx) => (await ctx.db.get(id))!);
}

async function scheduledNames(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).map((j) => j.name)
  );
}

describe("envio pela porta", () => {
  test("Instagram: POST /{page}/messages com Bearer, destino = IGSID do config da conversa; mid gravado e metaSentMids", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const g = graph([ok("ig_mid_0001")]);
    const id = await send(t, s, s.igConv, "Olá, Marina!");
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(g.calls).toHaveLength(1);
    expect(g.calls[0].url).toBe(`https://graph.facebook.com/v26.0/${PAGE_ID}/messages`);
    expect(g.calls[0].url).not.toContain("fake-page-token");
    expect(g.calls[0].auth).toBe("Bearer fake-page-token");
    expect(g.calls[0].body).toEqual({
      recipient: { id: IGSID },
      message: { text: "Olá, Marina!", metadata: `hnb:${id}` },
    });
    const m = await getMessage(t, id);
    expect(m).toMatchObject({ externalId: "ig_mid_0001", deliveryStatus: "sent" });
    expect(typeof m.metadata?.metaDispatchStartedAt).toBe("number");
    const sent = await t.run(async (ctx) => await ctx.db.query("metaSentMids").collect());
    expect(sent.map((r) => [r.mid, r.messageId])).toEqual([["ig_mid_0001", id]]);
  });

  test("Messenger: destino = PSID, messaging_type RESPONSE, sem metaSentMids", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const g = graph([ok("m_mid_0001")]);
    const id = await send(t, s, s.msConv, "Oi");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.calls[0].body).toMatchObject({ recipient: { id: PSID }, messaging_type: "RESPONSE" });
    expect((await getMessage(t, id)).externalId).toBe("m_mid_0001");
    expect(await t.run(async (ctx) => await ctx.db.query("metaSentMids").collect())).toHaveLength(0);
  });

  test("resposta citando uma mensagem manda reply_to.mid", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const quotedId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId: s.igConv,
        leadId: s.leadId,
        direction: "inbound",
        senderType: "contact",
        content: "Quanto custa?",
        contentType: "text",
        externalId: "ig_in_0009",
        isInternal: false,
        createdAt: Date.now(),
      })
    );
    const g = graph([ok("ig_mid_0002")]);
    await t
      .withIdentity({ subject: `${s.userId}|s1` })
      .mutation(api.conversations.sendMessage, { conversationId: s.igConv, content: "R$ 10", replyToMessageId: quotedId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.calls[0].body.reply_to).toEqual({ mid: "ig_in_0009" });
  });

  test("org de demonstração não chama a rede", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { demo: true });
    const g = graph([ok("nunca")]);
    const id = await send(t, s, s.igConv, "Oi");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.fn).not.toHaveBeenCalled();
    expect(await getMessage(t, id)).toMatchObject({ deliveryStatus: "delivered", externalId: `demo:${id}` });
  });

  test("texto longo vira N POSTs em ordem; metaMids e metaSentMids de todas as partes (IG)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const g = graph([ok("ig_p1"), ok("ig_p2"), ok("ig_p3")]);
    const paragraphs = ["A".repeat(900), "B".repeat(900), "C".repeat(900)];
    const id = await send(t, s, s.igConv, paragraphs.join("\n\n"));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.calls.map((c) => c.body.message.text)).toEqual(paragraphs);
    for (const c of g.calls) expect(c.body.message.metadata).toBe(`hnb:${id}`);
    const m = await getMessage(t, id);
    expect(m.externalId).toBe("ig_p1");
    expect(m.metadata?.metaMids).toEqual(["ig_p1", "ig_p2", "ig_p3"]);
    const sent = await t.run(async (ctx) => await ctx.db.query("metaSentMids").collect());
    expect(sent.map((r) => r.mid).sort()).toEqual(["ig_p1", "ig_p2", "ig_p3"]);
  });

  test("mensagem só com anexo falha com cópia clara, sem rede (mídia é F2)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const g = graph([ok("nunca")]);
    const id = await t.run(async (ctx) => {
      const fileId = await ctx.db.insert("files", {
        organizationId: s.organizationId,
        name: "foto.jpg",
        mimeType: "image/jpeg",
        size: 10,
        storageId: "kg2fake",
        fileType: "message_attachment",
        uploadedBy: s.memberId,
        createdAt: Date.now(),
      });
      const mid = await ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId: s.igConv,
        leadId: s.leadId,
        direction: "outbound",
        senderType: "human",
        senderId: s.memberId,
        content: "[imagem]",
        contentType: "image",
        attachments: [fileId],
        isInternal: false,
        createdAt: Date.now(),
      });
      await scheduleOutboundDispatch(ctx, (await ctx.db.get(s.igConv))!, mid);
      return mid;
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.fn).not.toHaveBeenCalled();
    const m = await getMessage(t, id);
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryError).toBe("Mídia por Instagram/Messenger chega na próxima versão.");
  });
});

describe("janela de serviço", () => {
  test("janela fechada na porta: failed com a cópia, sem rede e sem agendar o dispatcher", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { lastInboundAgoMs: 2 * DAY });
    const g = graph([ok("nunca")]);
    const id = await send(t, s, s.msConv, "Oi");
    expect(await scheduledNames(t)).not.toContain("metaMessaging:internalDispatchMessage");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.fn).not.toHaveBeenCalled();
    const m = await getMessage(t, id);
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryError).toBe("Fora da janela de 24 h: aguarde o cliente escrever de novo.");
  });

  test("janela fechada no dispatcher (fechou entre agendar e disparar): failed sem rede", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { lastInboundAgoMs: 2 * DAY });
    const g = graph([ok("nunca")]);
    const id = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        organizationId: s.organizationId,
        conversationId: s.igConv,
        leadId: s.leadId,
        direction: "outbound",
        senderType: "human",
        content: "Oi",
        contentType: "text",
        isInternal: false,
        createdAt: Date.now(),
      })
    );
    await t.action(internal.metaMessaging.internalDispatchMessage, { messageId: id });
    expect(g.fn).not.toHaveBeenCalled();
    expect((await getMessage(t, id)).metadata?.deliveryError).toMatch(/Fora da janela/);
  });

  test("conversa aberta por anúncio (windowOpenedByAdAt) envia até 7 dias", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { lastInboundAgoMs: 3 * DAY });
    await t.run(async (ctx) => ctx.db.patch(s.msConv, { windowOpenedByAdAt: Date.now() - 3 * DAY }));
    const g = graph([ok("m_ad_0001")]);
    const id = await send(t, s, s.msConv, "Oi");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.calls).toHaveLength(1);
    expect((await getMessage(t, id)).deliveryStatus).toBe("sent");
  });

  test("mensagem agendada que dispara com a janela fechada falha com a cópia", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { lastInboundAgoMs: 2 * DAY });
    const g = graph([ok("nunca")]);
    const rowId = await t.run(async (ctx) =>
      ctx.db.insert("scheduledMessages", {
        organizationId: s.organizationId,
        conversationId: s.igConv,
        content: "Lembrete",
        scheduledAt: Date.now(),
        status: "pending",
        createdBy: s.memberId,
        createdAt: Date.now(),
      })
    );
    await t.mutation(internal.scheduledMessages.deliver, { scheduledMessageId: rowId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.fn).not.toHaveBeenCalled();
    const row = await t.run(async (ctx) => (await ctx.db.get(rowId))!);
    const m = await getMessage(t, row.sentMessageId!);
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryError).toBe("Fora da janela de 24 h: aguarde o cliente escrever de novo.");
  });
});

describe("erros da Send API", () => {
  test("190 marca a conexão reauth_required (configs intactos) e o 2º envio falha sem rede", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const g = graph([metaErr(400, 190)]);
    const first = await send(t, s, s.igConv, "Oi");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.calls).toHaveLength(1);
    const m1 = await getMessage(t, first);
    expect(m1.deliveryStatus).toBe("failed");
    expect(m1.metadata?.deliveryError).toMatch(/reconectado/);
    expect(m1.metadata?.deliveryErrorCode).toBe(190);
    const state = await t.run(async (ctx) => ({
      conn: (await ctx.db.get(s.connectionId))!,
      configs: [(await ctx.db.get(s.instagramId))!, (await ctx.db.get(s.messengerId))!],
      audit: await ctx.db.query("auditLogs").collect(),
    }));
    expect(state.conn.authState).toBe("reauth_required");
    expect(state.configs.map((c) => c.status)).toEqual(["active", "active"]);
    const audit = state.audit.find((a) => a.entityType === "metaConnection");
    expect(audit?.severity).toBe("high");
    expect(JSON.stringify(audit)).not.toContain("fake-page-token");

    // Mesmo Página, outro canal: a credencial é a mesma, nem tenta a rede.
    const second = await send(t, s, s.msConv, "Oi de novo");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.calls).toHaveLength(1);
    expect((await getMessage(t, second)).metadata?.deliveryError).toBe(
      "Este canal precisa ser reconectado. Reconecte em Configurações > Canais."
    );
  });

  test("613 reagenda com backoff e o retry envia", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const g = graph([metaErr(400, 613), ok("ig_retry_01")]);
    const id = await send(t, s, s.igConv, "Oi");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.calls).toHaveLength(2);
    const m = await getMessage(t, id);
    expect(m).toMatchObject({ externalId: "ig_retry_01", deliveryStatus: "sent" });
    expect(m.metadata?.dispatchAttempts).toBe(1);
  });

  test("613 persistente: 5 retentativas e falha (backoff 4^n)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const g = graph([metaErr(400, 613)]);
    const id = await send(t, s, s.igConv, "Oi");
    // Primeiro despacho: agenda o retry com ~1 s de atraso.
    await t.finishInProgressScheduledFunctions();
    vi.runOnlyPendingTimers();
    await t.finishInProgressScheduledFunctions();
    const retry = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).find(
        (j) => j.name === "metaMessaging:internalDispatchMessage" && j.state.kind === "pending"
      )
    );
    expect(retry).toBeTruthy();
    expect(retry!.scheduledTime - Date.now()).toBeGreaterThanOrEqual(1000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.calls).toHaveLength(6);
    const m = await getMessage(t, id);
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryError).toMatch(/tentativas esgotadas/);
    expect(m.metadata?.dispatchAttempts).toBe(5);
  });

  test("10/2018300 falha com a cópia de controle da conversa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    graph([metaErr(400, 10, 2018300)]);
    const id = await send(t, s, s.msConv, "Oi");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const m = await getMessage(t, id);
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryError).toBe(
      "Outro app (ex. Caixa de entrada do Meta Business Suite) controla esta conversa. Defina o HNBCRM como app padrão em Configurações da Página > Mensagens avançadas."
    );
    const activity = await t.run(async (ctx) => await ctx.db.query("activities").collect());
    const note = activity.find((a) => a.type === "note");
    expect(note?.content).toMatch(/^Falha ao enviar mensagem: Outro app/);
    expect(note?.content).not.toMatch(/WhatsApp/);
  });
});

describe("resolução estrita", () => {
  test("conversa Instagram sem channelConfigId nunca cai no WhatsApp ativo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t, { withWhatsapp: true });
    const g = graph([ok("nunca")]);
    await t.run(async (ctx) => ctx.db.patch(s.igConv, { channelConfigId: undefined, channelProvider: undefined }));
    const id = await send(t, s, s.igConv, "Oi");
    const names = await scheduledNames(t);
    expect(names).not.toContain("whatsapp:internalDispatchMessage");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(g.fn).not.toHaveBeenCalled();
    const m = await getMessage(t, id);
    expect(m.deliveryStatus).toBe("failed");
    expect(m.metadata?.deliveryError).toMatch(/não tem um canal do Instagram\/Messenger/);
    const ctxData = await t.query(internal.metaMessaging.internalGetMetaDispatchContext, { messageId: id });
    expect(ctxData!.config).toBeNull();
  });

  test("contexto: o destino é a identidade do config da conversa", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ids = await t.run(async (ctx) => {
      const mk = (conversationId: Id<"conversations">) =>
        ctx.db.insert("messages", {
          organizationId: s.organizationId,
          conversationId,
          leadId: s.leadId,
          direction: "outbound",
          senderType: "human",
          content: "Oi",
          contentType: "text",
          isInternal: false,
          createdAt: Date.now(),
        });
      return { ig: await mk(s.igConv), ms: await mk(s.msConv) };
    });
    const ig = await t.query(internal.metaMessaging.internalGetMetaDispatchContext, { messageId: ids.ig });
    const ms = await t.query(internal.metaMessaging.internalGetMetaDispatchContext, { messageId: ids.ms });
    expect(ig!.recipientId).toBe(IGSID);
    expect(ig!.config!._id).toBe(s.instagramId);
    expect(ms!.recipientId).toBe(PSID);
    expect(ms!.config!._id).toBe(s.messengerId);
  });
});
