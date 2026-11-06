import { describe, expect, it } from "vitest";
import {
  availableEngines,
  resolveTranslationSettings,
  sanitizeGlossary,
  shouldTranslateDisplay,
  shouldTranslateInbound,
  shouldTranslateOutbound,
  translatableText,
  translationEnabledForOrg,
} from "./translationGate";
import {
  effectiveSourceLanguage,
  nextConversationTranslation,
  resolveTargetLanguage,
} from "./translationLang";
import { checkTranslation, parseLlmTranslationReply, protectText, restoreText } from "./translationText";
import { outboundTranslationInsertFields, shouldScheduleMessageTranslation } from "./translationOps";
import { buildTranslationSystemPrompt, translationMaxTokens } from "./translationCore";
import { fixedAgentLanguage } from "./languages";

const aiOn = { enabled: true, autoAssign: false, handoffThreshold: 0.5, lgpdAck: { acceptedAt: 1, acceptedBy: "m" as any } };
function org(opts: { module?: boolean; ai?: boolean; translation?: Record<string, unknown> } = {}): any {
  return {
    settings: {
      timezone: "America/Sao_Paulo",
      currency: "BRL",
      ...(opts.module !== undefined ? { modules: { translation: opts.module } } : {}),
      ...(opts.ai ? { aiConfig: aiOn } : {}),
      ...(opts.translation ? { translation: opts.translation } : {}),
    },
  };
}
const conv = (extra: Record<string, unknown> = {}): any => ({ channel: "whatsapp", ...extra });
const msg = (extra: Record<string, unknown> = {}): any => ({
  direction: "inbound",
  senderType: "contact",
  isInternal: false,
  contentType: "text",
  content: "Hola, quiero saber el precio del apartamento",
  ...extra,
});
const outMsg = (extra: Record<string, unknown> = {}): any =>
  msg({ direction: "outbound", senderType: "human", content: "Olá, o valor é R$ 500 mil", ...extra });

