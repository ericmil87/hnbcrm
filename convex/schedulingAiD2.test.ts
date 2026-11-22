/// <reference types="vite/client" />
/**
 * Agenda v2, D2: correções medidas na simulação com modelo real. Profissional pedido (o servidor resolve, filtra e fixa na reserva),
 * hora pedida com contagem de horários livres, grupo pela porta de grupo e reserva sem troca silenciosa de recurso. Chama as
 * internas como a action do atendente chama; o `convex-test` NÃO valida `returns` (cada retorno passa por `assertMatchesReturns`).
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
const book = async (s: AiSeed, who: Who, offer: string) => {
  const out = await t.mutation(internal.schedulingAi.internalBookOfferedTime, {
    organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: who.conversationId, argsJson: JSON.stringify({ offer }),
  });
  assertMatchesReturns(out, ai.internalBookOfferedTime);
  return out;
};
const appointments = () => t.run((ctx) => ctx.db.query("schedAppointments").collect());
const stateOf = (conversationId: Id<"conversations">) =>
  t.run((ctx) => ctx.db.query("schedConversationState").withIndex("by_conversation", (q) => q.eq("conversationId", conversationId)).first());
const linesOf = (resultado: string | undefined) => (resultado ?? "").split("\n").filter((l) => /^h\d+ — /.test(l));

async function addPerson(s: AiSeed, name: string, weekdays = [1, 2, 3, 4, 5], sortOrder = 5): Promise<Id<"schedResources">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("schedResources", {
      organizationId: s.organizationId, kind: "person", name, capacity: 1, tags: [], sortOrder, active: true,
      weekly: weekdays.map((weekday) => ({ weekday, startMin: 480, endMin: 1080 })), createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
}

/** Reserva da equipe direto pela porta (ocupa o horário de um recurso). */
async function staffBook(s: AiSeed, who: Who, startTime: number, resourceIds: Id<"schedResources">[], service: Id<"schedServices"> = s.services.consulta) {
  await t.run(async (ctx) => {
    const { bookAppointmentCore } = await import("./lib/schedBookingOps");
    const admin = (await ctx.db.get(s.adminId))!;
    const r = await bookAppointmentCore(ctx, {
      organizationId: s.organizationId, actor: { type: "human", member: admin, via: "app" }, origin: "staff",
      serviceId: service, startTime, contactId: who.contactId, resourceIds, now: Date.now(),
    });
    expect(r.ok).toBe(true);
  });
}

async function shownAndAnswered(who: Who) {
  vi.setSystemTime(Date.now() + 1_000);
  await t.run(async (ctx) => {
    const st = await ctx.db.query("schedConversationState").withIndex("by_conversation", (q) => q.eq("conversationId", who.conversationId)).first();
    if (st) await ctx.db.patch(st._id, { offers: st.offers.map((o) => (o.shownAt === undefined ? { ...o, shownAt: Date.now() } : o)) });
  });
  vi.setSystemTime(Date.now() + 60_000);
  await customerSpoke(t, who.conversationId, Date.now());
}

