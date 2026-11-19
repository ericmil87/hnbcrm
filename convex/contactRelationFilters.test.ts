/// <reference types="vite/client" />
/**
 * PR2 "Ver e filtrar": filtro por tipo de contato na lista do inbox (índice
 * por tipo, ranges mesclados, limite exato), em Contatos, marcação em massa
 * pela porta única (RBAC, IA recusada, Desfazer), exclusão `non_customer`
 * nos públicos de campanha, Central sem não-clientes e o backfill do espelho.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import type { ContactRelation } from "./lib/contactRelation";
import { AI_ACTOR_RELATION_ERROR } from "./lib/contactRelationOps";
import {
  CONTACT_RELATION_FILTERS,
  matchesContactRelationFilter,
  relationValuesForFilter,
} from "./lib/contactRelationFilter";
import { buildGroupMembersAudience, resolveSegmentAudience } from "./lib/campaignAudience";
import { computeCentralDashboard } from "./lib/centralDashboard";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

type Seed = Awaited<ReturnType<typeof seed>>;

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Org Filtros",
      slug: "org-filtros",
      settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
      createdAt: now,
      updatedAt: now,
    });
    const member = async (name: string, role: "admin" | "agent" | "ai", type: "human" | "ai", extra = {}) => {
      const userId = await ctx.db.insert("users", {});
      const id = await ctx.db.insert("teamMembers", {
        organizationId,
        userId,
        name,
        role,
        type,
        status: "active",
        createdAt: now,
        updatedAt: now,
        ...extra,
      });
      return { userId, id };
    };
    const admin = await member("Eva Admin", "admin", "human");
    const viewer = await member("Vera Leitura", "agent", "human", {
      permissions: {
        leads: "edit_own",
        contacts: "view",
        inbox: "reply",
        tasks: "edit_own",
        reports: "view",
        team: "none",
        settings: "none",
        auditLogs: "none",
        apiKeys: "none",
        campaigns: "view",
      },
    });
    const ai = await member("Ana (IA)", "admin", "ai", { agentProfile: { kind: "attendant", mode: "suggest" } });
    const configA = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número A",
      phoneNumberId: "555000111",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const configB = await ctx.db.insert("channelConfigs", {
      organizationId,
      channel: "whatsapp",
      provider: "meta",
      displayName: "Número B",
      phoneNumberId: "555000112",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const boardId = await ctx.db.insert("boards", {
      organizationId,
      name: "Vendas",
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
    return {
      organizationId,
      adminUserId: admin.userId,
      adminId: admin.id,
      viewerUserId: viewer.userId,
      aiUserId: ai.userId,
      configA,
      configB,
      boardId,
      stageId,
    };
  });
}

const as = (t: TestConvex<typeof schema>, userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s1` });

let phoneSeq = 0;

/** Contato + lead + conversa 1:1 com o espelho coerente. */
async function addPerson(
  t: TestConvex<typeof schema>,
  s: Seed,
  o: {
    name: string;
    relation?: ContactRelation;
    lastMessageAt: number;
    archived?: boolean;
    leadArchived?: boolean;
    configId?: Id<"channelConfigs">;
    phone?: string;
  },
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    phoneSeq += 1;
    const contactId = await ctx.db.insert("contacts", {
      organizationId: s.organizationId,
      firstName: o.name,
      phone: o.phone ?? `55119880${String(10000 + phoneSeq).slice(-5)}`,
      tags: [],
      ...(o.relation ? { relation: o.relation } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const leadId = await ctx.db.insert("leads", {
      organizationId: s.organizationId,
      title: o.name,
      contactId,
      boardId: s.boardId,
      stageId: s.stageId,
      value: 0,
      currency: "BRL",
      priority: "medium",
      temperature: "warm",
      tags: [],
      customFields: {},
      conversationStatus: "active",
      lastActivityAt: now,
      ...(o.leadArchived ? { archivedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", {
      organizationId: s.organizationId,
      leadId,
      channel: "whatsapp",
      channelConfigId: o.configId ?? s.configA,
      status: "active",
      messageCount: 1,
      lastMessageAt: o.lastMessageAt,
      ...(o.relation ? { contactRelation: o.relation } : {}),
      ...(o.archived ? { archivedAt: now } : {}),
      createdAt: now,
      updatedAt: now,
    });
    return { contactId, leadId, conversationId };
  });
}

async function addGroup(t: TestConvex<typeof schema>, s: Seed, lastMessageAt: number) {
  return await t.run(async (ctx) =>
    ctx.db.insert("conversations", {
      organizationId: s.organizationId,
      channel: "whatsapp",
      channelConfigId: s.configA,
      kind: "group",
      groupSubject: "Grupo",
      status: "active",
      messageCount: 1,
      lastMessageAt,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function listNames(
  t: TestConvex<typeof schema>,
  s: Seed,
  args: Record<string, unknown>,
): Promise<string[]> {
  const rows = (await as(t, s.adminUserId).query(api.conversations.getConversations, {
    organizationId: s.organizationId,
    ...args,
  })) as Array<{ contact: { firstName?: string } | null; kind: string; groupSubject?: string }>;
  return rows.map((r) => (r.kind === "group" ? `#${r.groupSubject}` : r.contact?.firstName ?? "?"));
}

describe("lib/contactRelationFilter", () => {
  test("valores por filtro e casamento em memória", () => {
    expect(relationValuesForFilter("leads")).toEqual([undefined, "customer"]);
    expect(relationValuesForFilter("none")).toEqual([undefined]);
    expect(relationValuesForFilter("personal")).toEqual(["personal", "team", "supplier", "partner", "automated"]);
    expect(relationValuesForFilter("team")).toEqual(["team"]);
    expect(CONTACT_RELATION_FILTERS).toHaveLength(8);
    expect(matchesContactRelationFilter(undefined, "leads")).toBe(true);
    expect(matchesContactRelationFilter("customer", "leads")).toBe(true);
    expect(matchesContactRelationFilter("team", "leads")).toBe(false);
    expect(matchesContactRelationFilter("automated", "personal")).toBe(true);
    expect(matchesContactRelationFilter("customer", "personal")).toBe(false);
    expect(matchesContactRelationFilter(null, "none")).toBe(true);
  });
});

describe("getConversations({relation})", () => {
  test("cada valor do filtro; Todas continua mostrando tudo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const base = 1_000_000;
    await addPerson(t, s, { name: "SemTipo1", lastMessageAt: base + 10 });
    await addPerson(t, s, { name: "SemTipo2", lastMessageAt: base + 9 });
    await addPerson(t, s, { name: "Cliente", relation: "customer", lastMessageAt: base + 8 });
    await addPerson(t, s, { name: "Mae", relation: "personal", lastMessageAt: base + 7 });
    await addPerson(t, s, { name: "Func", relation: "team", lastMessageAt: base + 6 });
    await addPerson(t, s, { name: "Grafica", relation: "supplier", lastMessageAt: base + 5 });
    await addPerson(t, s, { name: "Socio", relation: "partner", lastMessageAt: base + 4 });
    await addPerson(t, s, { name: "Robo", relation: "automated", lastMessageAt: base + 3 });
    await addPerson(t, s, { name: "IrmaArquivada", relation: "personal", lastMessageAt: base + 2, archived: true });
    await addGroup(t, s, base + 1);

    expect(await listNames(t, s, {})).toEqual([
      "SemTipo1", "SemTipo2", "Cliente", "Mae", "Func", "Grafica", "Socio", "Robo", "#Grupo",
    ]);
    expect(await listNames(t, s, { relation: "leads" })).toEqual(["SemTipo1", "SemTipo2", "Cliente"]);
    expect(await listNames(t, s, { relation: "none" })).toEqual(["SemTipo1", "SemTipo2"]);
    expect(await listNames(t, s, { relation: "customer" })).toEqual(["Cliente"]);
    expect(await listNames(t, s, { relation: "personal" })).toEqual(["Mae", "Func", "Grafica", "Socio", "Robo"]);
    expect(await listNames(t, s, { relation: "team" })).toEqual(["Func"]);
    expect(await listNames(t, s, { relation: "supplier" })).toEqual(["Grafica"]);
    expect(await listNames(t, s, { relation: "partner" })).toEqual(["Socio"]);
    expect(await listNames(t, s, { relation: "automated" })).toEqual(["Robo"]);
    expect(await listNames(t, s, { relation: "personal", archived: true })).toEqual(["IrmaArquivada"]);
    expect(await listNames(t, s, { relation: "leads", archived: true })).toEqual([]);

    // A linha traz o tipo para o selo.
    const rows = (await as(t, s.adminUserId).query(api.conversations.getConversations, {
      organizationId: s.organizationId,
      relation: "personal",
    })) as Array<{ contactRelation?: string }>;
    expect(rows.map((r) => r.contactRelation)).toEqual(["personal", "team", "supplier", "partner", "automated"]);
  });

  test("limite exato através dos ranges mesclados (Carregar mais)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const base = 2_000_000;
    // Sem tipo e cliente intercalados no tempo: 0,2,4… sem tipo; 1,3,5… cliente.
    for (let i = 0; i < 12; i++) {
      await addPerson(t, s, {
        name: `L${String(i).padStart(2, "0")}`,
        relation: i % 2 === 1 ? "customer" : undefined,
        lastMessageAt: base + i,
      });
    }
    const types: ContactRelation[] = ["personal", "team", "supplier", "partner", "automated"];
    for (let i = 0; i < 10; i++) {
      await addPerson(t, s, { name: `P${i}`, relation: types[i % 5], lastMessageAt: base - 100 + i });
    }
    const leadsDesc = Array.from({ length: 12 }, (_, i) => `L${String(11 - i).padStart(2, "0")}`);
    expect(await listNames(t, s, { relation: "leads", limit: 5 })).toEqual(leadsDesc.slice(0, 5));
    expect(await listNames(t, s, { relation: "leads", limit: 10 })).toEqual(leadsDesc.slice(0, 10));
    expect(await listNames(t, s, { relation: "leads", limit: 50 })).toEqual(leadsDesc);
    const personalDesc = Array.from({ length: 10 }, (_, i) => `P${9 - i}`);
    expect(await listNames(t, s, { relation: "personal", limit: 3 })).toEqual(personalDesc.slice(0, 3));
    expect(await listNames(t, s, { relation: "personal", limit: 7 })).toEqual(personalDesc.slice(0, 7));
  });

  test("Pessoais antigos atrás de 210 leads recentes aparecem (índice, não pós-filtro com piso)", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addPerson(t, s, { name: "MaeVelha", relation: "personal", lastMessageAt: 10 });
    await addPerson(t, s, { name: "RoboVelho", relation: "automated", lastMessageAt: 11 });
    await t.run(async (ctx) => {
      for (let i = 0; i < 210; i++) {
        await ctx.db.insert("conversations", {
          organizationId: s.organizationId,
          channel: "whatsapp",
          channelConfigId: s.configA,
          status: "active",
          messageCount: 1,
          lastMessageAt: 1000 + i,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    expect(await listNames(t, s, { relation: "personal" })).toEqual(["RoboVelho", "MaeVelha"]);
    expect(await listNames(t, s, { relation: "personal", channelConfigId: s.configA })).toEqual([
      "RoboVelho",
      "MaeVelha",
    ]);
  });

  test("Leads e Sem tipo com muitos grupos recentes: limite exato e Carregar mais", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    // 6 sem tipo (2 com kind "direct"), 4 clientes, todos ANTES de 260 grupos.
    for (let i = 0; i < 10; i++) {
      const p = await addPerson(t, s, {
        name: `D${i}`,
        relation: i >= 6 ? "customer" : undefined,
        lastMessageAt: 100 + i,
      });
      if (i < 2) await t.run(async (ctx) => ctx.db.patch(p.conversationId, { kind: "direct" }));
    }
    await t.run(async (ctx) => {
      for (let i = 0; i < 260; i++) {
        await ctx.db.insert("conversations", {
          organizationId: s.organizationId,
          channel: "whatsapp",
          channelConfigId: s.configA,
          kind: "group",
          groupSubject: `G${i}`,
          status: "active",
          messageCount: 1,
          lastMessageAt: 10_000 + i,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    const leadsDesc = Array.from({ length: 10 }, (_, i) => `D${9 - i}`);
    // Lote cheio (= há mais) e o seguinte, sem perder linha para os grupos.
    expect(await listNames(t, s, { relation: "leads", limit: 4 })).toEqual(leadsDesc.slice(0, 4));
    expect(await listNames(t, s, { relation: "leads", limit: 8 })).toEqual(leadsDesc.slice(0, 8));
    expect(await listNames(t, s, { relation: "leads", limit: 10 })).toEqual(leadsDesc);
    expect(await listNames(t, s, { relation: "leads", limit: 50 })).toEqual(leadsDesc);
    const noneDesc = Array.from({ length: 6 }, (_, i) => `D${5 - i}`);
    expect(await listNames(t, s, { relation: "none", limit: 3 })).toEqual(noneDesc.slice(0, 3));
    expect(await listNames(t, s, { relation: "none", limit: 6 })).toEqual(noneDesc);
    expect(await listNames(t, s, { relation: "none" })).toEqual(noneDesc);
  });

  test("combinações: conta, não lidas e Minhas com tipo", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const base = 3_000_000;
    await addPerson(t, s, { name: "MaeA", relation: "personal", lastMessageAt: base + 5, configId: s.configA });
    await addPerson(t, s, { name: "MaeB", relation: "personal", lastMessageAt: base + 4, configId: s.configB });
    await addPerson(t, s, { name: "LeadA", lastMessageAt: base + 3, configId: s.configA });
    await addPerson(t, s, { name: "LeadB", relation: "customer", lastMessageAt: base + 2, configId: s.configB });
    const unread = await addPerson(t, s, { name: "LeadUnread", lastMessageAt: base + 1, configId: s.configA });
    await t.run(async (ctx) => ctx.db.patch(unread.conversationId, { unreadCount: 2 }));

    expect(await listNames(t, s, { relation: "personal", channelConfigId: s.configB })).toEqual(["MaeB"]);
    expect(await listNames(t, s, { relation: "leads", channelConfigId: s.configA })).toEqual(["LeadA", "LeadUnread"]);
    expect(await listNames(t, s, { relation: "leads", unreadOnly: true })).toEqual(["LeadUnread"]);
    expect(await listNames(t, s, { relation: "personal", unreadOnly: true })).toEqual([]);
  });
});

describe("contacts.getContacts({relation})", () => {
  test("mesma semântica, pelo índice da org", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addPerson(t, s, { name: "A", lastMessageAt: 1 });
    await addPerson(t, s, { name: "B", relation: "customer", lastMessageAt: 2 });
    await addPerson(t, s, { name: "C", relation: "personal", lastMessageAt: 3 });
    await addPerson(t, s, { name: "D", relation: "supplier", lastMessageAt: 4 });
    const names = async (relation?: string) =>
      ((await as(t, s.viewerUserId).query(api.contacts.getContacts, {
        organizationId: s.organizationId,
        ...(relation ? { relation: relation as never } : {}),
      })) as Doc<"contacts">[]).map((c) => c.firstName);
    expect(await names()).toEqual(["A", "B", "C", "D"]);
    expect(await names("leads")).toEqual(["A", "B"]);
    expect(await names("personal")).toEqual(["C", "D"]);
    expect(await names("supplier")).toEqual(["D"]);
    expect(await names("none")).toEqual(["A"]);
  });
});

describe("contacts.bulkSetContactRelation", () => {
  test("marca em massa pela porta, devolve archivedLeadIds e o Desfazer restaura só eles", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const a = await addPerson(t, s, { name: "A", lastMessageAt: 1 });
    const b = await addPerson(t, s, { name: "B", lastMessageAt: 2 });
    const c = await addPerson(t, s, { name: "C", relation: "team", lastMessageAt: 3 });
    // Lead perdido arquivado à mão antes: não volta no Desfazer.
    const d = await addPerson(t, s, { name: "D", lastMessageAt: 4, leadArchived: true });

    const res = await as(t, s.adminUserId).mutation(api.contacts.bulkSetContactRelation, {
      organizationId: s.organizationId,
      contactIds: [a.contactId, b.contactId, c.contactId, d.contactId, a.contactId],
      relation: "team",
    });
    expect(res).toMatchObject({ relation: "team", changed: 3, unchanged: 1, notFound: 0, archivedLeads: 2 });
    expect(new Set(res.archivedLeadIds)).toEqual(new Set([a.leadId, b.leadId]));
    expect(res.items.find((i) => i.contactId === c.contactId)?.status).toBe("unchanged");
    expect(res.items.find((i) => i.contactId === a.contactId)?.previous).toBeNull();

    const after = await t.run(async (ctx) => ({
      convA: await ctx.db.get(a.conversationId),
      leadA: await ctx.db.get(a.leadId),
      contactB: await ctx.db.get(b.contactId),
      audits: await ctx.db
        .query("auditLogs")
        .withIndex("by_organization_and_created", (q) => q.eq("organizationId", s.organizationId))
        .collect(),
    }));
    expect(after.convA?.contactRelation).toBe("team");
    expect(after.leadA?.archivedAt).toBeDefined();
    expect(after.contactB?.relation).toBe("team");
    expect(after.contactB?.relationMeta?.source).toBe("manual");
    expect(after.audits.filter((x) => x.entityType === "contact")).toHaveLength(3);

    // Desfazer: volta a sem tipo, restaurando só os leads arquivados pela marcação.
    const undo = await as(t, s.adminUserId).mutation(api.contacts.bulkSetContactRelation, {
      organizationId: s.organizationId,
      contactIds: [a.contactId, b.contactId, d.contactId],
      relation: null,
      restoreLeadIds: res.archivedLeadIds,
    });
    expect(undo.changed).toBe(3);
    expect(new Set(undo.restoredLeadIds)).toEqual(new Set([a.leadId, b.leadId]));
    const final = await t.run(async (ctx) => ({
      leadA: await ctx.db.get(a.leadId),
      leadD: await ctx.db.get(d.leadId),
      convB: await ctx.db.get(b.conversationId),
    }));
    expect(final.leadA?.archivedAt).toBeUndefined();
    expect(final.leadD?.archivedAt).toBeDefined();
    expect(final.convB?.contactRelation).toBeUndefined();
  });

  test("ações pendentes lidas uma vez por chamada: cada conversa marcada tem a sua cancelada", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const a = await addPerson(t, s, { name: "A", lastMessageAt: 1 });
    const b = await addPerson(t, s, { name: "B", lastMessageAt: 2 });
    const keep = await addPerson(t, s, { name: "Fica", lastMessageAt: 3 });
    const ids = await t.run(async (ctx) => {
      const base = {
        organizationId: s.organizationId,
        requestedBy: s.adminId,
        preview: "Instruir",
        status: "pending" as const,
        expiresAt: Date.now() + 60_000,
        createdAt: Date.now(),
        tool: "instructAttendant",
      };
      return await Promise.all(
        [a, b, keep].map((p) =>
          ctx.db.insert("pendingActions", { ...base, args: { conversationId: p.conversationId, instruction: "x" } }),
        ),
      );
    });
    await as(t, s.adminUserId).mutation(api.contacts.bulkSetContactRelation, {
      organizationId: s.organizationId,
      contactIds: [a.contactId, b.contactId],
      relation: "personal",
    });
    const statuses = await t.run(async (ctx) => Promise.all(ids.map(async (id) => (await ctx.db.get(id))?.status)));
    expect(statuses).toEqual(["canceled", "canceled", "pending"]);
  });

  test("RBAC: IA e quem não tem contacts:edit são recusados; teto de 50; contato de outra org = not_found", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const a = await addPerson(t, s, { name: "A", lastMessageAt: 1 });
    const args = { organizationId: s.organizationId, contactIds: [a.contactId], relation: "personal" as const };
    await expect(as(t, s.aiUserId).mutation(api.contacts.bulkSetContactRelation, args)).rejects.toThrow(
      AI_ACTOR_RELATION_ERROR,
    );
    await expect(as(t, s.viewerUserId).mutation(api.contacts.bulkSetContactRelation, args)).rejects.toThrow();
    expect((await t.run(async (ctx) => ctx.db.get(a.contactId)))?.relation).toBeUndefined();

    const many = Array.from({ length: 51 }, () => a.contactId);
    // Duplicados contam uma vez: 51 cópias do mesmo id passam.
    await as(t, s.adminUserId).mutation(api.contacts.bulkSetContactRelation, { ...args, contactIds: many });
    const ids = await t.run(async (ctx) => {
      const out: Id<"contacts">[] = [];
      for (let i = 0; i < 51; i++) {
        out.push(
          await ctx.db.insert("contacts", {
            organizationId: s.organizationId,
            tags: [],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }),
        );
      }
      return out;
    });
    await expect(
      as(t, s.adminUserId).mutation(api.contacts.bulkSetContactRelation, { ...args, contactIds: ids }),
    ).rejects.toThrow("No máximo 50");

    const other = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", {
        name: "Outra",
        slug: "outra",
        settings: { timezone: "America/Sao_Paulo", currency: "BRL" },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return ctx.db.insert("contacts", { organizationId: orgId, tags: [], createdAt: Date.now(), updatedAt: Date.now() });
    });
    const res = await as(t, s.adminUserId).mutation(api.contacts.bulkSetContactRelation, {
      ...args,
      contactIds: [other],
    });
    expect(res).toMatchObject({ changed: 0, notFound: 1 });
    expect((await t.run(async (ctx) => ctx.db.get(other)))?.relation).toBeUndefined();
  });
});

describe("campanhas: motivo non_customer", () => {
  test("membros de grupo: telefone ou contato fora do comercial sai com non_customer", () => {
    const gid = "g1" as Id<"groupChats">;
    const r = buildGroupMembersAudience({
      groups: [
        {
          groupChatId: gid,
          subject: "Sala",
          jid: "1@g.us",
          monitored: true,
          selfKey: "self@lid",
          participants: [
            { lid: "a@lid", phone: "5511988880001", isAdmin: false, isSuperAdmin: false },
            { lid: "b@lid", phone: "5511988880002", isAdmin: false, isSuperAdmin: false },
            {
              lid: "c@lid",
              phone: "5511988880003",
              isAdmin: false,
              isSuperAdmin: false,
              contactId: "c1" as Id<"contacts">,
            },
          ],
        },
      ],
      nonCustomerPhones: new Set(["5511988880002"]),
      nonCustomerContactIds: new Set(["c1"]),
      memberList: {},
    });
    expect(r.excluded.non_customer).toBe(2);
    expect(r.recipients.map((x) => x.phone)).toEqual(["5511988880001"]);
    expect(r.members.find((m) => m.key === "b@lid")?.excludedReason).toBe("non_customer");
  });

  test("segmento e CSV: contato fora do comercial fica de fora da contagem", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    await addPerson(t, s, { name: "Lead", lastMessageAt: 1, phone: "5511988887001" });
    // Lead aberto criado à mão para um contato Pessoal (o 9º dígito casa as duas formas).
    await addPerson(t, s, { name: "Mae", relation: "personal", lastMessageAt: 2, phone: "551188887002" });
    const seg = await t.run(async (ctx) =>
      resolveSegmentAudience(ctx, { organizationId: s.organizationId, filters: {}, now: Date.now() }),
    );
    expect(seg.excluded.non_customer).toBe(1);
    expect(seg.candidates).toHaveLength(1);

    const phones = await t.query(internal.campaigns.internalNonCustomerPhones, {
      organizationId: s.organizationId,
    });
    expect(phones).toContain("5511988887002");
    expect(phones).not.toContain("5511988887001");
  });
});

describe("Central: não-cliente não conta", () => {
  test("conversa espelhada e lead de contato fora do comercial saem dos totais", () => {
    const now = new Date("2026-09-23T15:00:00Z").getTime();
    const doc = <T>(x: Record<string, unknown>) => x as unknown as T;
    const leadOk = doc<Doc<"leads">>({ _id: "l1", contactId: "c1", stageId: "s1", createdAt: now, value: 0, tags: [] });
    const leadMae = doc<Doc<"leads">>({ _id: "l2", contactId: "c2", stageId: "s1", createdAt: now, value: 0, tags: [], archivedAt: now });
    const conv = (id: string, leadId: string, relation?: ContactRelation) =>
      doc<Doc<"conversations">>({ _id: id, leadId, createdAt: now, ...(relation ? { contactRelation: relation } : {}) });
    const d = computeCentralDashboard({
      from: "2026-09-22",
      to: "2026-09-24",
      timezone: "America/Sao_Paulo",
      conversations: [conv("v1", "l1"), conv("v2", "l2", "personal")],
      leadsCreated: [leadOk, leadMae],
      leadsClosed: [],
      leadsById: new Map([["l1", leadOk], ["l2", leadMae]]),
      conversationsById: new Map(),
      transfers: [],
      handoffs: [],
      adSpend: [],
      units: [],
      departments: [],
      departmentOpen: new Map(),
      boards: [],
      stages: [],
      membersById: new Map(),
      openNow: 0,
      truncated: false,
      nonCustomerContactIds: new Set(["c2"]),
    });
    expect(d.totals.conversations).toBe(1);
    expect(d.totals.leads).toBe(1);
  });
});

describe("ops: internalBackfillContactRelationMirror", () => {
  test("dryRun padrão só conta; real conserta e é idempotente", async () => {
    const t = convexTest(schema, modules);
    const s = await seed(t);
    const ok = await addPerson(t, s, { name: "Ok", relation: "team", lastMessageAt: 1 });
    const stale = await addPerson(t, s, { name: "Velho", lastMessageAt: 2 });
    const orphan = await addPerson(t, s, { name: "Limpo", lastMessageAt: 3 });
    await t.run(async (ctx) => {
      // Contato marcado sem o espelho; espelho sobrando num contato sem tipo.
      await ctx.db.patch(stale.contactId, { relation: "personal" });
      await ctx.db.patch(orphan.conversationId, { contactRelation: "supplier" });
    });

    const dry = await t.mutation(internal.opsContactRelation.internalBackfillContactRelationMirror, {
      organizationId: s.organizationId,
    });
    expect(dry).toMatchObject({ dryRun: true, scanned: 3, mismatched: 2, written: 0, isDone: true });
    expect(new Set(dry.sample.map((x) => x.conversationId))).toEqual(
      new Set([stale.conversationId, orphan.conversationId]),
    );
    expect((await t.run(async (ctx) => ctx.db.get(stale.conversationId)))?.contactRelation).toBeUndefined();

    const real = await t.mutation(internal.opsContactRelation.internalBackfillContactRelationMirror, {
      organizationId: s.organizationId,
      dryRun: false,
      pageSize: 2,
    });
    expect(real.dryRun).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await t.run(async (ctx) => ({
      ok: await ctx.db.get(ok.conversationId),
      stale: await ctx.db.get(stale.conversationId),
      orphan: await ctx.db.get(orphan.conversationId),
    }));
    expect(after.ok?.contactRelation).toBe("team");
    expect(after.stale?.contactRelation).toBe("personal");
    expect(after.orphan?.contactRelation).toBeUndefined();

    const again = await t.mutation(internal.opsContactRelation.internalBackfillContactRelationMirror, {
      organizationId: s.organizationId,
    });
    expect(again.mismatched).toBe(0);
  });
});
