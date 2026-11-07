import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { LeadCardView, LeadMoveControls } from "./LeadCard";
import { defaultFunnelCardPrefs, type FunnelCardPrefs } from "@/lib/funnelCardPrefs";
import type { Lead, Stage } from "./types";

const lead = {
  _id: "l1",
  title: "Contrato Acme",
  value: 12500,
  priority: "urgent",
  temperature: "hot",
  stageId: "s1",
  lastActivityAt: Date.now(),
  contact: { _id: "c1", firstName: "Ana", lastName: "Souza", company: "Acme" },
  assignee: null,
  tags: ["vip"],
} as unknown as Lead;

const ALL: FunnelCardPrefs["fields"] = ["contact", "value", "priority", "temperature", "tags", "assignee", "age", "lastMessage"];
const comfortable: FunnelCardPrefs = { density: "comfortable", fields: ALL };
const msg = { text: "Pode me enviar a proposta?", at: Date.now() - 3 * 3600_000, fromContact: true };

describe("LeadCardView", () => {
  it("mostra título, contato, valor, prioridade e temperatura", () => {
    render(<LeadCardView lead={lead} prefs={comfortable} />);
    expect(screen.getByText("Contrato Acme")).toBeInTheDocument();
    expect(screen.getByText(/Ana Souza/)).toBeInTheDocument();
    expect(screen.getByText(/12\.500/)).toBeInTheDocument();
    expect(screen.getByText("Urgente")).toBeInTheDocument();
    expect(screen.getByText("Quente")).toBeInTheDocument();
    expect(screen.getByText("vip")).toBeInTheDocument();
  });

  it("sem lastMessage não renderiza a prévia", () => {
    render(<LeadCardView lead={lead} prefs={comfortable} />);
    expect(screen.queryByTestId("lead-last-message")).not.toBeInTheDocument();
  });

  it("com lastMessage do contato mostra texto e tempo, sem prefixo", () => {
    render(<LeadCardView lead={lead} prefs={comfortable} lastMessage={{ text: "Pode me enviar a proposta?", at: Date.now() - 3 * 3600_000, fromContact: true }} />);
    const el = screen.getByTestId("lead-last-message");
    expect(el).toHaveTextContent("Pode me enviar a proposta?");
    expect(el).toHaveTextContent("há 3h");
    expect(el).not.toHaveTextContent("Você:");
  });

  it("mensagem enviada pela equipe leva o prefixo Você:", () => {
    render(<LeadCardView lead={lead} prefs={comfortable} lastMessage={{ text: "Enviei agora", at: Date.now(), fromContact: false }} />);
    expect(screen.getByTestId("lead-last-message")).toHaveTextContent("Você: Enviei agora");
  });

  it("lead sem contato mostra o aviso", () => {
    render(<LeadCardView lead={{ ...lead, contact: null }} prefs={comfortable} />);
    expect(screen.getByText("Sem contato")).toBeInTheDocument();
  });

  describe("compacto (padrão)", () => {
    it("título em uma linha truncada, contato e valor pequeno", () => {
      render(<LeadCardView lead={lead} />);
      const h = screen.getByText("Contrato Acme");
      expect(h).toHaveClass("truncate");
      expect(screen.getByText(/Ana Souza/)).toBeInTheDocument();
      expect(screen.getByText(/12\.500/)).not.toHaveClass("text-lg");
    });

    it("prioridade e temperatura viram bolinhas com texto para leitor de tela", () => {
      render(<LeadCardView lead={lead} />);
      expect(screen.getByText("Prioridade: Urgente")).toHaveClass("sr-only");
      expect(screen.getByText("Temperatura: Quente")).toHaveClass("sr-only");
    });

    it("etiquetas ficam ocultas no padrão", () => {
      render(<LeadCardView lead={lead} />);
      expect(screen.queryByText("vip")).not.toBeInTheDocument();
    });

    it("valor zero não aparece", () => {
      render(<LeadCardView lead={{ ...lead, value: 0 }} />);
      expect(screen.queryByText(/R\$/)).not.toBeInTheDocument();
    });

    it("campos desmarcados somem", () => {
      render(<LeadCardView lead={lead} prefs={{ density: "compact", fields: ["priority"] }} />);
      expect(screen.queryByText(/Ana Souza/)).not.toBeInTheDocument();
      expect(screen.queryByText(/12\.500/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Temperatura/)).not.toBeInTheDocument();
      expect(screen.getByText("Prioridade: Urgente")).toBeInTheDocument();
      expect(screen.getByText("Contrato Acme")).toBeInTheDocument();
    });

    it("etiquetas ligadas mostram a primeira com contagem do resto", () => {
      render(<LeadCardView lead={{ ...lead, tags: ["vip", "b2b"] } as Lead} prefs={{ density: "compact", fields: ["tags"] }} />);
      expect(screen.getByText("vip")).toHaveClass("truncate");
      expect(screen.getByText(/\+1/)).toBeInTheDocument();
    });

    it("última mensagem: só com o campo ligado e o dado presente, em uma linha", () => {
      const { rerender } = render(<LeadCardView lead={lead} lastMessage={msg} />);
      expect(screen.queryByTestId("lead-last-message")).not.toBeInTheDocument();
      rerender(<LeadCardView lead={lead} lastMessage={msg} prefs={{ density: "compact", fields: ["lastMessage"] }} />);
      expect(screen.getByTestId("lead-last-message")).toHaveClass("truncate");
    });

    it("tempo na etapa vem do campo age", () => {
      const { rerender } = render(<LeadCardView lead={lead} prefs={{ density: "compact", fields: ["age"] }} />);
      expect(screen.getByText("0d")).toBeInTheDocument();
      rerender(<LeadCardView lead={lead} prefs={{ density: "compact", fields: [] }} />);
      expect(screen.queryByText("0d")).not.toBeInTheDocument();
    });

    it("padrão equivale a defaultFunnelCardPrefs", () => {
      const { container } = render(<LeadCardView lead={lead} prefs={defaultFunnelCardPrefs()} />);
      expect(container.firstElementChild).toHaveAttribute("data-density", "compact");
    });
  });

  describe("confortável", () => {
    it("mostra os badges de texto e o valor grande", () => {
      const { container } = render(<LeadCardView lead={lead} prefs={comfortable} />);
      expect(container.firstElementChild).toHaveAttribute("data-density", "comfortable");
      expect(screen.getByText(/12\.500/)).toHaveClass("text-lg");
    });

    it("respeita a seleção de campos", () => {
      render(<LeadCardView lead={lead} prefs={{ density: "comfortable", fields: ["value"] }} />);
      expect(screen.getByText(/12\.500/)).toBeInTheDocument();
      expect(screen.queryByText("Urgente")).not.toBeInTheDocument();
      expect(screen.queryByText(/Ana Souza/)).not.toBeInTheDocument();
      expect(screen.queryByText("vip")).not.toBeInTheDocument();
    });
  });
});

