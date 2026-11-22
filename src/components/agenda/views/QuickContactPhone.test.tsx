import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

let phone: string | null | undefined;
vi.mock("convex/react", () => ({ useQuery: () => phone }));
vi.mock("../../../../convex/_generated/api", () => ({ api: { scheduling: { getAppointmentContactPhone: "getAppointmentContactPhone" } } }));

import { QuickContactPhone } from "./QuickContactPhone";

describe("QuickContactPhone", () => {
  it("mostra o telefone e 'Abrir conversa' quando o agendamento tem conversa", () => {
    phone = "+55 (85) 98888-7777";
    const open = vi.fn();
    const done = vi.fn();
    render(<QuickContactPhone appointmentId="a1" conversationId="c1" canOpenInbox onOpenConversation={open} onDone={done} />);
    expect(screen.getByText("+55 (85) 98888-7777")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir conversa" }));
    expect(open).toHaveBeenCalledWith("c1");
    expect(done).toHaveBeenCalled();
  });
  it("sem a permissão da Caixa de entrada o telefone aparece, mas 'Abrir conversa' não", () => {
    phone = "+55 (85) 98888-7777";
    const open = vi.fn();
    render(<QuickContactPhone appointmentId="a1" conversationId="c1" canOpenInbox={false} onOpenConversation={open} onDone={vi.fn()} />);
    expect(screen.getByText("+55 (85) 98888-7777")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abrir conversa" })).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });
  it("sem conversa não há ação; sem telefone (ou ainda carregando) não mostra nada", () => {
    phone = "+55 (85) 98888-7777";
    const { unmount } = render(<QuickContactPhone appointmentId="a1" canOpenInbox onOpenConversation={vi.fn()} onDone={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    unmount();
    for (const v of [null, undefined]) {
      phone = v;
      const r = render(<QuickContactPhone appointmentId="a1" conversationId="c1" canOpenInbox onOpenConversation={vi.fn()} onDone={vi.fn()} />);
      expect(r.container).toBeEmptyDOMElement();
      r.unmount();
    }
  });
});
