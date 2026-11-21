/// <reference types="vite/client" />
/**
 * Agenda (`calendarEvents`): isolamento entre orgs (escrita e leitura),
 * permissões por papel, validações, transições de status, recorrência
 * (idempotência, fim de mês, fuso, REST = app), sobreposição no `getEvents`,
 * truncamento e paginação do REST.
 */
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import schema from "./schema";
import { EVENTS_SCAN_CAP, EVENTS_APP_LIMIT, DAY_MS, longStartFor } from "./lib/calendarRules";
import { DELETE_DESCENDANTS_CAP } from "./lib/calendarCore";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  t = convexTest(schema, modules);
});

afterEach(() => {
  vi.useRealTimers();
});

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-06-10T15:00:00Z");

async function seed(t: TestConvex<typeof schema>) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const mkOrg = async (name: string, slug: string, timezone = "America/Sao_Paulo") =>
      await ctx.db.insert("organizations", {
        name, slug, settings: { timezone, currency: "BRL" }, createdAt: now, updatedAt: now,
      });
    const orgA = await mkOrg("Org A", "org-a");
    const orgB = await mkOrg("Org B", "org-b");

    const mk = async (organizationId: Id<"organizations">, name: string, role: "admin" | "manager" | "agent" | "ai", permissions?: any) => {
      const userId = await ctx.db.insert("users", {});
      const memberId = await ctx.db.insert("teamMembers", {
        organizationId, userId, name, role, type: role === "ai" ? "ai" : "human", status: "active",
        ...(permissions ? { permissions } : {}),
        createdAt: now, updatedAt: now,
      });
      return { userId, memberId };
    };
    const adminA = await mk(orgA, "Admin A", "admin");
    const agentA = await mk(orgA, "Agente A", "agent");
    const agent2A = await mk(orgA, "Agente A2", "agent");
    const viewerA = await mk(orgA, "Leitor A", "agent", {
      leads: "view_own", contacts: "view", inbox: "view_own", tasks: "view_own", reports: "none",
      team: "none", settings: "none", auditLogs: "none", apiKeys: "none",
    });
    const noneA = await mk(orgA, "Sem acesso A", "agent", {
      leads: "none", contacts: "none", inbox: "none", tasks: "none", reports: "none",
      team: "none", settings: "none", auditLogs: "none", apiKeys: "none",
    });
    const adminB = await mk(orgB, "Admin B", "admin");

    const board = async (organizationId: Id<"organizations">) => {
      const boardId = await ctx.db.insert("boards", {
        organizationId, name: "Funil", color: "#3b82f6", isDefault: true, order: 0, createdAt: now, updatedAt: now,
      });
      const stageId = await ctx.db.insert("stages", {
        organizationId, boardId, name: "Novo", color: "#6366f1", order: 0,
        isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now,
      });
      return { boardId, stageId };
    };
    const lead = async (organizationId: Id<"organizations">, title: string) => {
      const { boardId, stageId } = await board(organizationId);
      return await ctx.db.insert("leads", {
        organizationId, title, boardId, stageId, value: 100, currency: "BRL", priority: "high",
        temperature: "hot", tags: [], customFields: { segredo: "x" }, conversationStatus: "active",
        lastActivityAt: now, createdAt: now, updatedAt: now,
      });
    };
    const contact = async (organizationId: Id<"organizations">, firstName: string) =>
      await ctx.db.insert("contacts", {
        organizationId, firstName, email: "x@example.test", tags: [], createdAt: now, updatedAt: now,
      });
    const task = async (organizationId: Id<"organizations">, createdBy: Id<"teamMembers">, assignedTo?: Id<"teamMembers">, dueDate?: number) =>
      await ctx.db.insert("tasks", {
        organizationId, title: "Tarefa", type: "task", status: "pending", priority: "medium",
        createdBy, assignedTo, dueDate, createdAt: now, updatedAt: now,
      } as any);

    const leadA = await lead(orgA, "Lead A");
    const leadB = await lead(orgB, "Lead B");
    const contactA = await contact(orgA, "Ana");
    const contactB = await contact(orgB, "Beto");
    const taskB = await task(orgB, adminB.memberId);
    return { orgA, orgB, adminA, agentA, agent2A, viewerA, noneA, adminB, leadA, leadB, contactA, contactB, taskB };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

const as = (t: TestConvex<typeof schema>, u: { userId: Id<"users"> }): any =>
  t.withIdentity({ subject: `${u.userId}|s1` });

const base = (s: Seed, over: Record<string, any> = {}) => ({
  organizationId: s.orgA,
  title: "Reunião",
  eventType: "meeting" as const,
  startTime: T0,
  endTime: T0 + HOUR,
  ...over,
});

/** `legacy: true` simula evento longo gravado antes do `longStart` (sem o campo). */
async function insertRaw(t: TestConvex<typeof schema>, s: Seed, over: Record<string, any> = {}) {
  const { legacy, ...rest } = over;
  return await t.run(async (ctx) => {
    const now = Date.now();
    const doc: any = {
      organizationId: s.orgA, title: "Evento", eventType: "meeting", startTime: T0, endTime: T0 + HOUR,
      allDay: false, status: "scheduled", createdBy: s.adminA.memberId, createdAt: now, updatedAt: now,
      ...rest,
    };
    const ls = legacy ? undefined : longStartFor(doc.startTime, doc.endTime);
    if (ls !== undefined) doc.longStart = ls;
    return await ctx.db.insert("calendarEvents", doc);
  });
}

const errText = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e: any) {
    return String(e.data ?? e.message).replace(/^"|"$/g, "");
  }
  return null;
};

