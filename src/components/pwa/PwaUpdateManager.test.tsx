import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({ useQuery: () => null }));
vi.mock("sonner", () => {
  const toast = Object.assign(vi.fn(), { dismiss: vi.fn() });
  return { toast };
});
vi.mock("@/lib/pwa/register", () => ({
  registerAppServiceWorker: vi.fn(),
  checkForUpdate: vi.fn(async () => false),
}));

import { toast } from "sonner";
import { PwaUpdateManager } from "./PwaUpdateManager";
import { resetTypedSignal, setComposerDirty } from "@/lib/pwa/composerDirty";
import { setUpdateWaiting } from "@/lib/pwa/updateStore";

function Nav() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => navigate("/app/tarefas")}>ir tarefas</button>
      <button onClick={() => navigate("/app/contatos")}>ir contatos</button>
      <textarea aria-label="campo" />
    </>
  );
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
}

function mount() {
  return render(
    <MemoryRouter initialEntries={["/app/painel"]}>
      <PwaUpdateManager />
      <Nav />
    </MemoryRouter>,
  );
}

let apply: ReturnType<typeof vi.fn<() => void>>;
const arrive = () => act(() => setUpdateWaiting(true, apply));

beforeEach(() => {
  apply = vi.fn<() => void>();
  resetTypedSignal();
  setUpdateWaiting(false, null);
  vi.mocked(toast).mockClear();
  setHidden(false);
});
afterEach(() => {
  setHidden(false);
  setComposerDirty("x", false);
});

describe("PwaUpdateManager", () => {
  it("a navigation made BEFORE the update arrives does not trigger it; the next one does", () => {
    mount();
    fireEvent.click(screen.getByText("ir tarefas"));
    arrive();
    expect(apply).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith("Nova versão disponível", expect.objectContaining({ position: "top-center" }));
    fireEvent.click(screen.getByText("ir contatos"));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("applies when the page is hidden and nothing was typed", () => {
    mount();
    arrive();
    expect(apply).not.toHaveBeenCalled();
    act(() => setHidden(true));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("typing anywhere blocks hidden and (until the route changes) keeps the toast", () => {
    mount();
    fireEvent.input(screen.getByLabelText("campo"), { target: { value: "oi" } });
    arrive();
    act(() => setHidden(true));
    expect(apply).not.toHaveBeenCalled();
    act(() => setHidden(false));
    // Leaving the screen drops the mark: the navigation is a safe moment.
    fireEvent.click(screen.getByText("ir tarefas"));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("typing after the last navigation blocks the route-change reload only through a registered draft", () => {
    mount();
    arrive();
    setComposerDirty("x", true);
    fireEvent.click(screen.getByText("ir tarefas"));
    act(() => setHidden(true));
    expect(apply).not.toHaveBeenCalled();
    setComposerDirty("x", false);
    act(() => setHidden(true));
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
