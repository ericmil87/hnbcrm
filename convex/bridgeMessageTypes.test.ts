/// <reference types="vite/client" />
/**
 * Tipos de mensagem do bridge que caíam em "[mensagem não suportada]" (13% de
 * ~3400 mensagens medidas em produção em 07/10/2026): ruído de protocolo
 * descartado, wrappers desembrulhados, tipos novos com placeholder legível +
 * `bridgeExtra`, apagar-para-todos/edição e a op de reprocessamento.
 *
 * Os payloads vêm de `__fixtures__/bridgeMessageTypes.json` (SINTÉTICA).
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import fx from "./__fixtures__/bridgeMessageTypes.json";
import {
  BRIDGE_RAW_MAX_CHARS,
  boundRawForStorage,
  classifyBridgeMessage,
  parseBridgeEvent,
} from "./lib/bridgeParse";
import { captionFor } from "./whatsapp";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const HMAC_SECRET = "fake-bridge-hmac-secret";
const INSTANCE_ID = "org_types_instance";
const BRIDGE_TOKEN = "fake-instance-token";
const BRIDGE_BASE_URL = "https://wa-gw.example.test";

const CONTACT_PHONE = "15550000001";
const CONTACT_JID = `${CONTACT_PHONE}@s.whatsapp.net`;
const OTHER_PHONE = "15550000077";
const GROUP_JID = "120363000000000000@g.us";
const OUR_LID = "90000000000001@lid";
const OUR_PHONE = "15550009999";
const ADMIN_LID = "90000000000002@lid";
const ADMIN_PHONE = "15550000002";
const MEMBER_LID = "90000000000003@lid";
const MEMBER_PHONE = "15550000003";

function env(waMessage: unknown, info: Record<string, unknown> = {}) {
  return {
    type: "Message",
    instanceId: INSTANCE_ID,
    event: {
      Info: {
        ID: "3EB0MSG01",
        Chat: CONTACT_JID,
        Sender: CONTACT_JID,
        IsFromMe: false,
        IsGroup: false,
        PushName: "Maria Teste",
        Timestamp: "2026-10-07T12:00:00Z",
        ...info,
      },
      Message: waMessage,
    },
  };
}

function groupEnv(waMessage: unknown, info: Record<string, unknown> = {}) {
  return env(waMessage, {
    Chat: GROUP_JID,
    Sender: MEMBER_LID,
    SenderAlt: `${MEMBER_PHONE}@s.whatsapp.net`,
    IsGroup: true,
    PushName: "Membro",
    ...info,
  });
}

function parseOne(waMessage: unknown) {
  const res = parseBridgeEvent(env(waMessage));
  expect(res.kind).toBe("message");
  if (res.kind !== "message") throw new Error("not a message");
  return res.message;
}

// ── A. Parser ──

describe("parser — ruído de protocolo é descartado", () => {
  test.each([
    ["senderKeyDistributionMessage sozinho", fx.senderKeyOnly],
    ["mensagem vazia", {}],
    ["protocolMessage de config (não REVOKE/EDIT)", fx.ephemeralSetting],
    ["menção de grupo no status", fx.statusMention],
    ["voto de enquete cifrado", fx.pollVote],
    ["keepInChat", { keepInChatMessage: { keepType: 1 } }],
    ["pinInChat", { PinInChatMessage: { type: 1 } }],
    ["peerDataOperation", { messageContextInfo: {}, peerDataOperationRequestResponseMessage: {} }],
    ["reação cifrada", { encReactionMessage: { encPayload: "AA" } }],
  ])("1 a 1: %s", (_label, msg) => {
    expect(parseBridgeEvent(env(msg)).kind).toBe("ignored");
  });

  test("grupo: senderKeyDistributionMessage sozinho também é ignorado", () => {
    expect(parseBridgeEvent(groupEnv(fx.senderKeyOnly)).kind).toBe("ignored");
  });

  test("senderKey ACOMPANHANDO conteúdo real não descarta o conteúdo", () => {
    const m = parseOne({ ...fx.senderKeyOnly, conversation: "oi grupo" });
    expect(m.content).toBe("oi grupo");
  });
});

describe("parser — wrappers", () => {
  test("ephemeral > viewOnceV2 > imagem: abre os dois e marca viewOnce", () => {
    const m = parseOne(fx.viewOnceNested);
    expect(m.contentType).toBe("image");
    expect(m.content).toBe("só uma vez");
    expect(m.metadata.viewOnce).toBe(true);
    expect(m.media?.kind).toBe("image");
  });

  test("filho de álbum (associatedChildMessage) vira a imagem", () => {
    const m = parseOne(fx.albumChild);
    expect(m.contentType).toBe("image");
    expect(m.content).toBe("foto 1 do álbum");
    expect(m.metadata.viewOnce).toBeUndefined();
  });

  test("documentWithCaption e deviceSent, PascalCase", () => {
    const m = parseOne({
      DeviceSentMessage: {
        Message: { documentWithCaptionMessage: { message: { documentMessage: { fileName: "pix.pdf" } } } },
      },
    });
    expect(m.content).toBe("pix.pdf");
    expect(m.metadata.bridgeType).toBe("document");
  });

  test("teto de 4 níveis: além disso não abre (e vira unknown)", () => {
    let msg: any = { conversation: "fundo" };
    for (let i = 0; i < 6; i++) msg = { ephemeralMessage: { message: msg } };
    const m = parseOne(msg);
    expect(m.metadata.bridgeType).toBe("unknown");
  });
});

describe("parser — tipos novos (contrato bridgeType/bridgeExtra)", () => {
  test("álbum", () => {
    const m = parseOne(fx.album);
    expect(m.content).toBe("[álbum: 20 fotos]");
    expect(m.metadata).toMatchObject({ bridgeType: "album", bridgeExtra: { imageCount: 20, videoCount: 0 } });
    expect(parseOne(fx.albumMixed).content).toBe("[álbum: 3 fotos e 1 vídeo]");
    expect(parseOne({ albumMessage: { expectedVideoCount: 1 } }).content).toBe("[álbum: 1 vídeo]");
  });

  test("enquete", () => {
    const m = parseOne(fx.poll);
    expect(m.content).toBe("[enquete: Qual dia é melhor?]");
    expect(m.metadata.bridgeExtra).toEqual({
      question: "Qual dia é melhor?",
      options: ["Sábado", "Domingo"],
      selectableCount: 1,
    });
  });

  test("enquete com opções demais é cortada em 12", () => {
    const options = Array.from({ length: 20 }, (_, i) => ({ optionName: `op${i}`.padEnd(300, "x") }));
    const m = parseOne({ pollCreationMessage: { name: "P", options } });
    const extra = m.metadata.bridgeExtra as { options: string[] };
    expect(extra.options).toHaveLength(12);
    expect(extra.options[0].length).toBeLessThanOrEqual(200);
  });

  test("localização e localização ao vivo", () => {
    const m = parseOne(fx.location);
    expect(m.content).toBe("[localização: Marco Zero]");
    expect(m.metadata).toMatchObject({
      bridgeType: "location",
      bridgeExtra: {
        latitude: -8.0476,
        longitude: -34.877,
        name: "Marco Zero",
        address: "Recife Antigo",
        url: "https://maps.example.test/marco-zero",
      },
    });
    const live = parseOne(fx.liveLocation);
    expect(live.content).toBe("[localização ao vivo]");
    expect(live.metadata).toMatchObject({ bridgeType: "live_location", bridgeExtra: { latitude: -8.05 } });
  });

  test("localização sem nome usa lat,lng e descarta url não-http", () => {
    const m = parseOne({ locationMessage: { degreesLatitude: 1.5, degreesLongitude: 2, URL: "javascript:alert(1)" } });
    expect(m.content).toBe("[localização: 1.500000, 2.000000]");
    expect((m.metadata.bridgeExtra as any).url).toBeUndefined();
  });

  test("contato e lista de contatos — sem o vCard", () => {
    const one = parseOne(fx.contact);
    expect(one.content).toBe("[contato: Joana Teste]");
    expect(one.metadata).toMatchObject({
      bridgeType: "contact",
      bridgeExtra: { names: ["Joana Teste"], phones: ["15550000099"] },
    });
    expect(JSON.stringify(one.metadata)).not.toContain("VCARD");

    const many = parseOne(fx.contactsArray);
    expect(many.content).toBe("[contatos: Ana, Bruno e mais 2]");
    expect(many.metadata.bridgeExtra).toEqual({
      names: ["Ana", "Bruno", "Carla", "Davi"],
      phones: ["15550000001", "15550000002"],
    });
  });

  test("evento (startTime em segundos vira ms)", () => {
    const m = parseOne(fx.event);
    expect(m.content).toBe("[evento: Roda de conversa]");
    expect(m.metadata.bridgeExtra).toEqual({
      name: "Roda de conversa",
      description: "Encontro mensal",
      startAt: 1791380000 * 1000,
      location: "Sede",
      joinLink: "https://call.example.test/abc",
    });
  });

  test("convite de grupo NUNCA grava o inviteCode", () => {
    const m = parseOne(fx.groupInvite);
    expect(m.content).toBe("[convite para o grupo Turma do Sábado]");
    expect(m.metadata.bridgeExtra).toEqual({ groupName: "Turma do Sábado" });
    expect(JSON.stringify(m)).not.toContain("SEGREDO");
  });

  test("registro de chamada (proto com typo 'Messsage')", () => {
    const m = parseOne(fx.callLog);
    expect(m.content).toBe("[chamada de vídeo]");
    expect(m.metadata.bridgeExtra).toEqual({ isVideo: true, outcome: "missed" });
    expect(parseOne({ callLogMessage: { isVideo: false } }).content).toBe("[chamada de voz]");
  });

  test("respostas interativas viram o texto escolhido", () => {
    const b = parseOne(fx.buttonsResponse);
    expect(b.content).toBe("Quero saber mais");
    expect(b.metadata).toMatchObject({ bridgeType: "interactive_reply", bridgeExtra: { selected: "Quero saber mais" } });
    expect(parseOne(fx.listResponse).content).toBe("Plano Anual");
    expect(
      parseOne({ templateButtonReplyMessage: { selectedDisplayText: "Sim" } }).metadata.bridgeExtra
    ).toEqual({ selected: "Sim" });
    expect(parseOne({ interactiveResponseMessage: { body: { text: "Confirmar" } } }).content).toBe("Confirmar");
  });

  test("template/interativo RECEBIDO vira texto; sem texto, unknown", () => {
    expect(parseOne(fx.templateReceived).content).toBe("Pedido confirmado\nSeu pedido #123 saiu para entrega.");
    expect(parseOne(fx.interactiveReceived).content).toBe("Promoção\nSó hoje: 20% off.");
    expect(parseOne({ interactiveMessage: { nativeFlowMessage: {} } }).metadata.bridgeType).toBe("unknown");
  });

  test("vídeo-nota (ptv) é vídeo", () => {
    const m = parseOne(fx.ptv);
    expect(m.content).toBe("[vídeo]");
    expect(m.contentType).toBe("file");
    expect(m.media?.kind).toBe("video");
    expect(m.metadata.bridgeType).toBe("video");
  });

  test("quote continua funcionando nos tipos novos", () => {
    const m = parseOne({
      locationMessage: {
        degreesLatitude: 1,
        degreesLongitude: 2,
        name: "Aqui",
        contextInfo: { stanzaId: "3EB0QUOTED", quotedMessage: { conversation: "onde fica?" } },
      },
    });
    expect(m.metadata.quoted).toEqual({ externalId: "3EB0QUOTED", preview: "onde fica?" });
  });

  test("grupo: tipo novo com menção mantém mentions", () => {
    const res = parseBridgeEvent(
      groupEnv({ pollCreationMessage: { name: "Q", options: [], contextInfo: { mentionedJid: [OUR_LID] } } })
    );
    expect(res.kind).toBe("group_message");
    if (res.kind !== "group_message") return;
    expect(res.message.content).toBe("[enquete: Q]");
    expect(res.message.mentions).toEqual([OUR_LID]);
  });

  test("unknown: guarda o tipo e um raw limitado", () => {
    const m = parseOne(fx.unknownType);
    expect(m.content).toBe("[mensagem não suportada]");
    expect(m.metadata.bridgeExtra).toEqual({ type: "requestPaymentMessage" });
    expect(m.metadata.raw).toBeTruthy();
  });

  test("raw gigante é truncado a ~4 KB", () => {
    const huge = { someNewMessage: { thumb: "A".repeat(50_000), list: Array.from({ length: 500 }, (_, i) => ({ i, s: "x".repeat(200) })) } };
    const m = parseOne(huge);
    const raw = m.metadata.raw as Record<string, unknown>;
    expect(JSON.stringify(raw).length).toBeLessThanOrEqual(BRIDGE_RAW_MAX_CHARS + 50);
    expect(raw._truncated).toBe(true);
    // Raw pequeno fica intacto.
    expect(boundRawForStorage({ a: "b" })).toEqual({ a: "b" });
  });
});

describe("parser — apagar para todos e edição", () => {
  test("revoke 1 a 1", () => {
    const res = parseBridgeEvent(env(fx.revoke));
    expect(res).toMatchObject({
      kind: "message_revoke",
      revoke: { targetExternalId: "3EB0TARGET01", isGroup: false, fromMe: false, chatPhone: CONTACT_PHONE },
    });
  });

  test("revoke com tipo por NOME (protojson) também vale", () => {
    const res = parseBridgeEvent(env({ protocolMessage: { key: { ID: "T1" }, type: "REVOKE" } }));
    expect(res.kind).toBe("message_revoke");
  });

  test("edit 1 a 1 (embrulhado em editedMessage)", () => {
    const res = parseBridgeEvent(env(fx.edit));
    expect(res).toMatchObject({
      kind: "message_edit",
      edit: { targetExternalId: "3EB0TARGET01", newContent: "texto corrigido", chatPhone: CONTACT_PHONE },
    });
  });

  test("edit sem o wrapper (protocolMessage no topo)", () => {
    const res = parseBridgeEvent(
      env({ protocolMessage: { key: { ID: "T2" }, type: 14, editedMessage: { extendedTextMessage: { text: "novo" } } } })
    );
    expect(res).toMatchObject({ kind: "message_edit", edit: { targetExternalId: "T2", newContent: "novo" } });
  });

  test("grupo: revoke e edit carregam sala e autor", () => {
    const r = parseBridgeEvent(groupEnv(fx.revoke));
    expect(r).toMatchObject({
      kind: "message_revoke",
      revoke: { isGroup: true, groupJid: GROUP_JID, senderLid: MEMBER_LID, senderPhone: MEMBER_PHONE },
    });
    const e = parseBridgeEvent(groupEnv(fx.edit));
    expect(e).toMatchObject({ kind: "message_edit", edit: { isGroup: true, groupJid: GROUP_JID } });
  });

  test("revoke sem id alvo é ruído", () => {
    expect(classifyBridgeMessage({ protocolMessage: { type: 0 } }).kind).toBe("noise");
  });
});

describe("captionFor (encaminhamento)", () => {
  test.each([
    "[álbum: 20 fotos]",
    "[álbum]",
    "[enquete: Qual dia?]",
    "[localização: Marco Zero]",
    "[localização ao vivo]",
    "[contato: Joana]",
    "[contatos: A, B e mais 2]",
    "[evento: Roda]",
    "[convite para o grupo Turma]",
    "[chamada de voz]",
    "[imagem]",
  ])("placeholder %s não vira legenda", (p) => {
    expect(captionFor(p)).toBeUndefined();
  });
  test("texto normal segue como legenda", () => {
    expect(captionFor("olha essa foto")).toBe("olha essa foto");
    expect(captionFor("[contato] me liga")).toBe("[contato] me liga");
  });
});

// ── B. Ingestão ──

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
  vi.stubEnv("WA_BRIDGE_HMAC_SECRET", HMAC_SECRET);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function seed(t: TestConvex<typeof schema>) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Types Org",
      slug: "types-org",
      settings: {
        timezone: "America/Sao_Paulo",
        currency: "BRL",
        aiConfig: { enabled: true, autoAssign: true, handoffThreshold: 0.5 },
      },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", { email: "admin@test.hnbcrm.com" });
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId: adminUserId,
      name: "Admin",
      role: "admin",
      type: "human",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("teamMembers", {
      organizationId,
      name: "AI Agent",
      role: "ai",
      type: "ai",
      status: "active",
      agentProfile: { kind: "attendant", mode: "suggest" },
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
    return { organizationId, adminUserId };
  });
  const asAdmin = t.withIdentity({ subject: `${seeded.adminUserId}|session1` });
  const configId = await asAdmin.action(api.channelConfigs.createChannelConfig, {
    organizationId: seeded.organizationId,
    channel: "whatsapp",
    provider: "bridge",
    displayName: "Bridge number",
    bridgeBaseUrl: BRIDGE_BASE_URL,
    bridgeInstanceId: INSTANCE_ID,
    bridgeToken: BRIDGE_TOKEN,
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(configId, { bridgeLid: OUR_LID, bridgePhone: OUR_PHONE });
  });
  return { ...seeded, asAdmin, configId };
}

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function post(t: TestConvex<typeof schema>, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await t.fetch("/webhooks/bridge", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", "X-Hmac-Signature": await sign(body) },
  });
  expect(res.status).toBe(200);
}

/** Ingere uma mensagem pelo caminho real (parse → action de ingest). */
async function ingest(t: TestConvex<typeof schema>, configId: Id<"channelConfigs">, payload: unknown) {
  const parsed = parseBridgeEvent(payload);
  if (parsed.kind === "message") {
    await t.action(internal.bridge.internalIngestBridgeMessage, { configId, message: parsed.message });
  } else if (parsed.kind === "group_message") {
    await t.action(internal.bridge.internalIngestGroupMessage, { configId, message: parsed.message });
  } else {
    throw new Error(`esperava mensagem, veio ${parsed.kind}`);
  }
}