describe("LeadMoveControls", () => {
  const st = (id: string, name: string) => ({ _id: id, name, color: "#000" }) as unknown as Stage;
  const [a, b, c] = [st("a", "Novo"), st("b", "Proposta"), st("c", "Ganho")];

  it("mostra setas com a etapa de destino e chama onMove sem propagar o clique", async () => {
    const onMove = vi.fn();
    const onParent = vi.fn();
    render(
      <div onClick={onParent}>
        <LeadMoveControls stages={[a, b, c]} currentStageId="b" prevStage={a} nextStage={c} onMove={onMove} />
      </div>
    );
    await userEvent.click(screen.getByRole("button", { name: "Mover para Ganho" }));
    expect(onMove).toHaveBeenCalledWith("c");
    expect(onParent).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Mover para Novo" })).toBeInTheDocument();
  });

  it("some a seta na primeira e na última etapa", () => {
    const { rerender } = render(
      <LeadMoveControls stages={[a, b]} currentStageId="a" prevStage={null} nextStage={b} onMove={vi.fn()} />
    );
    expect(screen.queryByRole("button", { name: "Mover para Novo" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mover para Proposta" })).toBeInTheDocument();
    rerender(<LeadMoveControls stages={[a, b]} currentStageId="b" prevStage={a} nextStage={null} onMove={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Mover para Proposta" })).not.toBeInTheDocument();
  });
});

describe("LeadCardView compacto: linha de apoio", () => {
  it("sem dados nos campos ligados não renderiza linha vazia", () => {
    const { container } = render(
      <LeadCardView lead={{ ...lead, value: 0, assignee: null }} prefs={{ density: "compact", fields: ["value", "assignee"] }} />
    );
    expect(container.querySelector(".min-h-6")).toBeNull();
  });

  it("temperatura usa chama e prioridade usa bolinha", () => {
    const { container } = render(<LeadCardView lead={lead} />);
    expect(container.querySelectorAll("svg.lucide-flame")).toHaveLength(1);
  });
});
