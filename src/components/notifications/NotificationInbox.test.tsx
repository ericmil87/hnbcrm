import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  NotificationGroupChips,
  NotificationInboxList,
  NotificationPanelShell,
  NotificationTabs,
  OrgNewsLines,
} from "./NotificationPanel";
import type { InboxNotification } from "@/lib/notificationInbox";
import type { NotificationGroup } from "../../../convex/lib/notificationGroups";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

const item = (over: Record<string, unknown>) =>
  ({
    _id: "n1",
    type: "new_message",
    title: "Maria escreveu",
    body: "Oi, tudo bem?",
    createdAt: NOW - 5 * 60_000,
    ...over,
  }) as unknown as InboxNotification;

function List(props: Partial<React.ComponentProps<typeof NotificationInboxList>> & { items: InboxNotification[] }) {
  return (
    <NotificationInboxList
      now={NOW}
      tab="unread"
      status="Exhausted"
      busyId={null}
      canAssume
      onOpen={vi.fn()}
      onToggleRead={vi.fn()}
      onAction={vi.fn()}
      onLoadMore={vi.fn()}
      onCreateLead={vi.fn()}
      {...props}
    />
  );
}

describe("NotificationTabs", () => {
  it("troca entre Não lidas e Todas e mostra a contagem", async () => {
    const onTab = vi.fn();
    render(<NotificationTabs tab="unread" onTab={onTab} unreadCount={4} />);
    expect(screen.getByRole("tab", { name: "Não lidas 4" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "Todas" }));
    expect(onTab).toHaveBeenCalledWith("all");
  });
});

