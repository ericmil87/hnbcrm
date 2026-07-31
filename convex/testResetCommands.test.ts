/// <reference types="vite/client" />
/**
 * /resetlist e /resetother (comandos de teste via WhatsApp). Prova que:
 *  - o parser só aceita o comando exato (trim/case, argumento no lugar certo);
 *  - valem os MESMOS gates do /resetme (env + allowlist do remetente) e a
 *    mensagem de comando nunca é persistida;
 *  - a lista traz os 10 leads mais recentes, numerados, marcando quem não tem
 *    telefone como não resetável;
 *  - o /resetother resolve por índice da lista e por sufixo do telefone;
 *  - ambiguidade de sufixo NÃO reseta ninguém — pede mais dígitos.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { parseTestCommand } from "./testReset";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

const SENDER_PHONE = "558181392929";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function setup() {
  return convexTest(schema, modules);
}

type Seed = Awaited<ReturnType<typeof seedOrg>>;

async function seedOrg(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Comandos",
      slug: "org-comandos",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    // Autor das respostas dos comandos.
    const adminId = await ctx.db.insert("teamMembers", {
      organizationId,
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
      color: "#111",
      isDefault: true,
      order: 0,
      createdAt: now,
      updatedAt: now,
    });
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#111",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, adminId, boardId, stageId };
  });
}

// Lead + contato. `phone: null` = contato sem telefone; `withContact: false` =
// lead solto, sem contato nenhum.
async function addLead(
  t: TestConvex<typeof schema>,
  seed: Seed,
  opts: { name: string; phone?: string | null; withContact?: boolean }
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const contactId =
      opts.withContact === false
        ? undefined
        : await ctx.db.insert("contacts", {
            organizationId: seed.organizationId,
            firstName: opts.name,
            ...(opts.phone ? { phone: opts.phone, whatsappNumber: opts.phone } : {}),
            tags: [],
            createdAt: now,
            updatedAt: now,
          });
    const leadId = await ctx.db.insert("leads", {
      organizationId: seed.organizationId,
      title: opts.name,
      ...(contactId ? { contactId } : {}),
      boardId: seed.boardId,
      stageId: seed.stageId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "warm",
      tags: [],
      customFields: {},
      conversationStatus: "active",
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { leadId, contactId };
  });
}

// Manda o comando pelo ingest (mesmo caminho de Meta/bridge).
async function sendCommand(
  t: TestConvex<typeof schema>,
  seed: Seed,
  leadId: Id<"leads">,
  content: string
) {
  return await t.mutation(internal.conversations.internalReceiveMessage, {
    organizationId: seed.organizationId,
    leadId,
    channel: "whatsapp",
    content,
  });
}

async function scheduledCommands(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) =>
      f.name.includes("internalRunTestCommand")
    )
  );
}

async function conversationOf(t: TestConvex<typeof schema>, leadId: Id<"leads">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_lead_and_channel", (q) => q.eq("leadId", leadId).eq("channel", "whatsapp"))
      .first()
  );
}

// Roda o comando direto (o hook já foi provado à parte) e devolve o texto que
// foi para o WhatsApp do remetente.
async function runCommandAndRead(
  t: TestConvex<typeof schema>,
  seed: Seed,
  sender: { leadId: Id<"leads">; conversationId: Id<"conversations"> },
  command: "resetlist" | "resetother",
  arg = ""
): Promise<string> {
  await t.mutation(internal.testReset.internalRunTestCommand, {
    organizationId: seed.organizationId,
    conversationId: sender.conversationId,
    senderPhone: SENDER_PHONE,
    command,
    arg,
  });
  const reply = await t.run(async (ctx) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_and_created", (q) =>
        q.eq("conversationId", sender.conversationId)
      )
      .collect();
    return messages.filter((m) => m.direction === "outbound").at(-1) ?? null;
  });
  if (!reply) throw new Error("nenhuma resposta enviada");
  return reply.content;
}

// Remetente allowlisted, com a conversa de resposta criada pelo próprio hook do
// ingest (o comando não persiste, então ela nasce vazia — o que deixa a última
// outbound da conversa ser sempre a resposta do comando sob teste).
async function seedSender(t: TestConvex<typeof schema>, seed: Seed) {
  vi.stubEnv("WA_TEST_RESET_PHONES", SENDER_PHONE);
  const sender = await addLead(t, seed, { name: "Eric", phone: SENDER_PHONE });
  await sendCommand(t, seed, sender.leadId, "/resetlist");
  const conversation = await conversationOf(t, sender.leadId);
  return { ...sender, conversationId: conversation!._id };
}

describe("parseTestCommand", () => {
  test("aceita os três comandos com trim e case-insensitive", () => {
    expect(parseTestCommand("  /ResetMe  ")).toEqual({ kind: "resetme" });
    expect(parseTestCommand("/RESETLIST")).toEqual({ kind: "resetlist" });
    expect(parseTestCommand("  /resetother   3 ")).toEqual({ kind: "resetother", arg: "3" });
    expect(parseTestCommand("/resetother 8139")).toEqual({ kind: "resetother", arg: "8139" });
  });

  test("comando sem argumento e argumento sobrando", () => {
    expect(parseTestCommand("/resetother")).toEqual({ kind: "resetother", arg: "" });
    // /resetme e /resetlist não aceitam argumento — viram mensagem comum.
    expect(parseTestCommand("/resetlist agora")).toBeNull();
    expect(parseTestCommand("/resetme por favor")).toBeNull();
  });

  test("texto comum nunca é comando", () => {
    expect(parseTestCommand("oi, tudo bem?")).toBeNull();
    expect(parseTestCommand("resetlist")).toBeNull();
    expect(parseTestCommand("/resetlista")).toBeNull();
  });
});

describe("gates do ingest", () => {
  test("sem env: '/resetlist' é mensagem comum e nada é agendado", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const sender = await addLead(t, seed, { name: "Eric", phone: SENDER_PHONE });

    const id = await sendCommand(t, seed, sender.leadId, "/resetlist");
    expect(id).not.toBeNull();
    expect(await scheduledCommands(t)).toHaveLength(0);
  });

  test("telefone fora da allowlist: mensagem comum", async () => {
    const t = setup();
    vi.stubEnv("WA_TEST_RESET_PHONES", "5599000000000");
    const seed = await seedOrg(t);
    const sender = await addLead(t, seed, { name: "Eric", phone: SENDER_PHONE });

    const id = await sendCommand(t, seed, sender.leadId, "/resetother 2");
    expect(id).not.toBeNull();
    expect(await scheduledCommands(t)).toHaveLength(0);
  });

  test("allowlisted: comando não persiste e o trabalho é agendado com o arg", async () => {
    const t = setup();
    vi.stubEnv("WA_TEST_RESET_PHONES", `+55 (81) 8139-2929`);
    const seed = await seedOrg(t);
    const sender = await addLead(t, seed, { name: "Eric", phone: SENDER_PHONE });

    const id = await sendCommand(t, seed, sender.leadId, "  /ResetOther  3 ");
    expect(id).toBeNull();

    const messages = await t.run(async (ctx) => ctx.db.query("messages").collect());
    expect(messages).toHaveLength(0); // o comando não vira mensagem

    const scheduled = await scheduledCommands(t);
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].args[0]).toMatchObject({
      command: "resetother",
      arg: "3",
      senderPhone: SENDER_PHONE,
    });
    // A conversa de resposta foi garantida mesmo sem mensagem persistida.
    expect(await conversationOf(t, sender.leadId)).not.toBeNull();
  });
});

describe("/resetlist", () => {
  test("10 mais recentes, numerados, com o rodapé de uso", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const sender = await seedSender(t, seed);
    for (let i = 1; i <= 11; i++) {
      await addLead(t, seed, { name: `Lead ${i}`, phone: `55119000000${String(i).padStart(2, "0")}` });
    }

    const reply = await runCommandAndRead(t, seed, sender, "resetlist");
    const linhas = reply.split("\n");

    expect(linhas[0]).toBe("Leads mais recentes (10):");
    // Mais novo primeiro: o último lead inserido é o nº 1.
    expect(linhas[1]).toBe("1. Lead 11 — …0011");
    expect(linhas[2]).toBe("2. Lead 10 — …0010");
    expect(linhas[10]).toBe("10. Lead 2 — …0002");
    expect(reply).not.toContain("11. "); // o teto de 10 vale
    expect(linhas.at(-1)).toBe(
      "Para resetar: /resetother <nº da lista> ou /resetother <últimos 4+ dígitos do telefone>"
    );
  });

  test("lead sem telefone aparece marcado como não resetável", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const sender = await seedSender(t, seed);
    await addLead(t, seed, { name: "Contato sem fone", phone: null });
    await addLead(t, seed, { name: "Lead solto", withContact: false });

    const reply = await runCommandAndRead(t, seed, sender, "resetlist");
    expect(reply).toContain("1. Lead solto (sem telefone — não resetável)");
    expect(reply).toContain("2. Contato sem fone (sem telefone — não resetável)");
    expect(reply).toContain(`3. Eric — …${SENDER_PHONE.slice(-4)}`);
  });

  test("org sem leads responde que não há nada", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const sender = await seedSender(t, seed);
    // Some com o lead do próprio remetente (a conversa segue de pé para a resposta).
    await t.run(async (ctx) => ctx.db.delete(sender.leadId));

    expect(await runCommandAndRead(t, seed, sender, "resetlist")).toBe(
      "Nenhum lead nesta organização."
    );
  });
});

describe("/resetother", () => {
  test("por índice da lista: reseta o alvo e confirma com as contagens", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const sender = await seedSender(t, seed);
    const alvo = await addLead(t, seed, { name: "Maria", phone: "5511977776666" });
    await t.run(async (ctx) => {
      const now = Date.now();
      const conversationId = await ctx.db.insert("conversations", {
        organizationId: seed.organizationId,
        leadId: alvo.leadId,
        channel: "whatsapp",
        status: "active",
        messageCount: 1,
        createdAt: now,
        updatedAt: now,
      });
      await ctx.db.insert("messages", {
        organizationId: seed.organizationId,
        conversationId,
        leadId: alvo.leadId,
        direction: "inbound",
        senderType: "contact",
        content: "oi",
        contentType: "text",
        isInternal: false,
        createdAt: now,
      });
    });

    // Maria é o lead mais novo → nº 1 da lista.
    const reply = await runCommandAndRead(t, seed, sender, "resetother", "1");
    expect(reply).toMatch(/^Resetado: Maria \(…6666\) — \d+ documentos apagados$/);
    // 1 contato + 1 lead + 1 conversa + 1 mensagem = 4 documentos.
    expect(reply).toContain("4 documentos apagados");

    const restantes = await t.run(async (ctx) => ({
      leads: (await ctx.db.query("leads").collect()).map((l) => l.title),
      contacts: (await ctx.db.query("contacts").collect()).length,
    }));
    expect(restantes.leads).toEqual(["Eric"]); // só o remetente sobrou
    expect(restantes.contacts).toBe(1);
  });

  test("por sufixo do telefone", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const sender = await seedSender(t, seed);
    await addLead(t, seed, { name: "Maria", phone: "5511977776666" });
    await addLead(t, seed, { name: "João", phone: "5511955554444" });

    const reply = await runCommandAndRead(t, seed, sender, "resetother", "6666");
    expect(reply).toContain("Resetado: Maria (…6666)");

    const leads = await t.run(async (ctx) =>
      (await ctx.db.query("leads").collect()).map((l) => l.title)
    );
    expect(leads.sort()).toEqual(["Eric", "João"]);
  });

  test("sufixo ambíguo NÃO reseta ninguém — pede mais dígitos", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const sender = await seedSender(t, seed);
    await addLead(t, seed, { name: "Maria", phone: "5511977776666" });
    await addLead(t, seed, { name: "Joana", phone: "5521988886666" });

    const reply = await runCommandAndRead(t, seed, sender, "resetother", "6666");
    expect(reply).toContain("2 leads terminam em 6666");
    expect(reply).toContain("Use mais dígitos");
    // Os dígitos extras vêm na amostra, para o testador saber o que digitar.
    expect(reply).toContain("Joana (…88886666)");

    const leads = await t.run(async (ctx) => (await ctx.db.query("leads").collect()).length);
    expect(leads).toBe(3); // nada foi apagado
  });

  test("vários leads do MESMO número não são ambiguidade", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const sender = await seedSender(t, seed);
    await addLead(t, seed, { name: "Maria", phone: "5511977776666" });
    await addLead(t, seed, { name: "Maria", phone: "5511977776666" });

    const reply = await runCommandAndRead(t, seed, sender, "resetother", "6666");
    expect(reply).toContain("Resetado: Maria (…6666)");
    const leads = await t.run(async (ctx) =>
      (await ctx.db.query("leads").collect()).map((l) => l.title)
    );
    expect(leads).toEqual(["Eric"]); // os dois leads do número foram junto
  });

  test("alvo sem telefone, índice inexistente e argumento inválido só respondem", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const sender = await seedSender(t, seed);
    await addLead(t, seed, { name: "Sem fone", phone: null });

    expect(await runCommandAndRead(t, seed, sender, "resetother", "1")).toBe(
      "Sem fone não tem telefone — não dá para resetar."
    );
    expect(await runCommandAndRead(t, seed, sender, "resetother", "9")).toBe(
      "Não existe o nº 9 na lista. Veja com /resetlist."
    );
    expect(await runCommandAndRead(t, seed, sender, "resetother", "")).toContain("Uso: /resetother");
    expect(await runCommandAndRead(t, seed, sender, "resetother", "abc")).toContain(
      "Uso: /resetother"
    );
    // 3 dígitos não é índice nem sufixo aceitável.
    expect(await runCommandAndRead(t, seed, sender, "resetother", "123")).toContain(
      "Uso: /resetother"
    );
    expect(await runCommandAndRead(t, seed, sender, "resetother", "4321")).toBe(
      "Nenhum lead com telefone terminando em 4321."
    );

    const leads = await t.run(async (ctx) => (await ctx.db.query("leads").collect()).length);
    expect(leads).toBe(2); // nenhuma dessas respostas apagou nada
  });

  test("apontar para o próprio número manda usar /resetme", async () => {
    const t = setup();
    const seed = await seedOrg(t);
    const sender = await seedSender(t, seed);

    const reply = await runCommandAndRead(t, seed, sender, "resetother", SENDER_PHONE.slice(-6));
    expect(reply).toBe("Esse é o seu próprio número — use /resetme.");
    const leads = await t.run(async (ctx) => (await ctx.db.query("leads").collect()).length);
    expect(leads).toBe(1);
  });
});
