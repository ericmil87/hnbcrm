/// <reference types="vite/client" />
/**
 * Agenda v2, PR I1: REST `/api/v1/scheduling/*` (rotas finas sobre `schedulingRest.ts` e as `internal*` de
 * `schedulingMutations.ts`). Autenticação por API key de verdade (`t.fetch`), RBAC por nível da chave, chave legada,
 * outra org, módulo desligado, idempotência, 409 estruturado, `force`, id malformado, paginação por cursor,
 * `view_own` sem vazamento, fechar recurso com prévia. Nenhuma mensagem real sai.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as R from "./schedulingRest";
import { assertMatchesReturns } from "./lib/assertMatchesValidator.test-helper";
import { type AgendaSeed, seedAgenda } from "./lib/schedTestSeed.test-helper";
import { schedInvariantProblems } from "./lib/schedInvariants.test-helper";
import { DEFAULT_PERMISSIONS } from "./lib/permissions";
import { sameResourceSet } from "./lib/schedBookingOps";
import { isReadLimitError } from "./lib/schedRestView";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const NOW = Date.UTC(2026, 5, 12, 15, 0); // sexta 12:00 em São Paulo
const MON = "2026-06-15";
const weekly = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 540, endMin: 1080 }));
const KEY = (name: string) => `hnb_test_sched_${name}_key_0001`;
const BASE = "/api/v1/scheduling";

let t: TestConvex<typeof schema>;
let s: AgendaSeed;
let svc: Id<"schedServices">;
let res: { p1: Id<"schedResources">; p2: Id<"schedResources">; sala: Id<"schedResources"> };

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function mkKey(name: string, memberId: Id<"teamMembers">, orgId: Id<"organizations">, permissions?: Record<string, string>) {
  const keyHash = await sha256Hex(KEY(name));
  await t.run((ctx) =>
    ctx.db.insert("apiKeys", {
      organizationId: orgId, teamMemberId: memberId, name, keyHash, isActive: true, createdAt: Date.now(),
      ...(permissions ? { permissions: permissions as never } : {}),
    })
  );
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  t = convexTest(schema, modules);
  s = await seedAgenda(t);
  const ids = await t.run(async (ctx) => {
    const mkRes = (name: string, kind: "person" | "room", teamMemberId?: Id<"teamMembers">, sortOrder = 0) =>
      ctx.db.insert("schedResources", {
        organizationId: s.orgId, kind, name, capacity: 1, weekly, tags: [], sortOrder, active: true,
        ...(teamMemberId ? { teamMemberId } : {}), createdAt: 1, updatedAt: 1,
      });
    const p1 = await mkRes("Profissional Um", "person", s.admin.memberId, 0);
    const p2 = await mkRes("Profissional Dois", "person", s.viewOwn.memberId, 1);
    const sala = await mkRes("Sala Um", "room", undefined, 2);
    await ctx.db.insert("schedResources", {
      organizationId: s.orgId, kind: "room", name: "Sala Arquivada", capacity: 1, weekly, tags: [], sortOrder: 9, active: false, createdAt: 1, updatedAt: 1,
    });
    const svcId = await ctx.db.insert("schedServices", {
      organizationId: s.orgId, name: "Consulta", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [{ role: "Profissional", kind: "person", resourceIds: [p1] }], sortOrder: 0, active: true, createdAt: 1, updatedAt: 1,
    });
    await ctx.db.insert("schedServices", {
      organizationId: s.orgId, name: "Serviço antigo", durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [{ role: "Sala", kind: "room" }], sortOrder: 1, active: false, createdAt: 1, updatedAt: 1,
    });
    return { svcId, p1, p2, sala };
  });
  svc = ids.svcId;
  res = { p1: ids.p1, p2: ids.p2, sala: ids.sala };
  await mkKey("none", s.none.memberId, s.orgId);
  await mkKey("own", s.viewOwn.memberId, s.orgId);
  await mkKey("all", s.viewAll.memberId, s.orgId);
  await mkKey("edit", s.agent.memberId, s.orgId);
  await mkKey("manage", s.admin.memberId, s.orgId);
  await mkKey("outsider", s.outsider.memberId, s.otherOrgId);
});
afterEach(async () => {
  expect(await schedInvariantProblems(t, s.orgId, Date.now())).toEqual([]);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Json = Record<string, any>;
async function call(key: string, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
  const resp = await t.fetch(`${BASE}${path}`, {
    method,
    headers: { "X-API-Key": KEY(key), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  let json: Json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* corpo vazio */
  }
  return { status: resp.status, json };
}
const get = (key: string, path: string) => call(key, "GET", path);
const post = (key: string, path: string, body: unknown, headers?: Record<string, string>) => call(key, "POST", path, body, headers);
const bookBody = (extra: Json = {}) => ({ serviceId: svc, startsAtLocal: `${MON}T10:00`, ...extra });
const book = (key: string, requestId: string, extra: Json = {}) => post(key, "/appointments/book", bookBody({ requestId, ...extra }));
/** Id bem formado de um agendamento que NÃO existe (criado e apagado). */
const ghostId = () =>
  t.run(async (ctx) => {
    const base = {
      organizationId: s.orgId, serviceId: svc, serviceName: "x", kind: "normal" as const, startTime: 1, endTime: 2, blockStart: 1, blockEnd: 2,
      localDate: MON, status: "cancelled" as const, origin: "staff" as const, resources: [], statusChangedAt: 1, createdAt: 1, updatedAt: 1,
    };
    const id = await ctx.db.insert("schedAppointments", base);
    await ctx.db.delete(id);
    return id as string;
  });
const appts = () => t.run((ctx) => ctx.db.query("schedAppointments").collect());

