/// <reference types="vite/client" />
/**
 * Foto de perfil do contato do WhatsApp (bridge, 1 a 1): agendamento, ritmo por
 * canal, aplicação do resultado, evento Picture e exclusão. O gateway é um
 * `fetch` simulado; os bytes da imagem são montados em código (cabeçalho JPEG +
 * enchimento) para não acionar o `secretScan`.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { encryptSecret } from "./lib/secretCrypto";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const PICTURE_URL = "https://pps.whatsapp.net/v/t61/fake.jpg?stp=dst-jpg&oe=6A0F1234";

function jpegBytes(size = 120): Uint8Array {
  const bytes = new Uint8Array(size).fill(7);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

type Gateway = { status?: number; body?: unknown; image?: Uint8Array };

/** `fetch` simulado: `/user/avatar` devolve `gateway`, a URL da foto devolve os bytes. */
function stubGateway(gateway: Gateway) {
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/user/avatar")) {
      return new Response(JSON.stringify(gateway.body ?? {}), { status: gateway.status ?? 200 });
    }
    if (url.startsWith("https://pps.whatsapp.net/")) {
      return new Response((gateway.image ?? jpegBytes()) as BodyInit, { status: 200 });
    }
    return new Response("ok", { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const okBody = (id = "1700000000") => ({ code: 200, success: true, data: { url: PICTURE_URL, id, type: "preview" } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type T = TestConvex<typeof schema>;

async function seed(t: T, opts: { phone?: string; sessionState?: "connected" | "disconnected" } = {}) {
  const tokenEncrypted = await encryptSecret("fake-instance-token");
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org",
      slug: "org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "admin@teste.com" });
    await ctx.db.insert("teamMembers", {
      organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active",
      createdAt: now, updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId, name: "Default", color: "#6366f1", isDefault: true, order: 0, createdAt: now, updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId, boardId, name: "New", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false,
      createdAt: now, updatedAt: now,
    });
    const configId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "bridge", displayName: "Loja",
      bridgeBaseUrl: "https://wa-gw.example.test", bridgeInstanceId: "inst_a",
      bridgeTokenEncrypted: tokenEncrypted, bridgeTokenLast4: "aaaa",
      bridgeSessionState: opts.sessionState ?? "connected", status: "active", createdAt: now, updatedAt: now,
    });
    const metaConfigId = await ctx.db.insert("channelConfigs", {
      organizationId, channel: "whatsapp", provider: "meta", displayName: "Oficial",
      status: "active", createdAt: now, updatedAt: now,
    });
    const newLead = async (phone: string, name: string) => {
      const contactId = await ctx.db.insert("contacts", {
        organizationId, firstName: name, phone, whatsappNumber: phone, tags: [], createdAt: now, updatedAt: now,
      });
      const leadId = await ctx.db.insert("leads", {
        organizationId, title: name, contactId, boardId, stageId, value: 0, currency: "BRL",
        priority: "medium", temperature: "cold", tags: [], customFields: {},
        conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
      });
      return { contactId, leadId };
    };
    const first = await newLead(opts.phone ?? "5511999990001", "Maria");
    return { organizationId, userId, configId, metaConfigId, ...first } as unknown as {
      organizationId: Id<"organizations">;
      userId: Id<"users">;
      configId: Id<"channelConfigs">;
      metaConfigId: Id<"channelConfigs">;
      contactId: Id<"contacts">;
      leadId: Id<"leads">;
    };
  });
}

async function newLead(t: T, organizationId: Id<"organizations">, phone: string, name: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const board = await ctx.db.query("boards").first();
    const stage = await ctx.db.query("stages").first();
    const contactId = await ctx.db.insert("contacts", {
      organizationId, firstName: name, phone, whatsappNumber: phone, tags: [], createdAt: now, updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: name, contactId, boardId: board!._id, stageId: stage!._id, value: 0, currency: "BRL",
      priority: "medium", temperature: "cold", tags: [], customFields: {},
      conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    return { contactId, leadId };
  });
}

