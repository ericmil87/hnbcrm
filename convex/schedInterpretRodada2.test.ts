/// <reference types="vite/client" />
/**
 * Agenda v2, C1, correções da rodada 2 (simulação com modelo real): reprodução das 120 mensagens reais da rodada 2 e do
 * conjunto cego de 30 positivos + 30 negativos, pelo caminho completo (gancho do aparelho → início → [LLM simulado] → decisão).
 * O LLM é SIMULADO por `vi.stubGlobal("fetch")`; nenhuma chamada real a modelo.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest, TestConvex } from "convex-test";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { parseConfirmation } from "./lib/schedConfirmParser";
import { addLocalDays, localDateOf, weekdayOf } from "./lib/schedTime";
import { BLIND_SET, type BlindCase, PROBE_HUMAN, PROBE_LEGIT, PROBE_NEG, REAL_CASES, type RealCase, type Subject, type Turn } from "../src/test/schedInterpretRodada2Fixtures";

const modules = import.meta.glob("./**/!(*.*.*)*.*s");
const TZ = "America/Sao_Paulo";
const MIN = 60_000;
const SEC = 1000;
/** 22/11/2026 (domingo) 04:44 em São Paulo: o relógio da medição real (a regra de "amanhã de madrugada" vale aqui). */
const SIM_NOW = Date.parse("2026-11-22T04:44:00-03:00");
/** O mesmo domingo, à tarde. */
const DAY_NOW = Date.parse("2026-11-22T14:00:00-03:00");
/** Sexta 12/06/2026 09:00 (conjunto cego). */
const FRI_NOW = Date.parse("2026-06-12T09:00:00-03:00");

let t: TestConvex<typeof schema>;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCODE_GO_API", "sk-test-fake-key-000000");
  t = convexTest(schema, modules);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ───────────────────────── LLM simulado ─────────────────────────

type LlmKind = "truth" | "naive" | "legacy" | "off";
let truthSubject: Subject = "agendamento_proprio";
let llmKind: LlmKind = "truth";

function chatResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 30 } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Um modelo "bom": lê a mensagem da equipe com o MESMO parser (ato, dia e hora corretos) e diz o assunto verdadeiro da conversa
 * (`truth`) ou, no pior caso (`naive`), sempre "agendamento_proprio". Só devolve `assunto` se o prompt o pede.
 */
function stubLlm() {
  const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
    const url = String(input);
    if (!url.includes("/chat/completions")) throw new Error(`fetch inesperado: ${url}`);
    const body = JSON.parse((init as { body: string }).body) as { messages: Array<{ role: string; content: string }> };
    const system = body.messages.find((m) => m.role === "system")!.content;
    const user = body.messages.find((m) => m.role === "user")!.content;
    const obj = JSON.parse(user.slice(user.indexOf("{"), user.lastIndexOf("}") + 1)) as { MENSAGEM_DA_EQUIPE: string };
    const text = obj.MENSAGEM_DA_EQUIPE;
    const p = parseConfirmation(text, { now: Date.now(), tz: TZ, services: [] });
    const ok = p.act === "confirmou" && p.localDate !== undefined && p.timeMin !== undefined;
    const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    const reply: Record<string, string> = {
      ato: ok ? "confirmou" : "nenhum",
      dia: ok ? p.localDate! : "nenhum",
      hora: ok ? hh(p.timeMin!) : "nenhuma",
      servico: "nenhum",
      evidencia: ok ? text : "",
    };
    if (system.includes(`"assunto"`) && llmKind !== "legacy") reply.assunto = llmKind === "naive" ? "agendamento_proprio" : truthSubject;
    return chatResponse(JSON.stringify(reply));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ───────────────────────── semente ─────────────────────────

const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startMin: 480, endMin: 1080 }));

