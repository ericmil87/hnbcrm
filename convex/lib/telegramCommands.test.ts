import { describe, expect, test } from "vitest";
import {
  KEYBOARD_LABELS,
  LIST_CAP,
  TELEGRAM_COMMANDS,
  buildFocusPicker,
  buildFooter,
  buildHandoffRow,
  buildLeadsPage,
  buildTaskRow,
  daysAgo,
  fetchLimit,
  handoffAge,
  parseCommandCallback,
  resolveCommandName,
} from "./telegramCommands";
import { parseCommand } from "./telegramCore";
import type { CardContext } from "./telegramNotifications";

const NOW = Date.UTC(2026, 10, 3, 15, 0);
const card = (over: Partial<CardContext> = {}): CardContext => ({
  orgName: "Acme Corp",
  timezone: "America/Sao_Paulo",
  currency: "BRL",
  appBaseUrl: "https://app.example.test",
  discreet: false,
  now: NOW,
  ...over,
});

describe("resolveCommandName", () => {
  test("comando conhecido, alias, desconhecido e rótulo do teclado", () => {
    expect(resolveCommandName(parseCommand("/repasses"), "/repasses")).toBe("repasses");
    expect(resolveCommandName(parseCommand("/help"), "/help")).toBe("ajuda");
    expect(resolveCommandName(parseCommand("/Tarefas@hnbcrm_bot"), "")).toBe("tarefas");
    expect(resolveCommandName(parseCommand("/banana"), "/banana")).toBeNull();
    for (const [label, cmd] of Object.entries(KEYBOARD_LABELS)) {
      expect(resolveCommandName(null, ` ${label} `)).toBe(cmd);
    }
    expect(resolveCommandName(null, "oi")).toBeNull();
  });
  test("lista do setMyCommands", () => {
    expect(TELEGRAM_COMMANDS.map((c) => c.command)).toEqual([
      "hoje", "repasses", "tarefas", "leads", "foco", "novo", "pausar", "org", "teclado", "tour", "ajuda", "sair",
    ]);
  });
});

describe("parseCommandCallback", () => {
  test("aceita a gramática e recusa o resto", () => {
    expect(parseCommandCallback("cmd:repasses")).toEqual({ kind: "cmd", command: "repasses" });
    expect(parseCommandCallback("cmd:sair")).toBeNull();
    expect(parseCommandCallback("pg:repasses:10")).toEqual({ kind: "page", command: "repasses", offset: 10 });
    expect(parseCommandCallback("pg:repasses:7")).toBeNull();
    expect(parseCommandCallback("pg:repasses:50")).toBeNull();
    expect(parseCommandCallback("pg:hoje:10")).toBeNull();
    expect(parseCommandCallback("fc:off")).toEqual({ kind: "focusOff" });
    expect(parseCommandCallback("fc:k57abc")).toEqual({ kind: "focus", conversationId: "k57abc" });
    expect(parseCommandCallback("mu:1h")).toEqual({ kind: "mute", mode: "1h" });
    expect(parseCommandCallback("mu:2h")).toBeNull();
    expect(parseCommandCallback("org:abc123")).toEqual({ kind: "org", linkId: "abc123" });
    expect(parseCommandCallback("ah:abc")).toBeNull();
    expect(parseCommandCallback(undefined)).toBeNull();
  });
});

describe("formatação", () => {
  test("idade do repasse", () => {
    expect(handoffAge(NOW - 30_000, NOW)).toBe("1 min");
    expect(handoffAge(NOW - 42 * 60_000, NOW)).toBe("42 min");
    expect(handoffAge(NOW - 90 * 60_000, NOW)).toBe("1h");
    expect(handoffAge(NOW - 3 * 3600_000, NOW)).toBe("3h ⚠️");
    expect(handoffAge(NOW - 50 * 3600_000, NOW)).toBe("2 d ⚠️");
  });
  test("há X dias", () => {
    expect(daysAgo(NOW, NOW)).toBe("hoje");
    expect(daysAgo(NOW - 86_400_000, NOW)).toBe("há 1 dia");
    expect(daysAgo(NOW - 5 * 86_400_000, NOW)).toBe("há 5 dias");
  });
  test("limite de leitura da página", () => {
    expect(fetchLimit(0)).toBe(11);
    expect(fetchLimit(10)).toBe(21);
    expect(fetchLimit(40)).toBe(LIST_CAP + 1);
  });
  test("rodapé: Mais 10 → ou link do CRM no teto", () => {
    expect(buildFooter("repasses", 0, "u").keyboard).toEqual([[{ text: "Mais 10 →", callback_data: "pg:repasses:10" }]]);
    expect(buildFooter("repasses", 40, "https://crm").text).toBe("Mais de 50 — abra o CRM.");
  });
});

