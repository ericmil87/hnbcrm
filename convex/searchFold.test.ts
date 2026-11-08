/// <reference types="vite/client" />
/**
 * Busca sem acento (07/11/2026): contatos (`search_contacts` com `searchText`
 * dobrado) e mensagens (`search_norm` com `searchNorm` dobrado), mais os
 * backfills de `opsSearchFold`.
 *
 * Protege: "antonio"/"REBOUÇAS" acham "Antônio Rebouças"; mensagem nova acha
 * "reboucas"; mensagem antiga sem o campo continua achável pelo termo exato;
 * transcrição/edição atualizam o campo; backfill dry run conta e não escreve,
 * real é idempotente; outra org nunca aparece.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { Id } from "./_generated/dataModel";
import { buildSearchText } from "./lib/searchText";
import { withMessageSearch } from "./lib/messageSearch";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

type T = TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedOrg(t: T, slug: string) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: slug,
      slug,
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: `admin@${slug}.test` });
    await ctx.db.insert("teamMembers", {
      organizationId,
      userId,
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
    const stageId = await ctx.db.insert("stages", {
      organizationId,
      boardId,
      name: "Novo",
      color: "#6366f1",
      order: 0,
      isClosedWon: false,
      isClosedLost: false,
      createdAt: now,
      updatedAt: now,
    });
    return { organizationId, userId, boardId, stageId };
  });
}

type Org = Awaited<ReturnType<typeof seedOrg>>;

/** Contato + lead + conversa. `legacySearchText` simula contato gravado antes da dobra. */
async function addContact(
  t: T,
  org: Org,
  contact: { firstName?: string; lastName?: string },
  opts: { legacySearchText?: string } = {}
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const contactId = await ctx.db.insert("contacts", {
      organizationId: org.organizationId,
      ...contact,
      tags: [],
      searchText: opts.legacySearchText ?? buildSearchText(contact),
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId: org.organizationId,
      title: `Lead ${contact.firstName ?? ""}`,
      contactId,
      boardId: org.boardId,
      stageId: org.stageId,
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
    const conversationId = await ctx.db.insert("conversations", {
      organizationId: org.organizationId,
      leadId,
      channel: "whatsapp",
      status: "active",
      messageCount: 1,
      lastMessageAt: now,
      unreadCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return { contactId, leadId, conversationId };
  });
}

async function addMessage(
  t: T,
  org: Org,
  conversationId: Id<"conversations">,
  content: string,
  opts: { legacy?: boolean; contentType?: "text" | "audio" } = {}
) {
  return await t.run(async (ctx) => {
    const doc = {
      organizationId: org.organizationId,
      conversationId,
      direction: "inbound" as const,
      senderType: "contact" as const,
      content,
      contentType: opts.contentType ?? ("text" as const),
      isInternal: false,
      // Espelhos vazios: o fake de search index do `convex-test` quebra em doc
      // com o campo do índice `undefined` (ver inboxListDenorm.test.ts).
      transcriptText: "",
      imageDescription: "",
      createdAt: Date.now(),
    };
    // `legacy`: mensagem gravada antes da busca sem acento. Em produção ela NÃO tem
    // `searchNorm`; aqui fica "" pelo mesmo motivo (nenhum termo casa com "").
    return await ctx.db.insert("messages", opts.legacy ? { ...doc, searchNorm: "" } : withMessageSearch(doc));
  });
}

function asAdmin(t: T, org: Org) {
  return t.withIdentity({ subject: `${org.userId}|s1` });
}

describe("contatos sem acento", () => {
  test("Antônio Rebouças é achado por antonio, reboucas e REBOUÇAS (e não aparece em outra org)", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-a");
    const other = await seedOrg(t, "org-b");
    const { contactId } = await addContact(t, org, { firstName: "Antônio", lastName: "Rebouças" });
    await addContact(t, other, { firstName: "Antônio", lastName: "Rebouças" });

    for (const term of ["antonio", "reboucas", "REBOUÇAS", "Antônio"]) {
      const contacts = await asAdmin(t, org).query(api.contacts.searchContacts, {
        organizationId: org.organizationId,
        searchText: term,
      });
      expect(contacts.map((c: { _id: string }) => c._id), term).toEqual([contactId]);

      const rows = await asAdmin(t, org).query(api.conversations.searchConversationsByContact, {
        organizationId: org.organizationId,
        searchQuery: term,
      });
      expect(rows, term).toHaveLength(1);
      expect(rows[0].contactName).toBe("Antônio Rebouças");
    }
  });

  test("contato antigo (searchText com acento, sem backfill) ainda é achado digitando o acento", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-a");
    const { contactId } = await addContact(
      t,
      org,
      { firstName: "Antônio" },
      { legacySearchText: "Antônio" }
    );
    const found = await asAdmin(t, org).query(api.contacts.searchContacts, {
      organizationId: org.organizationId,
      searchText: "Antônio",
    });
    expect(found.map((c: { _id: string }) => c._id)).toEqual([contactId]);
  });

  test("backfill de contatos: dry run conta sem escrever, real dobra e é idempotente", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-a");
    const { contactId } = await addContact(t, org, { firstName: "Antônio" }, { legacySearchText: "Antônio @toni" });
    await addContact(t, org, { firstName: "Maria" }); // já dobrado

    const dry = await t.mutation(internal.opsSearchFold.internalBackfillContactSearchText, {});
    expect(dry).toMatchObject({ dryRun: true, scanned: 2, wouldWrite: 1, written: 0, isDone: true });
    expect((await t.run((ctx) => ctx.db.get(contactId)))!.searchText).toBe("Antônio @toni");

    const real = await t.mutation(internal.opsSearchFold.internalBackfillContactSearchText, { dryRun: false });
    expect(real).toMatchObject({ dryRun: false, wouldWrite: 1, written: 1 });
    expect((await t.run((ctx) => ctx.db.get(contactId)))!.searchText).toBe("antonio @toni");

    const again = await t.mutation(internal.opsSearchFold.internalBackfillContactSearchText, { dryRun: false });
    expect(again).toMatchObject({ wouldWrite: 0, written: 0 });

    const found = await asAdmin(t, org).query(api.contacts.searchContacts, {
      organizationId: org.organizationId,
      searchText: "antonio",
    });
    expect(found.map((c: { _id: string }) => c._id)).toEqual([contactId]);
  });
});

