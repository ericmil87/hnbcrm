import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ApplyResult } from "../../../../convex/lib/onboardingApply";
import { buildBlock } from "../../../../convex/lib/onboardingBlocks";
import type { OnboardingDraft } from "../../../../convex/lib/onboardingDraft";
import { draftFixture } from "@/test/onboardingDraftFixture";
import { renderWithRouter } from "@/test/render";
import { RespostasRapidasView } from "./RespostasRapidasBlock";
import { PersonaCardView } from "./PersonaCardBlock";
import { ConhecimentoListaView, originText } from "./ConhecimentoListaBlock";
import { FunilPreviewView } from "./FunilPreviewBlock";
import { TraducaoCartaoView } from "./TraducaoCartaoBlock";
import { AplicarOperacaoView, type ApplyAttempt } from "./AplicarOperacaoBlock";
import { SimuladorView } from "./SimuladorBlock";
import { ConectarCanalView } from "./ConectarCanalBlock";
import { ProximosPassosView } from "./ProximosPassosBlock";
import { OnboardingTutorial, OnboardingTutorialModal } from "../tutorial/OnboardingTutorial";
import { TUTORIAL_CARDS } from "../tutorial/tutorialCards";
import type { BlockOf } from "./types";
import type { CardEditor } from "./draftParts";

const live = { draftHash: "h1", draftVersion: 3, appliedDraftHash: null, emailVerified: true, aiActive: false };
function block<K extends "personaCard" | "conhecimentoLista" | "funilPreview" | "traducaoCartao">(kind: K, draft = draftFixture()) {
  return buildBlock({ kind }, { ...live, draft }) as BlockOf<K>;
}

/** Editor falso: aplica a mudança num rascunho de teste e guarda o resultado. */
function fakeEditor(version = 3) {
  const saved: OnboardingDraft[] = [];
  const save = vi.fn(async (update: (d: OnboardingDraft) => OnboardingDraft, base: number) => {
    saved.push(update(draftFixture()));
    expect(base).toBe(version);
    return true;
  });
  const editor: CardEditor = { version, saving: false, save };
  return { editor, save, saved };
}

