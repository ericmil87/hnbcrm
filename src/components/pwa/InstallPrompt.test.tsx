import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallPrompt } from "./InstallPrompt";
import { ChatModeProvider } from "@/components/layout/chatMode";
import { renderWithRouter } from "@/test/render";
import { __resetInstallStoreForTests, startInstallCapture } from "@/lib/pwa/installStore";
import { INVITE_VISIBLE_MS, readDismissedAt } from "@/lib/pwa/installInvite";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1";

type InstallEvent = Event & { prompt: ReturnType<typeof vi.fn>; userChoice: Promise<unknown> };

function installEvent(outcome: "accepted" | "dismissed" = "accepted"): InstallEvent {
  const ev = new Event("beforeinstallprompt") as InstallEvent;
  ev.prompt = vi.fn().mockResolvedValue(undefined);
  ev.userChoice = Promise.resolve({ outcome, platform: "web" });
  return ev;
}

function fire(ev: Event) {
  act(() => {
    window.dispatchEvent(ev);
  });
}

function mockMedia(match: (q: string) => boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (q: string) =>
      ({ matches: match(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as MediaQueryList,
  );
}

const TITLE = "Instale o HNBCRM";

describe("InstallPrompt", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetInstallStoreForTests();
    startInstallCapture();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("não aparece antes do 3º acesso", () => {
    localStorage.setItem("hnbcrm:pwa:visits", "1");
    renderWithRouter(<InstallPrompt />);
    fire(installEvent());
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("aparece no 3º acesso e chama o prompt nativo", async () => {
    localStorage.setItem("hnbcrm:pwa:visits", "2"); // este render registra o 3º acesso
    renderWithRouter(<InstallPrompt />);
    const ev = installEvent();
    fire(ev);
    await userEvent.click(await screen.findByRole("button", { name: "Instalar app" }));
    expect(ev.prompt).toHaveBeenCalled();
  });

  it("funciona quando o beforeinstallprompt dispara ANTES do render", async () => {
    localStorage.setItem("hnbcrm:pwa:visits", "5");
    const ev = installEvent();
    fire(ev);
    renderWithRouter(<InstallPrompt />);
    await userEvent.click(await screen.findByRole("button", { name: "Instalar app" }));
    expect(ev.prompt).toHaveBeenCalled();
  });

  it("dispensar esconde e grava a data", async () => {
    localStorage.setItem("hnbcrm:pwa:visits", "5");
    renderWithRouter(<InstallPrompt />);
    fire(installEvent());
    await userEvent.click(await screen.findByRole("button", { name: "Dispensar convite" }));
    expect(screen.queryByText(TITLE)).toBeNull();
    expect(readDismissedAt()).not.toBeNull();
  });

  it("recusar o diálogo nativo (outcome dismissed) grava a dispensa", async () => {
    localStorage.setItem("hnbcrm:pwa:visits", "5");
    renderWithRouter(<InstallPrompt />);
    fire(installEvent("dismissed"));
    await userEvent.click(await screen.findByRole("button", { name: "Instalar app" }));
    await vi.waitFor(() => expect(readDismissedAt()).not.toBeNull());
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("appinstalled esconde o convite", async () => {
    localStorage.setItem("hnbcrm:pwa:visits", "5");
    renderWithRouter(<InstallPrompt />);
    fire(installEvent());
    await screen.findByText(TITLE);
    fire(new Event("appinstalled"));
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("não aparece em modo standalone", () => {
    localStorage.setItem("hnbcrm:pwa:visits", "9");
    mockMedia((q) => q.includes("standalone"));
    __resetInstallStoreForTests();
    startInstallCapture();
    renderWithRouter(<InstallPrompt />);
    fire(installEvent());
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("modo conversa no celular esconde o banner", () => {
    localStorage.setItem("hnbcrm:pwa:visits", "9");
    mockMedia((q) => q.includes("max-width: 767px"));
    renderWithRouter(
      <ChatModeProvider value={{ active: true, setActive: () => {} }}>
        <InstallPrompt />
      </ChatModeProvider>,
    );
    fire(installEvent());
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("some ao trocar de rota e não volta na mesma sessão", async () => {
    localStorage.setItem("hnbcrm:pwa:visits", "9");
    const { router, unmount } = renderWithRouter(<InstallPrompt />);
    fire(installEvent());
    await screen.findByText(TITLE);
    await act(async () => {
      await router.navigate("/outra");
    });
    expect(screen.queryByText(TITLE)).toBeNull();
    unmount();
    renderWithRouter(<InstallPrompt />);
    fire(installEvent());
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("some sozinho depois de ~20 s", async () => {
    vi.useFakeTimers();
    localStorage.setItem("hnbcrm:pwa:visits", "9");
    renderWithRouter(<InstallPrompt />);
    fire(installEvent());
    expect(screen.getByText(TITLE)).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(INVITE_VISIBLE_MS + 1);
    });
    expect(screen.queryByText(TITLE)).toBeNull();
  });

  it("iPhone: Instalar app abre a folha e Entendi dispensa por 30 dias", async () => {
    localStorage.setItem("hnbcrm:pwa:visits", "9");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE);
    renderWithRouter(<InstallPrompt />);
    await userEvent.click(await screen.findByRole("button", { name: "Instalar app" }));
    expect(screen.getByText(/Toque em Compartilhar/)).toBeInTheDocument();
    expect(screen.getByText(/pode estar no menu/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Entendi" }));
    expect(readDismissedAt()).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText(TITLE)).toBeNull();
  });
});
