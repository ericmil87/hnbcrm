/**
 * Relatórios (F2, §4.7): goldens da manhã e do fim do dia (completo, discreto,
 * escopo de agente, "50+"), e as funções de hora local.
 */
import { describe, expect, test } from "vitest";
import {
  ageLabel,
  atLocal,
  formatEveningReport,
  formatMorningReport,
  isWeekend,
  localDateKey,
  shortDatePt,
  type ReportData,
  type ReportOptions,
} from "./executiveReport";

const TZ = "America/Sao_Paulo";
// Terça 03/11/2026 08:05 em São Paulo (UTC−3).
const NOW = Date.UTC(2026, 10, 3, 11, 5);
const MIN = 60_000;
const HOUR = 60 * MIN;

const opts = (over: Partial<ReportOptions> = {}): ReportOptions => ({
  memberName: "Eric Milfont",
  orgName: "Acme Corp",
  timezone: TZ,
  currency: "BRL",
  now: NOW,
  discreet: false,
  appBaseUrl: "https://app.example.test",
  usdBrlRate: 5.5,
  ...over,
});

const at = (h: number, m = 0) => atLocal(NOW, TZ, 0, h) + m * MIN;

function morning(over: Partial<NonNullable<ReportData["morning"]>> = {}, scope: "org" | "own" = "org"): ReportData {
  return {
    scope,
    canReply: true,
    morning: {
      handoffs: {
        count: 3,
        capped: false,
        oldestAt: NOW - 40 * MIN,
        items: [
          { id: "h1", leadName: "Pedro Nunes", reason: "preço", createdAt: NOW - 40 * MIN },
          { id: "h2", leadName: "Ana Reis", reason: "reclamação", createdAt: NOW - 20 * MIN },
          { id: "h3", leadName: "Luís Tavares", reason: "agenda", createdAt: NOW - 5 * MIN },
        ],
      },
      followUps: {
        count: 2,
        capped: false,
        items: [
          { leadName: "Joana", dueAt: at(10) },
          { leadName: "Carlos", dueAt: at(15) },
        ],
      },
      tasksToday: {
        count: 4,
        capped: false,
        items: [
          { id: "t1", title: "Enviar contrato Carlos", dueDate: at(10), leadName: "Carlos Lima" },
          { id: "t2", title: "Follow-up Bia", dueDate: at(11) },
        ],
      },
      tasksOverdue: { count: 1, capped: false, items: [{ id: "t9", title: "Ligar", leadName: "Dona Rejane" }] },
      newLeads: { count: 7, capped: false, mine: 2, sinceLabel: "ontem 18h", items: [{ title: "Carlos Lima" }, { title: "Bia Moraes" }] },
      unread: { count: 5, capped: false },
      channels: { total: 2, down: [] },
      ...over,
    },
  };
}

describe("hora local", () => {
  test("data, meia-noite, fim de semana e rótulos", () => {
    expect(localDateKey(NOW, TZ)).toBe("2026-11-03");
    expect(atLocal(NOW, TZ, 0, 0)).toBe(Date.UTC(2026, 10, 3, 3, 0));
    expect(atLocal(NOW, TZ, -1, 18)).toBe(Date.UTC(2026, 10, 2, 21, 0));
    expect(atLocal(NOW, "America/Manaus", 0, 0)).toBe(Date.UTC(2026, 10, 3, 4, 0));
    expect(shortDatePt(NOW, TZ)).toBe("ter 03/11");
    expect(isWeekend(NOW, TZ)).toBe(false);
    expect(isWeekend(Date.UTC(2026, 10, 7, 12), TZ)).toBe(true); // sábado
    // Domingo 23:30 em São Paulo já é segunda em UTC: vale o fuso da org.
    expect(isWeekend(Date.UTC(2026, 10, 9, 2, 30), TZ)).toBe(true);
    expect(ageLabel(40 * MIN)).toBe("40 min");
    expect(ageLabel(3 * HOUR)).toBe("3h");
  });
});