describe("RBAC por nível da chave", () => {
  test("leitura: none = 403; view_own, view_all, edit e manage = 200", async () => {
    expect((await get("none", "/services")).status).toBe(403);
    expect((await get("none", "/pending")).status).toBe(403);
    for (const key of ["own", "all", "edit", "manage"]) {
      const r = await get(key, "/services");
      expect(r.status, key).toBe(200);
      expect(r.json.services.map((x: Json) => x.name)).toEqual(["Consulta"]); // só os ativos
      expect(r.json.services[0].organizationId).toBeUndefined();
    }
  });

  test("escrita: none, view_own e view_all = 403 (nada gravado); edit e manage = 201", async () => {
    for (const key of ["none", "own", "all"]) {
      const r = await book(key, `r-${key}`);
      expect(r.status, key).toBe(403);
      expect(r.json).toEqual({ error: "Permissão insuficiente", code: 403 });
    }
    expect(await appts()).toHaveLength(0);
    const a = await book("edit", "r-edit");
    expect(a.status).toBe(201);
    const b = await book("manage", "r-manage", { startsAtLocal: `${MON}T14:00` });
    expect(b.status).toBe(201);
    expect(await appts()).toHaveLength(2);
    const row = (await appts())[0];
    expect(row.origin).toBe("api");
    expect(row.createdBy).toBe(s.agent.memberId);
  });

  test("toda rota de escrita nega view_all (e a de leitura de fechamento exige view_all)", async () => {
    const paths = ["/appointments/preview", "/appointments/reschedule", "/appointments/cancel", "/appointments/status", "/appointments/undo-status", "/appointments/resources", "/resources/day", "/resources/reopen", "/conflicts/resolve"];
    for (const p of paths) expect((await post("all", p, {})).status, p).toBe(403);
    expect((await get("own", "/closures/get?runId=abc")).status).toBe(403);
  });

  test("chave LEGADA sem `agenda` herda de `tasks`: edit_all escreve, view_own só lê", async () => {
    // permissões gravadas ANTES da categoria `agenda` existir: sem a chave
    const legacy = (tasks: string): Record<string, string> => {
      const { agenda: _agenda, ...rest } = DEFAULT_PERMISSIONS.agent;
      void _agenda;
      return { ...rest, tasks };
    };
    await mkKey("legacyedit", s.agent.memberId, s.orgId, legacy("edit_all"));
    await mkKey("legacyview", s.agent.memberId, s.orgId, legacy("view_own"));
    expect((await book("legacyedit", "leg-1")).status).toBe(201);
    expect((await get("legacyview", "/services")).status).toBe(200);
    expect((await book("legacyview", "leg-2", { startsAtLocal: `${MON}T15:00` })).status).toBe(403);
  });

  test("a chave com view_own enxerga só o que a tela mostraria; a de outra org não vê nada", async () => {
    const mine = await book("manage", "vis-1", { resourceIds: [res.p1] });
    expect(mine.status).toBe(201);
    const id = mine.json.appointmentId as string;
    // viewOwn é o profissional p2; o agendamento é do p1 (criado pelo admin): 404 idêntico ao inexistente.
    const own = await get("own", `/appointments/get?id=${id}`);
    const missing = await get("own", `/appointments/get?id=${await ghostId()}`);
    expect(missing.json).toEqual(own.json);
    expect(own.status).toBe(404);
    expect(own.json).toEqual({ error: "Agendamento não encontrado", code: 404 });
    expect(missing.status).toBe(404);
    const list = await get("own", `/appointments?from=${MON}&to=${MON}`);
    expect(list.json.appointments).toEqual([]);
    expect((await get("all", `/appointments/get?id=${id}`)).status).toBe(200);
    const foreign = await get("outsider", `/appointments/get?id=${id}`);
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual(own.json);
    // o agendamento do PRÓPRIO profissional aparece para a chave view_own
    const sala = await t.run((ctx) => ctx.db.insert("schedServices", {
      organizationId: s.orgId, name: "Com p2", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [{ role: "Profissional", kind: "person", resourceIds: [res.p2] }], sortOrder: 2, active: true, createdAt: 1, updatedAt: 1,
    }));
    const p2 = await post("manage", "/appointments/book", { serviceId: sala, startsAtLocal: `${MON}T11:00`, requestId: "vis-2" });
    expect(p2.status).toBe(201);
    const seen = await get("own", `/appointments?from=${MON}&to=${MON}`);
    expect(seen.json.appointments.map((a: Json) => a._id)).toEqual([p2.json.appointmentId]);
  });

  test("outra org: serviço e agendamento da org A não existem para a chave da B (404 igual ao inexistente)", async () => {
    const r = await post("outsider", "/appointments/book", bookBody({ requestId: "x-1" }));
    expect(r.status).toBe(404);
    expect(r.json.error).toBe("Serviço não encontrado");
    expect(await appts()).toHaveLength(0);
  });

  test("membro removido: a chave deixa de valer (401)", async () => {
    await t.run((ctx) => ctx.db.patch(s.agent.memberId, { removedAt: Date.now(), status: "inactive" } as never));
    expect((await get("edit", "/services")).status).toBe(401);
  });

  test("módulo desligado: resposta padrão do repo (400 com a mensagem do módulo), leitura e escrita", async () => {
    await t.run(async (ctx) => {
      const org = await ctx.db.get(s.orgId);
      await ctx.db.patch(s.orgId, { settings: { ...org!.settings, modules: { scheduling: false } } });
    });
    const r = await get("manage", "/services");
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/Módulo não habilitado/);
    expect((await book("manage", "off-1")).status).toBe(400);
    expect(await appts()).toHaveLength(0);
  });
});

