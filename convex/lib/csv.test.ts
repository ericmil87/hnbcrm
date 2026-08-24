import { describe, it, expect } from "vitest";
import {
  parseCsv,
  serializeCsv,
  detectDelimiter,
  formatCsvValue,
  CSV_BOM,
} from "./csv";

describe("parseCsv", () => {
  it("lê cabeçalhos e linhas de um CSV simples", () => {
    const { headers, rows, delimiter } = parseCsv("nome,email\nAna,ana@ex.com\nBia,bia@ex.com\n");
    expect(headers).toEqual(["nome", "email"]);
    expect(delimiter).toBe(",");
    expect(rows).toEqual([
      { nome: "Ana", email: "ana@ex.com" },
      { nome: "Bia", email: "bia@ex.com" },
    ]);
  });

  it("remove o BOM do início do arquivo", () => {
    const { headers, rows } = parseCsv(`${CSV_BOM}nome,cidade\nAna,São Paulo\n`);
    expect(headers).toEqual(["nome", "cidade"]);
    expect(rows[0]).toEqual({ nome: "Ana", cidade: "São Paulo" });
  });

  it("detecta ponto e vírgula como delimitador", () => {
    const { headers, rows, delimiter } = parseCsv("nome;valor\nAna;1.234,56\n");
    expect(delimiter).toBe(";");
    expect(headers).toEqual(["nome", "valor"]);
    expect(rows[0].valor).toBe("1.234,56");
  });

  it("detecta TAB como delimitador", () => {
    const { headers, delimiter } = parseCsv("nome\temail\nAna\tana@ex.com\n");
    expect(delimiter).toBe("\t");
    expect(headers).toEqual(["nome", "email"]);
  });

  it("respeita o delimitador forçado por opção", () => {
    const { headers } = parseCsv("nome;email\nAna;ana@ex.com", { delimiter: "," });
    expect(headers).toEqual(["nome;email"]);
  });

  it("não conta delimitadores que estão dentro de aspas na detecção", () => {
    expect(detectDelimiter('"Silva; Ana",1;2\n')).toBe(",");
  });

  it("preserva aspas escapadas por duplicação", () => {
    const { rows } = parseCsv('nome,obs\nAna,"Disse ""oi"" ontem"\n');
    expect(rows[0].obs).toBe('Disse "oi" ontem');
  });

  it("aceita quebra de linha dentro de campo entre aspas", () => {
    const { rows } = parseCsv('nome,obs\nAna,"linha 1\nlinha 2"\nBia,ok\n');
    expect(rows).toHaveLength(2);
    expect(rows[0].obs).toBe("linha 1\nlinha 2");
    expect(rows[1]).toEqual({ nome: "Bia", obs: "ok" });
  });

  it("preserva o delimitador dentro de campo entre aspas", () => {
    const { rows } = parseCsv('nome,tags\nAna,"vip,quente"\n');
    expect(rows[0].tags).toBe("vip,quente");
  });

  it("ignora linhas totalmente vazias", () => {
    const { rows } = parseCsv("\n\nnome,email\n\nAna,ana@ex.com\n,\n\nBia,bia@ex.com\n\n");
    expect(rows).toEqual([
      { nome: "Ana", email: "ana@ex.com" },
      { nome: "Bia", email: "bia@ex.com" },
    ]);
  });

  it("aceita CRLF, LF e CR como fim de linha", () => {
    expect(parseCsv("a,b\r\n1,2\r\n").rows).toEqual([{ a: "1", b: "2" }]);
    expect(parseCsv("a,b\r1,2\r").rows).toEqual([{ a: "1", b: "2" }]);
    expect(parseCsv("a,b\n1,2").rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("completa colunas faltantes com vazio e descarta as excedentes", () => {
    const { rows } = parseCsv("a,b,c\n1,2\n1,2,3,4\n");
    expect(rows[0]).toEqual({ a: "1", b: "2", c: "" });
    expect(rows[1]).toEqual({ a: "1", b: "2", c: "3" });
  });

  it("renomeia cabeçalhos vazios e duplicados", () => {
    const { headers, rows } = parseCsv("Nome,,Nome\nAna,x,Silva\n");
    expect(headers).toEqual(["Nome", "coluna_2", "Nome (2)"]);
    expect(rows[0]).toEqual({ Nome: "Ana", coluna_2: "x", "Nome (2)": "Silva" });
  });

  it("devolve vazio para texto em branco", () => {
    expect(parseCsv("")).toEqual({ headers: [], rows: [], delimiter: "," });
    expect(parseCsv("   \n\n")).toEqual({ headers: [], rows: [], delimiter: "," });
  });

  it("tolera espaços antes das aspas de abertura", () => {
    const { rows } = parseCsv('nome,obs\nAna, "com espaço"\n');
    expect(rows[0].obs).toBe("com espaço");
  });
});

describe("serializeCsv", () => {
  it("escreve BOM, cabeçalho e linhas com CRLF", () => {
    const csv = serializeCsv(["nome", "email"], [{ nome: "Ana", email: "ana@ex.com" }]);
    expect(csv).toBe(`${CSV_BOM}nome,email\r\nAna,ana@ex.com\r\n`);
  });

  it("escapa aspas, delimitador e quebra de linha", () => {
    const csv = serializeCsv(["a"], [{ a: 'diz "oi", sai\nagora' }], { bom: false });
    expect(csv).toBe('a\r\n"diz ""oi"", sai\nagora"\r\n');
  });

  it("converte números, booleanos, datas, arrays e nulos", () => {
    expect(formatCsvValue(12.5)).toBe("12.5");
    expect(formatCsvValue(true)).toBe("true");
    expect(formatCsvValue(null)).toBe("");
    expect(formatCsvValue(undefined)).toBe("");
    expect(formatCsvValue(["vip", "quente"])).toBe("vip;quente");
    expect(formatCsvValue(new Date(Date.UTC(2026, 7, 23)))).toBe("2026-08-23T00:00:00.000Z");
    expect(formatCsvValue({ a: 1 })).toBe('{"a":1}');
  });

  it("usa célula vazia para coluna ausente na linha", () => {
    const csv = serializeCsv(["a", "b"], [{ a: "1" }], { bom: false });
    expect(csv).toBe("a,b\r\n1,\r\n");
  });

  it("aceita delimitador, fim de linha e BOM customizados", () => {
    const csv = serializeCsv(["a", "b"], [{ a: "1", b: "2" }], {
      delimiter: ";",
      eol: "\n",
      bom: false,
    });
    expect(csv).toBe("a;b\n1;2\n");
  });

  it("neutraliza fórmulas quando escapeFormulas está ligado", () => {
    const csv = serializeCsv(["a"], [{ a: "=1+1" }], { bom: false, escapeFormulas: true });
    expect(csv).toBe("a\r\n'=1+1\r\n");
    const plain = serializeCsv(["a"], [{ a: "=1+1" }], { bom: false });
    expect(plain).toBe("a\r\n=1+1\r\n");
  });

  it("prefixa com ' células que começam com = + @ ou TAB quando escapeFormulas está ligado", () => {
    const rows = [
      { a: "=HYPERLINK(\"http://mal.example\")" },
      { a: "+1234" },
      { a: "@SUM(A1)" },
      { a: "\tconteudo" },
    ];
    for (const row of rows) {
      const csv = serializeCsv(["a"], [row], { bom: false, escapeFormulas: true });
      const cell = row.a.includes('"') ? `"'${row.a.replace(/"/g, '""')}"` : `'${row.a}`;
      expect(csv).toBe(`a\r\n${cell}\r\n`);
    }
  });

  it("não prefixa número puro negativo (inteiro ou decimal pt-BR) mesmo com escapeFormulas ligado", () => {
    expect(serializeCsv(["a"], [{ a: "-123" }], { bom: false, escapeFormulas: true })).toBe(
      "a\r\n-123\r\n"
    );
    // Delimitador ";" evita a quotação por causa da vírgula decimal — o que
    // importa aqui é que NÃO leva o prefixo `'` de neutralização de fórmula.
    expect(
      serializeCsv(["a"], [{ a: "-1.234,56" }], {
        bom: false,
        escapeFormulas: true,
        delimiter: ";",
      })
    ).toBe("a\r\n-1.234,56\r\n");
  });

  it("prefixa com ' quando o valor começa com - mas não é um número puro", () => {
    const csv = serializeCsv(["a"], [{ a: "-abc" }], { bom: false, escapeFormulas: true });
    expect(csv).toBe("a\r\n'-abc\r\n");
  });

  it("não neutraliza fórmulas por padrão (sem passar escapeFormulas)", () => {
    const csv = serializeCsv(["a"], [{ a: "=1+1" }, { a: "-123" }], { bom: false });
    expect(csv).toBe("a\r\n=1+1\r\n-123\r\n");
  });

  it("faz round-trip com parseCsv preservando acentos e valores complexos", () => {
    const headers = ["nome", "obs", "tags"];
    const rows = [
      { nome: "Ana Álvares", obs: 'quebra\nde "linha", ok', tags: ["vip", "quente"] },
      { nome: "Bia", obs: " espaços ", tags: [] },
    ];
    const parsed = parseCsv(serializeCsv(headers, rows));
    expect(parsed.headers).toEqual(headers);
    expect(parsed.rows[0]).toEqual({
      nome: "Ana Álvares",
      obs: 'quebra\nde "linha", ok',
      tags: "vip;quente",
    });
    expect(parsed.rows[1]).toEqual({ nome: "Bia", obs: " espaços ", tags: "" });
  });
});
