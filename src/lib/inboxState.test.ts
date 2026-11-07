import { describe, expect, it } from "vitest";
import {
  KIND_FILTER_KEY,
  activeBotSuspicion,
  aiStateChipInfo,
  applyInboxChip,
  countUnreadConversations,
  inboxFilterChips,
  decideConversationParamAction,
  emptyListMessage,
  filterConversations,
  isHandoffPending,
  linkedMatchesView,
  listFilterKey,
  readKindFilter,
} from "./inboxState";

describe("activeBotSuspicion", () => {
  const base = { at: 1, source: "heuristic" as const, reason: "resposta automática" };
  it("devolve a suspeita sem clearedAt", () => {
    expect(activeBotSuspicion({ botSuspicion: base })).toEqual(base);
  });
  it("ignora suspeita já limpa", () => {
    expect(activeBotSuspicion({ botSuspicion: { ...base, clearedAt: 5 } })).toBeNull();
  });
  it("aceita conversa ausente ou sem suspeita", () => {
    expect(activeBotSuspicion(null)).toBeNull();
    expect(activeBotSuspicion(undefined)).toBeNull();
    expect(activeBotSuspicion({})).toBeNull();
  });
});

describe("isHandoffPending", () => {
  it("só é pendente com estado diferente de completed", () => {
    expect(isHandoffPending(undefined)).toBe(false);
    expect(isHandoffPending(null)).toBe(false);
    expect(isHandoffPending({ status: "completed" })).toBe(false);
    expect(isHandoffPending({ status: "pending" })).toBe(true);
    expect(isHandoffPending({ status: "accepted", reason: "x" })).toBe(true);
  });
});

describe("aiStateChipInfo", () => {
  const at = 1;
  it("sem estado ou done: sem chip", () => {
    expect(aiStateChipInfo(undefined)).toBeNull();
    expect(aiStateChipInfo(null)).toBeNull();
    expect(aiStateChipInfo({ status: "done", reason: null, at, afterLastInbound: true })).toBeNull();
  });
  it("pending e processing: IA preparando resposta", () => {
    for (const status of ["pending", "processing"]) {
      expect(aiStateChipInfo({ status, reason: null, at, afterLastInbound: false })).toEqual({
        label: "IA preparando resposta…",
        tone: "processing",
      });
    }
  });
  it("skipped/failed depois da última mensagem: IA em espera com o motivo", () => {
    const chip = aiStateChipInfo({ status: "skipped", reason: "ia_pausada", at, afterLastInbound: true });
    expect(chip).toEqual({ label: "IA em espera: IA pausada nesta conversa", tone: "waiting" });
    expect(aiStateChipInfo({ status: "failed", reason: null, at, afterLastInbound: true })?.label).toBe(
      "IA em espera: motivo desconhecido"
    );
  });
  it("item antigo (superado por mensagem mais nova): sem chip", () => {
    expect(aiStateChipInfo({ status: "skipped", reason: "ia_pausada", at, afterLastInbound: false })).toBeNull();
  });
});

describe("readKindFilter", () => {
  const store = (value: string | null) => ({ getItem: (k: string) => (k === KIND_FILTER_KEY ? value : null) });
  it("lê só valores válidos", () => {
    expect(readKindFilter(store(null))).toBe("all");
    expect(readKindFilter(store("group"))).toBe("group");
    expect(readKindFilter(store("direct"))).toBe("direct");
    expect(readKindFilter(store("lixo"))).toBe("all");
  });
  it("localStorage bloqueado ou ausente não quebra", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readKindFilter(blocked)).toBe("all");
    expect(readKindFilter(null)).toBe("all");
  });
});

describe("filterConversations", () => {
  const list = [
    { id: "a", kind: "direct", labelIds: ["l1"] },
    { id: "b", kind: "group", labelIds: ["l1", "l2"] },
    { id: "c", kind: undefined, labelIds: undefined },
  ];
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  it("all sem etiqueta devolve tudo", () => {
    expect(ids(filterConversations(list, { kind: "all", labelId: null }))).toEqual(["a", "b", "c"]);
  });
  it("direct inclui conversa sem kind; group só grupos", () => {
    expect(ids(filterConversations(list, { kind: "direct", labelId: null }))).toEqual(["a", "c"]);
    expect(ids(filterConversations(list, { kind: "group", labelId: null }))).toEqual(["b"]);
  });
  it("etiqueta combina com o tipo", () => {
    expect(ids(filterConversations(list, { kind: "all", labelId: "l1" }))).toEqual(["a", "b"]);
    expect(ids(filterConversations(list, { kind: "group", labelId: "l2" }))).toEqual(["b"]);
    expect(ids(filterConversations(list, { kind: "direct", labelId: "l2" }))).toEqual([]);
  });
});