describe("PersonaCardView", () => {
  it("Ajustar edita nome, tom e tratamento e salva com a versão do formulário", async () => {
    const user = userEvent.setup();
    const { editor, saved } = fakeEditor();
    render(<PersonaCardView block={block("personaCard")} editor={editor} />);
    await user.click(screen.getByRole("button", { name: "Ajustar" }));
    const name = screen.getByLabelText("Nome do atendente");
    await user.clear(name);
    await user.type(name, "Zé");
    await user.click(screen.getByRole("radio", { name: "Formal" }));
    await user.click(screen.getByRole("radio", { name: "Senhor(a)" }));
    await user.click(screen.getByRole("button", { name: "Salvar ajuste" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].persona).toMatchObject({ attendantName: "Zé", tone: "formal", addressAs: "senhor" });
  });

  it("sem rascunho vivo, Ajustar só pede para carregar (não grava)", async () => {
    const user = userEvent.setup();
    const onAdjust = vi.fn();
    render(<PersonaCardView block={block("personaCard")} onAdjust={onAdjust} />);
    await user.click(screen.getByRole("button", { name: "Ajustar" }));
    expect(onAdjust).toHaveBeenCalledTimes(1);
  });
});

describe("ConhecimentoListaView", () => {
  it("mostra a origem de cada item (link some do texto) e o motivo do item marcado", () => {
    render(<ConhecimentoListaView block={block("conhecimentoLista")} />);
    expect(screen.getByText("Do site")).toBeInTheDocument();
    expect(screen.getByText("Do PDF")).toBeInTheDocument();
  });

  it("item marcado: 'Usar mesmo assim' exige motivo e envia release", async () => {
    const user = userEvent.setup();
    const { editor, save, saved } = fakeEditor();
    render(<ConhecimentoListaView block={block("conhecimentoLista")} editor={editor} />);
    expect(screen.getByText(/Marcado para revisão/)).toBeInTheDocument();
    expect(screen.getByText(/Motivo: telefone/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Usar mesmo assim" }));
    // Sem motivo: não envia.
    await user.click(screen.getAllByRole("button", { name: "Usar mesmo assim" })[0]);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText(/mínimo 5 letras/)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Por que este trecho pode entrar?"), "é o telefone da loja");
    await user.click(screen.getAllByRole("button", { name: "Usar mesmo assim" })[0]);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].knowledge[1].release).toEqual({ reason: "é o telefone da loja" });
  });

  it("remover e editar passam pelo saveDraft; origem 'você'", async () => {
    const user = userEvent.setup();
    const { editor, saved } = fakeEditor();
    render(<ConhecimentoListaView block={block("conhecimentoLista")} editor={editor} />);
    await user.click(screen.getByRole("button", { name: "Remover o fato 1" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].knowledge).toHaveLength(1);
    expect(originText({ originKind: "usuario" })).toBe("Você contou");
    expect(originText({ originKind: "audio" })).toBe("Do áudio");
    expect(originText({ originKind: "imagem" })).toBe("Da imagem");
    expect(originText({ originKind: "pdf", originLabel: "Do PDF: catalogo.pdf" })).toBe("Do PDF: catalogo.pdf");
  });
});

describe("FunilPreviewView", () => {
  it("renomeia e reordena as etapas e salva", async () => {
    const user = userEvent.setup();
    const { editor, saved } = fakeEditor();
    render(<FunilPreviewView block={block("funilPreview")} editor={editor} startOpen />);
    const stage2 = screen.getByLabelText("Etapa 2");
    await user.clear(stage2);
    await user.type(stage2, "Atendimento");
    await user.click(screen.getByRole("button", { name: "Descer a etapa 2" }));
    await user.click(screen.getByRole("button", { name: "Salvar ajuste" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].funnel.stages.map((s) => [s.name, s.order])).toEqual([
      ["Novo", 0],
      ["Ganho", 1],
      ["Atendimento", 2],
    ]);
  });

  it("nome bloqueado: pede edição, sem 'Usar mesmo assim'", () => {
    const d = draftFixture();
    d.blocked = [{ field: "funnel.stages.1.name", label: "Etapa 2", reason: "parece instrução" }];
    const b = { ...block("funilPreview", d), blockedCount: 1 };
    render(<FunilPreviewView block={b} blocked={d.blocked} editor={fakeEditor().editor} />);
    expect(screen.getByText(/precisa ser editado|precisam ser editado|nome precisa/)).toBeInTheDocument();
    expect(screen.getByText(/não há como liberar/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Usar mesmo assim" })).toBeNull();
  });
});

describe("TraducaoCartaoView", () => {
  it("a chave grava features.translation pelo editor", async () => {
    const user = userEvent.setup();
    const { editor, saved } = fakeEditor();
    render(<TraducaoCartaoView block={block("traducaoCartao")} editor={editor} />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    await user.click(sw);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].features.translation).toBe(false);
  });
});

function applyResult(over: Partial<ApplyResult> = {}): ApplyResult {
  return {
    alreadyApplied: false,
    draftHash: "h",
    boardId: null,
    funnelMode: "created",
    fieldsCreated: 0,
    fieldsUpdated: 0,
    quickRepliesCreated: 2,
    quickRepliesSkipped: 0,
    attendant: "created",
    attendantId: null,
    attendantModeReset: false,
    skippedSuspicious: { knowledge: 0, quickReplies: 0, handoffRules: 0, greeting: false, business: false },
    aiActive: true,
    features: { vision: "applied", transcription: "not_requested", dateTime: "not_requested", translation: "applied", voice: "not_requested" },
    pendingConsent: [],
    ...over,
  } as ApplyResult;
}
const okState = { canApply: true, blockedCount: 0, flaggedCount: 0, aiActive: true, alreadyApplied: false };

describe("AplicarOperacaoView", () => {
  it("não aplica ao montar; o clique chama onApply sem sobrescrever e mostra o resultado", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn<(o: boolean) => Promise<ApplyAttempt>>().mockResolvedValue({ ok: true, result: applyResult() });
    render(<AplicarOperacaoView state={okState} onApply={onApply} />);
    expect(onApply).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Montar minha operação" }));
    expect(onApply).toHaveBeenCalledWith(false);
    expect(await screen.findByText("Operação montada.")).toBeInTheDocument();
    expect(screen.getByText("Atendente IA criado")).toBeInTheDocument();
    expect(screen.getByText(/começa em Sugerir respostas/)).toBeInTheDocument();
  });

  it("nome bloqueado desabilita o botão e explica", () => {
    render(<AplicarOperacaoView state={{ ...okState, canApply: false, blockedCount: 2 }} onApply={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Montar minha operação" })).toBeDisabled();
    expect(screen.getByText(/2 nomes do rascunho precisam ser editados/)).toBeInTheDocument();
  });

  it("mostra quantos itens marcados ficam de fora", () => {
    render(<AplicarOperacaoView state={{ ...okState, flaggedCount: 3 }} onApply={vi.fn()} />);
    expect(screen.getByText(/itens marcados ficam de fora/)).toBeInTheDocument();
  });

  it("atendente que já existia: pede confirmação clara antes de sobrescrever", async () => {
    const user = userEvent.setup();
    const onApply = vi
      .fn<(o: boolean) => Promise<ApplyAttempt>>()
      .mockResolvedValueOnce({ ok: true, result: applyResult({ attendant: "skipped_existing" }) })
      .mockResolvedValueOnce({ ok: true, result: applyResult({ attendant: "overwritten" }) });
    render(<AplicarOperacaoView state={okState} onApply={onApply} />);
    await user.click(screen.getByRole("button", { name: "Montar minha operação" }));
    await user.click(await screen.findByRole("button", { name: "Sobrescrever o atendente que já existe" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Sobrescrever troca o jeito de atender/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Manter o atual" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Sobrescrever o atendente que já existe" }));
    await user.click(screen.getByRole("button", { name: "Sim, sobrescrever" }));
    expect(onApply).toHaveBeenCalledTimes(2);
    expect(onApply).toHaveBeenLastCalledWith(true);
  });

  it("aceite de IA pendente: só um botão que leva ao aceite (nunca aceita sozinho)", async () => {
    const user = userEvent.setup();
    const onAskAccept = vi.fn();
    const pending = applyResult({
      attendant: "pending_consent",
      features: { vision: "pending_consent", transcription: "not_requested", dateTime: "not_requested", translation: "pending_consent", voice: "not_requested" },
      pendingConsent: ["vision", "translation"],
    });
    render(
      <AplicarOperacaoView
        state={{ ...okState, aiActive: false }}
        onApply={vi.fn().mockResolvedValue({ ok: true, result: pending })}
        onAskAccept={onAskAccept}
      />
    );
    await user.click(screen.getByRole("button", { name: "Montar minha operação" }));
    expect(await screen.findByText(/O atendente só nasce depois do aceite de IA/)).toBeInTheDocument();
    expect(screen.getByText(/leitura de imagens, tradução de mensagens/)).toBeInTheDocument();
    expect(onAskAccept).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Ir para o aceite de IA" }));
    expect(onAskAccept).toHaveBeenCalledTimes(1);
  });

  it("erro do servidor aparece e o botão continua disponível", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn<(o: boolean) => Promise<ApplyAttempt>>().mockResolvedValue({ ok: false, message: "O rascunho mudou." });
    render(<AplicarOperacaoView state={okState} onApply={onApply} />);
    await user.click(screen.getByRole("button", { name: "Montar minha operação" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("O rascunho mudou.");
    expect(screen.getByRole("button", { name: "Montar minha operação" })).toBeEnabled();
  });
});

describe("SimuladorView", () => {
  it("disponível: mostra a conversa de teste", () => {
    render(<SimuladorView available simulator={<div>conversa de teste</div>} tutorial={<div>tutorial aqui</div>} />);
    expect(screen.getByText("conversa de teste")).toBeInTheDocument();
    expect(screen.getByText(/Fale como se fosse um cliente/)).toBeInTheDocument();
    expect(screen.getByText("tutorial aqui")).toBeInTheDocument();
  });

  it("IA inativa: explica e aponta para o aceite, sem conversa", async () => {
    const user = userEvent.setup();
    const onAskAccept = vi.fn();
    render(<SimuladorView available={false} reason="ai_inactive" onAskAccept={onAskAccept} simulator={<div>conversa de teste</div>} />);
    expect(screen.queryByText("conversa de teste")).toBeNull();
    expect(screen.getByText(/ela ainda não está ativa/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ir para o aceite de IA" }));
    expect(onAskAccept).toHaveBeenCalledTimes(1);
  });

  it("operação não montada: aponta para montar", async () => {
    const user = userEvent.setup();
    const onAskApply = vi.fn();
    render(<SimuladorView available={false} reason="not_applied" onAskApply={onAskApply} />);
    expect(screen.getByText(/primeiro monte a operação/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ir para montar a operação" }));
    expect(onAskApply).toHaveBeenCalledTimes(1);
  });
});

describe("ConectarCanalView", () => {
  it("avisa com honestidade sobre o QR code e mostra o fluxo de conexão", () => {
    render(<ConectarCanalView connected={false} connectCard={<div>fluxo de conexão</div>} />);
    expect(screen.getByText(/pode ser banido/)).toBeInTheDocument();
    expect(screen.getByText(/número dedicado/)).toBeInTheDocument();
    expect(screen.getByText("fluxo de conexão")).toBeInTheDocument();
  });

  it("conectado: mostra a escolha de modo (que fica por conta do fluxo com aceite)", () => {
    render(<ConectarCanalView connected modeChoice={<div>escolha de modo</div>} connectCard={<div>fluxo</div>} />);
    expect(screen.getByText("Número conectado.")).toBeInTheDocument();
    expect(screen.getByText("escolha de modo")).toBeInTheDocument();
    expect(screen.queryByText("fluxo")).toBeNull();
  });
});

describe("ProximosPassosView", () => {
  const steps = [
    { id: "conectar_whatsapp" as const },
    { id: "convidar_equipe" as const },
    { id: "comunidade" as const },
    { id: "consultoria" as const },
  ];

  it("sem VITE_COMMUNITY_URL a comunidade não aparece; consultoria é um mailto", () => {
    renderWithRouter(<ProximosPassosView steps={steps} communityHref={null} consultoriaHref="mailto:x@y.example?subject=Oi" />);
    expect(screen.queryByText("Entrar na comunidade")).toBeNull();
    expect(screen.getByRole("link", { name: "Conectar número" })).toHaveAttribute("href", "/app/configuracoes?secao=channels");
    expect(screen.getByRole("link", { name: "Convidar pessoas" })).toHaveAttribute("href", "/app/equipe");
    expect(screen.getByRole("link", { name: "Falar com a gente" })).toHaveAttribute("href", "mailto:x@y.example?subject=Oi");
  });

  it("com a env, a comunidade abre em outra aba sem referrer", () => {
    renderWithRouter(<ProximosPassosView steps={steps} communityHref="https://chat.example/grupo" consultoriaHref="mailto:x@y.example" />);
    const link = screen.getByRole("link", { name: /Abrir a comunidade/ });
    expect(link).toHaveAttribute("href", "https://chat.example/grupo");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});

describe("tutorial guiado", () => {
  it("tem de 4 a 5 cartões, cada um com cena de 2 bolhas, sem o termo 'Repasse'", () => {
    expect(TUTORIAL_CARDS.length).toBeGreaterThanOrEqual(4);
    expect(TUTORIAL_CARDS.length).toBeLessThanOrEqual(5);
    for (const c of TUTORIAL_CARDS) expect(c.scene).toHaveLength(2);
    expect(JSON.stringify(TUTORIAL_CARDS)).not.toMatch(/Repasse|Handoff/i);
    expect(TUTORIAL_CARDS.map((c) => c.id)).toEqual(["traducao", "audio_imagem", "pedido_de_ajuda", "copiloto", "aviso_celular"]);
  });

  it("'Entendi' avança cartão a cartão e avisa no fim; pular também termina", async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    render(<OnboardingTutorial onDone={onDone} />);
    for (let i = 0; i < TUTORIAL_CARDS.length; i += 1) {
      expect(screen.getByText(`Cartão ${i + 1} de ${TUTORIAL_CARDS.length}`)).toBeInTheDocument();
      expect(screen.getByRole("group", { name: "Exemplo de conversa" }).children).toHaveLength(2);
      expect(onDone).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Entendi" }));
    }
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/rever este tutorial/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ver de novo" }));
    await user.click(screen.getByRole("button", { name: "Pular tutorial" }));
    expect(onDone).toHaveBeenCalledTimes(2);
  });
});

describe("concorrência: versão do rascunho muda com o formulário aberto", () => {
  it("'Usar mesmo assim' aberto na versão 3 não libera nada depois que vira 4", async () => {
    const user = userEvent.setup();
    const { editor, save } = fakeEditor(3);
    const b = block("conhecimentoLista");
    const { rerender } = render(<ConhecimentoListaView block={b} editor={editor} />);
    await user.click(screen.getByRole("button", { name: "Usar mesmo assim" }));
    await user.type(screen.getByLabelText("Por que este trecho pode entrar?"), "é o telefone da loja");
    rerender(<ConhecimentoListaView block={b} editor={{ ...editor, version: 4 }} />);
    expect(screen.getByText(/O rascunho mudou desde que você abriu/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usar mesmo assim" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
  });

  it("sem mudança de versão, a liberação usa a versão de quando abriu", async () => {
    const user = userEvent.setup();
    const { editor, save } = fakeEditor(3);
    render(<ConhecimentoListaView block={block("conhecimentoLista")} editor={editor} />);
    await user.click(screen.getByRole("button", { name: "Usar mesmo assim" }));
    await user.type(screen.getByLabelText("Por que este trecho pode entrar?"), "é o telefone da loja");
    await user.click(screen.getByRole("button", { name: "Usar mesmo assim" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][1]).toBe(3);
  });

  it("edição aberta mantém o texto, avisa e desliga o salvar; recarregar traz os campos novos", async () => {
    const user = userEvent.setup();
    const { editor, save } = fakeEditor(3);
    const b = block("personaCard");
    const { rerender } = render(<PersonaCardView block={b} editor={editor} startOpen />);
    const name = screen.getByLabelText("Nome do atendente");
    await user.clear(name);
    await user.type(name, "Zé");
    rerender(<PersonaCardView block={{ ...b, attendantName: "Bia Nova" }} editor={{ ...editor, version: 4 }} startOpen />);
    expect(screen.getByRole("alert")).toHaveTextContent(/O rascunho mudou enquanto você editava/);
    expect(screen.getByLabelText("Nome do atendente")).toHaveValue("Zé");
    expect(screen.getByRole("button", { name: "Salvar ajuste" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Recarregar os campos" }));
    expect(screen.getByLabelText("Nome do atendente")).toHaveValue("Bia Nova");
    expect(screen.getByRole("button", { name: "Salvar ajuste" })).toBeEnabled();
    expect(save).not.toHaveBeenCalled();
  });
});

describe("respostas rápidas liberadas", () => {
  it("item marcado e liberado mostra a tag e não pede liberação de novo", () => {
    const b = buildBlock({ kind: "respostasRapidas" }, { ...live, draft: draftFixture() }) as BlockOf<"respostasRapidas">;
    render(<RespostasRapidasView block={b} editor={fakeEditor().editor} released={[false, true]} />);
    expect(screen.getByText("Liberado por você")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Usar mesmo assim" })).toBeNull();
  });
});

describe("aplicar: trava e sobrescrita", () => {
  it("alreadyApplied depois de pedir a troca é erro, não sucesso", async () => {
    const user = userEvent.setup();
    const onApply = vi
      .fn<(o: boolean) => Promise<ApplyAttempt>>()
      .mockResolvedValueOnce({ ok: true, result: applyResult({ attendant: "skipped_existing" }) })
      .mockResolvedValueOnce({ ok: true, result: applyResult({ alreadyApplied: true, attendant: "unchanged" }) });
    render(<AplicarOperacaoView state={okState} onApply={onApply} />);
    await user.click(screen.getByRole("button", { name: "Montar minha operação" }));
    await user.click(await screen.findByRole("button", { name: "Sobrescrever o atendente que já existe" }));
    await user.click(screen.getByRole("button", { name: "Sim, sobrescrever" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Não foi possível sobrescrever/);
    expect(screen.getByText("Operação montada.")).toBeInTheDocument();
    expect(screen.queryByText(/Esta versão já estava montada/)).toBeNull();
  });

  it("mensagem que não é a mais recente trava o botão; rascunho que mudou avisa", () => {
    render(
      <AplicarOperacaoView
        state={okState}
        onApply={vi.fn()}
        lockedReason="Esta é uma mensagem antiga. Use o botão da mensagem mais recente."
        changedSinceMessage
      />
    );
    expect(screen.getByRole("button", { name: "Montar minha operação" })).toBeDisabled();
    expect(screen.getByText(/mensagem antiga/)).toBeInTheDocument();
    expect(screen.getByText(/O rascunho mudou desde esta mensagem/)).toBeInTheDocument();
  });
});

describe("tutorial no modal", () => {
  it("o último Entendi não fecha: mostra Ver de novo e Concluir", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<OnboardingTutorialModal open onClose={onClose} />);
    for (let i = 0; i < TUTORIAL_CARDS.length; i += 1) await user.click(screen.getByRole("button", { name: "Entendi" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Ver de novo" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Concluir" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