async function seed(mode: "suggest" | "auto") {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const organizationId = await ctx.db.insert("organizations", {
      name: "Clínica Teste",
      slug: `org-${Math.random().toString(36).slice(2)}`,
      settings: { timezone: TZ, currency: "BRL", modules: { scheduling: true }, aiConfig: { enabled: true, autoAssign: false, handoffThreshold: 0.8 } },
      createdAt: now,
      updatedAt: now,
    });
    const userId = await ctx.db.insert("users", { email: "admin@teste.dev", name: "Admin" });
    const memberId = await ctx.db.insert("teamMembers", { organizationId, userId, name: "Admin", role: "admin", type: "human", status: "active", createdAt: now, updatedAt: now });
    const org = (await ctx.db.get(organizationId))!;
    await ctx.db.patch(organizationId, { settings: { ...org.settings, aiConfig: { ...org.settings.aiConfig!, lgpdAck: { acceptedAt: now, acceptedBy: memberId } } } });
    const boardId = await ctx.db.insert("boards", { organizationId, name: "Funil", color: "#3b82f6", isDefault: true, order: 0, createdAt: now, updatedAt: now });
    const stageId = await ctx.db.insert("stages", { organizationId, boardId, name: "Novo", color: "#6366f1", order: 0, isClosedWon: false, isClosedLost: false, createdAt: now, updatedAt: now });
    await ctx.db.insert("schedSettings", { organizationId, humanConfirm: { mode }, updatedAt: now });
    const contactId = await ctx.db.insert("contacts", { organizationId, firstName: "Ana", lastName: "Teste", tags: [], createdAt: now, updatedAt: now });
    const leadId = await ctx.db.insert("leads", {
      organizationId, title: "Lead Ana", contactId, boardId, stageId, value: 0, currency: "BRL", priority: "medium", temperature: "warm", tags: [],
      customFields: {}, conversationStatus: "active", lastActivityAt: now, createdAt: now, updatedAt: now,
    });
    const conversationId = await ctx.db.insert("conversations", { organizationId, leadId, channel: "whatsapp", status: "active", messageCount: 0, createdAt: now, updatedAt: now });
    const p1 = await ctx.db.insert("schedResources", { organizationId, kind: "person", name: "Profissional Um", capacity: 1, weekly: WEEKDAYS, tags: [], sortOrder: 0, active: true, teamMemberId: memberId, createdAt: now, updatedAt: now });
    await ctx.db.insert("schedServices", {
      organizationId, name: "Consulta", durationMin: 60, bufferBeforeMin: 0, bufferAfterMin: 0,
      requirements: [{ role: "Profissional", kind: "person", resourceIds: [p1] }], sortOrder: 0, active: true, createdAt: now, updatedAt: now,
    });
    return { organizationId, leadId, conversationId, contactId };
  });
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function clientSays(s: Seed, text: string): Promise<void> {
  const at = Date.now();
  await t.run(async (ctx) => {
    const id = await ctx.db.insert("messages", {
      organizationId: s.organizationId, conversationId: s.conversationId, leadId: s.leadId,
      direction: "inbound", senderType: "contact", content: text, contentType: "text", isInternal: false, createdAt: at,
    });
    await ctx.db.patch(s.conversationId, { lastMessageAt: at, lastMessageId: id, lastMessagePreview: text.slice(0, 100), lastMessageDirection: "inbound", lastMessagePreviewAt: at });
  });
}

let extSeq = 0;
async function humanOnPhone(s: Seed, text: string): Promise<void> {
  await t.mutation(internal.conversations.internalReceiveDeviceMessage, { organizationId: s.organizationId, leadId: s.leadId, content: text, externalId: `ext-${++extSeq}`, sentAt: Date.now() });
}

/** Deixa os jobs que já venceram terminarem (o relógio avança de 100 em 100 ms para o recuo do cliente de LLM). */
async function drain() {
  for (let i = 0; i < 6; i++) {
    vi.advanceTimersByTime(1);
    const waiting = t.finishInProgressScheduledFunctions();
    let settled = false;
    void waiting.then(() => (settled = true));
    for (let k = 0; k < 60 && !settled; k++) {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(100);
    }
    await waiting;
  }
}
/** Espera a janela da criação automática (e o que mais estiver agendado até 2 min) e termina os jobs. */
async function settle(ms = 100 * SEC) {
  await drain();
  await vi.advanceTimersByTimeAsync(ms);
  await drain();
}

