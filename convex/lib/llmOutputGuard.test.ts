import { describe, expect, it } from "vitest";
import { describeLeakedModelMarkup, detectLeakedModelMarkup, isAgendaTextLeak } from "./llmOutputGuard";

// Amostra REAL do incidente de 07/10/2026 (barras U+FF5C, fullwidth).
const REAL_DSML = [
  "<｜DSML｜tool_calls>",
  '<｜DSML｜invoke name="consultarAgenda">',
  '<｜DSML｜parameter name="consulta" string="true">eventos futuros</｜DSML｜parameter>',
  "</｜DSML｜invoke>",
  "</｜DSML｜tool_calls>",
].join("\n");

describe("detectLeakedModelMarkup — positivos", () => {
  it("pega a amostra real (DSML com U+FF5C)", () => {
    expect(REAL_DSML).toContain("｜");
    const leak = detectLeakedModelMarkup(REAL_DSML);
    expect(leak?.kind).toBe("tool_call_markup");
    expect(leak!.sample.startsWith("<｜DSML｜tool_calls>")).toBe(true);
    expect(leak!.sample.length).toBeLessThanOrEqual(80);
  });

  it("pega DSML no meio de um texto e a variante ASCII", () => {
    expect(detectLeakedModelMarkup(`Bom dia, grupo!\n${REAL_DSML}`)?.kind).toBe("tool_call_markup");
    expect(detectLeakedModelMarkup("<|DSML|invoke name=\"x\">")?.kind).toBe("tool_call_markup");
    expect(detectLeakedModelMarkup("</｜DSML｜tool_calls>")?.kind).toBe("tool_call_markup");
  });

  it.each([
    "<|tool_calls_begin|>",
    "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>x",
    "<|tool▁call▁begin|>",
    '<|python_tag|>{"name": "x", "parameters": {}}',
    "<tool_call>\n{\"name\": \"x\", \"arguments\": {}}\n</tool_call>",
    "<tool_calls>[]</tool_calls>",
    "texto </tool_call>",
    "<function_calls><invoke name=\"x\"></invoke></function_calls>",
    '<invoke name="consultarAgenda">',
    '<parameter name="consulta">x</parameter>',
    "<function=consultarAgenda>{\"q\":1}</function>",
    "</function>",
    '[TOOL_CALLS] [{"name": "x", "arguments": {}}]',
    "<tool_response>{}</tool_response>",
  ])("marcação de tool: %s", (text) => {
    expect(detectLeakedModelMarkup(text)?.kind).toBe("tool_call_markup");
  });

  it.each([
    "<|im_start|>assistant\nOlá",
    "Olá<|im_end|>",
    "<｜begin▁of▁sentence｜>Olá",
    "<|begin▁of▁sentence|>",
    "Olá!<|eot_id|>",
    "<|assistant|> Olá",
  ])("token especial: %s", (text) => {
    expect(detectLeakedModelMarkup(text)?.kind).toBe("special_token");
  });

  it.each([
    '{"name": "consultarAgenda", "arguments": {"consulta": "eventos"}}',
    '{"name": "x", "parameters": {}}',
    '[{"name": "x", "input": {}}]',
    '{"tool_calls": [{"id": "1"}]}',
    '{"function_call": {"name": "x"}}',
    '{"type": "function", "function": {"name": "x", "arguments": "{}"}}',
    '```json\n{"name": "x", "arguments": {}}\n```',
    '{"tool_calls": [{"id": "1", "function": {"name": "x", "argu',
  ])("JSON que é tool call: %s", (text) => {
    expect(detectLeakedModelMarkup(text)?.kind).toBe("json_tool_call");
  });

  it.each([
    "<think>vou responder sobre a agenda",
    "pensei bastante</think>Bom dia!",
    "<thinking>hmm</thinking> Bom dia",
    "<reasoning>x",
  ])("resto de raciocínio: %s", (text) => {
    expect(detectLeakedModelMarkup(text)?.kind).toBe("reasoning_leftover");
  });
});

describe("detectLeakedModelMarkup — negativos (mensagens comuns de WhatsApp)", () => {
  it.each([
    "",
    "   ",
    "Bom dia, grupo! ☀️ Hoje tem *roda de conversa* às 19h.",
    "Te amo <3",
    "se a<b então b>a",
    "preço: R$ 50 | 3x sem juros",
    "Veja https://exemplo.com/a|b?x=1|2 e me diga",
    "Use | para separar | as colunas",
    "Formato: <nome> <telefone>",
    "Seu pedido {\"id\": 1} foi recebido",
    'Mande assim: {"name": "Maria", "arguments": "x"} e pronto',
    '{"nome": "Maria", "idade": 30}',
    "[1, 2, 3]",
    "_itálico_ e ~riscado~ e `código`",
    "🎉🎉 Promoção!! >>> corre <<<",
    "A função de pagamento está fora do ar",
    "Parâmetro: name = João",
  ])("não casa: %s", (text) => {
    expect(detectLeakedModelMarkup(text)).toBeNull();
  });

  it("null/undefined", () => {
    expect(detectLeakedModelMarkup(null)).toBeNull();
    expect(detectLeakedModelMarkup(undefined)).toBeNull();
  });
});

