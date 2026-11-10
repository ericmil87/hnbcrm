import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { BillingBanner } from "./BillingBanner";
import type { BillingBanner as Model } from "@/lib/billingBanner";

const banner = (o: Partial<Model> = {}): Model => ({
  kind: "warn80",
  tone: "warning",
  title: "Você usou 80% dos atendimentos IA do mês",
  body: "Acompanhe o uso.",
  cta: { label: "Ver uso", to: "/app/configuracoes?secao=billing" },
  dismissible: true,
  dismissKey: "warn80:2026-11",
  ...o,
});

const view = (b: Model, onDismiss?: () => void) =>
  render(
    <MemoryRouter>
      <BillingBanner banner={b} onDismiss={onDismiss} />
    </MemoryRouter>,
  );

describe("BillingBanner", () => {
  it("role status, título, texto e link", () => {
    view(banner());
    expect(screen.getByRole("status").textContent).toContain("80%");
    expect(screen.getByRole("link", { name: "Ver uso" }).getAttribute("href")).toBe("/app/configuracoes?secao=billing");
  });

  it("dispensar chama o callback", () => {
    const onDismiss = vi.fn();
    view(banner(), onDismiss);
    fireEvent.click(screen.getByRole("button", { name: "Dispensar aviso" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("não dispensável: sem botão; sem CTA: sem link", () => {
    view(banner({ dismissible: false, dismissKey: null, cta: null, kind: "read_only", tone: "error" }), () => {});
    expect(screen.queryByRole("button", { name: "Dispensar aviso" })).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