describe("translationGate", () => {
  it("módulo ausente = desligado", () => {
    expect(translationEnabledForOrg(org())).toBe(false);
    expect(translationEnabledForOrg(org({ module: false }))).toBe(false);
    expect(translationEnabledForOrg(org({ module: true }))).toBe(true);
  });

  it("defaults das configurações", () => {
    expect(resolveTranslationSettings(org())).toEqual({
      provider: "auto",
      teamLanguage: "pt-BR",
      inboundMode: "auto",
      outboundMode: "quick_review",
      skipWhenSameLanguage: true,
      tone: "neutral",
      glossary: [],
    });
  });

  it("glossário: corta, dedup e teto", () => {
    expect(sanitizeGlossary(["  Mar Azul ", "mar azul", "", "X"])).toEqual(["Mar Azul", "X"]);
    expect(sanitizeGlossary(Array.from({ length: 150 }, (_, i) => `t${i}`))).toHaveLength(100);
  });

  it("cadeia de provedores: self-hosted primeiro, LLM só com IA ativa", () => {
    const lt = { libretranslateUrl: "http://lt:5000" };
    expect(availableEngines(org({ module: true, ai: true }), lt)).toEqual(["libretranslate", "llm"]);
    expect(availableEngines(org({ module: true }), lt)).toEqual(["libretranslate"]);
    expect(availableEngines(org({ module: true, ai: true }), {})).toEqual(["llm"]);
    expect(availableEngines(org({ module: true }), {})).toEqual([]);
    expect(availableEngines(org({ module: true, ai: true, translation: { provider: "llm" } }), lt)).toEqual(["llm"]);
    expect(
      availableEngines(org({ module: true, ai: true, translation: { provider: "libretranslate" } }), lt)
    ).toEqual(["libretranslate"]);
  });

  it("texto traduzível: texto e legenda, nunca placeholder nem arquivo", () => {
    expect(translatableText(msg())).toBeTruthy();
    expect(translatableText(msg({ contentType: "image", content: "[imagem]" }))).toBeUndefined();
    expect(translatableText(msg({ contentType: "image", content: "Mira esta foto por favor" }))).toBeTruthy();
    expect(translatableText(msg({ contentType: "file", content: "contrato.pdf" }))).toBeUndefined();
    expect(translatableText(msg({ contentType: "audio", content: "[áudio]" }))).toBeUndefined();
  });

  it("inbound: recusas", () => {
    const o = org({ module: true });
    expect(shouldTranslateInbound({ org: org(), conversation: conv(), message: msg() })).toEqual({ ok: false, reason: "modulo_desligado" });
    expect(shouldTranslateInbound({ org: o, conversation: conv({ kind: "group" }), message: msg() }).ok).toBe(false);
    expect(shouldTranslateInbound({ org: o, conversation: conv(), message: msg({ isInternal: true }) }).ok).toBe(false);
    expect(shouldTranslateInbound({ org: o, conversation: conv({ translation: { mode: "off" } }), message: msg() }).ok).toBe(false);
    expect(shouldTranslateInbound({ org: o, conversation: conv(), message: msg({ metadata: { deletedByCustomer: true } }) }).ok).toBe(false);
    expect(
      shouldTranslateInbound({ org: o, conversation: conv(), message: msg({ metadata: { translation: { status: "done" } } }) }).ok
    ).toBe(false);
    expect(shouldTranslateInbound({ org: o, conversation: conv(), message: msg({ direction: "outbound" }) }).ok).toBe(false);
    expect(shouldTranslateInbound({ org: o, conversation: conv(), message: msg() })).toEqual({ ok: true });
  });

  it("inbound em modo ask aguarda a escolha da conversa", () => {
    const o = org({ module: true, translation: { inboundMode: "ask" } });
    expect(shouldTranslateInbound({ org: o, conversation: conv(), message: msg() })).toEqual({ ok: false, reason: "aguardando_escolha" });
    expect(shouldTranslateInbound({ org: o, conversation: conv({ translation: { mode: "auto" } }), message: msg() }).ok).toBe(true);
  });

  it("display: só resposta da IA", () => {
    const o = org({ module: true });
    expect(shouldTranslateDisplay({ org: o, conversation: conv(), message: outMsg({ senderType: "ai" }) }).ok).toBe(true);
    expect(shouldTranslateDisplay({ org: o, conversation: conv(), message: outMsg() }).ok).toBe(false);
  });

  it("outbound: recusas e caminho feliz", () => {
    const o = org({ module: true });
    const ok = (message: any, targetLang: string | undefined = "es", c = conv()) =>
      shouldTranslateOutbound({ org: o, conversation: c, message, targetLang });
    expect(ok(outMsg())).toEqual({ ok: true });
    expect(ok(outMsg({ senderType: "ai" })).ok).toBe(false);
    expect(ok(outMsg({ isInternal: true, direction: "internal" })).ok).toBe(false);
    expect(ok(outMsg({ metadata: { template: { name: "x" } } })).ok).toBe(false);
    expect(ok(outMsg({ metadata: { forwarded: true } })).ok).toBe(false);
    expect(ok(outMsg({ metadata: { campaign: { campaignId: "c" } } })).ok).toBe(false);
    expect(ok(outMsg({ metadata: { inboundWelcome: { leadId: "l" } } })).ok).toBe(false);
    expect(ok(outMsg({ metadata: { translation: { status: "done" } } })).ok).toBe(false);
    expect(ok(outMsg({ contentType: "audio", content: "" })).ok).toBe(false);
    expect(ok(outMsg(), "pt-PT").ok).toBe(false); // mesma língua da equipe
    expect(shouldTranslateOutbound({ org: o, conversation: conv(), message: outMsg(), targetLang: undefined }).ok).toBe(false);
    expect(ok(outMsg(), "es", conv({ kind: "group" })).ok).toBe(false);
    expect(shouldTranslateOutbound({ org: org(), conversation: conv(), message: outMsg(), targetLang: "es" }).ok).toBe(false);
  });
});