describe("leituras", () => {
  test("serviços e recursos ativos; slots com audiência equipe só para edit+", async () => {
    const r = await get("all", "/resources");
    expect(r.json.resources.map((x: Json) => x.name)).toEqual(["Profissional Um", "Profissional Dois", "Sala Um"]);
    const q = `/slots?serviceId=${svc}&from=${MON}&to=${MON}&limit=3`;
    const staff = await get("edit", q);
    expect(staff.status).toBe(200);
    expect(staff.json.reason).toBe("ok");
    expect(staff.json.timezone).toBe("America/Sao_Paulo");
    const first = staff.json.slots[0];
    expect(first.resourceNames).toEqual(["Profissional Um"]);
    expect(first.startsAt).toMatch(/^2026-06-15T\d\d:\d\d:00-03:00$/);
    expect(first.startsAtLocal).toBe(first.startsAt.slice(0, 16));
    expect(first.reasonCodes).toBeDefined();
    const viewer = await get("all", q);
    expect(viewer.json.slots).toHaveLength(staff.json.slots.length);
    expect(viewer.json.slots[0]).toMatchObject({ resourceNames: [], reasons: [], reasonCodes: [], score: 0 });
    expect(viewer.json.slots[0].startTime).toBe(first.startTime);
  });

  test("slots: janela maior que 7 dias, período, partySize e ids malformados dão 400", async () => {
    expect((await get("edit", `/slots?serviceId=${svc}&from=${MON}&to=2026-06-30`)).status).toBe(400);
    expect((await get("edit", `/slots?serviceId=${svc}&from=${MON}&period=madrugada`)).status).toBe(400);
    expect((await get("edit", `/slots?serviceId=${svc}&from=${MON}&partySize=9`)).status).toBe(400);
    expect((await get("edit", `/slots?serviceId=${encodeURIComponent("não é id!")}&from=${MON}`)).status).toBe(400);
    expect((await get("edit", `/slots?from=${MON}`)).status).toBe(400);
    expect((await get("edit", `/slots?serviceId=${svc}`)).status).toBe(400);
  });

  test("agendamentos: paginação por cursor estável (mesmo início, sem repetir nem perder)", async () => {
    // 5 agendamentos, dois deles no MESMO início (recursos diferentes).
    const second = await t.run((ctx) => ctx.db.insert("schedServices", {
      organizationId: s.orgId, name: "Na sala", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [{ role: "Sala", kind: "room", resourceIds: [res.sala] }], sortOrder: 3, active: true, createdAt: 1, updatedAt: 1,
    }));
    const hours = ["09:00", "10:00", "11:00", "13:00"];
    for (const [i, h] of hours.entries()) expect((await book("manage", `pg-${i}`, { startsAtLocal: `${MON}T${h}` })).status).toBe(201);
    expect((await post("manage", "/appointments/book", { serviceId: second, startsAtLocal: `${MON}T10:00`, requestId: "pg-same" })).status).toBe(201);
    const ids: string[] = [];
    let cursor = "";
    for (let page = 0; page < 6; page++) {
      const r = await get("manage", `/appointments?from=${MON}&to=${MON}&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(r.status).toBe(200);
      expect(r.json.appointments.length).toBeLessThanOrEqual(2);
      ids.push(...r.json.appointments.map((a: Json) => a._id));
      expect(r.json.appointments[0]?.startsAtLocal).toMatch(/^2026-06-15T/);
      if (!r.json.hasMore) {
        expect(r.json.nextCursor).toBeNull();
        break;
      }
      cursor = r.json.nextCursor;
    }
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    const all = await get("manage", `/appointments?from=${MON}&to=${MON}&limit=50`);
    expect(all.json.appointments.map((a: Json) => a._id)).toEqual(ids);
    const filtered = await get("manage", `/appointments?from=${MON}&status=cancelled`);
    expect(filtered.json.appointments).toEqual([]);
    expect((await get("manage", `/appointments?from=${MON}&cursor=lixo`)).status).toBe(400);
    expect((await get("manage", `/appointments?from=${MON}&status=zzz`)).status).toBe(400);
    expect((await get("manage", `/appointments`)).status).toBe(400);
  });

  test("detalhe e pendências; returns conferidos com os validators", async () => {
    const b = await book("manage", "det-1", { contactId: s.contactId, leadId: s.leadId, notes: "interno" });
    const d = await get("manage", `/appointments/get?id=${b.json.appointmentId}`);
    expect(d.status).toBe(200);
    expect(d.json.appointment).toMatchObject({ serviceName: "Consulta", status: expect.any(String), timezone: "America/Sao_Paulo" });
    expect(d.json.appointment.idempotencyKey).toBeUndefined();
    expect(d.json.appointment.reminder).toBeUndefined();
    const p = await get("manage", "/pending");
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ timezone: "America/Sao_Paulo", approvals: expect.any(Array), conflicts: [], capped: expect.any(Object) });
    const keyArgs = { organizationId: s.orgId, teamMemberId: s.admin.memberId };
    assertMatchesReturns(await t.query(internal.schedulingRest.internalCatalog, keyArgs), R.internalCatalog);
    assertMatchesReturns(
      await t.query(internal.schedulingRest.internalFindSlots, { ...keyArgs, serviceId: svc, fromLocalDate: MON, now: NOW }),
      R.internalFindSlots
    );
    assertMatchesReturns(
      await t.query(internal.schedulingRest.internalListAppointments, { ...keyArgs, fromLocalDate: MON, toLocalDate: MON }),
      R.internalListAppointments
    );
    assertMatchesReturns(
      await t.query(internal.schedulingRest.internalGetAppointment, { ...keyArgs, appointmentId: b.json.appointmentId }),
      R.internalGetAppointment
    );
    // Formato estável: o REST nunca devolve campo do app (`contactPhone`, `crossingCapped`), mesmo com `contacts: view`.
    const rl = await t.query(internal.schedulingRest.internalListAppointments, { ...keyArgs, fromLocalDate: MON, toLocalDate: MON });
    expect(Object.keys(rl).sort()).toEqual(["appointments", "hasMore", "nextCursor", "timezone"]);
    const rg = await t.query(internal.schedulingRest.internalGetAppointment, { ...keyArgs, appointmentId: b.json.appointmentId });
    expect(Object.keys(rg?.detail ?? {}).sort()).toEqual(["appointment", "canEdit", "createdByName", "openConflicts", "statusActors"]);
    assertMatchesReturns(await t.query(internal.schedulingRest.internalListPending, { ...keyArgs, now: NOW }), R.internalListPending);
  });

  test("id malformado = 400 em toda rota que recebe id", async () => {
    for (const bad of ["", "a b", "../x", "x".repeat(80)]) {
      expect((await get("manage", `/appointments/get?id=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
    }
    expect((await post("manage", "/appointments/cancel", { appointmentId: "!!" })).status).toBe(400);
    expect((await post("manage", "/appointments/status", { appointmentId: 7, to: "confirmed" })).status).toBe(400);
    expect((await post("manage", "/appointments/reschedule", { appointmentId: "", startsAtLocal: `${MON}T10:00` })).status).toBe(400);
    expect((await post("manage", "/appointments/resources", { appointmentId: "abc", resourceIds: ["!"] })).status).toBe(400);
    expect((await post("manage", "/conflicts/resolve", { conflictId: "??", action: { type: "manual" } })).status).toBe(400);
    expect((await get("manage", "/closures/get?runId=%20")).status).toBe(400);
    expect((await book("manage", "bad-1", { contactId: "no no" })).status).toBe(400);
    expect((await book("manage", "bad-2", { resourceIds: "x" })).status).toBe(400);
    // um id bem formado de OUTRA tabela é recusado pela validação do Convex (400), não vira 500
    const wrongTable = (await get("manage", "/services")).json.services[0]._id;
    expect((await get("manage", `/appointments/get?id=${wrongTable}`)).status).toBe(400);
    // id bem formado mas que não existe = 404
    expect((await get("manage", `/appointments/get?id=${await ghostId()}`)).status).toBe(404);
  });
});

describe("marcar: idempotência, prévia e 409", () => {
  test("a chave de idempotência é obrigatória (cabeçalho Idempotency-Key ou requestId)", async () => {
    const none = await post("manage", "/appointments/book", bookBody());
    expect(none.status).toBe(400);
    expect(none.json.error).toMatch(/idempot/i);
    expect((await post("manage", "/appointments/book", bookBody({ requestId: "bad key!" }))).status).toBe(400);
    const header = await post("manage", "/appointments/book", bookBody(), { "Idempotency-Key": "hdr-1" });
    expect(header.status).toBe(201);
    expect(await appts()).toHaveLength(1);
  });

  test("mesma chave e mesmos dados = o mesmo agendamento (200, created:false); outros dados = 409 claro", async () => {
    const a = await book("manage", "idem-1");
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ success: true, created: true, duplicate: false, status: expect.any(String) });
    const b = await book("manage", "idem-1");
    expect(b.status).toBe(200);
    expect(b.json.appointmentId).toBe(a.json.appointmentId);
    expect(b.json.created).toBe(false);
    expect(await appts()).toHaveLength(1);
    const c = await book("manage", "idem-1", { startsAtLocal: `${MON}T15:00` });
    expect(c.status).toBe(409);
    expect(c.json.code).toBe("idempotency_key_reused");
    expect(c.json.error).toMatch(/idempotência/);
    expect(await appts()).toHaveLength(1);
  });

  test("prévia não grava; devolve o plano e os avisos", async () => {
    const before = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length);
    const r = await post("edit", "/appointments/preview", bookBody());
    expect(r.status).toBe(200);
    expect(r.json.preview).toBe(true);
    expect(r.json.plan).toEqual([expect.objectContaining({ role: "Profissional", resourceId: res.p1, resourceName: "Profissional Um" })]);
    expect(await appts()).toHaveLength(0);
    expect(await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).length)).toBe(before);
  });

  test("datas: startsAt com offset, startsAtLocal e startTime; divergência e hora inexistente = 400", async () => {
    const iso = await post("manage", "/appointments/preview", { serviceId: svc, startsAt: `${MON}T10:00:00-03:00` });
    const local = await post("manage", "/appointments/preview", { serviceId: svc, startsAtLocal: `${MON}T10:00` });
    const epoch = await post("manage", "/appointments/preview", { serviceId: svc, startTime: Date.UTC(2026, 5, 15, 13, 0) });
    for (const r of [iso, local, epoch]) expect(r.status).toBe(200);
    expect((await post("manage", "/appointments/preview", { serviceId: svc, startsAt: `${MON}T10:00:00-03:00`, startsAtLocal: `${MON}T11:00` })).status).toBe(400);
    expect((await post("manage", "/appointments/preview", { serviceId: svc, startsAt: `${MON}T10:00:00` })).status).toBe(400); // sem fuso
    expect((await post("manage", "/appointments/preview", { serviceId: svc })).status).toBe(400);
    expect((await post("manage", "/appointments/preview", { serviceId: svc, startTime: Date.UTC(2026, 5, 15, 13, 0, 30) })).status).toBe(400);
  });

  test("capacidade: 409 estruturado com violations e alternatives no formato Slot; force de capacidade não passa", async () => {
    expect((await book("manage", "cap-1")).status).toBe(201);
    const r = await book("edit", "cap-2");
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("sched_rules");
    expect(r.json.error).toEqual(expect.any(String));
    const cap = r.json.violations.find((v: Json) => v.code === "CAPACITY_EXCEEDED");
    expect(cap).toEqual({ code: "CAPACITY_EXCEEDED", severity: "block", message: expect.any(String) });
    expect(Object.keys(cap).sort()).toEqual(["code", "message", "severity"]); // sem `detail`
    expect(r.json.alternatives.length).toBeGreaterThan(0);
    expect(r.json.alternatives.length).toBeLessThanOrEqual(3);
    for (const alt of r.json.alternatives) {
      expect(alt).toMatchObject({
        startTime: expect.any(Number), endTime: expect.any(Number), localDate: MON, label: expect.any(String),
        resourceIds: expect.any(Array), resourceNames: expect.any(Array), score: expect.any(Number), reasons: expect.any(Array), reasonCodes: expect.any(Array),
        startsAt: expect.stringMatching(/-03:00$/), startsAtLocal: expect.any(String), timezone: "America/Sao_Paulo",
      });
    }
    const forced = await book("edit", "cap-3", { force: ["CAPACITY_EXCEEDED"] });
    expect(forced.status).toBe(409);
    expect(await appts()).toHaveLength(1);
    // a alternativa devolvida é marcável
    const alt = r.json.alternatives[0];
    const retry = await book("edit", "cap-4", { startsAtLocal: alt.startsAtLocal, resourceIds: alt.resourceIds });
    expect(retry.json).toMatchObject({ success: true });
    expect(retry.status).toBe(201);
  });

  test("force aceita só aviso: fora do expediente = 409 (warn) e passa com force:[OUTSIDE_HOURS]", async () => {
    const late = { startsAtLocal: `${MON}T20:00` };
    const refused = await book("manage", "warn-1", late);
    expect(refused.status).toBe(409);
    expect(refused.json.violations.find((v: Json) => v.code === "OUTSIDE_HOURS")).toMatchObject({ severity: "warn" });
    const forced = await book("manage", "warn-2", { ...late, force: ["OUTSIDE_HOURS"] });
    expect(forced.status).toBe(201);
    expect(forced.json.warnings.map((w: Json) => w.code)).toEqual(["OUTSIDE_HOURS"]);
    expect((await book("manage", "warn-3", { ...late, startsAtLocal: `${MON}T21:00`, force: "OUTSIDE_HOURS" })).status).toBe(400);
  });
});

