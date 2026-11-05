import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_TAG, BOT_TAG_MAX_CHARS } from "../../convex/lib/botGuard";
import {
  FOLLOW_UP_MAX_DAILY_CAP,
  aiSectionOrder,
  botGuardFromProfile,
  botGuardToPatch,
  conversationFromProfile,
  conversationToPatch,
  conversationWarnings,
  customizationToPatch,
  debounceWarning,
  followUpFromProfile,
  followUpResetDefaults,
  followUpToPatch,
  handoffFromProfile,
  handoffToPatch,
  modeFromProfile,
  nextMode,
  personaFromTexts,
  personaToPatch,
  pipelineFromProfile,
  pipelineToPatch,
  readDebounceSeconds,
  readFollowUpDailyCap,
  readFollowUpHour,
  readFollowUpMaxChain,
  readReplyLimit,
  replyLimitWarning,
  scheduleFromProfile,
  scheduleToPatch,
  validateBotGuard,
  validateCustomization,
  validateFollowUp,
  validateConversation,
  type CustomizationForms,
} from "./attendantConfig";

const ok = (value: number | undefined) => ({ ok: true, value });

describe("readDebounceSeconds", () => {
  it("vazio mantém o padrão do servidor", () => {
    expect(readDebounceSeconds("")).toEqual(ok(undefined));
    expect(readDebounceSeconds("   ")).toEqual(ok(undefined));
  });
  it("aceita 1 e 120", () => {
    expect(readDebounceSeconds("1")).toEqual(ok(1));
    expect(readDebounceSeconds("120")).toEqual(ok(120));
  });
  it("rejeita 0, 121, decimal e texto com a mensagem de hoje", () => {
    const msg = "Agrupar mensagens por: use um número inteiro de segundos entre 1 e 120.";
    for (const raw of ["0", "121", "2.5", "abc", "-3"]) {
      expect(readDebounceSeconds(raw)).toEqual({ ok: false, message: msg });
    }
  });
});

describe("debounceWarning", () => {
  it("avisa só acima de 30s", () => {
    expect(debounceWarning("30")).toBeNull();
    expect(debounceWarning("31")).toBe("Agrupar por 31s: as respostas vão demorar mais para sair.");
    expect(debounceWarning("")).toBeNull();
    expect(debounceWarning("x")).toBeNull();
  });
});

describe("readReplyLimit / replyLimitWarning", () => {
  it("vazio mantém o padrão; 0 é sem limite (válido)", () => {
    expect(readReplyLimit("", "X")).toEqual(ok(undefined));
    expect(readReplyLimit("0", "X")).toEqual(ok(0));
    expect(readReplyLimit("20", "X")).toEqual(ok(20));
  });
  it("rejeita negativo e fracionário com o rótulo", () => {
    const msg = "Por hora: use um número inteiro maior ou igual a zero (0 = sem limite).";
    expect(readReplyLimit("-1", "Por hora")).toEqual({ ok: false, message: msg });
    expect(readReplyLimit("1.5", "Por hora")).toEqual({ ok: false, message: msg });
  });
  it("avisa sem limite (0) e valores acima de 100", () => {
    expect(replyLimitWarning("0", "Por hora")).toBe(
      "Por hora: sem limite — a IA responde indefinidamente. Só para testes.",
    );
    expect(replyLimitWarning("101", "Por hora")).toBe(
      "Por hora: 101 é alto demais para servir de limite.",
    );
    expect(replyLimitWarning("100", "Por hora")).toBeNull();
    expect(replyLimitWarning("-1", "Por hora")).toBeNull();
    expect(replyLimitWarning("", "Por hora")).toBeNull();
  });
});

describe("follow-up readers", () => {
  it("encadeamento de 1 a 5", () => {
    expect(readFollowUpMaxChain("")).toEqual(ok(undefined));
    expect(readFollowUpMaxChain("5")).toEqual(ok(5));
    expect(readFollowUpMaxChain("0").ok).toBe(false);
    expect(readFollowUpMaxChain("6")).toEqual({
      ok: false,
      message: "Máximo de follow-ups seguidos: use um número inteiro entre 1 e 5.",
    });
  });
  it("hora de 0 a 24", () => {
    expect(readFollowUpHour("0", "Início")).toEqual(ok(0));
    expect(readFollowUpHour("24", "Início")).toEqual(ok(24));
    expect(readFollowUpHour("25", "Início")).toEqual({
      ok: false,
      message: "Início: use uma hora inteira entre 0 e 24.",
    });
    expect(readFollowUpHour("-1", "Início").ok).toBe(false);
  });
  it("teto diário de 0 a 500", () => {
    expect(readFollowUpDailyCap("0")).toEqual(ok(0));
    expect(readFollowUpDailyCap("500")).toEqual(ok(FOLLOW_UP_MAX_DAILY_CAP));
    expect(readFollowUpDailyCap("501")).toEqual({
      ok: false,
      message: "Teto diário de follow-ups: use um número inteiro entre 0 e 500 (0 = sem teto).",
    });
    expect(readFollowUpDailyCap("")).toEqual(ok(undefined));
  });
});

