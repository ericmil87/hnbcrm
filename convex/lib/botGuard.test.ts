import { describe, expect, test } from "vitest";
import {
  AUTOMATED_PHRASES,
  BOT_SELF_INTRO_PHRASES,
  BOT_SUSPICION_THRESHOLD,
  DEFAULT_BOT_TAG,
  BotGuardMessage,
  describeBotSignals,
  evaluateBotSignals,
  normalizeForPhrases,
  normalizeForRepeat,
  resolveBotGuardSettings,
  validateBotGuardTag,
} from "./botGuard";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 8, 15, 12, 0, 0);

// Textos REAIS do caso WhatsApp Support (o número do ticket muda a cada rodada).
const ENCERRADO =
  "Este atendimento foi encerrado. Caso você tenha outras dúvidas, fale conosco novamente.";
const TICKET = (n: string) =>
  `Hi 👋, thanks for contacting WhatsApp Support. Your ticket number is ${n}. We'll respond as soon as possible.`;

const inbound = (content: string, createdAt: number): BotGuardMessage => ({
  direction: "inbound",
  senderType: "contact",
  content,
  createdAt,
});
const ai = (content: string, createdAt: number): BotGuardMessage => ({
  direction: "outbound",
  senderType: "ai",
  content,
  createdAt,
});

describe("resolveBotGuardSettings", () => {
  test("ausente = ligado com a tag padrão", () => {
    expect(resolveBotGuardSettings(undefined)).toEqual({ enabled: true, tag: DEFAULT_BOT_TAG });
    expect(resolveBotGuardSettings({})).toEqual({ enabled: true, tag: "bot-suspeito" });
    expect(resolveBotGuardSettings({ botGuard: {} })).toEqual({ enabled: true, tag: "bot-suspeito" });
  });
  test("só enabled:false desliga; tag custom é aparada; tag vazia cai no padrão", () => {
    expect(resolveBotGuardSettings({ botGuard: { enabled: false } }).enabled).toBe(false);
    expect(resolveBotGuardSettings({ botGuard: { enabled: true, tag: "  robo " } }).tag).toBe("robo");
    expect(resolveBotGuardSettings({ botGuard: { tag: "   " } }).tag).toBe(DEFAULT_BOT_TAG);
  });
  test("validateBotGuardTag", () => {
    expect(validateBotGuardTag(" robo ")).toEqual({ ok: true, tag: "robo" });
    expect(validateBotGuardTag("").ok).toBe(false);
    expect(validateBotGuardTag("a,b").ok).toBe(false);
    expect(validateBotGuardTag("x".repeat(41)).ok).toBe(false);
  });
});

describe("normalização", () => {
  test("normalizeForRepeat tira dígitos, emoji, acento e pontuação", () => {
    expect(normalizeForRepeat(TICKET("3044939135877292"))).toBe(
      normalizeForRepeat(TICKET("9999999999999999"))
    );
    expect(normalizeForRepeat("  Olá!!  Tudo   bem? 😀 ")).toBe("ola tudo bem");
  });
  test("normalizeForPhrases unifica apóstrofo tipográfico e tira acento", () => {
    expect(normalizeForPhrases("We’ll respond — ATENÇÃO")).toBe("we'll respond — atencao");
  });
  test("listas exportadas estão em minúsculas e sem acento", () => {
    for (const p of [...AUTOMATED_PHRASES, ...BOT_SELF_INTRO_PHRASES]) {
      expect(normalizeForPhrases(p), p).toBe(p);
    }
  });
});