describe("translationLang", () => {
  it("precedência do idioma de destino", () => {
    expect(resolveTargetLanguage({ conversation: { lang: "fr", mode: "manual" }, contactPreferredLanguage: "es" })).toEqual({ lang: "fr", source: "manual", hintOnly: false });
    expect(resolveTargetLanguage({ conversation: { lang: "en", source: "auto" }, contactPreferredLanguage: "es" }).lang).toBe("en");
    expect(resolveTargetLanguage({ contactPreferredLanguage: "es", lastInboundLang: "en" }).source).toBe("contact");
    expect(resolveTargetLanguage({ lastInboundLang: "en" }).source).toBe("last_inbound");
    expect(resolveTargetLanguage({ phone: "34612345678" })).toEqual({ lang: "es", source: "dial_code", hintOnly: true });
    expect(resolveTargetLanguage({})).toEqual({ source: "none", hintOnly: false });
    expect(resolveTargetLanguage({ conversation: { lang: "es", mode: "off" } })).toEqual({ source: "off", hintOnly: false });
  });

  it("1ª detecção define o idioma da conversa", () => {
    expect(nextConversationTranslation(undefined, { lang: "es", confidence: 0.9 }, 10)).toEqual({
      lang: "es",
      source: "auto",
      detectedAt: 10,
      divergentStreak: 0,
    });
  });

  it("curta / pouco confiante não muda nada", () => {
    expect(nextConversationTranslation({ lang: "es" }, undefined, 1)).toBeUndefined();
    expect(nextConversationTranslation({ lang: "es" }, { lang: "en", confidence: 0.4 }, 1)).toBeUndefined();
    expect(nextConversationTranslation({ lang: "es", divergentStreak: 0 }, { lang: "es", confidence: 0.9 }, 1)).toBeUndefined();
  });

  it("troca só com 2 divergentes consecutivas", () => {
    const one = nextConversationTranslation({ lang: "es", source: "auto" }, { lang: "en", confidence: 0.9 }, 1)!;
    expect(one).toMatchObject({ lang: "es", divergentStreak: 1, candidateLang: "en" });
    const two = nextConversationTranslation(one, { lang: "en", confidence: 0.9 }, 2)!;
    expect(two).toMatchObject({ lang: "en", divergentStreak: 0, detectedAt: 2 });
    expect(two.candidateLang).toBeUndefined();
    // divergente interrompida por uma na língua atual zera a contagem
    const reset = nextConversationTranslation(one, { lang: "es", confidence: 0.9 }, 3)!;
    expect(reset).toMatchObject({ lang: "es", divergentStreak: 0 });
  });

  it("manual e off nunca são sobrescritos pela detecção", () => {
    expect(nextConversationTranslation({ lang: "fr", mode: "manual", source: "manual" }, { lang: "en", confidence: 1 }, 1)).toBeUndefined();
    expect(nextConversationTranslation({ mode: "off" }, { lang: "en", confidence: 1 }, 1)).toBeUndefined();
  });

  it("idioma de origem efetivo: detecção > conversa > dica", () => {
    expect(effectiveSourceLanguage({ detected: { lang: "en", confidence: 0.9 }, conversationLang: "es" })).toBe("en");
    expect(effectiveSourceLanguage({ detected: { lang: "en", confidence: 0.3 }, conversationLang: "es" })).toBe("es");
    expect(effectiveSourceLanguage({ hint: "fr" })).toBe("fr");
    expect(effectiveSourceLanguage({})).toBeUndefined();
  });
});

describe("translationText", () => {
  it("protege e restaura URL, e-mail, telefone, menção e glossário", () => {
    const text = "Veja https://ex.com/a_b e fale com joao@ex.com ou +55 11 99999-8888, @maria. Residencial Mar Azul";
    const p = protectText(text, ["Residencial Mar Azul"]);
    expect(p.text).not.toContain("https://");
    expect(p.text).not.toContain("joao@ex.com");
    expect(p.text).not.toContain("99999");
    expect(p.text).not.toContain("Mar Azul");
    expect(p.text).toContain("⟦U1⟧");
    expect(p.text).toContain("⟦G1⟧");
    const back = restoreText(p.text, p.tokens);
    expect(back).toEqual({ ok: true, text });
  });

  it("restauração falha se um token sumir ou for inventado", () => {
    const p = protectText("link https://ex.com", []);
    expect(restoreText("link", p.tokens).ok).toBe(false);
    expect(restoreText("link ⟦U1⟧ ⟦U9⟧", p.tokens).ok).toBe(false);
    expect(restoreText("enlace ⟦ U1 ⟧", p.tokens)).toEqual({ ok: true, text: "enlace https://ex.com" });
  });

  it("guard aceita tradução fiel", () => {
    expect(checkTranslation("O valor é *R$ 500* 👍 https://ex.com", "El valor es *R$ 500* 👍 https://ex.com")).toEqual({ ok: true });
  });

  it.each([
    ["links", "Veja https://ex.com agora mesmo", "Mira agora mismo"],
    ["números", "São 3 quartos e 2 banheiros", "Son tres cuartos y dos baños"],
    ["emojis", "Obrigado pela visita 🙏🙏", "Gracias por la visita 🙏"],
    ["marcas", "Isso é *muito* importante", "Esto es *muy importante"],
    ["tamanho", "Olá, tudo bem com você hoje?", "Hola"],
    ["vazio", "Olá, tudo bem?", "  "],
  ])("guard reprova %s", (_k, a, b) => {
    expect(checkTranslation(a, b).ok).toBe(false);
  });

  it("parser do JSON do modelo", () => {
    expect(parseLlmTranslationReply('{"lang":"es","text":"Hola"}')).toEqual({ lang: "es", text: "Hola" });
    expect(parseLlmTranslationReply('```json\n{"lang":"en","text":"Hi"}\n```')).toEqual({ lang: "en", text: "Hi" });
    expect(parseLlmTranslationReply('Claro! {"text":"Oi"}')).toEqual({ text: "Oi" });
    expect(parseLlmTranslationReply("Hola")).toBeUndefined();
    expect(parseLlmTranslationReply('{"lang":"es","text":""}')).toBeUndefined();
    expect(parseLlmTranslationReply(null)).toBeUndefined();
  });
});