describe("describeLeakedModelMarkup", () => {
  it("nomeia o kind e a amostra, sem quebra de linha", () => {
    const d = describeLeakedModelMarkup(detectLeakedModelMarkup(REAL_DSML)!);
    expect(d.startsWith("Saída com marcação de ferramenta vazada (tool_call_markup): <｜DSML｜tool_calls>")).toBe(true);
    expect(d).not.toContain("\n");
  });
});

describe("detectLeakedModelMarkup — agenda (D2): código de oferta e raciocínio sobre o cliente", () => {
  const agenda = { agenda: true };
  // as 3 mensagens reais do `deepseek-v4-flash` (simulação com modelo real, 21-22/11/2026)
  it.each([
    "O cliente escolheu o horário das 08h30 (código h1). Vou confirmar com ele antes de marcar.\n\nAndré, só pra confirmar: você quer a avaliação amanhã às 08h30?",
    "O cliente escolheu o horário das 17h (código h2). Preciso confirmar.\n\nMarina, posso registrar a sessão de terça às 17h?",
    "O cliente quer o primeiro horário (h1).\n\nPerfeito! Só confirmando: segunda às 9h, certo?",
  ])("barra o vazamento real: %s", (text) => {
    const leak = detectLeakedModelMarkup(text, agenda);
    expect(leak).not.toBeNull();
    expect(["offer_code", "reasoning_narration"]).toContain(leak!.kind);
  });
  it.each([
    ["Pode ser o h1 então? Me confirma (código h2)", "offer_code"],
    ["Tenho terça às 10h (h3).", "offer_code"],
    ["Vou usar bookOfferedTime para reservar.", "offer_code"],
    ["A cliente pediu o horário das 10h. Vou registrar.", "reasoning_narration"],
    ["Certo. O cliente confirmou, então vou reservar.", "reasoning_narration"],
  ])("barra %j como %s", (text, kind) => {
    expect(detectLeakedModelMarkup(text, agenda)?.kind).toBe(kind);
  });
  it.each([
    "Tenho terça-feira, 24/11, às 10h ou às 14h30. Qual prefere?",
    "Atendemos das 8h às 18h. A sessão dura 1h30.",
    "Seu pedido foi registrado para as 8h30, aguardando a equipe.",
    "A turma H2O começa às 19h",
    "O cliente anterior desmarcou, por isso tenho vaga às 10h", // "O cliente anterior": sem verbo de narração logo depois
    "Posso te ajudar? Se o cliente chegar atrasado a gente espera 10 minutos.", // "o cliente" no meio da frase
  ])("não barra texto legítimo: %s", (text) => {
    expect(detectLeakedModelMarkup(text, agenda)).toBeNull();
  });
  it("limite documentado: 'h1' solto em frase legítima com a agenda ligada é barrado (regenera uma vez; o prompt manda não escrever códigos)", () => {
    expect(detectLeakedModelMarkup("Sala h1 liberada", agenda)?.kind).toBe("offer_code");
  });
  it("SEM a opção agenda a regra não existe (grupos, tradução e voz podem falar de 'o cliente' e de 'h1')", () => {
    expect(detectLeakedModelMarkup("O cliente escolheu o horário das 08h30 (código h1).")).toBeNull();
    expect(detectLeakedModelMarkup("Veja a seção h1 e (h2).", {})).toBeNull();
  });
  it("a marcação técnica continua vindo ANTES dos vazamentos da agenda", () => {
    expect(detectLeakedModelMarkup("<think>x</think> O cliente escolheu (código h1)", agenda)?.kind).toBe("reasoning_leftover");
  });
  it("isAgendaTextLeak e describe", () => {
    const leak = detectLeakedModelMarkup("O cliente escolheu o horário (código h1).", agenda)!;
    expect(isAgendaTextLeak(leak)).toBe(true);
    expect(isAgendaTextLeak(detectLeakedModelMarkup("<think>x", agenda)!)).toBe(false);
    expect(describeLeakedModelMarkup(leak)).toMatch(/^Saída com código de oferta ou nome de ferramenta vazado \(offer_code\)/);
  });
});