describe("profissional pedido pelo cliente: o servidor resolve, filtra e fixa", () => {
  test("nome → recurso ativo da org: só horários dele, a oferta o nomeia, a reserva grava ELE (e só ele)", async () => {
    const s = await seedAiAgenda(t);
    const leo = await addPerson(s, "Léo");
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", professional: "o Léo" });
    expect(out.result.status).toBe("ok");
    expect(out.result.resultado).toContain("Pedido com Léo: os horários abaixo SÃO com Léo");
    const lines = linesOf(out.result.resultado);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/\(com Léo\)$/);
    expect(JSON.stringify(out)).not.toContain("Helena"); // só o nome que o CLIENTE pediu volta
    const st = await stateOf(s.ana.conversationId);
    expect(st!.offers.every((o) => o.professional === "Léo" && o.resourceIds.length === 1 && o.resourceIds[0] === leo)).toBe(true);
    expect(out.control.named).toHaveLength(lines.length);

    await shownAndAnswered(s.ana);
    const booked = await book(s, s.ana, "h1");
    expect(booked.result.status).toBe("reservado_aguardando_equipe");
    expect(booked.result.resultado).toContain("com Léo");
    const rows = await appointments();
    expect(rows).toHaveLength(1);
    expect(rows[0].resources.map((r) => r.name)).toEqual(["Léo"]);
    expect(booked.control.named).toEqual([{ startTime: rows[0].startTime, professional: "Léo" }]);
  });

  test("nome sem acento, caixa nem título casa; primeiro nome único casa; ambíguo e desconhecido = sem filtro e a resposta diz", async () => {
    const s = await seedAiAgenda(t);
    await addPerson(s, "Léo Silva");
    await addPerson(s, "Léo Souza");
    for (const name of ["dra helena", "HELENA", "  a dra. helena "]) {
      const ok = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", professional: name });
      expect(ok.result.resultado, name).toContain("SÃO com Dra. Helena");
    }
    const ambiguous = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", professional: "Léo" });
    expect(ambiguous.result.status).toBe("ok");
    expect(ambiguous.result.resultado).toContain("serve a mais de um profissional");
    expect(linesOf(ambiguous.result.resultado).every((l) => !l.includes("(com"))).toBe(true);
    const unique = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", professional: "Souza" });
    expect(unique.result.resultado).toContain("SÃO com Léo Souza");
    const unknown = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", professional: "Zeca" });
    expect(unknown.result.resultado).toContain("Não identifiquei o profissional pedido");
    expect(unknown.result.resultado).toContain("NÃO são com ele");
    expect(linesOf(unknown.result.resultado).length).toBeGreaterThan(0);
    const st = await stateOf(s.ana.conversationId);
    expect(st!.offers.filter((o) => o.professional === undefined).length).toBeGreaterThan(0);
  });

  test("profissional de folga no dia: diz que ele não tem horário, oferece as alternativas reais SEM o nome dele, e a oferta não nomeia ninguém", async () => {
    const s = await seedAiAgenda(t);
    await addPerson(s, "Léo", [2, 3, 4, 5]); // folga na segunda 15/06
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", professional: "Léo" });
    expect(out.result.status).toBe("ok");
    expect(out.result.resultado).toContain("Léo NÃO tem horário livre nesse pedido");
    expect(out.result.resultado).toContain("NÃO diga que são com Léo");
    const lines = linesOf(out.result.resultado);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => !l.includes("(com"))).toBe(true);
    const st = await stateOf(s.ana.conversationId);
    expect(st!.offers.every((o) => o.professional === undefined)).toBe(true);
    expect(out.control.named).toBeUndefined();
  });

  test("ninguém tem horário: sem_horarios também diz que o profissional pedido não tem", async () => {
    const s = await seedAiAgenda(t);
    await addPerson(s, "Léo");
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-14", professional: "Léo" }); // domingo
    expect(out.result.status).toBe("sem_horarios");
    expect(out.result.resultado).toContain("Léo NÃO tem horário livre");
  });

  test("profissional que não faz o serviço e grupo com profissional: busca sem filtro, avisando", async () => {
    const s = await seedAiAgenda(t);
    // "Sessão" só pede SALA: um profissional pedido não restringe nada, mas Sala Rosa não é pessoa que faça "Consulta"? aqui, sala existente pedida p/ o serviço de profissional
    const room = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", professional: "Sala Rosa" });
    expect(room.result.resultado).toMatch(/Sala Rosa (não faz esse serviço|NÃO tem horário livre)/);
    expect(linesOf(room.result.resultado).every((l) => !l.includes("(com"))).toBe(true);
    const group = await find(s, s.ana, { service: "Massagem casal", dateRef: "2026-06-15", people: 2, professional: "Helena" });
    expect(group.result.resultado).toContain("Marcação em grupo não escolhe profissional");
    expect(linesOf(group.result.resultado).every((l) => !l.includes("(com"))).toBe(true);
  });

  test("argumento inválido do profissional: erro acionável, sem tocar na agenda", async () => {
    const s = await seedAiAgenda(t);
    for (const professional of [123, { id: "x" }, "x".repeat(80)]) {
      const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", professional });
      expect(out.result.error).toBe("profissional_invalido");
    }
    expect(await appointments()).toHaveLength(0);
  });

  test("reserva = plano da OFERTA: se o recurso da oferta foi tomado, é horário tomado, nunca outro profissional em silêncio", async () => {
    const s = await seedAiAgenda(t);
    await addPerson(s, "Léo");
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" }); // sem profissional: plano padrão (Helena)
    expect(linesOf(out.result.resultado).length).toBeGreaterThan(0);
    const st = await stateOf(s.ana.conversationId);
    const first = st!.offers[0];
    expect(first.resourceIds).toEqual([s.p1]);
    await shownAndAnswered(s.ana);
    // outro cliente ocupa a Helena nesse horário; Léo continua livre (a porta trocaria o recurso sem o allowResourceFallback:false)
    await staffBook(s, s.bia, first.startTime, [s.p1!]);
    const taken = await book(s, s.ana, "h1");
    expect(taken.result.error).toBe("horario_tomado");
    expect(await appointments()).toHaveLength(1);
    expect((await appointments())[0].contactId).toBe(s.bia.contactId);
  });

  test("sem corrida, a reserva grava exatamente o plano da oferta (mesmos recursos)", async () => {
    const s = await seedAiAgenda(t);
    await addPerson(s, "Léo");
    await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" });
    const offer = (await stateOf(s.ana.conversationId))!.offers[0];
    await shownAndAnswered(s.ana);
    await book(s, s.ana, "h1");
    const [row] = await appointments();
    expect(row.resources.map((r) => r.resourceId)).toEqual(offer.resourceIds);
  });
});