describe("linhas", () => {
  test("repasse: nome, canal, motivo, idade e botões", () => {
    const row = buildHandoffRow(
      card({ lead: { id: "l1", title: "Pedro Nunes" }, conversation: { id: "c1", channel: "whatsapp" } }),
      { handoffId: "h1", conversationId: "c1", reason: "preço <b>", createdAt: NOW - 42 * 60_000 },
      1,
    );
    expect(row.text).toBe("1. <b>Pedro Nunes</b> · WhatsApp · preço &lt;b&gt; · 42 min");
    expect(row.keyboard).toEqual([[
      { text: "✅ Aceitar", callback_data: "ah:h1" },
      { text: "🤖 Instruir", callback_data: "ia:c1" },
    ]]);
  });
  test("repasse discreto: iniciais e sem motivo de grupo sem lead", () => {
    const row = buildHandoffRow(
      card({ discreet: true, lead: { id: "l1", title: "Pedro Nunes" }, conversation: { id: "c1", channel: "instagram" } }),
      { handoffId: "h1", reason: "Pedro Nunes ligou 11 98765-4321", createdAt: NOW - 3 * 3600_000 },
      2,
    );
    expect(row.text).toContain("2. <b>P. N.</b> · Instagram");
    expect(row.text).not.toContain("Pedro");
    expect(row.text).not.toContain("98765");
    const group = buildHandoffRow(card({ discreet: true }), { handoffId: "h2", reason: "segredo", subjectLabel: "Grupo Vendas", createdAt: NOW }, 1);
    expect(group.text).toBe("1. <b>G. V.</b> · 1 min");
    expect(group.keyboard[0]).toHaveLength(1);
  });
  test("tarefa: atrasada e com prazo", () => {
    const fmt = (at: number) => `T${at}`;
    expect(buildTaskRow(card(), { taskId: "t1", title: "Ligar", dueDate: NOW - 1000 }, 1, fmt).text).toBe(`1. <b>Ligar</b>\n⚠️ atrasada desde T${NOW - 1000}`);
    expect(buildTaskRow(card(), { taskId: "t1", title: "Ligar" }, 1, fmt).text).toContain("sem prazo");
    expect(buildTaskRow(card(), { taskId: "t1", title: "Ligar", dueDate: NOW + 1 }, 3, fmt).keyboard).toEqual([[
      { text: "✅ Concluir", callback_data: "ct:t1" },
      { text: "⏰ Adiar 1h", callback_data: "sz1:t1" },
    ]]);
  });
  test("leads: linha, botões url e Mais", () => {
    const page = buildLeadsPage({
      header: "H",
      rows: [{ leadId: "L1", title: "Maria Souza", stageName: "Proposta", value: 4800, lastActivityAt: NOW - 3 * 86_400_000 }],
      offset: 0, discreet: false, currency: "BRL", now: NOW, appBaseUrl: "https://a.test", hasMore: true,
    });
    expect(page.text).toMatch(/^H\n1\. <b>Maria Souza<\/b> · Proposta · R\$.*4\.800 · há 3 dias$/);
    expect(page.keyboard[0]).toEqual([{ text: "🔗 1", url: "https://a.test/app/pipeline?lead=L1" }]);
    expect(page.keyboard[1]).toEqual([{ text: "Mais 10 →", callback_data: "pg:leads:10" }]);
  });
  test("picker de foco: um botão por linha, callback fc:", () => {
    const p = buildFocusPicker({ rows: [{ conversationId: "c1", title: "Carlos Lima", channel: "whatsapp" }], offset: 0, discreet: true, hasMore: false, appBaseUrl: "u" });
    expect(p.keyboard).toEqual([[{ text: "C. L. · WhatsApp", callback_data: "fc:c1" }]]);
  });
});
