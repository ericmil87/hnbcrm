import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PushActivationCardView } from "./PushActivationCard";
import { MyDevicesListView, type DeviceRow } from "./MyDevicesList";

const props = { platform: "android" as const, onEnable: vi.fn(), onDisable: vi.fn(), onShowInstall: vi.fn() };

describe("PushActivationCardView", () => {
  it("default: 'Ativar avisos' só dispara no toque", () => {
    const onEnable = vi.fn();
    render(<PushActivationCardView {...props} status="default" onEnable={onEnable} />);
    expect(onEnable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Ativar avisos/ }));
    expect(onEnable).toHaveBeenCalledTimes(1);
  });

  it("ativo: mostra 'Avisos ligados neste aparelho' e 'Desligar'", () => {
    const onDisable = vi.fn();
    render(<PushActivationCardView {...props} status="subscribed" onDisable={onDisable} />);
    expect(screen.getByText("Avisos ligados neste aparelho")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Desligar" }));
    expect(onDisable).toHaveBeenCalled();
  });

  it.each([
    ["android", /cadeado.*Permissões/],
    ["ios", /Ajustes › Notificações › HNBCRM/],
    ["desktop", /barra|ícone/],
  ] as const)("bloqueado em %s explica como reabrir", (platform, re) => {
    render(<PushActivationCardView {...props} platform={platform} status="denied" />);
    expect(screen.getByText("Os avisos estão bloqueados neste aparelho")).toBeTruthy();
    expect(screen.getByText(re)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ativar/ })).toBeNull();
  });

  it("iPhone fora da Tela de Início: 'Instale o app para receber avisos' abre o tutorial", () => {
    const onShowInstall = vi.fn();
    render(<PushActivationCardView {...props} platform="ios" status="needs-install" onShowInstall={onShowInstall} />);
    fireEvent.click(screen.getByRole("button", { name: "Instale o app para receber avisos" }));
    expect(onShowInstall).toHaveBeenCalled();
  });

  it("não suportado: texto honesto, sem botão", () => {
    render(<PushActivationCardView {...props} status="unsupported" />);
    expect(screen.getByText(/não recebe avisos com o app fechado/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("erro: mostra a mensagem e 'Tentar de novo'", () => {
    render(<PushActivationCardView {...props} status="error" error="Este navegador usa um serviço de avisos que não é suportado" />);
    expect(screen.getByRole("alert").textContent).toContain("não é suportado");
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
  });

  it("carregando: não renderiza nada", () => {
    const { container } = render(<PushActivationCardView {...props} status="loading" />);
    expect(container.firstChild).toBeNull();
  });
});

const dev = (over: Partial<DeviceRow>): DeviceRow => ({
  subscriptionId: "s1",
  platform: "android",
  userAgentLabel: "Chrome no Android",
  createdAt: 1_000,
  lastSeenAt: 1_000,
  linkedHere: true,
  isCurrent: false,
  ...over,
});

describe("MyDevicesListView", () => {
  it("lista nome, 'Este aparelho' e visto relativo", () => {
    render(
      <MyDevicesListView
        now={1_000 + 3 * 3600_000}
        onRemove={vi.fn()}
        devices={[dev({ isCurrent: true }), dev({ subscriptionId: "s2", userAgentLabel: null, platform: "desktop", lastSeenAt: null })]}
      />,
    );
    expect(screen.getByText("Chrome no Android")).toBeTruthy();
    expect(screen.getByText("Este aparelho")).toBeTruthy();
    expect(screen.getByText("Computador")).toBeTruthy();
    expect(screen.getAllByText(/Visto há 3h/).length).toBe(2);
  });

  it("'Remover' pede confirmação e só então remove", () => {
    const onRemove = vi.fn();
    render(<MyDevicesListView now={2_000} onRemove={onRemove} devices={[dev({})]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remover Chrome no Android" }));
    expect(onRemove).not.toHaveBeenCalled();
    expect(screen.getByText("Remover este aparelho?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remover" }));
    expect(onRemove).toHaveBeenCalledWith("s1");
  });

  it("cancelar não remove", () => {
    const onRemove = vi.fn();
    render(<MyDevicesListView now={2_000} onRemove={onRemove} devices={[dev({})]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remover Chrome no Android" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onRemove).not.toHaveBeenCalled();
  });
});
