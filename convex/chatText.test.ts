/**
 * Meta Messaging F3: saída do atendente em TEXTO PURO para Instagram e
 * Messenger (`toPlainChatText`). Tabela markdown → texto.
 */
import { describe, expect, test } from "vitest";
import { toPlainChatText } from "./lib/chatText";

describe("toPlainChatText", () => {
  test.each([
    ["negrito markdown", "O cupom é **PORTO50**!", "O cupom é PORTO50!"],
    ["negrito do WhatsApp", "O cupom é *PORTO50*!", "O cupom é PORTO50!"],
    ["negrito+itálico", "***Atenção***: hoje", "Atenção: hoje"],
    ["itálico com _", "Fica _bem_ perto", "Fica bem perto"],
    ["negrito com __", "Fica __bem__ perto", "Fica bem perto"],
    ["riscado ~~", "De ~~R$ 100~~ por R$ 80", "De R$ 100 por R$ 80"],
    ["riscado do WhatsApp ~", "De ~R$ 100~ por R$ 80", "De R$ 100 por R$ 80"],
    ["título", "## Horários\nSeg a sex", "Horários\nSeg a sex"],
    ["título com negrito", "# **Menu**", "Menu"],
    ["crase inline", "Use o código `PIX10`", "Use o código PIX10"],
    ["cerca de código", "```json\n{\"a\":1}\n```", "{\"a\":1}\n"],
    ["link", "Veja [o cardápio](https://ex.com/menu)", "Veja o cardápio (https://ex.com/menu)"],
    ["link com rótulo igual à URL", "[https://ex.com](https://ex.com)", "https://ex.com"],
    ["lista com *", "* um\n* dois", "- um\n- dois"],
    ["lista com +", "+ um\n+ dois", "- um\n- dois"],
    ["lista com •", "• um\n• dois", "- um\n- dois"],
    ["lista numerada fica", "1. um\n2. dois", "1. um\n2. dois"],
    ["citação", "> frase citada", "frase citada"],
    ["régua some", "antes\n---\ndepois", "antes\n\ndepois"],
    ["negrito em item de lista", "- **Seg**: 9h", "- Seg: 9h"],
    ["negrito colado em URL", "**https://ex.com/a_b**", "https://ex.com/a_b"],
    ["URL com _ intacta", "Acesse https://ex.com/__init__/a_b_c", "Acesse https://ex.com/__init__/a_b_c"],
    ["e-mail com _ intacto", "Escreva para joao_silva@ex.com.br", "Escreva para joao_silva@ex.com.br"],
    ["snake_case intacto", "o campo lead_id e lead__id", "o campo lead_id e lead__id"],
    ["multiplicação intacta", "2*3 = 6", "2*3 = 6"],
    ["** órfão some", "Preço: **R$ 10", "Preço: R$ 10"],
    ["emojis e acentos preservados", "Olá, *João*! 😊🎉 Até já", "Olá, João! 😊🎉 Até já"],
    ["quebras preservadas", "linha 1\n\nlinha 2\n", "linha 1\n\nlinha 2\n"],
    ["itálico em palavra acentuada", "é _ótimo_ mesmo", "é ótimo mesmo"],
    ["escape de asterisco", "Isso \\*isso\\* aqui", "Isso isso aqui"],
    ["escape de sublinhado e hashtag", "\\_nota\\_ e \\#promo", "nota e #promo"],
    ["escape de pontuação comum", "1\\. Pix por R\\$ 50 \\- à vista", "1. Pix por R$ 50 - à vista"],
    ["cerca de tis", "~~~\ncódigo\n~~~", "código\n"],
    ["cerca de 4 crases", "````md\ncódigo\n````", "código\n"],
    ["crases dentro de cerca maior somem", "````md\n```x```\n````", "x\n"],
    ["cerca sem fechamento some", "```\nsolto", "\nsolto"],
  ])("%s", (_name, input, expected) => {
    expect(toPlainChatText(input)).toBe(expected);
  });

  test("idempotente", () => {
    const inputs = [
      "**A** e _b_ com [link](https://ex.com/x_y) e `c`\n* item\n## Título",
      "Oi! 😊 Tudo *bem*?",
    ];
    for (const input of inputs) {
      const once = toPlainChatText(input);
      expect(toPlainChatText(once)).toBe(once);
    }
  });

  test("resultado nunca carrega marcadores de ênfase do WhatsApp", () => {
    const out = toPlainChatText(
      "**Promoção** de *hoje*: _só_ ~~amanhã~~ hoje!\n* pizza\n* refri\n### Fim"
    );
    expect(out).not.toMatch(/[*_~#`]/);
    expect(out).toBe("Promoção de hoje: só amanhã hoje!\n- pizza\n- refri\nFim");
  });

  test("texto vazio volta como veio", () => {
    expect(toPlainChatText("")).toBe("");
  });
});