describe("remarcar, cancelar, status, desfazer e trocar recurso", () => {
  test("remarcar (idempotente) e cancelar; 404 igual para inexistente", async () => {
    const a = await book("manage", "mv-1");
    const id = a.json.appointmentId as string;
    const moved = await post("edit", "/appointments/reschedule", { appointmentId: id, startsAtLocal: `${MON}T14:00`, requestId: "mv-key" });
    expect(moved.status).toBe(200);
    expect(moved.json.appointmentId).not.toBe(id);
    const again = await post("edit", "/appointments/reschedule", { appointmentId: id, startsAtLocal: `${MON}T14:00`, requestId: "mv-key" });
    expect(again.status).toBe(200);
    expect(again.json.appointmentId).toBe(moved.json.appointmentId);
    const old = await t.run((ctx) => ctx.db.get(id as Id<"schedAppointments">));
    expect(old?.status).toBe("rescheduled");
    const cancel = await post("edit", "/appointments/cancel", { appointmentId: moved.json.appointmentId, reason: "Cliente pediu" });
    expect(cancel.status).toBe(200);
    expect(cancel.json).toMatchObject({ success: true, lateCancel: expect.any(Boolean) });
    const gone = await post("edit", "/appointments/cancel", { appointmentId: await ghostId() });
    expect(gone.status).toBe(404);
    // remarcar para um horário tomado = 409 com alternativas
    const x = await book("manage", "mv-2", { startsAtLocal: `${MON}T10:00` });
    const y = await book("manage", "mv-3", { startsAtLocal: `${MON}T11:00` });
    const clash = await post("edit", "/appointments/reschedule", { appointmentId: y.json.appointmentId, startsAtLocal: `${MON}T10:00` });
    expect(clash.status).toBe(409);
    expect(clash.json.code).toBe("sched_rules");
    expect(x.status).toBe(201);
  });

  test("status: confirmar, chegou, atendido; valor inválido = 400; desfazer devolve o estado anterior", async () => {
    const a = await book("manage", "st-1");
    const id = a.json.appointmentId as string;
    expect((await post("edit", "/appointments/status", { appointmentId: id, to: "confirmed" })).status).toBe(200);
    expect((await post("edit", "/appointments/status", { appointmentId: id, to: "checked_in" })).status).toBe(200);
    expect((await post("edit", "/appointments/status", { appointmentId: id, to: "cancelled" })).status).toBe(400);
    expect((await post("edit", "/appointments/status", { appointmentId: id })).status).toBe(400);
    const undo = await post("edit", "/appointments/undo-status", { appointmentId: id });
    expect(undo.status).toBe(200);
    expect(undo.json.restoredTo).toBe("confirmed");
    expect((await t.run((ctx) => ctx.db.get(id as Id<"schedAppointments">)))?.status).toBe("confirmed");
    expect((await post("edit", "/appointments/status", { appointmentId: id, to: "completed" })).status).toBe(200);
  });

  test("aprovar e recusar proposta de IA (status approve / reject)", async () => {
    const mk = (start: string) =>
      t.run(async (ctx) => {
        const [h, m] = start.split(":").map(Number);
        const startTime = Date.UTC(2026, 5, 15, h + 3, m);
        const id = await ctx.db.insert("schedAppointments", {
          organizationId: s.orgId, serviceId: svc, serviceName: "Consulta", kind: "normal", startTime, endTime: startTime + 3_600_000,
          blockStart: startTime, blockEnd: startTime + 3_600_000, localDate: MON, status: "pending_approval", origin: "ai",
          resources: [{ resourceId: res.p1, role: "Profissional", name: "Profissional Um", allocated: true }],
          statusChangedAt: NOW, createdAt: NOW, updatedAt: NOW,
        });
        await ctx.db.insert("schedAllocations", {
          organizationId: s.orgId, appointmentId: id, resourceId: res.p1, role: "Profissional", blockStart: startTime, blockEnd: startTime + 3_600_000,
          coreStart: startTime, coreEnd: startTime + 3_600_000, units: 1,
        });
        return id;
      });
    const approve = await mk("09:00");
    const reject = await mk("11:00");
    const pending = await get("manage", "/pending");
    expect(pending.json.approvals.map((x: Json) => x._id).sort()).toEqual([approve, reject].sort());
    expect((await post("edit", "/appointments/status", { appointmentId: approve, action: "approve" })).status).toBe(200);
    expect((await t.run((ctx) => ctx.db.get(approve)))?.status).toBe("scheduled");
    expect((await post("edit", "/appointments/status", { appointmentId: reject, action: "reject", reason: "Sem vaga" })).status).toBe(200);
    expect((await t.run((ctx) => ctx.db.get(reject)))?.status).toBe("cancelled");
  });

  test("trocar recurso: capacidade tomada = 409; livre = 200", async () => {
    const svc2 = await t.run((ctx) => ctx.db.insert("schedServices", {
      organizationId: s.orgId, name: "Sala", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [{ role: "Sala", kind: "room" }], sortOrder: 4, active: true, createdAt: 1, updatedAt: 1,
    }));
    const salaB = await t.run((ctx) => ctx.db.insert("schedResources", {
      organizationId: s.orgId, kind: "room", name: "Sala Dois", capacity: 1, weekly, tags: [], sortOrder: 5, active: true, createdAt: 1, updatedAt: 1,
    }));
    const a = await post("manage", "/appointments/book", { serviceId: svc2, startsAtLocal: `${MON}T10:00`, resourceIds: [res.sala], requestId: "sw-1" });
    const b = await post("manage", "/appointments/book", { serviceId: svc2, startsAtLocal: `${MON}T10:00`, resourceIds: [salaB], requestId: "sw-2" });
    expect([a.status, b.status]).toEqual([201, 201]);
    const clash = await post("edit", "/appointments/resources", { appointmentId: b.json.appointmentId, resourceIds: [res.sala] });
    expect(clash.status).toBe(409);
    expect(clash.json.violations.some((v: Json) => v.code === "CAPACITY_EXCEEDED")).toBe(true);
    const c = await post("manage", "/appointments/book", { serviceId: svc2, startsAtLocal: `${MON}T13:00`, resourceIds: [res.sala], requestId: "sw-3" });
    const ok = await post("edit", "/appointments/resources", { appointmentId: c.json.appointmentId, resourceIds: [salaB] });
    expect(ok.status).toBe(200);
  });
});

