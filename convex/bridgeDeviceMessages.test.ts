/// <reference types="vite/client" />
/**
 * Mensagem que sai do NOSSO número sem passar pelo CRM — alguém digitou no app
 * do celular pareado ao bridge (`Info.IsFromMe: true`).
 *
 * Até a v0.55 o parser descartava tudo que era `fromMe` para evitar o eco do
 * próprio CRM. Só que o WhatsApp multi-device manda o MESMO evento nos dois
 * casos, então a conversa do inbox divergia da conversa real: o cliente via no
 * celular respostas que o CRM (e o atendente IA, que lê o histórico) não tinha.
 *
 * Estes testes travam as duas metades: o do aparelho ENTRA, o eco do CRM NÃO
 * duplica.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const TEST_KEY = btoa("A".repeat(32));
const INSTANCE_ID = "org_device_instance";
const BRIDGE_TOKEN = "fake-instance-token";
const BRIDGE_BASE_URL = "https://wa-gw.example.test";

const CONTACT_PHONE = "15550000042";
const CONTACT_JID = `${CONTACT_PHONE}@s.whatsapp.net`;
// O nosso próprio número (quem "envia" quando a mensagem é fromMe).
const OWN_JID = "5581988887777:14@s.whatsapp.net";

beforeEach(() => {
  // Timers falsos seguram os jobs agendados (webhook de `message.sent`) dentro
  // do teste — sem isso eles disparam depois que o convex-test já fechou a
  // transação e o vitest reporta unhandled rejection.
  vi.useFakeTimers();
  vi.stubEnv("CHANNEL_ENCRYPTION_KEY", TEST_KEY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function seed(t: TestConvex<typeof schema>) {
  const seeded = await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Device Org",
      slug: "device-org",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const adminUserId = await ctx.db.insert("users", {});
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

  return { ...seeded, configId };
}

/** Roda o ingest direto, pulando o webhook (a rota HTTP já tem teste próprio). */
async function ingest(
  t: TestConvex<typeof schema>,
  configId: Id<"channelConfigs">,
  message: Record<string, unknown>
) {
  await t.action(internal.bridge.internalIngestBridgeMessage, {
    configId,
    message: {
      externalId: "3EB0DEVICE01",
      from: CONTACT_PHONE,
      fromMe: true,
      timestamp: Date.now(),
      contentType: "text" as const,
      content: "mandei pelo celular",
      ...message,
    } as any,
  });
}

async function messagesOf(t: TestConvex<typeof schema>, organizationId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("messages")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .collect()
  );
}

describe("mensagem enviada pelo aparelho (fromMe)", () => {
  test("entra como outbound, sem autor do CRM e marcada como 'device'", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seed(t);

    await ingest(t, configId, {});

    const messages = await messagesOf(t, organizationId);
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message.direction).toBe("outbound");
    expect(message.senderType).toBe("human");
    // Ninguém do CRM mandou: atribuir a um membro seria inventar autoria.
    expect(message.senderId).toBeUndefined();
    expect(message.metadata?.via).toBe("device");
    expect(message.content).toBe("mandei pelo celular");
  });

  test("cria contato e lead pelo telefone do CONTATO", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seed(t);

    await ingest(t, configId, {});

    const contacts = await t.run(async (ctx) =>
      ctx.db
        .query("contacts")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect()
    );
    expect(contacts).toHaveLength(1);
    // O telefone é o do outro lado da conversa — se fosse o `Sender` do evento,
    // cada mensagem enviada pelo celular criaria um lead com o número da própria
    // empresa.
    expect(contacts[0].whatsappNumber ?? contacts[0].phone).toContain(CONTACT_PHONE);
  });

  test("NÃO conta como não lida nem reabre a janela de 24h", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seed(t);

    await ingest(t, configId, {});

    const conversation = await t.run(async (ctx) =>
      ctx.db
        .query("conversations")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .first()
    );
    // Não há nada para o time ler: a mensagem é nossa.
    expect(conversation?.unreadCount ?? 0).toBe(0);
    // E `lastInboundAt` é o que libera envio livre fora da janela de 24h —
    // mentir aqui autorizaria envio que a Meta recusaria.
    expect(conversation?.lastInboundAt).toBeUndefined();
    expect(conversation?.lastMessageAt).toBeDefined();
  });

  test("NÃO enfileira o atendente IA (o gatilho é mensagem do contato)", async () => {
    const t = convexTest(schema, modules);
    const { configId } = await seed(t);

    await ingest(t, configId, {});

    const queued = await t.run(async (ctx) => ctx.db.query("aiReplyQueue").collect());
    expect(queued).toHaveLength(0);
  });

  test("eco do que o CRM enviou não duplica (idempotência por externalId)", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seed(t);

    // Chega o eco duas vezes (redelivery do gateway é normal).
    await ingest(t, configId, { externalId: "3EB0SAME" });
    await ingest(t, configId, { externalId: "3EB0SAME" });

    expect(await messagesOf(t, organizationId)).toHaveLength(1);
  });

  test("usa o carimbo do WhatsApp, mas nunca um do futuro", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seed(t);

    const past = Date.now() - 60 * 60 * 1000;
    await ingest(t, configId, { externalId: "3EB0PAST", timestamp: past });
    // Relógio do aparelho adiantado furaria a ordenação da conversa.
    await ingest(t, configId, { externalId: "3EB0FUTURE", timestamp: Date.now() + 86_400_000 });

    const messages = await messagesOf(t, organizationId);
    const byId = Object.fromEntries(messages.map((m) => [m.externalId, m]));
    expect(byId["3EB0PAST"].createdAt).toBe(past);
    expect(byId["3EB0FUTURE"].createdAt).toBeLessThanOrEqual(Date.now());
  });

  test("mensagem antiga não puxa a conversa para trás no inbox", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seed(t);

    // Chega a recente primeiro, depois a recuperação traz uma de 5 dias atrás.
    await ingest(t, configId, { externalId: "3EB0NOVA" });
    const recente = (await messagesOf(t, organizationId))[0].createdAt;
    await ingest(t, configId, {
      externalId: "3EB0VELHA",
      timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000,
    });

    const conversation = await t.run(async (ctx) =>
      ctx.db
        .query("conversations")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .first()
    );
    // Sobrescrever com a data da antiga jogaria a conversa para baixo na lista.
    expect(conversation?.lastMessageAt).toBe(recente);
  });

  test("mensagem do contato continua inbound, com o caminho de sempre", async () => {
    const t = convexTest(schema, modules);
    const { organizationId, configId } = await seed(t);

    await t.action(internal.bridge.internalIngestBridgeMessage, {
      configId,
      message: {
        externalId: "2A0INBOUND",
        from: CONTACT_PHONE,
        fromMe: false,
        profileName: "Maria",
        timestamp: Date.now(),
        contentType: "text" as const,
        content: "oi",
      } as any,
    });

    const messages = await messagesOf(t, organizationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe("inbound");
    expect(messages[0].senderType).toBe("contact");
  });
});

