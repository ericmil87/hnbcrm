import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { automationFromSettings, type AutomationForm } from "@/lib/agendaAutomation";
import type { SettingsView } from "../../../../convex/lib/schedViews";
import { AiPolicyForm } from "./AiPolicyForm";

const base = (ack = false): AutomationForm =>
  automationFromSettings({
    gridMinutes: 30, minNoticeMin: 120, maxAdvanceDays: 60,
    smart: { mode: "rank", weights: { adjacency: 40, deadGap: 50, openNewResource: 20, earlyFirst: 10, balance: 0, preference: 30 }, minOffer: 3 },
    ai: { consult: true, book: "propose", reschedule: "propose", cancel: "handoff", firstVisitNeedsApproval: true, maxAiBookingsPerContactPerDay: 2, ...(ack ? { autoAck: { by: "m", at: 1 } } : {}) },
    humanConfirm: { mode: "auto" },
  } as unknown as SettingsView)!;

describe("AiPolicyForm: aceite do 'marca sozinha'", () => {
  it("mostra o aviso e só muda depois do aceite", () => {
    const onChange = vi.fn();
    render(<AiPolicyForm value={base()} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("radio", { name: /Marca sozinha/ })[0]);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/A IA vai marcar horários sozinha, sem passar por você/)).toBeInTheDocument();
    expect(screen.getByText(/primeira visita de cada cliente continua pedindo a sua aprovação/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Entendi, ligar" }));
    expect(onChange).toHaveBeenCalledWith({ ...base(), book: "auto", ackAcceptedNow: true });
  });
  it("voltar não muda nada", () => {
    const onChange = vi.fn();
    render(<AiPolicyForm value={base()} onChange={onChange} />);
    fireEvent.click(screen.getAllByRole("radio", { name: /Marca sozinha/ })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(onChange).not.toHaveBeenCalled();
  });
  it("com aceite já gravado não pergunta de novo", () => {
    const onChange = vi.fn();
    render(<AiPolicyForm value={base(true)} onChange={onChange} />);
    fireEvent.click(screen.getByRole("radio", { name: /Cancela sozinha/ }));
    expect(onChange).toHaveBeenCalledWith({ ...base(true), cancel: "auto" });
  });
  it("explica as confirmações pelo WhatsApp e o 'na dúvida só sugere'", () => {
    render(<AiPolicyForm value={base()} onChange={() => {}} />);
    expect(screen.getByText(/Na dúvida, ele só sugere/)).toBeInTheDocument();
  });
  it("assistente: três opções e o interruptor das confirmações; sozinha pede o mesmo aceite", () => {
    const onChange = vi.fn();
    render(<AiPolicyForm variant="wizard" value={base()} onChange={onChange} />);
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByRole("radio", { name: /Consulta e reserva para você aprovar/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: /Não mexe na agenda/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...base(), consult: false, book: "off", reschedule: "off" });
    fireEvent.click(screen.getByRole("radio", { name: /Marca sozinha/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Entendi, ligar" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...base(), book: "auto", ackAcceptedNow: true });
    fireEvent.click(screen.getByRole("switch", { name: "Interpretar minhas confirmações pelo WhatsApp" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...base(), humanConfirmMode: "off" });
  });
  it("assistente sem IA ativa: só o interruptor, a explicação e o atalho", () => {
    const onChange = vi.fn();
    const onOpenAiSettings = vi.fn();
    render(<AiPolicyForm variant="wizard" aiActive={false} value={base()} onChange={onChange} onOpenAiSettings={onOpenAiSettings} />);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.getByText(/Sem a IA ativa ele só sugere/)).toBeInTheDocument();
    expect(screen.getByText("As opções de como a IA participa da agenda aparecem quando a IA da organização estiver ativa.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Interpretar minhas confirmações pelo WhatsApp" }));
    expect(onChange).toHaveBeenLastCalledWith({ ...base(), humanConfirmMode: "off" });
    fireEvent.click(screen.getByRole("button", { name: "Configurar a IA" }));
    expect(onOpenAiSettings).toHaveBeenCalled();
  });
  it("o painel de Configurações não muda com aiActive", () => {
    render(<AiPolicyForm aiActive={false} value={base()} onChange={() => {}} />);
    expect(screen.getAllByRole("radio").length).toBeGreaterThan(3);
  });
  it("chaves de Sugestões e IA: tocar no texto também liga e desliga (área de toque maior que a chave de 44 x 24)", () => {
    const onChange = vi.fn();
    render(<AiPolicyForm value={base()} onChange={onChange} />);
    fireEvent.click(screen.getByText("Consultar horários livres"));
    expect(onChange).toHaveBeenLastCalledWith({ ...base(), consult: !base().consult });
    fireEvent.click(screen.getByText(/quem nunca veio antes passa pela sua aprovação/));
    expect(onChange).toHaveBeenLastCalledWith({ ...base(), firstVisitNeedsApproval: !base().firstVisitNeedsApproval });
    // A própria chave amplia o toque para 44 px por um pseudo-elemento (o desenho continua 44 x 24).
    for (const name of ["Consultar horários livres", "Primeira visita sempre com aprovação"]) {
      expect(screen.getByRole("switch", { name }).className).toContain("before:-inset-y-2.5");
    }
  });
  it("mostra quem aceitou", () => {
    render(<AiPolicyForm value={base(true)} onChange={() => {}} ackNote='Ana aceitou o aviso do "marca sozinha" em 01/01/2026.' />);
    expect(screen.getByText(/Ana aceitou/)).toBeInTheDocument();
  });
});