describe("isolamento entre orgs na ESCRITA", () => {
  test("createEvent recusa lead, contato, tarefa, participante e responsável de outra org", async () => {
    const s = await seed(t);
    const admin = as(t, s.adminA);
    expect(await errText(admin.mutation(api.calendar.createEvent, base(s, { leadId: s.leadB })))).toMatch(/Lead não encontrado/);
    expect(await errText(admin.mutation(api.calendar.createEvent, base(s, { contactId: s.contactB })))).toMatch(/Contato não encontrado/);
    expect(await errText(admin.mutation(api.calendar.createEvent, base(s, { taskId: s.taskB })))).toMatch(/Tarefa não encontrada/);
    expect(await errText(admin.mutation(api.calendar.createEvent, base(s, { attendees: [s.adminB.memberId] })))).toMatch(/Responsável não encontrado/);
    expect(await errText(admin.mutation(api.calendar.createEvent, base(s, { assignedTo: s.adminB.memberId })))).toMatch(/Responsável não encontrado/);
    const count = await t.run(async (ctx) => (await ctx.db.query("calendarEvents").collect()).length);
    expect(count).toBe(0);
  });

  test("participante removido da org também é recusado", async () => {
    const s = await seed(t);
    await t.run(async (ctx) => ctx.db.patch(s.agent2A.memberId, { removedAt: Date.now() }));
    expect(await errText(as(t, s.adminA).mutation(api.calendar.createEvent, base(s, { attendees: [s.agent2A.memberId] })))).toMatch(/removido/);
  });

  test("updateEvent recusa id cruzado novo, mas aceita vínculos da mesma org", async () => {
    const s = await seed(t);
    const admin = as(t, s.adminA);
    const id = await admin.mutation(api.calendar.createEvent, base(s));
    expect(await errText(admin.mutation(api.calendar.updateEvent, { eventId: id, leadId: s.leadB }))).toMatch(/Lead não encontrado/);
    expect(await errText(admin.mutation(api.calendar.updateEvent, { eventId: id, attendees: [s.adminB.memberId] }))).toMatch(/Responsável não encontrado/);
    await admin.mutation(api.calendar.updateEvent, { eventId: id, leadId: s.leadA, contactId: s.contactA, attendees: [s.agentA.memberId, s.agentA.memberId] });
    const ev = await admin.query(api.calendar.getEvent, { eventId: id });
    expect(ev.lead).toEqual({ _id: s.leadA, title: "Lead A" });
    expect(ev.attendees).toEqual([s.agentA.memberId]); // deduplicado
  });

  test("REST: internalCreateEvent aplica as mesmas regras e a key não alcança evento de outra org", async () => {
    const s = await seed(t);
    const rest = { organizationId: s.orgA, teamMemberId: s.adminA.memberId };
    expect(await errText(t.mutation(internal.calendar.internalCreateEvent, { ...base(s), ...rest, leadId: s.leadB }))).toMatch(/Lead não encontrado/);
    expect(await errText(t.mutation(internal.calendar.internalCreateEvent, { ...base(s), ...rest, taskId: s.taskB }))).toMatch(/Tarefa não encontrada/);
    const id = await t.mutation(internal.calendar.internalCreateEvent, { ...base(s), ...rest });
    // key da org B
    const other = { organizationId: s.orgB, teamMemberId: s.adminB.memberId };
    expect(await errText(t.mutation(internal.calendar.internalDeleteEvent, { eventId: id, ...other }))).toMatch(/Evento não encontrado/);
    expect(await errText(t.mutation(internal.calendar.internalCompleteEvent, { eventId: id, ...other }))).toMatch(/Evento não encontrado/);
    // membro de outra org usado como actor da org A
    expect(await errText(t.mutation(internal.calendar.internalCreateEvent, { ...base(s), organizationId: s.orgA, teamMemberId: s.adminB.memberId }))).toMatch(/Membro não encontrado/);
  });
});

describe("isolamento entre orgs na LEITURA", () => {
  test("id cruzado já gravado não vaza dado: lead/contato/responsável viram null e a projeção é mínima", async () => {
    const s = await seed(t);
    const id = await insertRaw(t, s, {
      leadId: s.leadB, contactId: s.contactB, assignedTo: s.adminB.memberId, attendees: [s.adminB.memberId, s.agentA.memberId],
    });
    const admin = as(t, s.adminA);
    const list = await admin.query(api.calendar.getEvents, { organizationId: s.orgA, startDate: T0 - DAY_MS, endDate: T0 + DAY_MS });
    const item = list.find((e: any) => e._id === id);
    expect(item.lead).toBeNull();
    expect(item.contact).toBeNull();
    expect(item.assignee).toBeNull();
    const one = await admin.query(api.calendar.getEvent, { eventId: id });
    expect(one.lead).toBeNull();
    expect(one.contact).toBeNull();
    expect(one.assignee).toBeNull();
    expect(one.attendeesResolved).toEqual([{ _id: s.agentA.memberId, name: "Agente A", type: "human" }]);
    expect(JSON.stringify(one)).not.toContain("Lead B");
    expect(JSON.stringify(one)).not.toContain("Beto");
    expect(JSON.stringify(one)).not.toContain("example.test");
  });

  test("projeção mínima da mesma org: sem campos extras de lead/contato/membro", async () => {
    const s = await seed(t);
    const id = await insertRaw(t, s, { leadId: s.leadA, contactId: s.contactA, assignedTo: s.agentA.memberId });
    const one = await as(t, s.adminA).query(api.calendar.getEvent, { eventId: id });
    expect(one.lead).toEqual({ _id: s.leadA, title: "Lead A" });
    expect(Object.keys(one.contact).sort()).toEqual(["_id", "firstName", "lastName"].filter((k) => k in one.contact).sort());
    expect(one.contact.email).toBeUndefined();
    expect(Object.keys(one.assignee).sort()).toEqual(["_id", "name", "type"]);
    expect(one.creator.name).toBe("Admin A");
  });

  test("getEvent de outra org e de membro inexistente devolve null; por lead/contato de outra org devolve []", async () => {
    const s = await seed(t);
    const id = await insertRaw(t, s);
    const b = as(t, s.adminB);
    expect(await b.query(api.calendar.getEvent, { eventId: id })).toBeNull();
    expect(await b.query(api.calendar.getEventsByLead, { leadId: s.leadA })).toEqual([]);
    expect(await b.query(api.calendar.getEventsByContact, { contactId: s.contactA })).toEqual([]);
  });

  test("evento gravado na org A apontando para lead da org B não aparece em getEventsByLead da B", async () => {
    const s = await seed(t);
    await insertRaw(t, s, { leadId: s.leadB });
    expect(await as(t, s.adminB).query(api.calendar.getEventsByLead, { leadId: s.leadB })).toEqual([]);
  });

  test("tarefa mesclada: lead de outra org vira null", async () => {
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", {
        organizationId: s.orgA, title: "T", type: "task", status: "pending", priority: "low",
        createdBy: s.adminA.memberId, leadId: s.leadB, dueDate: T0, createdAt: 1, updatedAt: 1,
      } as any);
    });
    const list = await as(t, s.adminA).query(api.calendar.getEvents, { organizationId: s.orgA, startDate: T0 - DAY_MS, endDate: T0 + DAY_MS });
    const task = list.find((e: any) => e._source === "task");
    expect(task.lead).toBeNull();
  });
});