describe("hora pedida e contagem de horários livres", () => {
  test("hora livre vem como PRIMEIRA oferta; a resposta diz que está disponível e quantos horários há", async () => {
    const s = await seedAiAgenda(t);
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", time: "14h" });
    expect(out.result.resultado).toContain("Horário pedido (14:00) DISPONÍVEL: é o primeiro da lista");
    const lines = linesOf(out.result.resultado);
    expect(lines[0]).toBe("h1 — segunda-feira, 15/06, às 14:00");
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(out.result.resultado).toMatch(/Há \d+ horários livres neste pedido; os \d abaixo são só uma amostra/);
    const total = Number(/Há (\d+) horários livres/.exec(out.result.resultado ?? "")![1]);
    expect(total).toBeGreaterThan(3);
    expect(out.result.ha_mais).toBe("sim");
    expect((await stateOf(s.ana.conversationId))!.offers[0].startTime).toBe(aiAt(14));
  });

  test("hora ocupada: diz 'indisponível' e devolve as mais PRÓXIMAS dela (não o ranking), sem o horário pedido", async () => {
    const s = await seedAiAgenda(t);
    await staffBook(s, s.bia, aiAt(14), [s.p1!]);
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", time: "14:00" });
    expect(out.result.resultado).toContain("Horário pedido (14:00) INDISPONÍVEL neste pedido");
    const lines = linesOf(out.result.resultado);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => !l.includes("às 14:00"))).toBe(true);
    for (const l of lines) {
      const m = /às (\d{2}):(\d{2})$/.exec(l)!;
      expect(Math.abs(Number(m[1]) * 60 + Number(m[2]) - 14 * 60)).toBeLessThanOrEqual(90);
    }
    expect(out.control.offeredTimes).toHaveLength(lines.length);
  });

  test("modo 'restrict' que esconderia a hora pedida: se ela está livre, vem como primeira oferta (o modo orienta, não recusa pedido explícito)", async () => {
    const s = await seedAiAgenda(t);
    await t.run(async (ctx) => {
      const doc = (await ctx.db.query("schedSettings").first())!;
      await ctx.db.patch(doc._id, { smart: { mode: "restrict" } });
    });
    await staffBook(s, s.bia, aiAt(10), [s.p1!]); // 10-11h ocupado: restrict só oferece horários encostados (9h, 11h)
    const plain = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" });
    const offeredPlain = linesOf(plain.result.resultado).map((l) => /às (\d{2}):\d{2}$/.exec(l)![1]);
    expect(offeredPlain).not.toContain("15"); // 15h livre, não encostada em nada: o modo a esconde
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", time: "15:00" });
    expect(out.result.resultado).toContain("Horário pedido (15:00) DISPONÍVEL");
    const first = linesOf(out.result.resultado)[0];
    expect(first).toMatch(/^h\d+ — segunda-feira, 15\/06, às 15:00$/);
    await shownAndAnswered(s.ana);
    expect((await book(s, s.ana, first.split(" ")[0])).result.status).toBe("reservado_aguardando_equipe"); // a porta aceita: é só um horário livre
  });

  test("dia inteiro lotado na hora pedida e em volta: sem_horarios cita a hora pedida", async () => {
    const s = await seedAiAgenda(t);
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-14", time: "14:00" }); // domingo
    expect(out.result.status).toBe("sem_horarios");
    expect(out.result.resultado).toContain("Horário pedido (14:00) INDISPONÍVEL");
  });

  test("a contagem vale sem hora pedida também (a IA não conclui 'não tem' por ver só 3)", async () => {
    const s = await seedAiAgenda(t);
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15" });
    expect(out.result.resultado).toMatch(/Há \d+ horários livres neste pedido/);
    const none = await find(s, s.bia, { service: "Sessão", dateRef: "2026-06-15", period: "noite" });
    expect(none.result.status).toBe("sem_horarios");
  });

  test.each([["25:00"], ["tarde"], ["14:75"], [""]])("hora inválida %j: erro acionável quando não vazia", async (time) => {
    const s = await seedAiAgenda(t);
    const out = await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", time });
    if (time === "") expect(out.result.status).toBe("ok");
    else expect(out.result.error).toBe("hora_invalida");
  });

  test("a hora pedida NUNCA vira escrita: a reserva só aceita código e a oferta é a do servidor", async () => {
    const s = await seedAiAgenda(t);
    await find(s, s.ana, { service: "Consulta", dateRef: "2026-06-15", time: "14:00" });
    await shownAndAnswered(s.ana);
    const bad = await t.mutation(internal.schedulingAi.internalBookOfferedTime, {
      organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: s.ana.conversationId, argsJson: JSON.stringify({ offer: "h1", time: "03:00", startTime: 1 }),
    });
    expect(bad.result.status).toBe("reservado_aguardando_equipe"); // campos extras ignorados
    expect((await appointments())[0].startTime).toBe(aiAt(14));
  });
});