async function messages(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .collect()
  );
}

async function byExternalId(t: TestConvex<typeof schema>, externalId: string) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("messages").collect()).find((m) => m.externalId === externalId) ?? null
  );
}

describe("ingest — ruído não vira mensagem nem acorda a IA", () => {
  test("senderKeyDistributionMessage no 1 a 1: nada agendado, nada gravado, fila da IA vazia", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    await post(t, env(fx.senderKeyOnly));
    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((s) => s.name.includes("internalIngest"))).toHaveLength(0);
    expect(await messages(t, organizationId)).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("aiReplyQueue").collect())).toHaveLength(0);
    expect(await t.run(async (ctx) => ctx.db.query("contacts").collect())).toHaveLength(0);
  });

  test("controle: uma mensagem de texto do mesmo contato É ingerida", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seed(t);
    await ingest(t, configId, env({ conversation: "oi" }));
    expect(await messages(t, organizationId)).toHaveLength(1);
  });

  test("tipo novo entra como texto com placeholder e bridgeExtra", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seed(t);
    await ingest(t, configId, env(fx.poll));
    const [m] = await messages(t, organizationId);
    expect(m.contentType).toBe("text");
    expect(m.content).toBe("[enquete: Qual dia é melhor?]");
    expect(m.metadata).toMatchObject({ bridgeType: "poll", bridgeExtra: { options: ["Sábado", "Domingo"] } });
  });
});

