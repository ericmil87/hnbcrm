/// <reference types="vite/client" />
/**
 * Agenda v2, PR D1: tools do Atendente que consultam horários e propõem agendamento
 * (`schedulingAi.ts` + `lib/schedAiOps.ts`). Chama as internas como a action do atendente chama. O `convex-test` NÃO
 * valida `returns`: cada retorno passa por `assertMatchesReturns`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, type TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import * as ai from "./schedulingAi";
import { assertMatchesReturns } from "./lib/assertMatchesValidator.test-helper";
import { AI_NOW, aiAt, type AiSeed, customerSpoke, seedAiAgenda } from "./lib/schedAiTestSeed.test-helper";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");

let t: TestConvex<typeof schema>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(AI_NOW);
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
});

type Who = AiSeed["ana"];
const find = async (s: AiSeed, who: Who, args: Record<string, unknown>) => {
  const out = await t.mutation(internal.schedulingAi.internalFindAvailableTimes, {
    organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: who.conversationId, argsJson: JSON.stringify(args),
  });
  assertMatchesReturns(out, ai.internalFindAvailableTimes);
  return out;
};
const book = async (s: AiSeed, who: Who, offer: string, extra: { mode?: "commit" | "preview" } = {}) => {
  const out = await t.mutation(internal.schedulingAi.internalBookOfferedTime, {
    organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: who.conversationId, argsJson: JSON.stringify({ offer }), ...extra,
  });
  assertMatchesReturns(out, ai.internalBookOfferedTime);
  return out;
};
const appointments = () => t.run((ctx) => ctx.db.query("schedAppointments").collect());
const stateOf = (conversationId: Id<"conversations">) =>
  t.run((ctx) => ctx.db.query("schedConversationState").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).first());
const handoffs = () => t.run((ctx) => ctx.db.query("handoffs").collect());

/** O cliente VIU as ofertas: a mensagem que as contém saiu (commit/aprovação grava `shownAt`; aqui direto). */
async function markShownNow(who: Who) {
  await t.run(async (ctx) => {
    const st = await ctx.db.query("schedConversationState").withIndex("by_conversation", (q) => q.eq("conversationId", who.conversationId)).first();
    if (st) await ctx.db.patch(st._id, { offers: st.offers.map((o) => (o.shownAt === undefined ? { ...o, shownAt: Date.now() } : o)) });
  });
}

/** Busca segunda 15/06, a resposta com as ofertas SAI (shownAt) e o cliente "responde" 1 min depois. */
async function offeredAndAnswered(s: AiSeed, who: Who, args: Record<string, unknown> = { service: "Consulta", dateRef: "2026-06-15" }) {
  const out = await find(s, who, args);
  const codes = [...(out.result.resultado ?? "").matchAll(/^(h\d+) — /gm)].map((m) => m[1]);
  vi.setSystemTime(Date.now() + 1_000);
  await markShownNow(who);
  vi.setSystemTime(Date.now() + 60_000);
  await customerSpoke(t, who.conversationId, Date.now());
  return { out, codes };
}