describe("listFilterKey", () => {
  it("muda com os filtros de servidor", () => {
    const base = listFilterKey(false, {}, {});
    expect(listFilterKey(true, {}, {})).not.toBe(base);
    expect(listFilterKey(false, { queue: "mine" }, {})).not.toBe(base);
    expect(listFilterKey(false, {}, { channel: "whatsapp" })).not.toBe(base);
  });
  it("é estável para os mesmos filtros", () => {
    expect(listFilterKey(true, { a: 1 }, { b: 2 })).toBe(listFilterKey(true, { a: 1 }, { b: 2 }));
    expect(listFilterKey(false, {}, {})).toBe("active|{}|{}");
  });
});

describe("linkedMatchesView", () => {
  it("exige a mesma aba (ativas x arquivadas)", () => {
    expect(linkedMatchesView({ archivedAt: 1 }, true, "all")).toBe(true);
    expect(linkedMatchesView({ archivedAt: 1 }, false, "all")).toBe(false);
    expect(linkedMatchesView({}, false, "all")).toBe(true);
    expect(linkedMatchesView({}, true, "all")).toBe(false);
  });
  it("respeita Diretas/Grupos", () => {
    expect(linkedMatchesView({ kind: "group" }, false, "group")).toBe(true);
    expect(linkedMatchesView({ kind: "direct" }, false, "group")).toBe(false);
    expect(linkedMatchesView({ kind: "group" }, false, "direct")).toBe(false);
  });
  it("sem conversa não casa", () => {
    expect(linkedMatchesView(null, false, "all")).toBe(false);
  });
});

describe("decideConversationParamAction", () => {
  const base = { param: null, selected: null, listLoaded: true, inList: false, linked: null, showArchived: false };
  it("sem param e sem seleção: nada", () => {
    expect(decideConversationParamAction(base)).toEqual({ type: "none" });
  });
  it("sem param com conversa aberta (voltar do navegador): fecha", () => {
    expect(decideConversationParamAction({ ...base, selected: "c1" })).toEqual({ type: "close" });
  });
  it("param igual à seleção: nada", () => {
    expect(decideConversationParamAction({ ...base, param: "c1", selected: "c1" })).toEqual({ type: "none" });
  });
  it("espera a lista carregar", () => {
    expect(decideConversationParamAction({ ...base, param: "c1", listLoaded: false, inList: true })).toEqual({
      type: "none",
    });
  });
  it("id na lista: abre direto", () => {
    expect(decideConversationParamAction({ ...base, param: "c1", inList: true })).toEqual({
      type: "select",
      id: "c1",
    });
  });
  it("fora da lista: espera o resolver", () => {
    expect(decideConversationParamAction({ ...base, param: "c1" })).toEqual({ type: "none" });
    expect(decideConversationParamAction({ ...base, param: "c1", linked: { _id: "outra" } })).toEqual({
      type: "none",
    });
  });
  it("fora da lista e resolvida: abre; arquivada troca a aba", () => {
    expect(decideConversationParamAction({ ...base, param: "c1", linked: { _id: "c1" } })).toEqual({
      type: "select",
      id: "c1",
    });
    expect(
      decideConversationParamAction({ ...base, param: "c1", linked: { _id: "c1", archivedAt: 9 } })
    ).toEqual({ type: "select", id: "c1", archivedTab: true });
    expect(
      decideConversationParamAction({
        ...base,
        param: "c1",
        showArchived: true,
        linked: { _id: "c1" },
      })
    ).toEqual({ type: "select", id: "c1", archivedTab: false });
  });
});