describe("validateFollowUp", () => {
  const base = followUpFromProfile({});
  it("padrão (campos vazios) é válido: janela 8–20", () => {
    expect(validateFollowUp(base)).toEqual({ ok: true });
  });
  it("janela início >= fim é erro, inclusive igual", () => {
    const msg = "Follow-ups: a janela de envio precisa começar antes de terminar.";
    expect(validateFollowUp({ ...base, quietStart: "20", quietEnd: "8" })).toEqual({
      ok: false,
      message: msg,
    });
    expect(validateFollowUp({ ...base, quietStart: "10", quietEnd: "10" })).toEqual({
      ok: false,
      message: msg,
    });
  });
  it("usa o padrão para o lado vazio ao comparar a janela", () => {
    expect(validateFollowUp({ ...base, quietStart: "21" }).ok).toBe(false); // 21 >= 20
    expect(validateFollowUp({ ...base, quietEnd: "7" }).ok).toBe(false); // 8 >= 7
    expect(validateFollowUp({ ...base, quietStart: "9", quietEnd: "21" })).toEqual({ ok: true });
  });
  it("reporta o primeiro erro na ordem de sempre", () => {
    const r = validateFollowUp({ ...base, maxChain: "9", quietStart: "99" });
    expect(r.ok === false && r.message).toContain("Máximo de follow-ups seguidos");
  });
});

describe("validateConversation", () => {
  const base = conversationFromProfile({});
  it("padrão é válido", () => expect(validateConversation(base)).toEqual({ ok: true }));
  it("ordem: conversa, hora, agrupamento", () => {
    const r1 = validateConversation({ ...base, maxPerConversation: "-1", maxPerHour: "-1" });
    expect(r1.ok === false && r1.message).toMatch(/^Máx\. respostas por conversa:/);
    const r2 = validateConversation({ ...base, maxPerHour: "x", debounceSeconds: "0" });
    expect(r2.ok === false && r2.message).toMatch(/^Máx\. respostas por hora:/);
    const r3 = validateConversation({ ...base, debounceSeconds: "0" });
    expect(r3.ok === false && r3.message).toMatch(/^Agrupar mensagens por:/);
  });
  it("teto 0 (sem limite) é válido e vira 0 no patch", () => {
    const f = { ...base, maxPerConversation: "0" };
    expect(validateConversation(f)).toEqual({ ok: true });
    expect(conversationToPatch(f).maxRepliesPerConversation).toBe(0);
  });
  it("avisos dos tetos e do agrupamento", () => {
    const w = conversationWarnings({ ...base, maxPerHour: "0", debounceSeconds: "60" });
    expect(w.limits).toHaveLength(1);
    expect(w.debounce).toHaveLength(1);
  });
});

describe("proteção contra robôs", () => {
  it("ausente = ligada com a etiqueta padrão; só enabled:false desliga", () => {
    expect(botGuardFromProfile({})).toEqual({ enabled: true, tag: DEFAULT_BOT_TAG });
    expect(botGuardFromProfile({ botGuard: { enabled: false } }).enabled).toBe(false);
  });
  it("etiqueta inválida bloqueia só com a proteção ligada", () => {
    const r = validateBotGuard({ enabled: true, tag: "a,b" });
    expect(r).toEqual({
      ok: false,
      message: "Proteção contra robôs: A etiqueta não pode conter vírgula",
      field: "botGuardTag",
      fieldError: "A etiqueta não pode conter vírgula",
    });
    expect(validateBotGuard({ enabled: true, tag: "" }).ok).toBe(false);
    expect(validateBotGuard({ enabled: true, tag: "x".repeat(BOT_TAG_MAX_CHARS + 1) }).ok).toBe(
      false,
    );
    expect(validateBotGuard({ enabled: false, tag: "a,b" })).toEqual({ ok: true });
  });
  it("patch usa a etiqueta aparada, ou o padrão se inválida e desligada", () => {
    expect(botGuardToPatch({ enabled: true, tag: "  bot  " })).toEqual({
      botGuard: { enabled: true, tag: "bot" },
    });
    expect(botGuardToPatch({ enabled: false, tag: "a,b" })).toEqual({
      botGuard: { enabled: false, tag: DEFAULT_BOT_TAG },
    });
  });
});

describe("persona e conhecimento (safety net)", () => {
  it("toPatch NUNCA inclui os textos se não foram carregados", () => {
    const f = personaFromTexts(undefined);
    expect(f.loaded).toBe(false);
    expect(personaToPatch(f)).toEqual({});
    expect(personaToPatch({ systemPrompt: "x", knowledge: "y", loaded: false })).toEqual({});
  });
  it("carregados: manda ambos, inclusive vazios de propósito", () => {
    expect(personaToPatch(personaFromTexts({ systemPrompt: "s", knowledge: null }))).toEqual({
      systemPrompt: "s",
      knowledge: "",
    });
  });
  it("o patch composto herda a regra", () => {
    const patch = customizationToPatch({ ...forms(), persona: personaFromTexts(undefined) });
    expect("systemPrompt" in patch).toBe(false);
    expect("knowledge" in patch).toBe(false);
    const withTexts = customizationToPatch({
      ...forms(),
      persona: personaFromTexts({ systemPrompt: "s", knowledge: "k" }),
    });
    expect(withTexts).toMatchObject({ systemPrompt: "s", knowledge: "k" });
  });
});

