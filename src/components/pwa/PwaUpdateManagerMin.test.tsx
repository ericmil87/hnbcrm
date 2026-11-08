import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({ useQuery: () => "9.0.0" }));
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }));
vi.mock("@/lib/pwa/appBuild", () => ({ APP_BUILD: "0.1.0", PWA_KILL_SWITCH: false }));
const { checkForUpdate } = vi.hoisted(() => ({ checkForUpdate: vi.fn<() => Promise<boolean>>() }));
vi.mock("@/lib/pwa/register", () => ({ registerAppServiceWorker: vi.fn(), checkForUpdate }));

import { toast } from "sonner";
import { PwaUpdateManager } from "./PwaUpdateManager";
import { MIN_RELOAD_KEY } from "@/lib/pwa/minReload";
import { setUpdateWaiting } from "@/lib/pwa/updateStore";

beforeEach(() => {
  vi.mocked(toast).mockClear();
  sessionStorage.clear();
  setUpdateWaiting(false, null);
  checkForUpdate.mockReset();
});

function mount() {
  return render(
    <MemoryRouter initialEntries={["/app/painel"]}>
      <PwaUpdateManager />
    </MemoryRouter>,
  );
}

describe("PwaUpdateManager below the minimum build", () => {
  it("shows the top bar and no 'Nova versão disponível' toast", () => {
    checkForUpdate.mockResolvedValue(false);
    mount();
    act(() => setUpdateWaiting(true, vi.fn()));
    expect(screen.getByText("Atualize para continuar")).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
  });

  it("waits for the update check before spending the one plain reload", async () => {
    const apply = vi.fn();
    checkForUpdate.mockImplementation(async () => {
      setUpdateWaiting(true, apply);
      return true;
    });
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Atualizar/ }));
    });
    expect(apply).toHaveBeenCalled();
    expect(sessionStorage.getItem(MIN_RELOAD_KEY)).toBeNull();
  });
});