describe("manhã (§4.7)", () => {
  test("golden completo", () => {
    const out = formatMorningReport(morning(), opts());
    expect(out.text).toBe(
      [
        "☀️ Bom dia, Eric · Acme Corp · ter 03/11",
        "🔁 3 repasses esperando (mais antigo: 40 min, Pedro Nunes)",
        "⏰ 2 follow-ups da IA hoje (Joana 10h, Carlos 15h)",
        "✅ Suas tarefas: 4 hoje · 1 atrasada (Dona Rejane)",
        "🆕 7 leads desde ontem 18h (2 seus) · 💬 5 conversas não lidas",
        "🟢 Canais conectados",
        "<blockquote expandable>Detalhes",
        "Repasses: Pedro Nunes (preço), Ana Reis (reclamação), Luís Tavares (agenda)",
        "Leads novos: Carlos Lima, Bia Moraes",
        "Tarefas hoje: 10:00 Enviar contrato Carlos · 11:00 Follow-up Bia</blockquote>",
      ].join("\n"),
    );
    expect(out.keyboard).toEqual([
      [
        { text: "🔁 Ver repasses", callback_data: "cmd:repasses" },
        { text: "✅ Ver tarefas", callback_data: "cmd:tarefas" },
      ],
      [{ text: "🔗 Abrir CRM", url: "https://app.example.test/app/painel" }],
    ]);
  });

  test("discreto: iniciais em todo nome, inclusive dentro do título da tarefa", () => {
    const out = formatMorningReport(morning(), opts({ discreet: true }));
    for (const name of ["Pedro", "Ana Reis", "Luís", "Joana", "Carlos", "Rejane", "Bia Moraes"]) {
      expect(out.text).not.toContain(name);
    }
    expect(out.text).toContain("(mais antigo: 40 min, P. N.)");
    expect(out.text).toContain("10:00 Enviar contrato C.");
  });

  test("escopo de agente: sem follow-ups da org, leads 'seus'", () => {
    const out = formatMorningReport(
      morning({ followUps: null, newLeads: { count: 2, capped: false, mine: 2, sinceLabel: "ontem 18h", items: [{ title: "Carlos Lima" }] } }, "own"),
      opts(),
    );
    expect(out.text).not.toContain("follow-up");
    expect(out.text).toContain("🆕 2 leads seus desde ontem 18h · 💬 5 conversas não lidas");
    expect(out.text).toContain("Leads novos seus: Carlos Lima");
  });

  test("teto: seções cheias viram 50+; vazias têm texto próprio; canal fora do ar", () => {
    const out = formatMorningReport(
      morning({
        handoffs: { count: 0, capped: false, items: [] },
        unread: { count: 50, capped: true },
        newLeads: { count: 50, capped: true, mine: 3, sinceLabel: "ontem 18h", items: [] },
        channels: { total: 2, down: ["Principal"] },
      }),
      opts(),
    );
    expect(out.text).toContain("🔁 Nenhum repasse esperando");
    expect(out.text).toContain("🆕 50+ leads desde ontem 18h (3 seus) · 💬 50+ conversas não lidas");
    expect(out.text).toContain("🔴 Fora do ar: Principal");
  });
});

function evening(over: Partial<NonNullable<ReportData["evening"]>> = {}, canReply = true): ReportData {
  return {
    scope: "org",
    canReply,
    evening: {
      newLeads: { count: 9, capped: false },
      won: { count: 2, capped: false, value: 9120 },
      lost: { count: 1, capped: false },
      tasksCompleted: { count: 6, capped: false },
      tasksPending: { count: 3, capped: false },
      ownerlessHandoffs: {
        count: 1,
        capped: false,
        items: [{ id: "h77", leadName: "Ana Reis", reason: "reclamação", createdAt: NOW - 3 * HOUR }],
      },
      ai: { runsToday: { count: 41, capped: false }, costTodayUsd: 0.37 / 5.5, costMonthUsd: 6.8 / 5.5 },
      tomorrowTasks: {
        count: 2,
        capped: false,
        items: [
          { id: "t1", title: "Visita técnica Carlos", dueDate: atLocal(NOW, TZ, 1, 9), leadName: "Carlos Lima" },
          // Discreet mode can only redact names of LINKED leads.
          { id: "t2", title: "Enviar contrato Carlos", dueDate: atLocal(NOW, TZ, 1, 10), leadName: "Carlos Lima" },
        ],
      },
      ...over,
    },
  };
}