describe("horário, repasse e funil", () => {
  it("horário padrão 9–18 em São Paulo", () => {
    expect(scheduleToPatch(scheduleFromProfile({}))).toEqual({
      schedule: { timezone: "America/Sao_Paulo", startHour: 9, endHour: 18 },
    });
  });
  it("palavras-chave: separa por vírgula, apara e ignora vazias", () => {
    expect(handoffToPatch({ keywords: " humano, , atendente ,," })).toEqual({
      handoffKeywords: ["humano", "atendente"],
    });
    expect(handoffFromProfile({ handoffKeywords: ["a", "b"] }).keywords).toBe("a, b");
  });
  it("funil vazio com allowMoveStages padrão vira null; desligar o switch é restrição real", () => {
    expect(pipelineToPatch(pipelineFromProfile({}))).toEqual({ pipelineConfig: null });
    const r = pipelineToPatch({ ...pipelineFromProfile({}), allowMoveStages: false });
    expect(r.pipelineConfig).toMatchObject({ allowMoveStages: false, qualifyThreshold: 3 });
  });
  it("funil preenchido manda só o que existe", () => {
    const r = pipelineToPatch({
      ...pipelineFromProfile({}),
      boardId: "b1",
      advanceRules: "  regra ",
      captureFields: ["cpf"],
    });
    expect(r.pipelineConfig).toMatchObject({
      boardId: "b1",
      initialStageId: undefined,
      advanceRules: "regra",
      captureFields: ["cpf"],
    });
  });
});

describe("follow-up: patch e modo", () => {
  it("ausente = draft; campos vazios viram undefined no patch", () => {
    const f = followUpFromProfile({});
    expect(f.mode).toBe("draft");
    expect(followUpToPatch(f).followUps).toEqual({
      mode: "draft",
      maxChain: undefined,
      quietStartHour: undefined,
      quietEndHour: undefined,
      dailyCap: undefined,
      eventDateField: undefined,
    });
  });
  it("carrega do perfil e 'usar padrões' limpa tudo menos o modo", () => {
    const f = followUpFromProfile({
      followUps: {
        mode: "send",
        maxChain: 3,
        quietStartHour: 9,
        quietEndHour: 18,
        dailyCap: 0,
        eventDateField: "d",
      },
    });
    expect(f).toMatchObject({ mode: "send", maxChain: "3", dailyCap: "0", eventDateField: "d" });
    expect(followUpResetDefaults(f)).toEqual({
      mode: "send",
      maxChain: "",
      quietStart: "",
      quietEnd: "",
      dailyCap: "",
      eventDateField: "",
    });
  });
  it("modo alterna entre sugerir e responder sozinha", () => {
    expect(modeFromProfile({})).toBe("suggest");
    expect(nextMode("suggest")).toBe("autopilot");
    expect(nextMode("autopilot")).toBe("suggest");
  });
});

describe("validateCustomization", () => {
  it("formulário padrão é válido", () =>
    expect(validateCustomization(forms())).toEqual({ ok: true }));
  it("ordem: conversa antes de follow-up antes da proteção contra robôs", () => {
    const f = forms();
    f.botGuard = { enabled: true, tag: "" };
    f.followUp = { ...f.followUp, maxChain: "9" };
    f.conversation = { ...f.conversation, debounceSeconds: "500" };
    let r = validateCustomization(f);
    expect(r.ok === false && r.message).toMatch(/^Agrupar mensagens por/);
    f.conversation = conversationFromProfile({});
    r = validateCustomization(f);
    expect(r.ok === false && r.message).toMatch(/^Máximo de follow-ups/);
    f.followUp = followUpFromProfile({});
    r = validateCustomization(f);
    expect(r.ok === false && r.message).toMatch(/^Proteção contra robôs/);
  });
});

describe("aiSectionOrder", () => {
  const FULL = ["activation", "featureToggles", "bridgeAi", "attendant", "usage", "privacy"];
  it("inativa: só o wizard", () => {
    expect(aiSectionOrder({ active: false, hasAttendant: false })).toEqual(["wizard"]);
    expect(aiSectionOrder({ active: false, hasAttendant: true })).toEqual(["wizard"]);
  });
  it("ativa sem atendente: só o wizard", () => {
    expect(aiSectionOrder({ active: true, hasAttendant: false })).toEqual(["wizard"]);
  });
  it("ativa com atendente: cartões na ordem de sempre", () => {
    expect(aiSectionOrder({ active: true, hasAttendant: true })).toEqual(FULL);
  });
});

function forms(): CustomizationForms {
  const p = {};
  return {
    persona: personaFromTexts(undefined),
    schedule: scheduleFromProfile(p),
    handoff: handoffFromProfile(p),
    conversation: conversationFromProfile(p),
    botGuard: botGuardFromProfile(p),
    followUp: followUpFromProfile(p),
    pipeline: pipelineFromProfile(p),
  };
}