const rowsOf = (s: Seed) => t.run((ctx) => ctx.db.query("schedInterpretations").withIndex("by_organization_and_created", (q) => q.eq("organizationId", s.organizationId)).collect());
const apptsOf = (s: Seed) =>
  t.run(async (ctx) => (await ctx.db.query("schedAppointments").collect()).filter((a) => a.organizationId === s.organizationId && ["scheduled", "confirmed", "pending_approval"].includes(a.status)));

function localOf(ms: number): { date: string; min: number } {
  const date = localDateOf(ms, TZ);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms));
  const g = (k: string) => Number(parts.find((p) => p.type === k)?.value ?? "0");
  return { date, min: (g("hour") % 24) * 60 + g("minute") };
}

/** Roda uma conversa (turnos) e devolve o que ficou: agendamentos ativos e linhas de interpretação. */
async function run(turns: Turn[], mode: "suggest" | "auto", who: string) {
  const s = await seed(mode);
  for (const turn of turns) {
    const text = turn.text.replaceAll("{who}", who);
    vi.advanceTimersByTime(2 * SEC);
    if (turn.from === "c") await clientSays(s, text);
    else {
      await humanOnPhone(s, text);
      await drain();
    }
  }
  await settle();
  return { s, rows: await rowsOf(s), appts: await apptsOf(s) };
}

/** Sugestão rotulada "para outra pessoa: confira o nome" (só o sino; nunca cria): não conta como indevida. */
const LABEL = "para_outra_pessoa";
const WHO = ["a Ana", "o Rui", "a Dra. Helena"];

function nextWeekday(now: number, wd: number): string {
  let d = addLocalDays(localDateOf(now, TZ), 1);
  while (weekdayOf(d) !== wd) d = addLocalDays(d, 1);
  return d;
}

type Tally = Record<string, number>;
const bump = (tl: Tally, k: string) => (tl[k] = (tl[k] ?? 0) + 1);

/** Classifica o que a conversa produziu, no estilo do harness da rodada 2. */
function judgeReal(cs: RealCase, mode: "suggest" | "auto", now: number, out: Awaited<ReturnType<typeof run>>): string {
  const open = out.rows.filter((r) => r.decision === "proposed" && r.status === "open");
  const at = (r: { parsed: { localDate?: string; timeMin?: number } }, date: string, hour: number) => r.parsed.localDate === date && r.parsed.timeMin === hour * 60;
  if (cs.expected === "create") {
    const date = cs.when!.tomorrow ? addLocalDays(localDateOf(now, TZ), 1) : nextWeekday(now, cs.when!.wd!);
    const created = out.appts.filter((a) => localOf(a.startTime).date === date && localOf(a.startTime).min === cs.when!.hour * 60);
    if (mode === "auto") {
      if (created.length === 1 && out.appts.length === 1) return "criou certo";
      if (out.appts.length > 0) return "criou ERRADO";
      return open.some((r) => at(r, date, cs.when!.hour)) ? "sugeriu (conservador)" : "nada";
    }
    if (out.appts.length > 0) return "criou sem querer";
    return open.some((r) => at(r, date, cs.when!.hour)) ? "sugeriu" : "nada";
  }
  if (cs.correction) {
    const date = nextWeekday(now, cs.correction.wd);
    if (out.appts.length > 0) return "CRIOU INDEVIDO";
    if (open.length === 0) return "quieto";
    return open.every((r) => at(r, date, cs.correction!.hour)) ? "corrigiu para o horário novo (certo)" : "sugeriu INDEVIDO";
  }
  if (out.appts.length > 0) return "CRIOU INDEVIDO";
  if (open.some((r) => r.reason !== LABEL)) return "sugeriu INDEVIDO";
  return open.length > 0 ? "sugeriu rotulado (outra pessoa)" : "ficou quieto (certo)";
}