describe("recurso fechado ou cheio nunca passa em silêncio (E2)", () => {
  const TUE = "2026-06-16";
  async function rooms() {
    return await t.run(async (ctx) => {
      const mk = (name: string, sortOrder: number) =>
        ctx.db.insert("schedResources", { organizationId: s.orgId, kind: "room", name, capacity: 1, weekly, tags: [], sortOrder, active: true, createdAt: 1, updatedAt: 1 });
      const r1 = await mk("Sala A", 10);
      const r2 = await mk("Sala B", 11);
      const roomSvc = await ctx.db.insert("schedServices", {
        organizationId: s.orgId, name: "Sessão de sala", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
        requirements: [{ role: "Sala", kind: "room", resourceIds: [r1, r2] }], sortOrder: 2, active: true, createdAt: 1, updatedAt: 1,
      });
      return { r1, r2, roomSvc };
    });
  }
  const closeDay = (resourceId: string, date: string) => post("manage", "/resources/day", { resourceId, fromLocalDate: date, mode: "commit", acceptAffected: true });
  const bookIn = (roomSvc: string, local: string, ids: string[], requestId: string) => post("manage", "/appointments/book", { serviceId: roomSvc, startsAtLocal: local, resourceIds: ids, requestId });
  const roomOf = async (id: string) => (await t.run((ctx) => ctx.db.get(id as Id<"schedAppointments">)))?.resources.map((r) => r.name);

  test("remarcar sem resourceIds para dia com a sala atual FECHADA: 409 (aviso exige force); force explícito mantém a sala; resourceIds troca", async () => {
    const { r1, r2, roomSvc } = await rooms();
    const a = await bookIn(roomSvc, `${MON}T10:00`, [r1], "e2-1");
    expect(a.status).toBe(201);
    await closeDay(r1, TUE);

    const refused = await post("edit", "/appointments/reschedule", { appointmentId: a.json.appointmentId, startsAtLocal: `${TUE}T14:00` });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("sched_rules");
    expect(refused.json.violations.map((v: Json) => `${v.code}:${v.severity}`)).toContain("RESOURCE_CLOSED:warn");
    expect((await appts()).filter((x) => x.status === "scheduled")).toHaveLength(1);

    const other = await post("edit", "/appointments/reschedule", { appointmentId: a.json.appointmentId, startsAtLocal: `${TUE}T14:00`, resourceIds: [r2] });
    expect(other.status).toBe(200);
    expect(await roomOf(other.json.appointmentId)).toEqual(["Sala B"]);

    const forced = await post("edit", "/appointments/reschedule", { appointmentId: other.json.appointmentId, startsAtLocal: `${TUE}T16:00`, resourceIds: [r1], force: ["RESOURCE_CLOSED"] });
    expect(forced.status).toBe(200);
    expect((await t.run((ctx) => ctx.db.get(forced.json.appointmentId as Id<"schedAppointments">)))?.forcedRules).toEqual(["RESOURCE_CLOSED"]);
  });

  test("force por PAR código:recurso: cobre só o recurso citado; outro aviso do mesmo código segue recusado; o código puro continua valendo", async () => {
    const { r1, r2, roomSvc } = await rooms();
    // serviço de duas peças: as duas salas no mesmo agendamento (papéis Sala e Apoio)
    const pairSvc = await t.run((ctx) =>
      ctx.db.insert("schedServices", {
        organizationId: s.orgId, name: "Dupla de salas", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
        requirements: [{ role: "Sala", kind: "room", resourceIds: [r1] }, { role: "Apoio", kind: "room", resourceIds: [r2] }], sortOrder: 3, active: true, createdAt: 1, updatedAt: 1,
      })
    );
    await closeDay(r1, TUE);
    await closeDay(r2, TUE);
    const base = { serviceId: pairSvc, startsAtLocal: `${TUE}T10:00`, resourceIds: [r1, r2] };
    const only1 = await post("manage", "/appointments/book", { ...base, force: [`RESOURCE_CLOSED:${r1}`], requestId: "pair-1" });
    expect(only1.status).toBe(409);
    expect(only1.json.violations.map((v: Json) => v.code)).toContain("RESOURCE_CLOSED");
    const both = await post("manage", "/appointments/book", { ...base, force: [`RESOURCE_CLOSED:${r1}`, `RESOURCE_CLOSED:${r2}`], requestId: "pair-2" });
    expect(both.status).toBe(201);
    const plain = await post("manage", "/appointments/book", { ...base, startsAtLocal: `${TUE}T14:00`, force: ["RESOURCE_CLOSED"], requestId: "pair-3" });
    expect(plain.status).toBe(201);
    expect(roomSvc).toBeTruthy();
  });

  test("sala pedida cheia: por padrão 409 (não troca em silêncio, como a tela); só `allowResourceFallback:true` aceita o plano alternativo", async () => {
    const { r1, r2, roomSvc } = await rooms();
    const a = await bookIn(roomSvc, `${MON}T10:00`, [r1], "e2-2");
    await bookIn(roomSvc, `${TUE}T14:00`, [r1], "e2-3");
    const body = { appointmentId: a.json.appointmentId, startsAtLocal: `${TUE}T14:00` };

    const pinnedCurrent = await post("edit", "/appointments/reschedule", body);
    expect(pinnedCurrent.status).toBe(409);
    expect(pinnedCurrent.json.violations.map((v: Json) => v.code)).toContain("CAPACITY_EXCEEDED");
    const pinnedNamed = await post("edit", "/appointments/reschedule", { ...body, resourceIds: [r1] });
    expect(pinnedNamed.status).toBe(409);
    expect((await appts()).filter((x) => x.status === "scheduled" && x.startTime !== NOW)).toHaveLength(2); // nada foi remarcado

    // prévia da remarcação com o mesmo comportamento
    const preview = await post("edit", "/appointments/preview", { serviceId: roomSvc, startsAtLocal: `${TUE}T14:00`, rescheduleAppointmentId: a.json.appointmentId });
    expect(preview.status).toBe(409);

    const swapped = await post("edit", "/appointments/reschedule", { ...body, allowResourceFallback: true });
    expect(swapped.status).toBe(200);
    expect(await roomOf(swapped.json.appointmentId)).toEqual(["Sala B"]);
    expect(r2).toBeTruthy();
  });

  test("marcar com resourceIds cheio: 409 por padrão; allowResourceFallback inválido = 400", async () => {
    const { r1, roomSvc } = await rooms();
    await bookIn(roomSvc, `${MON}T10:00`, [r1], "e2-4");
    const clash = await bookIn(roomSvc, `${MON}T10:00`, [r1], "e2-5");
    expect(clash.status).toBe(409);
    const fallback = await post("manage", "/appointments/book", { serviceId: roomSvc, startsAtLocal: `${MON}T10:00`, resourceIds: [r1], allowResourceFallback: true, requestId: "e2-6" });
    expect(fallback.status).toBe(201);
    expect(await roomOf(fallback.json.appointmentId)).toEqual(["Sala B"]);
    for (const path of ["/appointments/book", "/appointments/preview", "/appointments/reschedule"]) {
      const bad = await post("manage", path, { serviceId: roomSvc, appointmentId: fallback.json.appointmentId, startsAtLocal: `${MON}T11:00`, allowResourceFallback: "sim", requestId: "e2-7" });
      expect(bad.status).toBe(400);
      expect(bad.json.error ?? "").toMatch(/allowResourceFallback/);
    }
  });

  test("conflito: remarcar pela ação `reschedule` não troca sala em silêncio (padrão) e aceita `allowResourceFallback:true`", async () => {
    const { r1, r2, roomSvc } = await rooms();
    const a = await bookIn(roomSvc, `${MON}T10:00`, [r1], "e2-8");
    await bookIn(roomSvc, `${MON}T10:00`, [r2], "e2-8b");
    await bookIn(roomSvc, `${TUE}T14:00`, [r1], "e2-9");
    await closeDay(r1, MON); // Sala B também está ocupada às 10:00: o cliente da Sala A fica sem lugar
    const conflict = await t.run(async (ctx) => (await ctx.db.query("schedConflicts").collect()).find((c) => c.appointmentId === (a.json.appointmentId as Id<"schedAppointments">) && c.status === "open"));
    expect(conflict).toBeTruthy();
    const clash = await post("manage", "/conflicts/resolve", { conflictId: conflict!._id, action: { type: "reschedule", startsAtLocal: `${TUE}T14:00` } });
    expect(clash.status).toBe(409);
    expect(clash.json.violations.map((v: Json) => v.code)).toContain("CAPACITY_EXCEEDED");
    const ok = await post("manage", "/conflicts/resolve", { conflictId: conflict!._id, action: { type: "reschedule", startsAtLocal: `${TUE}T14:00`, allowResourceFallback: true } });
    expect(ok.status).toBe(200);
  });
});

