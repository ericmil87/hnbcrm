/// <reference types="vite/client" />
/**
 * Agenda v2, PR A3a: configuração (`schedulingConfig.*`). Isolamento entre orgs, RBAC, módulo desligado,
 * validações de escrita, modelos prontos (idempotência), aceite do "marca sozinha", fuso e `returns`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as config from "./schedulingConfig";
import { assertMatchesReturns, assertMatchesValidator } from "./lib/assertMatchesValidator.test-helper";
import { settingsViewValidator } from "./lib/schedViews";
import { type AgendaSeed, identityOf, seedAgenda, type Person } from "./lib/schedTestSeed.test-helper";
import { schedInvariantProblems } from "./lib/schedInvariants.test-helper";
import { MAX_RESOURCES_PER_ORG, MAX_SERVICES_PER_ORG } from "./lib/schedConstants";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
let t: TestConvex<typeof schema>;
let s: AgendaSeed;

const as = (p: Person) => t.withIdentity(identityOf(p));
const at10 = (n: number) => n;
const weekdays = (days: number[], ...shifts: Array<[number, number]>) =>
  days.flatMap((weekday) => shifts.map(([startMin, endMin]) => ({ weekday, startMin, endMin })));
const room = (over: Record<string, unknown> = {}) => ({
  kind: "room" as const,
  name: "Sala 1",
  capacity: 1,
  weekly: weekdays([1, 2, 3, 4, 5], [540, 720]),
  ...over,
});
const person = (over: Record<string, unknown> = {}) => ({
  kind: "person" as const,
  name: "Ana",
  capacity: 1,
  weekly: weekdays([1, 2, 3, 4, 5], [540, 720]),
  ...over,
});
const service = (over: Record<string, unknown> = {}) => ({
  name: "Sessão",
  durationMin: 60,
  requirements: [{ role: "Profissional", kind: "person" as const }],
  ...over,
});
const mkResourceFull = (p: Person, over: Record<string, unknown> = {}, org = s.orgId) =>
  as(p).mutation(api.schedulingConfig.upsertResource, { organizationId: org, ...room(over) } as any);
const mkResource = async (p: Person, over: Record<string, unknown> = {}, org = s.orgId) => (await mkResourceFull(p, over, org)).resourceId;
const mkService = (p: Person, over: Record<string, unknown> = {}, org = s.orgId) =>
  as(p).mutation(api.schedulingConfig.upsertService, { organizationId: org, ...service(over) } as any);

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-06-12T15:00:00Z"));
  t = convexTest(schema, modules);
  s = await seedAgenda(t);
});
afterEach(() => vi.useRealTimers());

const audits = (entityType: string) =>
  t.run(async (ctx) =>
    (await ctx.db.query("auditLogs").withIndex("by_organization", (q) => q.eq("organizationId", s.orgId)).collect()).filter(
      (l) => l.entityType === entityType
    )
  );
const count = (table: "schedServices" | "schedResources") =>
  t.run(async (ctx) => (await ctx.db.query(table).withIndex("by_organization", (q) => q.eq("organizationId", s.orgId)).collect()).length);

describe("permissão e módulo", () => {
  test("configuração exige manage: edit, view_all, view_own, none e de outra org são recusados", async () => {
    for (const p of [s.manager, s.agent, s.viewAll, s.viewOwn, s.none]) {
      await expect(mkService(p)).rejects.toThrow(/Permissão insuficiente/);
      await expect(mkResource(p)).rejects.toThrow(/Permissão insuficiente/);
      await expect(
        as(p).mutation(api.schedulingConfig.updateSettings, { organizationId: s.orgId, patch: { gridMinutes: 15 } })
      ).rejects.toThrow(/Permissão insuficiente/);
    }
    await expect(mkService(s.outsider)).rejects.toThrow(/Not authorized/);
    expect(await count("schedServices")).toBe(0);
  });

  test("módulo desligado: mutations recusam e getConfig devolve vazio", async () => {
    await t.run(async (ctx) => {
      const org = (await ctx.db.get(s.orgId))!;
      await ctx.db.patch(s.orgId, { settings: { ...org.settings, modules: { scheduling: false } } });
    });
    await expect(mkService(s.admin)).rejects.toThrow(/Módulo não habilitado: Agendamento/);
    await expect(mkResource(s.admin)).rejects.toThrow(/Módulo não habilitado/);
    await expect(
      as(s.admin).mutation(api.schedulingConfig.updateSettings, { organizationId: s.orgId, patch: { gridMinutes: 15 } })
    ).rejects.toThrow(/Módulo não habilitado/);
    await expect(as(s.admin).mutation(api.schedulingConfig.applyTemplate, { organizationId: s.orgId, templateKey: "solo" })).rejects.toThrow(
      /Módulo não habilitado/
    );
    const cfg = await as(s.admin).query(api.schedulingConfig.getConfig, { organizationId: s.orgId, closuresFrom: "2026-01-01" });
    expect(cfg).toMatchObject({ enabled: false, services: [], resources: [], closures: [] });
    assertMatchesReturns(cfg, config.getConfig);
  });

  test("queries: none e outra org recebem null/vazio, nunca erro", async () => {
    await mkService(s.admin, {});
    for (const p of [s.none, s.outsider]) {
      expect(await as(p).query(api.schedulingConfig.getConfig, { organizationId: s.orgId, closuresFrom: "2026-01-01" })).toBeNull();
      expect(await as(p).query(api.schedulingConfig.previewTemplate, { organizationId: s.orgId, templateKey: "solo" })).toBeNull();
    }
    const out = await as(s.manager).query(api.schedulingConfig.previewTemplate, { organizationId: s.orgId, templateKey: "solo" });
    expect(out).toBeNull(); // manager é edit, não manage
    expect(await t.query(api.schedulingConfig.getConfig, { organizationId: s.orgId, closuresFrom: "2026-01-01" })).toBeNull();
  });

  test("getConfig: view_own lê serviços e recursos, mas sem IA/automação; manage vê tudo", async () => {
    await mkService(s.admin);
    const own = await as(s.viewOwn).query(api.schedulingConfig.getConfig, { organizationId: s.orgId, closuresFrom: "2026-01-01" });
    expect(own!.services).toHaveLength(1);
    expect(own!.settings.ai).toBeUndefined();
    expect(own!.settings.humanConfirm).toBeUndefined();
    expect(own!.canManage).toBe(false);
    const adm = await as(s.admin).query(api.schedulingConfig.getConfig, { organizationId: s.orgId, closuresFrom: "2026-01-01" });
    expect(adm!.settings.ai).toMatchObject({ book: "propose", cancel: "handoff" });
    expect(adm!.timezone).toBe("America/Sao_Paulo");
    assertMatchesReturns(own, config.getConfig);
    assertMatchesReturns(adm, config.getConfig);
  });
});

describe("serviços", () => {
  test("cria, edita por MERGE (ausente mantém, null limpa), audita antes/depois", async () => {
    const id = await mkService(s.admin, { bufferAfterMin: 10, minNoticeMin: 60, priceCents: 5000 });
    assertMatchesReturns(id, config.upsertService);
    // cliente antigo/REST mandando só parte dos campos: o resto fica
    const edited = await as(s.admin).mutation(api.schedulingConfig.upsertService, { organizationId: s.orgId, serviceId: id, durationMin: 45 });
    expect(edited).toBe(id);
    let doc = await t.run((ctx) => ctx.db.get(id));
    expect(doc).toMatchObject({ name: "Sessão", durationMin: 45, bufferAfterMin: 10, minNoticeMin: 60, priceCents: 5000, active: true });
    expect(doc!.requirements).toHaveLength(1);
    // null limpa
    await as(s.admin).mutation(api.schedulingConfig.upsertService, { organizationId: s.orgId, serviceId: id, minNoticeMin: null, bufferAfterMin: null });
    doc = await t.run((ctx) => ctx.db.get(id));
    expect(doc!.minNoticeMin).toBeUndefined();
    expect(doc!.bufferAfterMin).toBe(0);
    expect(doc!.priceCents).toBe(5000);
    const logs = await audits("schedService");
    expect(logs.map((l) => l.action).sort()).toEqual(["create", "update", "update"]);
    const upd = logs.find((l) => l.action === "update" && l.changes?.after?.durationMin === 45 && l.changes?.before?.durationMin === 60);
    expect(upd?.changes?.after?.id).toBe(id);
    // criação sem os obrigatórios é recusada
    await expect(as(s.admin).mutation(api.schedulingConfig.upsertService, { organizationId: s.orgId, name: "X" })).rejects.toThrow(/duração é obrigatória/);
    await expect(as(s.admin).mutation(api.schedulingConfig.upsertService, { organizationId: s.orgId, name: "X", durationMin: 30 })).rejects.toThrow(/requisitos/);
  });

  test("duração + folgas ≤ MAX_BLOCK_MIN (base e cada variação), nome único sem acento, requisitos 1..4", async () => {
    await expect(mkService(s.admin, { durationMin: 470, bufferAfterMin: 20 })).rejects.toThrow(/passa de 480/);
    await expect(
      mkService(s.admin, { durationMin: 60, bufferAfterMin: 30, variants: [{ key: "longa", name: "Longa", durationMin: 460 }] })
    ).rejects.toThrow(/Longa.*passa de 480/);
    await expect(mkService(s.admin, { durationMin: 4 })).rejects.toThrow(/inteiro entre 5 e 480/);
    await expect(mkService(s.admin, { requirements: [] })).rejects.toThrow(/1 a 4 requisitos/);
    await expect(
      mkService(s.admin, {
        requirements: [1, 2, 3, 4, 5].map((n) => ({ role: `P${n}`, kind: "person" as const })),
      })
    ).rejects.toThrow(/1 a 4 requisitos/);
    await mkService(s.admin, { name: "Avaliação" });
    await expect(mkService(s.admin, { name: "  avaliacao " })).rejects.toThrow(/Já existe um serviço/);
    await expect(mkService(s.admin, { name: "A".repeat(61) })).rejects.toThrow(/no máximo 60/);
    expect(await count("schedServices")).toBe(1);
  });

  test("teto de serviços por org (arquivados contam)", async () => {
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_SERVICES_PER_ORG; i++) {
        await ctx.db.insert("schedServices", {
          organizationId: s.orgId, name: `S${i}`, durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: [],
          sortOrder: i, active: i % 2 === 0, createdAt: 1, updatedAt: 1,
        });
      }
    });
    await expect(mkService(s.admin, { name: "Mais um" })).rejects.toThrow(/já tem 100 serviços/);
  });

  test("requisito aponta só para recurso da MESMA org, do tipo certo e ativo", async () => {
    const mine = await mkResource(s.admin, { name: "Sala A" });
    const foreign = await mkResource(s.outsider, { name: "Sala B" }, s.otherOrgId);
    await expect(
      mkService(s.admin, { requirements: [{ role: "Sala", kind: "room", resourceIds: [foreign] }] })
    ).rejects.toThrow(/não existe nesta organização/);
    await expect(
      mkService(s.admin, { requirements: [{ role: "Pessoa", kind: "person", resourceIds: [mine] }] })
    ).rejects.toThrow(/não é do tipo exigido/);
    const ok = await mkService(s.admin, { requirements: [{ role: "Sala", kind: "room", resourceIds: [mine] }] });
    await as(s.admin).mutation(api.schedulingConfig.archiveResource, { organizationId: s.orgId, resourceId: mine });
    await expect(
      mkService(s.admin, { name: "Outro", requirements: [{ role: "Sala", kind: "room", resourceIds: [mine] }] })
    ).rejects.toThrow(/está arquivado/);
    // quem já usava o recurso arquivado continua editável
    await expect(
      as(s.admin).mutation(api.schedulingConfig.upsertService, {
        organizationId: s.orgId, serviceId: ok, ...service({ requirements: [{ role: "Sala", kind: "room", resourceIds: [mine] }] }),
      })
    ).resolves.toBe(ok);
  });

  test("outra org não mexe no serviço por id", async () => {
    const id = await mkService(s.admin);
    await expect(
      as(s.outsider).mutation(api.schedulingConfig.upsertService, { organizationId: s.otherOrgId, serviceId: id, ...service() })
    ).rejects.toThrow(/Serviço não encontrado/);
    await expect(
      as(s.outsider).mutation(api.schedulingConfig.archiveService, { organizationId: s.otherOrgId, serviceId: id })
    ).rejects.toThrow(/Serviço não encontrado/);
    await expect(
      as(s.outsider).mutation(api.schedulingConfig.reactivateService, { organizationId: s.otherOrgId, serviceId: id })
    ).rejects.toThrow(/Serviço não encontrado/);
  });

  test("arquivar com agendamento futuro: aviso + aceite; reativar", async () => {
    const id = await mkService(s.admin);
    const future = Date.now() + 86_400_000;
    await t.run(async (ctx) => {
      await ctx.db.insert("schedAppointments", {
        organizationId: s.orgId, serviceId: id, serviceName: "Sessão", kind: "normal", startTime: future, endTime: future + 3_600_000,
        blockStart: future, blockEnd: future + 3_600_000, localDate: "2026-06-13", status: "scheduled", origin: "staff", resources: [],
        statusChangedAt: 1, createdAt: 1, updatedAt: 1,
      });
    });
    const warn = await as(s.admin).mutation(api.schedulingConfig.archiveService, { organizationId: s.orgId, serviceId: id });
    expect(warn).toEqual({ changed: false, futureAppointments: 1, futureAppointmentsCapped: false });
    assertMatchesReturns(warn, config.archiveService);
    expect((await t.run((ctx) => ctx.db.get(id)))!.active).toBe(true);
    const done = await as(s.admin).mutation(api.schedulingConfig.archiveService, { organizationId: s.orgId, serviceId: id, acceptFuture: true });
    expect(done.changed).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(id)))!.active).toBe(false);
    const back = await as(s.admin).mutation(api.schedulingConfig.reactivateService, { organizationId: s.orgId, serviceId: id });
    assertMatchesReturns(back, config.reactivateService);
    expect((await t.run((ctx) => ctx.db.get(id)))!.active).toBe(true);
  });
});

describe("recursos", () => {
  test("capacidade inteira ≥ 1, pessoa = 1, grade válida, tags", async () => {
    await expect(mkResource(s.admin, { capacity: 0 })).rejects.toThrow(/inteiro entre 1 e 50/);
    await expect(mkResource(s.admin, { capacity: 1.5 })).rejects.toThrow(/inteiro entre 1 e 50/);
    await expect(mkResource(s.admin, { capacity: 51 })).rejects.toThrow(/inteiro entre 1 e 50/);
    await expect(mkResource(s.admin, { kind: "person", capacity: 2 })).rejects.toThrow(/capacidade é 1/);
    await expect(mkResource(s.admin, { weekly: [{ weekday: 1, startMin: 600, endMin: 540 }] })).rejects.toThrow(/depois do início/);
    await expect(mkResource(s.admin, { weekly: [{ weekday: 1, startMin: 22 * 60, endMin: 26 * 60 }] })).rejects.toThrow(/00:00 e 24:00/);
    await expect(
      mkResource(s.admin, { weekly: [{ weekday: 1, startMin: 540, endMin: 700 }, { weekday: 1, startMin: 650, endMin: 800 }] })
    ).rejects.toThrow(/não podem se sobrepor/);
    await expect(mkResource(s.admin, { weekly: [{ weekday: 9, startMin: 540, endMin: 600 }] })).rejects.toThrow(/Dia da semana inválido/);
    await expect(mkResource(s.admin, { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).rejects.toThrow(/10 etiquetas/);
    const out = await mkResourceFull(s.admin, { capacity: 2, name: "Sala dupla", tags: ["Dupla", "dupla", " VIP "] });
    assertMatchesReturns(out, config.upsertResource);
    expect(out).toMatchObject({ saved: true, futureOutsideHours: 0, overCapacityBy: 0, capped: false });
    expect((await t.run((ctx) => ctx.db.get(out.resourceId)))!.tags).toEqual(["dupla", "vip"]);
    // merge: só o nome muda; as tags ficam; null limpa
    await as(s.admin).mutation(api.schedulingConfig.upsertResource, { organizationId: s.orgId, resourceId: out.resourceId, name: "Dupla" });
    expect(await t.run((ctx) => ctx.db.get(out.resourceId))).toMatchObject({ name: "Dupla", capacity: 2, tags: ["dupla", "vip"] });
    await as(s.admin).mutation(api.schedulingConfig.upsertResource, { organizationId: s.orgId, resourceId: out.resourceId, tags: null });
    expect((await t.run((ctx) => ctx.db.get(out.resourceId)))!.tags).toBeUndefined();
    await expect(as(s.admin).mutation(api.schedulingConfig.upsertResource, { organizationId: s.orgId, name: "Sem tipo" })).rejects.toThrow(/tipo do recurso é obrigatório/);
    expect(await count("schedResources")).toBe(1);
  });

  test("teamMemberId: só pessoa, só da org, único por membro, tipo imutável", async () => {
    await expect(mkResource(s.admin, { kind: "room", teamMemberId: s.agent.memberId })).rejects.toThrow(/Só um profissional/);
    await expect(mkResource(s.admin, { ...person(), teamMemberId: s.outsider.memberId })).rejects.toThrow(/Responsável não encontrado/);
    const id = await mkResource(s.admin, { ...person({ name: "Ana" }), kind: "person", teamMemberId: s.agent.memberId });
    await expect(mkResource(s.admin, { ...person({ name: "Bia" }), teamMemberId: s.agent.memberId })).rejects.toThrow(/já está ligado a "Ana"/);
    await expect(
      as(s.admin).mutation(api.schedulingConfig.upsertResource, { organizationId: s.orgId, resourceId: id, kind: "room" })
    ).rejects.toThrow(/tipo do recurso não pode mudar/);
    // membro removido não recebe vínculo novo
    await t.run((ctx) => ctx.db.patch(s.viewAll.memberId, { removedAt: Date.now() }));
    await expect(mkResource(s.admin, { ...person({ name: "Caio" }), teamMemberId: s.viewAll.memberId })).rejects.toThrow(/removido/);
  });

  test("nome único por org e teto de recursos (arquivados contam)", async () => {
    await mkResource(s.admin, { name: "Sala Única" });
    await expect(mkResource(s.admin, { name: "sala unica" })).rejects.toThrow(/Já existe um recurso/);
    await t.run(async (ctx) => {
      for (let i = 0; i < MAX_RESOURCES_PER_ORG - 1; i++) {
        await ctx.db.insert("schedResources", {
          organizationId: s.orgId, kind: "room", name: `R${i}`, capacity: 1, weekly: [], sortOrder: i, active: i % 2 === 0, createdAt: 1, updatedAt: 1,
        });
      }
    });
    await expect(mkResource(s.admin, { name: "R-extra" })).rejects.toThrow(/já tem 100/);
  });

  test("outra org: id de recurso e membro alheios recusados", async () => {
    const mine = await mkResource(s.admin);
    await expect(
      as(s.outsider).mutation(api.schedulingConfig.upsertResource, { organizationId: s.otherOrgId, resourceId: mine, ...room() })
    ).rejects.toThrow(/Recurso não encontrado/);
    await expect(
      as(s.outsider).mutation(api.schedulingConfig.archiveResource, { organizationId: s.otherOrgId, resourceId: mine })
    ).rejects.toThrow(/Recurso não encontrado/);
    await expect(
      as(s.outsider).mutation(api.schedulingConfig.reactivateResource, { organizationId: s.otherOrgId, resourceId: mine })
    ).rejects.toThrow(/Recurso não encontrado/);
  });

  test("reduzir capacidade/horário com agendamento futuro: aviso + aceite (nada é cancelado); arquivar pede aceite", async () => {
    const id = await mkResource(s.admin, { name: "Sala dupla", capacity: 2 });
    const start = at10(Date.now() + 3_600_000);
    const apptIds: Id<"schedAppointments">[] = [];
    await t.run(async (ctx) => {
      const svc = await ctx.db.insert("schedServices", {
        organizationId: s.orgId, name: "X", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: [], sortOrder: 0, active: true, createdAt: 1, updatedAt: 1,
      });
      for (let i = 0; i < 2; i++) {
        const appointmentId = await ctx.db.insert("schedAppointments", {
          organizationId: s.orgId, serviceId: svc, serviceName: "X", kind: "normal", startTime: start, endTime: start + 3_600_000,
          blockStart: start, blockEnd: start + 3_600_000, localDate: "2026-06-12", status: "scheduled", origin: "staff",
          resources: [{ resourceId: id, role: "Sala", name: "Sala dupla", allocated: true }], statusChangedAt: 1, createdAt: 1, updatedAt: 1,
        });
        apptIds.push(appointmentId);
        await ctx.db.insert("schedAllocations", {
          organizationId: s.orgId, appointmentId, resourceId: id, role: "Sala", blockStart: start, blockEnd: start + 3_600_000,
          coreStart: start, coreEnd: start + 3_600_000, units: 1,
        });
      }
    });
    const up = (extra: Record<string, unknown>) =>
      as(s.admin).mutation(api.schedulingConfig.upsertResource, { organizationId: s.orgId, resourceId: id, ...extra } as any);
    const warn = await up({ capacity: 1 });
    assertMatchesReturns(warn, config.upsertResource);
    expect(warn).toMatchObject({ saved: false, overCapacityBy: 1, futureOutsideHours: 0, futureWithoutSpot: 1 });
    expect((await t.run((ctx) => ctx.db.get(id)))!.capacity).toBe(2);
    // horário semanal sem sexta (2026-06-12): os 2 futuros ficam fora do novo horário
    const week = await up({ weekly: weekdays([1, 2, 3, 4], [540, 720]) });
    expect(week).toMatchObject({ saved: false, futureOutsideHours: 2 });
    const done = await up({ capacity: 1, weekly: weekdays([1, 2, 3, 4], [540, 720]), acceptFuture: true });
    assertMatchesReturns(done, config.upsertResource);
    expect(done).toMatchObject({ saved: true, futureOutsideHours: 2, overCapacityBy: 1, futureWithoutSpot: 1 });
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ capacity: 1 });
    // nada foi cancelado; o excedente (o mais novo) perdeu a vaga e está na fila "sem lugar" (A3e)
    for (const a of apptIds) expect((await t.run((ctx) => ctx.db.get(a)))!.status).toBe("scheduled");
    const confl = await t.run((ctx) => ctx.db.query("schedConflicts").collect());
    expect(confl.map((c) => [c.appointmentId, c.kind, c.status])).toEqual([[apptIds[1], "capacity", "open"]]);
    expect(await schedInvariantProblems(t, s.orgId, Date.now())).toEqual([]);
    // mudar só o nome não avisa nada
    expect(await up({ name: "Renomeada" })).toMatchObject({ saved: true });
    const archWarn = await as(s.admin).mutation(api.schedulingConfig.archiveResource, { organizationId: s.orgId, resourceId: id });
    expect(archWarn).toMatchObject({ changed: false, futureAppointments: 1 }); // só o que manteve a vaga (o excedente já está na fila)
    assertMatchesReturns(archWarn, config.archiveResource);
    const arch = await as(s.admin).mutation(api.schedulingConfig.archiveResource, { organizationId: s.orgId, resourceId: id, acceptFuture: true });
    expect(arch.changed).toBe(true);
    const back = await as(s.admin).mutation(api.schedulingConfig.reactivateResource, { organizationId: s.orgId, resourceId: id });
    assertMatchesReturns(back, config.reactivateResource);
    expect(back.changed).toBe(true);
    expect((await audits("schedResource")).length).toBe(5); // create + 2 edições gravadas + arquivar + reativar
  });

  test("overlap de horário só conta o que de fato sai do horário (dentro do novo horário não avisa)", async () => {
    const id = await mkResource(s.admin, { name: "Sala X", capacity: 1 });
    const start = at10(Date.now() + 3_600_000); // sexta 2026-06-12 ~16:00Z = 13:00 local, fora do expediente atual (09-12), mas já marcado
    await t.run(async (ctx) => {
      const svc = await ctx.db.insert("schedServices", { organizationId: s.orgId, name: "X", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0, requirements: [], sortOrder: 0, active: true, createdAt: 1, updatedAt: 1 });
      const appointmentId = await ctx.db.insert("schedAppointments", {
        organizationId: s.orgId, serviceId: svc, serviceName: "X", kind: "normal", startTime: start, endTime: start + 3_600_000, blockStart: start, blockEnd: start + 3_600_000,
        localDate: "2026-06-12", status: "scheduled", origin: "staff", resources: [], statusChangedAt: 1, createdAt: 1, updatedAt: 1,
      });
      await ctx.db.insert("schedAllocations", { organizationId: s.orgId, appointmentId, resourceId: id, role: "Sala", blockStart: start, blockEnd: start + 3_600_000, coreStart: start, coreEnd: start + 3_600_000, units: 1 });
    });
    const covers = await as(s.admin).mutation(api.schedulingConfig.upsertResource, { organizationId: s.orgId, resourceId: id, weekly: weekdays([5], [0, 1440]) });
    expect(covers).toMatchObject({ saved: true, futureOutsideHours: 0 });
  });
});

describe("configurações (schedSettings)", () => {
  const upd = (p: Person, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    as(p).mutation(api.schedulingConfig.updateSettings, { organizationId: s.orgId, patch, ...extra } as any);
  const cfg = async () => (await as(s.admin).query(api.schedulingConfig.getConfig, { organizationId: s.orgId, closuresFrom: "2026-01-01" }))!.settings;

  test("grade, modo inteligente, pesos, fuso herdado; merge parcial e null limpa", async () => {
    const ret = await upd(s.admin, { gridMinutes: 15, smart: { mode: "restrict", minOffer: 2 }, minNoticeMin: 30 });
    expect(ret).toBeNull();
    assertMatchesReturns(ret, config.updateSettings);
    let c = await cfg();
    expect(c).toMatchObject({ gridMinutes: 15, minNoticeMin: 30, smart: { mode: "restrict", minOffer: 2 } });
    await upd(s.admin, { smart: { weights: { adjacency: 1, deadGap: 2, openNewResource: 3, earlyFirst: 4, balance: 5, preference: 6 }, minUsefulGapMin: 45 } });
    c = await cfg();
    expect(c.smart).toMatchObject({ mode: "restrict", minUsefulGapMin: 45, weights: { adjacency: 1, preference: 6 } });
    await upd(s.admin, { smart: { weights: null, minUsefulGapMin: null } });
    c = await cfg();
    expect(c.smart.weights).toMatchObject({ adjacency: 40, deadGap: 50 });
    expect(c.smart.minUsefulGapMin).toBeUndefined();
    const logs = await audits("schedSettings");
    expect(logs.length).toBe(3);
    expect(logs[0].severity).toBe("low");
    // sem `schedSettings.timezone`: o fuso é o da org
    const doc = await t.run((ctx) => ctx.db.query("schedSettings").first());
    expect(doc && "timezone" in doc).toBe(false);
  });

  test("valida grade, pesos, antecedência e referências de outra org", async () => {
    await expect(upd(s.admin, { gridMinutes: 7 })).rejects.toThrow(/passo da grade/);
    await expect(upd(s.admin, { smart: { weights: { adjacency: -1, deadGap: 0, openNewResource: 0, earlyFirst: 0, balance: 0, preference: 0 } } })).rejects.toThrow(/peso/);
    await expect(upd(s.admin, { minNoticeMin: -5 })).rejects.toThrow(/inteiro entre 0 e 43200/);
    await expect(upd(s.admin, { maxAdvanceDays: 0 })).rejects.toThrow(/inteiro entre 1 e 730/);
    const foreignSvc = await mkService(s.outsider, {}, s.otherOrgId);
    await expect(upd(s.admin, { humanConfirm: { defaultServiceId: foreignSvc } })).rejects.toThrow(/serviço padrão não existe/);
    await expect(upd(s.admin, { funnel: { onScheduledStageId: s.otherFunnel.stageId } })).rejects.toThrow(/etapas do funil/);
    await expect(upd(s.admin, { funnel: { onNoShowStageId: s.funnel.lostStageId } })).rejects.toThrow(/etapa de perda/);
    const mine = await mkService(s.admin, {});
    await upd(s.admin, { humanConfirm: { mode: "suggest", defaultServiceId: mine }, funnel: { onScheduledStageId: s.funnel.stageId } });
    expect(await cfg()).toMatchObject({ humanConfirm: { mode: "suggest", defaultServiceId: mine }, funnel: { onScheduledStageId: s.funnel.stageId } });
    await upd(s.admin, { humanConfirm: { defaultServiceId: null } });
    expect((await cfg()).humanConfirm!.defaultServiceId).toBeUndefined();
    await as(s.admin).mutation(api.schedulingConfig.archiveService, { organizationId: s.orgId, serviceId: mine });
    await expect(upd(s.admin, { humanConfirm: { defaultServiceId: mine } })).rejects.toThrow(/arquivado/);
  });

  test("'marca sozinha' só com o aceite: exige conta com e-mail, audita como high e revogar rebaixa", async () => {
    await expect(upd(s.admin, { ai: { book: "auto" } })).rejects.toThrow(/confirmar o aviso/);
    await expect(upd(s.admin, { ai: { cancel: "auto" } })).rejects.toThrow(/confirmar o aviso/);
    // conta sem e-mail (sessão anônima antiga) não aceita
    await t.run((ctx) => ctx.db.patch(s.admin.userId, { email: undefined }));
    await expect(upd(s.admin, { ai: { book: "auto" } }, { aiAutoAck: true })).rejects.toThrow(/conta com e-mail/);
    await t.run((ctx) => ctx.db.patch(s.admin.userId, { email: "admin@teste.dev" }));
    await upd(s.admin, { ai: { book: "auto", reschedule: "auto" } }, { aiAutoAck: true });
    let c = await cfg();
    expect(c.ai).toMatchObject({ book: "auto", reschedule: "auto" });
    expect(c.ai!.autoAck).toMatchObject({ by: s.admin.memberId });
    const high = (await audits("schedSettings")).filter((l) => l.severity === "high");
    expect(high).toHaveLength(1);
    // com o aceite gravado, mudar outra coisa não pede de novo
    await upd(s.admin, { ai: { cancel: "auto" } });
    await expect(upd(s.admin, { ai: { book: "auto" } }, { aiAutoAck: false })).rejects.toThrow(/ao mesmo tempo/);
    await upd(s.admin, {}, { aiAutoAck: false });
    c = await cfg();
    expect(c.ai).toMatchObject({ book: "propose", reschedule: "propose", cancel: "handoff" });
    expect(c.ai!.autoAck).toBeUndefined();
    expect((await audits("schedSettings")).filter((l) => l.severity === "high")).toHaveLength(2);
  });

  test("juiz de afirmação (interruptor por org): ausente = ligado na leitura; a tela grava false e true; a leitura devolve o valor (e confere o validator)", async () => {
    expect((await cfg()).ai!.claimJudge).toBe(true);
    await upd(s.admin, { ai: { claimJudge: false } });
    const off = await cfg();
    expect(off.ai!.claimJudge).toBe(false);
    assertMatchesValidator(off, settingsViewValidator);
    await upd(s.admin, { ai: { claimJudge: true } });
    expect((await cfg()).ai!.claimJudge).toBe(true);
    const doc = await t.run((ctx) => ctx.db.query("schedSettings").first());
    expect(doc?.ai?.claimJudge).toBe(true);
  });
});

describe("modelos prontos", () => {
  const humans = async () => {
    // a clínica do plano: 4 profissionais = 4 membros humanos
    await t.run(async (ctx) => {
      await ctx.db.patch(s.none.memberId, { removedAt: Date.now() }); // removido não vira profissional
    });
  };
  const apply = (p: Person, templateKey: string, draft?: unknown) =>
    as(p).mutation(api.schedulingConfig.applyTemplate, { organizationId: s.orgId, templateKey, ...(draft ? { draft } : {}) } as any);
  const state = () =>
    t.run(async (ctx) => ({
      resources: await ctx.db.query("schedResources").withIndex("by_organization", (q) => q.eq("organizationId", s.orgId)).collect(),
      services: await ctx.db.query("schedServices").withIndex("by_organization", (q) => q.eq("organizationId", s.orgId)).collect(),
      settings: await ctx.db.query("schedSettings").withIndex("by_organization", (q) => q.eq("organizationId", s.orgId)).first(),
    }));

  test("clínica: 3 salas (uma dupla) + 1 pessoa por membro humano ativo, serviços e horários; auditado", async () => {
    await humans();
    const r = await apply(s.admin, "clinic");
    assertMatchesReturns(r, config.applyTemplate);
    expect(r.applied).toBe(true);
    const st = await state();
    const rooms = st.resources.filter((x) => x.kind === "room");
    expect(rooms.map((x) => [x.name, x.capacity])).toEqual([["Sala 1", 1], ["Sala 2", 1], ["Sala dupla", 2]]);
    const people = st.resources.filter((x) => x.kind === "person");
    expect(people).toHaveLength(5); // admin, gerente, atendente, leitor geral, leitor próprio (o sem-agenda foi removido)
    expect(people.every((p) => p.teamMemberId !== undefined && p.capacity === 1)).toBe(true);
    expect(rooms[0].weekly).toHaveLength(5 * 2 + 1); // seg-sex 09-12 e 14-18; sáb 09-12
    expect(st.services.map((x) => [x.name, x.durationMin])).toEqual([["Sessão", 60], ["Avaliação", 45]]);
    expect(st.services[0].requirements.map((q) => q.kind)).toEqual(["room", "person"]);
    expect(st.settings).toMatchObject({ templateKey: "clinic", gridMinutes: 30, smart: { mode: "rank" } });
    const logs = await audits("schedSettings");
    expect(logs.some((l) => l.description?.includes('modelo "clinic"'))).toBe(true);
    assertMatchesReturns(await as(s.admin).query(api.schedulingConfig.getConfig, { organizationId: s.orgId, closuresFrom: "2026-01-01" }), config.getConfig);
  });

  test("idempotente: segunda aplicação não duplica; outro modelo ou agenda não vazia é recusado", async () => {
    await apply(s.admin, "solo");
    const before = await state();
    const again = await apply(s.admin, "solo");
    expect(again).toEqual({ applied: false, resourceIds: [], serviceIds: [] });
    const after = await state();
    expect(after.resources.length).toBe(before.resources.length);
    expect(after.services.length).toBe(before.services.length);
    await expect(apply(s.admin, "barber")).rejects.toThrow(/agenda vazia/);
    await expect(apply(s.admin, "inexistente")).rejects.toThrow(/Modelo desconhecido/);
  });

  test("cada modelo cria o esperado", async () => {
    const expected: Record<string, { people: number; services: string[]; grid: number; minNotice?: number }> = {
      solo: { people: 1, services: ["Atendimento"], grid: 60 },
      barber: { people: 5, services: ["Corte", "Barba", "Corte e barba"], grid: 30 },
      consulting: { people: 1, services: ["Reunião", "Diagnóstico"], grid: 30, minNotice: 1440 },
    };
    await humans();
    for (const [key, exp] of Object.entries(expected)) {
      t = convexTest(schema, modules);
      s = await seedAgenda(t);
      await humans();
      await apply(s.admin, key);
      const st = await state();
      expect(st.resources.filter((x) => x.kind === "person")).toHaveLength(exp.people);
      expect(st.services.map((x) => x.name)).toEqual(exp.services);
      expect(st.settings!.gridMinutes).toBe(exp.grid);
      expect(st.settings!.minNoticeMin).toBe(exp.minNotice);
    }
  });

  test("solo usa quem configura; folga de 10 min no serviço", async () => {
    await apply(s.manager, "solo").catch(() => undefined); // manager não é manage
    expect((await state()).resources).toHaveLength(0);
    await apply(s.admin, "solo");
    const st = await state();
    expect(st.resources).toHaveLength(1);
    expect(st.resources[0].teamMemberId).toBe(s.admin.memberId);
    expect(st.services[0]).toMatchObject({ durationMin: 50, bufferAfterMin: 10 });
  });

  test("rascunho editado vale; rascunho com membro de outra org ou inválido é recusado e nada é gravado", async () => {
    const draft = await as(s.admin).query(api.schedulingConfig.previewTemplate, { organizationId: s.orgId, templateKey: "solo" });
    assertMatchesReturns(draft, config.previewTemplate);
    expect(draft!.resources).toHaveLength(1);
    const evil = { ...draft!, resources: [{ ...draft!.resources[0], teamMemberId: s.outsider.memberId }] };
    await expect(apply(s.admin, "solo", evil)).rejects.toThrow(/Responsável não encontrado/);
    const dup = { ...draft!, services: [draft!.services[0], draft!.services[0]] };
    await expect(apply(s.admin, "solo", dup)).rejects.toThrow(/Já existe um serviço/);
    const st0 = await state();
    expect(st0.resources).toHaveLength(0);
    expect(st0.services).toHaveLength(0);
    expect(st0.settings).toBeNull();
    const edited = { ...draft!, services: [{ ...draft!.services[0], name: "Consulta", durationMin: 40 }] };
    await apply(s.admin, "solo", edited);
    expect((await state()).services.map((x) => x.name)).toEqual(["Consulta"]);
  });
});

describe("fuso da organização", () => {
  const changeTz = (tz: string) =>
    as(s.admin).mutation(api.organizations.updateOrganization, {
      organizationId: s.orgId,
      settings: { timezone: tz, currency: "BRL" },
    });

  test("trocar o fuso com agendamento futuro é recusado; sem agendamento futuro (ou mesmo fuso) passa", async () => {
    const svc = await mkService(s.admin);
    await changeTz("America/Sao_Paulo"); // mesmo fuso: não consulta nada
    const future = Date.now() + 86_400_000;
    const apptId = await t.run((ctx) =>
      ctx.db.insert("schedAppointments", {
        organizationId: s.orgId, serviceId: svc, serviceName: "Sessão", kind: "normal", startTime: future, endTime: future + 3_600_000,
        blockStart: future, blockEnd: future + 3_600_000, localDate: "2026-06-13", status: "confirmed", origin: "staff", resources: [],
        statusChangedAt: 1, createdAt: 1, updatedAt: 1,
      })
    );
    await expect(changeTz("America/New_York")).rejects.toThrow(/agendamentos futuros/);
    expect((await t.run((ctx) => ctx.db.get(s.orgId)))!.settings.timezone).toBe("America/Sao_Paulo");
    // cancelado não conta
    await t.run((ctx) => ctx.db.patch(apptId, { status: "cancelled" }));
    await changeTz("America/New_York");
    expect((await t.run((ctx) => ctx.db.get(s.orgId)))!.settings.timezone).toBe("America/New_York");
  });
});

describe("fuso pelo onboarding", () => {
  test("completeWizard também recusa trocar o fuso com agendamento futuro", async () => {
    const svc = await mkService(s.admin);
    const future = Date.now() + 86_400_000;
    await t.run(async (ctx) => {
      await ctx.db.insert("schedAppointments", {
        organizationId: s.orgId, serviceId: svc, serviceName: "Sessão", kind: "normal", startTime: future, endTime: future + 3_600_000,
        blockStart: future, blockEnd: future + 3_600_000, localDate: "2026-06-13", status: "scheduled", origin: "staff", resources: [],
        statusChangedAt: 1, createdAt: 1, updatedAt: 1,
      });
      await ctx.db.insert("onboardingProgress", {
        organizationId: s.orgId, teamMemberId: s.admin.memberId, wizardCompleted: false, wizardCurrentStep: 1,
        wizardData: { timezone: "America/New_York" }, checklistDismissed: false, seenSpotlights: [], celebratedMilestones: [], createdAt: 1, updatedAt: 1,
      });
    });
    await expect(as(s.admin).mutation(api.onboarding.completeWizard, { organizationId: s.orgId })).rejects.toThrow(/agendamentos futuros/);
    expect((await t.run((ctx) => ctx.db.get(s.orgId)))!.settings.timezone).toBe("America/Sao_Paulo");
  });
});

describe("previewSuggestions", () => {
  test("manage vê o efeito do modo; outros níveis recebem vazio", async () => {
    await as(s.admin).mutation(api.schedulingConfig.applyTemplate, { organizationId: s.orgId, templateKey: "solo" });
    const svc = (await t.run((ctx) => ctx.db.query("schedServices").first()))!._id;
    const now = Date.UTC(2026, 5, 12, 15, 0);
    const args = { organizationId: s.orgId, serviceId: svc, localDate: "2026-06-15", now };
    const out = await as(s.admin).query(api.schedulingConfig.previewSuggestions, args);
    assertMatchesReturns(out, config.previewSuggestions);
    expect(out.enabled).toBe(true);
    expect(out.suggestions.length).toBeGreaterThan(0);
    expect(out.suggestions.length).toBeLessThanOrEqual(3);
    expect(out.chronological.map((x) => x.startTime)).toEqual([...out.chronological.map((x) => x.startTime)].sort((a, b) => a - b));
    const off = await as(s.admin).query(api.schedulingConfig.previewSuggestions, { ...args, mode: "off" });
    expect(off.mode).toBe("off");
    for (const p of [s.manager, s.viewOwn, s.none, s.outsider]) {
      const r = await as(p).query(api.schedulingConfig.previewSuggestions, args);
      expect(r).toMatchObject({ enabled: false, suggestions: [] });
      assertMatchesReturns(r, config.previewSuggestions);
    }
  });
});

describe("tipos dos ids de outra org nunca vazam existência", () => {
  test("mensagens iguais para id inexistente e id de outra org", async () => {
    const foreign = await mkResource(s.outsider, { name: "Alheia" }, s.otherOrgId);
    const gone = await mkResource(s.admin, { name: "Apagada" });
    await t.run((ctx) => ctx.db.delete(gone));
    const msg = async (id: Id<"schedResources">) =>
      as(s.admin)
        .mutation(api.schedulingConfig.archiveResource, { organizationId: s.orgId, resourceId: id })
        .then(() => "ok", (e: Error) => e.message);
    expect(await msg(foreign)).toBe(await msg(gone));
  });
});
