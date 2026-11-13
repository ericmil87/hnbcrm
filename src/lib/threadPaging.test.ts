import { describe, expect, it } from "vitest";
import { MESSAGES_MAX_LIMIT } from "./inboxPaging";
import {
  decideJump,
  decideThreadScroll,
  isContactTyping,
  isNearBottom,
  isStandbyActive,
  leftOpenAnchor,
  makePrependAnchor,
  newestInbound,
  readSignature,
  resizeScrollAction,
  shouldPinAfterResize,
} from "./threadPaging";

const base = {
  conversationId: "c1",
  limit: 100,
  hasCurrentBatch: true,
  scrolledConversationId: "c1",
  nearBottom: false,
  scrollHeight: 5000,
};

describe("decideThreadScroll", () => {
  it("compensa a rolagem pela altura inserida acima quando o lote anterior chega", () => {
    const anchor = makePrependAnchor("c1", 100, { scrollTop: 20, scrollHeight: 3000 });
    const out = decideThreadScroll({ ...base, anchor });
    expect(out.scrollTop).toBe(20 + (5000 - 3000));
    expect(out.anchor).toBeNull();
  });

  it("não consome a âncora enquanto o lote do limite novo não chegou", () => {
    const anchor = makePrependAnchor("c1", 100, { scrollTop: 20, scrollHeight: 3000 });
    const out = decideThreadScroll({ ...base, anchor, hasCurrentBatch: false });
    expect(out.anchor).toEqual(anchor);
    expect(out.scrollTop).toBeNull();
  });

  it("ignora a âncora de outro limite", () => {
    const anchor = makePrependAnchor("c1", 150, { scrollTop: 20, scrollHeight: 3000 });
    const out = decideThreadScroll({ ...base, anchor });
    expect(out.anchor).toEqual(anchor);
    expect(out.scrollTop).toBeNull();
  });

  it("descarta a âncora de outra conversa e rola para o fim", () => {
    const anchor = makePrependAnchor("c0", 100, { scrollTop: 20, scrollHeight: 3000 });
    const out = decideThreadScroll({ ...base, anchor, scrolledConversationId: "c0" });
    expect(out.anchor).toBeNull();
    expect(out.scrollTop).toBe("bottom");
    expect(out.scrolledConversationId).toBe("c1");
    expect(out.nearBottom).toBe(true);
  });

  it("ao trocar de conversa vai para a mensagem mais nova", () => {
    const out = decideThreadScroll({ ...base, anchor: null, scrolledConversationId: null });
    expect(out.scrollTop).toBe("bottom");
  });

  it("mensagem nova só gruda no fim quem estava perto dele", () => {
    expect(decideThreadScroll({ ...base, anchor: null, nearBottom: true }).scrollTop).toBe("bottom");
    expect(decideThreadScroll({ ...base, anchor: null, nearBottom: false }).scrollTop).toBeNull();
  });
});

describe("isNearBottom", () => {
  it("usa 120 px de folga", () => {
    expect(isNearBottom({ scrollTop: 880, scrollHeight: 1500, clientHeight: 600 })).toBe(true);
    expect(isNearBottom({ scrollTop: 700, scrollHeight: 1500, clientHeight: 600 })).toBe(false);
  });
});

describe("decideJump", () => {
  it("rola quando a mensagem está na tela", () => {
    expect(decideJump({ found: true, loaded: 50, limit: 50 })).toEqual({ kind: "scroll" });
  });
  it("sobe o limite de 100 em 100 quando o lote veio cheio", () => {
    expect(decideJump({ found: false, loaded: 50, limit: 50 })).toEqual({ kind: "grow", limit: 150 });
  });
  it("desiste com lote incompleto", () => {
    const out = decideJump({ found: false, loaded: 30, limit: 50 });
    expect(out).toEqual({ kind: "give-up", message: "A mensagem original não está carregada" });
  });
  it("desiste no teto com o aviso de mensagem antiga", () => {
    const out = decideJump({ found: false, loaded: MESSAGES_MAX_LIMIT, limit: MESSAGES_MAX_LIMIT });
    expect(out).toEqual({ kind: "give-up", message: "Mensagem antiga demais para exibir aqui" });
  });
});