describe("mensagens sem acento", () => {
  test("mensagem nova grava searchNorm dobrado; REBOUÇAS/Rebouças acham pelos índices antigos; outra org não aparece", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-a");
    const other = await seedOrg(t, "org-b");
    const { conversationId } = await addContact(t, org, { firstName: "Ana" });
    const { conversationId: otherConv } = await addContact(t, other, { firstName: "Ana" });
    const messageId = await addMessage(t, org, conversationId, "Moro na Rua Rebouças, 12");
    await addMessage(t, other, otherConv, "Moro na Rua Rebouças, 12");

    expect((await t.run((ctx) => ctx.db.get(messageId)))!.searchNorm).toBe("moro na rua reboucas, 12");
    for (const term of ["REBOUÇAS", "Rebouças"]) {
      const hits = await asAdmin(t, org).query(api.conversations.searchMessages, {
        organizationId: org.organizationId,
        searchQuery: term,
      });
      expect(hits.map((h) => h._id), term).toEqual([messageId]);
      expect(hits[0].snippetText).toBe("Moro na Rua Rebouças, 12");
    }
    // Dentro da conversa (pesquisa na conversa).
    const inConv = await asAdmin(t, org).query(api.conversations.searchMessages, {
      organizationId: org.organizationId,
      searchQuery: "Rebouças",
      conversationId,
    });
    expect(inConv).toHaveLength(1);
  });

  test("mensagem antiga sem searchNorm continua achável pelo termo exato", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-a");
    const { conversationId } = await addContact(t, org, { firstName: "Ana" });
    const legacyId = await addMessage(t, org, conversationId, "Rua Rebouças", { legacy: true });

    const exact = await asAdmin(t, org).query(api.conversations.searchMessages, {
      organizationId: org.organizationId,
      searchQuery: "Rebouças",
    });
    expect(exact.map((h) => h._id)).toEqual([legacyId]);
  });

  test("transcrição concluída entra no searchNorm e marca matchedTranscript", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-a");
    const { conversationId } = await addContact(t, org, { firstName: "Ana" });
    const audioId = await addMessage(t, org, conversationId, "[áudio]", { contentType: "audio" });
    await t.mutation(internal.transcription.internalSetTranscriptionResult, {
      messageId: audioId,
      status: "done",
      text: "Quero ir na Vivência de São João",
    });
    const doc = await t.run((ctx) => ctx.db.get(audioId));
    expect(doc!.searchNorm).toBe("[audio] quero ir na vivencia de sao joao");

    const hits = await asAdmin(t, org).query(api.conversations.searchMessages, {
      organizationId: org.organizationId,
      searchQuery: "Vivência",
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedTranscript).toBe(true);
    expect(hits[0].snippetText).toBe("Quero ir na Vivência de São João");
  });

  test("getMessages não devolve searchNorm ao cliente", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-a");
    const { conversationId } = await addContact(t, org, { firstName: "Ana" });
    await addMessage(t, org, conversationId, "Olá, tudo bem?");
    const messages = await asAdmin(t, org).query(api.conversations.getMessages, { conversationId });
    expect(messages).toHaveLength(1);
    expect("searchNorm" in messages[0]).toBe(false);
  });

  test("backfill de mensagens: dry run conta, real grava, repetir não escreve; sinceMs e org recortam", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-a");
    const other = await seedOrg(t, "org-b");
    const { conversationId } = await addContact(t, org, { firstName: "Ana" });
    const { conversationId: otherConv } = await addContact(t, other, { firstName: "Bia" });
    const oldId = await addMessage(t, org, conversationId, "Rua Rebouças", { legacy: true });
    await addMessage(t, org, conversationId, "já tem o campo");
    await addMessage(t, other, otherConv, "Ação na outra org", { legacy: true });

    const dry = await t.mutation(internal.opsSearchFold.internalBackfillMessageSearchText, {});
    expect(dry).toMatchObject({ dryRun: true, scanned: 3, wouldWrite: 2, written: 0, isDone: true });
    expect((await t.run((ctx) => ctx.db.get(oldId)))!.searchNorm).toBe("");

    const scoped = await t.mutation(internal.opsSearchFold.internalBackfillMessageSearchText, {
      organizationId: org.organizationId,
    });
    expect(scoped).toMatchObject({ scanned: 2, wouldWrite: 1 });

    const future = await t.mutation(internal.opsSearchFold.internalBackfillMessageSearchText, {
      sinceMs: Date.now() + 60_000,
    });
    expect(future).toMatchObject({ scanned: 0, wouldWrite: 0 });

    const real = await t.mutation(internal.opsSearchFold.internalBackfillMessageSearchText, {
      dryRun: false,
      organizationId: org.organizationId,
    });
    expect(real).toMatchObject({ written: 1 });
    expect((await t.run((ctx) => ctx.db.get(oldId)))!.searchNorm).toBe("rua reboucas");

    const again = await t.mutation(internal.opsSearchFold.internalBackfillMessageSearchText, {
      dryRun: false,
      organizationId: org.organizationId,
    });
    expect(again).toMatchObject({ written: 0 });
  });

  test("backfill real em várias páginas agenda a continuação até o fim", async () => {
    const t = convexTest(schema, modules);
    const org = await seedOrg(t, "org-a");
    const { conversationId } = await addContact(t, org, { firstName: "Ana" });
    for (let i = 0; i < 5; i++) await addMessage(t, org, conversationId, `Ação ${i}`, { legacy: true });

    const first = await t.mutation(internal.opsSearchFold.internalBackfillMessageSearchText, {
      dryRun: false,
      pageSize: 2,
    });
    expect(first).toMatchObject({ written: 2, isDone: false, scheduledNext: true });
    // Próxima página com a pausa padrão (500 ms) entre páginas.
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").take(5));
    expect(jobs).toHaveLength(1);
    expect(jobs[0].scheduledTime - Date.now()).toBeGreaterThanOrEqual(500);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const docs = await t.run((ctx) => ctx.db.query("messages").take(10));
    expect(docs.every((d) => d.searchNorm?.startsWith("acao "))).toBe(true);
  });
});