describe("fim do dia (§4.7)", () => {
  test("golden completo com 'Pegar' para o único repasse sem dono", () => {
    const out = formatEveningReport(evening(), opts());
    expect(out.text).toBe(
      [
        "🌙 Fechamento · ter 03/11 · Acme Corp",
        "🆕 9 leads criados · 🏆 2 ganhos (R$ 9.120) · ❌ 1 perdido",
        "✅ 6 tarefas concluídas · 3 ficaram para amanhã",
        "🔁 1 repasse ainda sem dono: Ana Reis (reclamação, 3h esperando) ⚠️",
        "🤖 IA: 41 execuções · custo R$ 0,37 hoje · R$ 6,80 no mês",
        "<blockquote expandable>Amanhã",
        "09:00 Visita técnica Carlos · 10:00 Enviar contrato Carlos</blockquote>",
      ].join("\n"),
    );
    expect(out.keyboard).toEqual([
      [{ text: "🔁 Pegar Ana Reis", callback_data: "ah:h77" }],
      [{ text: "🔗 Abrir CRM", url: "https://app.example.test/app/painel" }],
    ]);
  });

  test("sem inbox:reply, ou mais de um repasse: sem botão 'Pegar'", () => {
    expect(formatEveningReport(evening({}, false), opts()).keyboard).toHaveLength(1);
    const two = evening({
      ownerlessHandoffs: {
        count: 2,
        capped: false,
        items: [
          { id: "a", leadName: "Ana", createdAt: NOW },
          { id: "b", leadName: "Bia", createdAt: NOW },
        ],
      },
    });
    const out = formatEveningReport(two, opts());
    expect(out.text).toContain("🔁 2 repasses ainda sem dono ⚠️");
    expect(out.keyboard).toHaveLength(1);
  });

  test("discreto: iniciais no texto e no botão; agente sem bloco de IA", () => {
    const out = formatEveningReport(evening({ ai: null }), opts({ discreet: true }));
    expect(out.text).not.toMatch(/Ana Reis|Carlos/);
    expect(out.text).toContain("A. R. (reclamação, 3h esperando)");
    expect(out.text).not.toContain("🤖 IA:");
    expect(out.keyboard[0]).toEqual([{ text: "🔁 Pegar A. R.", callback_data: "ah:h77" }]);
  });
});

describe("revisão F2 — lote 1", () => {
  test("#1 discreto mascara dígitos em títulos de tarefa, motivos e canais", () => {
    const out = formatMorningReport(
      morning({
        handoffs: {
          count: 1, capped: false, oldestAt: NOW - 40 * MIN,
          items: [{ id: "h1", leadName: "Pedro Nunes", reason: "boleto do CPF 123.456.789-00", createdAt: NOW - 40 * MIN }],
        },
        tasksToday: {
          count: 1, capped: false,
          items: [{ id: "t1", title: "Ligar 11 98765-4321 sobre o contrato", dueDate: at(10), leadName: "Pedro Nunes" }],
        },
        channels: { total: 1, down: ["WhatsApp 5511912345678"] },
      }),
      opts({ discreet: true }),
    );
    expect(out.text).not.toMatch(/98765|123\.456|912345/);
    expect(out.text).toContain("Ligar •••4321 sobre o contrato");
    expect(out.text).toContain("🔴 Fora do ar: WhatsApp •••5678");
    // Modo completo não mascara.
    expect(formatMorningReport(morning({ channels: { total: 1, down: ["WhatsApp 5511912345678"] } }), opts()).text).toContain(
      "WhatsApp 5511912345678",
    );
  });

  test("#3 contagem incerta (leitura no teto) vira 'N+', nunca um N seco", () => {
    const out = formatMorningReport(
      morning({ unread: { count: 0, capped: true }, tasksOverdue: { count: 0, capped: true, items: [] } }, "own"),
      opts(),
    );
    expect(out.text).toContain("💬 0+ conversas não lidas");
    expect(out.text).toContain("· 0+ atrasadas");
  });

  test("#5 segunda-feira sem fim de semana: rótulo 'desde sexta 18h'", () => {
    const out = formatMorningReport(
      morning({ newLeads: { count: 3, capped: false, mine: 0, sinceLabel: "sexta 18h", items: [] } }),
      opts(),
    );
    expect(out.text).toContain("🆕 3 leads desde sexta 18h (0 seus)");
  });
});

describe("greetingName", () => {
  test("usa o primeiro nome do membro", async () => {
    const { greetingName } = await import("./executiveReport");
    expect(greetingName({ memberName: "Eric Milfont" })).toBe(", Eric");
  });
  test("nome que é e-mail cai no primeiro nome do Telegram, nunca '[e-mail]'", async () => {
    const { greetingName } = await import("./executiveReport");
    expect(greetingName({ memberName: "eric@milfont.net", firstName: "Eric" })).toBe(", Eric");
    expect(greetingName({ memberName: "eric@milfont.net" })).toBe("");
    expect(greetingName({ memberName: "eric@milfont.net" })).not.toContain("e-mail");
  });
});