function judgeBlind(cs: BlindCase, mode: "suggest" | "auto", out: Awaited<ReturnType<typeof run>>): string {
  const open = out.rows.filter((r) => r.decision === "proposed" && r.status === "open");
  const hit = (r: { parsed: { localDate?: string; timeMin?: number } }, date: string, hour: number, min = 0) => r.parsed.localDate === date && r.parsed.timeMin === hour * 60 + min;
  if (cs.kind === "pos") {
    const w = cs.when!;
    const created = out.appts.filter((a) => localOf(a.startTime).date === w.date && localOf(a.startTime).min === w.hour * 60 + (w.min ?? 0));
    if (created.length === 1 && out.appts.length === 1) return mode === "auto" ? "criou certo" : "criou sem querer";
    if (out.appts.length > 0) return "criou ERRADO";
    return open.some((r) => hit(r, w.date, w.hour, w.min)) ? "sugeriu" : "nada";
  }
  if (out.appts.length > 0) return "CRIOU INDEVIDO";
  if (cs.correctionTo) return open.every((r) => hit(r, cs.correctionTo!.date, cs.correctionTo!.hour)) ? "ok" : "sugeriu INDEVIDO";
  if (open.some((r) => r.reason !== LABEL)) return "sugeriu INDEVIDO";
  return open.length > 0 ? "sugeriu rotulado (outra pessoa)" : "ficou quieto (certo)";
}

const fmt = (tl: Tally) => Object.entries(tl).sort().map(([k, v]) => `${k}=${v}`).join("; ");

// ───────────────────────── as 120 mensagens reais e o conjunto cego ─────────────────────────

const REPORT = process.env.RODADA2_REPORT === "1";

async function replayReal(mode: "suggest" | "auto", now: number) {
  stubLlm();
  const per: Record<string, Tally> = {};
  const total: Tally = {};
  for (const cs of REAL_CASES) {
    for (const who of WHO) {
      vi.clearAllTimers();
      vi.setSystemTime(now);
      t = convexTest(schema, modules);
      llmKind = "truth";
      truthSubject = cs.subject;
      const out = await run(cs.turns, mode, who);
      const j = judgeReal(cs, mode, now, out);
      bump((per[cs.id] ??= {}), j);
      bump(total, j);
    }
  }
  if (REPORT) console.log(`REAL ${mode} ${new Date(now).toISOString()}\n  ${Object.entries(per).map(([id, tl]) => `${id}: ${fmt(tl)}`).join("\n  ")}\n  TOTAL: ${fmt(total)}`);
  return { per, total };
}

async function replayBlind(mode: "suggest" | "auto", kind: LlmKind) {
  stubLlm();
  const pos: Tally = {};
  const neg: Tally = {};
  const bad: string[] = [];
  for (const cs of BLIND_SET) {
    vi.clearAllTimers();
    vi.setSystemTime(FRI_NOW);
    t = convexTest(schema, modules);
    llmKind = kind;
    truthSubject = cs.subject;
    const out = await run(cs.turns, mode, "a Ana");
    const j = judgeBlind(cs, mode, out);
    bump(cs.kind === "pos" ? pos : neg, j);
    const good = cs.kind === "pos" ? j === "sugeriu" || j === "criou certo" : j === "ficou quieto (certo)" || j === "ok" || j === "sugeriu rotulado (outra pessoa)";
    if (!good) bad.push(`${cs.id}:${j}`);
  }
  if (REPORT) console.log(`BLIND ${mode}/${kind}\n  POS: ${fmt(pos)}\n  NEG: ${fmt(neg)}\n  ERROS: ${bad.join(" ")}`);
  return { pos, neg, bad };
}