describe("parser: fromMe", () => {
  test("resolve o telefone pelo Chat e descarta o nosso PushName", async () => {
    const { parseBridgeEvent } = await import("./lib/bridgeParse");
    const parsed = parseBridgeEvent({
      type: "Message",
      event: {
        Info: {
          ID: "3EB0X",
          Sender: OWN_JID,
          Chat: CONTACT_JID,
          PushName: "Nossa Empresa",
          IsFromMe: true,
          IsGroup: false,
          Timestamp: "2026-09-16T12:00:00Z",
        },
        Message: { conversation: "resposta pelo celular" },
      },
    });
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") return;
    expect(parsed.message.fromMe).toBe(true);
    expect(parsed.message.from).toBe(CONTACT_PHONE);
    expect(parsed.message.profileName).toBeUndefined();
  });

  test("com LID no Chat, cai no alternativo em vez de inventar telefone", async () => {
    const { parseBridgeEvent } = await import("./lib/bridgeParse");
    const parsed = parseBridgeEvent({
      type: "Message",
      event: {
        Info: {
          ID: "3EB0Y",
          Sender: OWN_JID,
          Chat: "123456789@lid",
          ChatAlt: CONTACT_JID,
          IsFromMe: true,
          IsGroup: false,
        },
        Message: { conversation: "oi" },
      },
    });
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") return;
    expect(parsed.message.from).toBe(CONTACT_PHONE);
  });

  test("só LID e nada mais → ignora, não cria contato com número falso", async () => {
    const { parseBridgeEvent } = await import("./lib/bridgeParse");
    const parsed = parseBridgeEvent({
      type: "Message",
      event: {
        Info: { ID: "3EB0Z", Sender: OWN_JID, Chat: "123456789@lid", IsFromMe: true, IsGroup: false },
        Message: { conversation: "oi" },
      },
    });
    expect(parsed.kind).toBe("ignored");
  });

  test("a NOSSA reação continua fora (seria atribuída ao contato)", async () => {
    const { parseBridgeEvent } = await import("./lib/bridgeParse");
    const parsed = parseBridgeEvent({
      type: "Message",
      event: {
        Info: { ID: "3EB0R", Sender: OWN_JID, Chat: CONTACT_JID, IsFromMe: true, IsGroup: false },
        Message: { reactionMessage: { key: { ID: "2A0TARGET" }, text: "👍" } },
      },
    });
    expect(parsed.kind).toBe("ignored");
  });

  // v0.57: grupo saiu do descarte e virou um caminho próprio. `fromMe` num
  // grupo é a MESMA coisa do 1:1 — eco do CRM ou alguém digitando no celular —
  // e o ingest decide se aquele grupo é acompanhado.
  test("grupo NÃO é mais descartado no parser: vira group_message fromMe", async () => {
    const { parseBridgeEvent } = await import("./lib/bridgeParse");
    const parsed = parseBridgeEvent({
      type: "Message",
      event: {
        Info: { ID: "3EB0G", Sender: OWN_JID, Chat: "12345@g.us", IsFromMe: true, IsGroup: true },
        Message: { conversation: "oi turma" },
      },
    });
    expect(parsed.kind).toBe("group_message");
    if (parsed.kind !== "group_message") return;
    expect(parsed.message.fromMe).toBe(true);
    expect(parsed.message.chatJid).toBe("12345@g.us");
    // PushName nosso não vira nome de membro (mesma regra do 1:1).
    expect(parsed.message.senderName).toBeUndefined();
  });
});