describe("grupo pela porta de grupo (D2)", () => {
  test("reserva do grupo repete idempotente: o retry devolve o mesmo grupo, sem acompanhante duplicado", async () => {
    const s = await seedAiAgenda(t);
    await find(s, s.ana, { service: "Massagem casal", dateRef: "2026-06-15", people: 2 });
    await shownAndAnswered(s.ana);
    const first = await book(s, s.ana, "h1");
    expect(first.result.status).toBe("reservado_aguardando_equipe");
    const again = await book(s, s.ana, "h1"); // a oferta foi consumida: o retry acha o grupo pela chave da porta
    expect(again.result.resultado).toContain("O pedido já estava registrado");
    expect(await appointments()).toHaveLength(2);
  });

  test("modo prévia: valida e não grava, e o rótulo diz 'para 2 pessoas'", async () => {
    const s = await seedAiAgenda(t);
    await find(s, s.ana, { service: "Massagem casal", dateRef: "2026-06-15", people: 2 });
    await shownAndAnswered(s.ana);
    const out = await t.mutation(internal.schedulingAi.internalBookOfferedTime, {
      organizationId: s.organizationId, agentMemberId: s.agentId, conversationId: s.ana.conversationId, argsJson: JSON.stringify({ offer: "h1" }), mode: "preview",
    });
    expect(out.result.status).toBe("proposto_para_aprovacao_humana");
    expect(out.result.resultado).toContain("para 2 pessoas");
    expect(await appointments()).toHaveLength(0);
  });

  test("grupo com política auto: continua aguardando a equipe (a IA nunca marca grupo sozinha)", async () => {
    const s = await seedAiAgenda(t, { ai: { book: "auto", firstVisitNeedsApproval: false } });
    await t.run(async (ctx) => {
      const doc = (await ctx.db.query("schedSettings").first())!;
      await ctx.db.patch(doc._id, { ai: { ...doc.ai, autoAck: { by: s.adminId, at: Date.now() } } });
    });
    await find(s, s.ana, { service: "Massagem casal", dateRef: "2026-06-15", people: 2 });
    await shownAndAnswered(s.ana);
    const out = await book(s, s.ana, "h1");
    expect(out.result.status).toBe("reservado_aguardando_equipe");
    expect((await appointments()).every((r) => r.status === "pending_approval")).toBe(true);
  });
});