describe("ingest — apagar para todos e edição no 1 a 1", () => {
  test("o contato apaga: marca revoked, conteúdo preservado, sem mexer em unread", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    await ingest(t, configId, env({ conversation: "mensagem errada" }, { ID: "3EB0TARGET01" }));
    const before = await byExternalId(t, "3EB0TARGET01");
    const convBefore = await t.run(async (ctx) => ctx.db.get(before!.conversationId));

    await post(t, env(fx.revoke, { ID: "3EB0REVOKE01" }));

    const after = await byExternalId(t, "3EB0TARGET01");
    expect(after!.metadata).toMatchObject({ revoked: true });
    expect(after!.metadata!.revokedAt).toBeGreaterThan(0);
    expect(after!.content).toBe("mensagem errada");
    const convAfter = await t.run(async (ctx) => ctx.db.get(before!.conversationId));
    expect(convAfter!.unreadCount).toBe(convBefore!.unreadCount);
    expect(convAfter!.lastMessageAt).toBe(convBefore!.lastMessageAt);
    expect(await byExternalId(t, "3EB0REVOKE01")).toBeNull();
  });

  test("lista do inbox expõe lastMessageRevoked e lastMessageBridgeExtra", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId, asAdmin } = await seed(t);
    await ingest(t, configId, env(fx.poll, { ID: "3EB0POLL" }));
    let [row] = (await asAdmin.query(api.conversations.getConversations, { organizationId })) as any[];
    expect(row.lastMessageBridgeType).toBe("poll");
    expect(row.lastMessageBridgeExtra).toMatchObject({ question: "Qual dia é melhor?" });
    expect(row.lastMessageRevoked).toBe(false);

    await post(t, env({ protocolMessage: { key: { ID: "3EB0POLL" }, type: 0 } }, { ID: "RP" }));
    [row] = (await asAdmin.query(api.conversations.getConversations, { organizationId })) as any[];
    expect(row.lastMessageRevoked).toBe(true);
  });

  test("OUTRO contato não consegue apagar a mensagem alheia", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    await ingest(t, configId, env({ conversation: "minha" }, { ID: "3EB0TARGET01" }));
    const otherJid = `${OTHER_PHONE}@s.whatsapp.net`;
    await post(t, env(fx.revoke, { ID: "3EB0REVOKE02", Chat: otherJid, Sender: otherJid }));
    expect((await byExternalId(t, "3EB0TARGET01"))!.metadata?.revoked).toBeUndefined();
  });

  test("o contato não apaga a NOSSA mensagem (só fromMe apaga outbound)", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    await ingest(t, configId, env({ conversation: "resposta nossa" }, { ID: "3EB0OURS", IsFromMe: true, Sender: `${OUR_PHONE}@s.whatsapp.net` }));
    await post(t, env({ protocolMessage: { key: { ID: "3EB0OURS" }, type: 0 } }, { ID: "R3" }));
    expect((await byExternalId(t, "3EB0OURS"))!.metadata?.revoked).toBeUndefined();
    // Apagado pelo nosso aparelho: vale.
    await post(
      t,
      env({ protocolMessage: { key: { ID: "3EB0OURS" }, type: 0 } }, { ID: "R4", IsFromMe: true, Sender: `${OUR_PHONE}@s.whatsapp.net` })
    );
    expect((await byExternalId(t, "3EB0OURS"))!.metadata?.revoked).toBe(true);
  });

  test("alvo desconhecido é ignorado em silêncio", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seed(t);
    await post(t, env(fx.revoke, { ID: "3EB0REVOKE03" }));
    expect(await messages(t, organizationId)).toHaveLength(0);
  });

  test("edição troca o conteúdo e guarda o PRIMEIRO original", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);
    await ingest(t, configId, env({ conversation: "texto com eroo" }, { ID: "3EB0TARGET01" }));
    await post(t, env(fx.edit, { ID: "E1" }));
    let m = await byExternalId(t, "3EB0TARGET01");
    expect(m!.content).toBe("texto corrigido");
    expect(m!.metadata).toMatchObject({ edited: true, previousContent: "texto com eroo" });

    await post(
      t,
      env({ protocolMessage: { key: { ID: "3EB0TARGET01" }, type: 14, editedMessage: { conversation: "versão 3" } } }, { ID: "E2" })
    );
    m = await byExternalId(t, "3EB0TARGET01");
    expect(m!.content).toBe("versão 3");
    expect(m!.metadata!.previousContent).toBe("texto com eroo");
    // Edição não enfileira a IA de novo: só o ingest original enfileirou.
    const queue = await t.run(async (ctx) => ctx.db.query("aiReplyQueue").collect());
    expect(queue.length).toBeLessThanOrEqual(1);
  });
});