describe("fechar e reabrir recurso, conflitos", () => {
  const close = (key: string, body: Json) => post(key, "/resources/day", { fromLocalDate: MON, ...body });

  test("prévia não grava; commit com expectedAffected divergente é recusado; acerto passa", async () => {
    const a = await book("manage", "cl-1", { resourceIds: [res.p1] });
    expect(a.status).toBe(201);
    const preview = await close("edit", { resourceId: res.p1 });
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ mode: "preview", affected: 1, conflicts: 1 });
    expect(preview.json.items[0]).toMatchObject({ appointmentId: a.json.appointmentId, outcome: "conflict", startsAtLocal: `${MON}T10:00` });
    expect(await t.run((ctx) => ctx.db.query("schedExceptions").collect())).toHaveLength(0);
    const bad = await close("edit", { resourceId: res.p1, mode: "commit", acceptAffected: true, expectedAffected: 3 });
    expect(bad.status).toBe(400);
    expect(await t.run((ctx) => ctx.db.query("schedExceptions").collect())).toHaveLength(0);
    const noAccept = await close("edit", { resourceId: res.p1, mode: "commit", expectedAffected: 1 });
    expect(noAccept.status).toBe(400);
    const done = await close("edit", { resourceId: res.p1, mode: "commit", acceptAffected: true, expectedAffected: 1, reasonCode: "day_off" });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ mode: "commit", affected: 1, conflicts: 1 });
    expect(await t.run((ctx) => ctx.db.query("schedExceptions").collect())).toHaveLength(1);
    // o agendamento afetado virou conflito aberto, que o operador resolve pela API
    const pending = await get("edit", "/pending");
    expect(pending.json.conflicts).toHaveLength(1);
    const conflictId = pending.json.conflicts[0]._id;
    expect(pending.json.conflicts[0].appointment.startsAtLocal).toBe(`${MON}T10:00`);
    const bad2 = await post("edit", "/conflicts/resolve", { conflictId, action: { type: "bogus" } });
    expect(bad2.status).toBe(400);
    const cancel = await post("edit", "/conflicts/resolve", { conflictId, action: { type: "cancel", reason: "Profissional de folga" } });
    expect(cancel.status).toBe(200);
    expect((await get("edit", "/pending")).json.conflicts).toEqual([]);
    expect((await post("edit", "/conflicts/resolve", { conflictId, action: { type: "manual" } })).status).toBe(400); // já resolvido
    // reabrir: prévia e commit
    const reopen = await post("edit", "/resources/reopen", { resourceId: res.p1, fromLocalDate: MON, mode: "commit" });
    expect(reopen.status).toBe(200);
    expect(reopen.json).toMatchObject({ mode: "commit", removed: 1 });
    expect(await t.run((ctx) => ctx.db.query("schedExceptions").collect())).toHaveLength(0);
  });

  test("fechar a agenda inteira (sem recurso) exige manage; prévia padrão; recurso de outra org = 404", async () => {
    const denied = await close("edit", {});
    expect(denied.status).toBe(403);
    expect((await post("edit", "/resources/reopen", { fromLocalDate: MON })).status).toBe(403);
    const preview = await close("manage", {});
    expect(preview.status).toBe(200);
    expect(preview.json.mode).toBe("preview");
    const foreign = await t.run((ctx) => ctx.db.insert("schedResources", {
      organizationId: s.otherOrgId, kind: "room", name: "Sala B", capacity: 1, weekly, tags: [], sortOrder: 0, active: true, createdAt: 1, updatedAt: 1,
    }));
    const r = await close("edit", { resourceId: foreign });
    expect(r.status).toBe(404);
    expect((await close("edit", { resourceId: res.p1, mode: "nope" })).status).toBe(400);
    expect((await close("edit", { resourceId: res.p1, kind: "block" })).status).toBe(400); // bloqueio exige intervalos
    expect((await close("edit", { resourceId: res.p1, fromLocalDate: "15/06/2026" })).status).toBe(400);
    expect(await t.run((ctx) => ctx.db.query("schedExceptions").collect())).toHaveLength(0);
  });

  test("andamento do fechamento: view_all lê; view_own não; inexistente = 404", async () => {
    const run = await t.run((ctx) => ctx.db.insert("schedClosureRuns", {
      organizationId: s.orgId, kind: "resource_closed", resourceId: res.p1, fromLocalDate: MON, toLocalDate: MON, status: "done",
      total: 0, totalIsPartial: false, processed: 0, reallocated: 0, conflicts: 0, failed: 0, createdAt: NOW, updatedAt: NOW,
    }));
    const ok = await get("all", `/closures/get?runId=${run}`);
    expect(ok.status).toBe(200);
    expect(ok.json.run.status).toBe("done");
    assertMatchesReturns(await t.query(internal.schedulingRest.internalGetClosureRun, { organizationId: s.orgId, teamMemberId: s.viewAll.memberId, runId: run }), R.internalGetClosureRun);
    expect((await get("outsider", `/closures/get?runId=${run}`)).status).toBe(404);
  });

  test("returns de fechar/reabrir conferem com o validator", async () => {
    const key = { organizationId: s.orgId, teamMemberId: s.admin.memberId };
    assertMatchesReturns(await t.mutation(internal.schedulingRest.internalSetResourceDay, { ...key, resourceId: res.p1, fromLocalDate: MON, mode: "commit" }), R.internalSetResourceDay);
    assertMatchesReturns(await t.mutation(internal.schedulingRest.internalReopenResourceDay, { ...key, resourceId: res.p1, fromLocalDate: MON, mode: "commit" }), R.internalReopenResourceDay);
  });
});

