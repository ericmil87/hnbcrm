import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstallPrompt } from "./InstallPrompt";
import { __resetInstallStoreForTests, startInstallCapture } from "@/lib/pwa/installStore";
import { readDismissedAt } from "@/lib/pwa/installInvite";

function fireInstallEvent() {
  const ev = new Event("beforeinstallprompt") as Event & { prompt: () => Promise<void>; userChoice: Promise<unknown> };
  ev.prompt = vi.fn().mockResolvedValue(undefined);
  ev.userChoice = Promise.resolve({ outcome: "accepted", platform: "web" });
  act(() => {
    window.dispatchEvent(ev);
  });
  return ev;
}

describe("InstallPrompt", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    __resetInstallStoreForTests();
    startInstallCapture();
  });
  afterEach(() => vi.restoreAllMocks());

  it("não aparece antes do 3º acesso", () => {
    localStorage.setItem("hnbcrm:pwa:visits", "1");
    render(<InstallPrompt />);
    fireInstallEvent();
    expect(screen.queryByText("Instale o HNBCRM")).toBeNull();
  });

  it("aparece no 3º acesso quando o navegador oferece instalar e chama o prompt", async () => {
    localStorage.setItem("hnbcrm:pwa:visits", "2"); // this render registers the 3rd visit
    render(<InstallPrompt />);
    const ev = fireInstallEvent();
    await userEvent.click(await screen.findByRole("button", { name: "Instalar app" }));
    expect(ev.prompt).toHaveBeenCalled();
  });

  it("dispensar esconde e grava a data", async () => {
    localStorage.setItem("hnbcrm:pwa:visits", "5");
    render(<InstallPrompt />);
    fireInstallEvent();
    await userEvent.click(await screen.findByRole("button", { name: "Dispensar convite" }));
    expect(screen.queryByText("Instale o HNBCRM")).toBeNull();
    expect(readDismissedAt()).not.toBeNull();
  });

  it("não aparece em modo standalone", () => {
    localStorage.setItem("hnbcrm:pwa:visits", "9");
    vi.spyOn(window, "matchMedia").mockImplementation(
      (q: string) => ({ matches: q.includes("standalone"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }) as MediaQueryList,
    );
    __resetInstallStoreForTests();
    startInstallCapture();
    render(<InstallPrompt />);
    fireInstallEvent();
    expect(screen.queryByText("Instale o HNBCRM")).toBeNull();
  });
});
