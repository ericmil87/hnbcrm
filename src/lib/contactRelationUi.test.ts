import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  actionsMenuAiItems,
  aiMenuModel,
  aiQuiet,
  aiStateLine,
  aiTriggerLabel,
  asContactRelation,
  conversationContactRelation,
  needsRelationFrom,
  needsRelationText,
  relationChangedText,
  relationLabel,
  relationMetaLine,
  relationSheetTitle,
  shortName,
  undoArgs,
} from "./contactRelationUi";
import { formatDate } from "./format";

const base = { paused: false, off: false, hasPendingDraft: false, canReply: true, canEditContact: true };

describe("aiTriggerLabel / aiStateLine", () => {
  it("texto do botão da IA por estado", () => {
    expect(aiTriggerLabel({ paused: false, off: false })).toBe("IA ativa");
    expect(aiTriggerLabel({ paused: true, off: false })).toBe("IA pausada");
    expect(aiTriggerLabel({ paused: false, off: true })).toBe("IA desligada");
    expect(aiTriggerLabel({ paused: false, off: false, waiting: true })).toBe("IA em espera");
  });

  it("contato que não é cliente mostra o tipo, acima de pausa e espera", () => {
    expect(aiTriggerLabel({ paused: false, off: true, relation: "personal" })).toBe("IA desligada · Pessoal");
    expect(aiTriggerLabel({ paused: true, off: false, waiting: true, relation: "supplier" })).toBe(
      "IA desligada · Fornecedor"
    );
    expect(aiStateLine({ paused: false, off: true, relation: "team" })).toBe("IA desligada · contato Equipe");
    expect(aiQuiet({ paused: false, off: false, relation: "automated" })).toBe(true);
  });

  it("Lead (cliente) não muda o rótulo", () => {
    expect(aiTriggerLabel({ paused: false, off: false, relation: "customer" })).toBe("IA ativa");
    expect(aiStateLine({ paused: true, off: false, relation: "customer" })).toBe("IA pausada nesta conversa");
    expect(aiQuiet({ paused: false, off: false, relation: "customer" })).toBe(false);
  });
});

describe("aiMenuModel", () => {
  it("IA ativa: assumir, pedir sugestão e, depois do separador, Não é cliente…", () => {
    expect(aiMenuModel(base)).toEqual({ primary: ["assume", "ask"], secondary: ["notCustomer"] });
  });

  it("rascunho pendente esconde Pedir resposta sugerida; pausada mostra Devolver à IA", () => {
    expect(aiMenuModel({ ...base, hasPendingDraft: true }).primary).toEqual(["assume"]);
    expect(aiMenuModel({ ...base, paused: true }).primary).toEqual(["return"]);
  });

  it("sem inbox:reply não há ações da IA; sem contacts:edit não há Não é cliente…", () => {
    expect(aiMenuModel({ ...base, canReply: false })).toEqual({ primary: [], secondary: ["notCustomer"] });
    expect(aiMenuModel({ ...base, canEditContact: false })).toEqual({ primary: ["assume", "ask"], secondary: [] });
  });

  it("contato marcado: só Virar lead e Trocar tipo…", () => {
    expect(aiMenuModel({ ...base, off: true, relation: "personal" })).toEqual({
      primary: ["turnLead", "changeType"],
      secondary: [],
    });
    expect(aiMenuModel({ ...base, relation: "partner", canEditContact: false })).toEqual({ primary: [], secondary: [] });
  });
});

describe("actionsMenuAiItems (⋮)", () => {
  it("repete as ações do botão da IA, sem o Não é cliente…", () => {
    expect(actionsMenuAiItems({ ...base, showAiControls: true })).toEqual(["assume", "ask"]);
    expect(actionsMenuAiItems({ ...base, paused: true, showAiControls: true })).toEqual(["return"]);
  });

  it("sem controles da IA no canal não há seção; contato marcado mostra Virar lead mesmo assim", () => {
    expect(actionsMenuAiItems({ ...base, showAiControls: false })).toEqual([]);
    expect(actionsMenuAiItems({ ...base, relation: "personal", showAiControls: false })).toEqual(["turnLead"]);
    expect(actionsMenuAiItems({ ...base, relation: "personal", canEditContact: false, showAiControls: true })).toEqual(
      []
    );
  });
});