describe("as 120 mensagens reais da rodada 2 (3 negócios x 20 casos x 2 modos), caminho completo", () => {
  test.each([
    ["suggest", SIM_NOW],
    ["auto", SIM_NOW],
    ["suggest", DAY_NOW],
    ["auto", DAY_NOW],
  ] as const)("modo %s: nenhum negativo vira sugestão ou agendamento; positivos %#", async (mode, now) => {
    const { per, total } = await replayReal(mode, now);
    // Negativos (pergunta de funcionamento, terceiro, entrega, pix, humano nega, sem proposta, correção): zero indevidos.
    expect(total["CRIOU INDEVIDO"] ?? 0).toBe(0);
    expect(total["sugeriu INDEVIDO"] ?? 0).toBe(0);
    expect(total["criou ERRADO"] ?? 0).toBe(0);
    expect(total["criou sem querer"] ?? 0).toBe(0);
    // As correções ("ops, terça 14h") terminam com o horário novo proposto e NENHUM agendamento ativo (6 = 2 casos x 3 negócios).
    expect(total["corrigiu para o horário novo (certo)"]).toBe(6);
    const positives = ["P1", "P2", "P3", "P4", "P1i", "P2i", "P3i", "P4i"];
    const hit = (id: string) => (per[id]?.["sugeriu"] ?? 0) + (per[id]?.["criou certo"] ?? 0) + (per[id]?.["sugeriu (conservador)"] ?? 0);
    if (now === DAY_NOW) {
      // De dia, "amanhã às 15h" (P2, P2i) é lido como os demais: os 24 positivos viram sugestão (ou criação certa em `auto`).
      for (const id of positives) expect(hit(id), id).toBe(3);
    } else {
      // 04:44: "amanhã" escrito de madrugada é ambíguo por desenho (regra `amanha_madrugada`): nada é sugerido, o resto segue.
      for (const id of positives.filter((x) => !x.startsWith("P2"))) expect(hit(id), id).toBe(3);
      expect(per["P2"]?.["nada"]).toBe(3);
      expect(per["P2i"]?.["nada"]).toBe(3);
    }
    if (mode === "auto") {
      // Só cria quando o cliente tem intenção e a equipe confirmou na forma fechada (P1, P1i, P2i; P3/P4 ficam sugestão).
      expect(per["P1i"]?.["criou certo"]).toBe(3);
      expect(per["P4"]?.["criou certo"] ?? 0).toBe(0);
      expect(per["P4i"]?.["criou certo"] ?? 0).toBe(0);
    }
  }, 600_000);
});

describe("conjunto cego: 30 positivos + 30 negativos escritos antes da correção", () => {
  test.each([
    ["suggest", "truth"],
    ["auto", "truth"],
    ["auto", "naive"],
  ] as const)("modo %s, LLM %s", async (mode, kind) => {
    const { pos, neg, bad } = await replayBlind(mode, kind);
    // Falso positivo é o erro grave: zero negativos sugeridos ou criados, nos dois modos e até com um LLM ingênuo.
    expect(neg["CRIOU INDEVIDO"] ?? 0).toBe(0);
    expect(neg["sugeriu INDEVIDO"] ?? 0).toBe(0);
    expect(pos["criou ERRADO"] ?? 0).toBe(0);
    expect(pos["criou sem querer"] ?? 0).toBe(0);
    // Cobertura dos positivos: os 6 que dizem "sexta" numa sexta (hoje ou semana que vem? ambíguo por desenho) e o "terça de tarde, 15h"
    // são os limites que sobram; o resto vira sugestão (ou criação certa, em `auto`).
    const ok = (pos["sugeriu"] ?? 0) + (pos["criou certo"] ?? 0);
    expect(ok, bad.join(" ")).toBeGreaterThanOrEqual(23);
    expect(bad.filter((x) => x.includes("sugeriu INDEVIDO") || x.includes("CRIOU"))).toEqual([]);
  }, 600_000);
});

// ───────────────────────── assunto do pedido do cliente (funcionamento, terceiro) ─────────────────────────

const c = (text: string): Turn => ({ from: "c", text });
const h = (text: string): Turn => ({ from: "h", text });
const suggestionsOf = async (s: Seed) => (await rowsOf(s)).filter((r) => r.decision === "proposed" && r.status === "open");
const notesOf = (s: Seed, type: string) => t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.organizationId === s.organizationId && n.type === type));

