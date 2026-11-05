import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Id } from "../../../../convex/_generated/dataModel";
import { ChannelConnectCardView, type ChannelConnectCardViewProps } from "./ChannelConnectCard";

const ORG = "org1" as Id<"organizations">;
const CONFIG = "cfg1" as Id<"channelConfigs">;

function setup(overrides: Partial<ChannelConnectCardViewProps> = {}) {
  const actions = {
    createChannelConfig: vi.fn(),
    updateChannelConfig: vi.fn(),
    createManagedChannel: vi.fn().mockResolvedValue(CONFIG),
    startPairing: vi.fn().mockResolvedValue({ state: "qr", qrCode: "data:image/png;base64,AAAA" }),
    pollPairing: vi.fn().mockResolvedValue({ state: "qr" }),
    markConnected: vi.fn(),
  };
  const onConnected = vi.fn();
  render(
    <ChannelConnectCardView
      organizationId={ORG}
      narrow={false}
      defaults={{ managedAvailable: true }}
      defaultCountryCode="55"
      actions={actions}
      onConnected={onConnected}
      {...overrides}
    />
  );
  return { actions, onConnected };
}

describe("ChannelConnectCardView", () => {
  it("oferece WhatsApp oficial (Meta) e WhatsApp por QR code", () => {
    setup();
    expect(screen.getByRole("button", { name: /WhatsApp oficial \(Meta\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /WhatsApp por QR code/ })).toBeInTheDocument();
  });

  it("QR code mostra o aviso de risco e exige o aceite antes de Conectar número", async () => {
    const user = userEvent.setup();
    const { actions } = setup();
    await user.click(screen.getByRole("button", { name: /WhatsApp por QR code/ }));

    expect(screen.getByText(/Risco de banimento/)).toBeInTheDocument();
    const connect = screen.getByRole("button", { name: "Conectar número" });
    expect(connect).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /assumo o risco de banimento/ }));
    expect(connect).toBeEnabled();

    await user.click(connect);
    await waitFor(() => expect(actions.createManagedChannel).toHaveBeenCalledTimes(1));
    // O cliente nunca monta o endereço de retorno do servidor.
    expect(actions.createManagedChannel.mock.calls[0][0]).not.toHaveProperty("webhookUrl");
    expect(actions.createManagedChannel.mock.calls[0][0]).toMatchObject({ useManagedGateway: true });
  });

  it("campos manuais só aparecem no bloco de configuração manual", async () => {
    const user = userEvent.setup();
    setup({ defaults: { managedAvailable: true } });
    await user.click(screen.getByRole("button", { name: /WhatsApp por QR code/ }));
    expect(screen.getByText("Configuração manual (avançado)")).toBeInTheDocument();
    expect(screen.queryByLabelText("Token da conexão")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("URL do servidor de conexão")).not.toBeInTheDocument();
  });

  it("Conectar com código é o padrão em tela estreita", () => {
    const { actions } = setup({ configId: CONFIG, narrow: true });
    expect(screen.getByRole("radio", { name: "Conectar com código" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Número do WhatsApp")).toBeInTheDocument();
    expect(actions.startPairing).not.toHaveBeenCalled();
  });

  it("usa o QR code por padrão no computador e pede o QR ao abrir", async () => {
    const { actions } = setup({ configId: CONFIG, narrow: false });
    expect(screen.getByRole("radio", { name: "Usar QR code" })).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(actions.startPairing).toHaveBeenCalledWith({ configId: CONFIG, mode: "qr" }));
    expect(await screen.findByAltText("QR code para conectar o WhatsApp")).toBeInTheDocument();
  });

  it("gera o código de conexão e o mostra como XXXX-XXXX", async () => {
    const user = userEvent.setup();
    const { actions } = setup({ configId: CONFIG, narrow: true });
    actions.startPairing.mockResolvedValueOnce({ state: "code", linkingCode: "abcd1234", attemptsLeft: 2 });
    await user.type(screen.getByLabelText("Número do WhatsApp"), "11987654321");
    await user.click(screen.getByRole("button", { name: "Gerar código" }));
    expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
    expect(actions.startPairing).toHaveBeenCalledWith({ configId: CONFIG, mode: "code", phone: "11987654321" });
    expect(screen.getByRole("button", { name: "Gerar outro código" })).toBeDisabled();
    expect(screen.getByText(/Restam 2 códigos/)).toBeInTheDocument();
  });
});

describe("ChannelConnectCardView: configuração manual", () => {
  it("campos manuais aparecem só no bloco avançado, conforme a origem", async () => {
    const user = userEvent.setup();
    setup({ defaults: { managedAvailable: true } });
    await user.click(screen.getByRole("button", { name: /WhatsApp por QR code/ }));
    await user.click(screen.getByRole("radio", { name: "Criar no meu servidor" }));
    expect(screen.getByLabelText("Token de administrador do servidor")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("URL do servidor de conexão")).toBeInTheDocument();
    expect(screen.queryByLabelText("ID da conexão")).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Conexão existente" }));
    expect(screen.getByLabelText("ID da conexão")).toBeInTheDocument();
    expect(screen.getByLabelText("Token da conexão")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.queryByLabelText("Token de administrador do servidor")).not.toBeInTheDocument();
  });
});
