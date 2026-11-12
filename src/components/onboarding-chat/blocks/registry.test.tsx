import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BLOCK_REGISTRY, OnboardingBlockView, knownBlock } from "./registry";
import type { BlockContext } from "./types";
import { MessageItem } from "../MessageItem";

function ctx(overrides: Partial<BlockContext> = {}): BlockContext {
  return { organizationId: "o", sessionId: "s", sendText: vi.fn(), busy: false, isLatest: true, ...overrides };
}

const UNKNOWN_TEXT = /não pode ser exibido nesta versão/;

describe("registro de blocos", () => {
  it("tem um componente para cada kind do contrato", () => {
    expect(Object.keys(BLOCK_REGISTRY).sort()).toEqual(
      [
        "chips",
        "cartaoConta",
        "cartaoAceite",
        "resumoNegocio",
        "funilPreview",
        "personaCard",
        "conhecimentoLista",
        "respostasRapidas",
        "uploadProgresso",
        "aplicarOperacao",
        "simulador",
        "conectarCanal",
        "proximosPassos",
        "traducaoCartao",
        "avisoMateriais",
      ].sort()
    );
  });

  it("tipo desconhecido, sem kind, array, null e chave herdada viram UnknownBlock (sem payload cru)", () => {
    for (const raw of [{ kind: "html", html: "<b>x</b>" }, { foo: 1 }, [1], null, "texto", { kind: "toString" }]) {
      const { unmount, container } = render(<OnboardingBlockView block={raw} ctx={ctx()} />);
      expect(screen.getByText(UNKNOWN_TEXT)).toBeInTheDocument();
      expect(container.textContent).not.toMatch(/<b>|html/);
      unmount();
    }
    expect(knownBlock({ kind: "funilPreview" })).not.toBeNull();
    expect(knownBlock({ kind: "__proto__" })).toBeNull();
  });

  it("payload quebrado de um tipo conhecido não derruba a conversa", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(<OnboardingBlockView block={{ kind: "funilPreview", funnelName: "F", stages: [null], customFields: [], blockedCount: 0 }} ctx={ctx()} />);
      expect(screen.getByText(UNKNOWN_TEXT)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("resumoNegocio e funilPreview mostram texto puro: sem HTML, imagem ou link", () => {
    const { container } = render(
      <>
        <OnboardingBlockView
          block={{
            kind: "resumoNegocio",
            name: "Loja <img src=x onerror=alert(1)>Boa",
            segment: "ecommerce",
            segmentLabel: "E-commerce",
            description: "Veja [aqui](https://mal.example) e https://mal.example",
            suspicious: true,
            note: "<script>alert(1)</script>Nota",
          }}
          ctx={ctx()}
        />
        <OnboardingBlockView
          block={{
            kind: "funilPreview",
            funnelName: "Vendas",
            stages: [
              { name: "Novo <a href='https://x'>lead</a>", outcome: "open" },
              { name: "Ganho", outcome: "won" },
            ],
            customFields: [{ name: "Orçamento", type: "currency" }],
            blockedCount: 1,
          }}
          ctx={ctx()}
        />
      </>
    );
    expect(container.querySelector("img, a, script")).toBeNull();
    expect(screen.getByText("Loja Boa")).toBeInTheDocument();
    expect(screen.getByText("Veja aqui e [link removido]")).toBeInTheDocument();
    expect(screen.getByText("Nota")).toBeInTheDocument();
    expect(screen.getByText(/marcado para revisão/)).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Etapas do funil" }).textContent).toContain("Novo lead");
    expect(screen.getByText(/Campos: Orçamento/)).toBeInTheDocument();
  });

  it("chips: tocar envia o texto; desligados fora da última resposta ou durante um turno", async () => {
    const user = userEvent.setup();
    const sendText = vi.fn();
    const { rerender } = render(<OnboardingBlockView block={{ kind: "chips", options: ["Sim", "Não"] }} ctx={ctx({ sendText })} />);
    await user.click(screen.getByRole("button", { name: "Sim" }));
    expect(sendText).toHaveBeenCalledWith("Sim");
    rerender(<OnboardingBlockView block={{ kind: "chips", options: ["Sim"] }} ctx={ctx({ sendText, isLatest: false })} />);
    expect(screen.getByRole("button", { name: "Sim" })).toBeDisabled();
  });

  it("cartão de tradução estático mostra o estado e só oferece Ajustar (sem gravar nada ao montar)", () => {
    render(<OnboardingBlockView block={{ kind: "traducaoCartao", enabled: true, note: "Pronto" }} ctx={ctx()} />);
    expect(screen.getByRole("region", { name: "Tradução automática" })).toBeInTheDocument();
    expect(screen.getByText("Pronto")).toBeInTheDocument();
    expect(screen.getByText("Ligada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ajustar" })).toBeInTheDocument();
  });
});

describe("MessageItem", () => {
  it("resposta do Copiloto é texto puro com quebras; áudio que falha some e fica o texto", () => {
    const { container } = render(
      <MessageItem
        item={{
          key: "m1",
          role: "assistant",
          text: "Linha 1\n<b>Linha 2</b> ![img](https://x/i.png)",
          blocks: [{ kind: "desconhecido" }],
          chips: [],
          audio: { url: "https://x/a.wav", durationSec: 2, mimeType: "audio/wav" },
        }}
        blockCtx={{ organizationId: "o", sessionId: "s", sendText: vi.fn(), busy: false }}
        isLatest
      />
    );
    expect(container.querySelector("b, img, a")).toBeNull();
    expect(screen.getByText(/Linha 1\s+Linha 2 img/)).toBeInTheDocument();
    const audio = container.querySelector("audio");
    expect(audio).not.toBeNull();
    fireEvent.error(audio!);
    expect(container.querySelector("audio")).toBeNull();
    expect(screen.getByText(/Linha 1/)).toBeInTheDocument();
    // Bloco de tipo desconhecido na mesma mensagem: seguro.
    expect(screen.getByText(UNKNOWN_TEXT)).toBeInTheDocument();
  });
});
