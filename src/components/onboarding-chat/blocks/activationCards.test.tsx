import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApplyResult } from "../../../../convex/lib/onboardingApply";
import { RECOMMENDED_ATTENDANT_MODE } from "../../../../convex/lib/onboardingBlocks";
import { AI_LGPD_ACK_LABEL } from "@/lib/aiLgpdText";
import type { ActivationDeps } from "@/lib/onboardingActivate";
import { MemoryRouter } from "react-router";
import { renderWithRouter } from "@/test/render";
import { AtivarIaView, type AtivarIaViewProps } from "./AtivarIaBlock";
import { OperacaoProntaView } from "./OperacaoProntaBlock";

const summary = { businessName: "Bugre Tur", funnelName: "Passeios", stageCount: 5, attendantName: "Bia", knowledgeCount: 4, quickReplyCount: 2, hoursLabel: "Atende 24h, todos os dias" };

function result(over: Partial<ApplyResult> = {}): ApplyResult {
  return { alreadyApplied: false, attendant: "created", attendantId: "att1", funnelMode: "created", fieldsCreated: 0, fieldsUpdated: 0, quickRepliesCreated: 2, skippedSuspicious: { knowledge: 0, quickReplies: 0, handoffRules: 0, greeting: false, business: false }, features: {}, pendingConsent: [], ...over } as unknown as ApplyResult;
}

function deps(over: Partial<ActivationDeps> = {}) {
  return {
    enableAi: vi.fn(async () => {}),
    apply: vi.fn(async () => ({ ok: true as const, result: result() })),
    enableAutopilot: vi.fn(async () => {}),
    errorMessage: (e: unknown, f: string) => (e instanceof Error ? e.message : f),
    ...over,
  } satisfies ActivationDeps;
}

function view(over: Partial<AtivarIaViewProps> = {}, d: ActivationDeps = deps()) {
  const props: AtivarIaViewProps = {
    summary,
    aiActive: false,
    alreadyApplied: false,
    canApply: true,
    blockedCount: 0,
    recommendedMode: RECOMMENDED_ATTENDANT_MODE,
    deps: d,
    ...over,
  };
  return { ...render(<AtivarIaView {...props} />), props };
}

const AUTO_LABEL = "Ativar e deixar a IA responder sozinha";
const SUGGEST_LABEL = "Ativar com respostas para eu aprovar";

describe("AtivarIaView: conteúdo", () => {
  it("resumo do que será montado, texto humano sobre os dados e o jurídico completo só em 'Ver detalhes'", () => {
    view();
    expect(screen.getByRole("region", { name: "Ativar a sua IA" })).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "O que será montado" });
    expect(list).toHaveTextContent("Funil Passeios com 5 etapas");
    expect(list).toHaveTextContent("chamada Bia");
    expect(list).toHaveTextContent("4 informações");
    expect(list).toHaveTextContent("Atende 24h, todos os dias");
    expect(screen.getByText(/provedores de IA parceiros, inclusive fora do Brasil/)).toBeInTheDocument();
    expect(screen.getByText(/A sua empresa é a responsável pelos dados dos seus clientes/)).toBeInTheDocument();
    const details = screen.getByText("Ver detalhes").closest("details")!;
    expect(details).not.toHaveAttribute("open");
    expect(within(details).getByText(/zero-retention/)).toBeInTheDocument();
    expect(within(details).getByText(/LGPD, art\. 33/)).toBeInTheDocument();
  });

  it("caixa DESMARCADA com o rótulo jurídico; botão desabilitado com a dica do porquê", () => {
    view();
    const box = screen.getByRole("checkbox", { name: AI_LGPD_ACK_LABEL }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    const button = screen.getByRole("button", { name: AUTO_LABEL });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/Marque a caixa de confirmação/);
  });

  it("modo: dois cartões-rádio; Responder sozinha (24h) recomendado e pré-selecionado, com o aviso honesto", () => {
    view();
    const group = screen.getByRole("radiogroup", { name: "Como a IA vai responder" });
    const auto = within(group).getByRole("radio", { name: /Responder sozinha \(24h\)/ });
    const suggest = within(group).getByRole("radio", { name: /Sugerir respostas \(você aprova cada uma\)/ });
    expect(auto).toBeChecked();
    expect(suggest).not.toBeChecked();
    expect(within(group).getByText("Recomendado")).toBeInTheDocument();
    expect(screen.getByText(/A IA responde aos seus clientes sem você revisar antes\. Ela chama você quando não souber/)).toBeInTheDocument();
    expect(screen.getByText(/Dá para mudar a qualquer momento em Configurações/)).toBeInTheDocument();
  });

  it("o modo pré-selecionado segue block.recommendedMode", () => {
    view({ recommendedMode: "suggest" });
    expect(screen.getByRole("radio", { name: /Sugerir respostas/ })).toBeChecked();
  });

  it("IA já ativa: sem caixa nem aceite; só modo e montar", () => {
    view({ aiActive: true });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText("Ver detalhes")).toBeNull();
    expect(screen.getByRole("button", { name: "Montar e deixar a IA responder sozinha" })).toBeEnabled();
  });

  it("nome bloqueado desabilita com o motivo", async () => {
    view({ aiActive: true, canApply: false, blockedCount: 2 });
    expect(screen.getByRole("button", { name: AUTO_LABEL.replace("Ativar", "Montar") })).toBeDisabled();
    expect(screen.getByText(/2 nomes do rascunho precisam ser editados/)).toBeInTheDocument();
  });
});

