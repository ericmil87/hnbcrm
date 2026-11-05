import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LeadCardView } from "./LeadCard";
import type { Lead } from "./types";

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

describe("LeadCardView", () => {
  it("mostra título, contato, valor, prioridade e temperatura", () => {
    render(<LeadCardView lead={lead} />);
    expect(screen.getByText("Contrato Acme")).toBeInTheDocument();
    expect(screen.getByText(/Ana Souza/)).toBeInTheDocument();
    expect(screen.getByText(/12\.500/)).toBeInTheDocument();
    expect(screen.getByText("Urgente")).toBeInTheDocument();
    expect(screen.getByText("Quente")).toBeInTheDocument();
    expect(screen.getByText("vip")).toBeInTheDocument();
  });

  it("sem lastMessage não renderiza a prévia", () => {
    render(<LeadCardView lead={lead} />);
    expect(screen.queryByTestId("lead-last-message")).not.toBeInTheDocument();
  });

  it("com lastMessage do contato mostra texto e tempo, sem prefixo", () => {
    render(<LeadCardView lead={lead} lastMessage={{ text: "Pode me enviar a proposta?", at: Date.now() - 3 * 3600_000, fromContact: true }} />);
    const el = screen.getByTestId("lead-last-message");
    expect(el).toHaveTextContent("Pode me enviar a proposta?");
    expect(el).toHaveTextContent("há 3h");
    expect(el).not.toHaveTextContent("Você:");
  });

  it("mensagem enviada pela equipe leva o prefixo Você:", () => {
    render(<LeadCardView lead={lead} lastMessage={{ text: "Enviei agora", at: Date.now(), fromContact: false }} />);
    expect(screen.getByTestId("lead-last-message")).toHaveTextContent("Você: Enviei agora");
  });

  it("lead sem contato mostra o aviso", () => {
    render(<LeadCardView lead={{ ...lead, contact: null }} />);
    expect(screen.getByText("Sem contato")).toBeInTheDocument();
  });
});