describe("mensagens recebidas", () => {
  const msgs = [
    { _id: "a", direction: "inbound", createdAt: 1 },
    { _id: "b", direction: "outbound", createdAt: 2 },
    { _id: "c", direction: "inbound", createdAt: 3, metadata: { standby: true } },
    { _id: "d", direction: "outbound", createdAt: 4 },
  ];
  it("acha a mais nova recebida e monta a assinatura", () => {
    expect(newestInbound(msgs)?._id).toBe("c");
    expect(readSignature("c1", msgs)).toBe("c1:c");
    expect(readSignature("c1", [msgs[1]])).toBeNull();
  });
  it("standby vale para a última recebida que não é nota interna", () => {
    expect(isStandbyActive(msgs)).toBe(true);
    expect(isStandbyActive([...msgs, { _id: "e", direction: "inbound", createdAt: 5 }])).toBe(false);
    expect(
      isStandbyActive([...msgs, { _id: "n", direction: "inbound", isInternal: true, createdAt: 9 }])
    ).toBe(true);
  });
});

describe("isContactTyping", () => {
  it("vale por 12 s depois do composing", () => {
    expect(isContactTyping({ state: "composing", at: 1000 }, 12_999)).toBe(true);
    expect(isContactTyping({ state: "composing", at: 1000 }, 13_000)).toBe(false);
    expect(isContactTyping({ state: "paused", at: 1000 }, 1001)).toBe(false);
    expect(isContactTyping(null, 1)).toBe(false);
  });
});

describe("shouldPinAfterResize", () => {
  it("teclado abriu com o leitor no fim: gruda no fim", () => {
    expect(shouldPinAfterResize({ prevClientHeight: 700, clientHeight: 340, nearBottom: true })).toBe(true);
  });
  it("leitor no meio do histórico: não mexe", () => {
    expect(shouldPinAfterResize({ prevClientHeight: 700, clientHeight: 340, nearBottom: false })).toBe(false);
  });
  it("sem medida anterior ou mesma altura: não mexe", () => {
    expect(shouldPinAfterResize({ prevClientHeight: null, clientHeight: 340, nearBottom: true })).toBe(false);
    expect(shouldPinAfterResize({ prevClientHeight: 340.2, clientHeight: 340, nearBottom: true })).toBe(false);
  });
});

describe("resizeScrollAction (mídia carregando depois da rolagem inicial, teclado)", () => {
  const box = { clientHeight: 676, scrollHeight: 3794 };
  // Medido no navegador sem âncora de rolagem (como o Safari do iPhone): a imagem carrega, +240 px.
  const grown = { clientHeight: 676, scrollHeight: 4034 };

  it("conteúdo cresceu com o leitor no fim: continua no fim", () => {
    expect(resizeScrollAction({ prev: box, next: grown, holdingDivider: false, nearBottom: true })).toBe("bottom");
  });
  it("conteúdo cresceu com o leitor rolado para cima: não mexe", () => {
    expect(resizeScrollAction({ prev: box, next: grown, holdingDivider: false, nearBottom: false })).toBeNull();
  });
  it("abertura no divisor ainda valendo: refaz a rolagem até o divisor (conteúdo ou caixa)", () => {
    expect(resizeScrollAction({ prev: box, next: grown, holdingDivider: true, nearBottom: false })).toBe("divider");
    expect(resizeScrollAction({ prev: box, next: grown, holdingDivider: true, nearBottom: true })).toBe("divider");
    const keyboard = { clientHeight: 340, scrollHeight: 3794 };
    expect(resizeScrollAction({ prev: box, next: keyboard, holdingDivider: true, nearBottom: false })).toBe("divider");
  });
  it("caixa encolheu (teclado) com o leitor no fim: continua no fim; no meio: não mexe", () => {
    const keyboard = { clientHeight: 340, scrollHeight: 3794 };
    expect(resizeScrollAction({ prev: box, next: keyboard, holdingDivider: false, nearBottom: true })).toBe("bottom");
    expect(resizeScrollAction({ prev: box, next: keyboard, holdingDivider: false, nearBottom: false })).toBeNull();
  });
  it("nada mudou (subpixel) ou sem medida anterior: não mexe, nem com o divisor valendo", () => {
    const same = { clientHeight: 676.2, scrollHeight: 3794.4 };
    expect(resizeScrollAction({ prev: box, next: same, holdingDivider: true, nearBottom: true })).toBeNull();
    expect(resizeScrollAction({ prev: null, next: grown, holdingDivider: true, nearBottom: true })).toBeNull();
  });
});