describe("webhooks e auditoria da porta", () => {
  test("marcar pela REST audita como API/rest e emite appointment.created para quem assina", async () => {
    const delivered: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      delivered.push(String(init?.body ?? ""));
      return new Response("ok", { status: 200 });
    }));
    await t.run((ctx) => ctx.db.insert("webhooks", {
      organizationId: s.orgId, name: "n8n", url: "https://example.com/hook", events: ["appointment.created", "appointment.cancelled"], secret: "x".repeat(16), isActive: true, createdAt: 1,
    }));
    const a = await book("manage", "wh-1", { leadId: s.leadId, contactId: s.contactId });
    expect(a.status).toBe(201);
    const scheduled = await t.run(async (ctx) => (await ctx.db.system.query("_scheduled_functions").collect()).map((f) => JSON.stringify(f.args)));
    expect(scheduled.some((x) => x.includes("appointment.created"))).toBe(true);
    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    const created = audit.find((l) => l.entityType === "schedAppointment" && l.action === "create");
    expect(created?.metadata).toMatchObject({ via: "rest", origin: "api" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(delivered.some((body) => body.includes("appointment.created"))).toBe(true);
    expect(delivered.join("")).not.toMatch(/interno|phone|email/);
    const acts = await t.run((ctx) => ctx.db.query("activities").collect());
    expect(acts.some((x) => x.type === "appointment_booked")).toBe(true);
  });
});