describe("pergunta de funcionamento não é pedido de horário (nos dois modos)", () => {
  const CASES: Array<[Turn[], string]> = [
    [[c("Vocês abrem segunda às 10h?"), h("Confirmado segunda 10h")], "assunto_funcionamento"],
    [[c("Vocês abrem segunda às 10h?"), h("Sim, às 10h")], "sem_proposta"],
    [[c("Que horas vocês abrem na segunda?"), h("Sim, às 10h")], "sem_proposta"],
    [[c("Tem expediente sábado de manhã?"), h("Confirmado sábado 10h")], "sem_proposta"],
    [[c("Tem expediente sábado às 10h?"), h("Confirmado sábado 10h")], "assunto_funcionamento"],
    [[c("vocês funcionam sexta às 14h?"), h("Confirmado sexta 14h")], "assunto_funcionamento"],
    [[c("o consultório fecha às 18h na segunda?"), h("Confirmado segunda 18h")], "assunto_funcionamento"],
  ];
  test.each(CASES)("%j", async (turns, reason) => {
    stubLlm();
    for (const mode of ["suggest", "auto"] as const) {
      vi.clearAllTimers();
      vi.setSystemTime(FRI_NOW);
      t = convexTest(schema, modules);
      llmKind = "naive"; // até um modelo que diz "agendamento_proprio" a tudo não muda nada: a regra determinística já barrou
      const out = await run(turns, mode, "a Ana");
      expect(await suggestionsOf(out.s)).toEqual([]);
      expect(out.appts).toEqual([]);
      expect(await notesOf(out.s, "appointment_suggestion")).toEqual([]);
      const reasons = out.rows.map((r) => r.reason);
      // O parser já barra algumas frases (expediente, "fecha às 18h") sem ver proposta: `sem_proposta` também é quieto e certo.
      expect(reasons.every((x) => x === reason || x === "sem_proposta"), `${mode}: ${reasons.join(",")}`).toBe(true);
    }
  });

  test("sem cair em falso negativo: pedido explícito de marcar na mesma frase continua sendo pedido", async () => {
    stubLlm();
    vi.setSystemTime(FRI_NOW);
    for (const client of ["Vocês abrem quinta? Quero marcar quinta às 10h", "quero marcar quinta às 10h, posso pagar no pix?", "Oi, aqui é o João, quero marcar quinta às 10h"]) {
      vi.clearAllTimers();
      t = convexTest(schema, modules);
      llmKind = "truth";
      truthSubject = "agendamento_proprio";
      const out = await run([c(client), h("Confirmado quinta 10h")], "suggest", "a Ana");
      expect((await suggestionsOf(out.s)).length, client).toBe(1);
    }
  });
});

describe("horário para outra pessoa: sugestão ROTULADA \"para outra pessoa: confira o nome\", nunca criação", () => {
  const CASES: Turn[][] = [
    [c("minha mãe pode ir quinta às 10h?"), h("Pode sim, confirmado quinta 10h")],
    [c("pode ser terça às 10h pro meu marido?"), h("Confirmado terça 10h")],
    [c("quero marcar terça às 10h pro meu marido"), h("Confirmado terça 10h")],
    [c("é pro meu filho: quinta às 10h"), h("Confirmado quinta 10h")],
    [c("quinta às 10h pode?"), c("é pro meu filho"), h("Confirmado quinta 10h")],
    [c("minha esposa quer quinta às 10h"), h("Fechado, quinta 10h")],
    [c("pode ser quinta às 10h?"), h("Confirmado quinta 10h pro seu filho")],
    [c("pode ser quinta 10h pro João?"), h("Confirmado quinta 10h")],
    [c("marca pra Ana quinta 10h"), h("Confirmado quinta 10h")],
    [c("o Pedrinho pode ir quinta 10h?"), h("Confirmado quinta 10h")],
  ];
  test.each(CASES)("%j", async (...turns) => {
    stubLlm();
    for (const mode of ["suggest", "auto"] as const) {
      vi.clearAllTimers();
      vi.setSystemTime(FRI_NOW);
      t = convexTest(schema, modules);
      llmKind = "naive";
      const out = await run(turns, mode, "a Ana");
      const open = await suggestionsOf(out.s);
      expect(open.length, mode).toBe(1);
      expect(open[0].reason, mode).toBe("para_outra_pessoa");
      expect(out.appts).toEqual([]);
      // Só o sino (sem push nem Telegram).
      expect((await notesOf(out.s, "appointment_suggestion")).every((n) => n.data?.bellOnly === true)).toBe(true);
    }
  });
});

