import { describe, expect, it } from "vitest";
import {
  KIND_FILTER_KEY,
  isPlausibleConvexId,
  listShowsAi,
  rowAiMode,
  activeBotSuspicion,
  aiStateChipInfo,
  applyInboxChip,
  applyRelationFilter,
  countUnreadConversations,
  hasChipFilters,
  inboxFilterChips,
  inboxMoreFilters,
  showGroupsChip,
  NO_CHIP_FILTERS,
  decideConversationParamAction,
  emptyListMessage,
  filterConversations,
  mergeOpenConversation,
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

  it("contato que não é cliente não vira 'IA em espera' (vale o 'IA desligada · <Tipo>')", () => {
    expect(aiStateChipInfo({ status: "skipped", reason: "contato_nao_cliente", at, afterLastInbound: true })).toBeNull();
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
  it("keepId: a conversa aberta não some ao ser marcada como lida", () => {
    const withIds = [
      { _id: "a", unreadCount: 2 },
      { _id: "b", unreadCount: 0 },
    ];
    expect(
      filterConversations(withIds, { kind: "all", labelId: null, unreadOnly: true, keepId: "b" }).map((c) => c._id)
    ).toEqual(["a", "b"]);
  });
  it("countUnreadConversations conta conversas, não mensagens", () => {
    expect(countUnreadConversations(list)).toBe(2);
    expect(countUnreadConversations([])).toBe(0);
  });
});

describe("chips da lista (celular)", () => {
  const labels = [{ _id: "l1", name: "VIP", color: "#10b981" }];
  const none = NO_CHIP_FILTERS;

  it("Todas pressionado sem filtro; Grupos só com grupo; uma por etiqueta", () => {
    const chips = inboxFilterChips(none, { labels, showGroups: false, unreadCount: 0 });
    expect(chips.map((c) => c.id)).toEqual(["all", "unread", "mine", "leads", "personal", "label:l1", "stage"]);
    expect(chips[0].pressed).toBe(true);
    expect(chips[1].count).toBeUndefined();
    const withGroups = inboxFilterChips(none, { labels: [], showGroups: true, unreadCount: 12 });
    expect(withGroups.map((c) => c.id)).toEqual(["all", "unread", "mine", "leads", "personal", "group", "stage"]);
    expect(withGroups[1].count).toBe(12);
  });

  it("filtro guardado em Diretas/Grupos sempre tem chip para desligar", () => {
    expect(inboxFilterChips({ ...none, kind: "direct" }, { labels: [], showGroups: false, unreadCount: 0 })).toEqual([
      { id: "all", label: "Todas", pressed: false },
      { id: "unread", label: "Não lidas", pressed: false, count: undefined },
      { id: "mine", label: "Minhas", pressed: false },
      { id: "leads", label: "Leads", pressed: false },
      { id: "personal", label: "Pessoais", pressed: false },
      { id: "direct", label: "Diretas", pressed: true },
      { id: "stage", label: "Etapa", pressed: false },
    ]);
    const group = inboxFilterChips({ ...none, kind: "group" }, { labels: [], showGroups: false, unreadCount: 0 });
    expect(group.find((c) => c.id === "group")?.pressed).toBe(true);
  });

  it("Minhas: liga, combina com Não lidas/Grupos e Todas limpa", () => {
    const chips = inboxFilterChips({ ...none, mine: true }, { labels: [], showGroups: false, unreadCount: 0 });
    expect(chips.find((c) => c.id === "mine")?.pressed).toBe(true);
    expect(chips.find((c) => c.id === "all")?.pressed).toBe(false);
    const on = applyInboxChip("mine", none);
    expect(on.mine).toBe(true);
    const combined = applyInboxChip("group", applyInboxChip("unread", on));
    expect(combined).toMatchObject({ mine: true, unreadOnly: true, kind: "group" });
    expect(applyInboxChip("mine", on).mine).toBe(false);
    expect(applyInboxChip("all", combined)).toEqual(none);
  });

  it("Minhas: estado vazio próprio", () => {
    expect(
      emptyListMessage({ kind: "all", showArchived: false, queueFilterActive: false, labelId: null, mine: true }).text
    ).toBe("Nenhuma conversa atribuída a você");
  });

  it("applyInboxChip: Todas limpa; os outros ligam e desligam", () => {
    const busy = { ...none, kind: "group" as const, unreadOnly: true, labelId: "l1" };
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

  it("canal/conta ativos (guardados no aparelho): chip marcado que desliga, e Todas desmarcado", () => {
    const withChannel = { ...none, channel: "instagram", configId: "cfg1" };
    const chips = inboxFilterChips(withChannel, {
      labels: [],
      showGroups: false,
      unreadCount: 0,
      channelLabel: "Instagram",
      accountLabel: "@casalumiar",
    });
    expect(chips.map((c) => [c.id, c.label, c.pressed])).toEqual([
      ["all", "Todas", false],
      ["unread", "Não lidas", false],
      ["mine", "Minhas", false],
      ["leads", "Leads", false],
      ["personal", "Pessoais", false],
      ["channel", "Instagram", true],
      ["account", "@casalumiar", true],
      ["stage", "Etapa", false],
    ]);
    expect(applyInboxChip("account", withChannel)).toEqual({ ...withChannel, configId: null });
    expect(applyInboxChip("channel", withChannel)).toEqual(none);
    expect(applyInboxChip("all", { ...withChannel, unreadOnly: true, kind: "direct" })).toEqual(none);
  });

  it("contador de não lidas vira mínimo ('12+') quando pode haver mais", () => {
    const [, unread] = inboxFilterChips(none, { labels: [], showGroups: false, unreadCount: 12, unreadMore: true });
    expect(unread).toMatchObject({ count: 12, countMore: true });
    const [, zero] = inboxFilterChips(none, { labels: [], showGroups: false, unreadCount: 0, unreadMore: true });
    expect(zero.countMore).toBeUndefined();
  });
});

describe("filtros Etapa e IA (chips)", () => {
  const none = NO_CHIP_FILTERS;
  const base = { labels: [], showGroups: false, unreadCount: 0 };

  it("Etapa vem depois de Grupos e das etiquetas; IA depois de Etapa, só com IA na org", () => {
    const labels = [{ _id: "l1", name: "VIP", color: "#10b981" }];
    expect(inboxFilterChips(none, { ...base, labels, showGroups: true }).map((c) => c.id)).toEqual([
      "all", "unread", "mine", "leads", "personal", "group", "label:l1", "stage",
    ]);
    expect(inboxFilterChips(none, { ...base, labels, showGroups: true, showAi: true }).map((c) => c.id)).toEqual([
      "all", "unread", "mine", "leads", "personal", "group", "label:l1", "stage", "ai",
    ]);
  });

  it("etapa escolhida mostra o nome (ou 'Etapa' sem nome) e desmarca Todas", () => {
    const named = inboxFilterChips({ ...none, stageId: "s1" }, { ...base, stageLabel: "Proposta" });
    expect(named.find((c) => c.id === "stage")).toMatchObject({ label: "Proposta", pressed: true });
    expect(named[0].pressed).toBe(false);
    expect(inboxFilterChips({ ...none, stageId: "s1" }, base).find((c) => c.id === "stage")?.label).toBe("Etapa");
  });

  it("filtro de IA ativo sempre tem chip (mesmo sem IA no lote) com o rótulo da opção", () => {
    const chips = inboxFilterChips({ ...none, ai: "off" }, base);
    expect(chips.find((c) => c.id === "ai")).toMatchObject({ label: "IA desligada", pressed: true });
    expect(chips[0].pressed).toBe(false);
  });

  it("tocar no chip ativo limpa; Todas limpa tudo", () => {
    expect(applyInboxChip("stage", { ...none, stageId: "s1" }).stageId).toBeNull();
    expect(applyInboxChip("ai", { ...none, ai: "on" }).ai).toBeNull();
    expect(applyInboxChip("all", { ...none, stageId: "s1", ai: "on" })).toEqual(none);
  });

  it("lista vazia explica etapa e IA (olham as conversas mais recentes)", () => {
    const e = { kind: "all" as const, showArchived: false, queueFilterActive: false, labelId: null };
    expect(emptyListMessage({ ...e, stageId: "s1" }).text).toBe("Nenhuma conversa nesta etapa");
    expect(emptyListMessage({ ...e, ai: "on" }).text).toBe("Nenhuma conversa com a IA atendendo entre as mais recentes");
    expect(emptyListMessage({ ...e, ai: "off" }).text).toBe("Nenhuma conversa com a IA desligada entre as mais recentes");
  });
});

describe("estado da IA na linha", () => {
  const NOW = 1_000_000;
  it("campo ausente = null (servidor antigo)", () => {
    expect(rowAiMode({}, NOW)).toBeNull();
  });
  it("usa aiMode; cai em aiAttending sem aiMode", () => {
    expect(rowAiMode({ aiMode: "suggest" }, NOW)).toBe("suggest");
    expect(rowAiMode({ aiAttending: true }, NOW)).toBe("auto");
    expect(rowAiMode({ aiAttending: false }, NOW)).toBe("off");
  });
  it("pausa com prazo (que o servidor não vê) desliga; pausa vencida não", () => {
    expect(rowAiMode({ aiMode: "auto", aiPausedUntil: NOW + 1 }, NOW)).toBe("off");
    expect(rowAiMode({ aiMode: "auto", aiPausedUntil: NOW - 1 }, NOW)).toBe("auto");
  });
  it("listShowsAi: org sem IA (tudo off) esconde; IA em alguma linha ou filtro ativo mostra", () => {
    expect(listShowsAi([{ aiMode: "off", aiAttending: false }], false)).toBe(false);
    expect(listShowsAi([{}], false)).toBe(false);
    expect(listShowsAi([{ aiMode: "off" }, { aiMode: "suggest", aiAttending: true }], false)).toBe(true);
    expect(listShowsAi([{ aiMode: "off" }], true)).toBe(true);
  });
  it("isPlausibleConvexId barra lixo da URL", () => {
    expect(isPlausibleConvexId("k17abcdefghijklmnopqrstuvwxyz0123".slice(0, 32))).toBe(true);
    expect(isPlausibleConvexId("<script>")).toBe(false);
    expect(isPlausibleConvexId(null)).toBe(false);
  });
});

describe("mergeOpenConversation", () => {
  const list: { _id: string; lastMessageAt?: number }[] = [
    { _id: "a", lastMessageAt: 300 },
    { _id: "b", lastMessageAt: 200 },
    { _id: "c", lastMessageAt: 100 },
  ];
  it("sem conversa aberta devolve a lista", () => {
    expect(mergeOpenConversation(list, null)).toEqual(list);
  });
  it("não duplica quando o servidor ainda a devolve", () => {
    expect(mergeOpenConversation(list, { _id: "b", lastMessageAt: 200 }).map((c) => c._id)).toEqual(["a", "b", "c"]);
  });
  it("entra na posição da última mensagem", () => {
    expect(mergeOpenConversation(list, { _id: "x", lastMessageAt: 250 }).map((c) => c._id)).toEqual(["a", "x", "b", "c"]);
    expect(mergeOpenConversation(list, { _id: "x", lastMessageAt: 50 }).map((c) => c._id)).toEqual(["a", "b", "c", "x"]);
    expect(mergeOpenConversation(list, { _id: "x", lastMessageAt: 999 }).map((c) => c._id)).toEqual(["x", "a", "b", "c"]);
  });
  it("sem hora vai ao topo; lista vazia", () => {
    expect(mergeOpenConversation(list, { _id: "x" }).map((c) => c._id)[0]).toBe("x");
    expect(mergeOpenConversation([], { _id: "x", lastMessageAt: 1 }).map((c) => c._id)).toEqual(["x"]);
  });
});

describe("tipo de contato nos chips (PR2)", () => {
  const none = NO_CHIP_FILTERS;
  const base = { labels: [], showGroups: true, unreadCount: 0 };
  const labels = [{ _id: "l1", name: "VIP", color: "#10b981" }];

  it("Leads e Pessoais na fileira principal, antes de Grupos; ligam, desligam e Todas limpa", () => {
    const chips = inboxFilterChips(none, base);
    expect(chips.slice(0, 6).map((c) => c.label)).toEqual(["Todas", "Não lidas", "Minhas", "Leads", "Pessoais", "Grupos"]);
    const leads = applyInboxChip("leads", none);
    expect(leads.relation).toBe("leads");
    expect(inboxFilterChips(leads, base).find((c) => c.id === "leads")?.pressed).toBe(true);
    expect(inboxFilterChips(leads, base)[0].pressed).toBe(false);
    expect(applyInboxChip("personal", leads).relation).toBe("personal");
    expect(applyInboxChip("leads", leads).relation).toBeNull();
    expect(applyInboxChip("all", leads)).toEqual(none);
    expect(hasChipFilters({ ...none, relation: "none" })).toBe(true);
  });

  it("tipo de 'Mais filtros' vira chip marcado com ✕ (celular e desktop); tocar desliga", () => {
    const team = applyRelationFilter(none, "team");
    for (const layout of ["mobile", "desktop"] as const) {
      const chip = inboxFilterChips(team, { ...base, layout }).find((c) => c.id === "relation");
      expect(chip).toMatchObject({ label: "Equipe", pressed: true, removable: true });
    }
    expect(applyInboxChip("relation", team).relation).toBeNull();
    expect(applyRelationFilter(team, "team").relation).toBeNull();
    // Leads/Pessoais não duplicam como chip extra.
    expect(inboxFilterChips({ ...none, relation: "personal" }, base).some((c) => c.id === "relation")).toBe(false);
  });

  it("desktop: só a fileira principal (sem etiquetas, Etapa nem IA) quando nada está ativo", () => {
    const chips = inboxFilterChips(none, { ...base, labels, showAi: true, layout: "desktop" });
    expect(chips.map((c) => c.id)).toEqual(["all", "unread", "mine", "leads", "personal", "group"]);
  });

  it("desktop: etiqueta, etapa, IA, canal e Diretas ativos entram com ✕", () => {
    const state = { ...none, labelId: "l1", stageId: "s1", ai: "on" as const, channel: "instagram", kind: "direct" as const };
    const chips = inboxFilterChips(state, { ...base, labels, stageLabel: "Proposta", channelLabel: "Instagram", layout: "desktop" });
    const extra = chips.slice(6).map((c) => [c.id, c.label, c.removable]);
    expect(extra).toEqual([
      ["direct", "Diretas", true],
      ["channel", "Instagram", true],
      ["label:l1", "VIP", true],
      ["stage", "Proposta", true],
      ["ai", "IA atendendo", true],
    ]);
    expect(chips.every((c) => c.id === "all" || !c.removable || c.pressed)).toBe(true);
    // Tocar no chip com ✕ desliga.
    expect(applyInboxChip("stage", state).stageId).toBeNull();
    expect(applyInboxChip("label:l1", state).labelId).toBeNull();
  });

  it("'Mais filtros': tipos, etapa, IA/canal só quando fazem sentido, etiquetas e contagem de ativos", () => {
    const empty = inboxMoreFilters(none, { labels });
    expect(empty.types.map((t) => t.label)).toEqual(["Equipe", "Fornecedores", "Parceiros", "Robôs", "Sem tipo"]);
    expect(empty.types.every((t) => !t.selected)).toBe(true);
    expect(empty.stage).toEqual({ label: "Todas as etapas", active: false });
    expect(empty.ai).toBeNull();
    expect(empty.channel).toBeNull();
    expect(empty.labels).toEqual([{ id: "l1", name: "VIP", color: "#10b981", selected: false }]);
    expect(empty.archived).toBe(false);
    expect(empty.activeCount).toBe(0);

    const busy = inboxMoreFilters(
      { ...none, relation: "supplier", stageId: "s1", ai: "off", labelId: "l1", configId: "c1" },
      { labels, stageLabel: "Proposta", channelLabel: "WhatsApp ····1234", showArchived: true }
    );
    expect(busy.types.find((t) => t.id === "supplier")?.selected).toBe(true);
    expect(busy.stage).toEqual({ label: "Proposta", active: true });
    expect(busy.ai).toEqual({ label: "IA desligada", active: true });
    expect(busy.channel).toEqual({ label: "WhatsApp ····1234", active: true });
    expect(busy.archived).toBe(true);
    expect(busy.activeCount).toBe(5);

    // Leads/Pessoais moram na fileira: não contam no ▾.
    expect(inboxMoreFilters({ ...none, relation: "leads" }, { labels: [] }).activeCount).toBe(0);
    expect(inboxMoreFilters(none, { labels: [], showAi: true, showChannel: true }).ai).toEqual({ label: "Todas", active: false });
  });

  it("estado vazio por tipo, com a dica de como marcar", () => {
    const base2 = { kind: "all" as const, showArchived: false, queueFilterActive: false, labelId: null };
    expect(emptyListMessage({ ...base2, relation: "personal" })).toEqual({
      text: "Nenhum contato pessoal",
      chooseGroups: false,
      hint: "Use ⋮ › Não é cliente… numa conversa para marcar o contato.",
    });
    expect(emptyListMessage({ ...base2, relation: "leads" })).toEqual({ text: "Nenhuma conversa com lead", chooseGroups: false });
    expect(emptyListMessage({ ...base2, relation: "automated", showArchived: true }).text).toBe("Nenhum robô entre as arquivadas");
  });

  it("tipo e Grupos se excluem: ligar um desliga o outro", () => {
    const groups = applyInboxChip("group", none);
    expect(applyInboxChip("leads", groups)).toMatchObject({ relation: "leads", kind: "all" });
    expect(applyInboxChip("personal", groups)).toMatchObject({ relation: "personal", kind: "all" });
    expect(applyRelationFilter(groups, "none")).toMatchObject({ relation: "none", kind: "all" });
    const personal = applyInboxChip("personal", none);
    expect(applyInboxChip("group", personal)).toMatchObject({ kind: "group", relation: null });
    // Desligar Grupos não mexe no tipo; Diretas combina com tipo.
    expect(applyInboxChip("group", { ...none, kind: "group" })).toEqual(none);
    expect(applyRelationFilter({ ...none, kind: "direct" }, "leads")).toMatchObject({ kind: "direct", relation: "leads" });
    // Desligar o tipo não religa Grupos.
    expect(applyInboxChip("personal", personal)).toEqual(none);
  });

  it("chip Grupos continua na fileira com um tipo ligado (lista sem grupos)", () => {
    const rowsWithGroup = [{ kind: "direct" }, { kind: "group" }];
    const rowsFiltered = [{ kind: "direct" }];
    expect(showGroupsChip({ rows: rowsWithGroup, kind: "all", relation: null, knownHasGroups: false })).toBe(true);
    expect(showGroupsChip({ rows: rowsFiltered, kind: "all", relation: "personal", knownHasGroups: true })).toBe(true);
    expect(showGroupsChip({ rows: rowsFiltered, kind: "all", relation: "leads", knownHasGroups: false })).toBe(false);
    expect(showGroupsChip({ rows: rowsFiltered, kind: "all", relation: null, knownHasGroups: true })).toBe(false);
    expect(showGroupsChip({ rows: [], kind: "group", relation: null, knownHasGroups: false })).toBe(true);
    const chips = inboxFilterChips(applyInboxChip("leads", none), {
      ...base,
      showGroups: showGroupsChip({ rows: rowsFiltered, kind: "all", relation: "leads", knownHasGroups: true }),
    });
    expect(chips.find((c) => c.id === "group")).toMatchObject({ pressed: false });
    expect(chips.find((c) => c.id === "leads")).toMatchObject({ pressed: true });
  });
});