describe("AtivarIaView: o clique", () => {
  it("nada roda ao montar nem sem o clique; o rótulo muda com o modo", async () => {
    const user = userEvent.setup();
    const d = deps();
    view({}, d);
    expect(d.enableAi).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
    await user.click(screen.getByRole("radio", { name: /Sugerir respostas/ }));
    expect(screen.getByRole("button", { name: SUGGEST_LABEL })).toBeInTheDocument();
  });

  it("automático: aceite → montar → ligar o modo, só depois da caixa marcada e do clique; avisa o Copiloto e vira 'IA ativa · Responder sozinha'", async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const d = deps({
      enableAi: vi.fn(async () => void order.push("accept")),
      apply: vi.fn(async () => {
        order.push("apply");
        return { ok: true as const, result: result() };
      }),
      enableAutopilot: vi.fn(async () => void order.push("mode")),
    });
    const onActivated = vi.fn();
    view({ onActivated }, d);
    await user.click(screen.getByRole("button", { name: AUTO_LABEL }));
    expect(d.enableAi).not.toHaveBeenCalled();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: AUTO_LABEL }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("IA ativa · Responder sozinha"));
    expect(order).toEqual(["accept", "apply", "mode"]);
    expect(d.enableAutopilot).toHaveBeenCalledWith("att1");
    expect(onActivated).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Clique para autorizar/)).toBeNull();
  });

  it("Sugerir respostas: o modo automático NUNCA é chamado; estado final 'IA ativa · Sugerir respostas'", async () => {
    const user = userEvent.setup();
    const d = deps();
    view({}, d);
    await user.click(screen.getByRole("radio", { name: /Sugerir respostas/ }));
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: SUGGEST_LABEL }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("IA ativa · Sugerir respostas"));
    expect(d.enableAutopilot).not.toHaveBeenCalled();
    expect(screen.getByText(/Nada sai sozinho/)).toBeInTheDocument();
  });

  it("erro no aceite: mensagem, 'Tentar de novo' e a montagem não roda; ao repetir, continua", async () => {
    const user = userEvent.setup();
    let fail = true;
    const d = deps({
      enableAi: vi.fn(async () => {
        if (fail) throw new Error("Sem permissão");
      }),
    });
    view({}, d);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: AUTO_LABEL }));
    expect(await screen.findByText("Sem permissão")).toBeInTheDocument();
    expect(d.apply).not.toHaveBeenCalled();
    fail = false;
    await user.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("IA ativa"));
  });

  it("erro ao montar: mostra o motivo e mantém o botão", async () => {
    const user = userEvent.setup();
    const d = deps({ apply: vi.fn(async () => ({ ok: false as const, message: "O rascunho mudou desde que você revisou." })) });
    view({ aiActive: true }, d);
    await user.click(screen.getByRole("button", { name: /Montar e deixar/ }));
    expect(await screen.findByText("O rascunho mudou desde que você revisou.")).toBeInTheDocument();
    expect(d.enableAutopilot).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("falha ao ligar o automático: fica montada em Sugerir, o cartão diz isso e oferece 'Tentar ligar de novo'", async () => {
    const user = userEvent.setup();
    let fail = true;
    const d = deps({
      enableAutopilot: vi.fn(async () => {
        if (fail) throw new Error("falhou");
      }),
    });
    const onActivated = vi.fn();
    view({ aiActive: true, onActivated }, d);
    await user.click(screen.getByRole("button", { name: /Montar e deixar/ }));
    expect(await screen.findByText(/A operação ficou montada em Sugerir respostas/)).toBeInTheDocument();
    expect(onActivated).toHaveBeenCalledTimes(1);
    fail = false;
    await user.click(screen.getByRole("button", { name: "Tentar ligar de novo" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("IA ativa · Responder sozinha"));
    expect(d.apply).toHaveBeenCalledTimes(1);
    expect(onActivated).toHaveBeenCalledTimes(1);
  });

  it("atendente mantido (skipped_existing): não liga o automático e explica, com a opção de sobrescrever", async () => {
    const user = userEvent.setup();
    const d = deps({ apply: vi.fn(async () => ({ ok: true as const, result: result({ attendant: "skipped_existing", attendantId: "old" as never }) })) });
    view({ aiActive: true }, d);
    await user.click(screen.getByRole("button", { name: /Montar e deixar/ }));
    expect(await screen.findByText(/eu mantive o dele/)).toBeInTheDocument();
    expect(d.enableAutopilot).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sobrescrever o atendente que já existe" })).toBeInTheDocument();
  });

  it("voltou à conversa com a IA ativa e esta versão já montada: só a linha de sucesso, com o modo certo", () => {
    view({ aiActive: true, alreadyApplied: true, activeMode: "autopilot" });
    expect(screen.getByRole("status")).toHaveTextContent("IA ativa · Responder sozinha");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("sem organização ou sessão: desligado", () => {
    view({ aiActive: true, disabled: true });
    expect(screen.getByRole("button", { name: /Montar e deixar/ })).toBeDisabled();
  });
});

describe("OperacaoProntaView", () => {
  const props = { summary, tested: false, connected: false };

  it("três botões; o do passo atual é o primário; os feitos ganham check", () => {
    const wrap = (el: React.ReactElement) => <MemoryRouter>{el}</MemoryRouter>;
    const { rerender } = render(wrap(<OperacaoProntaView {...props} />));
    expect(screen.getByRole("list", { name: "O que foi criado" })).toHaveTextContent("Funil Passeios com 5 etapas");
    const test = screen.getByRole("button", { name: "Testar a sua IA" });
    const connect = screen.getByRole("button", { name: "Conectar o WhatsApp" });
    const crm = screen.getByRole("link", { name: "Abrir o meu CRM" });
    expect(crm).toHaveAttribute("href", "/app/painel");
    expect(test.className).toMatch(/bg-brand-600/);
    expect(connect.className).not.toMatch(/bg-brand-600/);
    expect(crm.className).not.toMatch(/bg-brand-600/);

    rerender(wrap(<OperacaoProntaView {...props} tested />));
    expect(screen.getByRole("button", { name: /Testar a sua IA/ })).toHaveTextContent("(feito)");
    expect(screen.getByRole("button", { name: /Conectar o WhatsApp/ }).className).toMatch(/bg-brand-600/);

    rerender(wrap(<OperacaoProntaView {...props} tested connected />));
    expect(screen.getByRole("link", { name: "Abrir o meu CRM" }).className).toMatch(/bg-brand-600/);
  });

  it("'Testar' abre o simulador ali mesmo; 'Conectar' abre a conexão e 'Conectar depois' segue sem conectar", async () => {
    const user = userEvent.setup();
    const onSkipConnect = vi.fn();
    renderWithRouter(<OperacaoProntaView {...props} simulator={<p>Simulador aqui</p>} connectCard={<p>Conexão aqui</p>} onSkipConnect={onSkipConnect} />);
    expect(screen.queryByText("Simulador aqui")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Testar a sua IA" }));
    expect(screen.getByText("Simulador aqui")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Conectar o WhatsApp" }));
    expect(screen.getByText("Conexão aqui")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Conectar depois" }));
    expect(onSkipConnect).toHaveBeenCalledTimes(1);
  });

  it("rascunho mudou depois de montar: avisa e oferece 'Atualizar a operação'", async () => {
    const user = userEvent.setup();
    const onUpdate = vi.fn(async () => ({ ok: false, message: "Não foi possível atualizar a operação." }));
    renderWithRouter(<OperacaoProntaView {...props} changedSinceApply onUpdate={onUpdate} />);
    expect(screen.getByText(/Você mudou algo depois de montar/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Atualizar a operação" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível atualizar");
  });

  it("sem mudança, sem o aviso", () => {
    renderWithRouter(<OperacaoProntaView {...props} />);
    expect(screen.queryByRole("button", { name: "Atualizar a operação" })).toBeNull();
  });
});

describe("OperacaoProntaView com a tela dedicada de teste", () => {
  const base = { summary: { ...summary, funnelName: "Funil da clínica", stageCount: 6 }, tested: false, connected: false };
  const wrap = (el: React.ReactElement) => <MemoryRouter>{el}</MemoryRouter>;

  it("'Testar a sua IA' abre a tela (não espreme o simulador no cartão); sem 'Funil Funil'", async () => {
    const onOpenTest = vi.fn();
    render(wrap(<OperacaoProntaView {...base} onOpenTest={onOpenTest} simulator={<p>Simulador no cartão</p>} />));
    expect(screen.getByRole("list", { name: "O que foi criado" })).toHaveTextContent("Funil da clínica com 6 etapas");
    expect(screen.getByRole("list", { name: "O que foi criado" })).not.toHaveTextContent("Funil Funil");
    await userEvent.click(screen.getByRole("button", { name: "Testar a sua IA" }));
    expect(onOpenTest).toHaveBeenCalled();
    expect(screen.queryByText("Simulador no cartão")).not.toBeInTheDocument();
  });

  it("'conectar o WhatsApp' vindo da tela de teste abre a conexão no cartão", () => {
    const { rerender } = render(wrap(<OperacaoProntaView {...base} tested onOpenTest={vi.fn()} connectCard={<p>Fluxo de conexão</p>} connectSignal={0} />));
    expect(screen.queryByText("Fluxo de conexão")).not.toBeInTheDocument();
    rerender(wrap(<OperacaoProntaView {...base} tested onOpenTest={vi.fn()} connectCard={<p>Fluxo de conexão</p>} connectSignal={1} />));
    expect(screen.getByText("Fluxo de conexão")).toBeInTheDocument();
  });
});
