/**
 * Markdown do LLM → formatação do WhatsApp.
 *
 * O caso real que originou isto: a IA respondeu `**PORTO50**` e o cliente viu
 * os asteriscos. O que estes testes protegem, além das trocas, é o que NÃO pode
 * ser tocado — URL com `__` no caminho, chave Pix, `snake_case` — porque um
 * "conserto" ali quebra o link ou o dado que o cliente precisa copiar.
 */
import { describe, expect, test } from "vitest";
import { toWhatsAppText } from "./whatsappText";

describe("ênfase", () => {
  test("**x** e __x__ viram o negrito do WhatsApp", () => {
    expect(toWhatsAppText("Use o cupom **PORTO50** hoje")).toBe("Use o cupom *PORTO50* hoje");
    expect(toWhatsAppText("A __Vivência Maré Nova__ começa")).toBe(
      "A *Vivência Maré Nova* começa"
    );
  });

  test("~~x~~ vira o riscado do WhatsApp", () => {
    expect(toWhatsAppText("De ~~R$ 97~~ por R$ 67")).toBe("De ~R$ 97~ por R$ 67");
  });

  test("***x*** vira negrito, sem deixar asterisco órfão", () => {
    expect(toWhatsAppText("é ***urgente*** mesmo")).toBe("é *urgente* mesmo");
  });

  test("*x* e _x_ simples passam intactos (já são do WhatsApp)", () => {
    expect(toWhatsAppText("já é *negrito* e _itálico_")).toBe("já é *negrito* e _itálico_");
  });

  test("par que não fecha na mesma linha fica como veio", () => {
    // Converter aqui colocaria dois parágrafos inteiros em negrito.
    const solto = "Começo **sem fechar\n\noutro parágrafo** aqui";
    expect(toWhatsAppText(solto)).toBe(solto);
  });

  test("marcador solto não é inventado", () => {
    expect(toWhatsAppText("2 ** 3 = 8")).toBe("2 ** 3 = 8");
    expect(toWhatsAppText("**")).toBe("**");
  });
});

describe("títulos e listas", () => {
  test("título markdown vira negrito", () => {
    expect(toWhatsAppText("# Agenda\ntexto")).toBe("*Agenda*\ntexto");
    expect(toWhatsAppText("### Vagas abertas")).toBe("*Vagas abertas*");
  });

  test("título que já contém negrito não ganha asterisco duplo", () => {
    expect(toWhatsAppText("## **Agenda**")).toBe("*Agenda*");
  });

  test("marcador de lista * e + vira -", () => {
    expect(toWhatsAppText("* pão\n+ leite\n  * café")).toBe("- pão\n- leite\n  - café");
  });

  test("negrito no início da linha não é confundido com lista", () => {
    expect(toWhatsAppText("**Hoje** tem aula")).toBe("*Hoje* tem aula");
  });

  test("# no meio da linha não é título", () => {
    expect(toWhatsAppText("o item #3 chegou")).toBe("o item #3 chegou");
  });
});

describe("links e cerca", () => {
  test("link markdown vira rótulo: url", () => {
    expect(toWhatsAppText("veja [nosso site](https://aosfilhosdaterra.com.br)")).toBe(
      "veja nosso site: https://aosfilhosdaterra.com.br"
    );
  });

  test("rótulo igual à url não vira 'url: url'", () => {
    expect(toWhatsAppText("[https://x.com/a](https://x.com/a)")).toBe("https://x.com/a");
  });

  test("cerca de código some e o conteúdo fica", () => {
    expect(toWhatsAppText("segue:\n```json\n{\"a\":1}\n```")).toBe('segue:\n{"a":1}\n');
    // Cerca sem fechamento também não pode sobrar (viraria monoespaçado).
    expect(toWhatsAppText("abre ``` e não fecha")).toBe("abre  e não fecha");
  });
});

describe("o que NUNCA pode ser tocado", () => {
  test("URL com __ ou ** no caminho continua idêntica", () => {
    const url = "https://ex.com/__a__/b**c**d";
    expect(toWhatsAppText(`veja ${url} ok`)).toBe(`veja ${url} ok`);
  });

  test("negrito EM VOLTA de uma URL converte, sem tocar na URL", () => {
    expect(toWhatsAppText("**https://ex.com/a_b**")).toBe("*https://ex.com/a_b*");
  });

  test("chave Pix e e-mail passam intactos", () => {
    expect(toWhatsAppText("Pix: pix@milfont.net")).toBe("Pix: pix@milfont.net");
    expect(toWhatsAppText("contato_novo@empresa.com.br")).toBe("contato_novo@empresa.com.br");
  });

  test("snake_case no meio de palavra não vira ênfase", () => {
    expect(toWhatsAppText("o campo lead__id__final")).toBe("o campo lead__id__final");
    expect(toWhatsAppText("use lead_id no payload")).toBe("use lead_id no payload");
  });

  test("texto sem markdown nenhum sai idêntico", () => {
    const texto =
      "Oi, Maria! Tudo bem?\n\nA vivência é dia 07/10, às 9h.\nQualquer dúvida é só chamar 🌱";
    expect(toWhatsAppText(texto)).toBe(texto);
  });

  test("quebras de linha e espaçamento são preservados", () => {
    expect(toWhatsAppText("linha 1\n\n\nlinha 2  ")).toBe("linha 1\n\n\nlinha 2  ");
  });

  test("string vazia não quebra", () => {
    expect(toWhatsAppText("")).toBe("");
  });
});

describe("idempotência", () => {
  const casos = [
    "Use o cupom **PORTO50** hoje",
    "# Agenda\n* item __um__\n* item ~~dois~~\nveja [site](https://x.com/a__b__c)",
    "***tudo junto*** e https://ex.com/__z__",
    "Pix: pix@milfont.net — valor ~~R$ 97~~ **R$ 67**",
  ];

  test("aplicar duas vezes é igual a aplicar uma", () => {
    for (const caso of casos) {
      const uma = toWhatsAppText(caso);
      expect(toWhatsAppText(uma)).toBe(uma);
    }
  });
});