describe("findAvailableTimes", () => {
  test("devolve até 3 linhas com código, dia da semana, data e hora por extenso, mais o eco; nada de recurso ou cliente", async () => {
    const s = await seedAiAgenda(t);
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" });
    expect(out.result.status).toBe("ok");
    const lines = (out.result.resultado ?? "").split("\n");
    expect(lines[0]).toBe("Você pediu: seg, 15/06/2026.");
    const offers = lines.filter((l) => /^h\d+ — /.test(l));
    expect(offers.length).toBeGreaterThan(0);
    expect(offers.length).toBeLessThanOrEqual(3);
    for (const l of offers) expect(l).toMatch(/^h\d+ — segunda-feira, 15\/06, às \d{2}:\d{2}$/);
    expect(offers[0]).toMatch(/^h1 — /);
    expect(out.result.ha_mais).toBe("sim");
    const whole = JSON.stringify(out);
    for (const secret of ["Helena", "Sala Rosa", "Ana", "Bia", "score", "reason"]) expect(whole).not.toContain(secret);
    const st = await stateOf(s.ana.conversationId);
    expect(st?.offers.map((o) => o.code)).toEqual(offers.map((l) => l.split(" ")[0]));
    expect(st?.offerSeq).toBe(offers.length);
    expect(out.control.offeredTimes).toHaveLength(offers.length);
  });

  test("período e eco: 'tarde' só devolve horários entre 12:00 e 18:00 e aparece no eco", async () => {
    const s = await seedAiAgenda(t);
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", period: "tarde" });
    expect(out.result.resultado).toContain("Você pediu: seg, 15/06/2026, à tarde.");
    for (const m of (out.result.resultado ?? "").matchAll(/às (\d{2}):\d{2}/g)) expect(Number(m[1])).toBeGreaterThanOrEqual(12);
  });

  test("token relativo vira data no fuso da org (hoje = sexta 12/06)", async () => {
    const s = await seedAiAgenda(t);
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "hoje" });
    expect(out.result.resultado).toContain("Você pediu: sex, 12/06/2026.");
    // 09:00 agora + antecedência de 2 h: o primeiro horário é 11:00 ou depois
    const first = /às (\d{2}):(\d{2})/.exec(out.result.resultado ?? "");
    expect(Number(first![1])).toBeGreaterThanOrEqual(11);
  });

  test("sem horário: diz isso e informa a próxima data com vaga (sem emitir oferta)", async () => {
    const s = await seedAiAgenda(t);
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-14" }); // domingo
    expect(out.result.status).toBe("sem_horarios");
    expect(out.result.resultado).toContain("Não há horário livre");
    expect(out.result.resultado).toContain("A próxima data com horário livre é segunda-feira, 15/06");
    expect(out.result.resultado).not.toMatch(/^h\d+ — /m);
    expect(await stateOf(s.ana.conversationId)).toMatchObject({ offers: [] });
  });

  test("serviço desconhecido ou fora da IA: devolve a lista curta (sem o serviço aiBookable:false)", async () => {
    const s = await seedAiAgenda(t);
    for (const service of ["Cirurgia", "Procedimento interno", "consul"]) {
      const out = await find(s, s.ana, { service, dateRef: "2026-06-15" });
      expect(out.result.error).toBe("servico_desconhecido");
      expect(out.result.proximo_passo).toContain("Consulta; Sessão; Massagem casal");
      expect(out.result.proximo_passo).not.toContain("interno");
    }
    // sem acento e sem caixa casa o nome exato
    const ok = await find(s, s.ana, { service: "  SESSAO ", dateRef: "2026-06-15" });
    expect(ok.result.status).toBe("ok");
  });

  test.each([
    [{ service: "Consulta", dateRef: "ontem" }, "data_invalida"],
    [{ service: "Consulta", dateRef: "2026-06-01" }, "data_invalida"],
    [{ service: "Consulta", dateRef: "2027-12-31" }, "data_invalida"], // além da janela máxima
    [{ service: "Consulta", dateRef: "x".repeat(40) }, "data_invalida"],
    [{ service: "Consulta", dateRef: "hoje", period: "madrugada" }, "periodo_invalido"],
    [{ service: "Consulta", dateRef: "hoje", people: 5 }, "pessoas_invalido"],
    [{ service: "Consulta", dateRef: "hoje", people: 0 }, "pessoas_invalido"],
    [{ service: "Consulta", dateRef: "hoje", people: "2" }, "pessoas_invalido"],
    [{ dateRef: "hoje" }, "servico_desconhecido"],
  ])("argumentos inválidos %j → %s, sem tocar na agenda", async (args, code) => {
    const s = await seedAiAgenda(t);
    const out = await find(s, s.ana, args as Record<string, unknown>);
    expect(out.result.status).toBe("erro");
    expect(out.result.error).toBe(code);
    expect(out.result.proximo_passo).toBeTruthy();
    expect(await appointments()).toHaveLength(0);
  });

  test("lote novo continua a numeração (h4…) e mantém só as 9 últimas", async () => {
    const s = await seedAiAgenda(t);
    for (let i = 0; i < 4; i++) await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" });
    const st = await stateOf(s.ana.conversationId);
    expect(st!.offers.length).toBeLessThanOrEqual(9);
    expect(st!.offerSeq).toBeGreaterThan(9);
    expect(new Set(st!.offers.map((o) => o.code)).size).toBe(st!.offers.length);
  });

  test("grupo de 2 pessoas: só a sala dupla comporta; a oferta lembra e a reserva marca o GRUPO todo, sempre aguardando a equipe", async () => {
    const s = await seedAiAgenda(t);
    const none = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", people: 2 }); // 1 profissional só
    expect(none.result.status).toBe("sem_horarios");
    expect(none.result.resultado).toContain("para 2 pessoas");
    const { out, codes } = await offeredAndAnswered(s, s.ana, { service: "Massagem casal", dateRef: "2026-06-15", people: 2 });
    expect(out.result.status).toBe("ok");
    expect((await stateOf(s.ana.conversationId))!.offers.every((o) => o.people === 2)).toBe(true);
    // o tamanho do grupo vem da OFERTA: a escrita só recebe o código
    const booked = await book(s, s.ana, codes[0]);
    expect(booked.result.status).toBe("reservado_aguardando_equipe");
    expect(booked.result.resultado).toContain("para 2 pessoas");
    expect(booked.control.handoff).toBe(false);
    const rows = await appointments();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "pending_approval")).toBe(true);
    expect(new Set(rows.map((r) => r.partyKey)).size).toBe(1);
    expect(rows.filter((r) => r.contactId === s.ana.contactId)).toHaveLength(1);
    expect(rows.filter((r) => r.guestName !== undefined)).toHaveLength(1);
    expect(rows.every((r) => r.startTime === rows[0].startTime)).toBe(true);
    // a auditoria de cada agendamento aponta a conversa e o código da oferta (a porta de grupo repassa o metadata)
    const audits = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    expect(audits.filter((a) => a.metadata?.offer === codes[0] && a.metadata?.people === 2).length).toBeGreaterThanOrEqual(2);
    expect(await handoffs()).toHaveLength(0);
    expect((await stateOf(s.ana.conversationId))!.offers.some((o) => o.code === codes[0])).toBe(false);
  });

  test("grupo: sala dupla com UMA vaga só não aceita o grupo de 2 (capacidade): horário tomado, sem agendamento nem repasse", async () => {
    const s = await seedAiAgenda(t);
    const { codes } = await offeredAndAnswered(s, s.ana, { service: "Massagem casal", dateRef: "2026-06-15", people: 2 });
    const state = await stateOf(s.ana.conversationId);
    const picked = state!.offers.find((o) => o.code === codes[0])!;
    // outra pessoa ocupa 1 das 2 vagas da sala dupla no MESMO horário (reserva da equipe, direto pela porta)
    await t.run(async (ctx) => {
      const { bookAppointmentCore } = await import("./lib/schedBookingOps");
      const admin = (await ctx.db.get(s.adminId))!;
      const r = await bookAppointmentCore(ctx, {
        organizationId: s.organizationId,
        actor: { type: "human", member: admin, via: "app" },
        origin: "staff",
        serviceId: s.services.casal,
        startTime: picked.startTime,
        contactId: s.bia.contactId,
        resourceIds: picked.resourceIds,
        now: Date.now(),
      });
      expect(r.ok).toBe(true);
    });
    const before = await appointments();
    const booked = await book(s, s.ana, codes[0]);
    expect(booked.result.error).toBe("horario_tomado");
    expect(booked.result.resultado).toContain("Não há alternativa livre para o grupo de 2 pessoas");
    expect(booked.control.handoff).toBe(false);
    expect(await appointments()).toHaveLength(before.length); // nada ficou pela metade
    expect(await handoffs()).toHaveLength(0);
  });

  test("teto de consultas por hora: a 13ª vira repasse; passada a hora, volta a consultar", async () => {
    const s = await seedAiAgenda(t);
    for (let i = 0; i < 12; i++) expect((await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" })).result.status).toBe("ok");
    const blocked = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" });
    expect(blocked.result.error).toBe("limite_de_consultas");
    expect(blocked.control.handoff).toBe(true);
    expect(await handoffs()).toHaveLength(1);
    vi.setSystemTime(Date.now() + 61 * 60_000);
    expect((await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-16" })).result.status).toBe("ok");
  });
});

describe("tools ausentes quando a org não permite (executor reconfere)", () => {
  const cases: Array<[string, Parameters<typeof seedAiAgenda>[1], "null" | "sem tools"]> = [
    ["módulo desligado", { scheduling: false }, "null"],
    ["IA da org desligada", { aiEnabled: false }, "sem tools"],
    ["ai.consult desligado", { ai: { consult: false } }, "sem tools"],
    ["sem serviço liberado", { noService: true }, "sem tools"],
    ["sem recurso ativo", { noResource: true }, "sem tools"],
    ["contato 'não é cliente'", { relation: "personal" }, "sem tools"],
  ];
  test.each(cases)("%s: sem as tools (módulo desligado = contexto nulo; com o módulo o contexto só alimenta o guard) e find/book recusam sem gravar", async (_label, opts, expected) => {
    const s = await seedAiAgenda(t, opts);
    const ctxBlock = await t.query(internal.schedulingAi.internalContextBlock, {
      organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: s.ana.conversationId, now: Date.now(),
    });
    assertMatchesReturns(ctxBlock, ai.internalContextBlock);
    if (expected === "null") expect(ctxBlock).toBeNull();
    else {
      expect(ctxBlock?.tools).toEqual({ find: false, book: false });
      expect(ctxBlock?.services).toEqual([]);
      expect(ctxBlock?.offers).toEqual([]);
    }
    const f = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" });
    expect(f.result.error).toBe("agenda_desligada");
    const b = await book(s, s.ana, "h1");
    expect(b.result.error).toBe("agenda_desligada");
    expect(await appointments()).toHaveLength(0);
    expect(await stateOf(s.ana.conversationId)).toBeNull();
  });

  test("ai.book desligado: consulta existe, reserva não", async () => {
    const s = await seedAiAgenda(t, { ai: { book: "off" } });
    const c = await t.query(internal.schedulingAi.internalContextBlock, {
      organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: s.ana.conversationId, now: Date.now(),
    });
    expect(c?.tools).toEqual({ find: true, book: false });
    const { codes } = await offeredAndAnswered(s, s.ana);
    expect(codes.length).toBeGreaterThan(0);
    expect((await book(s, s.ana, codes[0])).result.error).toBe("agenda_desligada");
    expect(await appointments()).toHaveLength(0);
  });

  test("conversa de outra org / grupo / agente de outra org: recusa", async () => {
    const s = await seedAiAgenda(t);
    const other = await seedAiAgenda(t);
    const out = await find({ ...s, agentId: other.agentId }, s.ana, { service: "Consulta", dateRef: "2026-06-15" });
    expect(out.result.error).toBe("agenda_desligada");
    const cross = await t.mutation(internal.schedulingAi.internalFindAvailableTimes, {
      organizationId: other.organizationId, agentMemberId: other.agentId, conversationId: s.ana.conversationId,
      argsJson: JSON.stringify({ service: "Consulta", dateRef: "2026-06-15" }),
    });
    expect(cross.result.error).toBe("agenda_desligada");
    expect(await stateOf(s.ana.conversationId)).toBeNull();
  });
});

describe("contexto do prompt", () => {
  test("serviços liberados (sem os aiBookable:false), preço só quando cadastrado, próximos horários do contato e política efetiva", async () => {
    const s = await seedAiAgenda(t);
    const c = (await t.query(internal.schedulingAi.internalContextBlock, {
      organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: s.ana.conversationId, now: Date.now(),
    }))!;
    assertMatchesReturns(c, ai.internalContextBlock);
    expect(c.tools).toEqual({ find: true, book: true });
    expect(c.book).toBe("propose");
    expect(c.services).toEqual([
      { name: "Consulta", durationMin: 60, priceLabel: "R$ 150,00" },
      { name: "Sessão", durationMin: 45 },
      { name: "Massagem casal", durationMin: 60 },
    ]);
    expect(c.upcoming).toEqual([]);
    expect(c.offers).toEqual([]);
    expect(c.timezone).toBe("America/Sao_Paulo");
  });

  test("book:auto sem aceite do dono continua propose; com aceite, auto", async () => {
    const noAck = await seedAiAgenda(t, { ai: { book: "auto" } });
    const a = await t.query(internal.schedulingAi.internalContextBlock, {
      organizationId: noAck.organizationId, agentMemberId: noAck.agentId, conversationId: noAck.ana.conversationId, now: Date.now(),
    });
    expect(a?.book).toBe("propose");
    await t.run(async (ctx) => {
      const doc = (await ctx.db.query("schedSettings").first())!;
      await ctx.db.patch(doc._id, { ai: { ...doc.ai, autoAck: { by: noAck.adminId, at: Date.now() } } });
    });
    const b = await t.query(internal.schedulingAi.internalContextBlock, {
      organizationId: noAck.organizationId, agentMemberId: noAck.agentId, conversationId: noAck.ana.conversationId, now: Date.now(),
    });
    expect(b?.book).toBe("auto");
  });

  test("próximos horários do contato com referência curta e situação; contactHas segue o status", async () => {
    const s = await seedAiAgenda(t);
    const { codes } = await offeredAndAnswered(s, s.ana);
    await book(s, s.ana, codes[0]);
    const c = (await t.query(internal.schedulingAi.internalContextBlock, {
      organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: s.ana.conversationId, now: Date.now(),
    }))!;
    expect(c.upcoming).toHaveLength(1);
    expect(c.upcoming[0]).toMatchObject({ ref: "a1", serviceName: "Consulta", status: "pending_approval" });
    expect(c.upcoming[0].label).toMatch(/^segunda-feira, 15\/06, às \d{2}:\d{2}$/);
    expect(c.upcoming[0].startTime).toBeGreaterThan(Date.now());
    // outro contato não vê o horário da Ana
    const bia = (await t.query(internal.schedulingAi.internalContextBlock, {
      organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: s.bia.conversationId, now: Date.now(),
    }))!;
    expect(bia.upcoming).toEqual([]);
  });
});

describe("bookOfferedTime", () => {
  test("padrão propose: registra pending_approval, consome a oferta, audita com a conversa e avisa a equipe", async () => {
    const s = await seedAiAgenda(t);
    const { codes } = await offeredAndAnswered(s, s.ana);
    const out = await book(s, s.ana, codes[0]);
    expect(out.result.status).toBe("reservado_aguardando_equipe");
    expect(out.result.resultado).toMatch(/^Pedido registrado para segunda-feira, 15\/06, às \d{2}:\d{2}, aguardando confirmação da equipe\.$/);
    expect(out.result.proximo_passo).toContain(out.result.resultado!); // a frase canônica que o modelo deve usar
    expect(out.control.booked).toBe("pending");
    const [appt] = await appointments();
    expect(appt).toMatchObject({
      status: "pending_approval", origin: "ai", conversationId: s.ana.conversationId, contactId: s.ana.contactId, leadId: s.ana.leadId,
      idempotencyKey: `ai:${s.ana.conversationId}:${codes[0]}`,
    });
    expect((await stateOf(s.ana.conversationId))!.offers.map((o) => o.code)).not.toContain(codes[0]);

    const audit = await t.run((ctx) => ctx.db.query("auditLogs").collect());
    const create = audit.find((a) => a.entityType === "schedAppointment" && a.action === "create")!;
    expect(create.actorType).toBe("ai");
    expect(create.actorId).toBe(s.agentId);
    expect(create.metadata).toMatchObject({ via: "attendant", conversationId: s.ana.conversationId, offer: codes[0], origin: "ai" });

    const notifs = await t.run((ctx) => ctx.db.query("notifications").collect());
    const pending = notifs.filter((n) => n.type === "appointment_pending_approval");
    expect(pending).toHaveLength(1);
    expect(pending[0].memberId).toBe(s.adminId);
    expect(pending[0].conversationId).toBe(s.ana.conversationId);
    expect(pending[0].data).toMatchObject({ appointmentId: appt._id });
    expect(JSON.stringify(pending[0])).not.toMatch(/5511/);
  });

  test("regra da rodada: reservar sem o cliente ter respondido à oferta é recusado (oferta emitida depois da última mensagem)", async () => {
    const s = await seedAiAgenda(t);
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" }); // sem customerSpoke depois
    expect(out.result.status).toBe("ok");
    const b = await book(s, s.ana, "h1");
    expect(b.result.error).toBe("aguarde_resposta_do_cliente");
    expect(await appointments()).toHaveLength(0);
  });

  test.each(["h9", "h0", "H1;drop", "2026-06-15T10:00", "", "h99999"])("código inventado ou fora da forma (%s) → oferta_desconhecida", async (offer) => {
    const s = await seedAiAgenda(t);
    await offeredAndAnswered(s, s.ana);
    const b = await book(s, s.ana, offer);
    expect(b.result.error).toBe("oferta_desconhecida");
    expect(await appointments()).toHaveLength(0);
  });

  test("a oferta de OUTRA conversa não vale (estado por conversa)", async () => {
    const s = await seedAiAgenda(t);
    const { codes } = await offeredAndAnswered(s, s.ana);
    vi.setSystemTime(Date.now() + 1000);
    await customerSpoke(t, s.bia.conversationId, Date.now());
    const b = await book(s, s.bia, codes[0]);
    expect(b.result.error).toBe("oferta_desconhecida");
    expect(await appointments()).toHaveLength(0);
  });

  test("oferta vence em 30 minutos", async () => {
    const s = await seedAiAgenda(t);
    const { codes } = await offeredAndAnswered(s, s.ana);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const b = await book(s, s.ana, codes[0]);
    expect(b.result.error).toBe("oferta_expirada");
    expect(await appointments()).toHaveLength(0);
  });

  test("retry da mesma reserva devolve o mesmo agendamento (um só)", async () => {
    const s = await seedAiAgenda(t);
    const { codes } = await offeredAndAnswered(s, s.ana);
    const first = await book(s, s.ana, codes[0]);
    const again = await book(s, s.ana, codes[0]);
    expect(first.result.status).toBe("reservado_aguardando_equipe");
    expect(again.result.status).toBe("reservado_aguardando_equipe");
    expect(again.result.resultado).toContain("O pedido já estava registrado");
    expect(await appointments()).toHaveLength(1);
    const notifs = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notifs.filter((n) => n.type === "appointment_pending_approval")).toHaveLength(1);
  });

  test("auto com aceite do dono, não é primeira visita: marcado de fato (scheduled)", async () => {
    const s = await seedAiAgenda(t, { ai: { book: "auto", firstVisitNeedsApproval: false } });
    await t.run(async (ctx) => {
      const doc = (await ctx.db.query("schedSettings").first())!;
      await ctx.db.patch(doc._id, { ai: { ...doc.ai, autoAck: { by: s.adminId, at: Date.now() } } });
    });
    const { codes } = await offeredAndAnswered(s, s.ana);
    const out = await book(s, s.ana, codes[0]);
    expect(out.result.status).toBe("marcado");
    expect(out.control.booked).toBe("scheduled");
    expect((await appointments())[0].status).toBe("scheduled");
    const notifs = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notifs.filter((n) => n.type === "appointment_pending_approval")).toHaveLength(0);
  });

  test("auto com aceite mas primeira visita (padrão): continua aguardando a equipe", async () => {
    const s = await seedAiAgenda(t, { ai: { book: "auto" } });
    await t.run(async (ctx) => {
      const doc = (await ctx.db.query("schedSettings").first())!;
      await ctx.db.patch(doc._id, { ai: { ...doc.ai, autoAck: { by: s.adminId, at: Date.now() } } });
    });
    const { codes } = await offeredAndAnswered(s, s.ana);
    const out = await book(s, s.ana, codes[0]);
    expect(out.result.status).toBe("reservado_aguardando_equipe");
    expect((await appointments())[0].status).toBe("pending_approval");
  });

  test("auto SEM aceite do dono vale como propose", async () => {
    const s = await seedAiAgenda(t, { ai: { book: "auto", firstVisitNeedsApproval: false } });
    const { codes } = await offeredAndAnswered(s, s.ana);
    expect((await book(s, s.ana, codes[0])).result.status).toBe("reservado_aguardando_equipe");
  });

  test("duas conversas disputando o último horário: a segunda recebe horario_tomado com alternativas novas", async () => {
    const s = await seedAiAgenda(t);
    // as duas veem a mesma oferta
    const a = await offeredAndAnswered(s, s.ana);
    const b = await offeredAndAnswered(s, s.bia);
    const startA = (await stateOf(s.ana.conversationId))!.offers.find((o) => o.code === a.codes[0])!.startTime;
    const startB = (await stateOf(s.bia.conversationId))!.offers.find((o) => o.code === b.codes[0])!.startTime;
    expect(startA).toBe(startB);
    expect((await book(s, s.ana, a.codes[0])).result.status).toBe("reservado_aguardando_equipe");
    const taken = await book(s, s.bia, b.codes[0]);
    expect(taken.result.error).toBe("horario_tomado");
    expect(taken.result.resultado).toContain("Alternativas livres");
    const fresh = [...(taken.result.resultado ?? "").matchAll(/^(h\d+) — /gm)].map((m) => m[1]);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.length).toBeLessThanOrEqual(2);
    expect(fresh).not.toContain(b.codes[0]);
    const st = (await stateOf(s.bia.conversationId))!;
    expect(st.offers.map((o) => o.code)).toEqual(fresh); // as antigas deixaram de valer
    expect(st.slotTakenCount).toBe(1);
    expect(await appointments()).toHaveLength(1);
    // alternativas sem nome de recurso nem de cliente
    for (const secret of ["Helena", "Sala Rosa", "Ana"]) expect(JSON.stringify(taken)).not.toContain(secret);
    // o código antigo não reserva mais
    expect((await book(s, s.bia, b.codes[0])).result.error).toBe("oferta_desconhecida");
  });

  test("segundo horario_tomado na conversa: repasse automático (e a equipe é avisada pelo repasse)", async () => {
    const s = await seedAiAgenda(t);
    const occupyByStaff = async (conversationId: Id<"conversations">, code: string) => {
      const start = (await stateOf(conversationId))!.offers.find((o) => o.code === code)!.startTime;
      const r = await t.mutation(internal.schedulingMutations.internalBookAppointment, {
        organizationId: s.organizationId, serviceId: s.services.consulta, startTime: start, contactId: s.ana.contactId,
        actor: { type: "human", memberId: s.adminId }, origin: "staff",
      });
      expect(r.ok).toBe(true);
    };
    const first = await offeredAndAnswered(s, s.bia);
    await occupyByStaff(s.bia.conversationId, first.codes[0]);
    const t1 = await book(s, s.bia, first.codes[0]);
    expect(t1.result.error).toBe("horario_tomado");
    expect(t1.control.handoff).toBe(false);
    const fresh = [...(t1.result.resultado ?? "").matchAll(/^(h\d+) — /gm)].map((m) => m[1]);
    vi.setSystemTime(Date.now() + 1_000);
    await markShownNow(s.bia);
    vi.setSystemTime(Date.now() + 60_000);
    await customerSpoke(t, s.bia.conversationId, Date.now());
    await occupyByStaff(s.bia.conversationId, fresh[0]);
    const t2 = await book(s, s.bia, fresh[0]);
    expect(t2.result.error).toBe("horario_tomado");
    expect(t2.control.handoff).toBe(true);
    expect(await handoffs()).toHaveLength(1);
  });

  test("limite diário da IA por contato: o excedente vira repasse, nunca reserva", async () => {
    const s = await seedAiAgenda(t, { ai: { maxAiBookingsPerContactPerDay: 1 } });
    const first = await offeredAndAnswered(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" });
    expect((await book(s, s.ana, first.codes[0])).control.booked).toBe("pending");
    const second = await offeredAndAnswered(s, s.ana, { service: "Sessão", dateRef: "2026-06-16" });
    const out = await book(s, s.ana, second.codes[0]);
    expect(out.result.error).toBe("precisa_de_pessoa");
    expect(out.control.handoff).toBe(true);
    expect(await appointments()).toHaveLength(1);
  });

  test("contato que já tem horário do mesmo serviço: ja_tem_marcado, sem segundo agendamento", async () => {
    const s = await seedAiAgenda(t);
    const first = await offeredAndAnswered(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" });
    await book(s, s.ana, first.codes[0]);
    const second = await offeredAndAnswered(s, s.ana, { service: "Consulta", dateRef: "2026-06-16" });
    const out = await book(s, s.ana, second.codes[0]);
    expect(out.result.error).toBe("ja_tem_marcado");
    expect(out.result.proximo_passo).toContain("requestHandoff");
    expect(await appointments()).toHaveLength(1);
  });

  test("mode preview valida e NÃO grava: sem agendamento, oferta preservada, sem aviso", async () => {
    const s = await seedAiAgenda(t, { ai: { book: "auto" } });
    const { codes } = await offeredAndAnswered(s, s.ana);
    const out = await book(s, s.ana, codes[0], { mode: "preview" });
    expect(out.result.status).toBe("proposto_para_aprovacao_humana");
    expect(out.control.slotText).toMatch(/^segunda-feira, 15\/06, às \d{2}:\d{2}$/);
    expect(await appointments()).toHaveLength(0);
    expect((await stateOf(s.ana.conversationId))!.offers.map((o) => o.code)).toContain(codes[0]);
    const notifs = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notifs.filter((n) => n.type === "appointment_pending_approval")).toHaveLength(0);
  });

  test("a oferta guarda o plano de recursos, mas a porta revalida (recurso arquivado depois = horário tomado, não reserva)", async () => {
    const s = await seedAiAgenda(t);
    const { codes } = await offeredAndAnswered(s, s.ana);
    await t.run((ctx) => ctx.db.patch(s.p1!, { active: false }));
    const out = await book(s, s.ana, codes[0]);
    expect(out.result.status).toBe("erro");
    expect(await appointments()).toHaveLength(0);
  });
});