describe("o classificador devolve o assunto (campo fechado) e só `agendamento_proprio` cria", () => {
  const ask = [c("pode ser terça às 10h?"), h("Confirmado terça 10h")];
  async function runWith(kind: LlmKind, subject: Subject) {
    const fetchMock = stubLlm();
    vi.clearAllTimers();
    vi.setSystemTime(FRI_NOW);
    t = convexTest(schema, modules);
    llmKind = kind;
    truthSubject = subject;
    const out = await run(ask, "auto", "a Ana");
    return { out, fetchMock };
  }

  test("o prompt pede `assunto` com os cinco valores e o pedido só lista o necessário", async () => {
    const { fetchMock, out } = await runWith("truth", "agendamento_proprio");
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as { messages: Array<{ role: string; content: string }> };
    const system = body.messages[0].content;
    for (const v of ["agendamento_proprio", "funcionamento", "terceiro", "entrega_pagamento", "outro"]) expect(system).toContain(v);
    expect(system).toContain('"assunto"');
    expect(out.appts).toHaveLength(1); // concordando em tudo, cria
  });

  test("modelo diz `terceiro`: sugestão rotulada para outra pessoa, nunca cria", async () => {
    const { out } = await runWith("truth", "terceiro");
    expect(out.appts).toEqual([]);
    expect(out.rows[0]).toMatchObject({ decision: "proposed", status: "open", reason: "para_outra_pessoa" });
  });

  test.each(["funcionamento", "entrega_pagamento"] as const)("modelo diz `%s`: nem sugere, nem cria", async (subject) => {
    const { out } = await runWith("truth", subject);
    expect(out.appts).toEqual([]);
    expect(await suggestionsOf(out.s)).toEqual([]);
    expect(out.rows[0]).toMatchObject({ decision: "ignored", status: "done", reason: `assunto_${subject}` });
  });

  test("modelo diz `outro`: não cria, vira sugestão com o motivo", async () => {
    const { out } = await runWith("truth", "outro");
    expect(out.appts).toEqual([]);
    expect(out.rows[0]).toMatchObject({ decision: "proposed", status: "open", reason: "ia_assunto_incerto" });
  });

  test("resposta sem `assunto` (formato antigo) não é aceita: `ia_resposta_invalida`, sem criar", async () => {
    const { out } = await runWith("legacy", "agendamento_proprio");
    expect(out.appts).toEqual([]);
    expect(out.rows[0]).toMatchObject({ decision: "proposed", reason: "ia_resposta_invalida" });
  });
});

describe("\"amanhã às 15h\" vira proposta (rodada 2: 6 de 6 perdidos)", () => {
  const turns = [c("amanhã às 15h dá?"), h("Pode vir amanhã às 15h")];
  test("de dia, e em qualquer modo: sugestão no dia seguinte, 15h", async () => {
    stubLlm();
    for (const mode of ["suggest", "auto"] as const) {
      vi.clearAllTimers();
      vi.setSystemTime(DAY_NOW);
      t = convexTest(schema, modules);
      llmKind = "truth";
      truthSubject = "agendamento_proprio";
      const out = await run(turns, mode, "a Ana");
      const open = await suggestionsOf(out.s);
      expect(open).toHaveLength(1);
      expect(open[0].parsed).toMatchObject({ localDate: "2026-11-23", timeMin: 900 });
    }
  });
  test("às 04:44 (a hora da medição) 'amanhã' é ambíguo por desenho (pode ser o dia que ainda 'não virou'): nada é sugerido, e isso é a regra, não um defeito", async () => {
    stubLlm();
    vi.setSystemTime(SIM_NOW);
    t = convexTest(schema, modules);
    const out = await run(turns, "suggest", "a Ana");
    expect(await suggestionsOf(out.s)).toEqual([]);
    expect(out.rows[0]).toMatchObject({ decision: "ignored", reason: "sem_proposta" });
  });
});