describe("revisão adversarial (I1)", () => {
  const perms = (base: "admin" | "agent", agenda: string) => ({ ...DEFAULT_PERMISSIONS[base], agenda }) as Record<string, string>;

  test("idempotência: mesma chave com outros recursos ou variação = 409; notes diferente = repetição", async () => {
    const a = await book("manage", "adv-1");
    expect(a.status).toBe(201);
    const other = await book("manage", "adv-1", { resourceIds: [res.p2], notes: "outra" });
    expect(other.status).toBe(409);
    expect(other.json.code).toBe("idempotency_key_reused");
    expect((await book("manage", "adv-1", { variantKey: "curta" })).status).toBe(409);
    const same = await book("manage", "adv-1", { resourceIds: [res.p1], notes: "outra nota" });
    expect(same.status).toBe(200);
    expect(same.json.appointmentId).toBe(a.json.appointmentId);
    expect(await appts()).toHaveLength(1);
  });

  test("sameResourceSet: ordem não importa; sem recursos pedidos não restringe", () => {
    const ex = [{ resourceId: "a" }, { resourceId: "b" }];
    expect(sameResourceSet(ex, ["b", "a"])).toBe(true);
    expect(sameResourceSet(ex, undefined)).toBe(true);
    expect(sameResourceSet(ex, [])).toBe(true);
    expect(sameResourceSet(ex, ["a"])).toBe(false);
    expect(sameResourceSet(ex, ["a", "c"])).toBe(false);
  });

  test("recusar só vale para proposta pendente: agendamento confirmado não é cancelado por reject", async () => {
    const a = await book("manage", "rej-1");
    const id = a.json.appointmentId as string;
    expect((await post("edit", "/appointments/status", { appointmentId: id, to: "confirmed" })).status).toBe(200);
    const r = await post("edit", "/appointments/status", { appointmentId: id, action: "reject" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Este agendamento não é uma proposta pendente; use cancelar.");
    expect((await t.run((ctx) => ctx.db.get(id as Id<"schedAppointments">)))?.status).toBe("confirmed");
    expect((await post("edit", "/appointments/cancel", { appointmentId: id })).status).toBe(200);
  });

  test("matriz chave x membro: a chave vale igual em leitura e escrita (acima, abaixo e sem permissões gravadas)", async () => {
    // chave ACIMA do membro (membro view_own, chave manage): lê tudo, marca e fecha a agenda inteira
    await mkKey("ownAsManage", s.viewOwn.memberId, s.orgId, perms("agent", "manage"));
    const seed = await book("manage", "mx-seed");
    expect((await get("ownAsManage", `/appointments/get?id=${seed.json.appointmentId}`)).status).toBe(200);
    expect((await book("ownAsManage", "mx-up", { startsAtLocal: `${MON}T15:00` })).status).toBe(201);
    expect((await post("ownAsManage", "/resources/day", { fromLocalDate: MON })).status).toBe(200);
    // chave ABAIXO do membro (admin, chave view_own): só os próprios, não marca, não fecha
    await mkKey("adminAsOwn", s.admin.memberId, s.orgId, perms("admin", "view_own"));
    expect((await book("adminAsOwn", "mx-down")).status).toBe(403);
    expect((await post("adminAsOwn", "/resources/day", { resourceId: res.p1, fromLocalDate: MON })).status).toBe(403);
    expect((await post("adminAsOwn", "/appointments/cancel", { appointmentId: seed.json.appointmentId })).status).toBe(403);
    // chave edit sobre membro admin: marca, mas NÃO fecha a agenda inteira (manage nas duas camadas)
    await mkKey("adminAsEdit", s.admin.memberId, s.orgId, perms("admin", "edit"));
    expect((await book("adminAsEdit", "mx-edit", { startsAtLocal: `${MON}T16:00` })).status).toBe(201);
    expect((await post("adminAsEdit", "/resources/day", { fromLocalDate: MON })).status).toBe(403);
    // sem permissões gravadas na chave: vale o membro (viewOwn do seed não escreve; admin escreve)
    expect((await book("own", "mx-own")).status).toBe(403);
    expect((await book("manage", "mx-manage", { startsAtLocal: `${MON}T17:00` })).status).toBe(201);
  });

  test("andamento do fechamento: só campos de andamento, sem org, autor nem mensagem interna", async () => {
    const run = await t.run((ctx) => ctx.db.insert("schedClosureRuns", {
      organizationId: s.orgId, kind: "resource_closed", resourceId: res.p1, fromLocalDate: MON, toLocalDate: MON, status: "failed",
      failure: "Error: detalhe interno stack", total: 3, totalIsPartial: false, processed: 1, reallocated: 0, conflicts: 1, failed: 2,
      createdBy: s.admin.memberId, exceptionIds: [], createdAt: NOW, updatedAt: NOW,
    }));
    const r = await get("all", `/closures/get?runId=${run}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.run).sort()).toEqual([
      "_id", "conflicts", "createdAt", "failed", "failureMessage", "fromLocalDate", "kind", "processed", "reallocated",
      "resourceId", "status", "toLocalDate", "total", "totalIsPartial", "updatedAt",
    ]);
    expect(JSON.stringify(r.json)).not.toMatch(/interno|stack|organizationId|createdBy/);
    assertMatchesReturns(await t.query(internal.schedulingRest.internalGetClosureRun, { organizationId: s.orgId, teamMemberId: s.viewAll.memberId, runId: run }), R.internalGetClosureRun);
  });

  test("linhas de agendamento da REST: projeção própria, sem org, _creationTime, bloco nem autor cru", async () => {
    const b = await book("manage", "pr-1", { contactId: s.contactId, notes: "n" });
    const row = (await get("manage", `/appointments?from=${MON}`)).json.appointments[0];
    for (const k of ["organizationId", "_creationTime", "blockStart", "blockEnd", "createdBy", "approvedBy", "idempotencyKey", "reminder", "notes"]) {
      expect(row[k], k).toBeUndefined();
    }
    expect(row).toMatchObject({ _id: b.json.appointmentId, serviceName: "Consulta", startsAtLocal: `${MON}T10:00`, timezone: "America/Sao_Paulo" });
    const detail = (await get("manage", `/appointments/get?id=${b.json.appointmentId}`)).json.appointment;
    expect(detail.notes).toBe("n");
    expect(detail.organizationId).toBeUndefined();
    expect(detail.createdBy).toBeUndefined();
    const cat = (await get("manage", "/resources")).json.resources[0];
    expect(cat.organizationId).toBeUndefined();
    expect(cat._creationTime).toBeUndefined();
  });

  test("limites de custo: lista até 31 dias, pendências com limit, janela padrão de 3 dias nos horários", async () => {
    expect((await get("manage", `/appointments?from=2026-06-01&to=2026-07-01`)).status).toBe(200);
    const big = await get("manage", `/appointments?from=2026-06-01&to=2026-07-02`);
    expect(big.status).toBe(400);
    expect(big.json.error).toMatch(/31 dias/);
    const slots = await get("manage", `/slots?serviceId=${svc}&from=${MON}&limit=50`);
    expect(slots.status).toBe(200);
    const days = new Set(slots.json.slots.map((x: Json) => x.localDate));
    expect([...days].sort()).toEqual(["2026-06-15", "2026-06-16", "2026-06-17"]);
    const week = await get("manage", `/slots?serviceId=${svc}&from=${MON}&to=2026-06-21&limit=50`);
    expect(new Set(week.json.slots.map((x: Json) => x.localDate)).size).toBeGreaterThan(3);
    // pendências: limit corta por seção
    const mk = (h: number) => t.run((ctx) => ctx.db.insert("schedAppointments", {
      organizationId: s.orgId, serviceId: svc, serviceName: "Consulta", kind: "normal", startTime: Date.UTC(2026, 5, 15, h + 3), endTime: Date.UTC(2026, 5, 15, h + 4),
      blockStart: Date.UTC(2026, 5, 15, h + 3), blockEnd: Date.UTC(2026, 5, 15, h + 4), localDate: MON, status: "pending_approval", origin: "ai",
      resources: [{ resourceId: res.p2, role: "Profissional", name: "Profissional Dois", allocated: false }], needsAttention: { code: "no_resource", at: NOW },
      statusChangedAt: NOW, createdAt: NOW, updatedAt: NOW,
    }));
    await mk(9);
    await mk(10);
    const p = await get("manage", "/pending?limit=1");
    expect(p.json.approvals).toHaveLength(1);
    expect(p.json.capped.approvals).toBe(true);
    expect((await get("manage", "/pending")).json.approvals).toHaveLength(2);
    expect((await get("manage", "/pending?limit=x")).status).toBe(400);
    await t.run(async (ctx) => { for (const a of await ctx.db.query("schedAppointments").collect()) await ctx.db.delete(a._id); });
  });

  test("horários: serviço inexistente ou de outra org = 404 igual ao das outras rotas", async () => {
    const ghost = await t.run(async (ctx) => {
      const id = await ctx.db.insert("schedServices", { organizationId: s.orgId, name: "x", durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: [{ role: "Sala", kind: "room" }], sortOrder: 9, active: true, createdAt: 1, updatedAt: 1 });
      await ctx.db.delete(id);
      return id;
    });
    const r = await get("edit", `/slots?serviceId=${ghost}&from=${MON}`);
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "Serviço não encontrado", code: 404 });
    expect((await get("outsider", `/slots?serviceId=${svc}&from=${MON}`)).json).toEqual(r.json);
  });

  test("chave de membro de IA: lê a agenda, escrever = 403 com mensagem clara", async () => {
    const aiMember = await t.run((ctx) => ctx.db.insert("teamMembers", { organizationId: s.orgId, name: "Agente IA", role: "ai", type: "ai", status: "active", createdAt: 1, updatedAt: 1 }));
    await mkKey("ai", aiMember, s.orgId);
    expect((await get("ai", "/services")).status).toBe(200);
    for (const [path, body] of [
      ["/appointments/book", bookBody({ requestId: "ai-1" })],
      ["/appointments/cancel", { appointmentId: await ghostAppt() }],
      ["/resources/day", { resourceId: res.p1, fromLocalDate: MON }],
    ] as const) {
      const r = await post("ai", path, body);
      expect(r.status, path).toBe(403);
      expect(r.json.error).toBe("Chaves de agentes de IA só leem a agenda por esta API");
    }
    expect(await appts()).toHaveLength(0);
  });

  test("marcar em grupo (casal na sala dupla): tudo ou nada, idempotente por grupo", async () => {
    const dupla = await t.run((ctx) => ctx.db.insert("schedResources", { organizationId: s.orgId, kind: "room", name: "Sala Dupla", capacity: 2, weekly, tags: [], sortOrder: 7, active: true, createdAt: 1, updatedAt: 1 }));
    const casal = await t.run((ctx) => ctx.db.insert("schedServices", {
      organizationId: s.orgId, name: "Massagem casal", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [{ role: "Sala", kind: "room", resourceIds: [dupla] }], sortOrder: 8, active: true, createdAt: 1, updatedAt: 1,
    }));
    const body = { serviceId: casal, startsAtLocal: `${MON}T10:00`, contactId: s.contactId, companions: [{ guestName: "Acompanhante" }], requestId: "party-1" };
    const r = await post("edit", "/appointments/book", body);
    expect(r.status).toBe(201);
    expect(r.json.appointmentIds).toHaveLength(2);
    expect(r.json.partySize).toBe(2);
    const rows = await appts();
    expect(rows.map((x) => x.guestName ?? "").sort()).toEqual(["", "Acompanhante"]);
    expect(new Set(rows.map((x) => x.partyKey)).size).toBe(1);
    const again = await post("edit", "/appointments/book", body);
    expect(again.status).toBe(200);
    expect(again.json.duplicate).toBe(true);
    expect(await appts()).toHaveLength(2);
    // sala cheia (2 pessoas): outro casal no mesmo horário = 409 e nada novo gravado
    const full = await post("edit", "/appointments/book", { ...body, requestId: "party-2", contactId: undefined });
    expect(full.status).toBe(409);
    expect(full.json.violations.some((v: Json) => v.code === "CAPACITY_EXCEEDED")).toBe(true);
    expect(await appts()).toHaveLength(2);
    // validação
    expect((await post("edit", "/appointments/book", { ...body, requestId: "p3", companions: [] })).status).toBe(400);
    expect((await post("edit", "/appointments/book", { ...body, requestId: "p4", companions: [{ guestName: "" }] })).status).toBe(400);
    expect((await post("all", "/appointments/book", { ...body, requestId: "p5" })).status).toBe(403);
  });

  test("estouro do teto de leitura do runtime vira 400, nunca 500", () => {
    expect(isReadLimitError("Too many documents read in a single function execution (limit: 32000)")).toBe(true);
    expect(isReadLimitError("Too many bytes read in a single function execution (limit: 16777216 bytes)")).toBe(true);
    expect(isReadLimitError("Serviço não encontrado")).toBe(false);
  });
});

async function ghostAppt(): Promise<string> {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("schedAppointments", {
      organizationId: s.orgId, serviceId: svc, serviceName: "x", kind: "normal", startTime: 1, endTime: 2, blockStart: 1, blockEnd: 2,
      localDate: MON, status: "cancelled", origin: "staff", resources: [], statusChangedAt: 1, createdAt: 1, updatedAt: 1,
    });
    await ctx.db.delete(id);
    return id as string;
  });
}