let ext = 0;
async function receive(
  t: T,
  s: { organizationId: Id<"organizations">; leadId: Id<"leads"> },
  channelConfigId: Id<"channelConfigs">,
  metadata?: Record<string, unknown>
) {
  ext += 1;
  return await t.mutation(internal.conversations.internalReceiveMessage, {
    organizationId: s.organizationId,
    leadId: s.leadId,
    channel: "whatsapp",
    channelConfigId,
    content: "Oi",
    externalId: `3EB0AV${ext}`,
    skipAiEnqueue: true,
    ...(metadata ? { metadata } : {}),
  });
}

async function avatarJobs(t: T) {
  return await t.run(async (ctx) => {
    const jobs = await ctx.db.system.query("_scheduled_functions").collect();
    return jobs.filter((j) => j.name.includes("contactAvatar") && j.state.kind === "pending");
  });
}

async function cancelPending(t: T) {
  await t.run(async (ctx) => {
    for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
      if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
    }
  });
  await t.finishInProgressScheduledFunctions();
}

const rowOf = (t: T, contactId: Id<"contacts">) =>
  t.run(async (ctx) =>
    ctx.db.query("contactAvatars").withIndex("by_contact", (q) => q.eq("contactId", contactId)).first()
  );

async function patchRow(t: T, contactId: Id<"contacts">, fields: Record<string, unknown>) {
  const row = await rowOf(t, contactId);
  await t.run(async (ctx) => ctx.db.patch(row!._id, fields));
}

const fetchArgs = (s: { organizationId: Id<"organizations">; contactId: Id<"contacts">; configId: Id<"channelConfigs"> }) => ({
  organizationId: s.organizationId,
  contactId: s.contactId,
  channelConfigId: s.configId,
});

describe("agendamento", () => {
  test("a primeira mensagem agenda UMA busca; a segunda em seguida não agenda", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.configId);
    expect(await avatarJobs(t)).toHaveLength(1);
    const row = await rowOf(t, s.contactId);
    expect(row?.pendingSince).toBeTypeOf("number");
    await receive(t, s, s.configId);
    expect(await avatarJobs(t)).toHaveLength(1);
    await cancelPending(t);
  });

  test("Meta, histórico, kill switch, canal desconectado e telefone LID não agendam", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.metaConfigId);
    expect(await avatarJobs(t)).toHaveLength(0);

    await receive(t, s, s.configId, { importedFromHistory: true });
    expect(await avatarJobs(t)).toHaveLength(0);

    vi.stubEnv("CONTACT_AVATAR_FETCH", "0");
    await receive(t, s, s.configId);
    expect(await avatarJobs(t)).toHaveLength(0);
    vi.unstubAllEnvs();
    vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);

    await t.run(async (ctx) => ctx.db.patch(s.configId, { bridgeSessionState: "logged_out" }));
    await receive(t, s, s.configId);
    expect(await avatarJobs(t)).toHaveLength(0);
    await t.run(async (ctx) => ctx.db.patch(s.configId, { bridgeSessionState: "connected" }));

    const lid = await newLead(t, s.organizationId, "180002129735765@lid", "Lid");
    await receive(t, { organizationId: s.organizationId, leadId: lid.leadId }, s.configId);
    expect(await avatarJobs(t)).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.query("contactAvatars").collect()).length)).toBe(0);
    await cancelPending(t);
  });

  test("conversa de grupo não agenda", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("conversations", {
        organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: s.configId,
        kind: "group", status: "active", messageCount: 0, createdAt: now, updatedAt: now,
      });
    });
    const { maybeScheduleContactAvatar } = await import("./lib/contactAvatarOps");
    const scheduled = await t.run(async (ctx) => {
      const conversation = (await ctx.db.query("conversations").first())!;
      const contact = (await ctx.db.get(s.contactId))!;
      return await maybeScheduleContactAvatar(ctx, { contact, conversation });
    });
    expect(scheduled).toBe(false);
    expect(await avatarJobs(t)).toHaveLength(0);
  });

  test("abrir a conversa (markConversationRead) agenda para contato antigo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const conversationId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("conversations", {
        organizationId: s.organizationId, leadId: s.leadId, channel: "whatsapp", channelConfigId: s.configId,
        status: "active", messageCount: 0, createdAt: now, updatedAt: now,
      });
    });
    const asAdmin = t.withIdentity({ subject: `${s.userId}|s1` });
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId });
    expect(await avatarJobs(t)).toHaveLength(1);
    await asAdmin.mutation(api.conversations.markConversationRead, { conversationId });
    expect(await avatarJobs(t)).toHaveLength(1);
    await cancelPending(t);
  });
});

