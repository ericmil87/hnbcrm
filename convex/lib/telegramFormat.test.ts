import { describe, expect, test } from "vitest";
import {
  escapeHtml,
  htmlToPlainText,
  isBalancedHtml,
  expandableQuote,
  markdownToTelegramHtml,
  maskDigitRuns,
  splitMessage,
  TELEGRAM_TEXT_LIMIT,
} from "./telegramFormat";

describe("escapeHtml", () => {
  test("só os três escapes do HTML do Telegram", () => {
    expect(escapeHtml(`a & b < c > d "e" 'f'`)).toBe(`a &amp; b &lt; c &gt; d "e" 'f'`);
  });
});

describe("expandableQuote", () => {
  test("embrulha e escapa", () => {
    expect(expandableQuote("Oi <b>")).toBe("<blockquote expandable>Oi &lt;b&gt;</blockquote>");
  });
});

describe("maskDigitRuns", () => {
  test("telefone com separadores vira os 4 últimos", () => {
    expect(maskDigitRuns("Ligue +55 11 98765-4321 hoje")).toBe("Ligue •••4321 hoje");
    expect(maskDigitRuns("cpf 12345678900")).toBe("cpf •••8900");
  });
  test("valores, datas e números curtos ficam", () => {
    expect(maskDigitRuns("R$ 58.000 em 03/11/2026, item 1234")).toBe("R$ 58.000 em 03/11/2026, item 1234");
  });

  test("grupos separados por ponto, hífen, barra ou espaço são UM run", () => {
    expect(maskDigitRuns("tel 11.98765.4321")).toBe("tel •••4321");
    expect(maskDigitRuns("cpf 123.456.789-00")).toBe("cpf •••8900");
    expect(maskDigitRuns("cnpj 12.345.678/0001-90")).toBe("cnpj •••0190");
    expect(maskDigitRuns("(11) 98765-4321")).toBe("•••4321");
    expect(maskDigitRuns("+55 (11) 98765 4321")).toBe("•••4321");
  });

  test("datas, horas e dinheiro não são mascarados", () => {
    expect(maskDigitRuns("em 2026-11-03 às 14:30")).toBe("em 2026-11-03 às 14:30");
    expect(maskDigitRuns("vence 03/11/2026 23:59:59")).toBe("vence 03/11/2026 23:59:59");
    expect(maskDigitRuns("R$ 58.000 ou R$ 1.234,56 ou R$1234567")).toBe("R$ 58.000 ou R$ 1.234,56 ou R$1234567");
    expect(maskDigitRuns("total 12.345,67 hoje")).toBe("total 12.345,67 hoje");
  });

  test("misturado: só o identificador cai", () => {
    expect(maskDigitRuns("Maria 11 98765-4321 pagou R$ 4.320,00 em 2026-11-03")).toBe(
      "Maria •••4321 pagou R$ 4.320,00 em 2026-11-03",
    );
  });
});