describe("evaluateBotSignals — caso real WhatsApp Support", () => {
  test("dispara na 3ª mensagem (1 → 3 → 5: repetido +2, frases no teto de 2, instantânea +1)", () => {
    const msgs: BotGuardMessage[] = [inbound(ENCERRADO, T0)];
    const r1 = evaluateBotSignals({ messages: msgs, sinceAt: 0 });
    expect(r1.score).toBe(1);
    expect(r1.triggered).toBe(false);

    msgs.push(ai("Olá! Parece que você encerrou um atendimento. Posso ajudar?", T0 + 10_000));
    msgs.push(inbound(TICKET("3044939135877292"), T0 + 12_000)); // 2 s depois: instantânea
    const r2 = evaluateBotSignals({ messages: msgs, sinceAt: 0 });
    expect(r2.score).toBe(3);
    expect(r2.signals).toEqual(["frase_automatica", "frase_automatica", "resposta_instantanea"]);
    expect(r2.triggered).toBe(false);

    msgs.push(ai("Essa mensagem parece automática 🙂", T0 + 20_000));
    msgs.push(inbound(ENCERRADO, T0 + 8 * DAY)); // dias depois, mesmo texto
    const r3 = evaluateBotSignals({ messages: msgs, sinceAt: 0 });
    expect(r3.score).toBe(5);
    // A 3ª frase automática não pontua mais (teto de 2 pontos de frase).
    expect(r3.signals.filter((x) => x === "frase_automatica")).toHaveLength(2);
    expect(r3.signals).toContain("texto_repetido");
    expect(r3.triggered).toBe(true);
    expect(r3.score).toBeGreaterThanOrEqual(BOT_SUSPICION_THRESHOLD);
  });

  test("sinceAt zera os contadores (humano limpou a suspeita)", () => {
    const msgs = [
      inbound(ENCERRADO, T0),
      ai("oi", T0 + 10_000),
      inbound(TICKET("1"), T0 + 12_000),
      ai("oi de novo", T0 + 20_000),
      inbound(ENCERRADO, T0 + DAY),
    ];
    expect(evaluateBotSignals({ messages: msgs, sinceAt: 0 }).triggered).toBe(true);
    const r = evaluateBotSignals({ messages: msgs, sinceAt: T0 + DAY });
    expect(r.score).toBe(1); // só a última, sem repetição (a 1ª ficou antes do corte)
    expect(r.triggered).toBe(false);
  });
});

describe("evaluateBotSignals — outro assistente de IA do outro lado", () => {
  test("auto-apresentação + resposta longa em segundos dispara", () => {
    const longa =
      "Olá! Sou um assistente virtual da Loja Exemplo e estou aqui para ajudar você com pedidos, trocas e dúvidas. " +
      "Para agilizar, me informe o número do pedido, o CPF do titular e o motivo do contato. " +
      "Nosso horário de atendimento humano é de segunda a sexta, das 9h às 18h, e respondemos por ordem de chegada.";
    expect(longa.length).toBeGreaterThanOrEqual(250);
    const r = evaluateBotSignals({
      messages: [ai("Oi! Tudo bem? Como posso ajudar?", T0), inbound(longa, T0 + 4_000)],
      sinceAt: 0,
    });
    expect(r.signals).toEqual(
      expect.arrayContaining(["auto_apresentacao_de_bot", "longa_e_rapida", "resposta_instantanea"])
    );
    expect(r.triggered).toBe(true);
  });
});

describe("evaluateBotSignals — conversa humana NÃO dispara", () => {
  test("perguntas variadas, respostas entre 30 s e 10 min", () => {
    const humanas = [
      "Oi, boa tarde! Queria saber do próximo encontro",
      "Quanto custa a inscrição?",
      "Dá pra pagar no Pix?",
      "E onde vai ser?",
      "Posso levar meu filho de 10 anos?",
      "Fechado, vou fazer o Pix agora",
      "Mandei o comprovante",
      "Obrigada!",
    ];
    const msgs: BotGuardMessage[] = [];
    let t = T0;
    const delays = [30_000, 2 * MIN, 45_000, 10 * MIN, 90_000, 3 * MIN, 60_000, 5 * MIN];
    humanas.forEach((h, i) => {
      msgs.push(inbound(h, t));
      t += 8_000;
      msgs.push(ai(`Resposta ${i} do atendente com algum texto`, t));
      t += delays[i];
    });
    const r = evaluateBotSignals({ messages: msgs, sinceAt: 0 });
    expect(r.score).toBe(0);
    expect(r.triggered).toBe(false);
  });

  test('"ok" curto e rápido 3× não conta texto_repetido nem resposta_instantanea', () => {
    const msgs: BotGuardMessage[] = [];
    let t = T0;
    for (let i = 0; i < 3; i++) {
      msgs.push(ai(`Pergunta ${i}`, t));
      msgs.push(inbound("ok", t + 3_000));
      t += MIN;
    }
    // e "obrigado" e "sim" também (menos de 12 caracteres normalizados)
    msgs.push(ai("Algo mais?", t));
    msgs.push(inbound("obrigado!", t + 3_000));
    msgs.push(ai("Disponha", t + 10_000));
    msgs.push(inbound("obrigado!", t + 13_000));
    const r = evaluateBotSignals({ messages: msgs, sinceAt: 0 });
    expect(r.signals).not.toContain("texto_repetido");
    expect(r.signals).not.toContain("resposta_instantanea");
    expect(r.triggered).toBe(false);
  });

  test("humano perguntando se é chatbot não dispara sozinho", () => {
    const r = evaluateBotSignals({
      messages: [
        ai("Oi! Sou o assistente da casa.", T0),
        inbound("Você é um chatbot? Prefiro falar com uma pessoa", T0 + 40_000),
      ],
      sinceAt: 0,
    });
    expect(r.signals).toEqual(["frase_automatica"]);
    expect(r.triggered).toBe(false);
  });

  test("mesmo texto reenviado sem resposta nossa no meio não é repetição", () => {
    const txt = "Vocês têm vaga para o encontro de sábado?";
    const r = evaluateBotSignals({
      messages: [inbound(txt, T0), inbound(txt, T0 + MIN)],
      sinceAt: 0,
    });
    expect(r.signals).not.toContain("texto_repetido");
  });

  test("notas internas são ignoradas", () => {
    const r = evaluateBotSignals({
      messages: [
        { direction: "internal", content: ENCERRADO, createdAt: T0, isInternal: true },
        { direction: "outbound", senderType: "human", content: ENCERRADO, createdAt: T0 + 1, isInternal: true },
      ],
      sinceAt: 0,
    });
    expect(r.score).toBe(0);
  });
});