describe("ritmo por canal", () => {
  test("duas buscas do mesmo canal ficam espaçadas de 8 a 15 s", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const b = await newLead(t, s.organizationId, "5511999990002", "Joao");
    await receive(t, s, s.configId);
    await receive(t, { organizationId: s.organizationId, leadId: b.leadId }, s.configId);
    const jobs = await avatarJobs(t);
    expect(jobs).toHaveLength(2);
    const times = jobs.map((j) => j.scheduledTime).sort((x, y) => x - y);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(8000);
    expect(times[1] - times[0]).toBeLessThanOrEqual(15000);
    await cancelPending(t);
  });

  test("fila cheia (próximo horário a mais de 10 min) não agenda e não escreve", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await t.run(async (ctx) =>
      ctx.db.insert("channelAvatarPacing", {
        organizationId: s.organizationId, channelConfigId: s.configId, nextFetchAt: Date.now() + 11 * 60_000,
      })
    );
    await receive(t, s, s.configId);
    expect(await avatarJobs(t)).toHaveLength(0);
    expect(await rowOf(t, s.contactId)).toBeNull();
  });

  test("HTTP 429 pausa o canal para fotos (15 min, dobrando) e o primeiro sucesso zera", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.configId);
    stubGateway({ status: 429, body: { error: "too many requests" } });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    const pacing = () =>
      t.run(async (ctx) => ctx.db.query("channelAvatarPacing").withIndex("by_channel_config", (q) => q.eq("channelConfigId", s.configId)).first());
    let p = await pacing();
    expect(p?.strikes).toBe(1);
    expect(p!.pausedUntil! - Date.now()).toBeGreaterThanOrEqual(15 * 60_000 - 1000);

    // Em pausa: outro contato não agenda.
    const b = await newLead(t, s.organizationId, "5511999990002", "Joao");
    await receive(t, { organizationId: s.organizationId, leadId: b.leadId }, s.configId);
    expect(await rowOf(t, b.contactId)).toBeNull();

    // 2º 429 dobra.
    const pacingId = (await pacing())!._id;
    await t.run(async (ctx) => ctx.db.patch(pacingId, { pausedUntil: Date.now() - 1 }));
    await patchRow(t, s.contactId, { pendingSince: Date.now() });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    p = await pacing();
    expect(p?.strikes).toBe(2);
    expect(p!.pausedUntil! - Date.now()).toBeGreaterThanOrEqual(30 * 60_000 - 1000);

    // Sucesso zera.
    await t.run(async (ctx) => ctx.db.patch(p!._id, { pausedUntil: Date.now() - 1 }));
    await patchRow(t, s.contactId, { pendingSince: Date.now() });
    stubGateway({ body: okBody() });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    p = await pacing();
    expect(p?.strikes).toBeUndefined();
    expect(p?.pausedUntil).toBeUndefined();
    await cancelPending(t);
  });
});

