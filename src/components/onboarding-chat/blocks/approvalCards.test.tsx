import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildBlock } from "../../../../convex/lib/onboardingBlocks";
import { cardSignature, sectionSignature, type ApprovalSection } from "../../../../convex/lib/onboardingRoadmap";
import type { OnboardingDraft } from "../../../../convex/lib/onboardingDraft";
import { draftFixture } from "@/test/onboardingDraftFixture";
import { ConhecimentoListaView } from "./ConhecimentoListaBlock";
import { FunilPreviewView } from "./FunilPreviewBlock";
import { PersonaCardView } from "./PersonaCardBlock";
import { approvalFor, liveApproval, liveDraftBlock } from "./liveBlock";
import type { CardEditor } from "./draftParts";
import type { BlockContext, BlockOf, LiveFacts } from "./types";

const baseCtx = { draftHash: "h1", draftVersion: 3, appliedDraftHash: null, emailVerified: true, aiActive: false };

function facts(approvals: Partial<Record<ApprovalSection, string>> = {}, draft: OnboardingDraft = draftFixture()): LiveFacts {
  return { draft, approvals, aiActive: false, applied: false, tested: false, connected: false, emailVerified: true };
}

function ctxOf(f: LiveFacts, over: Partial<BlockContext> = {}): Pick<BlockContext, "facts" | "compact" | "busy" | "sendEvent"> {
  return { facts: f, compact: false, busy: false, sendEvent: vi.fn(), ...over };
}

function block<K extends "personaCard" | "conhecimentoLista" | "funilPreview">(kind: K, draft = draftFixture()) {
  return buildBlock({ kind }, { ...baseCtx, draft }) as BlockOf<K>;
}

describe("aprovação AO VIVO (não o snapshot da mensagem)", () => {
  it("liveApproval compara a assinatura aprovada com o rascunho vivo", () => {
    const d = draftFixture();
    const sig = sectionSignature(d, "funnel");
    expect(liveApproval("funilPreview", { facts: facts({ funnel: sig }) })).toMatchObject({ section: "funnel", approved: true });
    expect(liveApproval("funilPreview", { facts: facts({ funnel: "velha" }) })).toMatchObject({ approved: false });
    expect(liveApproval("resumoNegocio", { facts: facts() })).toBeNull();
    expect(liveApproval("funilPreview", {})).toBeNull();
  });

  it("mudou o conteúdo depois de aprovado: volta a pendente", () => {
    const d = draftFixture();
    const sig = sectionSignature(d, "persona");
    const changed = draftFixture();
    changed.persona.attendantName = "Zé";
    expect(liveApproval("personaCard", { facts: facts({ persona: sig }, changed) })?.approved).toBe(false);
  });

  it("o cartão é remontado do rascunho vivo", () => {
    const changed = draftFixture();
    changed.funnel.name = "Novo nome";
    const shown = liveDraftBlock(block("funilPreview"), { facts: facts({}, changed) });
    expect(shown.funnelName).toBe("Novo nome");
  });
});

