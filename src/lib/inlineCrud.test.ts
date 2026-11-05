import { describe, expect, it } from "vitest";
import { initialInlineCrud, inlineCrudReducer, type InlineCrudAction } from "./inlineCrud";

const EMPTY = { name: "", type: "website" };
const run = (s: ReturnType<typeof initialInlineCrud<typeof EMPTY>>, a: InlineCrudAction<typeof EMPTY>) =>
  inlineCrudReducer(s, a, EMPTY);

describe("inlineCrudReducer", () => {
  it("começa fechado e sem edição", () => {
    expect(initialInlineCrud(EMPTY)).toEqual({ showForm: false, editingId: null, form: EMPTY, confirmDeleteId: null });
  });

  it("startCreate abre o formulário em branco, descartando edição anterior", () => {
    let s = run(initialInlineCrud(EMPTY), { type: "startEdit", id: "a", form: { name: "X", type: "ads" } });
    s = run(s, { type: "startCreate" });
    expect(s).toMatchObject({ showForm: true, editingId: null, form: EMPTY });
  });

  it("startEdit abre com os dados do item", () => {
    const s = run(initialInlineCrud(EMPTY), { type: "startEdit", id: "a", form: { name: "X", type: "ads" } });
    expect(s).toMatchObject({ showForm: true, editingId: "a", form: { name: "X", type: "ads" } });
  });

  it("cancel fecha e sai do modo edição, mantendo o rascunho", () => {
    let s = run(initialInlineCrud(EMPTY), { type: "startCreate" });
    s = run(s, { type: "patchForm", patch: { name: "Rascunho" } });
    s = run(s, { type: "cancel" });
    expect(s).toMatchObject({ showForm: false, editingId: null, form: { name: "Rascunho", type: "website" } });
  });

  it("saved fecha e zera o formulário", () => {
    let s = run(initialInlineCrud(EMPTY), { type: "startEdit", id: "a", form: { name: "X", type: "ads" } });
    s = run(s, { type: "saved" });
    expect(s).toEqual({ showForm: false, editingId: null, form: EMPTY, confirmDeleteId: null });
  });

  it("patchForm altera só os campos informados; setForm troca tudo", () => {
    let s = run(initialInlineCrud(EMPTY), { type: "patchForm", patch: { type: "ads" } });
    expect(s.form).toEqual({ name: "", type: "ads" });
    s = run(s, { type: "setForm", form: { name: "Z", type: "x" } });
    expect(s.form).toEqual({ name: "Z", type: "x" });
  });

  it("askDelete guarda o id; cancelDelete e confirmDelete limpam", () => {
    let s = run(initialInlineCrud(EMPTY), { type: "askDelete", id: "k" });
    expect(s.confirmDeleteId).toBe("k");
    expect(run(s, { type: "cancelDelete" }).confirmDeleteId).toBeNull();
    s = run(s, { type: "confirmDelete" });
    expect(s.confirmDeleteId).toBeNull();
  });
});