// ───────────────────────── sondagem 2 (revisão do PR #204): parente, vocativo e pagamento na frase ─────────────────────────

async function probe(mode: "suggest" | "auto") {
  stubLlm();
  const legit: Tally = {};
  const neg: Tally = {};
  const missed: string[] = [];
  const leaked: string[] = [];
  const cases: Array<{ text: string; legit: boolean; kind?: string }> = [...PROBE_LEGIT.map((text) => ({ text, legit: true })), ...PROBE_NEG.map((n) => ({ text: n.text, legit: false, kind: n.kind }))];
  for (const cs of cases) {
    vi.clearAllTimers();
    vi.setSystemTime(FRI_NOW);
    t = convexTest(schema, modules);
    llmKind = "naive";
    const out = await run([c(cs.text), h(PROBE_HUMAN)], mode, "a Ana");
    const open = await suggestionsOf(out.s);
    const plain = open.filter((r) => r.reason !== LABEL);
    if (cs.legit) {
      const ok = plain.length > 0 || out.appts.length > 0;
      bump(legit, out.appts.length > 0 ? "criou" : ok ? "sugeriu" : open.length > 0 ? "rotulado (errado)" : "perdido");
      if (!ok) missed.push(cs.text);
    } else {
      const bad = plain.length > 0 || out.appts.length > 0;
      bump(neg, out.appts.length > 0 ? "CRIOU" : bad ? "sugeriu sem rótulo" : open.length > 0 ? "rotulado" : "quieto");
      if (bad) leaked.push(`${cs.kind}: ${cs.text}`);
    }
  }
  if (REPORT) console.log(`SONDAGEM ${mode}\n  LEGÍTIMOS (${PROBE_LEGIT.length}): ${fmt(legit)}\n  PERDIDOS: ${missed.join(" | ")}\n  NEGATIVOS (${PROBE_NEG.length}): ${fmt(neg)}\n  VAZARAM: ${leaked.join(" | ")}`);
  return { legit, neg, missed, leaked };
}

describe("sondagem 2: 40 pedidos legítimos com parente, vocativo ou pagamento × 40 horários de outra pessoa, funcionamento ou pagamento", () => {
  test.each(["suggest", "auto"] as const)("modo %s: >= 85% dos legítimos viram sugestão; >= 90% dos demais não viram agendamento sem rótulo; nenhum criado", async (mode) => {
    const { legit, neg, missed, leaked } = await probe(mode);
    const okLegit = (legit["sugeriu"] ?? 0) + (legit["criou"] ?? 0);
    expect(okLegit / PROBE_LEGIT.length, `perdidos: ${missed.join(" | ")}`).toBeGreaterThanOrEqual(0.85);
    expect(1 - leaked.length / PROBE_NEG.length, `vazaram: ${leaked.join(" | ")}`).toBeGreaterThanOrEqual(0.9);
    expect(neg["CRIOU"] ?? 0).toBe(0);
  }, 600_000);
});

describe("'vou marcar' do cliente só vale com o dia/hora logo depois (revisão do PR)", () => {
  test("'vou marcar a reunião/o médico quinta 10h' não é pedido de atendimento; 'posso marcar quinta 10h?' é", async () => {
    stubLlm();
    for (const [text, expected] of [["vou marcar a reunião quinta 10h", 0], ["vou marcar o médico quinta 10h", 0], ["posso marcar quinta 10h?", 1], ["posso agendar quinta às 10h?", 1], ["vou marcar quinta 10h", 1]] as const) {
      vi.clearAllTimers();
      vi.setSystemTime(FRI_NOW);
      t = convexTest(schema, modules);
      llmKind = "naive";
      const out = await run([c(text), h("Confirmado quinta 10h")], "suggest", "a Ana");
      expect((await suggestionsOf(out.s)).length, text).toBe(expected);
    }
  });
});