describe("markdownToTelegramHtml", () => {
  test("golden: resposta típica do Copiloto", () => {
    const md = [
      "## Leads parados",
      "",
      "4 leads em **Proposta** há mais de _5 dias_:",
      "- Pedro Nunes · `R$ 3.200`",
      "* Bia & Co",
      "1. Ver [pipeline](https://hnbcrm.com/app/pipeline?lead=1&x=2)",
      "",
      "| Nome | Valor |",
      "|------|-------|",
      "| Pedro | R$ 3.200 |",
      "",
      "```",
      "if (a < b) return;",
      "```",
      "> citação *leve*",
      "---",
      "~~velho~~ fim",
    ].join("\n");
    expect(markdownToTelegramHtml(md)).toBe(
      [
        "<b>Leads parados</b>",
        "",
        "4 leads em <b>Proposta</b> há mais de <i>5 dias</i>:",
        "• Pedro Nunes · <code>R$ 3.200</code>",
        "• Bia &amp; Co",
        '1. Ver <a href="https://hnbcrm.com/app/pipeline?lead=1&amp;x=2">pipeline</a>',
        "",
        "Nome · Valor",
        "Pedro · R$ 3.200",
        "",
        "<pre>if (a &lt; b) return;</pre>",
        "<blockquote>citação <i>leve</i></blockquote>",
        "<s>velho</s> fim",
      ].join("\n"),
    );
  });

  test("tag maliciosa descartada: HTML cru é escapado, link não-http vira texto", () => {
    const out = markdownToTelegramHtml(
      `<script>alert(1)</script> <a href="javascript:alert(1)">x</a> [clique](javascript:alert(1)) <b>oi</b>`,
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<a href="javascript/i);
    expect(out).not.toMatch(/<b>oi<\/b>/);
    expect(out).toBe(
      `&lt;script&gt;alert(1)&lt;/script&gt; &lt;a href="javascript:alert(1)"&gt;x&lt;/a&gt; clique &lt;b&gt;oi&lt;/b&gt;`,
    );
  });

  test("underscore dentro de palavra e de URL não vira itálico", () => {
    expect(markdownToTelegramHtml("snake_case_name e [doc](https://x.com/a_b_c)")).toBe(
      'snake_case_name e <a href="https://x.com/a_b_c">doc</a>',
    );
  });

  test("marcas cruzadas caem no texto puro escapado (D12), nunca em HTML mal aninhado", () => {
    const out = markdownToTelegramHtml("~~a **b~~ c** & <x>");
    expect(isBalancedHtml(out)).toBe(true);
    expect(out).toBe("a b c &amp; &lt;x&gt;");
    // Texto bem formado continua com tags.
    expect(markdownToTelegramHtml("**a** ~~b~~")).toBe("<b>a</b> <s>b</s>");
  });

  test("fallback remove marcas de lista, título e link", () => {
    expect(markdownToTelegramHtml("## T\n- **a ~~b** c~~ [x](https://e.com) [y](javascript:z)")).toBe(
      "T\n• a b c x (https://e.com) y",
    );
  });

  test("isBalancedHtml e htmlToPlainText", () => {
    expect(isBalancedHtml("<b>a <i>b</i></b>")).toBe(true);
    expect(isBalancedHtml("<s>a <b>b</s></b>")).toBe(false);
    expect(isBalancedHtml("<b>a")).toBe(false);
    expect(htmlToPlainText('<a href="https://x">a &amp; &lt;b&gt;</a>')).toBe("a & <b>");
  });

  test("aspas na URL não quebram o atributo", () => {
    expect(markdownToTelegramHtml('[x](https://x.com/"onmouseover=1)')).not.toContain('"onmouseover');
  });
});

describe("splitMessage", () => {
  test("texto curto é um bloco só", () => {
    expect(splitMessage("oi")).toEqual(["oi"]);
  });

  test("quebra em fronteira de linha e respeita o limite", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `linha ${i} ${"x".repeat(20)}`);
    const chunks = splitMessage(lines.join("\n"));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    // Nenhuma linha cortada ao meio.
    expect(chunks.join("\n").split("\n")).toEqual(lines);
  });

  test("linha gigante sem espaço é cortada fora de entidade", () => {
    const text = "&amp;".repeat(2000);
    const chunks = splitMessage(text, 100);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
      expect(c).toMatch(/^(&amp;)+$/);
    }
    expect(chunks.join("")).toBe(text);
  });

  test("tag aberta no corte é fechada e reaberta no bloco seguinte", () => {
    const body = Array.from({ length: 60 }, (_, i) => `linha ${i}`).join("\n");
    const chunks = splitMessage(`<blockquote expandable>${body}</blockquote>`, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(200);
      expect(c.startsWith("<blockquote expandable>")).toBe(true);
      expect(c.endsWith("</blockquote>")).toBe(true);
    }
  });
});