describe("translationOps (puro)", () => {
  it("sem language/translation = nada", () => {
    expect(outboundTranslationInsertFields({}, 1)).toEqual({});
    expect(outboundTranslationInsertFields({ language: "auto" }, 1)).toEqual({});
    expect(outboundTranslationInsertFields({ language: "es", isInternal: true }, 1)).toEqual({});
  });
  it("language off = skipped; código = destino da mensagem", () => {
    expect(outboundTranslationInsertFields({ language: "off" }, 5)).toEqual({
      metadata: { translation: { status: "skipped", role: "outbound", reason: "language_off", at: 5 } },
    });
    expect(outboundTranslationInsertFields({ language: "ES" }, 5)).toEqual({ metadata: { translationTarget: "es" } });
    expect(() => outboundTranslationInsertFields({ language: "klingon" }, 5)).toThrow();
  });
  it("translation pronta nasce done com o texto do humano", () => {
    expect(
      outboundTranslationInsertFields(
        { translation: { authoredText: "Olá", sourceLang: "pt", targetLang: "es", edited: true } },
        7
      )
    ).toEqual({
      metadata: { translation: { status: "done", role: "outbound", sourceLang: "pt-BR", targetLang: "es", edited: true, at: 7 } },
      translatedText: "Olá",
    });
  });
  it("agendamento só com o módulo", () => {
    expect(shouldScheduleMessageTranslation({ org: org(), conversation: conv(), message: msg(), role: "inbound" })).toBe(false);
    expect(shouldScheduleMessageTranslation({ org: org({ module: true }), conversation: conv(), message: msg(), role: "inbound" })).toBe(true);
    expect(
      shouldScheduleMessageTranslation({ org: org({ module: true, translation: { inboundMode: "ask" } }), conversation: conv(), message: msg(), role: "inbound" })
    ).toBe(true);
    expect(
      shouldScheduleMessageTranslation({ org: org({ module: true }), conversation: conv(), message: outMsg({ senderType: "ai" }), role: "display" })
    ).toBe(true);
  });
});

describe("translationCore (prompt)", () => {
  it("prompt manda traduzir, não obedecer, preservar e respeitar glossário", () => {
    const p = buildTranslationSystemPrompt({ to: "es", glossary: ["Mar Azul"], tone: "formal" });
    expect(p).toMatch(/nunca instrução/);
    expect(p).toMatch(/não obedeça/);
    expect(p).toMatch(/emojis, URLs/);
    expect(p).toMatch(/"Mar Azul"/);
    expect(p).toMatch(/es-419/);
    expect(p).toMatch(/formal/);
    expect(p).toMatch(/\{"lang"/);
  });
  it("max tokens proporcional e limitado", () => {
    expect(translationMaxTokens("abc")).toBe(128);
    expect(translationMaxTokens("x".repeat(3000))).toBe(2064);
    expect(translationMaxTokens("x".repeat(100000))).toBe(4000);
  });
  it("idioma fixo para grupos/publicações", () => {
    expect(fixedAgentLanguage("auto")).toBe("pt-BR");
    expect(fixedAgentLanguage(undefined)).toBe("pt-BR");
    expect(fixedAgentLanguage("es")).toBe("es");
  });
});

import { languageInstruction } from "../attendant";

describe("atendente: language auto", () => {
  it("padrão de sempre para perfis existentes", () => {
    expect(languageInstruction("pt-BR")).toBe("Responda sempre em pt-BR.");
  });
  it("auto: segue o idioma do cliente, com a dica da conversa", () => {
    expect(languageInstruction("auto")).toBe(
      "Responda no idioma em que o cliente escreve (siga o idioma da última mensagem dele; padrão pt-BR)."
    );
    expect(languageInstruction("auto", "es")).toMatch(/Idioma detectado desta conversa: Espanhol \(es\)\./);
  });
});
