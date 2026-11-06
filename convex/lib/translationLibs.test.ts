import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  availableEngines,
  resolveTranslationSettings,
  sanitizeGlossary,
  shouldTranslateDisplay,
  shouldTranslateInbound,
  shouldTranslateOutbound,
  conversationHasForeignLanguage,
  editedDraftNeedsTranslation,
  isTeamEditedAiDraft,
  translatableText,
  translationEnabledForOrg,
} from "./translationGate";
import {
  effectiveSourceLanguage,
  nextConversationTranslation,
  firstDetectionFixesLanguage,
  resolveTargetLanguage,
} from "./translationLang";
import { checkTranslation, hasTranslatableText, parseLlmTranslationReply, protectText, restoreText } from "./translationText";
import { outboundTranslationInsertFields, shouldScheduleMessageTranslation } from "./translationOps";
import { buildTranslationSystemPrompt, libreTranslateUrlProblem, translationMaxTokens } from "./translationCore";
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

  it("1ª detecção só fixa o idioma com evidência (review #11)", () => {
    const fixed = { lang: "es", source: "auto", detectedAt: 10, divergentStreak: 0 };
    // Forte: confiança ≥ 0,85 em texto com ≥ 40 letras.
    expect(nextConversationTranslation(undefined, { lang: "es", confidence: 0.9 }, 10, { alphaChars: 45 })).toEqual(fixed);
    // Concordância com o contato ou com o DDI.
    expect(nextConversationTranslation(undefined, { lang: "es", confidence: 0.7 }, 10, { contactPreferredLanguage: "es" })).toEqual(fixed);
    expect(nextConversationTranslation(undefined, { lang: "es", confidence: 0.7 }, 10, { dialHint: "es" })).toEqual(fixed);
    // Sem evidência: só candidato; a 2ª consecutiva no mesmo idioma fixa.
    const one = nextConversationTranslation(undefined, { lang: "es", confidence: 0.9 }, 10, { alphaChars: 25 })!;
    expect(one).toEqual({ candidateLang: "es", divergentStreak: 1 });
    expect(nextConversationTranslation(one, { lang: "es", confidence: 0.7 }, 11)).toEqual({ ...fixed, detectedAt: 11 });
    // Candidato trocado recomeça a contagem; DDI de outro idioma não ajuda.
    expect(nextConversationTranslation(one, { lang: "en", confidence: 0.7 }, 11, { dialHint: "es" })).toEqual({
      candidateLang: "en",
      divergentStreak: 1,
    });
    expect(firstDetectionFixesLanguage({ lang: "es", confidence: 0.84 }, { alphaChars: 100 })).toBe(false);
    expect(firstDetectionFixesLanguage({ lang: "es", confidence: 0.95 }, { alphaChars: 39 })).toBe(false);
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

  // Saídas REAIS do LibreTranslate do VPS (06/11/2026, pt → en/es). Antes da
  // correção, "10h" → "10:00" reprovava o "Testar conexão" com "números alterados".
  it.each([
    ["Bom dia, tudo bem? Podemos conversar amanhã às 10h.", "Good morning, all right? We can talk tomorrow at 10:00."],
    ["Bom dia, tudo bem? Podemos conversar amanhã às 10h.", "Buenos días, todo bien? Podemos hablar mañana a las 10."],
    [
      "Bom dia, tudo bem? Podemos conversar amanhã às 10h. O valor é R$ 1.500,00.",
      "Good morning, all right? We can talk tomorrow at 10:00. The amount is R$ 1,500.00.",
    ],
    [
      "Bom dia, tudo bem? Podemos conversar amanhã às 10h. O valor é R$ 1.500,00.",
      "Buenos días, todo bien? Podemos hablar mañana a las 10. El valor es R$ 1.500,00.",
    ],
    [
      "O condomínio é R$ 1.200,00 e a visita pode ser dia 15/12 às 14h30, 2x por semana.",
      "El condominio es R$ 1200,00 y la visita puede ser el día 15/12 a las 14.30, 2x por semana.",
    ],
    ["Apartamento de 85m² com 3 quartos, 1º andar, valor 450 mil.", "Apartment 85m2 with 3 bedrooms, 1st floor, value 450 thousand."],
    ["Apartamento de 85m² com 3 quartos, 1º andar, valor 450 mil.", "Apartamento de 85m2 con 3 habitaciones, 1o piso, valor 450 mil."],
    [
      "Me liga no (11) 98765-4321 ou acesse https://exemplo.com/imovel?id=42",
      "Me une en (11) 98765-4321 o visite https://exemplo.com/imovel?id=42",
    ],
    ["Chego às 9h e saio às 18h30. Custa R$ 99,90 ou 3x de R$ 35.", "Llego a las 9h y salgo a las 18.30. Custa R$ 99,90 o 3x de R$ 35."],
    ["Oi 👍🏽 *promoção* de 20% até 31/12 ❤️", "Oi 👍🏽 *promoción* del 20% hasta el 31/12 ❤️"],
  ])("guard aceita a saída real do LibreTranslate: %s", (a, b) => {
    expect(checkTranslation(a, b)).toEqual({ ok: true });
  });

  it.each([
    ["10h", "Até amanhã às 10h, combinado?", "See you tomorrow at 10 am, deal?"],
    ["14h30 em 12h com pm", "A visita é às 14h30, combinado?", "The visit is at 2:30 pm, deal?"],
    ["centavos omitidos", "O sinal é de R$ 1.500,00 no Pix.", "The deposit is R$ 1,500 via Pix."],
    ["espaço fino de milhar", "O sinal é de R$ 1.500,00 no Pix.", "Le dépôt est de 1\u202F500,00 R$ par Pix."],
    ["espaço comum de milhar com decimal (saída real fr)", "O valor é R$ 1.500,00.", "Le montant est de R$ 1 500.00."],
    ["emoji sem seletor e sem tom de pele", "Obrigado pela visita 👍🏽❤️", "Gracias por la visita 👍❤"],
  ])("guard tolera reformatação legítima (%s)", (_k, a, b) => {
    expect(checkTranslation(a, b)).toEqual({ ok: true });
  });

  it.each([
    ["valor trocado", "O condomínio é R$ 1.200,00 por mês.", "The condo fee is R$ 1,300.00 per month.", "números alterados"],
    ["valor sumiu", "O condomínio é R$ 1.200,00 por mês.", "The condo fee is paid every month.", "números alterados"],
    ["mil não é um", "O sinal é de R$ 1.000 no Pix.", "The deposit is R$ 1 via Pix.", "números alterados"],
    ["horário trocado", "Podemos conversar amanhã às 10h.", "We can talk tomorrow at 11:00.", "números alterados"],
    [
      "frase inventada com telefone",
      "Podemos conversar amanhã às 10h.",
      "We can talk tomorrow at 10:00. Call 555-1234.",
      "número novo na tradução",
    ],
    // Saída real do servidor em en: "às 14h30" → "at 2:30", "às 18h" → "6:00".
    ["24h → 12h sem am/pm", "Visita às 14h30 ou às 18h.", "Visit at 2:30 or 6:00.", "horário convertido para 12h sem am/pm"],
    ["link sumiu", "Veja o imóvel em https://exemplo.com/imovel?id=42 hoje", "See the property today", "links alterados"],
    ["negrito desbalanceado", "Isso é *muito* importante, viu?", "This is *very important, ok?", "formatação do WhatsApp alterada"],
    [
      "5× mais longa",
      "Podemos conversar amanhã cedo?",
      "Can we talk tomorrow morning? We would also like to tell you about our other properties, our team and our payment plans for this year.",
      "tamanho fora do esperado",
    ],
  ])("guard reprova %s", (_k, a, b, reason) => {
    expect(checkTranslation(a, b)).toEqual({ ok: false, reason });
  });

  it("marcador perdido pelo servidor (saída real em en) reprova na restauração", () => {
    const p = protectText("Me liga no (11) 98765-4321 ou acesse https://exemplo.com/imovel?id=42", []);
    expect(p.text).toContain("⟦P1⟧");
    expect(p.text).toContain("⟦U1⟧");
    expect(restoreText("Call me at ", p.tokens).ok).toBe(false);
  });

  // Respostas REAIS do LibreTranslate do VPS (06/11/2026) ao texto já protegido
  // no formato `libre`. Antes, com `⟦…⟧` e emoji cru, o pt→en cortava o texto:
  // "Me liga no ⟦P1⟧ ou acesse ⟦U1⟧" → "Call me at ", "Oi 👍🏽 *promoção*…" → "Hi ".
  it.each([
    ["Me liga no (11) 98765-4321 ou acesse https://exemplo.com/imovel?id=42", "en", "Call me at {2} or access {1}", "Call me at (11) 98765-4321 or access https://exemplo.com/imovel?id=42"],
    ["Me liga no (11) 98765-4321 ou acesse https://exemplo.com/imovel?id=42", "fr", "Appelez-moi à {2} ou accédez à {1}", "Appelez-moi à (11) 98765-4321 ou accédez à https://exemplo.com/imovel?id=42"],
    ["Me liga no (11) 98765-4321 ou acesse https://exemplo.com/imovel?id=42", "de", "Ruf mich an {2} oder access {1}", "Ruf mich an (11) 98765-4321 oder access https://exemplo.com/imovel?id=42"],
    ["Oi 👍 tudo bem? Até amanhã.", "en", "Hey, XEMO1X, what's up? See you tomorrow.", "Hey, 👍, what's up? See you tomorrow."],
    ["Oi 👍 tudo bem? Até amanhã.", "fr", "XEMO1X, quoi de neuf ? A demain.", "👍, quoi de neuf ? A demain."],
    ["Oi 👍 tudo bem? Até amanhã.", "de", "Hey, XEMO1X, was ist los? Wir sehen uns morgen.", "Hey, 👍, was ist los? Wir sehen uns morgen."],
    ["Oi 👍🏽 *promoção* até 15/12 ❤️", "en", "Hi XEMO1X *promotion* up to 15/12", "Hi 👍🏽 *promotion* up to 15/12 ❤️"],
    ["Oi 👍🏽 *promoção* até 15/12 ❤️", "fr", "Bonjour XEMO1X *promotion* jusqu'à 15/12", "Bonjour 👍🏽 *promotion* jusqu'à 15/12 ❤️"],
    ["Oi 👍🏽 *promoção* até 15/12 ❤️", "de", "Hi XEMO1X *Promotion* bis 15/12", "Hi 👍🏽 *Promotion* bis 15/12 ❤️"],
    ["Obrigado pela visita 🙏🙏 O Residencial Mar Azul fica a 200m da praia 🏖️. Fale com @marina ou escreva para contato@exemplo.com.", "en", "Thank you for visiting XEMO4X The {3} is 200m from XEMO5X beach. Talk to {2} or write to {1}.", "Thank you for visiting 🙏🙏 The Residencial Mar Azul is 200m from 🏖️ beach. Talk to @marina or write to contato@exemplo.com."],
    ["Obrigado pela visita 🙏🙏 O Residencial Mar Azul fica a 200m da praia 🏖️. Fale com @marina ou escreva para contato@exemplo.com.", "fr", "Merci de visiter XEMO4X Le {3} est à 200m de la plage XEMO5X. Parlez à {2} ou écrivez à {1}.", "Merci de visiter 🙏🙏 Le Residencial Mar Azul est à 200m de la plage 🏖️. Parlez à @marina ou écrivez à contato@exemplo.com."],
    ["Obrigado pela visita 🙏🙏 O Residencial Mar Azul fica a 200m da praia 🏖️. Fale com @marina ou escreva para contato@exemplo.com.", "de", "Vielen Dank für Ihren Besuch XEMO4X Die {3} ist 200m vom Strand XEMO5X. Sprich mit {2} oder schreibe mit {1}.", "Vielen Dank für Ihren Besuch 🙏🙏 Die Residencial Mar Azul ist 200m vom Strand 🏖️. Sprich mit @marina oder schreibe mit contato@exemplo.com."],
    ["Bom dia, tudo bem? Podemos conversar amanhã às 10h. O valor é R$ 1.500,00.", "en", "Good morning, all right? We can talk tomorrow at 10:00. The amount is R$ 1,500.00.", "Good morning, all right? We can talk tomorrow at 10:00. The amount is R$ 1,500.00."],
    ["Bom dia, tudo bem? Podemos conversar amanhã às 10h. O valor é R$ 1.500,00.", "fr", "Bonjour. On peut parler demain à 10 h. Le montant est de R$ 1 500.00.", "Bonjour. On peut parler demain à 10 h. Le montant est de R$ 1 500.00."],
    ["Bom dia, tudo bem? Podemos conversar amanhã às 10h. O valor é R$ 1.500,00.", "de", "Guten Morgen, okay? Wir können morgen um 10:00 Uhr sprechen. Der Betrag ist R$ 1.500.00.", "Guten Morgen, okay? Wir können morgen um 10:00 Uhr sprechen. Der Betrag ist R$ 1.500.00."],
    ["🎉 Parabéns! Seu cadastro foi aprovado.", "en", "Congratulations! Your record has been approved.", "🎉 Congratulations! Your record has been approved."],
    ["🎉 Parabéns! Seu cadastro foi aprovado.", "fr", "Félicitations ! Votre dossier a été approuvé.", "🎉 Félicitations ! Votre dossier a été approuvé."],
    ["🎉 Parabéns! Seu cadastro foi aprovado.", "de", "Herzlichen Glückwunsch! Ihre Aufzeichnung wurde genehmigt.", "🎉 Herzlichen Glückwunsch! Ihre Aufzeichnung wurde genehmigt."],
    ["Segue o link: https://exemplo.com/a_b?x=1", "en", "Following link: {1}", "Following link: https://exemplo.com/a_b?x=1"],
    ["Segue o link: https://exemplo.com/a_b?x=1", "fr", "Lien suivant: {1}", "Lien suivant: https://exemplo.com/a_b?x=1"],
    ["Segue o link: https://exemplo.com/a_b?x=1", "de", "Nach dem Link: {1}", "Nach dem Link: https://exemplo.com/a_b?x=1"],
    ["Oi! 👋\nA casa é linda 😍 e fica perto da praia.\nMe chama no (11) 98765-4321 🙏", "en", "Hello!\nThe house is beautiful XEMO2X and is close to the beach.\nCall me in {1}", "Hello! 👋\nThe house is beautiful 😍 and is close to the beach.\nCall me in (11) 98765-4321 🙏"],
    ["Oi! 👋\nA casa é linda 😍 e fica perto da praia.\nMe chama no (11) 98765-4321 🙏", "fr", "Bonjour !\nLa maison est belle XEMO2X et est proche de la plage.\nAppelez-moi dans {1}", "Bonjour ! 👋\nLa maison est belle 😍 et est proche de la plage.\nAppelez-moi dans (11) 98765-4321 🙏"],
    ["Oi! 👋\nA casa é linda 😍 e fica perto da praia.\nMe chama no (11) 98765-4321 🙏", "de", "Hallo!\nDas Haus ist schön XEMO2X und liegt in der Nähe des Strandes.\nRuf mich an {1}", "Hallo! 👋\nDas Haus ist schön 😍 und liegt in der Nähe des Strandes.\nRuf mich an (11) 98765-4321 🙏"],
    ["Visita confirmada ✅ amanhã às 10h, combinado? 👍🏽", "en", "Confirmed XEMO1X visit tomorrow at 10:00, agreed?", "Confirmed ✅ visit tomorrow at 10:00, agreed? 👍🏽"],
    ["Visita confirmada ✅ amanhã às 10h, combinado? 👍🏽", "fr", "Confirmé la visite de XEMO1X demain à 10h, d'accord ?", "Confirmé la visite de ✅ demain à 10h, d'accord ? 👍🏽"],
    ["Visita confirmada ✅ amanhã às 10h, combinado? 👍🏽", "de", "Bestätigt XEMO1X Besuch morgen um 10:00 Uhr, vereinbart?", "Bestätigt ✅ Besuch morgen um 10:00 Uhr, vereinbart? 👍🏽"],
  ])("formato libre: %s → %s volta inteiro e passa no guard", (source, _lang, engineOut, expected) => {
    const p = protectText(source, ["Residencial Mar Azul"], "libre");
    expect(p.text).not.toMatch(/⟦|\p{Extended_Pictographic}/u);
    const back = restoreText(engineOut, p, "libre");
    expect(back).toEqual({ ok: true, text: expected });
    expect(checkTranslation(source, back.text)).toEqual({ ok: true });
  });

  it("formato libre: hora da tarde vai como HH:MM; manhã, duração e HH:MM ficam como estão", () => {
    expect(protectText("Quinta, às 19h, no Espaço. Chega 18h45.", [], "libre").text).toBe(
      "Quinta, às 19:00, no Espaço. Chega 18:45."
    );
    expect(protectText("Às 10h ou 7h30; dura 2h; 14:30; 48h; 25h; 19horas", [], "libre").text).toBe(
      "Às 10h ou 7h30; dura 2h; 14:30; 48h; 25h; 19horas"
    );
    // O formato do LLM não muda: o modelo entende "19h".
    expect(protectText("às 19h", [], "llm").text).toBe("às 19h");
  });

  // Mensagem REAL do incidente de 06/11/2026 ("horário convertido para 12h sem
  // am/pm"): com "19h"/"18h45" o servidor devolvia "6:45"; já protegida, a
  // resposta medida no mesmo servidor mantém os horários e passa no guard.
  it.each([
    ["en", "Payment checked, your spot in Experience Tide Nova is confirmed! Thursday, 08/10, at 19:00, in the Sacred Heart Space ({1}). Comes 18:45, comfortable clothes and water bottle. I'll wait for you. All right!"],
    ["fr", "Paiement vérifié, votre place dans Experience Tide Nova est confirmée! Jeudi 08/10, à 19h00, dans l'Espace Sacré-Cœur ({1}). Livré à 18h45, vêtements confortables et bouteille d'eau. Je t'attends. Très bien !"],
  ])("formato libre: horário da tarde da mensagem real → %s passa no guard", (_lang, engineOut) => {
    const source =
      "Pagamento conferido, sua vaga na Vivência Maré Nova tá confirmada! Quinta, 08/10, às 19h, no Espaço Coração Sagrado (https://maps.app.goo.gl/BMkniuCXqWrhsp1L7). Chega 18h45, roupa confortável e garrafa d'água. Te espero. muito bem!";
    const p = protectText(source, [], "libre");
    expect(p.text).toContain("às 19:00");
    expect(p.text).toContain("Chega 18:45");
    const back = restoreText(engineOut, p, "libre");
    expect(back.ok).toBe(true);
    expect(back.text).toContain("https://maps.app.goo.gl/BMkniuCXqWrhsp1L7");
    expect(checkTranslation(source, back.text)).toEqual({ ok: true });
  });

  it("formato libre: servidor que ainda converte para 12h continua reprovado (vai para a IA)", () => {
    // Medido: "Visita às 14:30 ou às 18:00." → "Visit at 2:30 or 6:00."
    expect(checkTranslation("Visita às 14h30 ou às 18h.", "Visit at 2:30 or 6:00.")).toEqual({
      ok: false,
      reason: "horário convertido para 12h sem am/pm",
    });
  });

  it("formato libre: tokens, bordas de linha e emoji no meio", () => {
    const p = protectText("Oi! 👋\nA casa é linda 😍 e fica perto da praia.\nMe chama no (11) 98765-4321 🙏", [], "libre");
    expect(p.text).toBe("Oi!\nA casa é linda XEMO2X e fica perto da praia.\nMe chama no {1}");
    expect(p.tokens).toEqual([
      { token: "{1}", value: "(11) 98765-4321" },
      { token: "XEMO2X", value: "😍" },
    ]);
    expect(p.edges).toEqual([
      { lead: "", trail: " 👋" },
      { lead: "", trail: "" },
      { lead: "", trail: " 🙏" },
    ]);
  });

  it("formato libre: caixa e espaço variando no token ainda restauram", () => {
    const p = protectText("Veja https://ex.com, é lindo 😍 demais", [], "libre");
    expect(restoreText("See { 1 }, it is so xemo2x beautiful", p, "libre")).toEqual({
      ok: true,
      text: "See https://ex.com, it is so 😍 beautiful",
    });
  });

  it("formato libre: token sumido, inventado ou linhas mudadas reprovam", () => {
    const p = protectText("🎉 Parabéns!\nVeja https://ex.com hoje", [], "libre");
    expect(p.text).toBe("Parabéns!\nVeja {1} hoje");
    expect(restoreText("Congratulations!\nSee today", p, "libre").ok).toBe(false);
    expect(restoreText("Congratulations!\nSee {1} {7} today", p, "libre").ok).toBe(false);
    expect(restoreText("Congratulations! See {1} today", p, "libre").ok).toBe(false);
    expect(restoreText("Congratulations!\nSee {1} today", p, "libre")).toEqual({
      ok: true,
      text: "🎉 Congratulations!\nSee https://ex.com today",
    });
  });

  it("formato libre: \"{1}\" escrito pelo usuário vira token e volta igual", () => {
    const p = protectText("Use o código {1} no link https://ex.com", [], "libre");
    expect(p.text).toBe("Use o código {1} no link {2}");
    expect(p.tokens[0]).toEqual({ token: "{1}", value: "{1}" });
    expect(restoreText("Use code {1} at the link {2}", p, "libre")).toEqual({
      ok: true,
      text: "Use code {1} at the link https://ex.com",
    });
  });

  it("formato llm continua com ⟦…⟧ e emoji cru", () => {
    const p = protectText("Oi 👍 veja https://ex.com", []);
    expect(p.text).toBe("Oi 👍 veja ⟦U1⟧");
    expect(p.edges).toBeUndefined();
  });

  it("hasTranslatableText: só emoji/link/telefone não tem o que traduzir", () => {
    expect(hasTranslatableText(protectText("👍🏽🙏", [], "libre"))).toBe(false);
    expect(hasTranslatableText(protectText("https://ex.com 👍", [], "libre"))).toBe(false);
    expect(hasTranslatableText(protectText("Oi 👍", [], "libre"))).toBe(true);
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
  it("max tokens proporcional, com folga de raciocínio, e limitado", () => {
    expect(translationMaxTokens("abc")).toBe(2 + 64 + 512);
    // A mensagem real de 06/11/2026 (~260 caracteres) cortava com ~238 tokens.
    expect(translationMaxTokens("x".repeat(260))).toBeGreaterThanOrEqual(700);
    expect(translationMaxTokens("x".repeat(3000))).toBe(2576);
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

describe("review da tradução (backend)", () => {
  const PT = "Olá, boa tarde! Vocês têm disponibilidade para o fim de semana?";
  it("#10: inbound em pt-BR (ou curta) numa conversa sem idioma estrangeiro não agenda", () => {
    const on = org({ module: true });
    expect(shouldScheduleMessageTranslation({ org: on, conversation: conv(), message: msg({ content: PT }), role: "inbound" })).toBe(false);
    expect(shouldScheduleMessageTranslation({ org: on, conversation: conv(), message: msg({ content: "ok" }), role: "inbound" })).toBe(false);
    // Conversa ativa (idioma ou candidato estrangeiro): agenda (o `skipped` aparece na bolha).
    expect(
      shouldScheduleMessageTranslation({ org: on, conversation: conv({ translation: { lang: "es" } }), message: msg({ content: PT }), role: "inbound" })
    ).toBe(true);
    expect(
      shouldScheduleMessageTranslation({ org: on, conversation: conv({ translation: { candidateLang: "en" } }), message: msg({ content: "ok" }), role: "inbound" })
    ).toBe(true);
    // Dica externa estrangeira (Whisper) também agenda.
    expect(
      shouldScheduleMessageTranslation({ org: on, conversation: conv(), message: msg({ content: "ok" }), role: "inbound", hintLang: "en" })
    ).toBe(true);
    expect(conversationHasForeignLanguage(conv({ translation: { lang: "pt-BR" } }), "pt-BR")).toBe(false);
    expect(conversationHasForeignLanguage(conv({ translation: { lang: "es", mode: "off" } }), "pt-BR")).toBe(false);
  });

  it("#1: legenda de arquivo conta na saída; texto longo só recusa quando a tradução é devida", () => {
    expect(translatableText(msg({ contentType: "file", content: "Segue o contrato assinado" }), { fileCaption: true })).toBeTruthy();
    expect(translatableText(msg({ contentType: "file", content: "Segue o contrato assinado" }))).toBeUndefined();
    const long = outMsg({ content: "Olá ".repeat(1100) });
    const o = org({ module: true });
    expect(shouldTranslateOutbound({ org: o, conversation: conv(), message: long, targetLang: "es" })).toEqual({ ok: false, reason: "texto_longo" });
    expect(shouldTranslateOutbound({ org: o, conversation: conv(), message: long, targetLang: "pt-BR" })).toEqual({ ok: false, reason: "mesma_lingua" });
    expect(shouldTranslateOutbound({ org: o, conversation: conv(), message: long, targetLang: undefined })).toEqual({ ok: false, reason: "sem_idioma" });
  });

  it("#3: rascunho da IA editado em pt-BR vira elegível; sem a marca segue recusado", () => {
    const o = org({ module: true });
    const es = conv({ translation: { lang: "es" } });
    expect(editedDraftNeedsTranslation({ org: o, conversation: es, finalText: PT })).toBe(true);
    expect(editedDraftNeedsTranslation({ org: o, conversation: es, finalText: "Ok!" })).toBe(true);
    expect(editedDraftNeedsTranslation({ org: o, conversation: es, finalText: "Hola, el apartamento cuesta quinientos mil reales" })).toBe(false);
    expect(editedDraftNeedsTranslation({ org: o, conversation: conv(), finalText: PT })).toBe(false);
    expect(editedDraftNeedsTranslation({ org: org(), conversation: es, finalText: PT })).toBe(false);
    const ai = outMsg({ senderType: "ai" });
    expect(shouldTranslateOutbound({ org: o, conversation: es, message: ai, targetLang: "es" }).ok).toBe(false);
    const edited = outMsg({ senderType: "ai", metadata: { aiDraft: { edited: true, editedInTeamLanguage: true } } });
    expect(isTeamEditedAiDraft(edited)).toBe(true);
    expect(shouldTranslateOutbound({ org: o, conversation: es, message: edited, targetLang: "es" }).ok).toBe(true);
  });

  it("#14: LibreTranslate só por https (http só em localhost)", () => {
    expect(libreTranslateUrlProblem("https://lt.hnbcrm.com")).toBeUndefined();
    expect(libreTranslateUrlProblem("http://localhost:5000")).toBeUndefined();
    expect(libreTranslateUrlProblem("http://127.0.0.1:5000")).toBeUndefined();
    expect(libreTranslateUrlProblem("http://10.0.0.5:5000")).toBe("URL do LibreTranslate precisa ser https");
    expect(libreTranslateUrlProblem("ftp://lt")).toBe("URL do LibreTranslate precisa ser https");
    expect(libreTranslateUrlProblem("nada")).toBe("URL do LibreTranslate inválida");
  });

  it("#8: idioma inválido no insert é ConvexError (REST responde 400)", () => {
    expect(() => outboundTranslationInsertFields({ language: "klingon" }, 5)).toThrow(ConvexError);
  });
});