describe("permissões por papel (categoria tasks)", () => {
  test("sem tasks (none): queries degradam para vazio/null (o Painel não quebra); mutations lançam", async () => {
    const s = await seed(t);
    const id = await insertRaw(t, s, { leadId: s.leadA, contactId: s.contactA });
    const u = as(t, s.noneA);
    const range = { organizationId: s.orgA, startDate: T0 - DAY_MS, endDate: T0 + DAY_MS };
    expect(await u.query(api.calendar.getEvents, range)).toEqual([]);
    expect(await u.query(api.calendar.getEventsWithMeta, range)).toEqual({ items: [], truncated: false });
    expect(await u.query(api.calendar.getEvent, { eventId: id })).toBeNull();
    expect(await u.query(api.calendar.getEventsByLead, { leadId: s.leadA })).toEqual([]);
    expect(await u.query(api.calendar.getEventsByContact, { contactId: s.contactA })).toEqual([]);
    expect(await errText(u.mutation(api.calendar.createEvent, base(s)))).toMatch(/Permissão insuficiente/);
    expect(await errText(u.mutation(api.calendar.completeEvent, { eventId: id }))).toMatch(/Permissão insuficiente/);
    // quem não é membro da org continua sem acesso (erro de auth, como em main)
    expect(await errText(as(t, s.adminB).query(api.calendar.getEvents, range))).toMatch(/Not authorized/);
  });

  test("por lead/contato: matriz de papéis (admin e agent veem; view_own só os seus; none vazio) e de outra org nunca", async () => {
    const s = await seed(t);
    await insertRaw(t, s, { title: "Do admin", leadId: s.leadA, contactId: s.contactA });
    await insertRaw(t, s, { title: "Do leitor", leadId: s.leadA, contactId: s.contactA, createdBy: s.viewerA.memberId });
    const titles = async (u: any) => [
      (await u.query(api.calendar.getEventsByLead, { leadId: s.leadA })).map((e: any) => e.title).sort(),
      (await u.query(api.calendar.getEventsByContact, { contactId: s.contactA })).map((e: any) => e.title).sort(),
    ];
    expect(await titles(as(t, s.adminA))).toEqual([["Do admin", "Do leitor"], ["Do admin", "Do leitor"]]);
    expect(await titles(as(t, s.agentA))).toEqual([["Do admin", "Do leitor"], ["Do admin", "Do leitor"]]);
    expect(await titles(as(t, s.viewerA))).toEqual([["Do leitor"], ["Do leitor"]]);
    expect(await titles(as(t, s.noneA))).toEqual([[], []]);
    expect(await titles(as(t, s.adminB))).toEqual([[], []]);
  });

  test("canEdit é calculado no servidor para o chamador", async () => {
    const s = await seed(t);
    const mine = await insertRaw(t, s, { title: "Meu", createdBy: s.agentA.memberId });
    await insertRaw(t, s, { title: "Alheio" });
    await t.run(async (ctx) => {
      await ctx.db.insert("tasks", { organizationId: s.orgA, title: "T", type: "task", status: "pending", priority: "low", createdBy: s.adminA.memberId, dueDate: T0, createdAt: 1, updatedAt: 1 } as any);
    });
    const range = { organizationId: s.orgA, startDate: T0 - DAY_MS, endDate: T0 + DAY_MS };
    const agentList = await as(t, s.agentA).query(api.calendar.getEvents, range);
    const by = (list: any[]) => Object.fromEntries(list.map((e) => [e.title, e.canEdit]));
    expect(by(agentList)).toEqual({ Meu: true, Alheio: false, T: false });
    expect(by(await as(t, s.adminA).query(api.calendar.getEvents, range))).toMatchObject({ Meu: true, Alheio: true });
    expect((await as(t, s.agentA).query(api.calendar.getEvent, { eventId: mine })).canEdit).toBe(true);
    expect((await as(t, s.viewerA).query(api.calendar.getEvent, { eventId: await insertRaw(t, s, { createdBy: s.viewerA.memberId }) })).canEdit).toBe(false);
  });

  test("REST: agent não reagenda/conclui/exclui evento de colega; reagenda o seu", async () => {
    const s = await seed(t);
    const rest = { organizationId: s.orgA, teamMemberId: s.agentA.memberId };
    const colleague = await insertRaw(t, s, { createdBy: s.agent2A.memberId });
    expect(await errText(t.mutation(internal.calendar.internalRescheduleEvent, { eventId: colleague, newStartTime: T0 + HOUR, ...rest }))).toMatch(/Permissão insuficiente/);
    expect(await errText(t.mutation(internal.calendar.internalCompleteEvent, { eventId: colleague, ...rest }))).toMatch(/Permissão insuficiente/);
    expect(await errText(t.mutation(internal.calendar.internalCancelEvent, { eventId: colleague, ...rest }))).toMatch(/Permissão insuficiente/);
    expect(await errText(t.mutation(internal.calendar.internalDeleteEvent, { eventId: colleague, ...rest }))).toMatch(/Permissão insuficiente/);
    expect(await errText(t.mutation(internal.calendar.internalUpdateEvent, { eventId: colleague, title: "x", ...rest }))).toMatch(/Permissão insuficiente/);
    const mine = await insertRaw(t, s, { createdBy: s.agentA.memberId });
    await t.mutation(internal.calendar.internalRescheduleEvent, { eventId: mine, newStartTime: T0 + HOUR, ...rest });
  });

  test("evento inexistente e de outra org respondem igual nos caminhos por id do app", async () => {
    const s = await seed(t);
    const foreign = await insertRaw(t, s);
    const gone = await insertRaw(t, s);
    await t.run(async (ctx) => ctx.db.delete(gone));
    const b = as(t, s.adminB);
    for (const call of [
      (id: any) => b.mutation(api.calendar.completeEvent, { eventId: id }),
      (id: any) => b.mutation(api.calendar.cancelEvent, { eventId: id }),
      (id: any) => b.mutation(api.calendar.deleteEvent, { eventId: id }),
      (id: any) => b.mutation(api.calendar.updateEvent, { eventId: id, title: "x" }),
      (id: any) => b.mutation(api.calendar.rescheduleEvent, { eventId: id, newStartTime: T0 }),
    ]) {
      expect(await errText(call(foreign))).toBe("Evento não encontrado");
      expect(await errText(call(gone))).toBe("Evento não encontrado");
    }
  });

  test("view_own: vê só os próprios, não cria, não edita", async () => {
    const s = await seed(t);
    const mine = await insertRaw(t, s, { createdBy: s.viewerA.memberId, title: "Meu" });
    const asAssignee = await insertRaw(t, s, { assignedTo: s.viewerA.memberId, title: "Atribuído" });
    const asAttendee = await insertRaw(t, s, { attendees: [s.viewerA.memberId], title: "Convidado" });
    const others = await insertRaw(t, s, { title: "De outro" });
    const u = as(t, s.viewerA);
    const list = await u.query(api.calendar.getEvents, { organizationId: s.orgA, startDate: T0 - DAY_MS, endDate: T0 + DAY_MS });
    expect(list.map((e: any) => e.title).sort()).toEqual(["Atribuído", "Convidado", "Meu"]);
    expect(await u.query(api.calendar.getEvent, { eventId: others })).toBeNull();
    expect((await u.query(api.calendar.getEvent, { eventId: mine }))._id).toBe(mine);
    expect(asAssignee && asAttendee).toBeTruthy();
    expect(await errText(u.mutation(api.calendar.createEvent, base(s)))).toMatch(/Permissão insuficiente/);
    expect(await errText(u.mutation(api.calendar.updateEvent, { eventId: mine, title: "x" }))).toMatch(/Permissão insuficiente/);
    expect(await errText(u.mutation(api.calendar.deleteEvent, { eventId: mine }))).toMatch(/Permissão insuficiente/);
  });

  test("agent (edit_own): cria e edita/conclui/cancela/exclui os seus; não mexe nos de outros", async () => {
    const s = await seed(t);
    const agent = as(t, s.agentA);
    const mine = await agent.mutation(api.calendar.createEvent, base(s));
    await agent.mutation(api.calendar.updateEvent, { eventId: mine, title: "Novo título" });
    await agent.mutation(api.calendar.rescheduleEvent, { eventId: mine, newStartTime: T0 + HOUR });
    await agent.mutation(api.calendar.completeEvent, { eventId: mine });

    const theirs = await insertRaw(t, s); // criado pelo admin
    for (const call of [
      () => agent.mutation(api.calendar.updateEvent, { eventId: theirs, title: "x" }),
      () => agent.mutation(api.calendar.rescheduleEvent, { eventId: theirs, newStartTime: T0 + HOUR }),
      () => agent.mutation(api.calendar.completeEvent, { eventId: theirs }),
      () => agent.mutation(api.calendar.cancelEvent, { eventId: theirs }),
      () => agent.mutation(api.calendar.deleteEvent, { eventId: theirs }),
    ]) {
      expect(await errText(call())).toMatch(/Permissão insuficiente/);
    }
    // responsável pelo evento passa a poder editar
    await t.run(async (ctx) => ctx.db.patch(theirs, { assignedTo: s.agentA.memberId }));
    await agent.mutation(api.calendar.cancelEvent, { eventId: theirs });
    // agent vê todos (default edit_own ≥ view_all)
    const list = await agent.query(api.calendar.getEvents, { organizationId: s.orgA, startDate: T0 - DAY_MS, endDate: T0 + 2 * DAY_MS });
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  test("admin edita e exclui eventos de qualquer membro", async () => {
    const s = await seed(t);
    const id = await insertRaw(t, s, { createdBy: s.agentA.memberId });
    const admin = as(t, s.adminA);
    await admin.mutation(api.calendar.updateEvent, { eventId: id, title: "Admin mexeu" });
    await admin.mutation(api.calendar.deleteEvent, { eventId: id });
    expect(await t.run(async (ctx) => ctx.db.get(id))).toBeNull();
  });

  test("REST: permissões da chave (view_own) negam escrita e escondem eventos alheios", async () => {
    const s = await seed(t);
    const keyPerms = { leads: "none", contacts: "none", inbox: "none", tasks: "view_own", reports: "none", team: "none", settings: "none", auditLogs: "none", apiKeys: "none" } as const;
    const rest = { organizationId: s.orgA, teamMemberId: s.adminA.memberId, permissions: keyPerms };
    expect(await errText(t.mutation(internal.calendar.internalCreateEvent, { ...base(s), ...rest }))).toMatch(/Permissão insuficiente/);
    await insertRaw(t, s, { createdBy: s.agentA.memberId });
    const res = await t.query(internal.calendar.internalGetEvents, { ...rest, startDate: T0 - DAY_MS, endDate: T0 + DAY_MS });
    expect(res.events).toEqual([]);
  });

  test("REST: membro removido não age", async () => {
    const s = await seed(t);
    await t.run(async (ctx) => ctx.db.patch(s.adminA.memberId, { removedAt: Date.now() }));
    expect(await errText(t.mutation(internal.calendar.internalCreateEvent, { ...base(s), organizationId: s.orgA, teamMemberId: s.adminA.memberId }))).toMatch(/Membro não encontrado/);
  });
});

describe("validações e transições", () => {
  test("término antes do início, título vazio, duração acima do teto e NaN", async () => {
    const s = await seed(t);
    const admin = as(t, s.adminA);
    expect(await errText(admin.mutation(api.calendar.createEvent, base(s, { endTime: T0 - 1 })))).toMatch(/anterior ao início/);
    expect(await errText(admin.mutation(api.calendar.createEvent, base(s, { title: "   " })))).toMatch(/título/i);
    expect(await errText(admin.mutation(api.calendar.createEvent, base(s, { endTime: T0 + 32 * DAY_MS })))).toMatch(/31 dias/);
    expect(await errText(admin.mutation(api.calendar.createEvent, base(s, { startTime: NaN })))).toMatch(/inválido/);
    const id = await admin.mutation(api.calendar.createEvent, base(s));
    expect(await errText(admin.mutation(api.calendar.updateEvent, { eventId: id, endTime: T0 - HOUR }))).toMatch(/anterior ao início/);
    expect(await errText(admin.mutation(api.calendar.updateEvent, { eventId: id, title: " " }))).toMatch(/título/i);
    expect(await errText(admin.mutation(api.calendar.rescheduleEvent, { eventId: id, newStartTime: T0, newEndTime: T0 - 5 }))).toMatch(/anterior ao início/);
  });

  test("título é aparado ao gravar", async () => {
    const s = await seed(t);
    const admin = as(t, s.adminA);
    const id = await admin.mutation(api.calendar.createEvent, base(s, { title: "  Com espaço  " }));
    expect((await admin.query(api.calendar.getEvent, { eventId: id })).title).toBe("Com espaço");
  });

  test("não conclui nem cancela duas vezes; concluído não cancela; cancelado não reagenda", async () => {
    const s = await seed(t);
    const admin = as(t, s.adminA);
    const a = await admin.mutation(api.calendar.createEvent, base(s));
    await admin.mutation(api.calendar.completeEvent, { eventId: a });
    expect(await errText(admin.mutation(api.calendar.completeEvent, { eventId: a }))).toMatch(/já está concluído/);
    expect(await errText(admin.mutation(api.calendar.cancelEvent, { eventId: a }))).toMatch(/não pode ser cancelado/);
    expect(await errText(admin.mutation(api.calendar.rescheduleEvent, { eventId: a, newStartTime: T0 + HOUR }))).toMatch(/reagendado/);
    const b = await admin.mutation(api.calendar.createEvent, base(s));
    await admin.mutation(api.calendar.cancelEvent, { eventId: b });
    expect(await errText(admin.mutation(api.calendar.cancelEvent, { eventId: b }))).toMatch(/já está cancelado/);
    expect(await errText(admin.mutation(api.calendar.completeEvent, { eventId: b }))).toMatch(/não pode ser concluído/);
  });

  test("evento inexistente: ConvexError em PT-BR", async () => {
    const s = await seed(t);
    const id = await insertRaw(t, s);
    await t.run(async (ctx) => ctx.db.delete(id));
    expect(await errText(as(t, s.adminA).mutation(api.calendar.completeEvent, { eventId: id }))).toBe("Evento não encontrado");
  });

  test("recorrência não aceita lastGeneratedAt do cliente nem fim antes do início", async () => {
    const s = await seed(t);
    const admin = as(t, s.adminA);
    expect(await errText(admin.mutation(api.calendar.createEvent, base(s, { recurrence: { pattern: "daily", endDate: T0 - 1 } })))).toMatch(/recorrência/);
    const id = await admin.mutation(api.calendar.createEvent, base(s, { recurrence: { pattern: "daily", lastGeneratedAt: 123 } }));
    const doc = await t.run(async (ctx) => ctx.db.get(id as Id<"calendarEvents">));
    expect(doc?.recurrence?.lastGeneratedAt).toBeUndefined();
  });
});

describe("efeitos: app = REST", () => {
  test("create/complete/cancel/delete gravam audit + activity + webhook nos dois caminhos", async () => {
    const s = await seed(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("webhooks", {
        organizationId: s.orgA, name: "w", url: "https://example.test/h", events: ["*"], secret: "fake-secret", isActive: true, createdAt: 1,
      });
    });
    const rest = { organizationId: s.orgA, teamMemberId: s.adminA.memberId };
    const run = async (mode: "app" | "rest") => {
      const input = base(s, { leadId: s.leadA });
      const id: Id<"calendarEvents"> = mode === "app"
        ? await as(t, s.adminA).mutation(api.calendar.createEvent, input)
        : await t.mutation(internal.calendar.internalCreateEvent, { ...input, ...rest });
      if (mode === "app") await as(t, s.adminA).mutation(api.calendar.completeEvent, { eventId: id });
      else await t.mutation(internal.calendar.internalCompleteEvent, { eventId: id, ...rest });
      const id2: Id<"calendarEvents"> = mode === "app"
        ? await as(t, s.adminA).mutation(api.calendar.createEvent, input)
        : await t.mutation(internal.calendar.internalCreateEvent, { ...input, ...rest });
      if (mode === "app") await as(t, s.adminA).mutation(api.calendar.cancelEvent, { eventId: id2 });
      else await t.mutation(internal.calendar.internalCancelEvent, { eventId: id2, ...rest });
      if (mode === "app") await as(t, s.adminA).mutation(api.calendar.deleteEvent, { eventId: id2 });
      else await t.mutation(internal.calendar.internalDeleteEvent, { eventId: id2, ...rest });
    };
    const snapshot = async () =>
      await t.run(async (ctx) => {
        const audits = (await ctx.db.query("auditLogs").collect()).filter((a) => a.entityType === "calendarEvent");
        const acts = await ctx.db.query("activities").collect();
        const jobs = await ctx.db.system.query("_scheduled_functions").collect();
        return {
          audits: audits.map((a) => `${a.action}:${a.severity}`).sort(),
          acts: acts.map((a) => `${a.type}:${(a.content ?? "").replace(/".*"/, "T")}`).sort(),
          jobs: jobs.length,
        };
      });
    await run("app");
    const app = await snapshot();
    await t.run(async (ctx) => {
      for (const d of await ctx.db.query("auditLogs").collect()) await ctx.db.delete(d._id);
      for (const d of await ctx.db.query("activities").collect()) await ctx.db.delete(d._id);
    });
    await run("rest");
    const rest2 = await snapshot();
    expect(rest2.audits).toEqual(app.audits);
    expect(rest2.acts).toEqual(app.acts);
    expect(rest2.jobs - app.jobs).toBe(app.jobs); // mesmo número de webhooks agendados em cada caminho
    expect(app.acts).toContain("event_completed:Evento T concluído");
    expect(app.audits).toContain("delete:high");
    // webhooks agendados não podem disparar depois do teste
    await t.run(async (ctx) => {
      for (const j of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (j.state.kind === "pending") await ctx.scheduler.cancel(j._id);
      }
    });
  });
});

describe("recorrência", () => {
  const recurring = (s: Seed, over: Record<string, any> = {}) =>
    base(s, { recurrence: { pattern: "weekly" }, ...over });

  test("concluir gera UMA próxima ocorrência; concluir de novo é recusado e não duplica", async () => {
    const s = await seed(t);
    const admin = as(t, s.adminA);
    const id = await admin.mutation(api.calendar.createEvent, recurring(s));
    await admin.mutation(api.calendar.completeEvent, { eventId: id });
    expect(await errText(admin.mutation(api.calendar.completeEvent, { eventId: id }))).toMatch(/já está concluído/);
    const all = await t.run(async (ctx) => ctx.db.query("calendarEvents").collect());
    expect(all).toHaveLength(2);
    const child = all.find((e) => e.parentEventId === id)!;
    expect(child.startTime).toBe(T0 + 7 * DAY_MS);
    expect(child.endTime - child.startTime).toBe(HOUR);
    expect(child.status).toBe("scheduled");
    expect(child.recurrence?.lastGeneratedAt).toBeUndefined();
    const parent = all.find((e) => e._id === id)!;
    expect(parent.recurrence?.lastGeneratedAt).toBeTypeOf("number");
  });

  test("não gera se já existe filho (idempotência por dado, mesmo sem carimbo)", async () => {
    const s = await seed(t);
    const id = await insertRaw(t, s, { recurrence: { pattern: "daily" } });
    await insertRaw(t, s, { parentEventId: id, startTime: T0 + DAY_MS, endTime: T0 + DAY_MS + HOUR });
    await as(t, s.adminA).mutation(api.calendar.completeEvent, { eventId: id });
    expect(await t.run(async (ctx) => (await ctx.db.query("calendarEvents").collect()).length)).toBe(2);
  });

  test("respeita o fim da recorrência", async () => {
    const s = await seed(t);
    const admin = as(t, s.adminA);
    const id = await admin.mutation(api.calendar.createEvent, recurring(s, { recurrence: { pattern: "weekly", endDate: T0 + 3 * DAY_MS } }));
    await admin.mutation(api.calendar.completeEvent, { eventId: id });
    expect(await t.run(async (ctx) => (await ctx.db.query("calendarEvents").collect()).length)).toBe(1);
  });

  test("mensal em 31/jan cai em 28/fev (não transborda para março), no fuso da org", async () => {
    const s = await seed(t);
    const start = Date.parse("2026-01-31T19:30:00-03:00"); // 22:30Z
    const id = await as(t, s.adminA).mutation(api.calendar.createEvent, base(s, { startTime: start, endTime: start + HOUR, recurrence: { pattern: "monthly" } }));
    await as(t, s.adminA).mutation(api.calendar.completeEvent, { eventId: id });
    const child = await t.run(async (ctx) => (await ctx.db.query("calendarEvents").collect()).find((e) => e.parentEventId === id)!);
    expect(child.startTime).toBe(Date.parse("2026-02-28T19:30:00-03:00"));
  });

  test("usa o fuso da org: org em Nova York mantém a hora de parede através do horário de verão", async () => {
    const s = await seed(t);
    await t.run(async (ctx) => ctx.db.patch(s.orgA, { settings: { timezone: "America/New_York", currency: "USD" } }));
    const start = Date.parse("2026-03-07T09:00:00-05:00");
    const id = await as(t, s.adminA).mutation(api.calendar.createEvent, base(s, { startTime: start, endTime: start + HOUR, recurrence: { pattern: "weekly" } }));
    await as(t, s.adminA).mutation(api.calendar.completeEvent, { eventId: id });
    const child = await t.run(async (ctx) => (await ctx.db.query("calendarEvents").collect()).find((e) => e.parentEventId === id)!);
    expect(child.startTime).toBe(Date.parse("2026-03-14T09:00:00-04:00"));
  });

  test("REST: internalCompleteEvent gera a próxima igual ao app", async () => {
    const s = await seed(t);
    const rest = { organizationId: s.orgA, teamMemberId: s.adminA.memberId };
    const viaApp = await as(t, s.adminA).mutation(api.calendar.createEvent, recurring(s));
    const viaRest = await t.mutation(internal.calendar.internalCreateEvent, { ...recurring(s), ...rest });
    await as(t, s.adminA).mutation(api.calendar.completeEvent, { eventId: viaApp });
    await t.mutation(internal.calendar.internalCompleteEvent, { eventId: viaRest, ...rest });
    expect(await errText(t.mutation(internal.calendar.internalCompleteEvent, { eventId: viaRest, ...rest }))).toMatch(/já está concluído/);
    const all = await t.run(async (ctx) => ctx.db.query("calendarEvents").collect());
    const a = all.find((e) => e.parentEventId === viaApp)!;
    const r = all.find((e) => e.parentEventId === viaRest)!;
    expect(r.startTime).toBe(a.startTime);
    expect(r.endTime).toBe(a.endTime);
    expect(all).toHaveLength(4);
  });

  test("excluir apaga o evento e só os descendentes ainda agendados; concluído/cancelado fica sem pai pendurado", async () => {
    const s = await seed(t);
    const root = await insertRaw(t, s, { recurrence: { pattern: "daily" } });
    const doneChild = await insertRaw(t, s, { parentEventId: root, status: "completed", title: "feito" });
    const schedChild = await insertRaw(t, s, { parentEventId: root, title: "agendado" });
    const grandSched = await insertRaw(t, s, { parentEventId: schedChild, title: "neto agendado" });
    const grandCancelled = await insertRaw(t, s, { parentEventId: schedChild, status: "cancelled", title: "neto cancelado" });
    const behindDone = await insertRaw(t, s, { parentEventId: doneChild, title: "atrás do feito" });
    // filho de OUTRA org apontando para a raiz: nunca é tocado
    const foreign = await t.run(async (ctx) =>
      ctx.db.insert("calendarEvents", {
        organizationId: s.orgB, title: "outra org", eventType: "other", startTime: T0, endTime: T0 + 1, allDay: false,
        status: "scheduled", createdBy: s.adminB.memberId, parentEventId: root, createdAt: 1, updatedAt: 1,
      }),
    );
    await as(t, s.adminA).mutation(api.calendar.deleteEvent, { eventId: root });
    const get = (id: any) => t.run(async (ctx) => ctx.db.get(id)) as Promise<any>;
    expect(await get(root)).toBeNull();
    expect(await get(schedChild)).toBeNull();
    expect(await get(grandSched)).toBeNull();
    expect((await get(doneChild))?.parentEventId).toBeUndefined();
    expect((await get(doneChild))?.title).toBe("feito");
    expect((await get(grandCancelled))?.parentEventId).toBeUndefined();
    expect((await get(behindDone))?.parentEventId).toBe(doneChild); // intocado: o pai existe
    expect((await get(foreign))?.parentEventId).toBe(root);
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLogs").collect()).find((a) => a.action === "delete"));
    expect(audit?.metadata).toMatchObject({ deletedDescendants: 2, preservedDescendants: 2 });
  });

  test("cadeia acima do teto: não apaga nada (nem a raiz) e explica", async () => {
    const s = await seed(t);
    const root = await insertRaw(t, s, { recurrence: { pattern: "daily" } });
    await t.run(async (ctx) => {
      for (let i = 0; i < DELETE_DESCENDANTS_CAP + 1; i++) {
        await ctx.db.insert("calendarEvents", {
          organizationId: s.orgA, title: `c${i}`, eventType: "other", startTime: T0 + i, endTime: T0 + i, allDay: false,
          status: "scheduled", createdBy: s.adminA.memberId, parentEventId: root, createdAt: 1, updatedAt: 1,
        });
      }
    });
    expect(await errText(as(t, s.adminA).mutation(api.calendar.deleteEvent, { eventId: root }))).toMatch(/ocorrências demais/);
    expect(await t.run(async (ctx) => (await ctx.db.query("calendarEvents").collect()).length)).toBe(DELETE_DESCENDANTS_CAP + 2);
  });

  test("mensal ancorado: 31/01 → 28/02 → 31/03 (anchorDay); sem âncora (legado) segue derivando", async () => {
    const s = await seed(t);
    const admin = as(t, s.adminA);
    const start = Date.parse("2026-01-31T10:00:00-03:00");
    const id = await admin.mutation(api.calendar.createEvent, base(s, { startTime: start, endTime: start + HOUR, recurrence: { pattern: "monthly" } }));
    expect(((await t.run(async (ctx) => ctx.db.get(id))) as any).recurrence.anchorDay).toBe(31);
    await admin.mutation(api.calendar.completeEvent, { eventId: id });
    const feb = await t.run(async (ctx) => (await ctx.db.query("calendarEvents").collect()).find((e) => e.parentEventId === id)!);
    expect(feb.startTime).toBe(Date.parse("2026-02-28T10:00:00-03:00"));
    expect(feb.recurrence?.anchorDay).toBe(31);
    await admin.mutation(api.calendar.completeEvent, { eventId: feb._id });
    const mar = await t.run(async (ctx) => (await ctx.db.query("calendarEvents").collect()).find((e) => e.parentEventId === feb._id)!);
    expect(mar.startTime).toBe(Date.parse("2026-03-31T10:00:00-03:00"));
    // legado: sem anchorDay deriva do dia atual (28)
    const legacy = await insertRaw(t, s, { startTime: Date.parse("2026-02-28T10:00:00-03:00"), endTime: Date.parse("2026-02-28T11:00:00-03:00"), recurrence: { pattern: "monthly" } });
    await admin.mutation(api.calendar.completeEvent, { eventId: legacy });
    const next = await t.run(async (ctx) => (await ctx.db.query("calendarEvents").collect()).find((e) => e.parentEventId === legacy)!);
    expect(next.startTime).toBe(Date.parse("2026-03-28T10:00:00-03:00"));
  });
});

describe("getEvents: sobreposição, teto e paginação", () => {
  test("inclui evento que começa antes do intervalo e termina dentro dele; exclui o que termina antes", async () => {
    const s = await seed(t);
    const start = T0;
    await insertRaw(t, s, { title: "Atravessa", startTime: start - 2 * DAY_MS, endTime: start + HOUR });
    await insertRaw(t, s, { title: "Terminou antes", startTime: start - 2 * DAY_MS, endTime: start - DAY_MS });
    await insertRaw(t, s, { title: "Dentro", startTime: start + HOUR, endTime: start + 2 * HOUR });
    await insertRaw(t, s, { title: "Depois", startTime: start + 3 * DAY_MS, endTime: start + 3 * DAY_MS + HOUR });
    const list = await as(t, s.adminA).query(api.calendar.getEvents, { organizationId: s.orgA, startDate: start, endDate: start + DAY_MS, includeTasks: false });
    expect(list.map((e: any) => e.title)).toEqual(["Atravessa", "Dentro"]);
  });

  test("longStart: evento de 3 dias aparece no dia do meio (início > 1 dia antes da janela); legado sem o campo não", async () => {
    const s = await seed(t);
    const D0 = Date.parse("2026-06-01T10:00:00Z");
    await insertRaw(t, s, { title: "Viagem", startTime: D0, endTime: D0 + 3 * DAY_MS });
    await insertRaw(t, s, { title: "Viagem legada", startTime: D0, endTime: D0 + 3 * DAY_MS, legacy: true });
    const mid = { organizationId: s.orgA, startDate: D0 + 2 * DAY_MS - 10 * HOUR, endDate: D0 + 2 * DAY_MS + 8 * HOUR, includeTasks: false };
    const list = await as(t, s.adminA).query(api.calendar.getEvents, mid);
    expect(list.map((e: any) => e.title)).toEqual(["Viagem"]);
    // quem ainda tem o evento legado no dia seguinte ao início o vê (recuo de 1 dia no índice principal)
    const day1 = { organizationId: s.orgA, startDate: D0 + 10 * HOUR, endDate: D0 + 20 * HOUR, includeTasks: false };
    expect((await as(t, s.adminA).query(api.calendar.getEvents, day1)).map((e: any) => e.title).sort()).toEqual(["Viagem", "Viagem legada"]);
  });

  test("longStart é mantido em create, update, reschedule e recorrência", async () => {
    const s = await seed(t);
    const admin = as(t, s.adminA);
    const get = async (id: any) => (await t.run(async (ctx) => ctx.db.get(id))) as any;
    const id = await admin.mutation(api.calendar.createEvent, base(s));
    expect((await get(id)).longStart).toBeUndefined();
    await admin.mutation(api.calendar.updateEvent, { eventId: id, endTime: T0 + 3 * DAY_MS });
    expect((await get(id)).longStart).toBe(T0);
    await admin.mutation(api.calendar.rescheduleEvent, { eventId: id, newStartTime: T0 + DAY_MS });
    expect((await get(id)).longStart).toBe(T0 + DAY_MS);
    await admin.mutation(api.calendar.rescheduleEvent, { eventId: id, newStartTime: T0, newEndTime: T0 + HOUR });
    expect((await get(id)).longStart).toBeUndefined();
    const long = await admin.mutation(api.calendar.createEvent, base(s, { endTime: T0 + 2 * DAY_MS, recurrence: { pattern: "weekly" } }));
    expect((await get(long)).longStart).toBe(T0);
    await admin.mutation(api.calendar.completeEvent, { eventId: long });
    const child = await t.run(async (ctx) => (await ctx.db.query("calendarEvents").collect()).find((e) => e.parentEventId === long)!);
    expect(child.longStart).toBe(child.startTime);
  });

  test("backfill: dryRun (default) só conta; real grava longStart nos longos legados e é idempotente", async () => {
    const s = await seed(t);
    const a = await insertRaw(t, s, { startTime: T0, endTime: T0 + 3 * DAY_MS, legacy: true });
    await insertRaw(t, s, { title: "curto" });
    await insertRaw(t, s, { startTime: T0, endTime: T0 + 2 * DAY_MS }); // já tem
    const dry: any = await t.mutation(internal.opsCalendar.internalBackfillCalendarLongStart, {});
    expect(dry).toMatchObject({ dryRun: true, scanned: 3, wouldWrite: 1, written: 0, isDone: true, scheduledNext: false });
    expect(((await t.run(async (ctx) => ctx.db.get(a))) as any).longStart).toBeUndefined();
    const real: any = await t.mutation(internal.opsCalendar.internalBackfillCalendarLongStart, { dryRun: false });
    expect(real).toMatchObject({ dryRun: false, wouldWrite: 1, written: 1 });
    expect(((await t.run(async (ctx) => ctx.db.get(a))) as any).longStart).toBe(T0);
    const again: any = await t.mutation(internal.opsCalendar.internalBackfillCalendarLongStart, { dryRun: false });
    expect(again).toMatchObject({ wouldWrite: 0, written: 0 });
    expect(JSON.stringify(real)).not.toMatch(/Evento|example/); // só contagens
  });

  test("corte em 1000: getEventsWithMeta devolve 1000 itens com truncated verdadeiro (todos os tipos contam)", async () => {
    const s = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < EVENTS_APP_LIMIT + 5; i++) {
        await ctx.db.insert("calendarEvents", {
          organizationId: s.orgA, title: `E${i}`, eventType: i % 2 ? "call" : "meeting", startTime: T0 + i * 1000, endTime: T0 + i * 1000 + 500,
          allDay: false, status: "scheduled", createdBy: s.adminA.memberId, createdAt: 1, updatedAt: 1,
        });
      }
    });
    const range = { organizationId: s.orgA, startDate: T0 - DAY_MS, endDate: T0 + DAY_MS, includeTasks: false };
    const res = await as(t, s.adminA).query(api.calendar.getEventsWithMeta, range);
    expect(res.items).toHaveLength(EVENTS_APP_LIMIT);
    expect(res.truncated).toBe(true);
    const small = await as(t, s.adminA).query(api.calendar.getEventsWithMeta, { ...range, endDate: T0 + 100 * 1000 });
    expect(small.truncated).toBe(false);
  });

  test("REST por lead com mais de 1500 eventos: sem cursor infinito (hasMore:false, truncated:true)", async () => {
    const s = await seed(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < EVENTS_SCAN_CAP + 10; i++) {
        await ctx.db.insert("calendarEvents", {
          organizationId: s.orgA, title: `L${i}`, eventType: "other", startTime: T0 + i * 1000, endTime: T0 + i * 1000 + 500,
          allDay: false, status: "scheduled", leadId: s.leadA, createdBy: s.adminA.memberId, createdAt: 1, updatedAt: 1,
        });
      }
    });
    const rest = { organizationId: s.orgA, teamMemberId: s.adminA.memberId, startDate: T0 - DAY_MS, endDate: T0 + DAY_MS, leadId: s.leadA };
    const page: any = await t.query(internal.calendar.internalGetEvents, { ...rest, limit: 500 });
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.truncated).toBe(true);
  });

  test("filtros por responsável/tipo/status e por lead (índice)", async () => {
    const s = await seed(t);
    await insertRaw(t, s, { title: "A", assignedTo: s.agentA.memberId, eventType: "call", leadId: s.leadA });
    await insertRaw(t, s, { title: "B", status: "completed", contactId: s.contactA });
    const q = (extra: Record<string, any>) =>
      as(t, s.adminA).query(api.calendar.getEvents, { organizationId: s.orgA, startDate: T0 - DAY_MS, endDate: T0 + DAY_MS, includeTasks: false, ...extra });
    expect((await q({ assignedTo: s.agentA.memberId })).map((e: any) => e.title)).toEqual(["A"]);
    expect((await q({ eventType: "call" })).map((e: any) => e.title)).toEqual(["A"]);
    expect((await q({ status: "completed" })).map((e: any) => e.title)).toEqual(["B"]);
    expect((await q({ leadId: s.leadA })).map((e: any) => e.title)).toEqual(["A"]);
    expect((await q({ contactId: s.contactA })).map((e: any) => e.title)).toEqual(["B"]);
  });

  test("janela inválida ou enorme é recusada", async () => {
    const s = await seed(t);
    const admin = as(t, s.adminA);
    expect(await errText(admin.query(api.calendar.getEvents, { organizationId: s.orgA, startDate: 10, endDate: 5 }))).toMatch(/final/);
    expect(await errText(admin.query(api.calendar.getEvents, { organizationId: s.orgA, startDate: 0, endDate: 500 * DAY_MS }))).toMatch(/400 dias/);
  });

  test("teto de leitura: getEventsWithMeta sinaliza truncamento e o REST continua pelo cursor", async () => {
    const s = await seed(t);
    const total = EVENTS_SCAN_CAP + 20;
    await t.run(async (ctx) => {
      for (let i = 0; i < total; i++) {
        await ctx.db.insert("calendarEvents", {
          organizationId: s.orgA, title: `E${i}`, eventType: "other", startTime: T0 + i * 60_000, endTime: T0 + i * 60_000 + 1000,
          allDay: false, status: "scheduled", createdBy: s.adminA.memberId, createdAt: 1, updatedAt: 1,
        });
      }
    });
    const range = { organizationId: s.orgA, startDate: T0 - DAY_MS, endDate: T0 + 3 * DAY_MS, includeTasks: false };
    const res = await as(t, s.adminA).query(api.calendar.getEventsWithMeta, range);
    expect(res.truncated).toBe(true);
    expect(res.items.length).toBeLessThanOrEqual(1000);

    // REST: percorre tudo por cursor, sem repetir nem pular
    const rest = { organizationId: s.orgA, teamMemberId: s.adminA.memberId, startDate: range.startDate, endDate: range.endDate };
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const page: any = await t.query(internal.calendar.internalGetEvents, { ...rest, limit: 500, cursor });
      seen.push(...page.events.map((e: any) => e.title));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
    expect(seen[0]).toBe("E0");
    expect(seen[total - 1]).toBe(`E${total - 1}`);
  });

  test("REST: paginação coerente com a ordem por início, inclusive com inícios iguais", async () => {
    const s = await seed(t);
    for (const [i, off] of [[0, 0], [1, 0], [2, 0], [3, 1], [4, 1], [5, 2], [6, 3]] as const) {
      await insertRaw(t, s, { title: `E${i}`, startTime: T0 + off * HOUR, endTime: T0 + off * HOUR + 1000 });
    }
    const rest = { organizationId: s.orgA, teamMemberId: s.adminA.memberId, startDate: T0 - DAY_MS, endDate: T0 + DAY_MS };
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page: any = await t.query(internal.calendar.internalGetEvents, { ...rest, limit: 2, cursor });
      pages++;
      seen.push(...page.events.map((e: any) => e.title));
      if (!page.hasMore) break;
      cursor = page.nextCursor;
    }
    expect(pages).toBe(4);
    expect(seen).toEqual(["E0", "E1", "E2", "E3", "E4", "E5", "E6"]);
    expect(await errText(t.query(internal.calendar.internalGetEvents, { ...rest, cursor: "lixo" }))).toMatch(/Cursor inválido/);
  });
});
