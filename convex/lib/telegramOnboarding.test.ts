import { describe, expect, test } from "vitest";
import {
  appendFirstTimeTip,
  buildTourCard,
  buildWelcomeCard,
  parseOnboardingCallback,
  tipFor,
} from "./telegramOnboarding";

describe("cartões do tour", () => {
  test("cartão 0: boas-vindas com nome e org escapados", () => {
    const c = buildWelcomeCard({ memberName: "Eric <b>", orgName: "Acme & Co" });
    expect(c.text).toBe(
      "👋 Conectado como <b>Eric &lt;b&gt;</b> · Acme &amp; Co\nSou sua assistente executiva no HNBCRM. Em 4 passos você entende tudo.",
    );
    expect(c.keyboard).toEqual([[{ text: "Próximo →", callback_data: "ob:1" }]]);
  });

  test("cartão 0 com várias orgs", () => {
    const c = buildWelcomeCard({ memberName: "Eric", orgName: "Acme", otherOrgNames: ["Terra"] });
    expect(c.text).toContain("também está conectado a <b>Terra</b>");
  });

  test("cartões 1 a 4 (golden)", () => {
    const c1 = buildTourCard(1);
    expect(c1.text).toBe(
      "<b>1/4 · O que chega aqui</b>\n" +
        "🔔 Repasses da IA · 💬 mensagens das conversas que você atende\n" +
        "📌 tarefas · 🆕 leads · 🔴 alertas de canal · ☀️🌙 relatório de manhã e de noite\n" +
        'Cada cartão vem com resumo e botões. "Ver tudo" abre o histórico.',
    );
    expect(c1.keyboard).toEqual([[{ text: "←", callback_data: "ob:back" }, { text: "Próximo →", callback_data: "ob:2" }]]);
    const c2 = buildTourCard(2);
    expect(c2.text).toContain("2/4 · Dois modos");
    expect(c2.text).toContain("Começar em:");
    expect(c2.keyboard[0]).toEqual([
      { text: "💡 Sugestão", callback_data: "ob:mode:suggest" },
      { text: "🤖 Automático", callback_data: "ob:mode:auto" },
    ]);
    const c3 = buildTourCard(3);
    expect(c3.text).toContain("3/4 · Como falar comigo");
    expect(c3.keyboard[0][1]).toEqual({ text: "Próximo →", callback_data: "ob:4" });
    const c4 = buildTourCard(4);
    expect(c4.text).toBe("<b>4/4 · Teste agora</b>");
    expect(c4.keyboard).toEqual([
      [{ text: "☀️ Ver meu /hoje", callback_data: "cmd:hoje" }, { text: "🔁 Repasses pendentes", callback_data: "cmd:repasses" }],
      [{ text: "Terminar", callback_data: "ob:done" }],
    ]);
  });

  test("callbacks cabem em 64 bytes e card inexistente lança", () => {
    for (let i = 1; i <= 4; i++) {
      for (const b of buildTourCard(i).keyboard.flat()) {
        expect(new TextEncoder().encode((b as { callback_data: string }).callback_data).length).toBeLessThanOrEqual(64);
      }
    }
    expect(() => buildTourCard(5)).toThrow();
    expect(() => buildTourCard(0)).toThrow();
  });
});

describe("parseOnboardingCallback", () => {
  test("gramática", () => {
    expect(parseOnboardingCallback("ob:3")).toEqual({ kind: "step", step: 3 });
    expect(parseOnboardingCallback("ob:5")).toBeNull();
    expect(parseOnboardingCallback("ob:back")).toEqual({ kind: "back" });
    expect(parseOnboardingCallback("ob:done")).toEqual({ kind: "done" });
    expect(parseOnboardingCallback("ob:mode:auto")).toEqual({ kind: "mode", mode: "auto" });
    expect(parseOnboardingCallback("ob:mode:x")).toBeNull();
    expect(parseOnboardingCallback("ah:1")).toBeNull();
    expect(parseOnboardingCallback(undefined)).toBeNull();
  });
});

describe("dicas da primeira vez", () => {
  test("uma vez por tipo e idempotente", () => {
    const first = appendFirstTimeTip({ type: "handoff_requested" });
    expect(first.line).toBe("💡 Dica: toque em Ver tudo para o histórico.");
    expect(first.tipsShown).toEqual(["handoff"]);
    const again = appendFirstTimeTip({ type: "handoff_requested", tipsShown: first.tipsShown });
    expect(again.line).toBeUndefined();
    expect(again.tipsShown).toEqual(["handoff"]);
  });

  test("task_* compartilham a dica; tipo sem dica não grava nada", () => {
    const a = appendFirstTimeTip({ type: "task_due_soon" });
    expect(a.line).toBe("💡 Dica: Adiar empurra o lembrete; Concluir fecha a tarefa.");
    expect(appendFirstTimeTip({ type: "task_overdue", tipsShown: a.tipsShown }).line).toBeUndefined();
    expect(appendFirstTimeTip({ type: "group_digest", tipsShown: ["x"] })).toEqual({ tipsShown: ["x"] });
    expect(tipFor("campaign_paused")).toBeNull();
  });

  test("não muta o array de entrada; new_message e rascunho", () => {
    const input = ["handoff"];
    const r = appendFirstTimeTip({ type: "new_message", tipsShown: input });
    expect(input).toEqual(["handoff"]);
    expect(r.tipsShown).toEqual(["handoff", "new_message"]);
    expect(r.line).toBe("💡 Dica: responda a este cartão para falar sobre essa conversa.");
    expect(appendFirstTimeTip({ type: "ai_draft_pending" }).line).toBe("💡 Dica: Regenerar pede o motivo e gera outro rascunho.");
  });
});