describe("aplicar o resultado", () => {
  test("foto nova grava o arquivo, a linha lateral e contacts.avatarUrl", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.configId);
    const mock = stubGateway({ body: okBody("111") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));

    const state = await t.run(async (ctx) => {
      const contact = (await ctx.db.get(s.contactId))!;
      const row = (await ctx.db.query("contactAvatars").first())!;
      const file = row.fileId ? await ctx.db.get(row.fileId) : null;
      return { contact, row, file };
    });
    expect(state.row).toMatchObject({ status: "ok", pictureId: "111" });
    expect(state.row.pendingSince).toBeUndefined();
    expect(state.row.url).toBeTypeOf("string");
    expect(state.row.url).not.toContain("whatsapp.net");
    expect(state.contact.avatarUrl).toBe(state.row.url);
    expect(state.file).toMatchObject({ fileType: "other", metadata: { kind: "contact_avatar" } });
    // Cabeçalho do gateway com a miniatura e o token; nada de telefone no log.
    const call = mock.mock.calls.find((c) => String(c[0]).endsWith("/user/avatar"))!;
    expect(JSON.parse(((call as unknown[])[1] as RequestInit).body as string)).toEqual({ Phone: "5511999990001", Preview: true });
    await cancelPending(t);
  });

  test("mesma pictureId só carimba a linha: sem download e sem tocar no contato", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.configId);
    stubGateway({ body: okBody("111") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    const before = await t.run(async (ctx) => ({
      contact: await ctx.db.get(s.contactId),
      files: (await ctx.db.query("files").collect()).length,
    }));
    // Vence a conferência e agenda de novo.
    await patchRow(t, s.contactId, { nextCheckAt: 0 });
    await receive(t, s, s.configId);
    const mock = stubGateway({ body: okBody("111") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    expect(mock.mock.calls.filter((c) => String(c[0]).startsWith("https://pps."))).toHaveLength(0);
    const after = await t.run(async (ctx) => ({
      contact: await ctx.db.get(s.contactId),
      files: (await ctx.db.query("files").collect()).length,
      row: await ctx.db.query("contactAvatars").first(),
    }));
    expect(after.contact).toEqual(before.contact);
    expect(after.files).toBe(before.files);
    expect(after.row?.pendingSince).toBeUndefined();
    expect(after.row!.nextCheckAt).toBeGreaterThan(Date.now());
    await cancelPending(t);
  });

  test("foto trocada apaga a anterior e atualiza avatarUrl", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.configId);
    stubGateway({ body: okBody("111") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    const first = await rowOf(t, s.contactId);
    await patchRow(t, s.contactId, { nextCheckAt: 0, pendingSince: Date.now() });
    stubGateway({ body: okBody("222"), image: jpegBytes(200) });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    const state = await t.run(async (ctx) => ({
      row: await ctx.db.query("contactAvatars").first(),
      contact: await ctx.db.get(s.contactId),
      files: await ctx.db.query("files").collect(),
      oldFile: await ctx.db.get(first!.fileId!),
      blobs: await ctx.db.system.query("_storage").collect(),
    }));
    expect(state.row?.pictureId).toBe("222");
    expect(state.oldFile).toBeNull();
    expect(state.files).toHaveLength(1);
    expect(state.blobs).toHaveLength(1);
    expect(state.contact?.avatarUrl).toBe(state.row?.url);
    expect(state.contact?.avatarUrl).not.toBe(first?.url);
    await cancelPending(t);
  });

  test("foto manual vence a do WhatsApp; remover a manual volta à do WhatsApp", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob([jpegBytes()], { type: "image/jpeg" })));
    const manualFileId = await t.run(async (ctx) =>
      ctx.db.insert("files", {
        organizationId: s.organizationId, storageId, name: "m.jpg", mimeType: "image/jpeg", size: 120,
        fileType: "contact_photo", contactId: s.contactId, createdAt: Date.now(),
      })
    );
    const asAdmin = t.withIdentity({ subject: `${s.userId}|s1` });
    await asAdmin.mutation(api.contacts.updateContactPhoto, { contactId: s.contactId, photoFileId: manualFileId });
    const manualUrl = (await t.run(async (ctx) => ctx.db.get(s.contactId)))!.avatarUrl;
    expect(manualUrl).toBeTypeOf("string");

    await receive(t, s, s.configId);
    stubGateway({ body: okBody("111") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    const row = await rowOf(t, s.contactId);
    expect(row?.status).toBe("ok");
    expect((await t.run(async (ctx) => ctx.db.get(s.contactId)))!.avatarUrl).toBe(manualUrl);

    await asAdmin.mutation(api.contacts.updateContactPhoto, { contactId: s.contactId });
    const contact = (await t.run(async (ctx) => ctx.db.get(s.contactId)))!;
    expect(contact.photoFileId).toBeUndefined();
    expect(contact.avatarUrl).toBe(row!.url);
    expect(await t.run(async (ctx) => ctx.db.get(manualFileId))).toBeNull();

    // Sem foto do WhatsApp guardada, remover a manual limpa.
    await asAdmin.mutation(api.contacts.updateContactPhoto, { contactId: s.contactId });
    await cancelPending(t);
  });

  test("cota estourada não lança: apaga o blob novo e marca error com recuo longo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.configId);
    await t.run(async (ctx) =>
      ctx.db.insert("orgStorageUsage", {
        organizationId: s.organizationId, bytes: 2 * 1024 ** 3, count: 1, updatedAt: Date.now(),
      })
    );
    stubGateway({ body: okBody("111") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    const state = await t.run(async (ctx) => ({
      row: await ctx.db.query("contactAvatars").first(),
      contact: await ctx.db.get(s.contactId),
      blobs: await ctx.db.system.query("_storage").collect(),
      files: await ctx.db.query("files").collect(),
    }));
    expect(state.row?.status).toBe("error");
    expect(state.row!.nextCheckAt - Date.now()).toBeGreaterThan(24 * 3600_000);
    expect(state.blobs).toHaveLength(0);
    expect(state.files).toHaveLength(0);
    expect(state.contact?.avatarUrl).toBeUndefined();
    await cancelPending(t);
  });

  test("oculta e sem foto: tiram a foto guardada e o avatarUrl (30 dias)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.configId);
    stubGateway({ body: okBody("111") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    await patchRow(t, s.contactId, { pendingSince: Date.now() });
    stubGateway({ status: 500, body: { success: false, error: "user has hidden their profile picture" } });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    const state = await t.run(async (ctx) => ({
      row: await ctx.db.query("contactAvatars").first(),
      contact: await ctx.db.get(s.contactId),
      blobs: await ctx.db.system.query("_storage").collect(),
      files: await ctx.db.query("files").collect(),
    }));
    expect(state.row).toMatchObject({ status: "hidden" });
    expect(state.row?.url).toBeUndefined();
    expect(state.row!.nextCheckAt - Date.now()).toBeGreaterThan(29 * 24 * 3600_000);
    expect(state.contact?.avatarUrl).toBeUndefined();
    expect(state.blobs).toHaveLength(0);
    expect(state.files).toHaveLength(0);
    await cancelPending(t);
  });

  test("URL fora de .whatsapp.net e imagem inválida viram error, sem guardar nada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.configId);
    stubGateway({ body: { data: { url: "https://evil.example.com/x.jpg", id: "1" } } });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    expect((await rowOf(t, s.contactId))?.status).toBe("error");

    await patchRow(t, s.contactId, { pendingSince: Date.now() });
    stubGateway({ body: okBody("2"), image: new TextEncoder().encode("<html>nope</html>") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    const row = await rowOf(t, s.contactId);
    expect(row?.failures).toBe(2);
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length)).toBe(0);
    await cancelPending(t);
  });

  test("contato de outra org é recusado (action não busca; mutation apaga o blob)", async () => {
    const t = convexTest(schema, modules);
    const a = await seed(t);
    const otherOrg = await t.run(async (ctx) => {
      const now = Date.now();
      const organizationId = await ctx.db.insert("organizations", {
        name: "Outra", slug: "outra", settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: now, updatedAt: now,
      });
      const contactId = await ctx.db.insert("contacts", {
        organizationId, firstName: "X", phone: "5511999990009", whatsappNumber: "5511999990009",
        tags: [], createdAt: now, updatedAt: now,
      });
      return { organizationId, contactId };
    });
    const mock = stubGateway({ body: okBody() });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, {
      organizationId: a.organizationId,
      contactId: otherOrg.contactId,
      channelConfigId: a.configId,
    });
    expect(mock).not.toHaveBeenCalled();

    const storageId = await t.run(async (ctx) => ctx.storage.store(new Blob([jpegBytes()], { type: "image/jpeg" })));
    const applied = await t.mutation(internal.contactAvatar.internalApplyContactAvatar, {
      organizationId: a.organizationId,
      contactId: otherOrg.contactId,
      channelConfigId: a.configId,
      storageId,
      mimeType: "image/jpeg",
      size: 120,
    });
    expect(applied).toBe(false);
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length)).toBe(0);
    expect((await t.run(async (ctx) => ctx.db.get(otherOrg.contactId)))?.avatarUrl).toBeUndefined();
  });
});

