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

  it("com lastMessage mostra a prévia", () => {
    render(<LeadCardView lead={lead} lastMessage="Pode me enviar a proposta?" />);
    expect(screen.getByTestId("lead-last-message")).toHaveTextContent("Pode me enviar a proposta?");
  });

  it("lead sem contato mostra o aviso", () => {
    render(<LeadCardView lead={{ ...lead, contact: null }} />);
    expect(screen.getByText("Sem contato")).toBeInTheDocument();
  });
});