describe("tipo do contato", () => {
  it("lê o tipo da linha ou do contato e ignora valores desconhecidos", () => {
    expect(conversationContactRelation({ contactRelation: "team" })).toBe("team");
    expect(conversationContactRelation({ contact: { relation: "personal" } })).toBe("personal");
    expect(conversationContactRelation({ contactRelation: "family" })).toBeUndefined();
    expect(conversationContactRelation(null)).toBeUndefined();
    expect(asContactRelation(42)).toBeUndefined();
  });

  it("rótulos e título da folha", () => {
    expect(relationLabel(undefined)).toBe("Sem tipo");
    expect(relationLabel("customer")).toBe("Lead");
    expect(relationSheetTitle("Mieko Kawano")).toBe("Quem é Mieko Kawano?");
    expect(relationSheetTitle("  ")).toBe("Quem é este contato?");
  });
});

describe("toasts e Desfazer", () => {
  it("usa o primeiro nome", () => {
    expect(shortName("Mieko Kawano")).toBe("Mieko");
    expect(shortName("")).toBe("Contato");
    expect(relationChangedText("Mieko Kawano", "personal")).toBe("Mieko agora está como Pessoal");
    expect(relationChangedText("Mieko Kawano", "customer")).toBe("Mieko agora é lead");
    expect(relationChangedText("Mieko", null)).toBe("Mieko agora está sem tipo");
  });

  it("desfazer volta ao tipo anterior e restaura o lead ao sair de não-cliente", () => {
    expect(undoArgs(undefined, "personal")).toEqual({ relation: null, restoreLead: true });
    expect(undoArgs("customer", "supplier")).toEqual({ relation: "customer", restoreLead: true });
    expect(undoArgs("personal", "customer")).toEqual({ relation: "personal" });
    expect(undoArgs("personal", "team")).toEqual({ relation: "personal" });
  });
});

describe("relationMetaLine", () => {
  it("monta quem, quando e por onde", () => {
    const setAt = Date.UTC(2026, 10, 18, 15);
    expect(relationMetaLine({ setAt, source: "telegram" }, "Kenji")).toBe(
      `Marcado por Kenji em ${formatDate(setAt)} (pelo Telegram)`
    );
    expect(relationMetaLine({ setAt, source: "desconhecida" })).toBe(`Marcado em ${formatDate(setAt)}`);
    expect(relationMetaLine(null)).toBeNull();
  });
});

describe("needsRelationFrom", () => {
  it("lê o retorno { needsRelation, relation }", () => {
    expect(needsRelationFrom({ needsRelation: true, relation: "team" })).toBe("team");
    expect(needsRelationFrom({ ok: true })).toBeNull();
    expect(needsRelationFrom(null)).toBeNull();
    expect(needsRelationFrom("x")).toBeNull();
  });

  it("lê o ConvexError { code: needs_relation }", () => {
    expect(needsRelationFrom(new ConvexError({ code: "needs_relation", relation: "supplier" }))).toBe("supplier");
    expect(needsRelationFrom(new ConvexError({ code: "outro", relation: "supplier" }))).toBeNull();
    expect(needsRelationFrom(new ConvexError("Mensagem"))).toBeNull();
    expect(needsRelationFrom(new Error("boom"))).toBeNull();
  });

  it("tipo ausente ou inválido cai em Pessoal (ainda pede o tipo)", () => {
    expect(needsRelationFrom({ needsRelation: true })).toBe("personal");
  });

  it("texto do diálogo", () => {
    expect(needsRelationText("Mieko Kawano", "personal")).toBe(
      "Mieko Kawano está como Pessoal. A IA não responde contatos que não são clientes."
    );
    expect(needsRelationText("", "automated")).toMatch(/^Este contato está como Robô\./);
  });
});
