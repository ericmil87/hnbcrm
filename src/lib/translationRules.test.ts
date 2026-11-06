import { describe, expect, it } from "vitest";
import {
  canRequestTranslation,
  conversationLanguageState,
  hasFreshUntranslated,
  languageChipLabel,
  languageDisplayName,
  selectableLanguages,
  shortLanguageCode,
  translationBannerKind,
  translationView,
  uncertainLanguageLabel,
  uncertainLanguageOffer,
  type TranslatableMessage,
  type TranslationOrgSettings,
} from "./translationRules";

const ON: TranslationOrgSettings = { moduleEnabled: true, teamLanguage: "pt-BR", inboundMode: "auto", outboundMode: "quick_review" };
const NOW = 1_000_000;

const inbound = (over: Partial<TranslatableMessage> = {}): TranslatableMessage => ({
  content: "Hola, ¿tienen disponibilidad?",
  direction: "inbound",
  senderType: "contact",
  isInternal: false,
  createdAt: NOW - 1_000,
  ...over,
});
const tr = (t: Record<string, unknown>) => ({ metadata: { translation: { at: 1, ...t } } });

describe("nomes de idioma", () => {
  it("nome em PT-BR com maiúscula, forma minúscula e código curto", () => {
    expect(languageDisplayName("es")).toBe("Espanhol");
    expect(languageDisplayName("en", { lower: true })).toBe("inglês");
    expect(shortLanguageCode("pt-BR")).toBe("PT");
    expect(shortLanguageCode("es")).toBe("ES");
    expect(languageDisplayName("")).toBe("");
  });
  it("o seletor tira o idioma da equipe (sem região)", () => {
    const codes = selectableLanguages("pt-BR").map((l) => l.code);
    expect(codes).not.toContain("pt-BR");
    expect(codes).not.toContain("pt-PT");
    expect(codes).toContain("es");
  });
});

describe("conversationLanguageState", () => {
  it("auto: idioma estrangeiro detectado traduz", () => {
    const s = conversationLanguageState({ translation: { lang: "es", mode: "auto" } }, ON);
    expect(s).toMatchObject({ lang: "es", foreign: true, active: true, awaitingChoice: false, eligible: true });
  });
  it("ask sem escolha: espera a equipe", () => {
    const s = conversationLanguageState({ translation: { lang: "es" } }, { ...ON, inboundMode: "ask" });
    expect(s.active).toBe(false);
    expect(s.awaitingChoice).toBe(true);
  });
  it("off, grupo e módulo desligado não traduzem", () => {
    expect(conversationLanguageState({ translation: { lang: "es", mode: "off" } }, ON).active).toBe(false);
    expect(conversationLanguageState({ kind: "group", translation: { lang: "es" } }, ON).eligible).toBe(false);
    expect(conversationLanguageState({ translation: { lang: "es" } }, { ...ON, moduleEnabled: false }).active).toBe(false);
  });
  it("mesma língua da equipe não é estrangeira", () => {
    expect(conversationLanguageState({ translation: { lang: "pt-PT" } }, ON).foreign).toBe(false);
  });
});

describe("languageChipLabel", () => {
  const st = (t: Record<string, unknown>) => conversationLanguageState({ translation: t }, ON);
  it("auto, fixo e sem tradução", () => {
    expect(languageChipLabel(st({ lang: "es", mode: "auto" }), "pt-BR")).toEqual({
      short: "ES · auto",
      full: "Enviar em: Espanhol (auto)",
      tone: "active",
    });
    expect(languageChipLabel(st({ lang: "en", mode: "manual" }), "pt-BR")?.short).toBe("EN · fixo");
    expect(languageChipLabel(st({ lang: "es", mode: "off" }), "pt-BR")?.full).toBe(
      "Enviar em: Português (Brasil) (sem tradução)"
    );
  });
  it("escondido sem sinal de idioma ou com o lead na língua da equipe", () => {
    expect(languageChipLabel(st({}), "pt-BR")).toBeNull();
    expect(languageChipLabel(st({ lang: "pt-BR", mode: "auto" }), "pt-BR")).toBeNull();
  });
});

