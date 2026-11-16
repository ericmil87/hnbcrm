import { describe, expect, it } from "vitest";
import {
  MAX_STATE_CHARS,
  MAX_TURNS,
  MAX_TURN_CHARS,
  maskPersonalData,
  prepareJevState,
  sanitizeJevState,
  stableStringify,
  stateHash,
} from "./state";
import { JevValidationError } from "./types";

const rejects = (input: unknown, re: RegExp) => {
  try {
    sanitizeJevState(input);
  } catch (e) {
    expect(e).toBeInstanceOf(JevValidationError);
    expect((e as JevValidationError).code).toBe("invalid_state");
    expect((e as Error).message).toMatch(re);
    return (e as Error).message;
  }
  throw new Error("deveria ter lançado");
};

describe("PII nunca entra no estado", () => {
  it("campo fora da lista é REJEITADO (nome, telefone, e-mail, cpf, id…), sem ecoar o valor", () => {
    for (const k of ["nome", "name", "telefone", "phone", "email", "cpf", "documento", "id", "leadId", "conversationId", "contactId"]) {
      const msg = rejects({ mensagem: "oi", [k]: "Maria da Silva 81999998888" }, /campo não permitido/);
      expect(msg).not.toContain("Maria");
      expect(msg).not.toContain("81999998888");
    }
  });
  it("campo fora da lista dentro de lead/empresa/fala também é rejeitado", () => {
    rejects({ lead: { etapa: "novo", nome: "Maria" } }, /campo não permitido \(nome\)/);
    rejects({ lead: { etapa: "novo", telefone: "81999998888" } }, /campo não permitido \(telefone\)/);
    rejects({ empresa: { segmento: "x", cnpj: "1" } }, /campo não permitido \(cnpj\)/);
    rejects({ historico: [{ de: "lead", texto: "oi", contactId: "abc" }] }, /campo não permitido/);
    rejects({ historico: [{ de: "cliente", texto: "oi" }] }, /"lead" ou "empresa"/);
  });
  it("estado vazio ou não-objeto é rejeitado", () => {
    rejects({}, /vazio/);
    rejects(null, /objeto/);
    rejects([], /objeto/);
  });
  it("PII no TEXTO LIVRE é mascarada (telefone, e-mail, CPF, CNPJ, link, id)", () => {
    const out = sanitizeJevState({
      mensagem: "me liga no +55 (81) 99999-8888 ou 81 99999 8888, mail maria.silva@exemplo.com.test, cpf 123.456.789-09, 12345678909, cnpj 12.345.678/0001-95",
      historico: [
        { de: "lead", texto: "meu site é https://exemplo.com.br/perfil?id=9 e www.exemplo.com" },
        { de: "empresa", texto: "lead 8f3a2c1d-1111-4222-8333-444455556666 e ks7a8f9d2b3c4e5f6a7b8c9d0e1f2a3b" },
      ],
    });
    const json = JSON.stringify(out);
    for (const leak of ["99999", "8888", "maria.silva", "exemplo.com", "123.456.789", "12345678909", "12.345.678", "8f3a2c1d", "ks7a8f9d2b3c"]) {
      expect(json, leak).not.toContain(leak);
    }
    expect(json).toContain("[telefone]");
    expect(json).toContain("[email]");
    expect(json).toContain("[cpf]");
    expect(json).toContain("[cnpj]");
    expect(json).toContain("[link]");
    expect(json).toContain("[id]");
  });
  it("não mascara o que não é PII: preço, data, hora, quantidade pequena", () => {
    expect(maskPersonalData("sessão custa R$ 180,00, pacote R$ 1.500,00 e R$ 12.345.678 de teto")).toBe("sessão custa R$ 180,00, pacote R$ 1.500,00 e R$ 12.345.678 de teto");
    expect(maskPersonalData("dia 15/11/2026 às 10:30 ou 2026-11-15, 3 vezes por semana, 2 pessoas")).toBe("dia 15/11/2026 às 10:30 ou 2026-11-15, 3 vezes por semana, 2 pessoas");
  });
  it("campos aceitos continuam passando, em PT-BR com acento", () => {
    const out = sanitizeJevState({
      mensagem: "Quero saber o preço do pacote",
      lead: { etapa: "Inscrição em andamento", origem: "instagram", tags: ["quente"] },
      empresa: { segmento: "estúdio de terapias", produtos: ["sessão individual"], horario: "seg-sex 09:00-18:00" },
      politica: { desconto_maximo: 0.15, aceita_pix: true, moeda: "BRL" },
    });
    expect(out).toMatchObject({ mensagem: "Quero saber o preço do pacote", lead: { etapa: "Inscrição em andamento" }, politica: { aceita_pix: true } });
  });
  it("política só aceita chave simples e valor escalar", () => {
    rejects({ politica: { "Chave Ruim": 1 } }, /chave inválida/);
    rejects({ politica: { a: { b: 1 } } }, /texto, número ou booleano/);
  });
});

describe("truncamento", () => {
  it(`histórico fica com o FIM (${MAX_TURNS} falas) e cada fala é cortada em ${MAX_TURN_CHARS} caracteres`, () => {
    const historico = Array.from({ length: 20 }, (_, i) => ({ de: i % 2 ? ("empresa" as const) : ("lead" as const), texto: `fala ${i} ` + "x".repeat(900) }));
    const out = sanitizeJevState({ historico }) as { historico: Array<{ texto: string }> };
    expect(out.historico).toHaveLength(MAX_TURNS);
    expect(out.historico[0].texto.startsWith("fala 12 ")).toBe(true);
    expect(out.historico.at(-1)!.texto.startsWith("fala 19 ")).toBe(true);
    for (const t of out.historico) expect(Array.from(t.texto).length).toBeLessThanOrEqual(MAX_TURN_CHARS);
  });
  it("não corta no meio de um emoji", () => {
    const out = sanitizeJevState({ mensagem: "😀".repeat(2000) }) as { mensagem: string };
    expect(out.mensagem.endsWith("…")).toBe(true);
    expect([...out.mensagem].every((c) => c === "😀" || c === "…")).toBe(true);
  });
  it("estado acima do teto total é rejeitado", () => {
    const politica = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "y".repeat(200)]));
    rejects({ politica, mensagem: "x" }, new RegExp(`${MAX_STATE_CHARS}`));
  });
});

describe("hash estável", () => {
  it("a ordem das chaves não muda o hash; o conteúdo muda", async () => {
    const a = await stateHash({ b: 1, a: { y: [1, 2], x: "z" } });
    const b = await stateHash({ a: { x: "z", y: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await stateHash({ b: 2, a: { x: "z", y: [1, 2] } })).not.toBe(a);
  });
  it("undefined some como no JSON; número não finito lança", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(() => stableStringify({ a: Number.NaN })).toThrow();
  });
  it("é o hash do estado JÁ LIMPO: dois textos que só diferem no telefone dão o mesmo hash", async () => {
    const p1 = await prepareJevState({ mensagem: "liga 81 99999-1111" });
    const p2 = await prepareJevState({ mensagem: "liga 81 99999-2222" });
    expect(p1.stateHash).toBe(p2.stateHash);
    expect(JSON.stringify(p1)).not.toContain("9999");
  });
  it("valor conhecido (regressão do formato do hash)", async () => {
    expect(await stateHash({ a: 1 })).toBe("015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862");
  });
});