describe("leftOpenAnchor", () => {
  it("rolagem igual à aplicada (com folga de subpixel): a abertura continua valendo", () => {
    expect(leftOpenAnchor({ applied: 4420, scrollTop: 4420 })).toBe(false);
    expect(leftOpenAnchor({ applied: 4420, scrollTop: 4420.67 })).toBe(false);
    expect(leftOpenAnchor({ applied: 4420, scrollTop: 4418 })).toBe(false);
  });
  it("a pessoa rolou (para cima ou para baixo): a abertura acabou", () => {
    expect(leftOpenAnchor({ applied: 4420, scrollTop: 4380 })).toBe(true);
    expect(leftOpenAnchor({ applied: 4420, scrollTop: 4423 })).toBe(true);
  });
});

describe("rolagem inicial e botão ir para o fim", () => {
  it("marca a rolagem inicial da conversa", () => {
    expect(decideThreadScroll({ ...base, anchor: null, scrolledConversationId: null }).initial).toBe(true);
    expect(decideThreadScroll({ ...base, anchor: null, nearBottom: true }).initial).toBe(false);
  });
  it("dividerScrollTop deixa o divisor perto do topo", async () => {
    const { dividerScrollTop } = await import("./threadPaging");
    expect(dividerScrollTop({ dividerTop: 500, containerTop: 100, scrollTop: 0 })).toBe(392);
    expect(dividerScrollTop({ dividerTop: 100, containerTop: 100, scrollTop: 0 })).toBe(0);
  });
  it("countInboundAfter conta só recebidas depois da referência", async () => {
    const { countInboundAfter } = await import("./threadPaging");
    const msgs = [
      { _id: "a", direction: "inbound", createdAt: 1 },
      { _id: "b", direction: "outbound", createdAt: 2 },
      { _id: "c", direction: "inbound", createdAt: 3 },
      { _id: "d", direction: "inbound", isInternal: true, createdAt: 4 },
      { _id: "e", direction: "inbound", createdAt: 5 },
    ];
    expect(countInboundAfter(msgs, "a")).toBe(2);
    expect(countInboundAfter(msgs, "e")).toBe(0);
    expect(countInboundAfter(msgs, "zzz")).toBe(0);
    expect(countInboundAfter(msgs, null)).toBe(0);
  });
  it("rótulo e badge", async () => {
    const { jumpToLatestLabel, jumpBadgeText } = await import("./threadPaging");
    expect(jumpToLatestLabel(0)).toBe("Ir para as mensagens mais recentes");
    expect(jumpToLatestLabel(1)).toBe("Ir para as mensagens mais recentes, 1 nova");
    expect(jumpToLatestLabel(3)).toBe("Ir para as mensagens mais recentes, 3 novas");
    expect(jumpBadgeText(120)).toBe("99+");
    expect(jumpBadgeText(7)).toBe("7");
  });
});