describe("translationView", () => {
  const ctx = { conversationActive: true, now: NOW };

  it("recebida traduzida: tradução é o texto principal", () => {
    const v = translationView(
      inbound({ translatedText: "Olá, vocês têm disponibilidade?", ...tr({ status: "done", role: "inbound", sourceLang: "es", targetLang: "pt-BR" }) }),
      ctx
    );
    expect(v).toMatchObject({
      kind: "translated",
      primary: "Olá, vocês têm disponibilidade?",
      secondary: "Hola, ¿tienen disponibilidad?",
      label: "Espanhol → pt-BR",
      showSecondaryLabel: "Ver original",
      showPrimaryLabel: "Ver tradução",
    });
  });

  it("recebida sem estado: 'Traduzindo…' inferido só nos primeiros 30 s", () => {
    expect(translationView(inbound(), ctx)).toEqual({ kind: "translating", inferred: true });
    expect(translationView(inbound({ createdAt: NOW - 31_000 }), ctx).kind).toBe("none");
    expect(translationView(inbound(), { ...ctx, conversationActive: false }).kind).toBe("none");
  });

  it("pending, failed e skipped da recebida", () => {
    expect(translationView(inbound(tr({ status: "pending", role: "inbound" })), ctx).kind).toBe("translating");
    expect(translationView(inbound(tr({ status: "failed", role: "inbound" })), ctx).kind).toBe("failed");
    expect(translationView(inbound(tr({ status: "skipped", role: "inbound" })), ctx).kind).toBe("none");
  });

  it("enviada traduzida: principal é o que o lead recebeu", () => {
    const v = translationView(
      {
        ...inbound(),
        direction: "outbound",
        senderType: "user",
        content: "¡Sí tenemos!",
        translatedText: "Temos sim!",
        ...tr({ status: "done", role: "outbound", sourceLang: "pt-BR", targetLang: "es" }),
      },
      ctx
    );
    expect(v).toMatchObject({ kind: "translated", primary: "¡Sí tenemos!", secondary: "Temos sim!", label: "pt-BR → Espanhol · Você escreveu" });
  });

  it("enviada com a tradução editada antes do envio (F3)", () => {
    const v = translationView(
      {
        ...inbound(),
        direction: "outbound",
        senderType: "user",
        content: "¡Sí, tenemos!",
        translatedText: "Temos sim!",
        ...tr({ status: "done", role: "outbound", sourceLang: "pt-BR", targetLang: "es", edited: true }),
      },
      ctx
    );
    expect(v).toMatchObject({ kind: "translated", label: "pt-BR → Espanhol · Tradução editada por você" });
  });

  it("estados da enviada", () => {
    const out = (t: Record<string, unknown>) => ({ ...inbound(), direction: "outbound", senderType: "user", ...tr({ role: "outbound", ...t }) });
    expect(translationView(out({ status: "pending" }), ctx).kind).toBe("outbound_pending");
    expect(translationView(out({ status: "failed", error: "x" }), ctx)).toEqual({ kind: "outbound_failed", error: "x" });
    expect(translationView(out({ status: "skipped" }), ctx).kind).toBe("outbound_skipped");
  });

  it("resposta da IA: principal no idioma do lead, pt-BR ao tocar", () => {
    const v = translationView(
      {
        ...inbound(),
        direction: "outbound",
        senderType: "ai",
        content: "Claro",
        translatedText: "Claro (pt)",
        ...tr({ status: "done", role: "display", sourceLang: "es", targetLang: "pt-BR" }),
      },
      ctx
    );
    expect(v).toMatchObject({ kind: "translated", role: "display", primary: "Claro", showSecondaryLabel: "Ver em pt-BR" });
  });

  it("nota interna e grupo nunca", () => {
    expect(translationView(inbound({ isInternal: true }), ctx).kind).toBe("none");
    expect(translationView(inbound(), { ...ctx, isGroup: true }).kind).toBe("none");
  });
});

describe("canRequestTranslation e hasFreshUntranslated", () => {
  it("pulada ou nunca processada pode ser traduzida; feita não", () => {
    expect(canRequestTranslation(inbound(tr({ status: "skipped", role: "inbound" })), { moduleEnabled: true })).toBe(true);
    expect(canRequestTranslation(inbound(), { moduleEnabled: true })).toBe(true);
    expect(canRequestTranslation(inbound(tr({ status: "done", role: "inbound" })), { moduleEnabled: true })).toBe(false);
    expect(canRequestTranslation(inbound(), { moduleEnabled: false })).toBe(false);
    expect(canRequestTranslation(inbound({ content: " " }), { moduleEnabled: true })).toBe(false);
  });
  it("relógio só liga com recebida recente sem estado", () => {
    expect(hasFreshUntranslated([inbound()], NOW)).toBe(true);
    expect(hasFreshUntranslated([inbound({ createdAt: NOW - 40_000 })], NOW)).toBe(false);
    expect(hasFreshUntranslated([inbound(tr({ status: "done", role: "inbound" }))], NOW)).toBe(false);
  });
});