describe("FunilPreviewView: aprovar e ajustar", () => {
  it("mostra 'para que serve', os leads de exemplo e o selo 'Exemplo'; 'Está bom, seguir' envia o approve com a assinatura", async () => {
    const user = userEvent.setup();
    const sendEvent = vi.fn();
    const c = ctxOf(facts(), { sendEvent });
    render(<FunilPreviewView block={block("funilPreview")} approval={approvalFor("funilPreview", c)} onAdjust={vi.fn()} />);
    expect(screen.getByText(/Funil é o caminho que cada cliente faz/)).toBeInTheDocument();
    expect(screen.getByText("Exemplo")).toBeInTheDocument();
    expect(screen.getByText("Falta conferir")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Está bom, seguir" }));
    expect(sendEvent).toHaveBeenCalledWith({ kind: "approve", section: "funnel", sig: cardSignature(draftFixture(), "funilPreview") });
    expect(screen.getByRole("button", { name: "Ajustar" })).toBeInTheDocument();
  });

  it("todas as etapas legíveis (inteiras, sem truncar) e os leads fictícios da animação", () => {
    const b = block("funilPreview");
    const examples = [
      { name: "Família Souza", note: "passeio de 4h" },
      { name: "Marina", note: "quer para sábado" },
    ];
    render(<FunilPreviewView block={{ ...b, stages: [{ name: "Em conversa com o cliente", outcome: "open" }, { name: "Proposta enviada", outcome: "open" }, { name: "Ganho", outcome: "won" }], examples }} />);
    const list = screen.getByLabelText("Etapas do funil");
    expect(list.textContent).toContain("Em conversa com o cliente");
    expect(list.textContent).toContain("Proposta enviada");
    expect(list.className).not.toMatch(/truncate/);
    expect(document.querySelectorAll("[data-example-lead]").length).toBe(2);
    expect(screen.getAllByText("Família Souza").length).toBeGreaterThan(0);
  });

  it("mensagem antiga sem examples cai num padrão seguro", () => {
    const b = { ...block("funilPreview"), examples: undefined };
    render(<FunilPreviewView block={b} />);
    expect(document.querySelectorAll("[data-example-lead]").length).toBeGreaterThan(0);
  });

  it("botão de pausar e continuar; movimento reduzido = estado final parado, sem botão", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<FunilPreviewView block={block("funilPreview")} />);
    await user.click(screen.getByRole("button", { name: "Pausar cena" }));
    expect(screen.getByRole("button", { name: "Retomar cena" })).toBeInTheDocument();
    unmount();
    render(<FunilPreviewView block={block("funilPreview")} reducedMotion />);
    expect(screen.queryByRole("button", { name: /Pausar cena/ })).toBeNull();
    expect(screen.getByText("Exemplo")).toBeInTheDocument();
  });

  it("aprovado: recolhe para título + selo 'Aprovado' + Ver/Ajustar; 'Ver' abre", async () => {
    const user = userEvent.setup();
    const d = draftFixture();
    const c = ctxOf(facts({ funnel: sectionSignature(d, "funnel") }));
    render(<FunilPreviewView block={block("funilPreview")} approval={approvalFor("funilPreview", c)} onAdjust={vi.fn()} />);
    expect(screen.getByText("Aprovado")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Está bom, seguir" })).toBeNull();
    expect(screen.queryByLabelText("Etapas do funil")).toBeNull();
    expect(screen.getByRole("button", { name: "Ajustar" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver" }));
    expect(screen.getByLabelText("Etapas do funil")).toBeInTheDocument();
  });

  it("na conversa o formulário salva e SEGUE ('Salvar e seguir' aprova depois de gravar); no painel é 'Salvar ajuste'", async () => {
    const user = userEvent.setup();
    const saved: OnboardingDraft[] = [];
    const editor: CardEditor = {
      version: 3,
      saving: false,
      save: vi.fn(async (update) => {
        saved.push(update(draftFixture()));
        return true;
      }),
    };
    const onApprove = vi.fn();
    const { unmount } = render(
      <FunilPreviewView block={block("funilPreview")} editor={editor} approval={{ approved: false, sig: "x", onApprove }} startOpen />
    );
    const stage = screen.getByLabelText("Etapa 2");
    await user.clear(stage);
    await user.type(stage, "Atendimento");
    await user.click(screen.getByRole("button", { name: "Salvar e seguir" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    // Sem assinatura: o servidor calcula a do rascunho que acabou de ser salvo.
    expect(onApprove).toHaveBeenCalledWith();
    unmount();

    render(<FunilPreviewView block={block("funilPreview")} editor={editor} compact approval={{ approved: false }} startOpen />);
    expect(screen.getByRole("button", { name: "Salvar ajuste" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Salvar e seguir" })).toBeNull();
  });

  it("não salvou (conflito): não aprova", async () => {
    const user = userEvent.setup();
    const editor: CardEditor = { version: 3, saving: false, save: vi.fn(async () => false) };
    const onApprove = vi.fn();
    render(<FunilPreviewView block={block("funilPreview")} editor={editor} approval={{ approved: false, onApprove }} startOpen />);
    await user.click(screen.getByRole("button", { name: "Salvar e seguir" }));
    await waitFor(() => expect(editor.save).toHaveBeenCalled());
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("prévia compacta do painel: só o selo, sem 'Está bom, seguir'", () => {
    const c = ctxOf(facts(), { compact: true });
    render(<FunilPreviewView block={block("funilPreview")} compact approval={approvalFor("funilPreview", c)} onAdjust={vi.fn()} />);
    expect(screen.getByText("Falta conferir")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Está bom, seguir" })).toBeNull();
    expect(screen.getByRole("button", { name: "Ajustar" })).toBeInTheDocument();
  });
});

describe("PersonaCardView e ConhecimentoListaView", () => {
  it("persona: 'para que serve', 'Atende 24h, todos os dias' e 'Chama você quando'", () => {
    const d = draftFixture();
    d.handoffRules = [{ kind: "pedido_humano", suspicious: false }, { kind: "reclamacao", suspicious: false }] as never;
    render(<PersonaCardView block={block("personaCard", d)} />);
    expect(screen.getByText(/É o jeito de a sua IA atender/)).toBeInTheDocument();
    expect(screen.getByText("Atende 24h, todos os dias")).toBeInTheDocument();
    expect(screen.getByText(/Chama você quando: o cliente pede para falar com uma pessoa; há uma reclamação/)).toBeInTheDocument();
  });

  it("persona aprovada recolhe; conhecimento tem 'Está bom, seguir' e mostra a procedência do servidor", async () => {
    const user = userEvent.setup();
    const sendEvent = vi.fn();
    const d = draftFixture();
    const personaCtx = ctxOf(facts({ persona: sectionSignature(d, "persona") }));
    const { unmount } = render(<PersonaCardView block={block("personaCard")} approval={approvalFor("personaCard", personaCtx)} onAdjust={vi.fn()} />);
    expect(screen.getByText("Aprovado")).toBeInTheDocument();
    unmount();

    const b = block("conhecimentoLista");
    const items = b.items.map((it, i) => (i === 0 ? { ...it, originKind: "site" as const, originLabel: "Do site: loja.com.br" } : { ...it, originKind: "audio" as const, originLabel: "Do áudio" }));
    render(<ConhecimentoListaView block={{ ...b, items }} approval={approvalFor("conhecimentoLista", ctxOf(facts(), { sendEvent }))} />);
    expect(screen.getByText(/É o que a sua IA sabe para responder/)).toBeInTheDocument();
    expect(screen.getByText("Do site: loja.com.br")).toBeInTheDocument();
    expect(screen.getByText("Do áudio")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Está bom, seguir" }));
    expect(sendEvent).toHaveBeenCalledWith({ kind: "approve", section: "knowledge", sig: cardSignature(d, "conhecimentoLista") });
  });

  it("nunca deduz 'Do site': sem rótulo do servidor, o tipo fixo manda", () => {
    const b = block("conhecimentoLista");
    const items = b.items.map((it) => ({ ...it, originKind: "usuario" as const, originLabel: undefined }));
    render(<ConhecimentoListaView block={{ ...b, items }} />);
    expect(screen.queryByText("Do site")).toBeNull();
    expect(screen.getAllByText("Você contou").length).toBe(2);
  });
});
