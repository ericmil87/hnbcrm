import { describe, expect, it, vi } from "vitest";
import { openConversationAction } from "./agendaInbox";

describe("openConversationAction", () => {
  it("com permissão da Caixa de entrada, conversa e destino: devolve a ação que abre a conversa", () => {
    const open = vi.fn();
    const action = openConversationAction("c1", true, open);
    expect(action).toBeTypeOf("function");
    action!();
    expect(open).toHaveBeenCalledWith("c1");
  });
  it("sem permissão `inbox`, sem conversa ou sem destino: sem ação", () => {
    const open = vi.fn();
    expect(openConversationAction("c1", false, open)).toBeUndefined();
    expect(openConversationAction(undefined, true, open)).toBeUndefined();
    expect(openConversationAction("c1", true, undefined)).toBeUndefined();
    expect(open).not.toHaveBeenCalled();
  });
});