describe("translationBannerKind", () => {
  const base = {
    isGroup: false,
    openedAt: NOW,
    dismissed: false,
    canManageSettings: true,
    settings: ON,
  };
  it("auto: detecção recente mostra o aviso; antiga ou fixada não", () => {
    const t = { lang: "es", mode: "auto" as const, source: "auto" as const, detectedAt: NOW - 1000 };
    expect(translationBannerKind({ ...base, translation: t, state: conversationLanguageState({ translation: t }, ON) })).toBe("auto");
    const old = { ...t, detectedAt: NOW - 3_600_000 };
    expect(translationBannerKind({ ...base, translation: old, state: conversationLanguageState({ translation: old }, ON) })).toBeNull();
    const manual = { ...t, mode: "manual" as const, source: "manual" as const };
    expect(translationBannerKind({ ...base, translation: manual, state: conversationLanguageState({ translation: manual }, ON) })).toBeNull();
  });
  it("ask pergunta", () => {
    const s = { ...ON, inboundMode: "ask" as const };
    const t = { lang: "es" };
    expect(translationBannerKind({ ...base, settings: s, translation: t, state: conversationLanguageState({ translation: t }, s) })).toBe("ask");
  });
  it("descoberta: módulo off, quem gerencia e dica estrangeira", () => {
    const off = { ...ON, moduleEnabled: false };
    const state = conversationLanguageState({}, off);
    expect(translationBannerKind({ ...base, settings: off, state, contactLanguageHint: "es" })).toBe("discover");
    expect(translationBannerKind({ ...base, settings: off, state, contactLanguageHint: "pt-BR" })).toBeNull();
    expect(translationBannerKind({ ...base, settings: off, state, contactLanguageHint: "es", canManageSettings: false })).toBeNull();
    expect(translationBannerKind({ ...base, settings: off, state, contactLanguageHint: "es", dismissed: true })).toBeNull();
  });
});

describe("idioma incerto (F3)", () => {
  const ctxOn = { moduleEnabled: true, teamLanguage: "pt-BR" };
  it("detecção fraca com idioma provável oferece traduzir", () => {
    const m = inbound(tr({ status: "skipped", role: "inbound", reason: "low_confidence", candidateLang: "es", sourceLang: "pt-BR" }));
    expect(uncertainLanguageOffer(m, ctxOn)).toBe("es");
    expect(uncertainLanguageLabel("es")).toBe("Idioma incerto · Traduzir como espanhol?");
  });
  it("curta usa o candidato da conversa; sem candidato ou candidato pt-BR não oferece", () => {
    const short = inbound(tr({ status: "skipped", role: "inbound", reason: "short" }));
    expect(uncertainLanguageOffer(short, { ...ctxOn, conversation: { translation: { candidateLang: "en" } } })).toBe("en");
    expect(uncertainLanguageOffer(short, ctxOn)).toBeNull();
    expect(uncertainLanguageOffer(short, { ...ctxOn, conversation: { translation: { candidateLang: "pt-PT" } } })).toBeNull();
  });
  it("mesma língua, conversa sem tradução, módulo off e enviada não oferecem", () => {
    const same = inbound(tr({ status: "skipped", role: "inbound", reason: "same_language", candidateLang: "es" }));
    expect(uncertainLanguageOffer(same, ctxOn)).toBeNull();
    const low = inbound(tr({ status: "skipped", role: "inbound", reason: "low_confidence", candidateLang: "es" }));
    expect(uncertainLanguageOffer(low, { ...ctxOn, conversation: { translation: { mode: "off" } } })).toBeNull();
    expect(uncertainLanguageOffer(low, { ...ctxOn, moduleEnabled: false })).toBeNull();
    expect(uncertainLanguageOffer({ ...low, direction: "outbound", senderType: "user" }, ctxOn)).toBeNull();
  });
});
