import { describe, it, expect } from "vitest";
import {
  parseMarkdown,
  parseInline,
  inlineToPlainText,
  isSafeHref,
  type BlockNode,
} from "./markdown";

function firstOfType<T extends BlockNode["type"]>(
  blocks: BlockNode[],
  type: T
): Extract<BlockNode, { type: T }> {
  const found = blocks.find((b) => b.type === type);
  if (!found) throw new Error(`bloco "${type}" não encontrado`);
  return found as Extract<BlockNode, { type: T }>;
}

describe("markdown — inline", () => {
  it("renderiza negrito, itálico, riscado e código", () => {
    const nodes = parseInline("**forte** _leve_ ~~fora~~ `cod`");
    expect(nodes.map((n) => n.type)).toEqual([
      "strong",
      "text",
      "em",
      "text",
      "del",
      "text",
      "codeSpan",
    ]);
    expect(inlineToPlainText(nodes)).toBe("forte leve fora cod");
  });

  it("não transforma snake_case em itálico", () => {
    const nodes = parseInline("o campo lead_id_final some?");
    expect(nodes).toEqual([{ type: "text", value: "o campo lead_id_final some?" }]);
  });

  it("mantém asterisco solto como texto", () => {
    expect(parseInline("3 * 4 = 12")).toEqual([{ type: "text", value: "3 * 4 = 12" }]);
  });

  it("quebra de linha simples vira <br> (chat, não CommonMark)", () => {
    expect(parseInline("linha 1\nlinha 2").map((n) => n.type)).toEqual([
      "text",
      "break",
      "text",
    ]);
  });

  it("respeita escape de asterisco", () => {
    expect(parseInline("\\*não é negrito\\*")).toEqual([
      { type: "text", value: "*não é negrito*" },
    ]);
  });

  it("aceita link markdown e URL solta, e recusa esquema perigoso", () => {
    const link = parseInline("veja [o funil](https://app.hnbcrm.com/pipeline)");
    expect(link.find((n) => n.type === "link")).toMatchObject({
      href: "https://app.hnbcrm.com/pipeline",
    });

    const auto = parseInline("abre https://hnbcrm.com/app/painel.");
    expect(auto.find((n) => n.type === "link")).toMatchObject({
      href: "https://hnbcrm.com/app/painel",
    });

    expect(parseInline("[x](javascript:alert(1))")).toEqual([
      { type: "text", value: "[x](javascript:alert(1))" },
    ]);
    expect(isSafeHref("data:text/html,<script>")).toBe(false);
    expect(isSafeHref("/app/pipeline")).toBe(true);
  });

  it("não interpreta ênfase dentro de código", () => {
    const nodes = parseInline("`a_b_c` e `2 * 3`");
    expect(nodes.filter((n) => n.type === "codeSpan")).toHaveLength(2);
    expect(nodes.some((n) => n.type === "em")).toBe(false);
  });
});

describe("markdown — blocos", () => {
  it("lê tabela GFM com alinhamento", () => {
    const table = firstOfType(
      parseMarkdown(
        [
          "| Lead | Valor |",
          "|:-----|------:|",
          "| Eric Milfont | R$ 1.000,00 |",
          "| **Total** | **R$ 1.000,00** |",
        ].join("\n")
      ),
      "table"
    );
    expect(table.align).toEqual(["left", "right"]);
    expect(table.header.map(inlineToPlainText)).toEqual(["Lead", "Valor"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1][0].some((n) => n.type === "strong")).toBe(true);
  });

  it("lê tabela sem os pipes das bordas", () => {
    const table = firstOfType(
      parseMarkdown(["Lead | Estágio", "--- | ---", "Rubens | Novo contato"].join("\n")),
      "table"
    );
    expect(table.header.map(inlineToPlainText)).toEqual(["Lead", "Estágio"]);
    expect(table.rows[0].map(inlineToPlainText)).toEqual(["Rubens", "Novo contato"]);
  });

  it("preenche célula faltante em linha curta", () => {
    const table = firstOfType(
      parseMarkdown(["| a | b | c |", "|---|---|---|", "| 1 | 2 |"].join("\n")),
      "table"
    );
    expect(table.rows[0]).toHaveLength(3);
    expect(inlineToPlainText(table.rows[0][2])).toBe("");
  });

  it("lê tabela ainda sem linhas (streaming no meio)", () => {
    const table = firstOfType(parseMarkdown("| a | b |\n|---|---|"), "table");
    expect(table.rows).toEqual([]);
  });

  it("não confunde separador de tabela com regra horizontal", () => {
    const blocks = parseMarkdown("texto\n\n---\n\noutro");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "hr", "paragraph"]);
  });

  it("lê listas com marcador e numeradas, preservando o início", () => {
    const blocks = parseMarkdown("- um\n- dois\n\n3. três\n4. quatro");
    const bullets = blocks[0];
    const ordered = blocks[1];
    expect(bullets).toMatchObject({ type: "list", ordered: false });
    expect(ordered).toMatchObject({ type: "list", ordered: true, start: 3 });
    expect((ordered as Extract<BlockNode, { type: "list" }>).items).toHaveLength(2);
  });

  it("aninha lista indentada dentro do item", () => {
    const list = firstOfType(parseMarkdown("- pai\n  - filho\n- tio"), "list");
    expect(list.items).toHaveLength(2);
    expect(list.items[0].map((b) => b.type)).toEqual(["paragraph", "list"]);
  });

  it("lê bloco de código com linguagem e sem fechamento", () => {
    const closed = firstOfType(parseMarkdown("```json\n{ \"a\": 1 }\n```"), "codeBlock");
    expect(closed).toMatchObject({ lang: "json", value: '{ "a": 1 }' });

    const streaming = firstOfType(parseMarkdown("```ts\nconst a = 1;"), "codeBlock");
    expect(streaming.value).toBe("const a = 1;");
  });

  it("não interpreta markdown dentro do bloco de código", () => {
    const code = firstOfType(parseMarkdown("```\n**não** | é | tabela\n```"), "codeBlock");
    expect(code.value).toBe("**não** | é | tabela");
  });

  it("lê títulos e citações", () => {
    const blocks = parseMarkdown("### Resumo\n\n> atenção aqui");
    expect(blocks[0]).toMatchObject({ type: "heading", level: 3 });
    expect(blocks[1].type).toBe("blockquote");
  });

  it("separa parágrafo de tabela colada logo abaixo", () => {
    const blocks = parseMarkdown(
      "Os leads sem responsável são **3**:\n| Lead | Estágio |\n|---|---|\n| Rubens | Novo |"
    );
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "table"]);
  });

  it("devolve lista vazia para conteúdo vazio", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("   \n\n  ")).toEqual([]);
  });
});