describe("evento Picture", () => {
  async function withPhoto() {
    const t = convexTest(schema, modules);
    const s = await seed(t, { phone: "15550000001" });
    await receive(t, s, s.configId);
    stubGateway({ body: okBody("111") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    return { t, s };
  }

  test("troca só marca como vencida (nextCheckAt 0), sem buscar nem tocar no contato", async () => {
    const { t, s } = await withPhoto();
    const before = await t.run(async (ctx) => await ctx.db.get(s.contactId));
    const result = await t.mutation(internal.contactAvatar.internalApplyPictureEvent, {
      channelConfigId: s.configId, phone: "15550000001", remove: false,
    });
    expect(result).toBe("expired");
    const row = await rowOf(t, s.contactId);
    expect(row?.nextCheckAt).toBe(0);
    expect(row?.status).toBe("ok");
    expect(await t.run(async (ctx) => await ctx.db.get(s.contactId))).toEqual(before);
    await cancelPending(t);
  });

  test("remoção apaga a foto do WhatsApp já e marca none", async () => {
    const { t, s } = await withPhoto();
    const result = await t.mutation(internal.contactAvatar.internalApplyPictureEvent, {
      channelConfigId: s.configId, phone: "15550000001", remove: true,
    });
    expect(result).toBe("removed");
    const state = await t.run(async (ctx) => ({
      row: await ctx.db.query("contactAvatars").first(),
      contact: await ctx.db.get(s.contactId),
      files: await ctx.db.query("files").collect(),
      blobs: await ctx.db.system.query("_storage").collect(),
    }));
    expect(state.row).toMatchObject({ status: "none" });
    expect(state.row?.fileId).toBeUndefined();
    expect(state.contact?.avatarUrl).toBeUndefined();
    expect(state.files).toHaveLength(0);
    expect(state.blobs).toHaveLength(0);
    await cancelPending(t);
  });

  test("contato desconhecido ou de outra org: ignora sem escrever", async () => {
    const { t, s } = await withPhoto();
    const before = await rowOf(t, s.contactId);
    expect(
      await t.mutation(internal.contactAvatar.internalApplyPictureEvent, {
        channelConfigId: s.configId, phone: "15559999999", remove: true,
      })
    ).toBe("ignored");
    expect(await rowOf(t, s.contactId)).toEqual(before);
    await cancelPending(t);
  });
});

describe("exclusão e ops", () => {
  test("excluir o contato apaga linha lateral, arquivo e blob", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.configId);
    stubGateway({ body: okBody("111") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    const asAdmin = t.withIdentity({ subject: `${s.userId}|s1` });
    // deleteContact recusa contato com lead: tira o lead antes.
    await t.run(async (ctx) => {
      await ctx.db.delete(s.leadId);
    });
    await asAdmin.mutation(api.contacts.deleteContact, { contactId: s.contactId });
    const end = await t.run(async (ctx) => ({
      rows: await ctx.db.query("contactAvatars").collect(),
      files: await ctx.db.query("files").collect(),
      blobs: await ctx.db.system.query("_storage").collect(),
    }));
    expect(end.rows).toHaveLength(0);
    expect(end.files).toHaveLength(0);
    expect(end.blobs).toHaveLength(0);
    await cancelPending(t);
  });

  test("hardDeleteLead com contato apaga a foto", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.configId);
    stubGateway({ body: okBody("111") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    const { hardDeleteLead } = await import("./lib/leadCascade");
    await t.run(async (ctx) => {
      const lead = (await ctx.db.get(s.leadId))!;
      await hardDeleteLead(ctx, { lead, actorType: "human", deleteContact: true });
    });
    const end = await t.run(async (ctx) => ({
      rows: await ctx.db.query("contactAvatars").collect(),
      files: await ctx.db.query("files").collect(),
      blobs: await ctx.db.system.query("_storage").collect(),
    }));
    expect(end.rows).toHaveLength(0);
    expect(end.files).toHaveLength(0);
    expect(end.blobs).toHaveLength(0);
    await cancelPending(t);
  });

  test("relatório conta por status, só números", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await receive(t, s, s.configId);
    stubGateway({ body: okBody("111") });
    await t.action(internal.contactAvatar.internalFetchContactAvatar, fetchArgs(s));
    const report = await t.query(internal.opsContactAvatar.internalAvatarReport, { organizationId: s.organizationId });
    expect(report).toMatchObject({ total: 1, ok: 1, hidden: 0, none: 0, error: 0, pending: 0, truncated: false });
    await cancelPending(t);
  });
});