describe("ingest — apagar e editar em grupo", () => {
  async function seedMonitoredGroup(t: TestConvex<typeof schema>) {
    const seeded = await seed(t);
    await seeded.asAdmin.mutation(api.groupChats.acceptGroupsAck, { channelConfigId: seeded.configId });
    await seeded.asAdmin.mutation(api.groupChats.setGroupsEnabled, { channelConfigId: seeded.configId, enabled: true });
    const groupChatId = await t.run(async (ctx) => {
      const now = Date.now();
      return await ctx.db.insert("groupChats", {
        organizationId: seeded.organizationId,
        channelConfigId: seeded.configId,
        jid: GROUP_JID,
        subject: "Sala",
        monitored: false,
        participants: [
          { lid: OUR_LID, phone: OUR_PHONE, isAdmin: false, isSuperAdmin: false },
          { lid: ADMIN_LID, phone: ADMIN_PHONE, isAdmin: true, isSuperAdmin: false },
          { lid: MEMBER_LID, phone: MEMBER_PHONE, isAdmin: false, isSuperAdmin: false },
        ],
        participantsCount: 3,
        createdAt: now,
        updatedAt: now,
      });
    });
    await seeded.asAdmin.mutation(api.groupChats.setMonitored, { groupChatId, monitored: true });
    return seeded;
  }
  const asAdminMember = { Sender: ADMIN_LID, SenderAlt: `${ADMIN_PHONE}@s.whatsapp.net`, PushName: "Admin" };

  test("senderKey em grupo acompanhado não grava nada", async () => {
    const t = convexTest(schema, modules);
    const { organizationId } = await seedMonitoredGroup(t);
    await post(t, groupEnv(fx.senderKeyOnly));
    expect(await messages(t, organizationId)).toHaveLength(0);
  });

  test("autor apaga e edita a própria mensagem", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seedMonitoredGroup(t);
    await ingest(t, configId, groupEnv({ conversation: "oi sala" }, { ID: "3EB0TARGET01" }));
    expect(await byExternalId(t, "3EB0TARGET01")).not.toBeNull();

    await post(t, groupEnv(fx.edit, { ID: "GE1" }));
    expect((await byExternalId(t, "3EB0TARGET01"))!.content).toBe("texto corrigido");

    await post(t, groupEnv(fx.revoke, { ID: "GR1" }));
    expect((await byExternalId(t, "3EB0TARGET01"))!.metadata?.revoked).toBe(true);
  });

  test("outro membro comum não apaga nem edita; admin apaga mas não edita", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seedMonitoredGroup(t);
    await ingest(t, configId, groupEnv({ conversation: "do membro" }, { ID: "3EB0TARGET01" }));

    // O próprio número não-admin tentando apagar mensagem de membro (sem fromMe é outro membro).
    const stranger = { Sender: "90000000000099@lid", SenderAlt: "15550000099@s.whatsapp.net" };
    await post(t, groupEnv(fx.revoke, { ID: "GR2", ...stranger }));
    expect((await byExternalId(t, "3EB0TARGET01"))!.metadata?.revoked).toBeUndefined();

    await post(t, groupEnv(fx.edit, { ID: "GE2", ...asAdminMember }));
    expect((await byExternalId(t, "3EB0TARGET01"))!.content).toBe("do membro");

    await post(t, groupEnv(fx.revoke, { ID: "GR3", ...asAdminMember }));
    expect((await byExternalId(t, "3EB0TARGET01"))!.metadata?.revoked).toBe(true);
  });

  test("revoke com o mesmo id vindo do 1 a 1 não atinge mensagem de grupo", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seedMonitoredGroup(t);
    await ingest(t, configId, groupEnv({ conversation: "na sala" }, { ID: "3EB0TARGET01" }));
    const memberJid = `${MEMBER_PHONE}@s.whatsapp.net`;
    await post(t, env(fx.revoke, { ID: "R9", Chat: memberJid, Sender: memberJid }));
    expect((await byExternalId(t, "3EB0TARGET01"))!.metadata?.revoked).toBeUndefined();
  });
});

