import { describe, expect, it } from "vitest";
import { blockNames, firstNameAndInitial, type NameInput } from "./agendaBlockNames";

const item = (id: string, label: string, startMin: number, endMin: number, widthPx = 70, time = "09:00"): NameInput => ({ id, label, startMin, endMin, widthPx, time });

describe("firstNameAndInitial", () => {
  it("primeiro nome e inicial do último sobrenome", () => {
    expect(firstNameAndInitial("Teste Ana Souza")).toBe("Teste S.");
    expect(firstNameAndInitial("teste a")).toBe("teste A.");
    expect(firstNameAndInitial("Maria")).toBe("Maria");
  });
});

describe("blockNames", () => {
  it("bloco estreito mostra primeiro nome + inicial quando cabe", () => {
    const m = blockNames([item("a", "Teste Ana", 540, 600, 70)]);
    expect(m.get("a")).toEqual({ text: "Teste A.", withTime: false });
  });
  it("quando não cabe, só o primeiro nome", () => {
    const m = blockNames([item("a", "Teste Ana", 540, 600, 40)]);
    expect(m.get("a")).toEqual({ text: "Teste", withTime: false });
  });
  it("blocos médios e largos ficam fora (nome inteiro)", () => {
    expect(blockNames([item("a", "Teste Ana", 540, 600, 120), item("b", "Teste Beto", 540, 600)]).has("a")).toBe(false);
  });
  it("homônimos lado a lado no mesmo grupo: a inicial desfaz o empate, mesmo apertada", () => {
    const m = blockNames([item("a", "Teste Ana", 540, 600, 40), item("b", "Teste Beto", 540, 600, 40), item("c", "Teste Carla", 540, 600, 40)]);
    expect([...m.values()].map((v) => v.text)).toEqual(["Teste A.", "Teste B.", "Teste C."]);
  });
  it("mesmo nome e inicial: soma a hora só em quem repete", () => {
    const m = blockNames([item("a", "Teste Ana", 540, 600, 70, "09:00"), item("b", "Teste Ana", 555, 615, 70, "09:15"), item("c", "Outra Pessoa", 540, 600, 70)]);
    expect(m.get("a")).toEqual({ text: "Teste A. 09:00", withTime: true });
    expect(m.get("b")).toEqual({ text: "Teste A. 09:15", withTime: true });
    expect(m.get("c")).toEqual({ text: "Outra P.", withTime: false });
  });
  it("homônimos em horários que não se sobrepõem não são desambiguados", () => {
    const m = blockNames([item("a", "Teste Ana", 540, 600, 40), item("b", "Teste Beto", 660, 720, 40)]);
    expect(m.get("a")!.text).toBe("Teste");
    expect(m.get("b")!.text).toBe("Teste");
  });
});
