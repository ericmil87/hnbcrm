import { describe, expect, it } from "vitest";
import { extractButtonLabels, extractUiStrings, sentenceCaseViolations } from "./uiStrings";

const texts = (src: string) => extractUiStrings(src).map((s) => s.text);

describe("extractUiStrings", () => {
  it("extrai texto JSX simples", () => {
    expect(texts(`<h1>Requer atenção</h1>`)).toEqual(["Requer atenção"]);
  });

  it("ignora texto com expressão e mantém o texto estático vizinho", () => {
    expect(texts(`<p>Olá {name}, bem-vindo</p><span>Fixo</span>`)).toEqual(["Fixo"]);
  });

  it("extrai literais de atributos de rótulo", () => {
    const out = texts(`<Input label="E-mail" placeholder='Seu nome' title="Dica" description="Texto" />`);
    expect(out).toEqual(expect.arrayContaining(["E-mail", "Seu nome", "Dica", "Texto"]));
  });

  it("extrai aria-label", () => {
    expect(texts(`<button aria-label="Fechar painel" />`)).toEqual(["Fechar painel"]);
  });

  it("extrai literais de toast.*", () => {
    expect(texts(`toast.error("Não foi possível salvar."); toast.success('Lead criado');`)).toEqual([
      "Não foi possível salvar.",
      "Lead criado",
    ]);
  });

  it("ignora comentários de linha, de bloco e JSX", () => {
    const src = `// <p>Repasses</p>\n/* title="Pipeline" */\n<div>{/* Handoff */}<b>Ok</b></div>`;
    expect(texts(src)).toEqual(["Ok"]);
  });

  it("template literal: ignora a parte dinâmica", () => {
    expect(texts("toast.info(`Salvo em ${board.name} agora`)")).toEqual(["Salvo em agora"]);
  });

  it("ignora className e identificadores", () => {
    const src = `<div className="Board Pipeline" id="Repasses">{Pipeline}</div>`;
    expect(texts(src)).toEqual([]);
  });

  it("junta texto multilinha em uma frase e informa a linha inicial", () => {
    const src = `<p>\n  Primeira linha\n  segunda linha\n</p>`;
    expect(extractUiStrings(src)).toEqual([{ text: "Primeira linha segunda linha", line: 2 }]);
  });

  it("decodifica entidades HTML", () => {
    expect(texts(`<p>Tom &amp; Jerry&nbsp;&quot;ok&quot;</p>`)).toEqual(['Tom & Jerry "ok"']);
  });

  it("não confunde setas e comparações com texto JSX", () => {
    expect(texts(`const f = (a) => a > 1 && b < 2;`)).toEqual([]);
  });
});

describe("extractButtonLabels", () => {
  it("lê o texto direto do Button, mesmo com arrow function nas props", () => {
    const src = `<Button onClick={() => go()} variant="primary">Assumir conversa</Button>`;
    expect(extractButtonLabels(src).map((b) => b.text)).toEqual(["Assumir conversa"]);
  });

  it("ignora Button autofechado e partes dinâmicas", () => {
    const src = `<Button iconOnly aria-label="x" /><Button>{n} Itens</Button>`;
    expect(extractButtonLabels(src).map((b) => b.text)).toEqual(["Itens"]);
  });
});

describe("sentenceCaseViolations", () => {
  it("aceita sentence case, nomes próprios e siglas", () => {
    expect(sentenceCaseViolations("Conectar WhatsApp por QR code")).toEqual([]);
    expect(sentenceCaseViolations("Exportar CSV: Todos os leads")).toEqual([]);
  });
  it("aponta palavras em Title Case", () => {
    expect(sentenceCaseViolations("Adicionar Nota Rápida")).toEqual(["Nota", "Rápida"]);
  });
});