describe("NotificationGroupChips", () => {
  it("um chip por grupo; clicar de novo limpa", async () => {
    function Harness() {
      const [group, setGroup] = useState<NotificationGroup | null>(null);
      return <NotificationGroupChips group={group} onGroup={setGroup} />;
    }
    render(<Harness />);
    const chip = screen.getByRole("button", { name: "Tarefas" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("button")).toHaveLength(5);
  });
});

describe("NotificationInboxList", () => {
  it("mostra título em bdi, corpo com dir=auto e tempo em <time>", () => {
    render(<List items={[item({})]} />);
    const title = screen.getByText("Maria escreveu");
    expect(title.tagName).toBe("BDI");
    expect(screen.getByText("Oi, tudo bem?")).toHaveAttribute("dir", "auto");
    expect(screen.getByText("Oi, tudo bem?").className).toContain("line-clamp-2");
    const time = screen.getByText("há 5 min");
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", new Date(NOW - 5 * 60_000).toISOString());
  });

  it("estado vazio por aba", () => {
    const { rerender } = render(<List items={[]} />);
    expect(screen.getByText("Tudo em dia")).toBeInTheDocument();
    rerender(<List items={[]} tab="all" />);
    expect(screen.getByText("Nenhuma notificação por aqui")).toBeInTheDocument();
  });

  it("pedido de ajuda: Assumir dispara a ação; sem permissão o botão some", async () => {
    const onAction = vi.fn();
    const n = item({ type: "handoff_requested", handoffId: "h1" });
    const { rerender } = render(<List items={[n]} onAction={onAction} />);
    await userEvent.click(screen.getByRole("button", { name: "Assumir" }));
    expect(onAction).toHaveBeenCalledWith(n, "assume");
    rerender(<List items={[n]} canAssume={false} />);
    expect(screen.queryByRole("button", { name: "Assumir" })).toBeNull();
  });

  it("rascunho tem Revisar e tarefa tem Adiar 1 h", async () => {
    const onAction = vi.fn();
    const draft = item({ _id: "d", type: "ai_draft_pending", conversationId: "c1" });
    const task = item({ _id: "t", type: "task_due_soon", taskId: "t1" });
    render(<List items={[draft, task]} onAction={onAction} />);
    await userEvent.click(screen.getByRole("button", { name: "Revisar rascunho" }));
    await userEvent.click(screen.getByRole("button", { name: "Adiar 1 h" }));
    expect(onAction).toHaveBeenNthCalledWith(1, draft, "review");
    expect(onAction).toHaveBeenNthCalledWith(2, task, "snooze");
  });

  it("resolvido aparece em cinza com Assumido por {nome}, sem ações", () => {
    const n = item({
      type: "handoff_requested",
      handoffId: "h1",
      readAt: 10,
      data: { resolvedBy: "m1", resolvedReason: "accepted" },
      resolvedByName: "Ana",
    });
    render(<List items={[n]} />);
    expect(screen.getByText("Assumido por Ana")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Assumir" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Marcar como/ })).toBeNull();
    expect(screen.getByRole("listitem")).toHaveClass("opacity-70");
  });

  it("Marcar como lida / não lida conforme o estado", async () => {
    const onToggleRead = vi.fn();
    const unread = item({ _id: "u" });
    const read = item({ _id: "r", readAt: 3 });
    render(<List items={[unread, read]} onToggleRead={onToggleRead} />);
    const [first, second] = screen.getAllByRole("listitem");
    await userEvent.click(within(first).getByRole("button", { name: "Marcar como lida" }));
    await userEvent.click(within(second).getByRole("button", { name: "Marcar como não lida" }));
    expect(onToggleRead).toHaveBeenNthCalledWith(1, unread);
    expect(onToggleRead).toHaveBeenNthCalledWith(2, read);
  });

  it("sem IntersectionObserver oferece Carregar mais", async () => {
    const onLoadMore = vi.fn();
    render(<List items={[item({})]} status="CanLoadMore" onLoadMore={onLoadMore} />);
    await userEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it("clicar no corpo abre o item", async () => {
    const onOpen = vi.fn();
    const n = item({});
    render(<List items={[n]} onOpen={onOpen} />);
    await userEvent.click(screen.getByText("Maria escreveu"));
    expect(onOpen).toHaveBeenCalledWith(n);
  });
});

describe("OrgNewsLines", () => {
  it("mostra a frase e abre a org", async () => {
    const onOpen = vi.fn();
    const entry = { organizationId: "o2", organizationName: "Beta", unread: 3, unseen: 3 };
    render(<OrgNewsLines entries={[entry]} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole("button", { name: "Você tem 3 novidades em Beta" }));
    expect(onOpen).toHaveBeenCalledWith(entry);
  });
});

describe("NotificationPanelShell (D1)", () => {
  function Harness({ onClose = vi.fn() }) {
    const ref = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={ref} type="button">
          sino
        </button>
        <NotificationPanelShell
          open
          onClose={onClose}
          anchor={ref}
          hasUnread
          onMarkAllRead={vi.fn()}
          liveMessage="Marcada como lida"
        >
          <button type="button">item</button>
        </NotificationPanelShell>
      </>
    );
  }

  it("é diálogo modal com região aria-live e botão Fechar", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const dialog = screen.getByRole("dialog", { name: "Notificações" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Marcada como lida");
    await userEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("prende o foco: Tab no último volta ao primeiro", async () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");
    const last = buttons[buttons.length - 1];
    last.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(buttons[0]);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });
});

describe("rolagem infinita e teto (autoLoad)", () => {
  type IOCallback = (entries: { isIntersecting: boolean }[]) => void;

  function installObserver() {
    const instances: { cb: IOCallback; observed: Element[] }[] = [];
    class FakeIO {
      cb: IOCallback;
      observed: Element[] = [];
      constructor(cb: IOCallback) {
        this.cb = cb;
        instances.push(this);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      disconnect() {}
      unobserve() {}
    }
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
    return instances;
  }

  it("com autoLoad o sentinela dispara loadMore ao ficar visível", () => {
    const instances = installObserver();
    const onLoadMore = vi.fn();
    render(<List items={[item({})]} status="CanLoadMore" onLoadMore={onLoadMore} />);
    expect(instances.length).toBeGreaterThan(0);
    instances[instances.length - 1].cb([{ isIntersecting: true }]);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Carregar mais" })).toBeNull();
    delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
  });

  it("sem autoLoad não monta o observador e mostra o botão", async () => {
    const instances = installObserver();
    const onLoadMore = vi.fn();
    render(<List items={[item({})]} status="CanLoadMore" autoLoad={false} onLoadMore={onLoadMore} />);
    expect(instances).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    delete (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
  });

  it("lista vazia sem autoLoad explica e oferece o botão", async () => {
    const onLoadMore = vi.fn();
    render(<List items={[]} status="CanLoadMore" autoLoad={false} onLoadMore={onLoadMore} />);
    expect(screen.getByText("Nada deste grupo nos avisos mais recentes")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(onLoadMore).toHaveBeenCalled();
  });
});

describe("casca: foco, rótulo e anúncios", () => {
  it("devolve o foco ao sino ao fechar por qualquer caminho", async () => {
    function Harness() {
      const ref = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button ref={ref} type="button" onClick={() => setOpen(true)}>
            sino
          </button>
          <NotificationPanelShell open={open} onClose={() => setOpen(false)} anchor={ref} hasUnread onMarkAllRead={vi.fn()}>
            <p>conteúdo</p>
          </NotificationPanelShell>
        </>
      );
    }
    render(<Harness />);
    const bell = screen.getByRole("button", { name: "sino" });
    await userEvent.click(bell);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(bell).not.toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bell).toHaveFocus();
  });

  it("rótulo do botão em massa muda com chip de grupo", () => {
    function Harness({ label }: { label?: string }) {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={ref} type="button">
            sino
          </button>
          <NotificationPanelShell open onClose={vi.fn()} anchor={ref} hasUnread onMarkAllRead={vi.fn()} markAllLabel={label}>
            <p>x</p>
          </NotificationPanelShell>
        </>
      );
    }
    const { rerender } = render(<Harness />);
    expect(screen.getByRole("button", { name: "Marcar todas como lidas" })).toBeInTheDocument();
    rerender(<Harness label="Marcar estas como lidas" />);
    expect(screen.getByRole("button", { name: "Marcar estas como lidas" })).toBeInTheDocument();
  });

  it("<bdi> só no nome da organização", () => {
    const entry = { organizationId: "o2", organizationName: "Beta", unread: 3, unseen: 3 };
    render(<OrgNewsLines entries={[entry]} onOpen={vi.fn()} />);
    const bdis = document.querySelectorAll("bdi");
    expect(bdis).toHaveLength(1);
    expect(bdis[0].textContent).toBe("Beta");
  });
});