// ── C. Op de reprocessamento ──

describe("opsBridgeReparse", () => {
  async function seedLegacy(t: TestConvex<typeof schema>) {
    const seeded = await seed(t);
    await ingest(t, seeded.configId, env({ conversation: "original" }, { ID: "3EB0TARGET01" }));
    const original = (await byExternalId(t, "3EB0TARGET01"))!;
    const ids = await t.run(async (ctx) => {
      const base = {
        organizationId: seeded.organizationId,
        conversationId: original.conversationId,
        leadId: original.leadId,
        direction: "inbound" as const,
        senderType: "contact" as const,
        contentType: "text" as const,
        content: "[mensagem não suportada]",
        isInternal: false,
      };
      const t0 = Date.now() + 1000;
      const noise1 = await ctx.db.insert("messages", {
        ...base,
        externalId: "L1",
        metadata: { bridgeType: "unknown", raw: fx.senderKeyOnly },
        createdAt: t0,
      });
      const noise2 = await ctx.db.insert("messages", {
        ...base,
        externalId: "L2",
        metadata: { bridgeType: "unknown", raw: fx.statusMention },
        createdAt: t0 + 1,
      });
      const album = await ctx.db.insert("messages", {
        ...base,
        externalId: "L3",
        metadata: { bridgeType: "unknown", raw: fx.album },
        createdAt: t0 + 2,
      });
      const still = await ctx.db.insert("messages", {
        ...base,
        externalId: "L4",
        metadata: { bridgeType: "unknown", raw: fx.unknownType },
        createdAt: t0 + 3,
      });
      const edit = await ctx.db.insert("messages", {
        ...base,
        externalId: "L5",
        metadata: { bridgeType: "unknown", raw: fx.edit },
        createdAt: t0 + 4,
      });
      await ctx.db.patch(original.conversationId, { unreadCount: 6 });
      return { noise1, noise2, album, still, edit };
    });
    return { ...seeded, ids, conversationId: original.conversationId };
  }

  test("dryRun conta e não escreve", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, ids } = await seedLegacy(t);
    const res = await t.mutation(internal.opsBridgeReparse.internalReparseUnknownBridgeMessages, { organizationId });
    expect(res.dryRun).toBe(true);
    expect(res.unknownFound).toBe(5);
    expect(res.ignoredDeleted).toBe(3); // 2 ruídos + a bolha da edição
    expect(res.editApplied).toBe(1);
    expect(res.reparsed).toEqual({ album: 1 });
    expect(res.stillUnknown).toEqual({ requestPaymentMessage: 1 });
    expect(res.unreadDecremented).toBe(3);
    expect(res.samples.deleted).toContain(ids.noise1);
    expect(res.scheduledNext).toBe(false);
    expect(await messages(t, organizationId)).toHaveLength(6);
    expect((await byExternalId(t, "3EB0TARGET01"))!.content).toBe("original");
  });

  test("real: apaga ruído, desconta unread, reprocessa álbum, aplica a edição, reagenda pelo cursor", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, ids, conversationId } = await seedLegacy(t);
    const res = await t.mutation(internal.opsBridgeReparse.internalReparseUnknownBridgeMessages, {
      organizationId,
      dryRun: false,
      pageSize: 4,
    });
    expect(res.isDone).toBe(false);
    expect(res.scheduledNext).toBe(true);
    // Drena a continuação agendada.
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const left = await messages(t, organizationId);
    const leftIds = left.map((m) => m._id);
    expect(leftIds).not.toContain(ids.noise1);
    expect(leftIds).not.toContain(ids.noise2);
    expect(leftIds).not.toContain(ids.edit);
    const album = left.find((m) => m._id === ids.album)!;
    expect(album.content).toBe("[álbum: 20 fotos]");
    expect(album.metadata).toMatchObject({ bridgeType: "album", bridgeExtra: { imageCount: 20, videoCount: 0 } });
    const still = left.find((m) => m._id === ids.still)!;
    expect(still.metadata).toMatchObject({ bridgeType: "unknown", bridgeExtra: { type: "requestPaymentMessage" } });
    const original = (await byExternalId(t, "3EB0TARGET01"))!;
    expect(original.content).toBe("texto corrigido");
    expect(original.metadata!.previousContent).toBe("original");
    const conv = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(conv!.unreadCount).toBe(3);
  });

  test("unread nunca fica negativo e deleteContentless:false mantém as bolhas", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, conversationId } = await seedLegacy(t);
    await t.run(async (ctx) => ctx.db.patch(conversationId, { unreadCount: 1 }));
    const keep = await t.mutation(internal.opsBridgeReparse.internalReparseUnknownBridgeMessages, {
      organizationId,
      dryRun: false,
      deleteContentless: false,
    });
    expect(keep.ignoredDeleted).toBe(0);
    expect(keep.ignoredKept).toBe(3);
    expect(await messages(t, organizationId)).toHaveLength(6);

    await t.mutation(internal.opsBridgeReparse.internalReparseUnknownBridgeMessages, { organizationId, dryRun: false });
    const conv = await t.run(async (ctx) => ctx.db.get(conversationId));
    expect(conv!.unreadCount).toBe(0);
  });
});