describe("evaluateBotSignals — review de 02/10/2026", () => {
  test("conversa longa sobre IA/chatbot (vocabulário comum) NÃO dispara", () => {
    const falas = [
      "Vocês usam inteligência artificial no atendimento?",
      "Achei legal o assistente virtual de vocês",
      "Meu sobrinho fez um chatbot pra loja dele",
      "Ele usa inteligência artificial também, igual vocês",
      "Será que um assistente digital resolveria pra mim?",
      "Enfim, voltando: quero a inscrição de sábado",
      "Vou pensar no chatbot depois, rs",
    ];
    const msgs: BotGuardMessage[] = [];
    let t = T0;
    falas.forEach((f, i) => {
      msgs.push(inbound(f, t));
      t += 10_000;
      msgs.push(ai(`Resposta ${i}`, t));
      t += 3 * MIN; // humano respondendo em minutos
    });
    const r = evaluateBotSignals({ messages: msgs, sinceAt: 0 });
    expect(r.signals.filter((x) => x === "frase_automatica")).toHaveLength(2);
    expect(r.score).toBe(2);
    expect(r.triggered).toBe(false);
  });

  test("fronteira de episódio: só conta o que vem depois do último outbound HUMANO", () => {
    const humano: BotGuardMessage = {
      direction: "outbound",
      senderType: "human",
      content: "Oi, aqui é a Ana da equipe",
      createdAt: T0 + 30_000,
    };
    const msgs = [
      inbound(ENCERRADO, T0),
      ai("oi", T0 + 10_000),
      inbound(TICKET("1"), T0 + 12_000),
      humano,
      inbound(ENCERRADO, T0 + DAY),
    ];
    const r = evaluateBotSignals({ messages: msgs, sinceAt: 0 });
    // Antes do humano: ignorado. Depois: 1 frase, sem repetição (a 1ª ficou no episódio anterior).
    expect(r.score).toBe(1);
    expect(r.triggered).toBe(false);
    // Nota INTERNA de humano não abre episódio.
    const comNota = evaluateBotSignals({
      messages: [...msgs.slice(0, 3), { ...humano, isInternal: true }, ai("oi de novo", T0 + 40_000), msgs[4]],
      sinceAt: 0,
    });
    expect(comNota.triggered).toBe(true);
  });

  test('"protocolo não chegou", "reaja com" e "resgate agora" não são frase automática', () => {
    const r = evaluateBotSignals({
      messages: [
        inbound("O protocolo não chegou no meu e-mail", T0),
        inbound("Reaja com carinho, ela tá nervosa", T0 + MIN),
        inbound("Vou fazer o resgate agora do meu cupom", T0 + 2 * MIN),
      ],
      sinceAt: 0,
    });
    expect(r.score).toBe(0);
  });

  test("formas inequívocas de protocolo pontuam", () => {
    const r = evaluateBotSignals({
      messages: [inbound("Anote o protocolo de atendimento: 123456", T0)],
      sinceAt: 0,
    });
    expect(r.signals).toEqual(["frase_automatica"]);
  });
});

describe("describeBotSignals", () => {
  test("agrupa com contagem, mais forte primeiro", () => {
    expect(
      describeBotSignals([
        "frase_automatica",
        "texto_repetido",
        "resposta_instantanea",
        "texto_repetido",
      ])
    ).toBe("texto repetido 2×, frase de sistema automático, resposta instantânea");
  });
  test("vazio tem frase neutra", () => {
    expect(describeBotSignals([])).toMatch(/autom/);
  });
});
