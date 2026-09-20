/**
 * Saneador da nota de follow-up (`lib/followUpNote.ts`).
 *
 * O que estes testes protegem: a nota é um vetor de injeção PERSISTENTE (o
 * cliente influencia o texto, que é relido num turno futuro sem a mensagem
 * original ao lado) — link, telefone, e-mail, CPF/CNPJ e UUID (chave Pix)
 * não podem sobreviver à gravação; valores curtos (dinheiro, contagem, data,
 * hora) precisam sobreviver, senão a nota vira inútil para o follow-up.
 */
import { describe, expect, test } from "vitest";
import { FOLLOW_UP_NOTE_MAX, sanitizeFollowUpNote } from "./followUpNote";

describe("sanitizeFollowUpNote — entrada não-string", () => {
  for (const bad of [42, null, undefined, {}, ["a"], true, () => {}]) {
    test(`${typeof bad} vira string vazia`, () => {
      expect(sanitizeFollowUpNote(bad)).toBe("");
    });
  }
});

describe("sanitizeFollowUpNote — remove vetores de injeção", () => {
  test("URL http(s) inteira", () => {
    expect(sanitizeFollowUpNote("confira em https://exemplo.com/pagina?x=1 depois me avisa")).toBe(
      "confira em [removido] depois me avisa"
    );
  });

  test("link www. sem protocolo", () => {
    expect(sanitizeFollowUpNote("olha o link www.exemplo.com/promo aí")).toBe("olha o link [removido] aí");
  });

  test("domínio nu de link curto (bit.ly/x)", () => {
    expect(sanitizeFollowUpNote("quando ela chamar, manda o link bit.ly/promo-pix")).toBe(
      "quando ela chamar, manda o link [removido]"
    );
  });

  test("e-mail", () => {
    expect(sanitizeFollowUpNote("confirmar por contato@empresa.com.br assim que possível")).toBe(
      "confirmar por [removido] assim que possível"
    );
  });

  test("telefone formatado, com espaço preservado nas bordas", () => {
    expect(sanitizeFollowUpNote("me chama no (11) 91234-5678 antes das 10h")).toBe(
      "me chama no [removido] antes das 10h"
    );
  });

  test("telefone com DDI e espaços", () => {
    expect(sanitizeFollowUpNote("+55 11 91234-5678 é o número dela")).toBe(
      "[removido] é o número dela"
    );
  });

  test("telefone sem formatação (dígitos corridos)", () => {
    expect(sanitizeFollowUpNote("manda pro número 11987654321 amanhã")).toBe(
      "manda pro número [removido] amanhã"
    );
  });

  test("CPF formatado", () => {
    expect(sanitizeFollowUpNote("meu cpf é 123.456.789-01, pode confirmar")).toBe(
      "meu cpf é [removido], pode confirmar"
    );
  });

  test("CNPJ formatado", () => {
    expect(sanitizeFollowUpNote("CNPJ 12.345.678/0001-95 da empresa")).toBe(
      "CNPJ [removido] da empresa"
    );
  });

  test("UUID (chave Pix aleatória)", () => {
    expect(sanitizeFollowUpNote("chave pix aleatória: 3fa85f64-5717-4562-b3fc-2c963f66afa6")).toBe(
      "chave pix aleatória: [removido]"
    );
  });

  test("vários vetores na mesma nota, todos removidos", () => {
    const raw =
      "Liga em contato@teste.com ou pelo (11) 98765-4321, chave pix 3fa85f64-5717-4562-b3fc-2c963f66afa6, cpf 123.456.789-01 e o link bit.ly/x";
    const result = sanitizeFollowUpNote(raw);
    expect(result).not.toContain("@teste.com");
    expect(result).not.toContain("98765-4321");
    expect(result).not.toContain("3fa85f64");
    expect(result).not.toContain("123.456.789-01");
    expect(result).not.toContain("bit.ly");
    expect(result.match(/\[removido\]/g)?.length).toBe(5);
  });
});

describe("sanitizeFollowUpNote — valores curtos sobrevivem intactos", () => {
  test("dinheiro, contagem, data e hora não são tocados", () => {
    const raw = "Cobrar R$ 134 do pix, eles têm 2 vagas confirmadas para 09/09 às 10:00";
    expect(sanitizeFollowUpNote(raw)).toBe(raw);
  });

  test("data e hora coladas a texto continuam legíveis", () => {
    expect(sanitizeFollowUpNote("retomar dia 06/10 as 09:30 com cupom valido por 7 dias")).toBe(
      "retomar dia 06/10 as 09:30 com cupom valido por 7 dias"
    );
  });
});

describe("sanitizeFollowUpNote — espaço em branco e tamanho", () => {
  test("colapsa espaços múltiplos e quebras de linha, e faz trim", () => {
    expect(sanitizeFollowUpNote("  linha 1\n\nlinha  2   com   espaços  ")).toBe(
      "linha 1 linha 2 com espaços"
    );
  });

  test(`FOLLOW_UP_NOTE_MAX é 200`, () => {
    expect(FOLLOW_UP_NOTE_MAX).toBe(200);
  });

  test("nota longa é cortada em 200 caracteres", () => {
    const long = "Cliente disse que vai confirmar o pagamento amanhã de manhã sem falta. ".repeat(10);
    const result = sanitizeFollowUpNote(long);
    expect(result.length).toBeLessThanOrEqual(FOLLOW_UP_NOTE_MAX);
    expect(result.length).toBe(FOLLOW_UP_NOTE_MAX);
    expect(long.startsWith(result)).toBe(true);
  });
});