describe("emptyListMessage", () => {
  const base = { kind: "all" as const, showArchived: false, queueFilterActive: false, labelId: null };
  it("Grupos vem antes de arquivadas e oferece escolher grupos", () => {
    expect(emptyListMessage({ ...base, kind: "group" })).toEqual({
      text: "Nenhum grupo acompanhado",
      chooseGroups: true,
    });
    expect(emptyListMessage({ ...base, kind: "group", showArchived: true }).chooseGroups).toBe(false);
  });
  it("Diretas, fila, arquivadas, etiqueta e vazio geral", () => {
    expect(emptyListMessage({ ...base, kind: "direct" }).text).toBe("Nenhuma conversa direta");
    expect(emptyListMessage({ ...base, kind: "direct", showArchived: true }).text).toBe(
      "Nenhuma conversa direta arquivada"
    );
    expect(emptyListMessage({ ...base, queueFilterActive: true }).text).toBe("Nenhuma conversa nesta fila");
    expect(emptyListMessage({ ...base, queueFilterActive: true, showArchived: true }).text).toBe(
      "Nenhuma conversa arquivada nesta fila"
    );
    expect(emptyListMessage({ ...base, showArchived: true, labelId: "l" }).text).toBe("Nenhuma conversa arquivada");
    expect(emptyListMessage({ ...base, labelId: "l" }).text).toBe("Nenhuma conversa com essa etiqueta");
    expect(emptyListMessage(base).text).toBe("Nenhuma conversa ainda");
  });
  it("Não lidas", () => {
    expect(emptyListMessage({ ...base, unreadOnly: true }).text).toBe("Nenhuma conversa não lida");
  });
});

describe("filtro 'Não lidas'", () => {
  const list = [
    { id: "a", unreadCount: 2 },
    { id: "b", unreadCount: 0 },
    { id: "c" },
    { id: "d", kind: "group", unreadCount: 1 },
  ];
  it("filterConversations com unreadOnly mantém só as não lidas (e combina com o tipo)", () => {
    expect(filterConversations(list, { kind: "all", labelId: null, unreadOnly: true }).map((c) => c.id)).toEqual([
      "a",
      "d",
    ]);
    expect(filterConversations(list, { kind: "direct", labelId: null, unreadOnly: true }).map((c) => c.id)).toEqual([
      "a",
    ]);
  });
  it("countUnreadConversations conta conversas, não mensagens", () => {
    expect(countUnreadConversations(list)).toBe(2);
    expect(countUnreadConversations([])).toBe(0);
  });
});

describe("chips da lista (celular)", () => {
  const labels = [{ _id: "l1", name: "VIP", color: "#10b981" }];
  const none = { kind: "all" as const, unreadOnly: false, labelId: null };

  it("Todas pressionado sem filtro; Grupos só com grupo; uma por etiqueta", () => {
    const chips = inboxFilterChips(none, { labels, showGroups: false, unreadCount: 0 });
    expect(chips.map((c) => c.id)).toEqual(["all", "unread", "label:l1"]);
    expect(chips[0].pressed).toBe(true);
    expect(chips[1].count).toBeUndefined();
    const withGroups = inboxFilterChips(none, { labels: [], showGroups: true, unreadCount: 12 });
    expect(withGroups.map((c) => c.id)).toEqual(["all", "unread", "group"]);
    expect(withGroups[1].count).toBe(12);
  });

  it("filtro guardado em Diretas/Grupos sempre tem chip para desligar", () => {
    expect(inboxFilterChips({ ...none, kind: "direct" }, { labels: [], showGroups: false, unreadCount: 0 })).toEqual([
      { id: "all", label: "Todas", pressed: false },
      { id: "unread", label: "Não lidas", pressed: false, count: undefined },
      { id: "direct", label: "Diretas", pressed: true },
    ]);
    const group = inboxFilterChips({ ...none, kind: "group" }, { labels: [], showGroups: false, unreadCount: 0 });
    expect(group.find((c) => c.id === "group")?.pressed).toBe(true);
  });

  it("applyInboxChip: Todas limpa; os outros ligam e desligam", () => {
    const busy = { kind: "group" as const, unreadOnly: true, labelId: "l1" };
    expect(applyInboxChip("all", busy)).toEqual(none);
    expect(applyInboxChip("unread", none)).toEqual({ ...none, unreadOnly: true });
    expect(applyInboxChip("unread", busy).unreadOnly).toBe(false);
    expect(applyInboxChip("group", none).kind).toBe("group");
    expect(applyInboxChip("group", busy).kind).toBe("all");
    expect(applyInboxChip("direct", { ...none, kind: "direct" }).kind).toBe("all");
    expect(applyInboxChip("label:l1", none).labelId).toBe("l1");
    expect(applyInboxChip("label:l1", busy).labelId).toBeNull();
    expect(applyInboxChip("label:l2", busy).labelId).toBe("l2");
    expect(applyInboxChip("desconhecido", busy)).toBe(busy);
  });
});
